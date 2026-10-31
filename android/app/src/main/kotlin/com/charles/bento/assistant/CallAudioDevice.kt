package com.charles.bento.assistant

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AudioEffect
import android.media.audiofx.NoiseSuppressor
import android.os.Process
import android.os.SystemClock
import android.util.Log
import com.charles.bento.core.assistant.live.CallAudio
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * A voice call's audio, set up as a phone call is: communication mode, the voice-call
 * microphone with the platform's echo canceller (Gemini mustn't hear itself through the
 * speaker and interrupt itself), and playback routed to a headset when one is connected,
 * else the loudspeaker, and again whenever one comes or goes. Microphone 16 kHz in, Gemini's
 * 24 kHz out, both mono PCM16. It holds audio focus as a call does; losing it (a phone call
 * rings) calls [onFocusLost].
 *
 * Neither side's failure takes the other down: a microphone that fails to read, or that the
 * call restarts ([restartMicrophone]), is reopened while playback goes on, and a speaker whose
 * track dies (the audio server restarted, say) gets a new one while the microphone goes on.
 */
class CallAudioDevice(context: Context, private val onFocusLost: () -> Unit = {}) : CallAudio {
    private val audio = context.getSystemService(AudioManager::class.java)
    private val executor = context.mainExecutor
    /** Where the call's audio goes now, once started: the loudspeaker or not. */
    @Volatile private var onSpeaker = false
    @Volatile private var routed = false
    /** Routing (the device callbacks, on the main thread) and putting it back at the end (the call's thread) take turns. */
    private val routing = Any()
    private val communicationDevice = AudioManager.OnCommunicationDeviceChangedListener { device ->
        onSpeaker = device?.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
    }
    /** A headset connected or gone during the call: it moves there, or back to the loudspeaker. */
    private val devices = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>?) = route()
        override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>?) = route()
    }

    /** Before the call starts, where [route] would send it. */
    override val loudspeaker: Boolean
        get() = if (routed) onSpeaker else pick()?.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
    /** Gemini's audio, each chunk with the [flush] count it was queued under. */
    private val queue = LinkedBlockingQueue<Pair<Int, ByteArray>>()
    @Volatile private var flushes = 0
    private val queued = AtomicLong()
    @Volatile private var running = false
    /** Between a successful start and stop. */
    private var started = false
    @Volatile private var flushRequested = false
    /** The microphone is to be reopened: it read an error, or the call heard nothing from it. */
    @Volatile private var reopenRequested = false
    /** The microphone's recorder, owned by the capture thread; others only stop it, to end a read stuck on a stalled input. */
    @Volatile private var record: AudioRecord? = null
    /** A recorder being stopped on a thread of its own ([stopRecorder]), so a stuck stop isn't joined by more. */
    private val stopping = AtomicReference<AudioRecord?>()
    /** The current recorder's session: the speaker's track follows it, so the echo canceller stays paired with Gemini's voice. */
    @Volatile private var micSession = 0
    private var previousMode = AudioManager.MODE_NORMAL
    private val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
        .setOnAudioFocusChangeListener { change ->
            // A ducking request (a notification sound) is fine; a call or another app taking over isn't.
            if (running && (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)) onFocusLost()
        }
        .build()

    override fun start(onPcm: (ByteArray) -> Unit): Boolean {
        if (started) return true
        if (audio.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) return false
        previousMode = audio.mode
        audio.mode = AudioManager.MODE_IN_COMMUNICATION
        audio.addOnCommunicationDeviceChangedListener(executor, communicationDevice)
        routed = true
        route()
        audio.registerAudioDeviceCallback(devices, null)
        val input = openInput() ?: run { restore(); return false }
        val t = openTrack(input.record.audioSessionId) ?: run { input.release(); restore(); return false }
        t.play()
        record = input.record
        micSession = input.record.audioSessionId
        running = true
        started = true
        Thread({ captureLoop(input, onPcm) }, "bento-call-mic").start()
        Thread({ playbackLoop(t) }, "bento-call-speaker").start()
        return true
    }

    /** A recorder and the effects on its session. */
    private class Input(val record: AudioRecord, val effects: List<AudioEffect>) {
        fun release() {
            effects.forEach { runCatching { it.release() } }
            runCatching { record.stop() }
            record.release()
        }
    }

    /** The voice-call microphone with the platform's echo canceller and noise suppressor, recording; null if it won't open. */
    @SuppressLint("MissingPermission") // the screen asks for the microphone before a call starts
    private fun openInput(): Input? {
        val minIn = AudioRecord.getMinBufferSize(IN_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val r = runCatching {
            AudioRecord.Builder()
                .setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
                .setAudioFormat(AudioFormat.Builder().setSampleRate(IN_RATE).setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                .setBufferSizeInBytes(maxOf(minIn, IN_RATE * 2))
                .build()
        }.getOrNull()
        if (r == null || r.state != AudioRecord.STATE_INITIALIZED) { r?.release(); return null }
        val effects = ArrayList<AudioEffect>()
        if (AcousticEchoCanceler.isAvailable()) runCatching { AcousticEchoCanceler.create(r.audioSessionId)?.also { it.enabled = true; effects.add(it) } }
        if (NoiseSuppressor.isAvailable()) runCatching { NoiseSuppressor.create(r.audioSessionId)?.also { it.enabled = true; effects.add(it) } }
        val input = Input(r, effects)
        runCatching { r.startRecording() }.onFailure { input.release(); return null }
        if (r.recordingState != AudioRecord.RECORDSTATE_RECORDING) { input.release(); return null }
        return input
    }

    /** Gemini's voice, on the microphone's session so the echo canceller pairs them; null if it won't open. */
    private fun openTrack(session: Int): AudioTrack? {
        val minOut = AudioTrack.getMinBufferSize(OUT_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val t = runCatching {
            AudioTrack.Builder()
                .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setAudioFormat(AudioFormat.Builder().setSampleRate(OUT_RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                .setTransferMode(AudioTrack.MODE_STREAM)
                .setBufferSizeInBytes(maxOf(minOut, OUT_RATE / 5 * 2)) // ~200 ms: short, so an interruption is heard at once
                .setSessionId(session)
                .build()
        }.getOrNull()
        if (t == null || t.state != AudioTrack.STATE_INITIALIZED) { t?.release(); return null }
        return t
    }

    /** A headset (Bluetooth, wired, USB) when there is one, else the loudspeaker: never the earpiece. */
    private fun route() = synchronized(routing) {
        if (!routed) return
        val device = pick()
        if (device != null && audio.communicationDevice?.id != device.id) runCatching { audio.setCommunicationDevice(device) }
        onSpeaker = audio.communicationDevice?.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
    }

    private fun pick(): AudioDeviceInfo? {
        val devices = audio.availableCommunicationDevices
        val preferred = listOf(
            AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
        )
        return preferred.firstNotNullOfOrNull { type -> devices.firstOrNull { it.type == type } }
    }

    private fun captureLoop(first: Input, onPcm: (ByteArray) -> Unit) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        val frame = ByteArray(FRAME_BYTES)
        var input: Input? = first
        var reopenedAt = 0L
        var failures = 0
        try {
            while (running) {
                if (input == null || reopenRequested) {
                    // A fresh recorder, its own session and effects; the speaker's track moves to its session once it's quiet.
                    reopenRequested = false
                    record = null
                    input?.release()
                    input = null
                    // One that fails as soon as it opens, or won't open, is tried less and less often (up to every 8 s).
                    val wait = REOPEN_MILLIS shl minOf(failures, 3)
                    SystemClock.sleep(maxOf(0L, reopenedAt + wait - SystemClock.elapsedRealtime()))
                    if (!running) break
                    reopenedAt = SystemClock.elapsedRealtime()
                    input = openInput()
                    record = input?.record
                    if (input != null) {
                        micSession = input.record.audioSessionId
                        Log.i(TAG, "reopened the microphone")
                    } else if (failures == 0) Log.w(TAG, "the microphone won't reopen; trying again now and then")
                    failures = if (input != null) 0 else failures + 1
                    continue
                }
                var filled = 0
                while (filled < frame.size && running && !reopenRequested) {
                    val n = input.record.read(frame, filled, frame.size - filled)
                    if (n < 0) { Log.w(TAG, "the microphone failed to read ($n)"); reopenRequested = true }
                    // A recorder stopped from outside reads nothing, at once, forever: reopen rather than spin.
                    if (n == 0 && input.record.recordingState != AudioRecord.RECORDSTATE_RECORDING) reopenRequested = true
                    if (n <= 0) break
                    filled += n
                }
                if (filled == frame.size && running && !reopenRequested) onPcm(frame.copyOf())
            }
        } finally {
            record = null
            input?.release()
        }
    }

    private fun playbackLoop(first: AudioTrack) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        var t: AudioTrack? = first
        var reopenAt = 0L
        var wroteAt = 0L
        try {
            while (running) {
                if (flushRequested) {
                    flushRequested = false
                    t?.let { runCatching { it.pause(); it.flush(); it.play() } }
                }
                val (queuedUnder, pcm) = queue.poll(50, TimeUnit.MILLISECONDS) ?: Pair(0, null)
                if (pcm == null) {
                    // A reopened microphone has a new session: once what's written has played, the track moves to it.
                    val track = t
                    if (track != null && track.audioSessionId != micSession && SystemClock.elapsedRealtime() - wroteAt >= DRAINED_MILLIS) {
                        runCatching { track.stop() }
                        track.release()
                        t = openTrack(micSession)?.also { it.play() }
                        if (t == null) reopenAt = SystemClock.elapsedRealtime() + REOPEN_MILLIS
                    }
                    continue
                }
                queued.addAndGet(-pcm.size.toLong())
                // Queued before a flush that came since: dropped. Queued after one this loop hasn't done yet
                // (it came between the check above and the poll): the flush goes first, so this still plays.
                if (queuedUnder != flushes) continue
                if (flushRequested) {
                    flushRequested = false
                    t?.let { runCatching { it.pause(); it.flush(); it.play() } }
                }
                if (t == null && SystemClock.elapsedRealtime() >= reopenAt) {
                    t = openTrack(micSession)?.also { it.play() }
                    if (t == null) reopenAt = SystemClock.elapsedRealtime() + REOPEN_MILLIS
                    Log.i(TAG, if (t != null) "reopened the speaker" else "the speaker won't reopen; dropping audio meanwhile")
                }
                val track = t ?: continue
                // In 20 ms slices, so a flush requested mid-reply takes effect at once.
                var at = 0
                while (at < pcm.size && running && queuedUnder == flushes) {
                    val n = track.write(pcm, at, minOf(SLICE_BYTES, pcm.size - at), AudioTrack.WRITE_BLOCKING)
                    if (n < 0) {
                        // A dead track plays nothing ever again: the next audio gets a new one, and the rest of this goes.
                        Log.w(TAG, "the speaker failed to play ($n); reopening it")
                        runCatching { track.release() }
                        t = null
                    }
                    if (n <= 0) break
                    at += n
                    wroteAt = SystemClock.elapsedRealtime()
                }
            }
        } finally {
            t?.let { runCatching { it.stop() }; it.release() }
        }
    }

    override fun play(pcm: ByteArray) {
        if (!running) return
        // Two minutes of speech at most; past that the oldest is dropped rather than the call growing without bound.
        while (queued.get() + pcm.size > MAX_QUEUED_BYTES) queue.poll()?.let { queued.addAndGet(-it.second.size.toLong()) } ?: break
        queue.offer(flushes to pcm)
        queued.addAndGet(pcm.size.toLong())
    }

    override fun flush() {
        flushes++ // only the call's thread queues and flushes
        queue.clear()
        queued.set(0)
        flushRequested = true
    }

    override fun restartMicrophone() {
        if (!running) return
        // The recorder to stop is the one before the reopen: read first, so a quick reopen's new one isn't stopped.
        val r = record
        reopenRequested = true
        stopRecorder(r)
    }

    /**
     * Stops the current recorder so a read waiting on a stalled input returns, on a thread of its
     * own: stopping waits for the audio server's record thread, which may be as stuck as the read.
     */
    private fun stopRecorder(r: AudioRecord?) {
        r ?: return
        // One stop per recorder at a time: a second can't unblock the first, and a stuck one would pile up threads.
        while (true) {
            val current = stopping.get()
            if (current === r) return
            if (stopping.compareAndSet(current, r)) break
        }
        Thread({
            try { runCatching { r.stop() } } finally { stopping.compareAndSet(r, null) }
        }, "bento-call-mic-stop").start()
    }

    override fun stop() {
        if (!started) return // a start that failed has already put everything back
        started = false
        running = false
        stopRecorder(record)
        queue.clear()
        queued.set(0)
        restore()
    }

    private fun restore() {
        synchronized(routing) {
            if (routed) {
                routed = false
                runCatching { audio.unregisterAudioDeviceCallback(devices) }
                runCatching { audio.removeOnCommunicationDeviceChangedListener(communicationDevice) }
            }
            runCatching { audio.clearCommunicationDevice() }
        }
        runCatching { audio.abandonAudioFocusRequest(focus) }
        audio.mode = previousMode
    }

    companion object {
        private const val TAG = "BentoCallAudio"
        const val IN_RATE = 16_000
        const val OUT_RATE = 24_000
        private const val FRAME_BYTES = IN_RATE / 50 * 2 // 20 ms
        private const val SLICE_BYTES = OUT_RATE / 50 * 2
        private const val MAX_QUEUED_BYTES = OUT_RATE * 2L * 120
        /** How long a microphone or speaker that won't reopen waits before trying again. */
        private const val REOPEN_MILLIS = 1_000L
        /** Silence after the last write by which the track's ~200 ms buffer has played out. */
        private const val DRAINED_MILLIS = 400L
    }
}
