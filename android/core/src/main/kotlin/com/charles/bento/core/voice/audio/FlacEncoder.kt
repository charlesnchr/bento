package com.charles.bento.core.voice.audio

import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import kotlin.math.abs

/**
 * A small FLAC encoder for 16-bit mono PCM, so uploads match the Mac's
 * `audio/flac` requests byte-for-byte in kind (the Mac encodes with AVAudioFile).
 *
 * Fixed-blocksize stream (4096 samples), each subframe the cheapest of CONSTANT,
 * FIXED (orders 0–4, partitioned Rice residual) and VERBATIM. Speech lands around
 * half the PCM size; digital silence almost nothing. STREAMINFO carries the real
 * frame sizes and the MD5 of the samples, so `flac -t` verifies the output.
 */
object FlacEncoder {
    const val BLOCK_SIZE = 4096
    private const val MAX_FIXED_ORDER = 4
    private const val MAX_PARTITION_ORDER = 6
    private const val MAX_RICE_PARAM = 14
    private const val BITS = 16

    class Output(val bytes: ByteArray, val encodeSeconds: Double)

    fun encode(samples: ShortArray, sampleRate: Int = AudioFormat.SAMPLE_RATE): ByteArray {
        val total = samples.size
        val blockSize = if (total in 1 until BLOCK_SIZE) maxOf(16, total) else BLOCK_SIZE
        val frames = ArrayList<ByteArray>()
        var position = 0
        var frameNumber = 0L
        while (position < total) {
            val n = minOf(blockSize, total - position)
            frames.add(encodeFrame(samples, position, n, frameNumber, blockSize, sampleRate))
            position += n
            frameNumber++
        }
        val md5 = MessageDigest.getInstance("MD5").digest(Pcm.toBytes(samples))
        val out = ByteArrayOutputStream(64 + frames.sumOf { it.size })
        out.write("fLaC".toByteArray(Charsets.US_ASCII))
        out.write(streamInfo(blockSize, frames, sampleRate, total.toLong(), md5))
        for (frame in frames) out.write(frame)
        return out.toByteArray()
    }

    fun encodeTimed(samples: ShortArray, sampleRate: Int = AudioFormat.SAMPLE_RATE): Output {
        val started = System.nanoTime()
        val bytes = encode(samples, sampleRate)
        return Output(bytes, (System.nanoTime() - started) / 1e9)
    }

    private fun streamInfo(blockSize: Int, frames: List<ByteArray>, sampleRate: Int, total: Long, md5: ByteArray): ByteArray {
        val w = BitWriter(42)
        w.write(1, 1) // last metadata block
        w.write(0, 7) // STREAMINFO
        w.write(34, 24)
        w.write(blockSize.toLong(), 16)
        w.write(blockSize.toLong(), 16)
        w.write((frames.minOfOrNull { it.size } ?: 0).toLong(), 24)
        w.write((frames.maxOfOrNull { it.size } ?: 0).toLong(), 24)
        w.write(sampleRate.toLong(), 20)
        w.write(0, 3) // channels - 1
        w.write((BITS - 1).toLong(), 5)
        w.write(total, 36)
        for (b in md5) w.write(b.toLong() and 0xFF, 8)
        return w.toByteArray()
    }

    private fun encodeFrame(samples: ShortArray, offset: Int, n: Int, frameNumber: Long, blockSize: Int, sampleRate: Int): ByteArray {
        val w = BitWriter(n * 2 + 32)
        // Header
        w.write(0x3FFE, 14) // sync
        w.write(0, 1)
        w.write(0, 1) // fixed blocksize
        val sizeCode = when {
            n == blockSize && blockSize == 4096 -> 0b1100
            n <= 256 -> 0b0110
            else -> 0b0111
        }
        w.write(sizeCode.toLong(), 4)
        w.write(sampleRateCode(sampleRate).toLong(), 4)
        w.write(0, 4) // mono
        w.write(0b100, 3) // 16 bits per sample
        w.write(0, 1)
        writeUtf8Number(w, frameNumber)
        if (sizeCode == 0b0110) w.write((n - 1).toLong(), 8)
        if (sizeCode == 0b0111) w.write((n - 1).toLong(), 16)
        val headerBytes = w.toByteArray()
        w.write(Crc.crc8(headerBytes, headerBytes.size).toLong(), 8)

        writeSubframe(w, samples, offset, n)

        w.padToByte()
        val frame = w.toByteArray()
        val crc = Crc.crc16(frame, frame.size)
        w.write(crc.toLong(), 16)
        return w.toByteArray()
    }

    private fun sampleRateCode(rate: Int) = when (rate) {
        8_000 -> 0b0100
        16_000 -> 0b0101
        22_050 -> 0b0110
        24_000 -> 0b0111
        32_000 -> 0b1000
        44_100 -> 0b1001
        48_000 -> 0b1010
        else -> 0b0000 // from STREAMINFO
    }

    private fun writeUtf8Number(w: BitWriter, value: Long) {
        when {
            value < 0x80 -> w.write(value, 8)
            else -> {
                // An n-byte sequence carries 5n+1 bits (n = 2…7).
                var bytes = 2
                while (bytes < 7 && value >= (1L shl (5 * bytes + 1))) bytes++
                val lead = (0xFF shl (8 - bytes)) and 0xFF
                w.write((lead.toLong() or (value ushr (6 * (bytes - 1)))) and 0xFF, 8)
                for (i in bytes - 2 downTo 0) {
                    w.write(0x80L or ((value ushr (6 * i)) and 0x3F), 8)
                }
            }
        }
    }

    private fun writeSubframe(w: BitWriter, samples: ShortArray, offset: Int, n: Int) {
        val first = samples[offset]
        if ((offset until offset + n).all { samples[it] == first }) {
            w.write(0, 1)
            w.write(0b000000, 6) // CONSTANT
            w.write(0, 1)
            w.writeSigned(first.toLong(), BITS)
            return
        }

        // Pick the fixed predictor with the smallest absolute residual.
        var bestOrder = 0
        var bestSum = Long.MAX_VALUE
        val residuals = Array(MAX_FIXED_ORDER + 1) { IntArray(n) }
        for (order in 0..minOf(MAX_FIXED_ORDER, n - 1)) {
            val r = residuals[order]
            var sum = 0L
            for (i in order until n) {
                val p = predict(samples, offset + i, order)
                val res = samples[offset + i] - p
                r[i] = res
                sum += abs(res.toLong())
            }
            if (sum < bestSum) { bestSum = sum; bestOrder = order }
        }
        val residual = residuals[bestOrder]
        val plan = planPartitions(residual, bestOrder, n)
        val fixedBits = 8 + bestOrder * BITS + 2 + 4 + plan.bits
        val verbatimBits = 8 + n * BITS
        if (fixedBits >= verbatimBits) {
            w.write(0, 1)
            w.write(0b000001, 6) // VERBATIM
            w.write(0, 1)
            for (i in 0 until n) w.writeSigned(samples[offset + i].toLong(), BITS)
            return
        }
        w.write(0, 1)
        w.write((0b001000 or bestOrder).toLong(), 6) // FIXED
        w.write(0, 1)
        for (i in 0 until bestOrder) w.writeSigned(samples[offset + i].toLong(), BITS)
        w.write(0b00, 2) // Rice, 4-bit parameters
        w.write(plan.order.toLong(), 4)
        val partitions = 1 shl plan.order
        val perPartition = n shr plan.order
        var index = bestOrder
        for (p in 0 until partitions) {
            val k = plan.params[p]
            w.write(k.toLong(), 4)
            val end = if (p == partitions - 1) n else (p + 1) * perPartition
            while (index < end) {
                val r = residual[index]
                val u = ((r shl 1) xor (r shr 31)).toLong() and 0xFFFF_FFFFL
                w.writeUnary(u ushr k)
                if (k > 0) w.write(u and ((1L shl k) - 1), k)
                index++
            }
        }
    }

    private fun predict(s: ShortArray, i: Int, order: Int): Int = when (order) {
        0 -> 0
        1 -> s[i - 1].toInt()
        2 -> 2 * s[i - 1] - s[i - 2]
        3 -> 3 * s[i - 1] - 3 * s[i - 2] + s[i - 3]
        else -> 4 * s[i - 1] - 6 * s[i - 2] + 4 * s[i - 3] - s[i - 4]
    }

    private class Plan(val order: Int, val params: IntArray, val bits: Long)

    /** Best partition order and per-partition Rice parameter, by exact bit count. */
    private fun planPartitions(residual: IntArray, predictorOrder: Int, n: Int): Plan {
        val folded = LongArray(n)
        for (i in predictorOrder until n) {
            val r = residual[i]
            folded[i] = ((r shl 1) xor (r shr 31)).toLong() and 0xFFFF_FFFFL
        }
        var best: Plan? = null
        for (order in 0..MAX_PARTITION_ORDER) {
            if (order > 0 && (n % (1 shl order) != 0)) break
            val perPartition = n shr order
            if (perPartition <= predictorOrder) break
            val partitions = 1 shl order
            val params = IntArray(partitions)
            var bits = 0L
            for (p in 0 until partitions) {
                val start = if (p == 0) predictorOrder else p * perPartition
                val end = if (p == partitions - 1) n else (p + 1) * perPartition
                val (k, cost) = bestParam(folded, start, end)
                params[p] = k
                bits += 4 + cost
            }
            if (best == null || bits < best.bits) best = Plan(order, params, bits)
        }
        return best ?: Plan(0, intArrayOf(0), 4L + (predictorOrder until n).sumOf { folded[it] + 1 })
    }

    private fun bestParam(folded: LongArray, start: Int, end: Int): Pair<Int, Long> {
        val count = end - start
        if (count <= 0) return 0 to 0L
        var sum = 0L
        for (i in start until end) sum += folded[i]
        val mean = sum / count
        var estimate = 0
        while (estimate < MAX_RICE_PARAM && (1L shl (estimate + 1)) <= mean) estimate++
        var bestK = 0
        var bestCost = Long.MAX_VALUE
        for (k in maxOf(0, estimate - 2)..minOf(MAX_RICE_PARAM, estimate + 2)) {
            var cost = count.toLong() * (k + 1)
            for (i in start until end) cost += folded[i] ushr k
            if (cost < bestCost) { bestCost = cost; bestK = k }
        }
        return bestK to bestCost
    }

    /** MSB-first bit writer. */
    private class BitWriter(capacity: Int) {
        private var buffer = ByteArray(maxOf(16, capacity))
        private var size = 0
        private var acc = 0L
        private var accBits = 0

        fun write(value: Long, bits: Int) {
            var remaining = bits
            while (remaining > 0) {
                val take = minOf(remaining, 32)
                val chunk = (value ushr (remaining - take)) and ((1L shl take) - 1)
                acc = (acc shl take) or chunk
                accBits += take
                remaining -= take
                while (accBits >= 8) {
                    accBits -= 8
                    put(((acc ushr accBits) and 0xFF).toInt())
                }
                acc = acc and ((1L shl accBits) - 1)
            }
        }

        fun writeSigned(value: Long, bits: Int) = write(value and ((1L shl bits) - 1), bits)

        fun writeUnary(zeros: Long) {
            var z = zeros
            while (z >= 32) { write(0, 32); z -= 32 }
            write(1, z.toInt() + 1)
        }

        fun padToByte() {
            if (accBits > 0) write(0, 8 - accBits)
        }

        private fun put(b: Int) {
            if (size == buffer.size) buffer = buffer.copyOf(buffer.size * 2)
            buffer[size++] = b.toByte()
        }

        /** Whole bytes written so far (the partial byte is not included). */
        fun toByteArray(): ByteArray = buffer.copyOf(size)
    }

    internal object Crc {
        private val table8 = IntArray(256) { i ->
            var c = i
            repeat(8) { c = if (c and 0x80 != 0) ((c shl 1) xor 0x07) and 0xFF else (c shl 1) and 0xFF }
            c
        }
        private val table16 = IntArray(256) { i ->
            var c = i shl 8
            repeat(8) { c = if (c and 0x8000 != 0) ((c shl 1) xor 0x8005) and 0xFFFF else (c shl 1) and 0xFFFF }
            c
        }

        fun crc8(data: ByteArray, length: Int): Int {
            var crc = 0
            for (i in 0 until length) crc = table8[(crc xor (data[i].toInt() and 0xFF)) and 0xFF]
            return crc
        }

        fun crc16(data: ByteArray, length: Int): Int {
            var crc = 0
            for (i in 0 until length) {
                crc = ((crc shl 8) xor table16[((crc shr 8) xor (data[i].toInt() and 0xFF)) and 0xFF]) and 0xFFFF
            }
            return crc
        }
    }
}
