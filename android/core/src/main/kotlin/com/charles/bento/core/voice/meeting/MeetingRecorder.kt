package com.charles.bento.core.voice.meeting

import com.charles.bento.core.voice.VoiceLog
import com.charles.bento.core.voice.after
import com.charles.bento.core.voice.audio.LevelMeter
import com.charles.bento.core.voice.audio.Pcm
import com.charles.bento.core.voice.audio.WavWriter
import com.charles.bento.core.voice.secondsSince
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.time.Instant

/** Points the meeting's PCM stream at the current Live session and counts frames delivered. Thread safe. */
class MeetingStreamRouter {
    private var target: ((ByteArray) -> Unit)? = null
    private var frames = 0L

    /** Called on the audio thread for every buffer. */
    fun deliver(pcm: ByteArray) {
        val t: ((ByteArray) -> Unit)?
        synchronized(this) {
            frames += pcm.size / 2
            t = target
        }
        t?.invoke(pcm)
    }

    /** Points the stream somewhere else and returns the boundary frame. */
    fun attach(target: ((ByteArray) -> Unit)?): Long = synchronized(this) {
        this.target = target
        frames
    }

    val framesDelivered: Long get() = synchronized(this) { frames }
}

/**
 * One part's capture: the app's mic samples go to the part's WAV as they arrive (a
 * killed app keeps them), then — silenced while muted — to the stream. The mute
 * ranges are recorded so batch re-transcription silences the same audio. Called on
 * the audio thread.
 */
internal class PartCapture(file: File, private val router: MeetingStreamRouter, private val onLevel: (Float) -> Unit,
                           private val onDied: (String) -> Unit) {
    private val writer = WavWriter(file)
    private val meter = LevelMeter()
    @Volatile var muted = false
    private var frames = 0L
    private var muteStart: Long? = null
    private val ranges = ArrayList<MeetingFrameRange>()
    private var failures = 0
    private var closed = false

    @Synchronized
    fun ingest(samples: ShortArray, offset: Int, length: Int) {
        if (closed || length <= 0) return
        try {
            writer.append(samples, offset, length)
            failures = 0
        } catch (e: IOException) {
            if (++failures == 15) onDied("Disk problem")
            return
        }
        val isMuted = muted
        if (isMuted && muteStart == null) muteStart = frames
        if (!isMuted) muteStart?.let { ranges += MeetingFrameRange(it, frames); muteStart = null }
        val delivered = if (isMuted) ByteArray(length * 2) else Pcm.toBytes(samples, offset, length)
        frames += length
        router.deliver(delivered)
        meter.feed(samples, offset, length) { onLevel(it) }
    }

    /** Stops and closes the file; the frames written and the muted ranges. */
    @Synchronized
    fun finish(): Pair<Long, List<MeetingFrameRange>> {
        if (!closed) {
            closed = true
            writer.close()
        }
        val all = muteStart?.let { ranges + MeetingFrameRange(it, frames) } ?: ranges.toList()
        return frames to all
    }
}

/** Timing of Live rotation, reconnects and buffered chunks (the Mac's values). Seconds. */
data class MeetingTiming(
    /** Start looking for a pause to rotate the Live session in… */
    val softRotation: Double = 480.0,
    /** …and rotate regardless here: the API caps a session at 10 minutes. */
    val hardRotation: Double = 555.0,
    /** How long the server must have reported silence before a rotation. */
    val quietBeforeRotation: Double = 0.6,
    /** With no session attached, cut the span for batch this often. */
    val bufferedChunkLimit: Double = 180.0,
    val reconnectBackoff: List<Double> = listOf(2.0, 5.0, 10.0, 20.0, 30.0, 60.0),
    val tickInterval: Double = 0.5,
)

/**
 * Meeting capture: parts (pause/resume), Live sessions rotated before the API's
 * 10-minute cap without leaving a hole, reconnects with backoff, and spans with no
 * Live session cut for batch every few minutes. Port of the Mac's MeetingRecorder
 * minus CoreAudio: the app feeds the mic. Confined to [dispatcher].
 */
class MeetingRecorder internal constructor(
    private val services: MeetingServices,
    private val store: MeetingStore,
    private val makeLiveSession: (() -> MeetingLiveSession?)?,
    private val timing: MeetingTiming,
    private val scope: CoroutineScope,
    private val dispatcher: CoroutineDispatcher,
    private val clock: () -> Instant = Instant::now,
) {
    enum class Phase { IDLE, RECORDING, PAUSED }
    enum class Connection {
        CONNECTING, LIVE,
        /** Live dropped; audio is kept and the socket is being reopened. */
        RECONNECTING,
        /** No Live transport: the meeting is transcribed from the recording a few minutes at a time. */
        UNAVAILABLE,
    }

    private val phaseFlow = MutableStateFlow(Phase.IDLE)
    val phase: StateFlow<Phase> = phaseFlow.asStateFlow()
    private val connectionFlow = MutableStateFlow(Connection.UNAVAILABLE)
    val connection: StateFlow<Connection> = connectionFlow.asStateFlow()
    private val levelFlow = MutableStateFlow(0f)
    val level: StateFlow<Float> = levelFlow.asStateFlow()
    private val latestLineFlow = MutableStateFlow("")
    /** The newest words heard, final or not. Display only. */
    val latestLine: StateFlow<String> = latestLineFlow.asStateFlow()
    private val interimFlow = MutableStateFlow("")
    /** The utterance in progress, cleared when its final lands. Display only. */
    val interim: StateFlow<String> = interimFlow.asStateFlow()
    private val elapsedFlow = MutableStateFlow(0.0)
    val elapsed: StateFlow<Double> = elapsedFlow.asStateFlow()
    private val micMutedFlow = MutableStateFlow(false)
    val micMuted: StateFlow<Boolean> = micMutedFlow.asStateFlow()
    private val noticeFlow = MutableStateFlow<String?>(null)
    val notice: StateFlow<String?> = noticeFlow.asStateFlow()

    var processor: MeetingProcessor? = null
        private set

    /** One attached Live session and what it has said about the audio. */
    private inner class LiveLink(val session: MeetingLiveSession, val chunk: Int, val chunkStart: Double) {
        val startedAt: Instant = clock()
        var speechActive = false
        var quietSince: Instant? = clock()
        var lastActivityStart = 0.0
        var failed = false
        var events: Job? = null
    }

    private var router = MeetingStreamRouter()
    private val audioLock = Any()
    private var capture: PartCapture? = null
    @Volatile private var muted = false
    private var partIndex = 0
    private var partOpen = false
    private var partStartedAt: Instant? = null
    private var previousPartsSeconds = 0.0
    private var currentChunk: Int? = null
    private var active: LiveLink? = null
    private var candidate: MeetingLiveSession? = null
    private var generation = 0
    private val flushing = ArrayList<Job>()
    private var nextConnectAt: Instant = Instant.MIN
    private var reconnectAttempts = 0
    private var goAwayPending = false
    private var transitioning = false
    private var ticker: Job? = null
    private var lastPartSave: Instant = Instant.MIN

    // MARK: - Audio in (any thread)

    /** Feeds mic samples. Returns false when the meeting is not recording (paused or stopped). */
    fun feed(samples: ShortArray, offset: Int, length: Int): Boolean {
        synchronized(audioLock) {
            val c = capture ?: return false
            c.ingest(samples, offset, length)
        }
        return true
    }

    // MARK: - Controls

    suspend fun start(id: String) = withContext(dispatcher) {
        check(phaseFlow.value == Phase.IDLE && !transitioning) { "a meeting is already recording" }
        val now = clock()
        val folder = store.makeFolder(id, now)
        val processor = MeetingProcessor(MeetingDocument(folder, MeetingMeta(id = id, startedAt = now), MeetingTranscript()),
            services, store, scope, dispatcher, clock)
        this@MeetingRecorder.processor = processor
        partIndex = 0
        previousPartsSeconds = 0.0
        latestLineFlow.value = ""
        elapsedFlow.value = 0.0
        try {
            startPart()
        } catch (e: Exception) {
            this@MeetingRecorder.processor = null
            folder.deleteRecursively()
            throw e
        }
        phaseFlow.value = Phase.RECORDING
        startTicking()
        VoiceLog.i(TAG, "meeting started (${id.take(8)})")
    }

    suspend fun pause() = withContext(dispatcher) {
        if (phaseFlow.value != Phase.RECORDING || transitioning) return@withContext
        transitioning = true
        phaseFlow.value = Phase.PAUSED
        endPart()
        processor?.setStatus(MeetingMeta.Status.PAUSED)
        transitioning = false
    }

    suspend fun resume() = withContext(dispatcher) {
        if (phaseFlow.value != Phase.PAUSED || transitioning) return@withContext
        startPart()
        phaseFlow.value = Phase.RECORDING
        processor?.setStatus(MeetingMeta.Status.RECORDING)
    }

    /** Ends capture; returns the processor, whose [MeetingProcessor.finish] the caller runs. */
    suspend fun stop(): MeetingProcessor? = withContext(dispatcher) {
        // A pause in progress finishes first: refusing would strand a meeting the user was told is finishing.
        while (transitioning) delay(50)
        val processor = processor ?: return@withContext null
        if (phaseFlow.value == Phase.IDLE) return@withContext null
        transitioning = true
        val wasRecording = phaseFlow.value == Phase.RECORDING
        phaseFlow.value = Phase.IDLE
        ticker?.cancel()
        ticker = null
        if (wasRecording) endPart()
        for (job in flushing.toList()) job.join()
        flushing.clear()
        processor.setEndedAt(clock())
        connectionFlow.value = Connection.UNAVAILABLE
        levelFlow.value = 0f
        this@MeetingRecorder.processor = null
        transitioning = false
        VoiceLog.i(TAG, "meeting stopped after ${processor.document.meta.durationSeconds.toInt()}s of audio")
        processor
    }

    /** Keeps the mic out of the meeting (the user is dictating): those words are meant for a text field. */
    fun setMicMuted(isMuted: Boolean) {
        muted = isMuted
        synchronized(audioLock) { capture?.muted = isMuted }
        micMutedFlow.value = isMuted
    }

    /** The app is going away: record where things stand; launch recovery finishes the notes. */
    suspend fun prepareForTermination() = withContext(dispatcher) {
        val processor = processor ?: return@withContext
        if (phaseFlow.value == Phase.IDLE) return@withContext
        generation++
        candidate?.let { scope.launch { it.abort() } }
        active?.let { link -> scope.launch { link.session.abort() } }
        val frames = router.framesDelivered
        processor.updatePart(partIndex) { it.copy(frames = maxOf(it.frames, frames)) }
        processor.setStatus(MeetingMeta.Status.INTERRUPTED)
        processor.saveSynchronously()
    }

    /** The app's microphone stopped: end the part and pause; the user can resume. */
    suspend fun reportAudioInterrupted(message: String = "The microphone stopped") = withContext(dispatcher) {
        if (phaseFlow.value != Phase.RECORDING || transitioning) return@withContext
        VoiceLog.e(TAG, "meeting capture died — pausing")
        noticeFlow.value = "$message — meeting paused"
        pause()
    }

    // MARK: - Parts

    private fun startPart() {
        val processor = processor ?: return
        partIndex++
        val router = MeetingStreamRouter()
        this.router = router
        val part = MeetingPart(index = partIndex, startedAt = clock())
        processor.addPart(part)
        // Before capture starts: a buffer with no chunk to belong to is a lost word.
        val link = attachFirstSession()
        val newCapture = try {
            PartCapture(File(processor.document.folder, part.micFileName), router,
                onLevel = { levelFlow.value = it },
                onDied = { message -> scope.launch(dispatcher) { reportAudioInterrupted(message) } })
        } catch (e: IOException) {
            router.attach(null)
            if (link != null) {
                active = null
                scope.launch { link.session.abort() }
            }
            currentChunk?.let { chunk -> processor.updateChunk(chunk) { it.copy(endFrame = 0, status = MeetingChunk.Status.BATCHED) } }
            currentChunk = null
            processor.updatePart(part.index, immediately = true) { it.copy(ended = true) }
            throw e
        }
        newCapture.muted = muted
        synchronized(audioLock) { capture = newCapture }
        partOpen = true
        partStartedAt = clock()
        if (link != null) connect(link)
    }

    /** The first session of a part attaches before its handshake: the ring holds the opening seconds. */
    private fun attachFirstSession(): LiveLink? {
        val processor = processor ?: return null
        val session = makeLiveSession?.invoke()
        if (session == null) {
            currentChunk = processor.openChunk(partIndex, router.framesDelivered, MeetingChunk.Status.BUFFERING)
            connectionFlow.value = Connection.UNAVAILABLE
            return null
        }
        val start = router.attach { pcm -> session.enqueue(pcm) }
        val chunk = processor.openChunk(partIndex, start, MeetingChunk.Status.STREAMING)
        val link = LiveLink(session, chunk, processor.document.meta.meetingSeconds(partIndex, start))
        active = link
        currentChunk = chunk
        connectionFlow.value = Connection.CONNECTING
        return link
    }

    private fun connect(link: LiveLink) {
        listen(link)
        scope.launch(dispatcher) {
            try {
                link.session.start()
                if (active !== link) return@launch
                connectionFlow.value = Connection.LIVE
                reconnectAttempts = 0
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                linkFailed(link, "setup failed: ${e.message}")
            }
        }
    }

    private suspend fun endPart() {
        val processor = processor ?: return
        if (!partOpen) return
        partOpen = false
        generation++
        candidate?.let { c ->
            candidate = null
            scope.launch { c.abort() }
        }
        // Stop first: the last buffers belong to this chunk and its session.
        val result = synchronized(audioLock) {
            val c = capture
            capture = null
            c?.finish()
        }
        val boundary = router.attach(null)
        currentChunk?.let { current ->
            processor.updateChunk(current) { it.copy(endFrame = boundary) }
            val link = active
            if (link != null) {
                active = null
                flush(link)
            } else {
                processor.updateChunk(current) {
                    it.copy(status = if (boundary > it.startFrame) MeetingChunk.Status.AWAITING_BATCH else MeetingChunk.Status.BATCHED)
                }
            }
        }
        currentChunk = null
        processor.updatePart(partIndex, immediately = true) {
            it.copy(frames = boundary, mutedRanges = result?.second ?: emptyList(), ended = true)
        }
        previousPartsSeconds += MeetingAudio.seconds(boundary)
        partStartedAt = null
        elapsedFlow.value = previousPartsSeconds
        levelFlow.value = 0f
        interimFlow.value = ""
    }

    // MARK: - The Live relay

    private fun listen(link: LiveLink) {
        link.events = scope.launch(dispatcher) {
            link.session.events.collect { event -> handle(event, link) }
        }
    }

    private fun handle(event: MeetingLiveEvent, link: LiveLink) {
        when (event) {
            is MeetingLiveEvent.Interim -> if (link === active) {
                latestLineFlow.value = event.text
                interimFlow.value = event.text
            }
            is MeetingLiveEvent.Final -> {
                processor?.appendFinal(link.chunk, event.text, link.chunkStart + link.lastActivityStart)
                latestLineFlow.value = event.text
                interimFlow.value = ""
            }
            is MeetingLiveEvent.Usage -> processor?.addUsage(event.audioTokens, event.textTokens)
            is MeetingLiveEvent.ActivityStart -> {
                link.speechActive = true
                link.lastActivityStart = event.offset
            }
            is MeetingLiveEvent.ActivityEnd -> {
                link.speechActive = false
                link.quietSince = clock()
            }
            MeetingLiveEvent.GoAway -> if (link === active) goAwayPending = true
            is MeetingLiveEvent.Failed -> linkFailed(link, event.message)
            MeetingLiveEvent.SetupComplete -> {}
        }
    }

    private fun linkFailed(link: LiveLink, reason: String) {
        if (link.failed) return
        link.failed = true
        VoiceLog.i(TAG, "meeting live session failed: $reason")
        if (link !== active) return // a flushing session: its chunk goes to batch
        active = null
        router.attach(null)
        processor?.updateChunk(link.chunk) { it.copy(status = MeetingChunk.Status.BUFFERING) }
        connectionFlow.value = Connection.RECONNECTING
        nextConnectAt = clock().after(backoff(reconnectAttempts))
    }

    private fun backoff(attempt: Int): Double = timing.reconnectBackoff[attempt.coerceIn(0, timing.reconnectBackoff.size - 1)]

    /** Opens the next session while the current one keeps streaming; switches only once it is ready. */
    private fun beginHandoff() {
        if (candidate != null) return
        val session = makeLiveSession?.invoke() ?: return
        candidate = session
        val generation = this.generation
        if (active == null) connectionFlow.value = Connection.RECONNECTING
        scope.launch(dispatcher) {
            try {
                session.start()
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                if (this@MeetingRecorder.generation != generation || candidate !== session) return@launch
                candidate = null
                reconnectAttempts++
                nextConnectAt = clock().after(backoff(reconnectAttempts - 1))
                VoiceLog.i(TAG, "meeting live session did not open: ${e.message}")
                return@launch
            }
            if (this@MeetingRecorder.generation != generation || phaseFlow.value != Phase.RECORDING || candidate !== session) {
                session.abort()
                return@launch
            }
            candidate = null
            adopt(session)
        }
    }

    private fun adopt(session: MeetingLiveSession) {
        val processor = processor ?: return
        val boundary = router.attach { pcm -> session.enqueue(pcm) }
        val previous = active
        currentChunk?.let { previousChunk ->
            processor.updateChunk(previousChunk) { chunk ->
                var c = chunk.copy(endFrame = boundary)
                if (previous == null) {
                    c = c.copy(status = if (boundary > c.startFrame) MeetingChunk.Status.AWAITING_BATCH else MeetingChunk.Status.BATCHED)
                }
                c
            }
        }
        val chunk = processor.openChunk(partIndex, boundary, MeetingChunk.Status.STREAMING)
        val link = LiveLink(session, chunk, processor.document.meta.meetingSeconds(partIndex, boundary))
        active = link
        currentChunk = chunk
        connectionFlow.value = Connection.LIVE
        reconnectAttempts = 0
        goAwayPending = false
        listen(link)
        if (previous != null) flush(previous)
    }

    /** Asks a detached session for its last utterance, then settles its chunk. */
    private fun flush(link: LiveLink) {
        val processor = processor ?: return
        val job = scope.launch(dispatcher) {
            val clean = link.session.finish()
            processor.updateChunk(link.chunk) {
                it.copy(status = if (clean && !link.failed) MeetingChunk.Status.COMPLETE else MeetingChunk.Status.AWAITING_BATCH)
            }
        }
        // Rotations are minutes apart: only the latest few can still be running.
        if (flushing.size >= 4) repeat(flushing.size - 3) { flushing.removeAt(0) }
        flushing += job
    }

    private fun cutBufferedChunk() {
        val processor = processor ?: return
        val current = currentChunk ?: return
        val boundary = router.attach(null)
        processor.updateChunk(current) { it.copy(endFrame = boundary, status = MeetingChunk.Status.AWAITING_BATCH) }
        currentChunk = processor.openChunk(partIndex, boundary, MeetingChunk.Status.BUFFERING)
    }

    // MARK: - Tick

    private fun startTicking() {
        ticker?.cancel()
        ticker = scope.launch(dispatcher) {
            while (isActive) {
                delay((timing.tickInterval * 1000).toLong())
                tick()
            }
        }
    }

    private fun tick() {
        val processor = processor ?: return
        processor.pump()
        if (phaseFlow.value != Phase.RECORDING || transitioning) return
        val now = clock()
        elapsedFlow.value = previousPartsSeconds + (partStartedAt?.let { now.secondsSince(it) } ?: 0.0)
        if (now.secondsSince(lastPartSave) >= 5) {
            lastPartSave = now
            val frames = router.framesDelivered
            processor.updatePart(partIndex) { it.copy(frames = frames) }
        }
        val link = active
        if (link != null) {
            val age = now.secondsSince(link.startedAt)
            val quiet = !link.speechActive && (link.quietSince?.let { now.secondsSince(it) >= timing.quietBeforeRotation } ?: true)
            if (candidate == null && !now.isBefore(nextConnectAt) &&
                (goAwayPending || age >= timing.hardRotation || (age >= timing.softRotation && quiet))
            ) beginHandoff()
        } else {
            val current = currentChunk?.let { processor.chunk(it) }
            if (current != null) {
                if (router.framesDelivered - current.startFrame >= MeetingAudio.frames(timing.bufferedChunkLimit)) cutBufferedChunk()
                if (makeLiveSession != null && candidate == null && !now.isBefore(nextConnectAt)) beginHandoff()
            }
        }
    }

    private companion object {
        const val TAG = "MeetingRecorder"
    }
}
