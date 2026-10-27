package com.charles.bento.core.voice.live

import com.charles.bento.core.voice.TranscriptionResult
import com.charles.bento.core.voice.VoiceLog
import com.charles.bento.core.voice.format.ReplacementEngine
import kotlinx.coroutines.flow.Flow

/** What the dictation session needs from a live transcriber; faked in tests. */
interface LiveTranscribing {
    /** Opens the socket and handshakes. Throwing is normal: the session uploads instead. */
    suspend fun begin()

    /** Called from the audio thread for every fed buffer. Must not block or suspend. */
    fun enqueue(pcm: ByteArray)

    /**
     * Ends the turn and returns a usable transcript, or null. `framesWritten` is what
     * reached the recording: the stream is trusted only when the socket accepted
     * exactly `framesWritten * 2` bytes (text alone cannot reveal truncation).
     */
    suspend fun finish(deadline: Double, framesWritten: Long): TranscriptionResult?

    /** Tear down without waiting. Idempotent. */
    suspend fun abort()

    /** Speculative text for display only. */
    val partials: Flow<String>
}

/** The real one: a [LiveTranscriptionSession] plus byte reconciliation, stats and Dictionary rules. */
class LiveTranscriber(
    private val session: LiveTranscriptionSession,
    private val modelID: String,
    private val replacementRules: () -> List<ReplacementEngine.Rule>,
    private val stats: LiveStats,
) : LiveTranscribing {

    override val partials: Flow<String> get() = session.partials

    override suspend fun begin() {
        try {
            session.start()
        } catch (e: Exception) {
            // Counted here: a session that never opened never reaches finish().
            stats.recordFallback(LiveStats.Fallback.NEVER_OPENED)
            throw e
        }
    }

    override fun enqueue(pcm: ByteArray) = session.enqueue(pcm)

    override suspend fun finish(deadline: Double, framesWritten: Long): TranscriptionResult? {
        val outcome = session.finish(deadline)
        if (outcome !is LiveTranscriptionSession.Outcome.Completed) {
            if (outcome is LiveTranscriptionSession.Outcome.Unusable) {
                VoiceLog.i(TAG, "live session unusable, falling back to upload: ${outcome.why}")
                // A session that never opened was already counted by begin().
                if (outcome.why != "setup never completed") stats.recordFallback(LiveStats.classify(outcome.why))
            }
            return null
        }
        // The reconciliation: the only check that sees audio that went missing.
        val expected = framesWritten * 2
        val accepted = session.acceptedBytes
        if (accepted != expected) {
            VoiceLog.i(TAG, "live byte mismatch: socket took $accepted of $expected — uploading instead")
            stats.recordFallback(LiveStats.Fallback.TRUNCATED)
            return null
        }
        stats.recordSuccess()
        // Dictionary rules run once over the whole transcript, never per chunk.
        val corrected = ReplacementEngine.apply(replacementRules(), outcome.text)
        return TranscriptionResult(rawTranscript = outcome.text, cleanedTranscript = corrected, modelID = modelID)
    }

    override suspend fun abort() = session.abort()

    private companion object { const val TAG = "LiveTranscriber" }
}
