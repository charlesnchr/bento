package com.charles.bento.ui.assistant

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.OpenInNew
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.Build
import androidx.compose.material.icons.rounded.CallEnd
import androidx.compose.material.icons.rounded.Block
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Error
import androidx.compose.material.icons.rounded.GraphicEq
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MicOff
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material.icons.automirrored.rounded.Chat
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.ArrowDropDown
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Memory
import androidx.compose.material.icons.rounded.Psychology
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavController
import com.charles.bento.assistant.AssistantController
import com.charles.bento.assistant.CallUi
import com.charles.bento.assistant.TaskUi
import com.charles.bento.core.assistant.ChatMessage
import com.charles.bento.core.assistant.HermesChoice
import com.charles.bento.core.assistant.HermesSession
import com.charles.bento.graph
import com.charles.bento.settings.Prefs
import com.charles.bento.ui.HomeAction
import com.charles.bento.ui.SettingsRoute
import com.charles.bento.ui.theme.SansCode
import kotlinx.coroutines.flow.MutableStateFlow
import java.text.DateFormat
import java.util.Date

/** Chat with Hermes, and voice calls through Gemini Live that hand requests to Hermes. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AssistantScreen(modifier: Modifier, nav: NavController, homeAction: MutableStateFlow<HomeAction?>) {
    val context = LocalContext.current
    val graph = context.graph
    val assistant = graph.assistant
    val state by assistant.state.collectAsStateWithLifecycle()
    val url by graph.prefs.hermesUrl.flow.collectAsStateWithLifecycle()
    val secretsVersion by graph.secrets.version.collectAsStateWithLifecycle()
    val configured = remember(url, secretsVersion) { assistant.configured }
    var showHistory by remember { mutableStateOf(false) }
    /** The call task whose conversation is open in a sheet. */
    var shownTask by remember { mutableStateOf<String?>(null) }
    LifecycleResumeEffect(configured) { assistant.onShown(); onPauseOrDispose { } }
    val mic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> if (granted) assistant.toggleCall() }
    fun call() {
        if (state.call != null || ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            assistant.toggleCall()
        } else mic.launch(Manifest.permission.RECORD_AUDIO)
    }
    // The Hermes call widget: a new chat and a call on it, unless a call is already running.
    LaunchedEffect(Unit) {
        homeAction.collect { a ->
            if (a != HomeAction.NewCall) return@collect
            homeAction.value = null
            if (assistant.state.value.call != null) return@collect
            assistant.newChat()
            call()
        }
    }

    Column(modifier.fillMaxSize().imePadding()) {
        TopAppBar(
            title = {
                Column {
                    Text(state.title ?: "Hermes", maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (state.title != null) Text("Hermes", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            },
            actions = {
                if (configured) {
                    IconButton(onClick = { assistant.refreshHistory(); showHistory = true }) { Icon(Icons.Rounded.History, "Conversations") }
                    IconButton(onClick = { assistant.newChat() }, enabled = !state.working && state.call == null) { Icon(Icons.Rounded.Add, "New chat") }
                }
                IconButton(onClick = { nav.navigate(SettingsRoute) }) { Icon(Icons.Rounded.Settings, "Settings") }
            },
        )
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        Box(Modifier.weight(1f)) {
            when {
                !configured -> SetupCard { nav.navigate(SettingsRoute) }
                state.messages.isEmpty() && !state.loading -> EmptyChat()
                // A task's session opens in the chat once the call is over; during it, the task's sheet shows it.
                else -> Messages(state.sessionId, state.messages, state.working, graph.prefs.hermesScroll, onAnswer = assistant::answer,
                                 onOpen = { m -> m.link?.let { link -> state.call?.tasks?.firstOrNull { it.sessionId == link }?.let { shownTask = it.id } ?: assistant.open(link) } })
            }
        }
        state.error?.let { ErrorBar(it) { assistant.dismissError() } }
        // A running call always keeps its bar (and its End button), whatever happens to the setup.
        val c = state.call
        if (c != null) CallBar(c, onMute = { assistant.setMuted(!c.muted) }, onWake = assistant::wakeCall, onEnd = { assistant.endCall() },
                               onOpenTask = { shownTask = it }, onCancelTask = assistant::cancelTask)
        else if (configured) {
            ModelPicker(assistant)
            Composer(state.working, onSend = assistant::send, onStop = assistant::stop, onCall = ::call)
        }
    }

    if (showHistory) HistorySheet(assistant, state.sessionId, onDismiss = { showHistory = false })
    val task = state.call?.tasks?.firstOrNull { it.id == shownTask }
    if (task != null) TaskSheet(task, onAnswer = assistant::answer, onCancel = { assistant.cancelTask(task.id) }, onDismiss = { shownTask = null })
}

@Composable
private fun SetupCard(onSetup: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(Icons.Rounded.AutoAwesome, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(48.dp))
        Spacer(Modifier.size(16.dp))
        Text("Talk to Hermes", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.size(8.dp))
        Text(
            "Chat with your Hermes agent or call it by voice, over your tailnet. Add its API server and key in Settings, " +
                "or scan the code Hermes's machine shows.",
            style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.size(20.dp))
        Button(onClick = onSetup) { Text("Set up Hermes") }
    }
}

@Composable
private fun EmptyChat() {
    Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(Icons.Rounded.AutoAwesome, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(40.dp))
        Spacer(Modifier.size(12.dp))
        Text("Ask Hermes anything, or tap the call button to talk.", style = MaterialTheme.typography.bodyLarge,
             color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun Messages(
    sessionId: String?, messages: List<ChatMessage>, working: Boolean, saved: Prefs.Pref<String>, onAnswer: (String, String) -> Unit,
    onOpen: (ChatMessage) -> Unit,
) {
    // Back where the user left this conversation (on another tab or screen, or before a new process), unless they were at
    // the bottom and more has come since: then at its end, like a conversation not seen here before.
    // A new list for each conversation shown (keyed by its first row, which a new session id from Hermes keeps):
    // another conversation, or the first load after a restart.
    val conversation = messages.firstOrNull()?.id
    val restored = remember(conversation) {
        messages.lastOrNull()?.let { last -> ChatScroll.restore(saved.value, sessionId)?.takeUnless { it.follows(messages.size, last.text.length) } }
    }
    val list = remember(conversation) { LazyListState(restored?.index ?: messages.lastIndex.coerceAtLeast(0), restored?.offset ?: 0) }
    // At the bottom, following the conversation, until the user scrolls away; back once they scroll to the very end.
    var pinned by remember(list) { mutableStateOf(restored?.pinned ?: true) }
    LaunchedEffect(list) { list.interactionSource.interactions.collect { if (it is DragInteraction.Start) pinned = false } }
    LaunchedEffect(list) {
        snapshotFlow { list.layoutInfo.totalItemsCount > 0 && !list.canScrollForward && !list.isScrollInProgress }.collect { if (it) pinned = true }
    }
    val current by rememberUpdatedState(list)
    val following by rememberUpdatedState(pinned)
    val session by rememberUpdatedState(sessionId)
    val shown by rememberUpdatedState(messages)
    val save = {
        val l = current
        if (l.layoutInfo.totalItemsCount > 0 && shown.isNotEmpty()) {
            saved.value = session?.let {
                ChatScroll(it, l.firstVisibleItemIndex, l.firstVisibleItemScrollOffset, shown.size, shown.last().text.length, following).encode()
            }.orEmpty()
        }
    }
    // Stopped, it has saved already, and its state may be stale (a new Hermes session moves the saved position).
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(Unit) { onDispose { if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) save() } }
    LifecycleEventEffect(Lifecycle.Event.ON_STOP) { save() }
    val last = messages.lastOrNull()
    // Follow the conversation while it grows, unless the user scrolled up to read (or had, when they left it).
    var returned by remember(list) { mutableStateOf(restored != null) }
    LaunchedEffect(list, messages.size, last?.text?.length, working) {
        val atEnd = !returned && list.layoutInfo.visibleItemsInfo.lastOrNull()?.index?.let { it >= list.layoutInfo.totalItemsCount - 3 } ?: true
        returned = false
        if (atEnd && list.layoutInfo.totalItemsCount > 0) list.animateScrollToItem(list.layoutInfo.totalItemsCount - 1)
    }
    LazyColumn(Modifier.fillMaxSize().testTag("assistant-messages"), state = list, contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
               verticalArrangement = Arrangement.spacedBy(10.dp)) {
        items(messages, key = { it.id }) { m ->
            when (m.role) {
                "user" -> UserRow(m)
                "assistant" -> if (m.voice) VoiceRow(m) else AssistantRow(m)
                "tool" -> ToolRow(m, onOpen = { onOpen(m) })
                "approval" -> ApprovalRow(m, onAnswer)
                else -> Text(m.text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                             modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp))
            }
        }
        if (working && (last == null || !(last.role == "assistant" && last.streaming && last.text.isNotEmpty()))) {
            item(key = "working") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(10.dp))
                    Text("Hermes is working…", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
private fun UserRow(m: ChatMessage) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Surface(shape = RoundedCornerShape(20.dp, 20.dp, 6.dp, 20.dp), color = MaterialTheme.colorScheme.primaryContainer,
                modifier = Modifier.widthIn(max = 320.dp)) {
            Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.Top) {
                if (m.voice) {
                    Icon(Icons.Rounded.Mic, "Spoken", Modifier.size(16.dp).padding(top = 3.dp), tint = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.7f))
                    Spacer(Modifier.width(6.dp))
                }
                SelectionContainer { Text(m.text, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onPrimaryContainer) }
            }
        }
    }
}

@Composable
private fun AssistantRow(m: ChatMessage) {
    var thinking by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().animateContentSize()) {
        // A call task's reply says which task it answers.
        m.speaker?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        if (m.thinking.isNotBlank()) {
            Text(if (thinking) "Hide thinking" else "Thinking", style = MaterialTheme.typography.labelMedium,
                 color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.clickable { thinking = !thinking }.padding(vertical = 4.dp))
            if (thinking) Text(m.thinking, style = MaterialTheme.typography.bodyMedium.copy(fontStyle = FontStyle.Italic),
                               color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 6.dp))
        }
        if (m.text.isNotBlank()) {
            if (m.failed) {
                Row(verticalAlignment = Alignment.Top) {
                    Icon(Icons.Rounded.Error, null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(18.dp).padding(top = 3.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(m.text, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.error)
                }
            } else SelectionContainer { ChatMarkdownText(m.text.trim()) }
        }
    }
}

/** What was said in a call: Gemini's lines quieter than Hermes's replies. */
@Composable
private fun VoiceRow(m: ChatMessage) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Icon(Icons.Rounded.GraphicEq, null, tint = MaterialTheme.colorScheme.tertiary, modifier = Modifier.size(16.dp).padding(top = 3.dp))
        Spacer(Modifier.width(8.dp))
        Column {
            Text(m.speaker ?: "Gemini", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(m.text.trim(), style = MaterialTheme.typography.bodyMedium.copy(fontStyle = FontStyle.Italic), color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun ToolRow(m: ChatMessage, onOpen: () -> Unit = {}) {
    var open by remember { mutableStateOf(false) }
    Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainerLow,
            modifier = Modifier.fillMaxWidth().clickable { open = !open }) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp).animateContentSize(), verticalAlignment = Alignment.CenterVertically) {
            StatusIcon(m.status)
            Spacer(Modifier.width(10.dp))
            Icon(Icons.Rounded.Build, null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(6.dp))
            Text(
                buildString {
                    append(m.toolName ?: "Tool")
                    m.toolDetail?.takeIf { it.isNotBlank() }?.let { append(" · ").append(it) }
                },
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = if (open) 12 else 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
            )
            // A call task's own Hermes session.
            if (m.link != null) {
                IconButton(onClick = onOpen, modifier = Modifier.size(32.dp)) {
                    Icon(Icons.AutoMirrored.Rounded.OpenInNew, "Open its Hermes session", Modifier.size(18.dp))
                }
            }
        }
    }
}

@Composable
private fun StatusIcon(status: String?) {
    when (status) {
        "running" -> CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
        "waiting" -> Icon(Icons.Rounded.Warning, "Waiting for you", tint = MaterialTheme.colorScheme.tertiary, modifier = Modifier.size(16.dp))
        "failed" -> Icon(Icons.Rounded.Warning, "Failed", tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(16.dp))
        "cancelled" -> Icon(Icons.Rounded.Block, "Cancelled", tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
        else -> Icon(Icons.Rounded.CheckCircle, "Done", tint = MaterialTheme.colorScheme.primary.copy(alpha = 0.8f), modifier = Modifier.size(16.dp))
    }
}

@Composable
private fun ApprovalRow(m: ChatMessage, onAnswer: (String, String) -> Unit) {
    Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.5f), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Hermes wants to run a command", style = MaterialTheme.typography.titleSmall)
            if (m.text.isNotBlank()) Text(m.text, style = MaterialTheme.typography.bodyMedium)
            m.toolDetail?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = SansCode), maxLines = 8, overflow = TextOverflow.Ellipsis)
            }
            when (m.status) {
                "pending" -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    // Hermes keys a streamed turn's approvals by its run, so "session" lasts until this request ends;
                    // "always" would change Hermes's permanent allowlist from a phone tap, so it isn't offered.
                    for (choice in m.choices.filter { it != "always" }) {
                        val label = when (choice) { "once" -> "Allow once"; "session" -> "Allow for this request"; "deny" -> "Deny"; else -> choice }
                        if (choice == "deny") OutlinedButton(onClick = { onAnswer(m.id, choice) }) { Text(label) }
                        else FilledTonalButton(onClick = { onAnswer(m.id, choice) }) { Text(label) }
                    }
                }
                "expired" -> Text("No answer was given.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                else -> Text(if (m.status == "deny") "Denied." else "Allowed.", style = MaterialTheme.typography.bodySmall,
                             color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun ErrorBar(message: String, onDismiss: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth().clickable(onClick = onDismiss)) {
        Text(message, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onErrorContainer,
             modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp))
    }
}

@Composable
private fun Composer(working: Boolean, onSend: (String) -> Unit, onStop: () -> Unit, onCall: () -> Unit) {
    var text by rememberSaveable { mutableStateOf("") }
    Surface(color = MaterialTheme.colorScheme.surface) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.Bottom) {
            TextField(
                text, { text = it },
                placeholder = { Text("Message Hermes") },
                modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("assistant-input"),
                maxLines = 6,
                shape = RoundedCornerShape(24.dp),
                colors = TextFieldDefaults.colors(
                    focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, disabledIndicatorColor = Color.Transparent,
                ),
            )
            Spacer(Modifier.width(8.dp))
            when {
                working -> FilledTonalIconButton(onClick = onStop, modifier = Modifier.size(48.dp)) { Icon(Icons.Rounded.Stop, "Stop") }
                text.isNotBlank() -> FilledIconButton(onClick = { onSend(text); text = "" }, modifier = Modifier.size(48.dp).testTag("assistant-send")) {
                    Icon(Icons.AutoMirrored.Rounded.Send, "Send")
                }
                else -> FilledIconButton(onClick = onCall, modifier = Modifier.size(48.dp).testTag("assistant-call")) { Icon(Icons.Rounded.GraphicEq, "Voice call") }
            }
        }
    }
}

/** The model and reasoning effort Hermes runs this phone's turns on, typed and spoken alike. */
@Composable
private fun ModelPicker(assistant: AssistantController) {
    val prefs = LocalContext.current.graph.prefs
    // Read so a pick recomposes; the controller makes the choice out of them.
    val provider by prefs.hermesModelProvider.flow.collectAsStateWithLifecycle()
    val model by prefs.hermesModel.flow.collectAsStateWithLifecycle()
    val effort by prefs.hermesEffort.flow.collectAsStateWithLifecycle()
    val models by assistant.models.collectAsStateWithLifecycle()
    val choice = remember(provider, model, effort) { assistant.choice }
    var modelMenu by remember { mutableStateOf(false) }
    var effortMenu by remember { mutableStateOf(false) }
    val options = models.options
    Surface(color = MaterialTheme.colorScheme.surface) {
        Row(Modifier.fillMaxWidth().padding(start = 8.dp, end = 8.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f, fill = false)) {
                TextButton(onClick = { assistant.loadModels(); modelMenu = true }, modifier = Modifier.testTag("assistant-model")) {
                    Icon(Icons.Rounded.Memory, null, Modifier.size(16.dp))
                    Spacer(Modifier.width(6.dp))
                    // Two providers can serve a model of the same name: then the label says whose.
                    val shared = options != null && options.providers.count { choice.model in it.models } > 1
                    val label = choice.model?.let { m -> if (shared) "$m · ${options?.providerName(choice.provider) ?: choice.provider}" else m } ?: "Default model"
                    Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelLarge)
                    Icon(Icons.Rounded.ArrowDropDown, null, Modifier.size(18.dp))
                }
                DropdownMenu(expanded = modelMenu, onDismissRequest = { modelMenu = false }, modifier = Modifier.heightIn(max = 480.dp)) {
                    MenuChoice("Hermes's default" + (options?.model?.let { " ($it)" } ?: ""), !choice.picked) {
                        assistant.pickModel(null, null); modelMenu = false
                    }
                    when {
                        options == null && models.loading -> DropdownMenuItem(text = { Text("Loading models…") }, onClick = {}, enabled = false)
                        options == null -> DropdownMenuItem(text = { Text(models.error ?: "Couldn't load Hermes's models. Tap to retry.") },
                                                            onClick = { assistant.loadModels(force = true) })
                    }
                    // A pick Hermes no longer lists stays visible, so it can be seen and replaced.
                    if (choice.picked && options != null && options.providers.none { it.slug == choice.provider && choice.model in it.models }) {
                        MenuChoice("${choice.model} (not offered by Hermes now)", true) { modelMenu = false }
                    }
                    options?.providers?.forEach { p ->
                        HorizontalDivider()
                        Text(p.name, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                             modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
                        for (m in p.models) {
                            MenuChoice(m, choice.provider == p.slug && choice.model == m) { assistant.pickModel(p.slug, m); modelMenu = false }
                        }
                    }
                }
            }
            Box {
                TextButton(onClick = { effortMenu = true }, modifier = Modifier.testTag("assistant-effort")) {
                    Icon(Icons.Rounded.Psychology, null, Modifier.size(16.dp))
                    Spacer(Modifier.width(6.dp))
                    Text(if (choice.effort == null) "Default effort" else HermesChoice.effortLabel(choice.effort) + " effort",
                         maxLines = 1, style = MaterialTheme.typography.labelLarge)
                    Icon(Icons.Rounded.ArrowDropDown, null, Modifier.size(18.dp))
                }
                DropdownMenu(expanded = effortMenu, onDismissRequest = { effortMenu = false }) {
                    MenuChoice("Hermes's default", choice.effort == null) { assistant.pickEffort(null); effortMenu = false }
                    for (e in HermesChoice.EFFORTS) {
                        MenuChoice(HermesChoice.effortLabel(e), choice.effort == e) { assistant.pickEffort(e); effortMenu = false }
                    }
                }
            }
        }
    }
}

@Composable
private fun MenuChoice(label: String, selected: Boolean, onClick: () -> Unit) {
    DropdownMenuItem(text = { Text(label) }, onClick = onClick,
                     trailingIcon = if (selected) ({ Icon(Icons.Rounded.Check, "Selected", Modifier.size(18.dp)) }) else null)
}

@Composable
private fun CallBar(c: CallUi, onMute: () -> Unit, onWake: () -> Unit, onEnd: () -> Unit, onOpenTask: (String) -> Unit, onCancelTask: (String) -> Unit) {
    Surface(color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(horizontal = 20.dp, vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (c.tasks.isNotEmpty()) {
                // One lane per task, newest at the bottom; a long call scrolls rather than pushing the controls off screen.
                Column(Modifier.fillMaxWidth().heightIn(max = 220.dp).verticalScroll(rememberScrollState(), reverseScrolling = true)
                           .testTag("assistant-call-tasks"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (task in c.tasks) TaskLane(task, onOpen = { onOpenTask(task.id) }, onCancel = { onCancelTask(task.id) })
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (c.connecting || c.standby) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                else Icon(Icons.Rounded.GraphicEq, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(10.dp))
                Text(if (c.tapToTalk && !c.connecting && !c.standby && !c.muted) "Talking… tap when you're done" else c.status,
                     style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
                if (c.standby) {
                    // Gemini isn't listening in standby: talking first brings it back.
                    FilledTonalButton(onClick = onWake, modifier = Modifier.heightIn(min = 56.dp).testTag("assistant-wake-call")) {
                        Icon(Icons.Rounded.Mic, null, Modifier.size(20.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Talk now")
                    }
                } else if (c.tapToTalk) {
                    FilledIconButton(onClick = onMute, enabled = !c.connecting, modifier = Modifier.size(72.dp),
                                     colors = if (!c.muted) IconButtonDefaults.filledIconButtonColors(containerColor = MaterialTheme.colorScheme.tertiary) else IconButtonDefaults.filledIconButtonColors()) {
                        Icon(Icons.Rounded.Mic, if (c.muted) "Talk" else "Done talking", Modifier.size(32.dp))
                    }
                } else {
                    FilledTonalIconButton(onClick = onMute, enabled = !c.connecting, modifier = Modifier.size(56.dp)) {
                        Icon(if (c.muted) Icons.Rounded.MicOff else Icons.Rounded.Mic, if (c.muted) "Unmute" else "Mute")
                    }
                }
                // Ends the call and every task still running; each task's lane cancels it alone.
                FilledIconButton(onClick = onEnd, modifier = Modifier.size(56.dp).testTag("assistant-end-call"),
                                 colors = IconButtonDefaults.filledIconButtonColors(containerColor = MaterialTheme.colorScheme.error)) {
                    Icon(Icons.Rounded.CallEnd, "End call", tint = MaterialTheme.colorScheme.onError)
                }
            }
        }
    }
}

/** A call task: its number, what was said, its latest step, and buttons to open its session or cancel it. */
@Composable
private fun TaskLane(task: TaskUi, onOpen: () -> Unit, onCancel: () -> Unit) {
    Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh,
            modifier = Modifier.fillMaxWidth().clickable(onClick = onOpen).testTag("assistant-task-${task.id}")) {
        Row(Modifier.padding(start = 12.dp, end = 4.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            StatusIcon(task.status)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text("Task ${task.id} · ${task.request}", style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                val line = when (task.status) {
                    "running", "waiting" -> task.progress ?: "Hermes is working…"
                    "completed" -> "Done"
                    "cancelled" -> "Cancelled"
                    else -> "Failed"
                }
                Text(line, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                     maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            IconButton(onClick = onOpen, enabled = task.messages.isNotEmpty()) {
                Icon(Icons.AutoMirrored.Rounded.OpenInNew, "Open task ${task.id}'s Hermes session", Modifier.size(20.dp))
            }
            if (task.active) {
                IconButton(onClick = onCancel, modifier = Modifier.testTag("assistant-cancel-task-${task.id}")) {
                    Icon(Icons.Rounded.Close, "Cancel task ${task.id}", Modifier.size(20.dp))
                }
            }
        }
    }
}

/** A call task's own Hermes conversation, live while it runs: its tools, approvals and reply. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TaskSheet(task: TaskUi, onAnswer: (String, String) -> Unit, onCancel: () -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                StatusIcon(task.status)
                Spacer(Modifier.width(10.dp))
                Text("Task ${task.id}", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                if (task.active) OutlinedButton(onClick = onCancel) { Text("Cancel task") }
            }
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = 560.dp), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                       verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(task.messages, key = { it.id }) { m ->
                    when (m.role) {
                        "user" -> UserRow(m)
                        "assistant" -> AssistantRow(m)
                        "tool" -> ToolRow(m)
                        "approval" -> ApprovalRow(m, onAnswer)
                        else -> Text(m.text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HistorySheet(assistant: AssistantController, current: String?, onDismiss: () -> Unit) {
    val history by assistant.history.collectAsStateWithLifecycle()
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Conversations", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                FilledTonalButton(onClick = { assistant.newChat(); onDismiss() }) { Text("New chat") }
            }
            if (history.loading) LinearProgressIndicator(Modifier.fillMaxWidth().padding(horizontal = 24.dp))
            history.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(24.dp)) }
            if (!history.loading && history.error == null && history.items.isEmpty()) {
                Text("Conversations you start here appear in this list.", color = MaterialTheme.colorScheme.onSurfaceVariant,
                     modifier = Modifier.padding(24.dp))
            }
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = 520.dp)) {
                items(history.items, key = { it.id }) { s -> HistoryRow(s, s.id == current, onOpen = { assistant.open(s.id); onDismiss() }, onDelete = { assistant.delete(s.id) }) }
            }
        }
    }
}

@Composable
private fun HistoryRow(s: HermesSession, selected: Boolean, onOpen: () -> Unit, onDelete: () -> Unit) {
    var confirm by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(start = 24.dp, end = 8.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(36.dp).clip(CircleShape), contentAlignment = Alignment.Center) {
            Icon(Icons.AutoMirrored.Rounded.Chat, null, tint = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(s.label, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val time = (s.lastActive ?: s.startedAt)?.let { DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date((it * 1000).toLong())) }
            Text(listOfNotNull(time, s.messageCount?.let { "$it messages" }).joinToString(" · "),
                 style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (confirm) {
            androidx.compose.material3.TextButton(onClick = { confirm = false; onDelete() }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
        } else IconButton(onClick = { confirm = true }) { Icon(Icons.Rounded.Delete, "Delete", tint = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}
