package com.charles.bento.core.voice.live

import com.charles.bento.core.voice.KeyValueStore
import kotlin.math.roundToInt

/**
 * How live dictation has been going, persisted: attempts, successes, why fallbacks
 * happened, and the failure streak that pauses Live for a minute after three
 * failures in a row (every failed attempt costs a handshake and then the upload).
 */
class LiveStats(private val store: KeyValueStore, private val now: () -> Double = { System.currentTimeMillis() / 1000.0 }) {
    enum class Fallback(val key: String) {
        /** The socket never opened: offline, refused, or the handshake timed out. */
        NEVER_OPENED("neverOpened"),
        /** It opened, then died, or the server ended it. */
        DROPPED_MID_SESSION("droppedMidSession"),
        /** Audio was evicted from the ring, so the transcript would be truncated. */
        TRUNCATED("truncated"),
        /** The server never sent a final transcript in time. */
        NO_FINAL("noFinal"),
        /** The server closed the turn during a pause and ignored what came after. */
        TURN_ENDED_EARLY("turnEndedEarly"),
    }

    companion object {
        private const val ATTEMPTS = "liveAttempts"
        private const val SUCCESSES = "liveSuccesses"
        private const val REASON_PREFIX = "liveFallback_"
        private const val CONSECUTIVE = "liveConsecutiveFailures"
        private const val LAST_FAILURE = "liveLastFailureAt"

        const val FAILURE_LIMIT = 3
        const val RETRY_COOLDOWN = 60.0

        internal fun phrase(reason: Fallback) = when (reason) {
            Fallback.NEVER_OPENED -> "the connection could not be opened"
            Fallback.DROPPED_MID_SESSION -> "the connection dropped mid-sentence"
            Fallback.TRUNCATED -> "audio arrived faster than it could be sent"
            Fallback.NO_FINAL -> "the transcript did not arrive in time"
            Fallback.TURN_ENDED_EARLY -> "the server stopped listening after a long pause"
        }

        /** Maps a session's own explanation onto a coarse reason. */
        fun classify(why: String): Fallback {
            val lowered = why.lowercase()
            if (lowered.contains("ended the turn")) return Fallback.TURN_ENDED_EARLY
            if (lowered.contains("truncated") || lowered.contains("dropped")) return Fallback.TRUNCATED
            if (lowered.contains("setup") || lowered.contains("connect") || lowered.contains("refused")) return Fallback.NEVER_OPENED
            if (lowered.contains("no final") || lowered.contains("empty")) return Fallback.NO_FINAL
            return Fallback.DROPPED_MID_SESSION
        }
    }

    private fun int(key: String) = store.getLong(key)?.toInt() ?: 0

    @Synchronized
    fun recordSuccess() {
        store.putLong(ATTEMPTS, int(ATTEMPTS) + 1L)
        store.putLong(SUCCESSES, int(SUCCESSES) + 1L)
        store.putLong(CONSECUTIVE, 0)
        store.remove(LAST_FAILURE)
    }

    @Synchronized
    fun recordFallback(reason: Fallback, at: Double = now()) {
        store.putLong(ATTEMPTS, int(ATTEMPTS) + 1L)
        store.putLong(REASON_PREFIX + reason.key, int(REASON_PREFIX + reason.key) + 1L)
        store.putLong(CONSECUTIVE, int(CONSECUTIVE) + 1L)
        store.putDouble(LAST_FAILURE, at)
    }

    val attempts: Int get() = int(ATTEMPTS)
    val successes: Int get() = int(SUCCESSES)
    val consecutiveFailures: Int get() = int(CONSECUTIVE)
    fun count(reason: Fallback): Int = int(REASON_PREFIX + reason.key)

    val shouldStopTrying: Boolean get() = shouldStopTrying(now())

    /** Paused for a minute after three failures in a row; a permanent pause could never observe a success. */
    fun shouldStopTrying(at: Double): Boolean {
        if (consecutiveFailures < FAILURE_LIMIT) return false
        val failedAt = store.getDouble(LAST_FAILURE) ?: return false
        val elapsed = at - failedAt
        // Clock changes must not leave Live paused indefinitely either.
        return elapsed >= 0 && elapsed < RETRY_COOLDOWN
    }

    /** Clears the streak, keeping the history: the user turning Live on again. */
    fun clearStreak() {
        store.putLong(CONSECUTIVE, 0)
        store.remove(LAST_FAILURE)
    }

    fun reset() {
        listOf(ATTEMPTS, SUCCESSES, CONSECUTIVE, LAST_FAILURE).forEach(store::remove)
        Fallback.entries.forEach { store.remove(REASON_PREFIX + it.key) }
    }

    /** One honest line for a Settings footer, naming the dominant failure. */
    val summary: String?
        get() {
            if (attempts <= 0) return null
            val percent = (successes.toDouble() / attempts * 100).roundToInt()
            var line = "Used live for $successes of the last $attempts dictations ($percent%)."
            val worst = Fallback.entries.map { it to count(it) }.filter { it.second > 0 }.maxByOrNull { it.second }
            if (worst != null && successes < attempts) line += " Most fell back because ${phrase(worst.first)}."
            if (shouldStopTrying) {
                line += " Live is temporarily paused; it retries on a dictation after one minute, or choose Try Live again."
            }
            return line
        }
}
