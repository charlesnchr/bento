package com.charles.bento.core.voice.audio

import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sqrt

/** The audio format everything here speaks: 16 kHz mono signed 16-bit little-endian PCM. */
object AudioFormat {
    const val SAMPLE_RATE = 16_000
    const val BYTES_PER_FRAME = 2
    const val BYTES_PER_SECOND = SAMPLE_RATE * BYTES_PER_FRAME

    fun seconds(frames: Long): Double = frames.toDouble() / SAMPLE_RATE
    fun frames(seconds: Double): Long = (seconds * SAMPLE_RATE).roundToLongCompat()

    private fun Double.roundToLongCompat(): Long = kotlin.math.round(this).toLong()
}

/** PCM16 conversions. Little-endian, as the Live API and WAV files expect. */
object Pcm {
    fun toBytes(samples: ShortArray, offset: Int = 0, length: Int = samples.size - offset): ByteArray {
        val out = ByteArray(length * 2)
        for (i in 0 until length) {
            val s = samples[offset + i].toInt()
            out[2 * i] = (s and 0xFF).toByte()
            out[2 * i + 1] = ((s shr 8) and 0xFF).toByte()
        }
        return out
    }

    fun toShorts(bytes: ByteArray, offset: Int = 0, length: Int = bytes.size - offset): ShortArray {
        val count = length / 2
        val out = ShortArray(count)
        for (i in 0 until count) {
            val lo = bytes[offset + 2 * i].toInt() and 0xFF
            val hi = bytes[offset + 2 * i + 1].toInt()
            out[i] = ((hi shl 8) or lo).toShort()
        }
        return out
    }

    /** RMS of a run of samples in 0…1 linear. */
    fun rms(samples: ShortArray, offset: Int = 0, length: Int = samples.size - offset): Float {
        if (length <= 0) return 0f
        var sum = 0.0
        for (i in offset until offset + length) {
            val v = samples[i] / 32_768.0
            sum += v * v
        }
        return sqrt(sum / length).toFloat()
    }
}

/** The Mac's compressive level curve: quiet speech lands mid-range, loud speech saturates. */
object AudioLevelCurve {
    const val GAIN = 11f
    const val EXPONENT = 0.65f
    /** The bottom of the scale, so digital silence has a finite dB value. */
    const val FLOOR_DBFS = -120.0

    /** RMS (0…1 linear) → level (0…1). */
    fun level(rms: Float): Float {
        if (rms <= 0f) return 0f
        return min(1f, min(rms * GAIN, 1f).pow(EXPONENT))
    }

    /** Level → RMS. Exact inverse below saturation. */
    fun rms(level: Float): Float {
        if (level <= 0f) return 0f
        return min(level, 1f).pow(1 / EXPONENT) / GAIN
    }

    /** Level → dBFS, where the noise-floor estimator works. */
    fun dBFS(level: Float): Double {
        val linear = rms(level)
        if (linear <= 0f) return FLOOR_DBFS
        return max(FLOOR_DBFS, 20 * log10(linear.toDouble()))
    }

    /** Where the curve stops distinguishing louder from loudest (≈ −20.8 dBFS). */
    val saturationDBFS: Double get() = 20 * log10(1 / GAIN.toDouble())
}

/**
 * Turns fed PCM into ~31 Hz levels (one per 512 samples, whatever buffer size the app
 * reads), and tracks the session peak the silence gate relies on. Not thread safe.
 */
class LevelMeter(private val window: Int = 512) {
    private var sumSquares = 0.0
    private var count = 0
    var peakLevel: Float = 0f
        private set
    /** False until at least one window was measured. */
    var measured: Boolean = false
        private set

    /** Feeds samples; calls [onLevel] once per completed window. */
    inline fun feed(samples: ShortArray, offset: Int, length: Int, onLevel: (Float) -> Unit) {
        var i = offset
        val end = offset + length
        while (i < end) {
            val v = samples[i] / 32_768.0
            accumulate(v * v)?.let(onLevel)
            i++
        }
    }

    @PublishedApi internal fun accumulate(square: Double): Float? {
        sumSquares += square
        count++
        if (count < window) return null
        val level = AudioLevelCurve.level(sqrt(sumSquares / count).toFloat())
        sumSquares = 0.0
        count = 0
        peakLevel = max(peakLevel, level)
        measured = true
        return level
    }
}

/**
 * How loud the room is: the 10th percentile of every level heard (~60 s window).
 * Always measured; only the experimental noise handling acts on it.
 */
class NoiseFloorEstimator(capacity: Int = 600) {
    companion object {
        /** Below this many samples the percentile is meaningless. */
        const val MINIMUM_SAMPLES = 8
        const val PERCENTILE = 0.10
    }

    private val capacity = max(MINIMUM_SAMPLES, capacity)
    private val samples = ArrayDeque<Double>()

    var peakDB: Double = AudioLevelCurve.FLOOR_DBFS
        private set
    var sampleCount: Int = 0
        private set

    fun ingest(level: Float) {
        val db = AudioLevelCurve.dBFS(level)
        peakDB = max(peakDB, db)
        sampleCount++
        if (samples.size == capacity) samples.removeFirst()
        samples.addLast(db)
    }

    /** The room, in dBFS: the 10th percentile of everything heard so far. */
    val floorDB: Double?
        get() {
            if (samples.size < MINIMUM_SAMPLES) return null
            val sorted = samples.sorted()
            val index = ((sorted.size - 1) * PERCENTILE).roundToInt()
            return sorted[index]
        }

    /** Peak minus floor: a lower bound on the true SNR (the level curve saturates). */
    val measuredSNR: Double? get() = floorDB?.let { peakDB - it }
}
