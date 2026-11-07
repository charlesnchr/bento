package com.charles.bento.voice

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.os.Process
import android.os.SystemClock
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.VibratorManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.charles.bento.MainActivity
import com.charles.bento.R
import com.charles.bento.assistant.AssistantController
import com.charles.bento.core.voice.VoiceLog
import com.charles.bento.core.voice.wake.OnnxWakeModel
import com.charles.bento.core.voice.wake.WakeDetector
import com.charles.bento.core.voice.wake.WakeModel
import com.charles.bento.settings.Prefs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream

/** What the wake word is doing, for Settings, the tile and the notification. */
sealed interface WakeState {
    data object Off : WakeState
    data object Listening : WakeState
    /** On, but not listening for now: [why] says so ("Battery saver is on"). */
    data class Paused(val why: String) : WakeState
    /** On, and its microphone service is starting. */
    data object Starting : WakeState
    /** On, but it can't run: [why] says what's missing. [needsBento]: Android refused to start it in the background. */
    data class Blocked(val why: String, val needsBento: Boolean = false) : WakeState
}

/**
 * "Woodhouse", around the clock: the Echo's wake word model, on the phone. Saying it starts a
 * voice call with Hermes in a new conversation, the words after it included, and the call hangs
 * up once nothing is said for a while.
 *
 * While it's on, Bento keeps its microphone service ([VoiceService.KIND_WAKE]) running, so the
 * microphone can come back after a pause without Bento on screen. Android only lets that service
 * start while Bento is in the foreground (or its accessibility service is on); when it can't, a
 * notification asks to open Bento. The listener lets go of the microphone during a call, a
 * dictation or a meeting, and, with [Prefs.wakePauseOnSaver], while battery saver is on or the
 * battery is low. A quiet room costs no inference at all ([WakeDetector]). Main thread.
 */
class WakeWord(
    private val context: Context,
    private val prefs: Prefs,
    private val scope: CoroutineScope,
    private val assistant: () -> AssistantController,
    /** Dictation or a meeting has the microphone. */
    private val microphoneBusy: () -> Boolean,
) {
    private val _state = MutableStateFlow<WakeState>(WakeState.Off)
    val state: StateFlow<WakeState> = _state.asStateFlow()
    /** In the microphone service. */
    private var held = false
    private var entering: Job? = null
    private var listener: WakeListener? = null
    private var receiver: BroadcastReceiver? = null
    private val earcons by lazy { Earcons(context) }
    private val panelLazy = lazy { WakePanel(context, prefs, scope, assistant) }
    private val panel by panelLazy
    /** Model loads in progress: a listener stopped mid-load may finish after its replacement started. */
    private val loads = java.util.concurrent.atomic.AtomicInteger()
    /** Why it turned itself off (loading the model failed, or brought Bento down last time), until it's turned on again. */
    private var broken: String? = null

    init {
        if (prefs.wakeLoading.value) {
            // the last launch died loading the model (its native library on this phone): don't loop
            VoiceLog.e(TAG, "loading the wake word model crashed Bento last time: turned off")
            prefs.wakeLoading.value = false
            prefs.wakeWord.value = false
            prefs.flush()
            broken = "Turned off: loading the model crashed Bento"
        }
        scope.launch {
            combine(prefs.wakeWord.flow, prefs.wakePauseOnSaver.flow, prefs.wakeThreshold.flow) { _, _, _ -> }.collect { refresh() }
        }
    }

    /** Turns it on or off (Settings, the tile, the notification). On needs Bento in the foreground the first time. */
    fun setEnabled(on: Boolean) {
        broken = null
        prefs.wakeWord.value = on
        refresh()
    }

    /**
     * Brings everything in line with the settings and the phone's state. Called when they change,
     * when Bento comes to the foreground (which may now start the service) and after a call.
     */
    fun refresh() {
        val on = prefs.wakeWord.value
        if (!on) { stopAll(); _state.value = broken?.let { WakeState.Blocked(it) } ?: WakeState.Off; return }
        watchPower()
        val missing = missing()
        if (missing != null) {
            listener?.stop(); listener = null
            leave()
            _state.value = WakeState.Blocked(missing)
            return
        }
        if (!held) { enter(); return }
        cancelResumeNotice()
        val paused = pausedBecause()
        if (paused != null) {
            listener?.stop(); listener = null
            _state.value = WakeState.Paused(paused)
        } else {
            val threshold = prefs.wakeThreshold.value / 100f
            // a new sensitivity applies to the running listener (the slider sends every step)
            listener?.threshold = threshold
            if (listener == null) {
                earcons // loaded now, so the first detection's tone is ready
                lateinit var l: WakeListener
                l = WakeListener(context, threshold, busy = { busy() }, onWake = { score -> scope.launch { woke(score) } },
                                 loading = { now -> synchronized(loads) { prefs.wakeLoading.value = loads.addAndGet(if (now) 1 else -1) > 0; prefs.flush() } },
                                 failed = { scope.launch { if (listener === l) loadFailed() } })
                listener = l.also { it.start() }
            }
            _state.value = WakeState.Listening
        }
        VoiceService.refresh(context, VoiceService.KIND_WAKE)
    }

    /** The model couldn't load or the listener threw: off, saying so, rather than "Listening" with nothing listening. */
    private fun loadFailed() {
        listener = null
        broken = "Turned off: the wake word stopped with an error"
        prefs.wakeWord.value = false
        refresh()
    }

    /** Debug builds: the listener hears this WAV (16 kHz mono) in real time instead of the microphone, once. */
    fun testWith(file: java.io.File?) {
        WakeListener.testSource = file
        listener?.stop(); listener = null
        refresh()
    }

    private fun missing(): String? = when {
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED -> "Needs the microphone permission"
        !assistant().canCall -> "Needs Hermes and a Gemini API key (Settings → Hermes)"
        else -> null
    }

    private fun pausedBecause(): String? {
        if (!prefs.wakePauseOnSaver.value) return null
        val pm = context.getSystemService(PowerManager::class.java)
        if (pm.isPowerSaveMode) return "Paused: battery saver is on"
        if (batteryLow()) return "Paused: the battery is low"
        return null
    }

    private fun batteryLow(): Boolean {
        val sticky = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return false
        val charging = sticky.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0
        return !charging && sticky.getBooleanExtra(BatteryManager.EXTRA_BATTERY_LOW, false)
    }

    /** The call, a dictation or a meeting has the microphone. Any thread. */
    private fun busy(): Boolean = assistant().callActive || microphoneBusy()

    private fun enter() {
        _state.value = WakeState.Starting
        if (entering != null) return
        entering = scope.launch {
            val ok = VoiceService.enter(context, VoiceService.KIND_WAKE)
            entering = null
            held = ok
            // turned off or blocked meanwhile: refresh lets go of the service again
            if (ok) refresh() else if (prefs.wakeWord.value) {
                // Android doesn't let Bento start listening from the background: opening Bento does
                _state.value = WakeState.Blocked("Open Bento to start listening", needsBento = true)
                showResumeNotice()
            }
        }
    }

    /** Out of the microphone service. A start still pending isn't cancelled (the service may be starting): it leaves once it's in. */
    private fun leave() {
        if (held) VoiceService.exit(context, VoiceService.KIND_WAKE)
        held = false
    }

    private fun stopAll() {
        listener?.stop(); listener = null
        leave()
        receiver?.let { runCatching { context.unregisterReceiver(it) } }
        receiver = null
        cancelResumeNotice()
    }

    /** Battery saver and the battery's level change what [pausedBecause] says. */
    private fun watchPower() {
        if (receiver != null) return
        val r = object : BroadcastReceiver() {
            override fun onReceive(c: Context, intent: Intent) {
                VoiceLog.i(TAG, "power: ${intent.action?.substringAfterLast('.')}")
                refresh()
            }
        }
        val filter = IntentFilter().apply {
            addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)
            addAction(Intent.ACTION_BATTERY_LOW)
            addAction(Intent.ACTION_BATTERY_OKAY)
            addAction(Intent.ACTION_POWER_CONNECTED)
            addAction(Intent.ACTION_POWER_DISCONNECTED)
        }
        // protected broadcasts from the system only
        ContextCompat.registerReceiver(context, r, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        receiver = r
    }

    /** Heard it: a call with Hermes, which takes the words said since from the listener as it connects. */
    private fun woke(score: Float) {
        val l = listener ?: return
        if (prefs.sounds.value) earcons.play(Earcons.START)
        // a phone on silent still says it heard: the panel and a buzz
        if (prefs.haptics.value) buzz()
        panel.show()
        val refused = assistant().callFromWake(
            opening = { l.takeOver() },
            ended = { error ->
                // a call that never connected never took the words: listening starts afresh
                l.takeOver()
                scope.launch {
                    if (prefs.sounds.value) earcons.play(if (error == null) Earcons.STOP else Earcons.ERROR)
                    panel.finish(error)
                    refresh()
                }
            },
        )
        VoiceLog.i(TAG, "woke (score %.2f): ".format(score) + (refused?.let { "no call: $it" } ?: "calling Hermes"))
        if (refused != null) {
            if (prefs.sounds.value) earcons.play(Earcons.ERROR)
            panel.finish(refused)
            l.takeOver()
        }
    }

    private fun buzz() {
        val vibrator = context.getSystemService(VibratorManager::class.java)?.defaultVibrator ?: return
        val effect = VibrationEffect.createPredefined(VibrationEffect.EFFECT_HEAVY_CLICK)
        // a communication request's usage: Android lets it through with Bento off screen
        runCatching {
            if (Build.VERSION.SDK_INT >= 33) {
                vibrator.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_COMMUNICATION_REQUEST))
            } else {
                @Suppress("DEPRECATION")
                vibrator.vibrate(effect, AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_COMMUNICATION_REQUEST).build())
            }
        }
    }

    /** Bento's accessibility service started or stopped: the panel may have a window to show in now, or need another. */
    fun accessibilityChanged() {
        if (panelLazy.isInitialized()) panel.accessibilityChanged()
    }

    /** What the microphone service's notification says while only the wake word is in it. */
    fun notificationText(): String = when (val s = _state.value) {
        WakeState.Listening -> "Say “Woodhouse” to talk to Hermes"
        is WakeState.Paused -> s.why
        is WakeState.Blocked -> s.why
        WakeState.Starting -> "Starting…"
        WakeState.Off -> "Off"
    }

    private fun showResumeNotice() {
        VoiceService.ensureChannels(context)
        val open = PendingIntent.getActivity(
            context, 2, MainActivity.internal(context, MainActivity.ACTION_WAKE_ON).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n: Notification = NotificationCompat.Builder(context, VoiceService.CHANNEL_LISTENING)
            .setSmallIcon(R.drawable.ic_stat_mic)
            .setContentTitle("Not listening for “Woodhouse”")
            .setContentText("Tap to start listening again")
            .setContentIntent(open)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .build()
        runCatching { context.getSystemService(NotificationManager::class.java).notify(RESUME_NOTIFICATION, n) }
    }

    private fun cancelResumeNotice() {
        context.getSystemService(NotificationManager::class.java).cancel(RESUME_NOTIFICATION)
    }

    companion object {
        private const val TAG = "WakeWord"
        private const val RESUME_NOTIFICATION = 43

    }
}

/**
 * The microphone thread that listens for the wake word: 16 kHz from the unprocessed voice
 * recognition source, read 160 ms at a time, into a [WakeDetector]. It lets go of the microphone
 * while [busy] and opens it again after. After a detection it keeps recording, for the call to
 * [takeOver], and then waits for the call to finish.
 */
internal class WakeListener(
    private val context: Context,
    threshold: Float,
    private val busy: () -> Boolean,
    /** On the listener's thread. */
    private val onWake: (Float) -> Unit,
    /** True as the model starts loading, false once it has (or failed cleanly). On the listener's thread. */
    private val loading: (Boolean) -> Unit = {},
    /** The model couldn't load, or listening threw: the thread has ended. On the listener's thread. */
    private val failed: () -> Unit = {},
) {
    /** Where the audio comes from: the microphone, or a test file. */
    private interface Mic {
        /** Fills [buf]; the count read, or 0 or less when it has stopped. */
        fun read(buf: ShortArray): Int
        /** Unblocks a read in progress. Any thread. */
        fun stop()
        fun release()
    }

    /** The score that counts as the word; the detector reads it at every frame. Any thread. */
    @Volatile var threshold: Float = threshold
    @Volatile private var running = false
    private var thread: Thread? = null
    private val lock = Object()
    /** After a detection, until the call takes it: everything heard since. */
    private var handing: ByteArrayOutputStream? = null
    private var handingSince = 0L
    /** Taken over: the call has (or had) the microphone; listening resumes once nothing is [busy]. */
    @Volatile private var yielded = false
    private var mic: Mic? = null

    fun start() {
        if (running) return
        running = true
        thread = Thread({ loop() }, "bento-wake").apply { start() }
    }

    /** Returns at once; the thread lets go of the microphone as its read returns. */
    fun stop() {
        running = false
        synchronized(lock) { mic?.stop() }
        thread?.interrupt()
        thread = null
    }

    /** Lets go of the microphone and returns what was said since the wake word (16 kHz PCM16), or null. Any thread. */
    fun takeOver(): ByteArray? = synchronized(lock) {
        val audio = handing?.toByteArray()
        handing = null
        yielded = true
        mic?.stop()
        audio
    }

    private fun loop() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
        loading(true)
        val model = runCatching { loadModel(context) }.also { loading(false) }.getOrElse {
            VoiceLog.e(TAG, "couldn't load the wake word model: ${it.message}")
            running = false
            failed()
            return
        }
        val detector = WakeDetector(model) { threshold }
        val buf = ShortArray(READ_SAMPLES)
        var statsAt = SystemClock.elapsedRealtime()
        try {
            while (running) {
                // Someone else has the microphone: wait for it to be free, checking twice a second.
                if (yielded || (!handingOver() && busy())) {
                    close()
                    if (yielded && !busy()) { yielded = false; detector.reset(); continue }
                    nap(500)
                    continue
                }
                val m = synchronized(lock) { mic } ?: open()
                if (m == null) { nap(2_000); continue }
                val n = m.read(buf)
                if (n <= 0) {
                    close()
                    // a microphone that keeps failing (not one taken over or stopped) isn't retried flat out
                    if (running && !yielded) nap(500)
                    continue
                }
                val hit = heard(detector, buf, n)
                if (hit != null) onWake(hit.score)
                val now = SystemClock.elapsedRealtime()
                if (now - statsAt >= STATS_MS) {
                    VoiceLog.i(TAG, "scored %d of %d frames so far (%.1f ms each); peak score %.2f in the last %d min"
                        .format(detector.scored, detector.frames, inferenceNanos / 1e6 / maxOf(1L, detector.scored),
                                detector.takePeak(), STATS_MS / 60_000))
                    statsAt = now
                }
            }
        } catch (e: Throwable) {
            // the model or the microphone threw: stop listening, never take Bento down
            VoiceLog.e(TAG, "the listener failed: ${e.javaClass.simpleName}: ${e.message}")
            running = false
            failed()
        } finally {
            close()
            model.close()
        }
    }

    /** Time spent in the model, for the log. */
    private var inferenceNanos = 0L

    private fun handingOver() = synchronized(lock) { handing != null }

    /** Audio heard: kept for the call after a detection, else listened to. A detection, if this completed one. */
    private fun heard(detector: WakeDetector, buf: ShortArray, n: Int): WakeDetector.Detection? = synchronized(lock) {
        val h = handing
        if (h != null) {
            h.write(bytes(buf, n))
            if (SystemClock.elapsedRealtime() - handingSince > HAND_OVER_MAX_MS) {
                // the call never came for it
                handing = null
                detector.reset()
            }
            return null
        }
        val t0 = System.nanoTime()
        val scoredBefore = detector.scored
        val found = detector.feed(buf, n)
        if (detector.scored > scoredBefore) inferenceNanos += System.nanoTime() - t0
        val hit = found ?: return null
        VoiceLog.i(TAG, "detected, score %.3f".format(hit.score))
        // what followed the word in this read is the start of the request
        handing = ByteArrayOutputStream().apply { if (hit.rest < n) write(bytes(buf.copyOfRange(hit.rest, n), n - hit.rest)) }
        handingSince = SystemClock.elapsedRealtime()
        hit
    }

    private fun nap(ms: Long) {
        try { Thread.sleep(ms) } catch (_: InterruptedException) {}
    }

    private fun open(): Mic? {
        // a test file plays once; the microphone after
        val test = testSource.also { testSource = null }
        val m = test?.let { f -> runCatching { FileMic(f.readBytes().let { it.copyOfRange(44, it.size) }) }.getOrNull() } ?: openRecord()
        m ?: return null
        synchronized(lock) {
            // taken over meanwhile: the call is opening its own
            if (yielded || !running) { m.stop(); m.release(); return null }
            mic = m
        }
        VoiceLog.i(TAG, if (test != null) "listening to a test file" else "listening")
        return m
    }

    @SuppressLint("MissingPermission") // WakeWord checks RECORD_AUDIO first
    private fun openRecord(): Mic? {
        val minBuf = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minBuf <= 0) return null
        val r = runCatching {
            AudioRecord.Builder()
                .setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
                .setAudioFormat(AudioFormat.Builder().setSampleRate(RATE).setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                .setBufferSizeInBytes(maxOf(minBuf, READ_SAMPLES * 2 * 4))
                .build()
        }.getOrNull() ?: return null
        if (r.state != AudioRecord.STATE_INITIALIZED) { r.release(); return null }
        runCatching { r.startRecording() }.onFailure { r.release(); return null }
        if (r.recordingState != AudioRecord.RECORDSTATE_RECORDING) { r.release(); return null }
        return RecordMic(r)
    }

    private fun close() {
        val m = synchronized(lock) { mic.also { mic = null } } ?: return
        m.stop()
        m.release()
    }

    private class RecordMic(private val r: AudioRecord) : Mic {
        override fun read(buf: ShortArray): Int {
            var filled = 0
            while (filled < buf.size) {
                val n = r.read(buf, filled, buf.size - filled)
                if (n <= 0) return if (filled > 0) filled else -1
                filled += n
            }
            return filled
        }
        override fun stop() { runCatching { r.stop() } }
        override fun release() = r.release()
    }

    /** Debug builds: a 16 kHz mono PCM16 file in real time, then a quiet room until the microphone reopens. */
    private class FileMic(private val pcm: ByteArray) : Mic {
        @Volatile private var stopped = false
        private var at = 0
        private val noise = java.util.Random(1)
        override fun read(buf: ShortArray): Int {
            if (stopped) return -1
            try { Thread.sleep(buf.size * 1000L / RATE) } catch (_: InterruptedException) {}
            for (i in buf.indices) {
                buf[i] = if (at + 1 < pcm.size) ((pcm[at].toInt() and 0xFF) or (pcm[at + 1].toInt() shl 8)).toShort()
                         else (noise.nextGaussian() * 20).toInt().toShort()
                at += 2
            }
            return if (stopped) -1 else buf.size
        }
        override fun stop() { stopped = true }
        override fun release() {}
    }

    private fun bytes(buf: ShortArray, n: Int): ByteArray {
        val out = ByteArray(n * 2)
        for (i in 0 until n) { out[2 * i] = buf[i].toByte(); out[2 * i + 1] = (buf[i].toInt() shr 8).toByte() }
        return out
    }

    companion object {
        private const val TAG = "WakeWord"
        const val RATE = 16_000
        /** 160 ms: two model steps per wakeup. */
        const val READ_SAMPLES = 2_560
        /** How long the words after the wake word wait for the call to take them. */
        const val HAND_OVER_MAX_MS = 20_000L
        const val STATS_MS = 30 * 60_000L
        /** Set only by debug builds' test receiver. */
        @Volatile var testSource: java.io.File? = null

        fun loadModel(context: Context): WakeModel =
            OnnxWakeModel(context.assets.open("wakeword/woodhouse.onnx").use { it.readBytes() })
    }
}
