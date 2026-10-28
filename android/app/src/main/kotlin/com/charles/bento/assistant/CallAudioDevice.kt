package com.charles.bento.assistant

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Process
import com.charles.bento.core.assistant.live.CallAudio
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * A voice call's audio, set up as a phone call is: communication mode, the voice-call
 * microphone with the platform's echo canceller (Gemini mustn't hear itself through the
 * speaker and interrupt itself), and playback routed to a headset when one is connected,
 * else the loudspeaker. Microphone 16 kHz in, Gemini's 24 kHz out, both mono PCM16.
 */
class CallAudioDevice(context: Context) : CallAudio {
    private val audio = context.getSystemService(AudioManager::class.java)
    private val queue = LinkedBlockingQueue<ByteArray>()
    private val queued = AtomicLong()
    @Volatile private var running = false
    @Volatile private var flushRequested = false
    private var record: AudioRecord? = null
    private var track: AudioTrack? = null
    private var previousMode = AudioManager.MODE_NORMAL

    @SuppressLint("MissingPermission") // the screen asks for the microphone before a call starts
    override fun start(onPcm: (ByteArray) -> Unit): Boolean {
        if (running) return true
        previousMode = audio.mode
        audio.mode = AudioManager.MODE_IN_COMMUNICATION
        route()
        val minIn = AudioRecord.getMinBufferSize(IN_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val r = runCatching {
            AudioRecord.Builder()
                .setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
                .setAudioFormat(AudioFormat.Builder().setSampleRate(IN_RATE).setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                .setBufferSizeInBytes(maxOf(minIn, IN_RATE * 2))
                .build()
        }.getOrNull()
        if (r == null || r.state != AudioRecord.STATE_INITIALIZED) { r?.release(); restore(); return false }
        if (AcousticEchoCanceler.isAvailable()) runCatching { AcousticEchoCanceler.create(r.audioSessionId)?.enabled = true }
        if (NoiseSuppressor.isAvailable()) runCatching { NoiseSuppressor.create(r.audioSessionId)?.enabled = true }
        val minOut = AudioTrack.getMinBufferSize(OUT_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val t = runCatching {
            AudioTrack.Builder()
                .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setAudioFormat(AudioFormat.Builder().setSampleRate(OUT_RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                .setTransferMode(AudioTrack.MODE_STREAM)
                .setBufferSizeInBytes(maxOf(minOut, OUT_RATE / 5 * 2)) // ~200 ms: short, so an interruption is heard at once
                .setSessionId(r.audioSessionId)
                .build()
        }.getOrNull()
        if (t == null || t.state != AudioTrack.STATE_INITIALIZED) { t?.release(); r.release(); restore(); return false }
        runCatching { r.startRecording() }.onFailure { r.release(); t.release(); restore(); return false }
        if (r.recordingState != AudioRecord.RECORDSTATE_RECORDING) { r.release(); t.release(); restore(); return false }
        t.play()
        record = r; track = t
        running = true
        Thread({ captureLoop(r, onPcm) }, "bento-call-mic").start()
        Thread({ playbackLoop(t) }, "bento-call-speaker").start()
        return true
    }

    /** A headset (Bluetooth, wired, USB) when there is one, else the loudspeaker: never the earpiece. */
    private fun route() {
        val devices = audio.availableCommunicationDevices
        val preferred = listOf(
            AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
        )
        val device = preferred.firstNotNullOfOrNull { type -> devices.firstOrNull { it.type == type } } ?: return
        runCatching { audio.setCommunicationDevice(device) }
    }

    private fun captureLoop(r: AudioRecord, onPcm: (ByteArray) -> Unit) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        val frame = ByteArray(FRAME_BYTES)
        try {
            while (running) {
                var filled = 0
                while (filled < frame.size && running) {
                    val n = r.read(frame, filled, frame.size - filled)
                    if (n <= 0) { if (n < 0) running = false; break }
                    filled += n
                }
                if (filled == frame.size && running) onPcm(frame.copyOf())
            }
        } finally {
            runCatching { r.stop() }
            r.release()
        }
    }

    private fun playbackLoop(t: AudioTrack) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        try {
            while (running) {
                if (flushRequested) {
                    flushRequested = false
                    runCatching { t.pause(); t.flush(); t.play() }
                }
                val pcm = queue.poll(50, TimeUnit.MILLISECONDS) ?: continue
                queued.addAndGet(-pcm.size.toLong())
                // In 20 ms slices, so a flush requested mid-reply takes effect at once.
                var at = 0
                while (at < pcm.size && running && !flushRequested) {
                    val n = t.write(pcm, at, minOf(SLICE_BYTES, pcm.size - at), AudioTrack.WRITE_BLOCKING)
                    if (n <= 0) break
                    at += n
                }
            }
        } finally {
            runCatching { t.stop() }
            t.release()
        }
    }

    override fun play(pcm: ByteArray) {
        if (!running) return
        // Two minutes of speech at most; past that the oldest is dropped rather than the call growing without bound.
        while (queued.get() + pcm.size > MAX_QUEUED_BYTES) queue.poll()?.let { queued.addAndGet(-it.size.toLong()) } ?: break
        queue.offer(pcm)
        queued.addAndGet(pcm.size.toLong())
    }

    override fun flush() {
        queue.clear()
        queued.set(0)
        flushRequested = true
    }

    override fun stop() {
        if (!running) { restore(); return }
        running = false
        queue.clear()
        queued.set(0)
        record = null; track = null
        restore()
    }

    private fun restore() {
        runCatching { audio.clearCommunicationDevice() }
        audio.mode = previousMode
    }

    companion object {
        const val IN_RATE = 16_000
        const val OUT_RATE = 24_000
        private const val FRAME_BYTES = IN_RATE / 50 * 2 // 20 ms
        private const val SLICE_BYTES = OUT_RATE / 50 * 2
        private const val MAX_QUEUED_BYTES = OUT_RATE * 2L * 120
    }
}
