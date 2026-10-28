package com.charles.bento.ui.voice

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Groups
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.RadioButtonUnchecked
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavController
import com.charles.bento.graph
import com.charles.bento.ui.MeetingRoute
import com.charles.bento.ui.SettingsRoute
import com.charles.bento.ui.settings.Setup
import com.charles.bento.ui.settings.scanPairingCode
import com.charles.bento.voice.DictationState
import com.charles.bento.voice.DictationTarget
import com.charles.bento.voice.FieldContext

/** Summary of a meeting for the list (from the meeting store). */
data class MeetingRow(val id: String, val title: String, val subtitle: String, val recording: Boolean)

/** Summary of a dictation for the history list. */
data class HistoryRow(val id: String, val text: String, val subtitle: String, val failed: Boolean)

/** What the Voice tab lists; wired to the meeting and history stores. */
interface VoiceLists {
    val meetings: kotlinx.coroutines.flow.StateFlow<List<MeetingRow>>
    val history: kotlinx.coroutines.flow.StateFlow<List<HistoryRow>>
    val recordingMeeting: kotlinx.coroutines.flow.StateFlow<String?>
    /** False when it can't start (no key, no microphone permission). */
    fun startMeeting(): Boolean
    fun stopMeeting()
    fun retry(historyId: String)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VoiceScreen(modifier: Modifier, nav: NavController) {
    val context = LocalContext.current
    val graph = context.graph
    var tick by remember { mutableIntStateOf(0) }
    LifecycleResumeEffect(Unit) { tick++; onPauseOrDispose { } }
    val lists = graph.voiceLists
    val meetings by lists.meetings.collectAsStateWithLifecycle()
    val history by lists.history.collectAsStateWithLifecycle()
    val recording by lists.recordingMeeting.collectAsStateWithLifecycle()
    var openWhenStarted by remember { mutableStateOf(false) }
    androidx.compose.runtime.LaunchedEffect(recording) {
        if (openWhenStarted && recording != null) { openWhenStarted = false; nav.navigate(MeetingRoute(recording!!)) }
    }

    Column(modifier.fillMaxSize()) {
        LargeTopAppBar(
            title = { Text("Voice") },
            actions = { IconButton(onClick = { nav.navigate(SettingsRoute) }) { Icon(Icons.Rounded.Settings, "Settings") } },
        )
        LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 24.dp)) {
            item { SetupCard(tick) }
            item { TryIt() }
            item {
                MeetingCard(recording != null, onToggle = {
                    if (recording != null) lists.stopMeeting() else if (lists.startMeeting()) openWhenStarted = true
                }, onOpen = { recording?.let { nav.navigate(MeetingRoute(it)) } })
            }
            if (meetings.isNotEmpty()) {
                item { SectionTitle("Meetings") }
                items(meetings, key = { "m" + it.id }) { m ->
                    ListRow(m.title, m.subtitle, Icons.Rounded.Groups) { nav.navigate(MeetingRoute(m.id)) }
                }
            }
            if (history.isNotEmpty()) {
                item { SectionTitle("Recent dictations") }
                items(history, key = { "h" + it.id }) { h ->
                    ListRow(h.text, h.subtitle, Icons.Rounded.Mic, error = h.failed) {
                        if (h.failed) lists.retry(h.id) else copy(context, h.text)
                    }
                }
            }
        }
    }
}

private fun copy(context: android.content.Context, text: String) {
    context.getSystemService(android.content.ClipboardManager::class.java)
        ?.setPrimaryClip(android.content.ClipData.newPlainText("Dictation", text))
}

@Composable
private fun SetupCard(tick: Int) {
    val context = LocalContext.current
    val graph = context.graph
    val mic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    val secrets by graph.secrets.version.collectAsStateWithLifecycle()
    val server by graph.prefs.server.flow.collectAsStateWithLifecycle()
    var pairing by remember { mutableStateOf<com.charles.bento.settings.Pairing?>(null) }
    pairing?.let { p -> com.charles.bento.ui.settings.PairingDialog(p) { pairing = null } }
    val steps = remember(tick, secrets, server) {
        listOf(
            Step("Pair with your Mac", "Sync notes, tasks and your dictionary", server.isNotBlank() && graph.secrets.syncToken != null) {
                scanPairingCode(context) { p -> pairing = p }
            },
            Step("Gemini API key", "Comes with the pairing code, or add it in Settings", graph.secrets.geminiKey != null, null),
            Step("Microphone", "Allow Bento to listen when you ask it to", Setup.hasMic(context)) { mic.launch(Manifest.permission.RECORD_AUDIO) },
            Step("Dictate in any app", "Turn on Bento dictation in Accessibility", Setup.accessibilityEnabled(context)) { Setup.openAccessibility(context) },
            Step("Keep it running", "Allow background activity (ColorOS)", Setup.ignoringBatteryOptimizations(context)) { Setup.requestBatteryExemption(context) },
        )
    }
    if (steps.all { it.done }) return
    Surface(Modifier.padding(16.dp).fillMaxWidth(), shape = RoundedCornerShape(24.dp), color = MaterialTheme.colorScheme.primaryContainer) {
        Column(Modifier.padding(vertical = 12.dp)) {
            Text("Set up", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onPrimaryContainer,
                 modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp))
            steps.forEach { s ->
                Row(
                    Modifier.fillMaxWidth().clickable(enabled = !s.done && s.action != null) { s.action?.invoke() }
                        .padding(horizontal = 20.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(if (s.done) Icons.Rounded.CheckCircle else Icons.Rounded.RadioButtonUnchecked, null,
                         tint = if (s.done) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onPrimaryContainer)
                    Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f)) {
                        Text(s.title, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onPrimaryContainer)
                        Text(s.detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.75f))
                    }
                }
            }
        }
    }
}

private class Step(val title: String, val detail: String, val done: Boolean, val action: (() -> Unit)?)

/** A field inside Bento to try dictation (and voice edits) without leaving the app. */
@Composable
private fun TryIt() {
    val graph = LocalContext.current.graph
    val state by graph.dictation.state.collectAsStateWithLifecycle()
    var value by remember { mutableStateOf(TextFieldValue("")) }
    val listening = state is DictationState.Listening
    Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
        OutlinedTextField(
            value = value, onValueChange = { value = it },
            modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp),
            placeholder = { Text("Try it: tap the mic and talk") },
            supportingText = {
                Text(
                    when (val s = state) {
                        is DictationState.Listening -> s.partial.ifBlank { "Listening…" }
                        is DictationState.Processing -> "Cleaning up…"
                        is DictationState.Failed -> s.message
                        else -> "Outside Bento: the bubble, a held Volume Down, or the Bento keyboard"
                    },
                    maxLines = 2, overflow = TextOverflow.Ellipsis,
                )
            },
            trailingIcon = {
                FilledIconButton(onClick = {
                    if (listening) graph.dictation.stop()
                    else graph.dictation.start(
                        DictationTarget.Editor(
                            commit = { text ->
                                val v = value
                                val before = v.text.substring(0, v.selection.start)
                                val ins = com.charles.bento.voice.TextInserter.spaced(text, before, v.text.substring(v.selection.end))
                                val t = before + ins + v.text.substring(v.selection.end)
                                value = TextFieldValue(t, TextRange(before.length + ins.length))
                            },
                            context = FieldContext(appLabel = "Bento", hint = "A test note", textBefore = value.text),
                        ),
                        handsFree = true,
                    )
                }) { Icon(if (listening) Icons.Rounded.Stop else Icons.Rounded.Mic, "Dictate") }
            },
        )
    }
}

@Composable
private fun MeetingCard(recording: Boolean, onToggle: () -> Unit, onOpen: () -> Unit) {
    Surface(
        Modifier.padding(horizontal = 16.dp, vertical = 8.dp).fillMaxWidth().clickable(enabled = recording, onClick = onOpen),
        shape = RoundedCornerShape(24.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh,
    ) {
        Row(Modifier.padding(18.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(if (recording) "Recording a meeting" else "Meeting notes", style = MaterialTheme.typography.titleMedium)
                Text(
                    if (recording) "Tap to see the live transcript" else "Records the room, tidies the transcript live, and files a summary with action items as a note",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.width(12.dp))
            Button(onClick = onToggle) { Text(if (recording) "Stop" else "Record") }
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(text, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary,
         modifier = Modifier.padding(start = 24.dp, top = 16.dp, bottom = 4.dp))
}

@Composable
private fun ListRow(title: String, subtitle: String, icon: androidx.compose.ui.graphics.vector.ImageVector, error: Boolean = false, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 20.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(36.dp), contentAlignment = Alignment.Center) {
            Surface(shape = CircleShape, color = if (error) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.secondaryContainer,
                    modifier = Modifier.size(36.dp)) {}
            Icon(icon, null, Modifier.size(18.dp), tint = if (error) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onSecondaryContainer)
        }
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(title, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyLarge)
            Text(subtitle, maxLines = 1, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
