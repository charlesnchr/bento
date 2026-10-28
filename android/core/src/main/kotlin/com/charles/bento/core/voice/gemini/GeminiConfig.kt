package com.charles.bento.core.voice.gemini

/** Models and endpoints. Defaults are the Mac's API-key route, exactly. */
object GeminiModels {
    /**
     * PRODUCT DECISION on the Mac, not a tunable default: Bento ships on
     * gemini-3.5-transcribe. No automatic substitution.
     */
    const val TRANSCRIBE = "gemini-3.5-transcribe"
    /** The Live model on the Gemini API (the Vertex helper's is "-preview"). */
    const val TRANSCRIBE_LIVE = "gemini-3.5-transcribe-live"
    const val ENDPOINT = "https://generativelanguage.googleapis.com"
    const val LIVE_ENDPOINT =
        "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
}

data class CleanupModel(val id: String, val name: String)

/** Cleanup models on the Gemini API (the Mac's built-in list; relayed models need the Vertex helper). */
object CleanupModels {
    val builtIn = listOf(
        CleanupModel("gemini-3.5-flash-lite", "Flash-Lite, fastest"),
        CleanupModel("gemini-3.8-flash", "3.8 Flash"),
    )
    val DEFAULT: String = builtIn[0].id

    /**
     * Thinking config the Mac sends with each cleanup model: Flash-Lite supports
     * MINIMAL, 3.8 Flash needs LOW or higher, Gemini 2.x takes a zero budget.
     */
    internal fun thinkingConfig(model: String): Pair<String, Any> = when {
        model.startsWith("gemini-2") -> "thinkingBudget" to 0
        model == "gemini-3.5-flash-lite" -> "thinkingLevel" to "minimal"
        else -> "thinkingLevel" to "low"
    }

    /** The public Gemini API serves only Gemini models; anything else falls back to the default. */
    fun resolve(model: String?): String = model?.trim()?.takeIf { it.startsWith("gemini-") } ?: DEFAULT
}

/** Request budgets, from the Mac's TimeoutPolicy. All seconds. */
object TimeoutPolicy {
    /** How long to wait after activityEnd for the server's final live transcript. */
    const val LIVE_FINAL = 6.0
    const val CONNECT = 5.0
    const val TIME_TO_FIRST_BYTE = 10.0
    const val INTER_CHUNK_STALL = 10.0
    /** When a UI should flip to a "Still working…" state. */
    const val SLOW_STATE_UI = 3.0
    /** Cleanup budget on the Gemini API: probe median 0.3 s, hard cap so raw fallback stays fast. */
    const val CLEANUP_DEADLINE = 1.5
    /** Voice editing's two calls (the Mac's fixed budgets). */
    const val EDIT_TRANSCRIBE = 60.0
    const val EDIT_REVISION = 30.0

    /** Overall per-request deadline, scaling gently: 5 s clip → 31 s; 10 min → 2.5 min. */
    fun overallDeadline(audioDuration: Double): Double = 30 + audioDuration / 4

    fun reviewDeadline(audioDuration: Double): Double = 120 + audioDuration / 2
}
