package com.charles.bento.core.voice.dictation

import com.charles.bento.core.voice.KeyValueStore
import com.charles.bento.core.voice.TranscriptionError
import com.charles.bento.core.voice.TranscriptionResult
import com.charles.bento.core.voice.VoiceLog
import com.charles.bento.core.voice.audio.FlacEncoder
import com.charles.bento.core.voice.audio.WavReader
import com.charles.bento.core.voice.format.PromptV1
import com.charles.bento.core.voice.format.ReplacementEngine
import com.charles.bento.core.voice.format.ValidationGate
import com.charles.bento.core.voice.gemini.GeminiClient
import com.charles.bento.core.voice.gemini.TimeoutPolicy
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import okhttp3.OkHttpClient
import java.io.File
import java.util.Locale
import kotlin.coroutines.coroutineContext

/** Turns a recording into text. Faked in tests; [GeminiTranscriptionService] is the real one. */
interface TranscriptionService {
    val supportsEditing: Boolean get() = false

    /** Throws [TranscriptionError] (or an IOException for an unreadable recording). */
    suspend fun transcribe(audio: File, durationSeconds: Double, config: DictationConfig, editing: EditingSession? = null): TranscriptionResult

    /** The cleanup pass over a live transcript, when the policy asks for one. */
    suspend fun finishLive(result: TranscriptionResult, config: DictationConfig): TranscriptionResult = result
}

/**
 * State the pipeline keeps across dictations: the cleanup gate's trip log (three
 * rejections in 24 h means the cleanup pass can't be trusted right now) and the
 * vocabulary that provably broke a request.
 */
class VoicePipelineState(private val store: KeyValueStore, private val now: () -> Double = { System.currentTimeMillis() / 1000.0 }) {
    /** Called once when the gate trips for the third time in 24 h with cleanup on: switch cleanup off. */
    @Volatile var onCleanupAutoDisabled: (() -> Unit)? = null

    @Synchronized
    fun recordGateTrip(): Int {
        val at = now()
        val trips = store.getDoubles(GATE_TRIPS).filter { at - it < 86_400 } + at
        store.putDoubles(GATE_TRIPS, trips)
        return trips.size
    }

    /** A deliberate re-enable is a clean slate (the Mac clears trips when cleanup is switched back on). */
    @Synchronized
    fun clearGateTrips() = store.remove(GATE_TRIPS)

    private var blockedVocabulary: List<String>? = null

    @Synchronized
    fun isVocabularyBlocked(vocabulary: List<String>) = blockedVocabulary != null && blockedVocabulary == vocabulary

    @Synchronized
    fun blockVocabulary(vocabulary: List<String>) {
        blockedVocabulary = vocabulary
    }

    private companion object { const val GATE_TRIPS = "gateTrips" }
}

/**
 * The transcription pipeline on the Gemini API, ported from the Mac:
 *
 *   recording → FLAC → interactions (mode smart, custom vocabulary)
 *       → [optional] cleanup model for tone/instructions → validation gate
 *       → ReplacementEngine → text.
 *
 * One silent retry on transient transcribe failures; one re-send for an empty
 * transcript of real audio; cleanup has a hard deadline and never costs the
 * dictation; the Dictionary's rules apply on every path.
 */
class GeminiTranscriptionService(
    /** A client carrying the config's key (the key travels with each dictation's config). */
    private val clientFor: (DictationConfig) -> GeminiClient,
    private val state: VoicePipelineState,
) : TranscriptionService {
    constructor(http: OkHttpClient, state: VoicePipelineState) :
        this({ config: DictationConfig -> GeminiClient({ config.apiKey }, http) }, state)

    override val supportsEditing: Boolean get() = true

    override suspend fun transcribe(audio: File, durationSeconds: Double, config: DictationConfig, editing: EditingSession?): TranscriptionResult {
        if (editing != null) return transcribeEditing(audio, editing, config)
        val policy = config.formattingPolicy
        val transcriber = config.transcribeModel
        val raw = transcribeUploaded(audio, durationSeconds, config, policy)
        if (raw.isEmpty()) throw TranscriptionError.EmptyTranscript
        val dictionary = config.dictionaryInputs

        if (!policy.cleanupPass) {
            // Dictionary rules are a hard guarantee on every path. The gate is not run:
            // with no second model there is nothing independent to compare against.
            return TranscriptionResult(
                rawTranscript = raw,
                cleanedTranscript = ReplacementEngine.apply(dictionary.replacementRules(), raw),
                modelID = "$transcriber/${policy.mode.wire}",
            )
        }
        val cleaned = cleanupOrFallback(raw, config)
        return TranscriptionResult(raw, cleaned, "$transcriber/${policy.mode.wire}+${config.effectiveCleanupModel}")
    }

    override suspend fun finishLive(result: TranscriptionResult, config: DictationConfig): TranscriptionResult {
        if (!config.formattingPolicy.cleanupPass) return result
        val cleaned = cleanupOrFallback(result.rawTranscript, config)
        return TranscriptionResult(result.rawTranscript, cleaned, result.modelID + "+" + config.effectiveCleanupModel)
    }

    /** Recording → FLAC bytes. The FLAC is never stored: the WAV is the only artifact that persists. */
    private fun encode(audio: File): ByteArray {
        val encoded = FlacEncoder.encodeTimed(WavReader.readAll(audio))
        VoiceLog.i(TAG, "FLAC ${encoded.bytes.size} bytes in ${(encoded.encodeSeconds * 1000).toInt()}ms")
        return encoded.bytes
    }

    private suspend fun transcribeUploaded(audio: File, durationSeconds: Double, config: DictationConfig,
                                           policy: DictationConfig.FormattingPolicy): String {
        val flac = encode(audio)
        val vocabulary = vocabularyIfEnabled(config)
        val deadline = TimeoutPolicy.overallDeadline(durationSeconds)
        var raw = transcribeWithRetry(flac, config, policy, vocabulary, deadline).trim()
        if (raw.isEmpty() && durationSeconds >= 0.6) {
            // An empty result on real audio is sometimes nondeterminism: one re-send.
            VoiceLog.i(TAG, "empty transcript on ${String.format(Locale.ROOT, "%.1f", durationSeconds)}s audio — one re-send")
            raw = try {
                sendTranscribe(flac, config, policy, vocabulary, deadline).trim()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                ""
            }
        }
        return raw
    }

    private suspend fun transcribeEditing(audio: File, editing: EditingSession, config: DictationConfig): TranscriptionResult {
        val flac = encode(audio)
        val instruction = clientFor(config).transcribeInteraction(
            audio = flac, model = config.transcribeModel, endpoint = config.endpoint,
            mode = GeminiClient.TranscriptionMode.VERBATIM,
            customVocabulary = config.dictionaryInputs.sanitizedVocabulary(), deadline = TimeoutPolicy.EDIT_TRANSCRIBE,
        ).trim()
        if (instruction.isEmpty()) throw TranscriptionError.EmptyTranscript
        coroutineContext.ensureActive()
        val revision = VoiceEdit.revise(clientFor(config), editing, instruction, config)
        return TranscriptionResult(instruction, revision, config.transcribeModel + "+edit/" + config.effectiveCleanupModel)
    }

    private fun vocabularyIfEnabled(config: DictationConfig): List<String> {
        val vocabulary = config.dictionaryInputs.sanitizedVocabulary()
        return if (state.isVocabularyBlocked(vocabulary)) emptyList() else vocabulary
    }

    /** The ONE place a transcription request is sent: primary, silent retry and second chance. */
    private suspend fun sendTranscribe(flac: ByteArray, config: DictationConfig, policy: DictationConfig.FormattingPolicy,
                                       vocabulary: List<String>, deadline: Double): String {
        suspend fun send(terms: List<String>): String =
            if (config.legacyTranscribeEndpoint) {
                clientFor(config).transcribe(flac, config.transcribeModel, config.endpoint, deadline, terms)
            } else {
                clientFor(config).transcribeInteraction(flac, "audio/flac", config.transcribeModel, config.endpoint, policy.mode, terms, deadline)
            }

        return try {
            send(vocabulary)
        } catch (e: TranscriptionError.BadRequest) {
            if (vocabulary.isEmpty()) throw e
            // Fail open: one strange Dictionary entry must never break dictation. Latch
            // only once the vocabulary-free retry succeeds (a bad key is a 400 too).
            VoiceLog.e(TAG, "transcribe rejected with vocabulary — retrying without it")
            val text = send(emptyList())
            state.blockVocabulary(vocabulary)
            text
        }
    }

    private suspend fun transcribeWithRetry(flac: ByteArray, config: DictationConfig, policy: DictationConfig.FormattingPolicy,
                                            vocabulary: List<String>, deadline: Double): String = try {
        sendTranscribe(flac, config, policy, vocabulary, deadline)
    } catch (e: TranscriptionError) {
        when (e) {
            is TranscriptionError.Network, TranscriptionError.Timeout -> {
                // One silent retry for transient classes (the audio is safe on disk).
                VoiceLog.i(TAG, "transcribe retrying after $e")
                delay(500)
                sendTranscribe(flac, config, policy, vocabulary, deadline)
            }
            else -> throw e
        }
    }

    /** Cleanup that never costs the dictation: a miss, an error or a gate rejection inserts the raw text. */
    private suspend fun cleanupOrFallback(raw: String, config: DictationConfig): String {
        val dictionary = config.dictionaryInputs
        val rules = dictionary.replacementRules()
        val tone = if (config.toneMatching) PromptV1.toneCategory(config.context.packageName) else PromptV1.ToneCategory.NEUTRAL
        val prompt = PromptV1.cleanupPrompt(
            raw = raw,
            tone = tone,
            vocabulary = dictionary.sanitizedVocabulary(),
            spellings = dictionary.spellings(),
            customInstructions = config.customInstructions,
            appContext = if (config.toneMatching) config.context else null,
            modePrompt = config.modePrompt,
            language = config.language,
        )
        return try {
            val response = clientFor(config).cleanup(prompt, config.effectiveCleanupModel, config.endpoint, config.cleanupDeadline)
            val cleaned = ValidationGate.stripArtifacts(response)
            val verdict = ValidationGate.validate(raw, cleaned)
            if (!verdict.accepted) {
                val trips = state.recordGateTrip()
                VoiceLog.w(TAG, "cleanup gate REJECTED (${verdict.reason}, trip #$trips in 24h) — inserting raw")
                if (trips >= 3 && config.formattingPolicy.cleanupPass) {
                    VoiceLog.w(TAG, "cleanup unreliable (3 gate trips in 24h) — asking the app to switch cleanup off")
                    state.onCleanupAutoDisabled?.invoke()
                }
                ReplacementEngine.apply(rules, raw)
            } else {
                // The Dictionary's hard guarantee: explicit rules always win.
                ReplacementEngine.apply(rules, cleaned)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            VoiceLog.i(TAG, "cleanup unavailable (${e.message}) — inserting raw")
            ReplacementEngine.apply(rules, raw)
        }
    }

    private companion object { const val TAG = "Transcription" }
}
