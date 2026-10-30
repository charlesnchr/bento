package com.charles.bento.voice

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import com.charles.bento.core.voice.AppContext
import com.charles.bento.core.voice.DictionaryEntry
import com.charles.bento.core.voice.dictation.DictationConfig
import com.charles.bento.core.voice.dictation.DictationEngine
import com.charles.bento.core.voice.dictation.DictationFailure
import com.charles.bento.core.voice.dictation.DictationOutcome
import com.charles.bento.core.voice.dictation.DictationSession
import com.charles.bento.core.voice.dictation.SilenceReason
import com.charles.bento.core.voice.dictation.VoiceEvent
import com.charles.bento.core.voice.history.RetryQueue
import com.charles.bento.core.voice.history.SessionMeta
import com.charles.bento.settings.Prefs
import com.charles.bento.settings.SecretStore
import com.charles.bento.ui.voice.HistoryRow
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/**
 * Dictation through the Gemini API key (the ported Mac pipeline in :core): Live while
 * talking, batch for what Live missed, the cleanup pass, the validation gate. Recordings
 * are kept until transcribed, so a crash or a dead connection loses nothing: they're
 * retried at launch and when the network returns.
 */
class GeminiVoice(
    private val context: Context,
    private val prefs: Prefs,
    private val secrets: SecretStore,
    private val voiceSync: VoiceSyncModule,
    private val scope: CoroutineScope,
) : VoicePipeline {
    val root = File(context.filesDir, "voice")
    val engine = DictationEngine(root)

    private val _history = MutableStateFlow<List<HistoryRow>>(emptyList())
    val history: StateFlow<List<HistoryRow>> = _history.asStateFlow()

    init {
        scope.launch(Dispatchers.IO) {
            engine.history.changes.collect { _history.value = rows() }
        }
        scope.launch {
            engine.events.collect { e ->
                if (e == VoiceEvent.CleanupAutoDisabled) {
                    // the gate rejected the cleanup three times in a day: the Mac turns it off too
                    voiceSync.perform { setCleanupEnabled(false) }
                    Toast.makeText(context, "Cleanup kept changing what you said, so it's off for now (Settings → Dictation)", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private val recovering = java.util.concurrent.atomic.AtomicBoolean(false)

    /** At launch and when the network returns: finish recordings a crash or an outage left behind. */
    fun recover() {
        val key = secrets.geminiKey ?: return
        // launch and the first network callback arrive together: one pass at a time
        if (!recovering.compareAndSet(false, true)) return
        scope.launch(Dispatchers.IO) {
            try {
                val cfg = baseConfig(key, VoiceRequest(FieldContext(), null, VoiceRequest.Purpose.Dictation))
                runCatching { engine.recoverInterrupted(cfg) }
                runCatching { engine.drainRetryQueue(cfg) }
                runCatching { engine.purgeExpiredAudio() }
            } finally {
                recovering.set(false)
            }
        }
    }

    override fun unavailableReason(): String? =
        if (secrets.geminiKey == null) "Dictation needs a Gemini API key: pair with your Mac or add one in Settings" else null

    override fun open(request: VoiceRequest, onPartial: (String) -> Unit): VoiceSession {
        val key = secrets.geminiKey ?: error(unavailableReason()!!)
        val s = engine.start(baseConfig(key, request)) ?: error("A dictation is already running")
        val partials = scope.launch { s.partialTranscript.collect { onPartial(it) } }
        return object : VoiceSession {
            override fun feed(frame: ShortArray): Boolean = s.feed(frame)

            override suspend fun finish(): String {
                val outcome = s.stop()
                partials.cancel()
                return when (outcome) {
                    is DictationOutcome.Transcribed -> outcome.result.text
                    is DictationOutcome.Silent -> if (outcome.reason == SilenceReason.TOO_NOISY) error("Too noisy to make anything out") else ""
                    is DictationOutcome.Queued -> error("No connection: the recording is saved and will be transcribed when you're back online")
                    is DictationOutcome.Failed -> error(failureMessage(outcome))
                    is DictationOutcome.Cancelled -> ""
                }
            }

            override fun cancel() {
                partials.cancel()
                s.cancel()
            }
        }
    }

    override suspend fun edit(instruction: String, text: String, request: VoiceRequest): String {
        val key = secrets.geminiKey ?: error(unavailableReason()!!)
        return engine.applyVoiceEdit(instruction, text, baseConfig(key, request)).revision
    }

    /** History → Retry: transcribes a kept recording again and copies the text. */
    fun retry(id: String) {
        val key = secrets.geminiKey ?: return
        scope.launch {
            val outcome = withContext(Dispatchers.IO) {
                runCatching { engine.retry(id, baseConfig(key, VoiceRequest(FieldContext(), null, VoiceRequest.Purpose.Dictation))) }
            }
            val text = engine.history.record(id)?.displayText
            when {
                outcome.isFailure -> Toast.makeText(context, outcome.exceptionOrNull()?.message ?: "Retry failed", Toast.LENGTH_LONG).show()
                outcome.getOrNull() == RetryQueue.RetryOutcome.ALREADY_DONE || !text.isNullOrBlank() -> {
                    context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("Dictation", text))
                    Toast.makeText(context, "Transcribed and copied", Toast.LENGTH_SHORT).show()
                }
                else -> Toast.makeText(context, "Still couldn't transcribe it", Toast.LENGTH_LONG).show()
            }
        }
    }

    /** What every dictation runs under: these settings, the synced dictionary and instructions, the mode. */
    private fun baseConfig(key: String, request: VoiceRequest): DictationConfig {
        val docs = voiceSync.docs.value
        val settings = VoiceSyncModule.settings(docs)
        val mode = request.modeId?.let { id -> VoiceSyncModule.modes(docs).firstOrNull { it.id == id } }
        val purposePrompt = when (request.purpose) {
            VoiceRequest.Purpose.Task -> "This is a to-do item. Keep it short and keep dates, times, #projects, @labels and p1–p4 as spoken."
            VoiceRequest.Purpose.Thought -> null
            else -> null
        }
        val ctx = request.context
        return DictationConfig(
            apiKey = key,
            live = prefs.liveTranscription.value,
            cleanup = settings.cleanupEnabled && (mode?.cleanup ?: true),
            toneMatching = prefs.toneMatching.value,
            cleanupModel = prefs.cleanupModel.value,
            language = mode?.language?.takeIf { it.isNotBlank() } ?: prefs.language.value.takeIf { it.isNotBlank() },
            dictionary = VoiceSyncModule.dictionary(docs).map { DictionaryEntry(it.term, it.misspelling, it.starred) },
            customInstructions = settings.effectiveInstructions,
            modePrompt = listOfNotNull(mode?.prompt?.takeIf { it.isNotBlank() }, purposePrompt).joinToString("\n").ifBlank { null },
            context = AppContext(ctx.appPackage, ctx.appLabel, ctx.hint, ctx.textBefore),
            // a captured thought can run long: half an hour still fits in one upload
            recordingCapSeconds = if (request.purpose == VoiceRequest.Purpose.Thought) THOUGHT_CAP_SECONDS
                                  else DictationSession.RECORDING_CAP_SECONDS,
        )
    }

    private companion object {
        const val THOUGHT_CAP_SECONDS = 30 * 60.0
    }

    private fun failureMessage(f: DictationOutcome.Failed): String = f.message?.takeIf { it.isNotBlank() } ?: when (f.failure) {
        DictationFailure.NETWORK -> "Couldn't reach Gemini"
        DictationFailure.NO_AUDIO, DictationFailure.AUDIO, DictationFailure.NO_MICROPHONE -> "The microphone didn't record anything"
        else -> "Transcription failed (${f.code})"
    } + if (f.recordingKept) ". The recording is kept: retry it from the Voice tab." else ""

    private fun rows(): List<HistoryRow> {
        val fmt = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.SHORT).withZone(ZoneId.systemDefault())
        return engine.history.records(limit = 50).map { r ->
            val failed = r.status in setOf(SessionMeta.Status.RECORDED, SessionMeta.Status.TRANSCRIBING) && r.displayText.isBlank() ||
                r.errorCode != null && r.displayText.isBlank()
            HistoryRow(
                id = r.id,
                text = r.displayText.ifBlank { if (failed) (r.errorMessage ?: "Not transcribed: tap to retry") else "(nothing said)" },
                subtitle = listOfNotNull(fmt.format(r.startedAt), r.targetAppName, r.durationSeconds?.let { "%.0f s".format(it) }).joinToString(" · "),
                failed = failed,
            )
        }
    }
}
