package com.charles.bento.core.voice.live

import com.charles.bento.core.voice.audio.AudioFormat
import java.util.Locale

/**
 * Bounded buffer between the audio thread and the socket. Drop-oldest: the newest
 * audio is what the user is still saying. Any drop disqualifies a dictation's live
 * transcript (the batch upload over the recording takes over), so this only decides
 * which words the server sees before the fallback.
 *
 * Bytes count as accepted only after the socket took them ([markAccepted]), so a
 * failed send never looks like a complete stream.
 */
class PcmRing(seconds: Double = 8.0) {
    companion object {
        /** 16 kHz mono Int16. */
        const val BYTES_PER_SECOND = AudioFormat.BYTES_PER_SECOND
    }

    private val capacityBytes = maxOf(BYTES_PER_SECOND, (seconds * BYTES_PER_SECOND).toInt())
    private val chunks = ArrayDeque<ByteArray>()
    private var queuedBytes = 0
    private var accepted = 0L
    private var dropped = 0L
    private var droppedChunkCount = 0

    /** Called from the audio thread. Never blocks for long, never suspends. */
    @Synchronized
    fun append(chunk: ByteArray) {
        if (chunk.isEmpty()) return
        chunks.addLast(chunk)
        queuedBytes += chunk.size
        while (queuedBytes > capacityBytes && chunks.isNotEmpty()) {
            val evicted = chunks.removeFirst()
            queuedBytes -= evicted.size
            dropped += evicted.size
            droppedChunkCount++
        }
    }

    /** Everything waiting, in order, leaving the ring empty. */
    @Synchronized
    fun drain(): List<ByteArray> {
        val out = chunks.toList()
        chunks.clear()
        queuedBytes = 0
        return out
    }

    @Synchronized
    fun markAccepted(byteCount: Int) {
        accepted += byteCount
    }

    /** Bytes the socket actually took; compared with `framesWritten * 2`. */
    val acceptedBytes: Long @Synchronized get() = accepted
    val droppedBytes: Long @Synchronized get() = dropped
    val didDrop: Boolean @Synchronized get() = dropped > 0
    val droppedChunks: Int @Synchronized get() = droppedChunkCount
    val pendingBytes: Int @Synchronized get() = queuedBytes

    val summary: String
        @Synchronized get() = "accepted=${accepted}B dropped=${dropped}B (" +
            String.format(Locale.ROOT, "%.2f", dropped.toDouble() / BYTES_PER_SECOND) + "s, $droppedChunkCount chunks)"
}
