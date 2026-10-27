package com.charles.bento.core.voice.audio

import java.io.Closeable
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile

/**
 * Crash-safe recording: a 16 kHz mono PCM16 WAV written as audio arrives. Every
 * [append] goes straight to the file (no user-space buffer), so a killed app keeps
 * everything written so far; the header's sizes are patched every second and on
 * [close], and [WavReader] trusts the file length over a stale header anyway.
 *
 * Replaces the Mac's CAF, which AVAudioFile writes the same way.
 */
class WavWriter(val file: File, private val headerPatchIntervalFrames: Long = AudioFormat.SAMPLE_RATE.toLong()) : Closeable {
    private val raf: RandomAccessFile
    var framesWritten: Long = 0
        private set
    private var framesAtLastPatch = 0L
    private var closed = false

    init {
        file.parentFile?.mkdirs()
        raf = RandomAccessFile(file, "rw")
        raf.setLength(0)
        raf.write(header(0))
    }

    /** Appends samples. Throws on a disk error; the caller decides when to give up. */
    @Throws(IOException::class)
    fun append(samples: ShortArray, offset: Int = 0, length: Int = samples.size - offset) {
        if (length <= 0) return
        check(!closed) { "writer closed" }
        raf.write(Pcm.toBytes(samples, offset, length))
        framesWritten += length
        if (framesWritten - framesAtLastPatch >= headerPatchIntervalFrames) patchHeader()
    }

    @Throws(IOException::class)
    fun appendBytes(pcm: ByteArray, offset: Int = 0, length: Int = pcm.size - offset) {
        val even = length - (length % 2)
        if (even <= 0) return
        check(!closed) { "writer closed" }
        raf.write(pcm, offset, even)
        framesWritten += even / 2
        if (framesWritten - framesAtLastPatch >= headerPatchIntervalFrames) patchHeader()
    }

    private fun patchHeader() {
        try {
            val position = raf.filePointer
            raf.seek(0)
            raf.write(header(framesWritten * 2))
            raf.seek(position)
            framesAtLastPatch = framesWritten
        } catch (_: IOException) {
            // The data itself is what matters; the reader recovers sizes from the length.
        }
    }

    override fun close() {
        if (closed) return
        closed = true
        try {
            patchHeader()
            raf.fd.sync()
        } catch (_: IOException) {
        } finally {
            runCatching { raf.close() }
        }
    }

    companion object {
        const val HEADER_BYTES = 44

        fun header(dataBytes: Long, sampleRate: Int = AudioFormat.SAMPLE_RATE): ByteArray {
            val data = dataBytes.coerceIn(0, 0xFFFF_FFFFL - 36).toInt()
            val out = ByteArray(HEADER_BYTES)
            fun str(at: Int, s: String) = s.forEachIndexed { i, c -> out[at + i] = c.code.toByte() }
            fun u32(at: Int, v: Int) { for (i in 0..3) out[at + i] = ((v ushr (8 * i)) and 0xFF).toByte() }
            fun u16(at: Int, v: Int) { out[at] = (v and 0xFF).toByte(); out[at + 1] = ((v shr 8) and 0xFF).toByte() }
            str(0, "RIFF"); u32(4, 36 + data); str(8, "WAVE")
            str(12, "fmt "); u32(16, 16); u16(20, 1); u16(22, 1)
            u32(24, sampleRate); u32(28, sampleRate * 2); u16(32, 2); u16(34, 16)
            str(36, "data"); u32(40, data)
            return out
        }

        /** Writes a whole clip at once (meeting batch windows, tests). */
        fun write(file: File, samples: ShortArray) {
            WavWriter(file).use { it.append(samples) }
        }
    }
}

/**
 * Reads PCM16 mono WAVs: ours (whose header may be stale after a crash) and ordinary
 * ones with extra chunks. Only 16-bit mono PCM is accepted.
 */
object WavReader {
    class Info(val sampleRate: Int, val dataOffset: Long, val frames: Long)

    @Throws(IOException::class)
    fun info(file: File): Info {
        RandomAccessFile(file, "r").use { raf ->
            val head = ByteArray(12)
            if (raf.length() < 12) throw IOException("not a WAV file")
            raf.readFully(head)
            if (String(head, 0, 4, Charsets.US_ASCII) != "RIFF" || String(head, 8, 4, Charsets.US_ASCII) != "WAVE") {
                throw IOException("not a WAV file")
            }
            var sampleRate = AudioFormat.SAMPLE_RATE
            var position = 12L
            val chunk = ByteArray(8)
            while (position + 8 <= raf.length()) {
                raf.seek(position)
                raf.readFully(chunk)
                val id = String(chunk, 0, 4, Charsets.US_ASCII)
                val size = le32(chunk, 4).toLong() and 0xFFFF_FFFFL
                if (id == "fmt ") {
                    val fmt = ByteArray(16)
                    raf.readFully(fmt)
                    val format = le16(fmt, 0)
                    val channels = le16(fmt, 2)
                    sampleRate = le32(fmt, 4)
                    val bits = le16(fmt, 14)
                    if ((format != 1 && format != 0xFFFE) || channels != 1 || bits != 16) {
                        throw IOException("unsupported WAV format ($format, $channels ch, $bits bit)")
                    }
                } else if (id == "data") {
                    val dataOffset = position + 8
                    // A crashed recording's header still says 0 (or a stale size): the
                    // file length is the truth.
                    val available = raf.length() - dataOffset
                    val bytes = if (size == 0L || size > available) available else size
                    return Info(sampleRate, dataOffset, bytes / 2)
                }
                position += 8 + size + (size and 1)
            }
            throw IOException("WAV has no data chunk")
        }
    }

    /** Frames on disk, or null when the file is missing or unreadable. */
    fun frames(file: File): Long? = if (!file.exists()) null else runCatching { info(file).frames }.getOrNull()

    /** All samples. */
    @Throws(IOException::class)
    fun readAll(file: File): ShortArray {
        val info = info(file)
        return read(file, info, 0, info.frames)
    }

    /** Samples in [start, end), padded with silence past the end of the file. */
    @Throws(IOException::class)
    fun readRange(file: File, start: Long, end: Long): ShortArray {
        val info = info(file)
        return read(file, info, start, end)
    }

    private fun read(file: File, info: Info, start: Long, end: Long): ShortArray {
        val count = (end - start).coerceAtLeast(0)
        require(count <= Int.MAX_VALUE) { "range too long" }
        val out = ShortArray(count.toInt())
        if (start >= info.frames || count == 0L) return out
        val available = minOf(end, info.frames) - start
        RandomAccessFile(file, "r").use { raf ->
            raf.seek(info.dataOffset + start * 2)
            val bytes = ByteArray((available * 2).toInt())
            raf.readFully(bytes)
            val shorts = Pcm.toShorts(bytes)
            System.arraycopy(shorts, 0, out, 0, shorts.size)
        }
        return out
    }

    private fun le16(b: ByteArray, at: Int) = (b[at].toInt() and 0xFF) or ((b[at + 1].toInt() and 0xFF) shl 8)
    private fun le32(b: ByteArray, at: Int) =
        (b[at].toInt() and 0xFF) or ((b[at + 1].toInt() and 0xFF) shl 8) or
            ((b[at + 2].toInt() and 0xFF) shl 16) or ((b[at + 3].toInt() and 0xFF) shl 24)
}
