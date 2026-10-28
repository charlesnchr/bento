package com.charles.bento.core.voice.dictation

import com.charles.bento.core.voice.TranscriptionError
import com.charles.bento.core.voice.gemini.GeminiClient
import com.charles.bento.core.voice.gemini.TimeoutPolicy
import java.time.Instant

/** A voice edit's result: the replacement text and the editing chain to continue from. */
data class VoiceEditResult(val revision: String, val session: EditingSession, val modelID: String)

/**
 * Voice editing of text just dictated ("make that shorter", "keep the dates"),
 * with the cleanup model and the Mac's editing prompt. The similarity gate does not
 * apply: summarizing legitimately changes the length.
 */
object VoiceEdit {
    /** Applies an already transcribed instruction to `text` (a fresh chain seeded with it). */
    suspend fun apply(client: GeminiClient, instruction: String, text: String, config: DictationConfig): VoiceEditResult =
        apply(client, instruction, EditingSession(seed = text), config)

    /** Applies an instruction to an existing chain, so "undo that" can see earlier turns. */
    suspend fun apply(client: GeminiClient, instruction: String, session: EditingSession, config: DictationConfig,
                      now: Instant = Instant.now()): VoiceEditResult {
        val trimmed = instruction.trim()
        if (trimmed.isEmpty()) throw TranscriptionError.EmptyTranscript
        val revision = revise(client, session, trimmed, config)
        return VoiceEditResult(revision, session.appending(trimmed, revision, now), "edit/" + config.effectiveCleanupModel)
    }

    internal suspend fun revise(client: GeminiClient, session: EditingSession, instruction: String, config: DictationConfig): String {
        val revision = client.cleanup(
            prompt = session.prompt(instruction),
            model = config.effectiveCleanupModel,
            endpoint = config.endpoint,
            deadline = TimeoutPolicy.EDIT_REVISION,
        ).trim()
        if (revision.isEmpty()) throw TranscriptionError.EmptyTranscript
        return revision
    }
}
