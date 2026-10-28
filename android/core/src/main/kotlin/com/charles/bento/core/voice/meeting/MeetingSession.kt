package com.charles.bento.core.voice.meeting

import com.charles.bento.core.voice.Dictionary
import com.charles.bento.core.voice.DictionaryEntry
import com.charles.bento.core.voice.audio.Pcm
import com.charles.bento.core.voice.gemini.CleanupModels
import com.charles.bento.core.voice.gemini.GeminiClient
import com.charles.bento.core.voice.gemini.GeminiModels
import com.charles.bento.core.voice.history.FileLayout
import com.charles.bento.core.voice.live.OkHttpLiveTransport
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import java.io.Closeable
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.util.Locale

/** What a meeting runs under. Defaults are the Mac's API-key route. */
data class MeetingConfig(
    val apiKey: String,
    /** Live transcription while recording; without it the meeting is transcribed from the recording every few minutes. */
    val live: Boolean = true,
    val dictionary: List<DictionaryEntry> = emptyList(),
    /** Title, summary, decisions and action items when the meeting ends. */
    val summary: Boolean = true,
    val transcribeModel: String = GeminiModels.TRANSCRIBE,
    val liveModel: String = GeminiModels.TRANSCRIBE_LIVE,
    /** The text model for cleanup and the summary: the dictation cleanup model, as on the Mac. */
    val textModel: String = CleanupModels.DEFAULT,
    val endpoint: String = GeminiModels.ENDPOINT,
    val liveEndpoint: String = GeminiModels.LIVE_ENDPOINT,
    val timing: MeetingTiming = MeetingTiming(),
) {
    override fun toString() = "MeetingConfig(live=$live, summary=$summary, transcribe=$transcribeModel, live=$liveModel, text=$textModel)"
}

/** A finished meeting: the document, and the note body to save in Bento's Notes. */
data class MeetingNotes(
    val document: MeetingDocument,
    val title: String,
    /** The note body (see [MeetingNoteRenderer]). */
    val noteMarkdown: String,
    val summary: MeetingSummary?,
    /** Spans that are still missing or failed (the notes say so; retry later). */
    val incomplete: Boolean,
)

/**
 * A meeting being recorded. Feed the mic with [feed] from the audio thread; observe
 * [paragraphs] (cleaned blocks, pending finals and gaps), [interim], [connection],
 * [level] and [elapsed]; [stop] ends capture and returns the finished notes once the
 * missed audio is backfilled, everything is cleaned and the summary is written.
 */
class MeetingSession internal constructor(
    private val recorder: MeetingRecorder,
    private val processor: MeetingProcessor,
    private val engine: MeetingEngine,
) {
    val id: String get() = processor.id
    val folder: File get() = processor.document.folder

    val phase: StateFlow<MeetingRecorder.Phase> get() = recorder.phase
    val connection: StateFlow<MeetingRecorder.Connection> get() = recorder.connection
    val level: StateFlow<Float> get() = recorder.level
    val elapsed: StateFlow<Double> get() = recorder.elapsed
    /** The utterance in progress. Display only. */
    val interim: StateFlow<String> get() = recorder.interim
    val latestLine: StateFlow<String> get() = recorder.latestLine
    val micMuted: StateFlow<Boolean> get() = recorder.micMuted
    val notice: StateFlow<String?> get() = recorder.notice
    /** What finishing is doing ("Transcribing missed audio…"), or null. */
    val step: StateFlow<String?> get() = processor.step
    val document: StateFlow<MeetingDocument> get() = processor.documentFlow
    /** The transcript in reading order, updating as finals land and cleanup runs. */
    val paragraphs: Flow<List<MeetingParagraph>> get() = processor.documentFlow.map { it.paragraphs }

    private val finished = CompletableDeferred<MeetingNotes>()
    private var stopping = false

    /** 16 kHz mono PCM16 samples. Returns false while paused or after stop. */
    fun feed(samples: ShortArray, offset: Int = 0, length: Int = samples.size - offset): Boolean = recorder.feed(samples, offset, length)

    /** Little-endian PCM16 bytes. */
    fun feed(pcm: ByteArray, offset: Int = 0, length: Int = pcm.size - offset): Boolean {
        val samples = Pcm.toShorts(pcm, offset, length)
        return recorder.feed(samples, 0, samples.size)
    }

    suspend fun pause() = recorder.pause()
    suspend fun resume() = recorder.resume()

    /** Keeps the mic out of the meeting while the user dictates (those words are for a text field). */
    fun setMicMuted(muted: Boolean) = recorder.setMicMuted(muted)

    fun rename(title: String) = engine.scope.launch(engine.confined) { processor.rename(title) }

    /** The microphone stopped: pauses the meeting (resume when the mic is back). */
    suspend fun reportAudioInterrupted(message: String = "The microphone stopped") = recorder.reportAudioInterrupted(message)

    /**
     * Ends capture and finishes the notes. Finishing runs in the engine's scope, so
     * cancelling the caller does not abandon it (launch recovery would finish it anyway).
     * A new meeting can start as soon as capture has ended.
     */
    suspend fun stop(): MeetingNotes {
        val start = withContext(engine.confined) { if (stopping) false else { stopping = true; true } }
        if (start) {
            engine.scope.launch {
                try {
                    recorder.stop()
                    engine.captureEnded(this@MeetingSession)
                    processor.finish()
                    finished.complete(engine.notes(processor.document))
                } catch (e: Throwable) {
                    finished.completeExceptionally(e)
                    if (e is kotlinx.coroutines.CancellationException) throw e
                } finally {
                    engine.finishingEnded(processor.id)
                }
            }
        }
        return finished.await()
    }

    /** The app is going away mid-meeting: saves where things stand for launch recovery. */
    suspend fun prepareForTermination() = recorder.prepareForTermination()
}

/**
 * The app's entry point for meetings, rooted at the same directory as the
 * [com.charles.bento.core.voice.dictation.DictationEngine] (meetings live in
 * `<root>/meetings`). One meeting records at a time; finished ones are listed,
 * reloaded, retried and rendered into notes here.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class MeetingEngine internal constructor(
    val root: File,
    private val http: OkHttpClient,
    private val liveHttp: OkHttpClient,
    private val clock: () -> Instant,
    private val servicesOverride: ((MeetingConfig) -> MeetingServices)?,
    private val liveOverride: ((MeetingConfig) -> (() -> MeetingLiveSession?)?)?,
) : Closeable {
    constructor(root: File, httpClient: OkHttpClient = GeminiClient.defaultHttpClient()) :
        this(root, httpClient, OkHttpLiveTransport.defaultClient(), Instant::now, null, null)

    internal val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    internal val confined = Dispatchers.Default.limitedParallelism(1)
    val store = MeetingStore(root)
    private var current: MeetingSession? = null

    /** Locale and zone for titles and dates in notes. */
    @Volatile var locale: Locale = Locale.getDefault()
    @Volatile var zone: ZoneId = ZoneId.systemDefault()

    private fun services(config: MeetingConfig): MeetingServices {
        servicesOverride?.let { return it(config) }
        val models = GeminiMeetingModels(GeminiClient({ config.apiKey }, http), config.transcribeModel,
            CleanupModels.resolve(config.textModel), config.endpoint)
        val dictionary = Dictionary(config.dictionary)
        return MeetingServices(batch = models, text = models, vocabulary = dictionary.sanitizedVocabulary(),
            spellings = dictionary.spellings(), replacementRules = dictionary.replacementRules(), summaryEnabled = config.summary)
    }

    /** Live for meetings follows the transport, not dictation's Live toggle or its failure streak. */
    private fun liveFactory(config: MeetingConfig): (() -> MeetingLiveSession?)? {
        liveOverride?.let { return it(config) }
        if (!config.live || config.apiKey.isBlank()) return null
        val vocabulary = Dictionary(config.dictionary).sanitizedVocabulary()
        return {
            MeetingLiveSession(OkHttpLiveTransport({ config.apiKey }, config.liveEndpoint, liveHttp),
                MeetingLiveProtocol.setupFrame(config.liveModel, vocabulary))
        }
    }

    /** Meetings being finished, recovered or retried right now (confined). */
    private val busy = HashSet<String>()

    /** Starts recording a meeting. Throws if one is already recording or the folder can't be created. */
    suspend fun start(config: MeetingConfig): MeetingSession = withContext(confined) {
        check(current == null) { "a meeting is already recording" }
        val recorder = MeetingRecorder(services(config), store, liveFactory(config), config.timing, scope, confined, clock)
        recorder.start(FileLayout.newId())
        val session = MeetingSession(recorder, recorder.processor!!, this@MeetingEngine)
        current = session
        busy += session.id
        session
    }

    /** The meeting being recorded, if any. */
    val activeSession: MeetingSession? get() = current

    /** Capture is over: another meeting may start while this one's notes are finished. */
    internal suspend fun captureEnded(session: MeetingSession) = withContext(confined) {
        if (current === session) current = null
    }

    internal suspend fun finishingEnded(id: String) = withContext(confined) {
        busy -= id
    }

    private suspend fun claim(id: String): Boolean = withContext(confined) { busy.add(id) }

    internal fun notes(document: MeetingDocument): MeetingNotes = MeetingNotes(
        document = document,
        title = document.displayTitle(locale, zone),
        noteMarkdown = MeetingNoteRenderer.render(document, locale, zone),
        summary = document.meta.summary,
        incomplete = document.meta.pendingBatchCount + document.meta.failedChunkCount > 0,
    )

    /** The note body for any meeting document. */
    fun noteMarkdown(document: MeetingDocument): String = MeetingNoteRenderer.render(document, locale, zone)

    /**
     * Launch recovery: meetings the app died in the middle of (or that finished with
     * spans still pending) are made finishable from disk and finished.
     */
    suspend fun recoverInterrupted(config: MeetingConfig): List<MeetingNotes> {
        val candidates = store.list().filter { entry ->
            when (entry.meta.status) {
                MeetingMeta.Status.RECORDING, MeetingMeta.Status.PAUSED, MeetingMeta.Status.FINISHING, MeetingMeta.Status.INTERRUPTED -> true
                MeetingMeta.Status.COMPLETE -> entry.meta.pendingBatchCount > 0
            }
        }
        val results = ArrayList<MeetingNotes>()
        for (entry in candidates) {
            // A meeting this process is recording or finishing is not interrupted.
            if (!claim(entry.meta.id)) continue
            try {
                val document = store.load(entry.folder) ?: continue
                val recovered = MeetingProcessor.recovered(document) { part -> MeetingAudioExtractor.framesOnDisk(entry.folder, part) }
                val processor = MeetingProcessor(recovered, services(config), store, scope, confined, clock)
                processor.finish()
                results += notes(processor.document)
            } finally {
                finishingEnded(entry.meta.id)
            }
        }
        return results
    }

    /** Retries a finished meeting's failed spans, raw cleanup and missing summary. Null if unknown or busy. */
    suspend fun retry(id: String, config: MeetingConfig): MeetingNotes? {
        val entry = store.find(id) ?: return null
        if (!claim(id)) return null
        try {
            val document = store.load(entry.folder) ?: return null
            val processor = MeetingProcessor(document, services(config), store, scope, confined, clock)
            processor.retry()
            return notes(processor.document)
        } finally {
            finishingEnded(id)
        }
    }

    fun list(): List<MeetingStore.Entry> = store.list()
    fun load(id: String): MeetingDocument? = store.find(id)?.let { store.load(it.folder) }

    /** Deletes a meeting's notes and recording. Refused (false) while it is recording or being finished. */
    suspend fun delete(id: String): Boolean = withContext(confined) {
        if (id in busy) return@withContext false
        store.find(id)?.let { store.delete(it.folder) }
        true
    }

    fun purgeExpiredAudio(retentionDays: Int, now: Instant = clock()): Int = store.purgeExpiredAudio(retentionDays, now)

    override fun close() = scope.cancel()

    companion object {
        /** For tests: fake models and live sessions, and a clock. */
        internal fun forTesting(
            root: File,
            services: (MeetingConfig) -> MeetingServices,
            live: ((MeetingConfig) -> (() -> MeetingLiveSession?)?)? = { null },
            clock: () -> Instant = Instant::now,
        ) = MeetingEngine(root, GeminiClient.defaultHttpClient(), OkHttpLiveTransport.defaultClient(), clock, services, live)
    }
}
