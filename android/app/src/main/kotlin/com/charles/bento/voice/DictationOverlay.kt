package com.charles.bento.voice

import android.content.Context
import android.graphics.PixelFormat
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.WindowManager
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.automirrored.rounded.Undo
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.charles.bento.settings.Prefs
import com.charles.bento.ui.ComposeWindowOwner
import com.charles.bento.ui.theme.BentoTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * The dictation bubble and the transcript pill, as accessibility overlays (no "draw over
 * other apps" permission needed). The bubble sits beside the keyboard while a text field
 * is focused; the pill appears above the keyboard while listening and after inserting.
 */
class DictationOverlay(
    private val context: Context,
    private val prefs: Prefs,
    private val dictation: DictationController,
    private val onHide: () -> Unit,
) {
    private val wm = context.getSystemService(WindowManager::class.java)
    private val density = context.resources.displayMetrics.density
    private var bubble: Window? = null
    private var pill: Window? = null
    private var field: BentoAccessibilityService.FocusedField? = null
    private val pillState = MutableStateFlow<DictationState>(DictationState.Idle)

    private inner class Window(val view: ComposeView, val params: WindowManager.LayoutParams, val owner: ComposeWindowOwner)

    /** `showBubbleFor`: the field to show the bubble beside (null hides it); `state`: the dictation. */
    fun update(showBubbleFor: BentoAccessibilityService.FocusedField?, current: BentoAccessibilityService.FocusedField?, state: DictationState) {
        field = current
        val dictating = state !is DictationState.Idle
        if (showBubbleFor != null && !dictating) showBubble(showBubbleFor) else hideBubble()
        pillState.value = state
        if (dictating && dictation.intoOtherApp) showPill(current) else hidePill()
    }

    fun hapticStart() {
        if (prefs.haptics.value) (pill?.view ?: bubble?.view)?.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
    }

    fun destroy() {
        hideBubble()
        hidePill()
    }

    private fun px(dp: Int) = (dp * density).roundToInt()

    private fun baseParams(gravity: Int) = WindowManager.LayoutParams(
        WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
        PixelFormat.TRANSLUCENT,
    ).apply { this.gravity = gravity }

    private fun window(params: WindowManager.LayoutParams, content: @Composable () -> Unit): Window {
        val owner = ComposeWindowOwner()
        val view = ComposeView(context).apply {
            owner.attach(this)
            setContent { BentoTheme(prefs.theme.value) { content() } }
        }
        owner.resume()
        wm.addView(view, params)
        return Window(view, params, owner)
    }

    private fun remove(w: Window?) {
        w ?: return
        runCatching { wm.removeView(w.view) }
        w.owner.destroy()
    }

    // MARK: Bubble

    private fun bubblePosition(f: BentoAccessibilityService.FocusedField, size: Int): Pair<Int, Int> {
        val w = f.screen.width().takeIf { it > 0 } ?: context.resources.displayMetrics.widthPixels
        val h = f.screen.height().takeIf { it > 0 } ?: context.resources.displayMetrics.heightPixels
        val maxY = (f.keyboardTop ?: (h - px(320))) - size - px(10)
        val fx = prefs.bubbleX.value
        val fy = prefs.bubbleY.value
        val x = if (fx < 0) w - size - px(10) else (fx * w).roundToInt().coerceIn(0, w - size)
        val y = if (fy < 0) maxY else (fy * h).roundToInt().coerceIn(px(24), maxY)
        return x to y
    }

    private fun showBubble(f: BentoAccessibilityService.FocusedField) {
        val size = px(prefs.bubbleSize.value)
        val (x, y) = bubblePosition(f, size)
        bubble?.let { b ->
            if (b.params.x != x || b.params.y != y) {
                b.params.x = x; b.params.y = y
                runCatching { wm.updateViewLayout(b.view, b.params) }
            }
            return
        }
        val params = baseParams(Gravity.TOP or Gravity.START).apply { this.x = x; this.y = y }
        var b: Window? = null
        b = window(params) {
            Bubble(
                sizeDp = prefs.bubbleSize.value,
                onTap = { dictation.startFromBubble(handsFree = true) },
                onHoldStart = { if (dictation.startFromBubble(handsFree = false)) hapticStart() },
                onHoldEnd = { dictation.stop() },
                onDrag = { dx, dy ->
                    val bw = b ?: return@Bubble
                    bw.params.x += dx.roundToInt(); bw.params.y += dy.roundToInt()
                    runCatching { wm.updateViewLayout(bw.view, bw.params) }
                },
                onDragEnd = {
                    val bw = b ?: return@Bubble
                    val screenW = context.resources.displayMetrics.widthPixels.toFloat()
                    val screenH = context.resources.displayMetrics.heightPixels.toFloat()
                    if (bw.params.y > screenH - px(90)) {
                        // dropped at the bottom edge: hide it in this app
                        onHide()
                    } else {
                        // snap to the nearer side, remember where
                        val toRight = bw.params.x + size / 2 > screenW / 2
                        bw.params.x = if (toRight) (screenW - size - px(10)).roundToInt() else px(10)
                        runCatching { wm.updateViewLayout(bw.view, bw.params) }
                        prefs.bubbleX.value = bw.params.x / screenW
                        prefs.bubbleY.value = bw.params.y / screenH
                    }
                },
            )
        }
        bubble = b
    }

    private fun hideBubble() {
        remove(bubble)
        bubble = null
    }

    // MARK: Pill

    private fun showPill(f: BentoAccessibilityService.FocusedField?) {
        val h = context.resources.displayMetrics.heightPixels
        val bottomOffset = f?.keyboardTop?.let { (h - it) + px(8) } ?: px(140)
        pill?.let { p ->
            if (p.params.y != bottomOffset) {
                p.params.y = bottomOffset
                runCatching { wm.updateViewLayout(p.view, p.params) }
            }
            return
        }
        val params = baseParams(Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply {
            width = WindowManager.LayoutParams.MATCH_PARENT
            y = bottomOffset
        }
        pill = window(params) { Pill(pillState, dictation, prefs) }
    }

    private fun hidePill() {
        remove(pill)
        pill = null
    }
}

@Composable
private fun Bubble(
    sizeDp: Int,
    onTap: () -> Unit,
    onHoldStart: () -> Unit,
    onHoldEnd: () -> Unit,
    onDrag: (Float, Float) -> Unit,
    onDragEnd: () -> Unit,
) {
    var pressed by remember { mutableStateOf(false) }
    val scale by animateFloatAsState(if (pressed) 0.9f else 1f, label = "bubble")
    Box(
        Modifier
            .padding(6.dp)
            .size(sizeDp.dp)
            .scale(scale)
            .shadow(6.dp, CircleShape)
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.primary)
            .pointerInput(Unit) {
                awaitEachGesture {
                    val down = awaitFirstDown()
                    pressed = true
                    var dragging = false
                    var holding = false
                    val downAt = down.uptimeMillis
                    while (true) {
                        val event = awaitPointerEvent()
                        val change = event.changes.firstOrNull { it.id == down.id } ?: break
                        if (!dragging && !holding && change.uptimeMillis - downAt > 350) {
                            holding = true
                            onHoldStart()
                        }
                        val delta = change.positionChange()
                        if (!holding && (dragging || abs(delta.x) + abs(delta.y) > viewConfiguration.touchSlop / 2)) {
                            dragging = true
                            onDrag(delta.x, delta.y)
                            change.consume()
                        }
                        if (!change.pressed) break
                    }
                    pressed = false
                    when {
                        dragging -> onDragEnd()
                        holding -> onHoldEnd()
                        else -> onTap()
                    }
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Icon(Icons.Rounded.Mic, contentDescription = "Dictate", tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size((sizeDp * 0.48f).dp))
    }
}

@Composable
private fun Pill(stateFlow: StateFlow<DictationState>, dictation: DictationController, prefs: Prefs) {
    var state by remember { mutableStateOf(stateFlow.value) }
    LaunchedEffect(stateFlow) { stateFlow.collect { state = it } }
    val levels = remember { mutableStateListOf<Float>().apply { repeat(36) { add(0f) } } }
    LaunchedEffect(state) {
        (state as? DictationState.Listening)?.let { levels.removeAt(0); levels.add(it.level) }
        if (state is DictationState.Done) { delay(4_000); dictation.dismiss() }
    }
    Surface(
        Modifier.padding(horizontal = 12.dp).fillMaxWidth(),
        shape = RoundedCornerShape(26.dp),
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        tonalElevation = 6.dp,
        shadowElevation = 8.dp,
    ) {
        AnimatedContent(state::class, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "pill") { _ ->
            when (val s = state) {
                is DictationState.Listening -> Row(Modifier.padding(horizontal = 10.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = { dictation.cancel() }) { Icon(Icons.Rounded.Close, "Cancel") }
                    Box(Modifier.weight(1f).height(44.dp), contentAlignment = Alignment.CenterStart) {
                        if (s.partial.isBlank()) {
                            Waveform(levels, MaterialTheme.colorScheme.primary)
                        } else {
                            Text(s.partial.takeLast(160), maxLines = 2, overflow = TextOverflow.Ellipsis,
                                 style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                    if (s.modeName != null && !s.editing) {
                        TextButton(onClick = { dictation.cycleMode() }) { Text(s.modeName, maxLines = 1) }
                    }
                    if (s.editing) Text("Edit", color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(end = 4.dp))
                    StopButton(level = s.level) { dictation.stop() }
                }
                is DictationState.Processing -> Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(12.dp))
                    Text(if (s.editing) "Rewriting…" else s.partial.takeLast(120).ifBlank { "Transcribing…" },
                         maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                }
                is DictationState.Done -> Row(Modifier.padding(horizontal = 14.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Rounded.Check, null, tint = MaterialTheme.colorScheme.primary)
                    Spacer(Modifier.width(10.dp))
                    Text(s.text, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                    if (s.undo != null) IconButton(onClick = { s.undo.invoke(); dictation.dismiss() }) { Icon(Icons.AutoMirrored.Rounded.Undo, "Undo") }
                    if (s.canEdit) IconButton(onClick = { dictation.startEdit() }) { Icon(Icons.Rounded.Edit, "Edit by voice") }
                }
                is DictationState.Failed -> Row(Modifier.padding(horizontal = 14.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Rounded.ErrorOutline, null, tint = MaterialTheme.colorScheme.error)
                    Spacer(Modifier.width(10.dp))
                    Text(s.message, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                    if (s.canRetry) IconButton(onClick = { dictation.retry() }) { Icon(Icons.Rounded.Refresh, "Retry") }
                    IconButton(onClick = { dictation.dismiss() }) { Icon(Icons.Rounded.Close, "Dismiss") }
                }
                DictationState.Idle -> Spacer(Modifier.height(1.dp))
            }
        }
    }
}

@Composable
fun Waveform(levels: List<Float>, color: Color, modifier: Modifier = Modifier) {
    Row(modifier.height(32.dp), horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.CenterVertically) {
        levels.forEach { l ->
            Box(Modifier.width(3.dp).height((4 + 28 * l).dp).clip(RoundedCornerShape(2.dp)).background(color.copy(alpha = 0.35f + 0.65f * l)))
        }
    }
}

@Composable
private fun StopButton(level: Float, onClick: () -> Unit) {
    val ring by animateFloatAsState(1f + level * 0.25f, label = "ring")
    Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
        Box(Modifier.size(44.dp).scale(ring).clip(CircleShape).background(MaterialTheme.colorScheme.primary.copy(alpha = 0.18f)))
        Box(
            Modifier.size(38.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary).clickable(onClick = onClick),
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Rounded.Check, "Done", tint = MaterialTheme.colorScheme.onPrimary) }
    }
}
