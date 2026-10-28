package com.charles.bento.core.voice

/** A transcript: what the model returned, what goes to the cursor, and which models made it. */
data class TranscriptionResult(
    /** What the recogniser returned (live finals joined, or the batch text). */
    val rawTranscript: String,
    /** What is inserted: cleanup (when it ran and passed the gate) plus Dictionary rules. */
    val cleanedTranscript: String,
    /** "gemini-3.5-transcribe/smart+gemini-3.5-flash-lite", like the Mac's History rows. */
    val modelID: String,
)
