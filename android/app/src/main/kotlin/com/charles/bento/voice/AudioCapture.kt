package com.charles.bento.voice

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.Process
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.sqrt

/**
 * 16 kHz mono PCM16 from the microphone, in 20 ms frames, on its own high-priority
 * thread. `onFrame` and `onLevel` are called on that thread; keep them cheap.
 */
class AudioCapture(
    private val onFrame: (ShortArray) -> Unit,
    /** 0…1, perceptual (dB mapped onto a curve), ~50 times a second. */
    private val onLevel: (Float) -> Unit = {},
    private val noiseSuppression: Boolean = false,
) {
    @Volatile private var running = false
    private var thread: Thread? = null
    private var record: AudioRecord? = null

    /** False when the microphone can't be opened (no permission, in use by a call). */
    @SuppressLint("MissingPermission") // callers check RECORD_AUDIO first
    fun start(): Boolean {
        if (running) return true
        val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minBuf <= 0) return false
        val r = runCatching {
            AudioRecord.Builder()
                .setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
                .setAudioFormat(
                    AudioFormat.Builder().setSampleRate(SAMPLE_RATE).setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build(),
                )
                .setBufferSizeInBytes(max(minBuf, SAMPLE_RATE * 2)) // 1 s of slack against hiccups
                .build()
        }.getOrNull() ?: return false
        if (r.state != AudioRecord.STATE_INITIALIZED) { r.release(); return false }
        // VOICE_RECOGNITION is unprocessed on most phones; the models prefer it raw, but a
        // meeting across a room benefits from gain control.
        if (noiseSuppression) {
            if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(r.audioSessionId)?.enabled = true
            if (AutomaticGainControl.isAvailable()) AutomaticGainControl.create(r.audioSessionId)?.enabled = true
        }
        runCatching { r.startRecording() }.onFailure { r.release(); return false }
        if (r.recordingState != AudioRecord.RECORDSTATE_RECORDING) { r.release(); return false }
        record = r
        running = true
        thread = Thread({ loop(r) }, "bento-audio").apply { start() }
        return true
    }

    fun stop() {
        running = false
        thread?.join(500)
        thread = null
        record?.let { runCatching { it.stop() }; it.release() }
        record = null
    }

    private fun loop(r: AudioRecord) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        val frame = ShortArray(FRAME_SAMPLES)
        while (running) {
            var filled = 0
            while (filled < frame.size && running) {
                val n = r.read(frame, filled, frame.size - filled)
                if (n < 0) { running = false; break }
                filled += n
            }
            if (filled == frame.size) {
                onFrame(frame.copyOf())
                onLevel(level(frame))
            }
        }
    }

    companion object {
        const val SAMPLE_RATE = 16_000
        const val FRAME_SAMPLES = 320 // 20 ms

        /** RMS in dBFS mapped onto 0…1 between -55 dB (silence) and -10 dB (loud speech). */
        fun level(frame: ShortArray): Float {
            var sum = 0.0
            for (s in frame) sum += s.toDouble() * s
            val rms = sqrt(sum / frame.size) / 32768.0
            val db = if (rms <= 1e-9) -120.0 else 20 * log10(rms)
            return ((db + 55) / 45).coerceIn(0.0, 1.0).toFloat()
        }
    }
}
