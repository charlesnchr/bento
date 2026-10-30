package com.charles.bento.voice

import android.Manifest
import android.app.PendingIntent
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.service.quicksettings.TileService
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.charles.bento.graph
import com.charles.bento.ui.LiveTranscript
import com.charles.bento.ui.settings.Setup
import com.charles.bento.ui.theme.BentoTheme
import kotlinx.coroutines.delay

/**
 * A sheet over whatever is on screen (also over the lock screen) that listens right away
 * and files what you say: a thought into a note, or a task. Opened by the Quick Settings
 * tile, the capture widget, the "Bento Dictate" icon (for the Snap Key) and shortcuts.
 */
class CaptureActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setShowWhenLocked(true)
        val kind = intent.getStringExtra(EXTRA_KIND) ?: KIND_THOUGHT
        setContent {
            val theme by graph.prefs.theme.flow.collectAsStateWithLifecycle()
            BentoTheme(theme) { CaptureSheet(kind, onClose = ::finish) }
        }
    }

    override fun onStop() {
        super.onStop()
        // the screen going off (the power button; the timeout is held off while listening) isn't
        // leaving: keep listening, and the sheet is back when the screen comes on
        if (getSystemService(PowerManager::class.java)?.isInteractive == false) return
        // leaving the sheet keeps what was said: finish it rather than drop it
        if (graph.dictation.state.value is DictationState.Listening) graph.dictation.stop()
        if (!isChangingConfigurations) finish()
    }

    companion object {
        const val EXTRA_KIND = "kind"
        const val KIND_THOUGHT = "thought"
        const val KIND_TASK = "task"

        fun intent(context: Context, kind: String) = Intent(context, CaptureActivity::class.java)
            .putExtra(EXTRA_KIND, kind)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
    }
}

@Composable
private fun CaptureSheet(kind: String, onClose: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val graph = context.graph
    val state by graph.dictation.state.collectAsStateWithLifecycle()
    val mic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) start(context, kind) else onClose()
    }
    LaunchedEffect(Unit) {
        if (!Setup.hasMic(context)) mic.launch(Manifest.permission.RECORD_AUDIO)
        else if (graph.dictation.state.value !is DictationState.Listening) start(context, kind)
    }
    LaunchedEffect(state) {
        when (val s = state) {
            // long enough to read what was filed, then out of the way
            is DictationState.Done -> { delay((1_400L + 25L * (s.detail?.length ?: 0)).coerceAtMost(4_000L)); graph.dictation.dismiss(); onClose() }
            DictationState.Idle -> { delay(300); if (graph.dictation.state.value == DictationState.Idle) onClose() }
            else -> {}
        }
    }
    // a long thought outlasts the screen timeout: the screen stays on while listening
    val view = LocalView.current
    val listening = state is DictationState.Listening
    DisposableEffect(listening) {
        view.keepScreenOn = listening
        onDispose { view.keepScreenOn = false }
    }
    val levels = remember { mutableStateListOf<Float>().apply { repeat(44) { add(0f) } } }
    LaunchedEffect(state) { (state as? DictationState.Listening)?.let { levels.removeAt(0); levels.add(it.level) } }

    Box(
        Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.35f))
            .clickable(remember { MutableInteractionSource() }, indication = null) {
                when (state) {
                    is DictationState.Listening -> graph.dictation.stop()
                    is DictationState.Done -> { graph.dictation.dismiss(); onClose() }
                    else -> onClose()
                }
            },
        contentAlignment = Alignment.BottomCenter,
    ) {
        Surface(
            Modifier.fillMaxWidth().padding(10.dp).navigationBarsPadding().clickable(remember { MutableInteractionSource() }, indication = null) {},
            shape = RoundedCornerShape(28.dp),
            color = MaterialTheme.colorScheme.surfaceContainerHigh,
            tonalElevation = 6.dp,
        ) {
            Column(Modifier.padding(start = 20.dp, end = 12.dp, top = 12.dp, bottom = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(if (kind == CaptureActivity.KIND_TASK) "New task" else "Capture thought",
                         style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                    IconButton(onClick = { graph.dictation.cancel(); onClose() }) { Icon(Icons.Rounded.Close, "Cancel") }
                }
                val transcript = MaterialTheme.typography.bodyLarge
                // the sheet must leave room for its buttons in landscape and split screen
                val cap = minOf(220.dp, (LocalConfiguration.current.screenHeightDp * 0.4f).dp)
                Column(Modifier.padding(end = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    when (val s = state) {
                        is DictationState.Listening -> {
                            // everything heard so far, following the latest words
                            if (s.partial.isBlank()) Box(Modifier.fillMaxWidth().height(64.dp), contentAlignment = Alignment.CenterStart) {
                                Waveform(levels, MaterialTheme.colorScheme.primary)
                            } else LiveTranscript(s.partial, Modifier.heightIn(min = 64.dp), maxHeight = cap, style = transcript)
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text("Tap anywhere when you're done", color = MaterialTheme.colorScheme.onSurfaceVariant,
                                     style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                                Box(
                                    Modifier.size(56.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary).clickable { graph.dictation.stop() },
                                    contentAlignment = Alignment.Center,
                                ) { Icon(Icons.Rounded.Check, "Done", tint = MaterialTheme.colorScheme.onPrimary) }
                            }
                        }
                        is DictationState.Processing -> {
                            Status(MaterialTheme.colorScheme.onSurfaceVariant, "Transcribing…") { CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) }
                            if (s.partial.isNotBlank()) LiveTranscript(s.partial, maxHeight = cap, style = transcript, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        is DictationState.Done -> {
                            Status(MaterialTheme.colorScheme.primary, s.text) { Icon(Icons.Rounded.Check, null, tint = MaterialTheme.colorScheme.primary) }
                            // what was filed, in full
                            s.detail?.let { LiveTranscript(it, maxHeight = cap, style = transcript) }
                        }
                        is DictationState.Failed -> {
                            Text(s.message, color = MaterialTheme.colorScheme.error)
                            // what was heard before it failed stays readable, and can be kept
                            s.heard?.let { LiveTranscript(it, maxHeight = cap, style = transcript, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                            Row {
                                if (s.heard != null) TextButton(onClick = {
                                    context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("Bento dictation", s.heard))
                                    Toast.makeText(context, "Copied", Toast.LENGTH_SHORT).show()
                                }) { Text("Copy") }
                                if (s.canRetry) TextButton(onClick = { graph.dictation.retry() }) { Text("Try again") }
                            }
                        }
                        DictationState.Idle -> Spacer(Modifier.height(64.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun Status(color: Color, text: String, icon: @Composable () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) { icon() }
        Spacer(Modifier.width(12.dp))
        Text(text, color = color, style = MaterialTheme.typography.titleSmall)
    }
}

private fun start(context: Context, kind: String) {
    val g = context.graph
    val target = if (kind == CaptureActivity.KIND_TASK) DictationTarget.Task
                 else DictationTarget.Thought(g.prefs.thoughtNote.value.ifEmpty { null })
    g.dictation.start(target, handsFree = true)
}

/** Quick Settings: "Capture thought", works from the lock screen. */
class DictateTileService : TileService() {
    override fun onClick() {
        val intent = CaptureActivity.intent(this, CaptureActivity.KIND_THOUGHT)
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }
}
