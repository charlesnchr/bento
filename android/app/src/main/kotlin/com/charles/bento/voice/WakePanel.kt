package com.charles.bento.voice

import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.ComponentCallbacks
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.os.PowerManager
import android.provider.Settings
import android.view.Display
import android.view.Gravity
import android.view.WindowInsets
import android.view.WindowManager
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CallEnd
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.ProcessLifecycleOwner
import com.charles.bento.MainActivity
import com.charles.bento.assistant.AssistantController
import com.charles.bento.assistant.AssistantUi
import com.charles.bento.assistant.latestExchange
import com.charles.bento.settings.Prefs
import com.charles.bento.ui.ComposeWindowOwner
import com.charles.bento.ui.LiveTranscript
import com.charles.bento.ui.linesHeight
import com.charles.bento.ui.theme.BentoTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/**
 * What a wake word call shows over other apps, as the Google Assistant does: a card at the
 * bottom of the screen from the moment "Pennyworth" is heard until just after the call ends, with
 * the call's state, what you're saying and the spoken reply, and End and Open. It's a window over
 * other apps once Android allows that, else an accessibility overlay when Bento's accessibility
 * service is on ([canShow]); with neither, only the call's notification says what's happening.
 * Hidden while Bento itself is on screen, which shows the call, and while the phone is locked: the
 * words aren't for anyone who picks it up (the notification keeps to the lock screen's settings).
 * Main thread.
 */
class WakePanel(
    private val context: Context,
    private val prefs: Prefs,
    private val scope: CoroutineScope,
    private val assistant: () -> AssistantController,
) {
    /** [host]: the accessibility service whose overlay it is, null for a window over other apps. */
    private class Window(
        val ctx: Context, val wm: WindowManager, val view: ComposeView, val owner: ComposeWindowOwner,
        val params: WindowManager.LayoutParams, val host: BentoAccessibilityService?,
    ) {
        /** Places it again as the display rotates and the keyboard comes and goes. */
        var rotation: ComponentCallbacks? = null
        var keyboard: Job? = null
    }

    private var window: Window? = null
    /** From the wake word until the panel goes: shown whenever Bento isn't on screen. */
    private var active = false
    /** Once the call has ended, how, until the panel goes. */
    private val ended = MutableStateFlow<Ended?>(null)
    private var hideJob: Job? = null
    /** One window context for every window over other apps (each holds a token in the system). */
    private val overAppsContext by lazy {
        val display = context.getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY)
        context.createWindowContext(display, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, null)
    }

    init {
        // Bento on screen shows the call itself; left mid-call, the panel comes back
        ProcessLifecycleOwner.get().lifecycle.addObserver(LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> close()
                Lifecycle.Event.ON_STOP -> if (active) open()
                else -> Unit
            }
        })
        // Gone as the screen goes off, back as it comes on unlocked or once it's unlocked. Off counts
        // as locked: the phone may lock a while later, with the panel up, and say nothing.
        val screen = object : BroadcastReceiver() {
            override fun onReceive(c: Context, intent: Intent) {
                if (intent.action == Intent.ACTION_SCREEN_OFF) close() else if (active) open()
            }
        }
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF); addAction(Intent.ACTION_SCREEN_ON); addAction(Intent.ACTION_USER_PRESENT)
        }
        // Exported: SystemUI sends USER_PRESENT, not the system server, and an unexported receiver
        // drops it. All three are protected broadcasts, which no app can send.
        ContextCompat.registerReceiver(context, screen, filter, ContextCompat.RECEIVER_EXPORTED)
    }

    /** The wake word was heard: up until [finish]. */
    fun show() {
        hideJob?.cancel()
        ended.value = null
        active = true
        open()
    }

    /** The call ended (or never started): says so for a moment, longer for an error, then goes. */
    fun finish(error: String?) {
        if (!active) return
        ended.value = Ended(error)
        hideJob?.cancel()
        hideJob = scope.launch {
            delay(if (error == null) 2_500 else 6_000)
            active = false
            close()
        }
    }

    /**
     * The accessibility service started or stopped. Stopped, the system took its overlay with it, so
     * the panel moves to a window of its own if it can; started, a panel that had nowhere to go shows.
     */
    fun accessibilityChanged() {
        window?.takeIf { it.host != null && it.host !== BentoAccessibilityService.instance }?.let { close() }
        if (active) open()
    }

    private fun open() {
        // an overlay of an accessibility service that has gone since: the system removed it
        window?.takeIf { it.host != null && it.host !== BentoAccessibilityService.instance }?.let { close() }
        if (window != null || !prefs.wakePanel.value || bentoOnScreen()) return
        if (!context.getSystemService(PowerManager::class.java).isInteractive) return
        if (context.getSystemService(KeyguardManager::class.java).isKeyguardLocked) return
        // A window over other apps sits below the keyboard and the lock screen; the accessibility
        // service's overlay (no permission needed) sits above both, so it's placed above the keyboard.
        val a11y = BentoAccessibilityService.instance
        val (ctx, type) = when {
            Settings.canDrawOverlays(context) -> overAppsContext to WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            a11y != null -> a11y to WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY
            else -> return
        }
        val host = a11y.takeIf { type == WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY }
        val wm = ctx.getSystemService(WindowManager::class.java)
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            // touches outside it reach the app below; it never takes the keyboard
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT,
        ).apply { gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL }
        place(params, ctx, wm, host)
        val owner = ComposeWindowOwner()
        val view = ComposeView(ctx).apply {
            owner.attach(this)
            setContent {
                BentoTheme(prefs.theme.value) {
                    Panel(assistant().state, ended, onEnd = ::end, onOpen = ::openBento)
                }
            }
        }
        owner.resume()
        if (runCatching { wm.addView(view, params) }.isFailure) { owner.destroy(); return }
        val w = Window(ctx, wm, view, owner, params, host)
        window = w
        w.rotation = object : ComponentCallbacks {
            override fun onConfigurationChanged(newConfig: Configuration) = replace(w)
            @Deprecated("Deprecated in Java") override fun onLowMemory() {}
        }.also(ctx::registerComponentCallbacks)
        w.keyboard = host?.let { h -> scope.launch { h.keyboardTop.collect { replace(w) } } }
    }

    /**
     * The window's margins (mostly not the card's padding: the strip around it mustn't take taps) and width
     * for the display as it is now, and for an accessibility overlay, which sits above the keyboard,
     * its place above any keyboard that's up.
     */
    private fun place(params: WindowManager.LayoutParams, ctx: Context, wm: WindowManager, host: BentoAccessibilityService?) {
        val metrics = wm.currentWindowMetrics
        val screen = metrics.bounds
        // 12 dp from the edges: half the window's margin, half the card's room for its shadow
        val margin = (6 * ctx.resources.displayMetrics.density).roundToInt()
        // the window is laid out clear of the bars and a cutout (down one side in landscape)
        val insets = metrics.windowInsets.getInsetsIgnoringVisibility(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
        params.width = screen.width() - insets.left - insets.right - 2 * margin
        val keyboardTop = host?.keyboardTop?.value
        params.fitInsetsTypes = WindowInsets.Type.systemBars()
        if (keyboardTop != null) {
            // clear of a side navigation bar, but y is a screen coordinate: from the display's bottom edge
            params.fitInsetsSides = WindowInsets.Side.LEFT or WindowInsets.Side.RIGHT
            params.y = screen.bottom - keyboardTop + margin
        } else {
            params.fitInsetsSides = WindowInsets.Side.all()
            params.y = margin
        }
    }

    private fun replace(w: Window) {
        if (window !== w) return
        place(w.params, w.ctx, w.wm, w.host)
        runCatching { w.wm.updateViewLayout(w.view, w.params) }
    }

    private fun close() {
        val w = window ?: return
        window = null
        w.keyboard?.cancel()
        w.rotation?.let { runCatching { w.ctx.unregisterComponentCallbacks(it) } }
        runCatching { w.wm.removeView(w.view) }
        w.owner.destroy()
    }

    /** End while in the call; once it's over, just closes the panel. */
    private fun end() {
        if (ended.value == null) assistant().endCall() else { hideJob?.cancel(); active = false; close() }
    }

    private fun openBento() {
        // allowed from the background: the panel is a visible window of Bento's
        runCatching {
            context.startActivity(
                Intent(context, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN_ASSISTANT).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }
    }

    private fun bentoOnScreen() = ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)

    companion object {
        /** Android lets Bento show the panel over other apps. */
        fun canShow(context: Context) = Settings.canDrawOverlays(context) || BentoAccessibilityService.isRunning
    }
}

/** How a wake call ended: [error] says why it failed, null when it simply ended. */
internal data class Ended(val error: String? = null)

/** The call's state in a few words. */
internal fun panelStatus(s: AssistantUi, ended: Ended?): String {
    val call = s.call
    return when {
        ended != null -> if (ended.error != null) "The call failed" else "Call ended"
        call == null -> "Listening…"
        call.micSilent -> "The microphone hears nothing"
        call.connecting -> "Connecting…"
        call.hermesWorking -> call.tasks.lastOrNull { it.active }?.progress?.let { "Hermes: $it" } ?: "Hermes is working…"
        else -> "Listening…"
    }
}

@Composable
private fun Panel(state: StateFlow<AssistantUi>, ended: StateFlow<Ended?>, onEnd: () -> Unit, onOpen: () -> Unit) {
    val s by state.collectAsState()
    val over by ended.collectAsState()
    val (said, reply) = s.latestExchange()
    Surface(
        Modifier.padding(6.dp).fillMaxWidth(),
        shape = RoundedCornerShape(28.dp),
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        tonalElevation = 6.dp,
        shadowElevation = 8.dp,
    ) {
        Column(Modifier.clickable(onClick = onOpen).padding(start = 18.dp, end = 6.dp, top = 6.dp, bottom = 12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Pulse(live = over == null)
                Spacer(Modifier.width(10.dp))
                Text(
                    panelStatus(s, over), maxLines = 1, overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary, modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onOpen) { Text("Open") }
                IconButton(onClick = onEnd) {
                    if (over == null) Icon(Icons.Rounded.CallEnd, "End call", tint = MaterialTheme.colorScheme.error)
                    else Icon(Icons.Rounded.Close, "Close")
                }
            }
            // fixed heights: the overlay window must not resize with each word
            val saidStyle = MaterialTheme.typography.titleMedium
            val replyStyle = MaterialTheme.typography.bodyMedium
            Column(Modifier.padding(end = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                val error = over?.error
                Box(Modifier.height(linesHeight(saidStyle, 2)), contentAlignment = Alignment.CenterStart) {
                    when {
                        error != null -> Text(error, style = saidStyle, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        !said.isNullOrBlank() -> LiveTranscript(said, maxHeight = linesHeight(saidStyle, 2), style = saidStyle)
                        else -> Text(if (over == null) "Go ahead, I'm listening" else "Didn't hear anything",
                                     style = saidStyle, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Box(Modifier.height(linesHeight(replyStyle, 2)), contentAlignment = Alignment.TopStart) {
                    if (error == null && !reply.isNullOrBlank()) {
                        LiveTranscript(reply, maxHeight = linesHeight(replyStyle, 2), style = replyStyle, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

/** A dot that breathes while the call is live. */
@Composable
private fun Pulse(live: Boolean) {
    val pulse = rememberInfiniteTransition(label = "pulse")
    val scale by pulse.animateFloat(0.75f, 1.15f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "scale")
    val color = if (live) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline
    Box(Modifier.size(12.dp).scale(if (live) scale else 1f).clip(CircleShape).background(color))
}
