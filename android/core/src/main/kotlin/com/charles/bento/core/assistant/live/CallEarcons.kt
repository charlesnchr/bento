package com.charles.bento.core.assistant.live

import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * Short tones the call plays itself, never through Gemini: a Hermes task started, and a result
 * arrived. Gemini answers a task's start silently (scheduling SILENT), so without them the user
 * hears nothing between asking and the answer.
 */
enum class Earcon {
    /** One soft blip: Hermes has the request. */
    TaskStarted,
    /** Two notes, rising: Hermes finished a task, and Gemini is about to say how. */
    ResultArrived,
}

object CallEarcons {
    /** Gemini's output rate, which the call's playback runs at. */
    const val RATE = 24_000
    /** The loudest a tone gets, as a fraction of full scale: well under Gemini's voice. */
    const val PEAK = 0.15

    private val cache = HashMap<Earcon, ByteArray>()

    /** [earcon] as 24 kHz mono PCM16 little-endian. */
    fun pcm(earcon: Earcon): ByteArray = synchronized(cache) {
        cache.getOrPut(earcon) {
            when (earcon) {
                Earcon.TaskStarted -> render(0.11, listOf(Note(0.0, 0.11, 880.0)))
                Earcon.ResultArrived -> render(0.27, listOf(Note(0.0, 0.12, 660.0), Note(0.13, 0.14, 990.0)))
            }
        }.copyOf()
    }

    private class Note(val at: Double, val length: Double, val hz: Double)

    /** Sines with a little second harmonic (it carries on a phone's loudspeaker), a 5 ms attack and a decay to silence. */
    private fun render(seconds: Double, notes: List<Note>): ByteArray {
        val samples = (seconds * RATE).roundToInt()
        val out = ByteArray(samples * 2)
        for (i in 0 until samples) {
            val t = i.toDouble() / RATE
            var v = 0.0
            for (n in notes) {
                val u = t - n.at
                if (u < 0 || u >= n.length) continue
                val attack = min(1.0, u / 0.005)
                // Falls to nothing at the note's end, so it never clicks.
                val decay = exp(-4.0 * u / n.length) * (1 - u / n.length)
                v += (sin(2 * PI * n.hz * u) + 0.25 * sin(4 * PI * n.hz * u)) / 1.25 * attack * decay
            }
            val s = (v * PEAK * Short.MAX_VALUE).roundToInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
            out[2 * i] = s.toByte()
            out[2 * i + 1] = (s shr 8).toByte()
        }
        return out
    }
}

/**
 * Tones laid over the call's playback, so one plays at once even while Gemini speaks rather
 * than queuing behind its reply. [add] on any thread; the rest on the playback thread.
 *
 * A stopped track (new, flushed, or idle for a while) starts only once its buffer is full, and
 * the start's blip is shorter than that: [lone] pads a tone playing without speech with silence
 * until a buffer's worth has gone, or it would wait for Gemini's next words.
 */
class CueMixer {
    private val pending = ConcurrentLinkedQueue<ByteArray>()
    private var current: ByteArray? = null
    private var at = 0
    /** Bytes written by [lone] since speech, a flush or the last lone stretch ended. */
    private var alone = 0

    fun add(pcm: ByteArray) {
        if (pcm.size >= 2) pending.add(pcm)
    }

    /** A tone is playing or waiting to. */
    val playing: Boolean get() = current != null || pending.isNotEmpty()

    /** Adds the next [length] bytes of tone into [pcm] from [offset] (PCM16 little-endian), clipping at full scale. */
    fun mixInto(pcm: ByteArray, offset: Int, length: Int) {
        var i = offset
        val end = offset + length - 1
        while (i < end) {
            val cue = nextSample() ?: return
            val sample = ((pcm[i + 1].toInt() shl 8) or (pcm[i].toInt() and 0xff)).toShort().toInt()
            val mixed = (sample + cue).coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
            pcm[i] = mixed.toByte()
            pcm[i + 1] = (mixed shr 8).toByte()
            i += 2
        }
    }

    /** The next [length] bytes of tone alone, padded with silence at its end; null when none is playing. */
    fun next(length: Int): ByteArray? {
        if (!playing) return null
        return ByteArray(length - length % 2).also { mixInto(it, 0, it.size) }
    }

    /** With no speech to write: the tone, then silence until [fill] bytes have gone since it started; null after. */
    fun lone(length: Int, fill: Int): ByteArray? {
        val slice = next(length) ?: if (alone in 1 until fill) ByteArray(length - length % 2) else null
        if (slice == null) { alone = 0; return null }
        alone += slice.size
        return slice
    }

    /** [lone] has more to write, so the playback shouldn't wait for speech. */
    fun waiting(fill: Int) = playing || alone in 1 until fill

    /** Speech went to the track, or it was flushed and stopped: a tone from here fills its buffer afresh. */
    fun restart() {
        alone = 0
    }

    fun clear() {
        pending.clear()
        current = null
        at = 0
        alone = 0
    }

    private fun nextSample(): Int? {
        var c = current
        if (c == null || at + 1 >= c.size) {
            c = pending.poll() ?: run { current = null; return null }
            current = c
            at = 0
        }
        val s = ((c[at + 1].toInt() shl 8) or (c[at].toInt() and 0xff)).toShort().toInt()
        at += 2
        if (at + 1 >= c.size) { current = null; at = 0 }
        return s
    }
}
