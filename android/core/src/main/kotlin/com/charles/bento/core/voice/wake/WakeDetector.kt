package com.charles.bento.core.voice.wake

import kotlin.math.log10
import kotlin.math.max
import kotlin.math.sqrt

/**
 * A streaming wake word model: one 80 ms step of 16 kHz audio in, a score out. Its state
 * carries over between steps, and [reset] returns it to the state it starts from (warmed up
 * on silence, as in training).
 */
interface WakeModel : AutoCloseable {
    /** Scores the next [FRAME] samples (floats in [-1, 1]). */
    fun step(frame: FloatArray): Float
    fun reset()
    override fun close() {}

    companion object {
        /** 80 ms at 16 kHz. */
        const val FRAME = 1280
        const val RATE = 16_000
    }
}

/**
 * Listens for the wake word in a microphone stream, running [model] only while there is
 * something to hear. A quiet room costs no inference at all, which is most of a day.
 *
 * The gate opens on a frame at least [Limits.marginDb] above the room's noise floor (the
 * quietest frame of the last few seconds) and above [Limits.openDbfs]; it stays open for
 * [Limits.hangFrames] after the last such frame. On opening, the model starts from its warm
 * state and first hears the [Limits.preRollFrames] before, so a word's start isn't lost.
 *
 * A score over [Limits.threshold] is a detection, as on the Echo's Wyoming server: then
 * nothing for [Limits.refractoryFrames], and the model starts afresh. Not thread-safe: one
 * audio thread feeds it.
 */
class WakeDetector(
    private val model: WakeModel,
    private val limits: Limits = Limits(),
    /** The score that counts as the word, read at every frame (the Sensitivity setting can change it). */
    private val threshold: () -> Float = { limits.threshold },
) {
    data class Limits(
        /** The Pennyworth model's recommended operating point: no false wakes on 13.7 h of held-out real speech. */
        val threshold: Float = 0.6f,
        val refractoryFrames: Int = 25,
        val marginDb: Double = 6.0,
        val openDbfs: Double = -62.0,
        /** Frames whose quietest sets the noise floor: 3.2 s. */
        val floorFrames: Int = 40,
        /**
         * 2 s, the model's own warm-up: on 77 minutes of Echo audio it kept 14 of the 15 detections
         * the continuous stream made (the other scored 0.71, where reset timing alone tips it); 1.2 s kept 13.
         */
        val preRollFrames: Int = 25,
        val hangFrames: Int = 25,
    )

    /**
     * A detection: its score, the frame it ended on (counting every frame fed), and where in the
     * samples [feed] was given the audio after it starts. The detector hasn't heard those.
     */
    data class Detection(val score: Float, val atFrame: Long, val rest: Int = 0)

    private val pending = FloatArray(WakeModel.FRAME)
    private var filled = 0
    private val levels = DoubleArray(limits.floorFrames) { 0.0 }
    private var levelCount = 0
    private val preRoll = ArrayDeque<FloatArray>()
    private var open = false
    private var hang = 0
    private var quietUntil = -1L

    /** Frames heard, and frames the model scored (the gate's saving is the difference). */
    var frames = 0L
        private set
    var scored = 0L
        private set
    /** The highest score since [takePeak]. */
    private var peak = 0f

    /** Feeds PCM16 samples (any count); returns a detection when one completes in them, leaving the samples after it unheard. */
    fun feed(pcm: ShortArray, count: Int = pcm.size): Detection? {
        var i = 0
        while (i < count) {
            val n = minOf(count - i, WakeModel.FRAME - filled)
            for (k in 0 until n) pending[filled + k] = pcm[i + k] / 32768f
            filled += n
            i += n
            if (filled == WakeModel.FRAME) {
                filled = 0
                frame(pending.copyOf())?.let { return it.copy(rest = i) }
            }
        }
        return null
    }

    /** The highest score since the last call, then forgets it. */
    fun takePeak(): Float = peak.also { peak = 0f }

    /** Forgets everything heard: the next sound opens the gate afresh. */
    fun reset() {
        filled = 0
        levelCount = 0
        preRoll.clear()
        open = false
        hang = 0
    }

    private fun frame(frame: FloatArray): Detection? {
        val at = frames++
        val level = dbfs(frame)
        levels[(levelCount++ % levels.size)] = level
        var floor = level
        for (k in 0 until minOf(levelCount, levels.size)) floor = minOf(floor, levels[k])
        val loud = level >= limits.openDbfs && level >= floor + limits.marginDb
        if (loud) hang = limits.hangFrames
        if (!open) {
            if (!loud) {
                preRoll.addLast(frame)
                if (preRoll.size > limits.preRollFrames) preRoll.removeFirst()
                return null
            }
            open = true
            model.reset()
            var found: Detection? = null
            for (f in preRoll) score(f, at)?.let { found = it }
            preRoll.clear()
            return score(frame, at) ?: found
        }
        val found = score(frame, at)
        if (!loud && --hang <= 0) open = false
        return found
    }

    private fun score(frame: FloatArray, at: Long): Detection? {
        scored++
        val s = model.step(frame)
        peak = max(peak, s)
        if (s <= threshold() || at < quietUntil) return null
        quietUntil = at + limits.refractoryFrames
        model.reset()
        return Detection(s, at)
    }

    companion object {
        /** RMS level in dBFS (-120 for digital silence). */
        fun dbfs(frame: FloatArray): Double {
            var sum = 0.0
            for (x in frame) sum += x.toDouble() * x
            val rms = sqrt(sum / frame.size)
            return if (rms <= 1e-6) -120.0 else 20 * log10(rms)
        }
    }
}
