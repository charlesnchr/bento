package com.charles.bento.core.voice.dictation

import com.charles.bento.core.voice.TranscriptionError
import com.charles.bento.core.voice.TranscriptionResult
import com.charles.bento.core.voice.VoiceLog

import com.charles.bento.core.voice.audio.AudioFormat
import com.charles.bento.core.voice.audio.AudioLevelCurve
import com.charles.bento.core.voice.audio.LevelMeter
import com.charles.bento.core.voice.audio.NoiseFloorEstimator
import com.charles.bento.core.voice.audio.Pcm
import com.charles.bento.core.voice.audio.WavWriter
import com.charles.bento.core.voice.format.TranscriptDiff
import com.charles.bento.core.voice.gemini.TimeoutPolicy
import com.charles.bento.core.voice.history.FileLayout
import com.charles.bento.core.voice.history.SessionMeta
import com.charles.bento.core.voice.live.LiveTranscribing
import com.charles.bento.core.voice.secondsSince
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import java.io.File
import java.io.IOException
import java.time.Instant
import kotlin.math.pow
import kotlin.math.roundToInt

/** What the app's inserter did with the text (the Mac's insertion outcomes). */
enum class InsertionOutcome {
    INSERTED,
    /** The target changed mid-flight; the text was offered instead of pasted blind. */
    TARGET_CHANGED,
    COPIED_TO_CLIPBOARD,
    /** A password field had focus: the text stays in History only. */
    BLOCKED_SECURE_FIELD,
}

/** A finished transcript as the app receives it. */
data class DictationResult(
    val sessionId: String,
    /** What to insert. */
    val text: String,
    /** What the recogniser returned (before cleanup and Dictionary rules). */
    val rawTranscript: String,
    val modelID: String,
    /** True when the live transcript was used (no upload was needed). */
    val usedLive: Boolean,
    /** What smart transcription cut from the last interim, for a kept/cut animation. Empty when nothing. */
    val corrections: List<TranscriptDiff.Segment>,
    val durationSeconds: Double,
    /** Stop → text latency. */
    val pipelineSeconds: Double,
    /** Set for a voice edit: the chain including this turn. */
    val editing: EditingSession?,
)

/** How a dictation ended. */
sealed class DictationOutcome {
    abstract val sessionId: String

    data class Transcribed(override val sessionId: String, val result: DictationResult, val insertion: InsertionOutcome) : DictationOutcome()
    /** No speech. `kept`: the recording stays in History (a loud room; the judgement may be wrong). */
    data class Silent(override val sessionId: String, val reason: SilenceReason, val kept: Boolean) : DictationOutcome()
    /** Offline: the recording is queued; [com.charles.bento.core.voice.history.RetryQueue] finishes it. */
    data class Queued(override val sessionId: String) : DictationOutcome()
    /** `code` is the History row's error code ("network", "auth", …); retryable failures keep the recording. */
    data class Failed(override val sessionId: String, val failure: DictationFailure, val code: String,
                      val message: String?, val recordingKept: Boolean) : DictationOutcome()
    data class Cancelled(override val sessionId: String, val recordingKept: Boolean) : DictationOutcome()
}

/** What a session needs from its engine; tests supply fakes. */
internal class SessionDeps(
    val root: File,
    val transcription: TranscriptionService,
    val makeLive: (DictationConfig) -> LiveTranscribing?,
    val scope: CoroutineScope,
    val clock: () -> Instant,
    val onUpdate: (SessionMeta, File) -> Unit,
    val onDiscard: (String) -> Unit,
    val onFinished: (DictationSession) -> Unit,
    val editingSessions: EditingSessionStore,
)

/**
 * One dictation, from start to text: a port of the Mac's DictationCoordinator for a
 * single session. The app feeds microphone audio; the session writes it to disk as it
 * arrives (a killed app keeps the recording), streams it to Live when enabled, and on
 * [stop] produces text through live finals or the batch upload, cleanup, the
 * validation gate and the Dictionary, falling back so no words are lost.
 *
 * Threading: [feed] is called from the audio thread and never suspends; everything
 * else may be called from any thread. Observe [state], [level] and [partialTranscript].
 */
class DictationSession internal constructor(
    val id: String,
    val config: DictationConfig,
    private val editing: EditingSession?,
    private val insert: suspend (String) -> InsertionOutcome,
    private val deps: SessionDeps,
) {
    companion object {
        /** Below this metered peak nobody spoke. */
        const val SILENCE_PEAK_THRESHOLD = 0.06f
        /** Clips shorter than this can't contain a word: never uploaded. */
        const val MINIMUM_SENDABLE_DURATION = 0.4
        /** Zero frames on a hold shorter than this is an accidental blip, not a failure. */
        const val BLIP_HOLD_THRESHOLD = 0.8
        /** Still speaking at stop: keep capturing until they actually stop. */
        const val TRAILING_SPEECH_THRESHOLD = 0.08f
        const val TRAILING_QUIET_TO_STOP = 0.25
        const val TRAILING_CAPTURE_CAP = 1.5
        const val TRAILING_FLOOR_MARGIN_DB = 3.0
        const val TRAILING_TRUST_SNR = 12.0
        const val TRAILING_RELATIVE_CAP = 0.30f
        const val EMPTY_TRANSCRIPT_SNR_THRESHOLD = 8.0
        const val DISCARD_SNR_THRESHOLD = 6.0
        /** Stop and transcribe at 10:00 of audio (a config may allow more), with a soft warning a minute before. */
        const val RECORDING_CAP_SECONDS = 600.0
        const val RECORDING_WARN_BEFORE_CAP = 60.0
        /** Cancelled recordings at least this long stay recoverable in History. */
        const val CANCEL_KEEP_THRESHOLD = 10.0
        /** No audio for this long during trailing capture means the app stopped the mic. */
        private const val FEED_SILENCE_GAP = 0.3
        private const val TAG = "DictationSession"
    }

    // MARK: - Observable surface

    private val stateFlow = MutableStateFlow<DictationState>(DictationState.Idle)
    val state: StateFlow<DictationState> = stateFlow.asStateFlow()

    private val levelFlow = MutableStateFlow(0f)
    /** ~31 Hz mic level, 0…1, for a waveform. */
    val level: StateFlow<Float> = levelFlow.asStateFlow()

    private val partialFlow = MutableStateFlow("")
    /** The words the model currently thinks it heard (live only). Display only, never inserted. */
    val partialTranscript: StateFlow<String> = partialFlow.asStateFlow()

    private val correctedFlow = MutableStateFlow("")
    /** Set once, when the finished text replaces the running guess. */
    val correctedTranscript: StateFlow<String> = correctedFlow.asStateFlow()

    private val noticeFlow = MutableStateFlow<String?>(null)
    /** Something to tell the user ("One minute left — 10-minute limit"). */
    val notice: StateFlow<String?> = noticeFlow.asStateFlow()

    private val outcome = CompletableDeferred<DictationOutcome>()

    /** True while the session wants audio. [feed] returns the same thing. */
    val wantsAudio: Boolean get() = accepting

    /** The recording on disk (16 kHz mono PCM16 WAV). */
    val audioFile: File get() = FileLayout.audioWAV(folder)

    var silenceReason: SilenceReason = SilenceReason.NO_SPEECH
        private set

    // MARK: - State (guarded by `lock`)

    private val lock = Any()
    private lateinit var folder: File
    private var meta: SessionMeta
    private val startedAt: Instant = deps.clock()
    private var pendingLockIn = false
    @Volatile private var live: LiveTranscribing? = null
    private var liveActiveForSession = false
    private var lastInterim = ""
    private var inFlight: Job? = null
    private var partialPump: Job? = null
    private var finished = false
    private var audioDurationSeconds: Double? = null

    // MARK: - Audio (guarded by `audioLock`)

    private val audioLock = Any()
    @Volatile private var accepting = false
    private var writer: WavWriter? = null
    private var framesWritten = 0L
    private val meter = LevelMeter()
    private val noiseFloor = NoiseFloorEstimator()
    private var latestLevel = 0f
    private var meterActive = true
    private var lastFeedNanos = 0L
    private var writeFailures = 0
    private var writeFailureReported = false
    private var capWarned = false
    private var capReached = false

    init {
        meta = SessionMeta(id = id, startedAt = startedAt, status = SessionMeta.Status.RECORDING,
            targetApp = config.context.packageName, targetAppName = config.context.appLabel, editingSession = editing)
    }

    /** Creates the folder and the recording and opens Live. Returns false (and fails the session) on a disk error. */
    internal fun begin(): Boolean {
        synchronized(lock) {
            apply(DictationEvent.HotkeyBegin)
            try {
                folder = FileLayout.makeSessionFolder(deps.root, id, startedAt)
                meta.write(folder)
                deps.onUpdate(meta, folder)
                synchronized(audioLock) { writer = WavWriter(FileLayout.audioWAV(folder)) }
            } catch (e: IOException) {
                VoiceLog.e(TAG, "session setup failed: ${e.message}")
                apply(DictationEvent.EngineFailed(DictationFailure.STORAGE))
                if (::folder.isInitialized) discardArtifacts()
                finish(DictationOutcome.Failed(id, DictationFailure.STORAGE, "disk_write", e.message, recordingKept = false))
                return false
            }
            // Latched once: a setting flipped mid-dictation must not make one recording
            // half live. Created before audio is accepted, so the ring sees every byte.
            val session = if (editing == null) deps.makeLive(config) else null
            live = session
            liveActiveForSession = session != null
            synchronized(audioLock) { accepting = true }
            if (session != null) {
                partialPump = deps.scope.launch {
                    session.partials.collect { text ->
                        synchronized(lock) {
                            // Late partials must not paint over a finished session.
                            if (finished || stateFlow.value.isTerminal) return@collect
                            lastInterim = text
                            partialFlow.value = text
                        }
                    }
                }
                // Not awaited: stop must not wait on a socket. Audio accumulates in the
                // ring meanwhile; a handshake that never lands means the upload runs.
                deps.scope.launch {
                    try {
                        session.begin()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        VoiceLog.i(TAG, "live session did not open (${e.message}) — this dictation uploads instead")
                        synchronized(lock) { liveActiveForSession = false }
                    }
                }
            }
        }
        return true
    }

    // MARK: - Audio in

    /**
     * Feeds 16 kHz mono PCM16 samples. Call from the audio thread with each buffer
     * read. Returns false once the session no longer wants audio (stop the mic then):
     * after [stop] it keeps returning true briefly while the user is still mid-word.
     */
    fun feed(samples: ShortArray, offset: Int = 0, length: Int = samples.size - offset): Boolean {
        if (length <= 0) return accepting
        var started = false
        var warn = false
        var cap = false
        var diskFailure = false
        synchronized(audioLock) {
            if (!accepting) return false
            val w = writer ?: return false
            try {
                w.append(samples, offset, length)
                writeFailures = 0
            } catch (e: IOException) {
                // The sink fires only after a successful write, as on the Mac.
                writeFailures++
                if (writeFailures >= 15 && !writeFailureReported) {
                    writeFailureReported = true
                    diskFailure = true
                }
                return@synchronized
            }
            if (framesWritten == 0L) started = true
            framesWritten += length
            lastFeedNanos = System.nanoTime()
            live?.enqueue(Pcm.toBytes(samples, offset, length))
            meter.feed(samples, offset, length) { level ->
                latestLevel = level
                noiseFloor.ingest(level)
                if (meterActive) levelFlow.value = level
            }
            val seconds = AudioFormat.seconds(framesWritten)
            if (seconds >= config.recordingCapSeconds - RECORDING_WARN_BEFORE_CAP && !capWarned) { capWarned = true; warn = true }
            if (seconds >= config.recordingCapSeconds && !capReached) { capReached = true; cap = true }
        }
        if (started) engineStarted()
        if (warn) synchronized(lock) { if (stateFlow.value is DictationState.Recording) noticeFlow.value = "One minute left — ${(config.recordingCapSeconds / 60).roundToInt()}-minute limit" }
        if (cap) {
            VoiceLog.i(TAG, "recording cap reached — finalizing")
            requestStop()
        }
        if (diskFailure) handleWriteFailure()
        return accepting
    }

    /** Feeds little-endian PCM16 bytes (an odd trailing byte is ignored). */
    fun feed(pcm: ByteArray, offset: Int = 0, length: Int = pcm.size - offset): Boolean =
        feed(Pcm.toShorts(pcm, offset, length))

    private fun engineStarted() {
        synchronized(lock) {
            if (!apply(DictationEvent.EngineStarted)) return
            if (pendingLockIn) {
                pendingLockIn = false
                apply(DictationEvent.LockIn)
            }
        }
    }

    /**
     * The app's microphone failed. Before any audio this fails the session (nothing to
     * store); mid-recording it finalizes with what was captured.
     */
    fun reportAudioFailure(failure: DictationFailure = DictationFailure.AUDIO, message: String? = null) {
        synchronized(lock) {
            when (stateFlow.value) {
                DictationState.Warming -> {
                    apply(DictationEvent.EngineFailed(failure))
                    closeCapture()
                    discardArtifacts()
                    finish(DictationOutcome.Failed(id, failure, "audio", message, recordingKept = false))
                    return
                }
                is DictationState.Recording -> {
                    VoiceLog.e(TAG, "capture died mid-recording — finalizing with what we have")
                    updateMeta { it.copy(errorCode = "engine_died") }
                    noticeFlow.value = (message ?: "The microphone stopped") + " — dictating what was captured"
                }
                else -> return
            }
        }
        requestStop()
    }

    private fun handleWriteFailure() {
        synchronized(lock) {
            if (stateFlow.value !is DictationState.Recording) return
            VoiceLog.e(TAG, "sustained write failures — finalizing with what we have")
            updateMeta { it.copy(errorCode = "disk_write") }
        }
        requestStop()
    }

    // MARK: - Controls

    /** Hands-free: a lock arriving before audio starts is latched and applied then. */
    fun lockIn(): Boolean = synchronized(lock) {
        if (stateFlow.value == DictationState.Warming) {
            pendingLockIn = true
            true
        } else {
            apply(DictationEvent.LockIn)
        }
    }

    /** Ends the recording and returns how the dictation ended. Idempotent: a second call awaits the same outcome. */
    suspend fun stop(): DictationOutcome {
        requestStop()
        return outcome.await()
    }

    /** Waits for the outcome without stopping. */
    suspend fun await(): DictationOutcome = outcome.await()

    /** Non-suspending stop for UI callbacks; observe [state] or [await]. */
    fun requestStop() {
        val wasSpeaking: Boolean
        synchronized(lock) {
            // The machine decides first; side effects only on an ACCEPTED finalize, so a
            // second stop while in flight changes nothing.
            if (!apply(DictationEvent.Finalize)) return
            synchronized(audioLock) {
                wasSpeaking = latestLevel >= currentTrailingThreshold()
                meterActive = false
            }
            levelFlow.value = 0f
        }
        deps.scope.launch {
            if (wasSpeaking) captureTrailingSpeech()
            val capture = synchronized(lock) { closeCapture() }
            completeFinalize(capture)
        }
    }

    /**
     * Cancels. A recording at least 10 s long (or one with a transcript) stays in
     * History with Retry; shorter ones leave no trace. Never cancels an insertion.
     */
    fun cancel() {
        synchronized(lock) {
            if (!apply(DictationEvent.Cancel)) return
            inFlight?.cancel()
            inFlight = null
            levelFlow.value = 0f
            val capture = closeCapture()
            // Post-finalize cancels have no capture left: use the persisted duration, or a
            // cancel during transcription would destroy a recording of any length.
            val duration = audioDurationSeconds ?: capture?.durationSeconds ?: 0.0
            val keep = meta.rawTranscript != null || duration >= CANCEL_KEEP_THRESHOLD
            if (keep) {
                updateMeta { it.copy(status = SessionMeta.Status.CANCELLED, audioDurationSeconds = it.audioDurationSeconds ?: duration) }
            } else {
                discardArtifacts()
            }
            finish(DictationOutcome.Cancelled(id, recordingKept = keep))
        }
    }

    /**
     * The engine is shutting down mid-session: close the recording and release waiters.
     * Whatever reached disk stays, and launch recovery finishes it.
     */
    internal fun abandon() {
        synchronized(lock) {
            if (finished) return
            inFlight?.cancel()
            closeCapture()
            finish(DictationOutcome.Cancelled(id, recordingKept = ::folder.isInitialized && folder.exists()))
        }
    }

    // MARK: - Finalize

    private class Capture(val framesWritten: Long, val durationSeconds: Double, val peakLevel: Float, val peakIsTrustworthy: Boolean)

    /** Stops accepting audio and closes the recording. Idempotent; call with `lock` held. */
    private fun closeCapture(): Capture? = synchronized(audioLock) {
        val w = writer ?: return@synchronized null
        accepting = false
        w.close()
        writer = null
        Capture(framesWritten, AudioFormat.seconds(framesWritten), meter.peakLevel, meter.measured)
    }

    /**
     * The level below which the user has stopped talking. Absolute by default; with
     * noise handling on it rises above a loud room, but only upward and only once the
     * session has shown it can tell speech from the room. Call with `audioLock` held.
     */
    private fun currentTrailingThreshold(): Float {
        if (!config.experimentalNoiseHandling) return TRAILING_SPEECH_THRESHOLD
        val floor = noiseFloor.floorDB ?: return TRAILING_SPEECH_THRESHOLD
        val snr = noiseFloor.measuredSNR ?: return TRAILING_SPEECH_THRESHOLD
        if (snr < TRAILING_TRUST_SNR) return TRAILING_SPEECH_THRESHOLD
        val relative = AudioLevelCurve.level(10.0.pow((floor + TRAILING_FLOOR_MARGIN_DB) / 20).toFloat())
        return minOf(TRAILING_RELATIVE_CAP, maxOf(TRAILING_SPEECH_THRESHOLD, relative))
    }

    /** Keeps the recording open past stop until the user stops talking; capped at 1.5 s. */
    private suspend fun captureTrailingSpeech() {
        val start = System.nanoTime()
        fun elapsed(since: Long) = (System.nanoTime() - since) / 1e9
        var quietSince: Long? = null
        while (elapsed(start) < TRAILING_CAPTURE_CAP) {
            delay(60)
            val (quiet, micOff) = synchronized(audioLock) {
                (latestLevel < currentTrailingThreshold()) to (elapsed(lastFeedNanos) >= FEED_SILENCE_GAP)
            }
            if (micOff) break
            if (quiet) {
                val since = quietSince ?: System.nanoTime().also { quietSince = it }
                if (elapsed(since) >= TRAILING_QUIET_TO_STOP) break
            } else {
                quietSince = null
            }
        }
        VoiceLog.i(TAG, "carried capture ${(elapsed(start) * 1000).toInt()}ms past stop — still talking")
    }

    private fun completeFinalize(capture: Capture?) {
        synchronized(lock) {
            if (finished || stateFlow.value !is DictationState.Finalizing) return
            val result = capture ?: Capture(0, 0.0, 0f, false)
            val heldFor = deps.clock().secondsSince(startedAt)
            if (result.framesWritten == 0L) {
                if (heldFor < BLIP_HOLD_THRESHOLD) {
                    // Released before the first buffer landed: not an error, not worth storing.
                    silenceReason = SilenceReason.NO_SPEECH
                    apply(DictationEvent.SilenceOnly)
                    discardArtifacts()
                    finish(DictationOutcome.Silent(id, SilenceReason.NO_SPEECH, kept = false))
                } else {
                    // Zero frames = nothing a Retry could ever transcribe: no dead-end row.
                    apply(DictationEvent.NoAudioCaptured)
                    discardArtifacts()
                    finish(DictationOutcome.Failed(id, DictationFailure.NO_AUDIO, "no_audio", null, recordingKept = false))
                }
                return
            }
            val (roomFloorDB, separation, peakDB) = synchronized(audioLock) {
                Triple(noiseFloor.floorDB, noiseFloor.measuredSNR, noiseFloor.peakDB)
            }
            audioDurationSeconds = result.durationSeconds
            updateMeta {
                it.copy(status = SessionMeta.Status.RECORDED, audioDurationSeconds = result.durationSeconds,
                    noiseFloorDBFS = roomFloorDB, speechPeakDBFS = if (roomFloorDB == null) null else peakDB)
            }
            // Micro-clips can't contain a word: classified locally, never uploaded.
            if (result.durationSeconds < MINIMUM_SENDABLE_DURATION) {
                silenceReason = SilenceReason.NO_SPEECH
                apply(DictationEvent.SilenceOnly)
                discardArtifacts()
                finish(DictationOutcome.Silent(id, SilenceReason.NO_SPEECH, kept = false))
                return
            }
            // Digital silence (muted mic) can't transcribe either. Two clauses can only
            // PREVENT a discard: unmeasured loudness uploads, and a quiet peak that still
            // rose clearly above the room is someone speaking softly.
            val roseAboveRoom = (separation ?: Double.POSITIVE_INFINITY) >= DISCARD_SNR_THRESHOLD
            if (!result.peakIsTrustworthy) {
                VoiceLog.i(TAG, "peak unmeasured — uploading rather than guessing silence")
            } else if (result.peakLevel < SILENCE_PEAK_THRESHOLD && !roseAboveRoom) {
                silenceReason = SilenceReason.NO_SPEECH
                apply(DictationEvent.SilenceOnly)
                discardArtifacts()
                finish(DictationOutcome.Silent(id, SilenceReason.NO_SPEECH, kept = false))
                return
            }
            apply(DictationEvent.AudioFinalized)
            val finalizeStartedAt = System.nanoTime()
            inFlight = deps.scope.launch { transcribe(result, finalizeStartedAt) }
        }
    }

    private suspend fun transcribe(capture: Capture, finalizeStartedAt: Long) {
        try {
            val (useLive, liveSession) = synchronized(lock) { liveActiveForSession to live }
            if (useLive && liveSession != null) {
                val liveResult = liveSession.finish(TimeoutPolicy.LIVE_FINAL, capture.framesWritten)
                currentCoroutineContext().ensureActive()
                if (liveResult != null) {
                    val finished = deps.transcription.finishLive(liveResult, config)
                    val corrections = synchronized(lock) {
                        val diff = TranscriptDiff.segments(lastInterim, finished.cleanedTranscript)
                        partialFlow.value = finished.cleanedTranscript
                        correctedFlow.value = finished.cleanedTranscript
                        if (diff.any { it.isCut }) diff else emptyList()
                    }
                    completeTranscription(finished, usedLive = true, corrections, capture, finalizeStartedAt)
                    return
                }
                // Not clean: dropped audio, a dead socket, no final in time. The
                // recording has been accumulating all along, so this costs latency only.
                VoiceLog.i(TAG, "live result unusable — uploading the recording instead")
            }
            val result = deps.transcription.transcribe(audioFile, capture.durationSeconds, config, editing)
            completeTranscription(result, usedLive = false, emptyList(), capture, finalizeStartedAt)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failTranscription(e, capture)
        }
    }

    private suspend fun completeTranscription(result: TranscriptionResult, usedLive: Boolean,
                                              corrections: List<TranscriptDiff.Segment>, capture: Capture, startedAt: Long) {
        synchronized(lock) {
            if (finished || stateFlow.value != DictationState.Transcribing) return
            updateMeta {
                it.copy(rawTranscript = result.rawTranscript, cleanedTranscript = result.cleanedTranscript,
                    modelID = result.modelID, status = SessionMeta.Status.TRANSCRIBING)
            }
            apply(DictationEvent.TranscriptReady)
        }
        val insertion = try {
            insert(result.cleanedTranscript)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            VoiceLog.w(TAG, "inserter threw (${e.javaClass.simpleName}) — the text is in History")
            InsertionOutcome.COPIED_TO_CLIPBOARD
        }
        synchronized(lock) {
            if (finished) return
            val pipelineSeconds = (System.nanoTime() - startedAt) / 1e9
            val (status, event) = when (insertion) {
                InsertionOutcome.INSERTED -> SessionMeta.Status.INSERTED to DictationEvent.Inserted
                InsertionOutcome.TARGET_CHANGED -> SessionMeta.Status.AWAITING_CHIP to DictationEvent.FrontmostChangedAwaitingChip
                InsertionOutcome.COPIED_TO_CLIPBOARD -> SessionMeta.Status.COPIED_TO_CLIPBOARD to DictationEvent.InsertionFellBackToClipboard
                InsertionOutcome.BLOCKED_SECURE_FIELD -> SessionMeta.Status.HELD_SECURE to DictationEvent.InsertionBlockedSecure
            }
            var chain: EditingSession? = null
            if (insertion == InsertionOutcome.INSERTED) {
                val now = deps.clock()
                chain = editing?.appending(result.rawTranscript, result.cleanedTranscript, now)
                    ?: EditingSession(seed = result.cleanedTranscript, updatedAt = now)
                deps.editingSessions.save(chain, config.context.packageName)
            } else if (editing != null) {
                chain = editing.appending(result.rawTranscript, result.cleanedTranscript, deps.clock())
            }
            updateMeta { it.copy(status = status, pipelineSeconds = pipelineSeconds) }
            apply(event)
            finish(DictationOutcome.Transcribed(id, DictationResult(
                sessionId = id, text = result.cleanedTranscript, rawTranscript = result.rawTranscript,
                modelID = result.modelID, usedLive = usedLive, corrections = corrections,
                durationSeconds = capture.durationSeconds, pipelineSeconds = pipelineSeconds,
                editing = if (editing != null) chain else null,
            ), insertion))
        }
    }

    private fun failTranscription(error: Exception, capture: Capture) {
        synchronized(lock) {
            if (finished || stateFlow.value != DictationState.Transcribing) return
            val transcriptionError = error as? TranscriptionError
            // Empty transcript: silence is judged by audio energy, not duration.
            if (transcriptionError == TranscriptionError.EmptyTranscript) {
                if (capture.peakLevel < SILENCE_PEAK_THRESHOLD || capture.durationSeconds < 0.6) {
                    silenceReason = SilenceReason.NO_SPEECH
                    apply(DictationEvent.SilenceOnly)
                    discardArtifacts()
                    finish(DictationOutcome.Silent(id, SilenceReason.NO_SPEECH, kept = false))
                    return
                }
                // A loud room with nothing above it: honest "no speech", but the recording
                // is KEPT as a visible failed row (a .silent row would be hidden and purged).
                val snr = synchronized(audioLock) { noiseFloor.measuredSNR }
                if (config.experimentalNoiseHandling && snr != null && snr < EMPTY_TRANSCRIPT_SNR_THRESHOLD) {
                    updateMeta { it.copy(status = SessionMeta.Status.FAILED, errorCode = "tooNoisy") }
                    silenceReason = SilenceReason.TOO_NOISY
                    apply(DictationEvent.SilenceOnly)
                    finish(DictationOutcome.Silent(id, SilenceReason.TOO_NOISY, kept = true))
                    return
                }
            }
            // Offline is not a failure: the audio queues and drains on reconnect.
            if (transcriptionError == TranscriptionError.Offline) {
                updateMeta { it.copy(status = SessionMeta.Status.QUEUED_FOR_RETRY, errorCode = "offline") }
                apply(DictationEvent.QueuedForRetry)
                finish(DictationOutcome.Queued(id))
                return
            }
            var detail: String? = null
            val (failure, code) = when (transcriptionError) {
                TranscriptionError.Offline -> DictationFailure.NETWORK to "offline"
                is TranscriptionError.BadRequest -> { detail = transcriptionError.detail; DictationFailure.BAD_REQUEST to "bad_request" }
                is TranscriptionError.ModelUnavailable -> {
                    detail = transcriptionError.detail ?: "model ${transcriptionError.model} not accessible"
                    DictationFailure.MODEL_ACCESS to "model"
                }
                is TranscriptionError.Network -> DictationFailure.NETWORK to "network"
                TranscriptionError.Auth -> DictationFailure.AUTH to "auth"
                TranscriptionError.RateLimitedDaily -> DictationFailure.QUOTA_EXHAUSTED to "quota"
                TranscriptionError.RateLimitedTransient -> DictationFailure.RATE_LIMITED to "rate_limit"
                TranscriptionError.Timeout -> DictationFailure.TIMEOUT to "timeout"
                TranscriptionError.EmptyTranscript -> DictationFailure.VALIDATION to "empty"
                TranscriptionError.SafetyBlocked -> DictationFailure.SAFETY_BLOCKED to "safety"
                TranscriptionError.ReviewRejected -> DictationFailure.VALIDATION to "review_rejected"
                null -> DictationFailure.NETWORK to "unknown"
            }
            updateMeta { it.copy(status = SessionMeta.Status.FAILED, errorCode = code, errorMessage = detail) }
            apply(DictationEvent.TranscriptFailed(failure))
            finish(DictationOutcome.Failed(id, failure, code, detail, recordingKept = true))
        }
    }

    // MARK: - Plumbing (call with `lock` held)

    private fun apply(event: DictationEvent): Boolean {
        val next = DictationStateMachine.transition(stateFlow.value, event) ?: return false
        stateFlow.value = next
        return true
    }

    private fun updateMeta(mutate: (SessionMeta) -> SessionMeta) {
        if (!::folder.isInitialized) return
        meta = mutate(meta)
        meta.write(folder)
        deps.onUpdate(meta, folder)
    }

    /** Removes the session folder and asks History to drop its row: what History doesn't show, we don't store. */
    private fun discardArtifacts() {
        closeCapture()
        if (::folder.isInitialized) folder.deleteRecursively()
        deps.onDiscard(id)
    }

    private fun finish(result: DictationOutcome) {
        if (finished) return
        finished = true
        partialPump?.cancel()
        val session = live
        live = null
        if (session != null) deps.scope.launch { session.abort() }
        outcome.complete(result)
        deps.onFinished(this)
    }

    /** The session folder, once created. */
    internal val recordingFolder: File? get() = if (::folder.isInitialized) folder else null

    /** For tests: the folder and the meta as last written. */
    internal val folderForTesting: File get() = folder
    internal val metaForTesting: SessionMeta get() = synchronized(lock) { meta }
}
