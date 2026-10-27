package com.charles.bento.core.voice.audio

import com.charles.bento.core.voice.tempDir
import com.charles.bento.core.voice.tone
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.Random
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A strict little FLAC decoder (fixed blocksize, mono, 16-bit; CONSTANT, VERBATIM,
 * FIXED and LPC subframes; Rice and Rice2 residuals), checking both CRCs and the
 * STREAMINFO MD5. Test-only: it is the round-trip oracle for [FlacEncoder].
 */
object FlacTestDecoder {
    class Decoded(val sampleRate: Int, val totalSamples: Long, val samples: ShortArray, val md5Matches: Boolean,
                  val minFrame: Int, val maxFrame: Int, val frameSizes: List<Int>)

    private class Bits(val data: ByteArray, var pos: Long = 0) {
        fun read(n: Int): Long {
            var v = 0L
            repeat(n) {
                val byte = data[(pos ushr 3).toInt()].toInt() and 0xFF
                val bit = (byte ushr (7 - (pos and 7).toInt())) and 1
                v = (v shl 1) or bit.toLong()
                pos++
            }
            return v
        }
        fun signed(n: Int): Long { val v = read(n); return if (n > 0 && v and (1L shl (n - 1)) != 0L) v - (1L shl n) else v }
        fun unary(): Long { var z = 0L; while (read(1) == 0L) z++; return z }
        fun align() { pos = (pos + 7) and 7L.inv() }
        val byte: Int get() = (pos ushr 3).toInt()
    }

    fun decode(bytes: ByteArray): Decoded {
        require(String(bytes, 0, 4, Charsets.US_ASCII) == "fLaC") { "no fLaC marker" }
        val b = Bits(bytes, 32)
        var sampleRate = 0
        var total = 0L
        var md5 = ByteArray(16)
        var minFrame = 0
        var maxFrame = 0
        while (true) {
            val last = b.read(1) == 1L
            val type = b.read(7).toInt()
            val length = b.read(24).toInt()
            val start = b.pos
            if (type == 0) {
                b.read(16); b.read(16)
                minFrame = b.read(24).toInt(); maxFrame = b.read(24).toInt()
                sampleRate = b.read(20).toInt()
                require(b.read(3) == 0L) { "mono only" }
                require(b.read(5) == 15L) { "16-bit only" }
                total = b.read(36)
                md5 = ByteArray(16) { b.read(8).toByte() }
            }
            b.pos = start + length * 8L
            if (last) break
        }
        val out = ArrayList<Short>()
        val frameSizes = ArrayList<Int>()
        while (b.byte < bytes.size) {
            val frameStart = b.byte
            require(b.read(14) == 0x3FFEL) { "lost sync at $frameStart" }
            b.read(1); require(b.read(1) == 0L)
            val sizeCode = b.read(4).toInt()
            val rateCode = b.read(4).toInt()
            require(b.read(4) == 0L)
            require(b.read(3) == 4L)
            b.read(1)
            // UTF-8 frame number
            val first = b.read(8).toInt()
            var extra = 0
            var mask = 0x80
            while (first and mask != 0) { extra++; mask = mask shr 1 }
            repeat(maxOf(0, extra - 1)) { require(b.read(8).toInt() and 0xC0 == 0x80) }
            val blockSize = when (sizeCode) {
                1 -> 192
                in 2..5 -> 576 shl (sizeCode - 2)
                6 -> b.read(8).toInt() + 1
                7 -> b.read(16).toInt() + 1
                in 8..15 -> 256 shl (sizeCode - 8)
                else -> error("reserved block size")
            }
            if (rateCode == 12) b.read(8) else if (rateCode == 13 || rateCode == 14) b.read(16)
            val headerEnd = b.byte
            val crc8 = b.read(8).toInt()
            require(crc8 == FlacEncoder.Crc.crc8(bytes.copyOfRange(frameStart, headerEnd), headerEnd - frameStart)) { "header CRC" }
            val samples = subframe(b, blockSize)
            b.align()
            val crcEnd = b.byte
            val crc16 = b.read(16).toInt()
            require(crc16 == FlacEncoder.Crc.crc16(bytes.copyOfRange(frameStart, crcEnd), crcEnd - frameStart)) { "frame CRC" }
            frameSizes += b.byte - frameStart
            samples.forEach { out += it.toInt().toShort() }
        }
        val decoded = ShortArray(out.size) { out[it] }
        val digest = MessageDigest.getInstance("MD5").digest(Pcm.toBytes(decoded))
        return Decoded(sampleRate, total, decoded, digest.contentEquals(md5), minFrame, maxFrame, frameSizes)
    }

    private fun subframe(b: Bits, n: Int): LongArray {
        require(b.read(1) == 0L)
        val type = b.read(6).toInt()
        require(b.read(1) == 0L) { "wasted bits unsupported" }
        val s = LongArray(n)
        when {
            type == 0 -> { val v = b.signed(16); s.fill(v) }
            type == 1 -> for (i in 0 until n) s[i] = b.signed(16)
            type in 8..12 -> {
                val order = type - 8
                for (i in 0 until order) s[i] = b.signed(16)
                residual(b, n, order, s)
                for (i in order until n) s[i] += when (order) {
                    0 -> 0
                    1 -> s[i - 1]
                    2 -> 2 * s[i - 1] - s[i - 2]
                    3 -> 3 * s[i - 1] - 3 * s[i - 2] + s[i - 3]
                    else -> 4 * s[i - 1] - 6 * s[i - 2] + 4 * s[i - 3] - s[i - 4]
                }
            }
            type >= 32 -> {
                val order = type - 31
                for (i in 0 until order) s[i] = b.signed(16)
                val precision = b.read(4).toInt() + 1
                val shift = b.signed(5).toInt()
                val coefs = LongArray(order) { b.signed(precision) }
                residual(b, n, order, s)
                for (i in order until n) {
                    var sum = 0L
                    for (j in 0 until order) sum += coefs[j] * s[i - j - 1]
                    s[i] += sum shr shift
                }
            }
            else -> error("reserved subframe type $type")
        }
        return s
    }

    private fun residual(b: Bits, n: Int, order: Int, s: LongArray) {
        val method = b.read(2).toInt()
        val paramBits = if (method == 0) 4 else 5
        val escape = if (method == 0) 15 else 31
        val partitionOrder = b.read(4).toInt()
        val partitions = 1 shl partitionOrder
        var i = order
        for (p in 0 until partitions) {
            val count = (n shr partitionOrder) - if (p == 0) order else 0
            val k = b.read(paramBits).toInt()
            if (k == escape) {
                val bits = b.read(5).toInt()
                repeat(count) { s[i++] = b.signed(bits) }
            } else {
                repeat(count) {
                    val u = (b.unary() shl k) or b.read(k)
                    s[i++] = if (u and 1L == 0L) u ushr 1 else -(u ushr 1) - 1
                }
            }
        }
    }
}

class FlacEncoderTest {
    private fun roundTrip(samples: ShortArray): FlacTestDecoder.Decoded {
        val bytes = FlacEncoder.encode(samples)
        val decoded = FlacTestDecoder.decode(bytes)
        assertContentEquals(samples, decoded.samples)
        assertEquals(samples.size.toLong(), decoded.totalSamples)
        assertEquals(16_000, decoded.sampleRate)
        assertTrue(decoded.md5Matches, "STREAMINFO MD5 must match the samples")
        if (decoded.frameSizes.isNotEmpty()) {
            assertEquals(decoded.frameSizes.min(), decoded.minFrame)
            assertEquals(decoded.frameSizes.max(), decoded.maxFrame)
        }
        return decoded
    }

    @Test fun speechLikeAudioRoundTripsAndCompresses() {
        val samples = tone(3.3)
        roundTrip(samples)
        val ratio = FlacEncoder.encode(samples).size.toDouble() / (samples.size * 2)
        assertTrue(ratio < 0.6, "ratio $ratio")
    }

    @Test fun silenceIsNearlyFree() {
        val samples = ShortArray(48_000)
        roundTrip(samples)
        assertTrue(FlacEncoder.encode(samples).size < 400)
    }

    @Test fun whiteNoiseFallsBackToVerbatimLosslessly() {
        val random = Random(42)
        val samples = ShortArray(10_000) { (random.nextInt(65_536) - 32_768).toShort() }
        roundTrip(samples)
        // Verbatim fallback: never meaningfully larger than PCM.
        assertTrue(FlacEncoder.encode(samples).size < samples.size * 2 + 2_000)
    }

    @Test fun extremesAndEdgesRoundTrip() {
        roundTrip(ShortArray(4096) { if (it % 2 == 0) Short.MAX_VALUE else Short.MIN_VALUE })
        roundTrip(ShortArray(1) { 1234 })
        roundTrip(ShortArray(15) { (it * 1000).toShort() })
        roundTrip(ShortArray(257) { (it * 37).toShort() })
        roundTrip(ShortArray(4096 * 3 + 1) { (it % 300 * 50).toShort() })
        roundTrip(ShortArray(0))
    }

    @Test fun longFrameNumbersUseMultiByteUtf8() {
        // 200 blocks: frame numbers ≥ 128 need two-byte UTF-8 coding.
        roundTrip(tone(4096 * 200 / 16_000.0, amplitude = 3_000.0))
    }

    /** When the reference `flac` tool is installed, it must accept the stream too. */
    @Test fun referenceDecoderAcceptsTheStream() {
        val flac = listOf("/usr/bin/flac", "/home/linuxbrew/.linuxbrew/bin/flac", "/opt/homebrew/bin/flac").map(::File).firstOrNull { it.canExecute() }
            ?: return
        val file = File(tempDir("flac"), "test.flac")
        file.writeBytes(FlacEncoder.encode(tone(2.0)))
        val process = ProcessBuilder(flac.path, "-t", "-s", file.path).redirectErrorStream(true).start()
        val output = process.inputStream.bufferedReader().readText()
        assertEquals(0, process.waitFor(), output)
    }
}

class WavFileTest {
    @Test fun writesAndReadsBack() {
        val file = File(tempDir("wav"), "a.wav")
        val samples = tone(1.5)
        WavWriter(file).use { w ->
            w.append(samples, 0, 10_000)
            w.append(samples, 10_000, samples.size - 10_000)
        }
        assertContentEquals(samples, WavReader.readAll(file))
        assertEquals(samples.size.toLong(), WavReader.frames(file))
        assertEquals(44 + samples.size * 2L, file.length())
    }

    /** A killed app never patches the header: the reader trusts the file length. */
    @Test fun crashedRecordingIsRecoveredFromItsLength() {
        val file = File(tempDir("wav"), "crash.wav")
        val samples = tone(0.5)
        val writer = WavWriter(file, headerPatchIntervalFrames = Long.MAX_VALUE)
        writer.append(samples)
        // No close(): simulate the process dying. The header still says 0 bytes.
        RandomAccessFile(file, "r").use { raf -> raf.seek(40); assertEquals(0, raf.read() or raf.read() or raf.read() or raf.read()) }
        assertEquals(samples.size.toLong(), WavReader.frames(file))
        assertContentEquals(samples, WavReader.readAll(file))
    }

    @Test fun rangesArePaddedPastTheEnd() {
        val file = File(tempDir("wav"), "r.wav")
        WavWriter.write(file, ShortArray(100) { 7 })
        val range = WavReader.readRange(file, 90, 120)
        assertEquals(30, range.size)
        assertTrue(range.take(10).all { it == 7.toShort() } && range.drop(10).all { it == 0.toShort() })
        assertNull(WavReader.frames(File(file.parentFile, "missing.wav")))
    }

    @Test fun pcmByteConversionsAreLittleEndian() {
        val bytes = Pcm.toBytes(shortArrayOf(1, -2, 0x1234))
        assertContentEquals(byteArrayOf(1, 0, -2, -1, 0x34, 0x12), bytes)
        assertContentEquals(shortArrayOf(1, -2, 0x1234), Pcm.toShorts(bytes))
    }
}

/** Ports of AudioLevelCurveTests.swift and NoiseFloorEstimatorTests.swift. */
class AudioLevelTest {
    @Test fun shippingThresholdsInDecibels() {
        assertTrue(abs(AudioLevelCurve.dBFS(0.06f) - (-58.4)) <= 0.1)
        assertTrue(abs(AudioLevelCurve.dBFS(0.08f) - (-54.6)) <= 0.1)
    }

    @Test fun curveSaturatesAtMinus21dB() {
        assertTrue(abs(AudioLevelCurve.dBFS(1.0f) - (-20.8)) <= 0.1)
        assertTrue(abs(AudioLevelCurve.saturationDBFS - (-20.8)) <= 0.1)
        assertTrue(abs(AudioLevelCurve.dBFS(1.0f) - AudioLevelCurve.dBFS(2.0f)) <= 0.0001)
    }

    @Test fun levelAndRMSRoundTrip() {
        for (level in listOf(0.01f, 0.06f, 0.08f, 0.25f, 0.5f, 0.99f)) {
            assertTrue(abs(AudioLevelCurve.level(AudioLevelCurve.rms(level)) - level) <= 0.0005, "round trip at $level")
        }
    }

    @Test fun silenceIsFiniteAndFloored() {
        assertEquals(0f, AudioLevelCurve.level(0f))
        assertEquals(AudioLevelCurve.FLOOR_DBFS, AudioLevelCurve.dBFS(0f))
    }

    @Test fun levelIsMonotonicInRMS() {
        var previous = -1f
        for (step in 0..100) {
            val level = AudioLevelCurve.level(step / 400f)
            assertTrue(level >= previous)
            previous = level
        }
    }

    @Test fun floorIsNilUntilEnoughSamples() {
        val estimator = NoiseFloorEstimator()
        repeat(NoiseFloorEstimator.MINIMUM_SAMPLES - 1) {
            estimator.ingest(0.2f)
            assertNull(estimator.floorDB)
        }
        estimator.ingest(0.2f)
        assertNotNull(estimator.floorDB)
    }

    @Test fun floorConvergesWhenSpeechStartsAtSampleZero() {
        val estimator = NoiseFloorEstimator()
        val quietRoom = 0.02f
        for (index in 0 until 40) estimator.ingest(if (index % 4 == 3) quietRoom else 0.7f)
        val floor = assertNotNull(estimator.floorDB)
        assertTrue(abs(floor - AudioLevelCurve.dBFS(quietRoom)) <= 0.5)
        assertTrue(assertNotNull(estimator.measuredSNR) > 30)
    }

    @Test fun loudRoomProducesLowSeparation() {
        val estimator = NoiseFloorEstimator()
        repeat(20) { estimator.ingest(0.4f) }
        estimator.ingest(0.5f)
        assertTrue(assertNotNull(estimator.measuredSNR) < 8)
    }

    @Test fun singleOutlierDoesNotSetTheFloor() {
        val estimator = NoiseFloorEstimator()
        estimator.ingest(0f)
        repeat(30) { estimator.ingest(0.3f) }
        assertTrue(abs(assertNotNull(estimator.floorDB) - AudioLevelCurve.dBFS(0.3f)) <= 0.5)
    }

    @Test fun peakTracksTheLoudestSample() {
        val estimator = NoiseFloorEstimator()
        for (level in listOf(0.1f, 0.9f, 0.3f)) estimator.ingest(level)
        assertTrue(abs(estimator.peakDB - AudioLevelCurve.dBFS(0.9f)) <= 0.001)
    }

    @Test fun windowIsBounded() {
        val estimator = NoiseFloorEstimator(capacity = 16)
        repeat(16) { estimator.ingest(0.01f) }
        repeat(16) { estimator.ingest(0.4f) }
        assertTrue(abs(assertNotNull(estimator.floorDB) - AudioLevelCurve.dBFS(0.4f)) <= 0.5)
    }

    @Test fun meterEmitsOnePerWindowAndTracksPeak() {
        val meter = LevelMeter()
        val levels = ArrayList<Float>()
        val samples = tone(1.0)
        meter.feed(samples, 0, 700) { levels += it }
        meter.feed(samples, 700, samples.size - 700) { levels += it }
        assertEquals(16_000 / 512, levels.size)
        assertEquals(levels.max(), meter.peakLevel)
        assertTrue(meter.measured)
    }
}
