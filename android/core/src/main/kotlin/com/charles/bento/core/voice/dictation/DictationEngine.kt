package com.charles.bento.core.voice.dictation

import com.charles.bento.core.voice.FileKeyValueStore
import com.charles.bento.core.voice.KeyValueStore
import com.charles.bento.core.voice.TranscriptionError
import com.charles.bento.core.voice.TranscriptionResult
import com.charles.bento.core.voice.audio.WavReader
import com.charles.bento.core.voice.gemini.GeminiClient
import com.charles.bento.core.voice.history.DictationRecord
import com.charles.bento.core.voice.history.FileLayout
import com.charles.bento.core.voice.history.HistoryStore
import com.charles.bento.core.voice.history.RecoveryScanner
import com.charles.bento.core.voice.history.RetentionPolicy
import com.charles.bento.core.voice.history.RetryQueue
import com.charles.bento.core.voice.history.SessionMeta
import com.charles.bento.core.voice.history.durationOf
import com.charles.bento.core.voice.history.forRetry
import com.charles.bento.core.voice.live.LiveSetup
import com.charles.bento.core.voice.live.LiveStats
import com.charles.bento.core.voice.live.LiveTranscriber
import com.charles.bento.core.voice.live.LiveTranscribing
import com.charles.bento.core.voice.live.LiveTranscriptionSession
import com.charles.bento.core.voice.live.OkHttpLiveTransport
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import okhttp3.OkHttpClient
import java.io.Closeable
import java.io.File
import java.time.Instant

/** Things the app should act on that don't belong to one session. */
sealed class VoiceEvent {
    /**
     * The cleanup gate rejected three outputs in 24 h: cleanup can't be trusted right
     * now. The Mac switches its cleanup setting off; the app should do the same and tell
     * the user (their words are unaffected).
     */
    data object CleanupAutoDisabled : VoiceEvent()
}

/**
 * The app's entry point for dictation: one engine per process, rooted at a directory
 * the app owns (e.g. `File(context.filesDir, "voice")`). It owns History (recordings
 * and `meta.json` under `<root>/recordings`), Live's stats, the cleanup gate's state,
 * and the voice-editing chains, and runs one [DictationSession] at a time.
 *
 * At launch call [recoverInterrupted] then [drainRetryQueue]; call [drainRetryQueue]
 * again when connectivity returns, and [purgeExpiredAudio] now and then.
 */
class DictationEngine internal constructor(
    val root: File,
    private val stateStore: KeyValueStore,
    private val clock: () -> Instant,
    private val http: OkHttpClient,
    private val liveHttp: OkHttpClient,
    transcriptionOverride: TranscriptionService?,
    private val liveOverride: ((DictationConfig) -> LiveTranscribing?)?,
) : Closeable {

    constructor(
        root: File,
        httpClient: OkHttpClient = GeminiClient.defaultHttpClient(),
        stateStore: KeyValueStore = FileKeyValueStore(File(root, "voice-state.json")),
    ) : this(root, stateStore, Instant::now, httpClient, OkHttpLiveTransport.defaultClient(), null, null)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val history = HistoryStore(root)
    val liveStats = LiveStats(stateStore)
    val pipelineState = VoicePipelineState(stateStore)
    private val transcription: TranscriptionService = transcriptionOverride ?: GeminiTranscriptionService(http, pipelineState)
    private val editingSessions = EditingSessionStore()
    private val retryQueue = RetryQueue(history, transcription)
    private val recoveryScanner = RecoveryScanner(history, transcription)

    private val eventFlow = MutableSharedFlow<VoiceEvent>(extraBufferCapacity = 8, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    val events: SharedFlow<VoiceEvent> = eventFlow.asSharedFlow()

    /** Days to keep recordings once transcribed. 0 = forever, negative = never keep. The Mac's default is 7. */
    @Volatile var audioRetentionDays: Int = 7

    private val lock = Any()
    private var active: DictationSession? = null

    /** The session in progress, if any. */
    val activeSession: DictationSession? get() = synchronized(lock) { active?.takeUnless { it.state.value.isTerminal } }

    init {
        pipelineState.onCleanupAutoDisabled = { eventFlow.tryEmit(VoiceEvent.CleanupAutoDisabled) }
    }

    /**
     * Starts a dictation. Returns null while another one is in progress. `insert` is
     * called with the final text before [DictationSession.stop] returns; report what
     * happened (the default says the app inserted it).
     */
    fun start(config: DictationConfig, insert: suspend (String) -> InsertionOutcome = { InsertionOutcome.INSERTED }): DictationSession? =
        begin(config, null, insert)

    /**
     * Starts a voice edit of the last dictation in the target app ("make that shorter"):
     * the recording is the instruction, and the result's text is the full replacement.
     * Returns null when there is nothing recent to edit (or another session is running).
     */
    fun startEditing(config: DictationConfig, session: EditingSession? = null,
                     insert: suspend (String) -> InsertionOutcome = { InsertionOutcome.INSERTED }): DictationSession? {
        val chain = session ?: editingSessions.session(config.context.packageName, clock()) ?: return null
        return begin(config, chain, insert)
    }

    /** The edit chain for the app's last dictation (5 minutes), or null. */
    fun recentEditingSession(packageName: String?): EditingSession? = editingSessions.session(packageName, clock())

    private fun begin(config: DictationConfig, editing: EditingSession?, insert: suspend (String) -> InsertionOutcome): DictationSession? {
        val session: DictationSession
        synchronized(lock) {
            if (active?.state?.value?.isTerminal == false) return null
            session = DictationSession(FileLayout.newId(), config, editing, insert, deps())
            active = session
        }
        // A new dictation (accepted, not refused) ends the app's edit chain, as on the Mac.
        if (editing == null) editingSessions.reset(config.context.packageName)
        session.begin() // a setup failure finishes the session as Failed(STORAGE)
        return session
    }

    private fun deps() = SessionDeps(
        root = root,
        transcription = transcription,
        makeLive = ::makeLive,
        scope = scope,
        clock = clock,
        onUpdate = ::sessionUpdated,
        onDiscard = { id -> history.delete(id, removeFolder = false) },
        onFinished = { finished -> synchronized(lock) { if (active === finished) active = null } },
        editingSessions = editingSessions,
    )

    private fun sessionUpdated(meta: SessionMeta, folder: File) {
        history.upsert(meta, folder)
        // "Never keep audio": the recording goes as soon as the words exist.
        if (audioRetentionDays < 0 && (meta.rawTranscript != null || meta.status == SessionMeta.Status.SILENT)) {
            FileLayout.audioWAV(folder).delete()
        }
    }

    /** A live transcriber for this config, or null: Live off, no key, or paused after repeated failures. */
    private fun makeLive(config: DictationConfig): LiveTranscribing? {
        liveOverride?.let { return it(config) }
        if (!config.liveActive) return null
        if (liveStats.shouldStopTrying) return null
        val dictionary = config.dictionaryInputs
        val session = LiveTranscriptionSession(
            transport = OkHttpLiveTransport({ config.apiKey }, config.liveEndpoint, liveHttp),
            setup = LiveSetup(
                model = config.liveModel,
                smart = config.smartTranscription,
                // The same terms the batch path biases with.
                customVocabulary = dictionary.sanitizedVocabulary(),
            ),
        )
        return LiveTranscriber(session, config.liveModel, { dictionary.replacementRules() }, liveStats)
    }

    // MARK: - Voice editing without audio

    /** Applies an already transcribed instruction to `text`, starting a chain for the target app. */
    suspend fun applyVoiceEdit(instruction: String, text: String, config: DictationConfig): VoiceEditResult =
        applyVoiceEdit(instruction, EditingSession(seed = text, updatedAt = clock()), config)

    /** Applies an instruction to an existing chain (so "undo that" works) and keeps the chain for the app. */
    suspend fun applyVoiceEdit(instruction: String, session: EditingSession, config: DictationConfig): VoiceEditResult {
        val result = VoiceEdit.apply(GeminiClient({ config.apiKey }, http), instruction, session, config, clock())
        editingSessions.save(result.session, config.context.packageName)
        return result
    }

    // MARK: - History, recovery, retry

    /** Launch recovery: finds sessions a killed app left behind and recovers or queues them. */
    suspend fun recoverInterrupted(config: DictationConfig): RecoveryScanner.Report = recoveryScanner.scanAndRecover(config)

    /** Re-runs offline-queued and transiently failed recordings. */
    suspend fun drainRetryQueue(config: DictationConfig): RetryQueue.DrainResult = retryQueue.drain(config)

    /** The History row's Retry button. */
    suspend fun retry(sessionId: String, config: DictationConfig): RetryQueue.RetryOutcome {
        val record = history.record(sessionId) ?: return RetryQueue.RetryOutcome.ALREADY_DONE
        return retryQueue.retrySingle(record, config)
    }

    /**
     * Retry with another model: re-transcribes any kept recording with the given models
     * (null keeps the config's) and replaces the row's text. The app decides whether to
     * replace text it inserted. Throws [TranscriptionError] on failure (the row keeps
     * its previous text).
     */
    suspend fun retryWithModel(sessionId: String, config: DictationConfig, transcribeModel: String? = null,
                               cleanupModel: String? = null): TranscriptionResult {
        val record: DictationRecord = history.record(sessionId) ?: throw TranscriptionError.BadRequest("unknown session")
        val meta = SessionMeta.read(record.folder) ?: throw TranscriptionError.BadRequest("session has no metadata")
        val audio = FileLayout.audioWAV(record.folder)
        if (!audio.exists() || (WavReader.frames(audio) ?: 0L) == 0L) throw TranscriptionError.BadRequest("recording is gone")
        val retryConfig = config.forRetry(meta).copy(
            transcribeModel = transcribeModel ?: config.transcribeModel,
            cleanupModel = cleanupModel ?: config.cleanupModel,
        )
        val result = transcription.transcribe(audio, durationOf(meta, audio), retryConfig, null)
        val updated = meta.copy(rawTranscript = result.rawTranscript, cleanedTranscript = result.cleanedTranscript,
            modelID = result.modelID, errorCode = null, errorMessage = null,
            status = if (meta.status == SessionMeta.Status.INSERTED) meta.status else SessionMeta.Status.RECOVERED)
        updated.write(record.folder)
        sessionUpdated(updated, record.folder)
        return result
    }

    /** Applies the retention setting to recordings on disk. */
    fun purgeExpiredAudio(now: Instant = clock()): Int =
        RetentionPolicy.purgeExpiredAudio(history.recordingsRoot, audioRetentionDays, now)

    /** Deletes all History and recordings, sparing the session in progress, and forgets edit chains. */
    fun deleteAllHistory() {
        val spared = activeSession?.recordingFolder
        history.deleteAll(removeFolders = true, sparing = spared)
        editingSessions.clear()
    }

    /** Onboarding's key check: valid, rejected (never advance), or unreachable (let them continue). */
    suspend fun validateKey(apiKey: String, endpoint: String = com.charles.bento.core.voice.gemini.GeminiModels.ENDPOINT): GeminiClient.KeyCheck =
        GeminiClient({ apiKey }, http).validateKey(endpoint)

    /** Stops background work. A session in progress is abandoned (its recording stays for recovery). */
    override fun close() {
        synchronized(lock) { active }?.abandon()
        scope.cancel()
    }

    companion object {
        /** For tests: an engine with fake transcription and live, and an injectable clock. */
        internal fun forTesting(
            root: File,
            transcription: TranscriptionService,
            live: ((DictationConfig) -> LiveTranscribing?)? = { null },
            clock: () -> Instant = Instant::now,
            stateStore: KeyValueStore = com.charles.bento.core.voice.InMemoryKeyValueStore(),
        ) = DictationEngine(root, stateStore, clock, GeminiClient.defaultHttpClient(), OkHttpLiveTransport.defaultClient(),
            transcription, live)
    }
}
