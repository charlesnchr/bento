package com.charles.bento.core.voice.dictation

import com.charles.bento.core.voice.AppContext
import com.charles.bento.core.voice.Dictionary
import com.charles.bento.core.voice.DictionaryEntry
import com.charles.bento.core.voice.gemini.CleanupModels
import com.charles.bento.core.voice.gemini.GeminiClient
import com.charles.bento.core.voice.gemini.GeminiModels
import com.charles.bento.core.voice.gemini.TimeoutPolicy

/**
 * Everything one dictation runs under, read once at start (a setting flipped
 * mid-flight must not change the rules a transcript is produced under). Defaults
 * are the Mac's defaults on the Gemini API-key route.
 */
data class DictationConfig(
    /** Gemini API key, sent as `x-goog-api-key`. */
    val apiKey: String,
    /** Stream to the Live API and show words as they are spoken. Off by default, as on the Mac. */
    val live: Boolean = false,
    /** Master switch for the cleanup model. Off: no second call at all. */
    val cleanup: Boolean = true,
    /**
     * Per-app tone in the cleanup pass (the Mac's "smart cleanup pass", off by default).
     * Also what puts [context]'s field hint and text before the cursor in the prompt.
     */
    val toneMatching: Boolean = false,
    /** Native `mode: smart` transcription (fillers, self-corrections, lists). */
    val smartTranscription: Boolean = true,
    val cleanupModel: String = CleanupModels.DEFAULT,
    val transcribeModel: String = GeminiModels.TRANSCRIBE,
    val liveModel: String = GeminiModels.TRANSCRIBE_LIVE,
    /**
     * The language spoken, as a hint for the cleanup prompt only. Never sent to the
     * transcription API as language codes: with smart mode that silently disables
     * the formatting (verified on the Mac); auto-detection needs no hint.
     */
    val language: String? = null,
    val dictionary: List<DictionaryEntry> = emptyList(),
    /** Personal style instructions; blank means none. Asking for them turns the cleanup pass on. */
    val customInstructions: String = "",
    /** An optional mode prompt (e.g. "format as a bulleted list"); also turns the cleanup pass on. */
    val modePrompt: String? = null,
    /** Where the text is going. */
    val context: AppContext = AppContext(),
    val endpoint: String = GeminiModels.ENDPOINT,
    val liveEndpoint: String = GeminiModels.LIVE_ENDPOINT,
    /** Escape hatch back to `:generateContent` (verbatim only; disables Live). */
    val legacyTranscribeEndpoint: Boolean = false,
    /** Judge trailing speech and empty transcripts relative to the room. Off by default. */
    val experimentalNoiseHandling: Boolean = false,
    /** Hard cap on the cleanup call; a miss inserts the transcript without cleanup. */
    val cleanupDeadline: Double = TimeoutPolicy.CLEANUP_DEADLINE,
) {
    /** How a dictation gets formatted: two independent flags, as on the Mac. */
    data class FormattingPolicy(val nativeSmart: Boolean, val cleanupPass: Boolean) {
        val mode: GeminiClient.TranscriptionMode
            get() = if (nativeSmart) GeminiClient.TranscriptionMode.SMART else GeminiClient.TranscriptionMode.VERBATIM
    }

    /** Whether anything asks for the cleanup model, before the master switch. */
    val cleanupRequested: Boolean
        get() = toneMatching || customInstructions.isNotBlank() || !modePrompt.isNullOrBlank()

    val formattingPolicy: FormattingPolicy
        get() = FormattingPolicy(
            // The legacy endpoint returns an empty transcript with `mode`.
            nativeSmart = smartTranscription && !legacyTranscribeEndpoint,
            cleanupPass = cleanup && cleanupRequested && apiKey.isNotBlank(),
        )

    /** Live needs the interactions-era transport; the legacy escape hatch wins. */
    val liveActive: Boolean get() = live && !legacyTranscribeEndpoint && apiKey.isNotBlank()

    /** The cleanup model actually used (the public API serves only Gemini models). */
    val effectiveCleanupModel: String get() = CleanupModels.resolve(cleanupModel)

    internal val dictionaryInputs: Dictionary get() = Dictionary(dictionary)

    override fun toString(): String =
        "DictationConfig(live=$live, cleanup=$cleanup, toneMatching=$toneMatching, smart=$smartTranscription, " +
            "transcribe=$transcribeModel, cleanupModel=$cleanupModel, liveModel=$liveModel, dictionary=${dictionary.size})"
}
