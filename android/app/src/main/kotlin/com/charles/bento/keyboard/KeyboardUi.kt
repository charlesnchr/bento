package com.charles.bento.keyboard

import android.view.HapticFeedbackConstants
import android.view.inputmethod.EditorInfo
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Backspace
import androidx.compose.material.icons.automirrored.rounded.KeyboardReturn
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.Keyboard
import androidx.compose.material.icons.rounded.KeyboardArrowUp
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.charles.bento.ui.LiveTranscript
import androidx.compose.ui.unit.sp
import com.charles.bento.voice.DictationState
import com.charles.bento.voice.Waveform
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private val PUNCTUATION = listOf(",", ".", "?", "!", "@", "~", "#", "-", "'", ":")
private val ROWS = listOf("qwertyuiop", "asdfghjkl", "zxcvbnm")
private val SYMBOL_ROWS = listOf("1234567890", "@#&*-+=()/", "\"':;!?_%")

@Composable
fun KeyboardUi(state: DictationState, editor: EditorInfo?, modeName: String?, hasModes: Boolean, actions: KeyboardActions) {
    var keys by remember { mutableStateOf(false) }
    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 6.dp, vertical = 6.dp)) {
            TopBar(state, modeName, hasModes, actions)
            if (keys) {
                Keys(actions, onVoice = { keys = false })
            } else {
                VoicePanel(state, actions)
                PunctuationRow(actions)
                BottomRow(editor, actions, onKeys = { keys = true })
            }
        }
    }
}

@Composable
private fun TopBar(state: DictationState, modeName: String?, hasModes: Boolean, actions: KeyboardActions) {
    Row(Modifier.fillMaxWidth().height(40.dp), verticalAlignment = Alignment.CenterVertically) {
        SmallKey(Icons.Rounded.Keyboard, "Previous keyboard", onLongPress = actions::pickKeyboard) { actions.switchKeyboard() }
        Spacer(Modifier.width(6.dp))
        if (hasModes) {
            Surface(shape = RoundedCornerShape(50), color = MaterialTheme.colorScheme.secondaryContainer,
                    modifier = Modifier.pressable { actions.cycleMode() }) {
                Text(modeName ?: "Default", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
            }
        }
        Spacer(Modifier.weight(1f))
        if (state is DictationState.Listening) SmallKey(Icons.Rounded.Close, "Cancel") { actions.cancel() }
        else SmallKey(Icons.Rounded.Edit, "Edit the last dictation by voice") { actions.edit() }
    }
}

@Composable
private fun VoicePanel(state: DictationState, actions: KeyboardActions) {
    val levels = remember { mutableStateListOf<Float>().apply { repeat(40) { add(0f) } } }
    LaunchedEffect(state) { (state as? DictationState.Listening)?.let { levels.removeAt(0); levels.add(it.level) } }
    val listening = state as? DictationState.Listening
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.fillMaxWidth().height(52.dp).padding(horizontal = 12.dp), contentAlignment = Alignment.Center) {
            when {
                listening != null && listening.partial.isNotBlank() -> LiveTranscript(
                    listening.partial, maxHeight = 52.dp, textAlign = TextAlign.Center, style = MaterialTheme.typography.bodyLarge,
                )
                listening != null -> Waveform(levels, MaterialTheme.colorScheme.primary)
                state is DictationState.Processing -> Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(10.dp))
                    Text(if (state.editing) "Rewriting…" else "Cleaning up…", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                state is DictationState.Failed -> Text(state.message, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center, maxLines = 2)
                else -> Text("Tap to talk · hold for push-to-talk", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
            }
        }
        BigMic(state, actions)
    }
}

@Composable
private fun BigMic(state: DictationState, actions: KeyboardActions) {
    val view = LocalView.current
    val listening = state as? DictationState.Listening
    val ring by animateFloatAsState(1f + (listening?.level ?: 0f) * 0.35f, label = "mic")
    Box(Modifier.size(96.dp), contentAlignment = Alignment.Center) {
        if (listening != null) Box(Modifier.size(84.dp).scale(ring).clip(CircleShape).background(MaterialTheme.colorScheme.primary.copy(alpha = 0.18f)))
        Box(
            Modifier.size(72.dp).clip(CircleShape)
                .background(if (listening != null) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.primaryContainer)
                .pointerInput(Unit) {
                    awaitEachGesture {
                        val down = awaitFirstDown()
                        val up = withTimeoutOrNullCompat(350) { waitForUpOrCancellation() }
                        if (up == null) {
                            // still down after 350 ms: push-to-talk
                            view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
                            actions.mic(handsFree = false)
                            waitForUpOrCancellation()
                            actions.micRelease()
                        } else {
                            view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
                            actions.mic(handsFree = true)
                        }
                        down.consume()
                    }
                },
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                if (listening != null) Icons.Rounded.Stop else Icons.Rounded.Mic, contentDescription = "Dictate",
                tint = if (listening != null) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onPrimaryContainer,
                modifier = Modifier.size(34.dp),
            )
        }
    }
}

@Composable
private fun PunctuationRow(actions: KeyboardActions) {
    Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        PUNCTUATION.forEach { p -> Key(p, Modifier.weight(1f)) { actions.punctuation(p) } }
    }
}

@Composable
private fun BottomRow(editor: EditorInfo?, actions: KeyboardActions, onKeys: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Key("abc", Modifier.weight(1.3f), muted = true, onClick = onKeys)
        Key("space", Modifier.weight(4f)) { actions.type(" ") }
        RepeatKey(Icons.AutoMirrored.Rounded.Backspace, "Delete", Modifier.weight(1.3f), actions)
        IconKey(Icons.AutoMirrored.Rounded.KeyboardReturn, enterLabel(editor), Modifier.weight(1.3f), accent = true) { actions.enter() }
    }
}

@Composable
private fun Keys(actions: KeyboardActions, onVoice: () -> Unit) {
    var shift by remember { mutableStateOf(false) }
    var symbols by remember { mutableStateOf(false) }
    val rows = if (symbols) SYMBOL_ROWS else ROWS
    Column(Modifier.fillMaxWidth().padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
        rows.forEachIndexed { i, row ->
            Row(Modifier.fillMaxWidth().padding(horizontal = if (i == 1 && !symbols) 14.dp else 0.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                if (i == 2) IconKey(Icons.Rounded.KeyboardArrowUp, "Shift", Modifier.weight(1.4f), accent = shift) { shift = !shift }
                row.forEach { ch ->
                    val c = if (shift && !symbols) ch.uppercaseChar() else ch
                    Key(c.toString(), Modifier.weight(1f)) { actions.type(c.toString()); if (shift) shift = false }
                }
                if (i == 2) RepeatKey(Icons.AutoMirrored.Rounded.Backspace, "Delete", Modifier.weight(1.4f), actions)
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Key(if (symbols) "abc" else "?123", Modifier.weight(1.4f), muted = true) { symbols = !symbols }
            IconKey(Icons.Rounded.Mic, "Voice", Modifier.weight(1.2f), accent = true, onClick = onVoice)
            Key(",", Modifier.weight(1f)) { actions.punctuation(",") }
            Key("space", Modifier.weight(4f)) { actions.type(" ") }
            Key(".", Modifier.weight(1f)) { actions.punctuation(".") }
            IconKey(Icons.AutoMirrored.Rounded.KeyboardReturn, "Enter", Modifier.weight(1.4f), muted = true) { actions.enter() }
        }
    }
}

private fun enterLabel(editor: EditorInfo?): String = when (editor?.imeOptions?.and(EditorInfo.IME_MASK_ACTION)) {
    EditorInfo.IME_ACTION_SEND -> "Send"
    EditorInfo.IME_ACTION_SEARCH -> "Search"
    EditorInfo.IME_ACTION_GO -> "Go"
    EditorInfo.IME_ACTION_NEXT -> "Next"
    EditorInfo.IME_ACTION_DONE -> "Done"
    else -> "Enter"
}

@Composable
private fun Key(label: String, modifier: Modifier = Modifier, muted: Boolean = false, onClick: () -> Unit) {
    val view = LocalView.current
    Surface(
        modifier.height(46.dp).pressable { view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP); onClick() },
        shape = RoundedCornerShape(10.dp),
        color = if (muted) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceContainerHighest,
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(label, fontSize = if (label.length > 1) 14.sp else 19.sp, fontWeight = FontWeight.Medium, maxLines = 1)
        }
    }
}

@Composable
private fun IconKey(icon: ImageVector, description: String, modifier: Modifier = Modifier, accent: Boolean = false, muted: Boolean = false, onClick: () -> Unit) {
    val view = LocalView.current
    Surface(
        modifier.height(46.dp).pressable { view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP); onClick() },
        shape = RoundedCornerShape(10.dp),
        color = when {
            accent -> MaterialTheme.colorScheme.primary
            muted -> MaterialTheme.colorScheme.secondaryContainer
            else -> MaterialTheme.colorScheme.surfaceContainerHighest
        },
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(icon, description, tint = if (accent) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface)
        }
    }
}

/** ⌫: deletes once, then repeats while held, then whole words. */
@Composable
private fun RepeatKey(icon: ImageVector, description: String, modifier: Modifier, actions: KeyboardActions) {
    val scope = rememberCoroutineScope()
    val view = LocalView.current
    var job by remember { mutableStateOf<Job?>(null) }
    Surface(
        modifier.height(46.dp).pointerInput(Unit) {
            awaitEachGesture {
                awaitFirstDown()
                view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
                actions.backspace(word = false)
                job = scope.launch {
                    delay(400)
                    var n = 0
                    while (true) {
                        actions.backspace(word = n > 12)
                        n++
                        delay(if (n > 12) 120 else 55)
                    }
                }
                waitForUpOrCancellation()
                job?.cancel()
            }
        },
        shape = RoundedCornerShape(10.dp),
        color = MaterialTheme.colorScheme.secondaryContainer,
    ) {
        Box(contentAlignment = Alignment.Center) { Icon(icon, description) }
    }
}

@Composable
private fun SmallKey(icon: ImageVector, description: String, onLongPress: (() -> Unit)? = null, onClick: () -> Unit) {
    Box(
        Modifier.size(40.dp).clip(CircleShape).pointerInput(Unit) {
            awaitEachGesture {
                awaitFirstDown()
                val up = withTimeoutOrNullCompat(500) { waitForUpOrCancellation() }
                if (up == null && onLongPress != null) { onLongPress(); waitForUpOrCancellation() } else if (up != null) onClick()
            }
        },
        contentAlignment = Alignment.Center,
    ) { Icon(icon, description, tint = MaterialTheme.colorScheme.onSurfaceVariant) }
}

/** Fires on release inside, without a ripple (keys give haptics instead). */
private fun Modifier.pressable(onClick: () -> Unit): Modifier = pointerInput(onClick) {
    awaitEachGesture {
        awaitFirstDown()
        if (waitForUpOrCancellation() != null) onClick()
    }
}

private suspend fun <T> androidx.compose.ui.input.pointer.AwaitPointerEventScope.withTimeoutOrNullCompat(
    ms: Long, block: suspend androidx.compose.ui.input.pointer.AwaitPointerEventScope.() -> T,
): T? = try { withTimeout(ms, block) } catch (_: androidx.compose.ui.input.pointer.PointerEventTimeoutCancellationException) { null }
