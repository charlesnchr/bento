package com.charles.bento.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Star
import androidx.compose.material.icons.rounded.StarBorder
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavController
import com.charles.bento.core.voicesync.DictionaryEntry
import com.charles.bento.core.voicesync.VoiceMode
import com.charles.bento.graph
import com.charles.bento.voice.VoiceSyncModule
import kotlinx.coroutines.launch

/** Cleanup on/off and custom instructions: synced with the Macs through the `voice` collection. */
@Composable
fun VoiceSyncedSettings() {
    val graph = LocalContext.current.graph
    val docs by graph.voiceSync.docs.collectAsStateWithLifecycle()
    val settings = remember(docs) { VoiceSyncModule.settings(docs) }
    val scope = rememberCoroutineScope()
    var editing by remember { mutableStateOf(false) }
    SwitchRow("Clean up the text", settings.cleanupEnabled, "Punctuation, filler words, your dictionary and instructions (synced with your Macs)") { on ->
        scope.launch { graph.voiceSync.perform { setCleanupEnabled(on) } }
    }
    SettingsRow(
        "Custom instructions",
        if (settings.customInstructionsEnabled && settings.customInstructions.isNotBlank()) settings.customInstructions.lines().first().take(80)
        else "Off",
        onClick = { editing = true },
    )
    if (editing) {
        var text by remember { mutableStateOf(settings.customInstructions) }
        var on by remember { mutableStateOf(settings.customInstructionsEnabled) }
        AlertDialog(
            onDismissRequest = { editing = false },
            title = { Text("Custom instructions") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Use them", modifier = Modifier.weight(1f))
                        Switch(on, { on = it })
                    }
                    OutlinedTextField(text, { text = it }, modifier = Modifier.fillMaxWidth(), minLines = 5, maxLines = 10,
                                      placeholder = { Text("e.g. British spelling. Never use em dashes.") })
                    Text("Shared with your Macs.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    scope.launch {
                        graph.voiceSync.perform {
                            if (text != settings.customInstructions) setCustomInstructions(text)
                            if (on != settings.customInstructionsEnabled) setCustomInstructionsEnabled(on)
                        }
                    }
                    editing = false
                }) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { editing = false }) { Text("Cancel") } },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DictionaryScreen(nav: NavController) {
    val graph = LocalContext.current.graph
    val docs by graph.voiceSync.docs.collectAsStateWithLifecycle()
    val entries = remember(docs) { VoiceSyncModule.dictionary(docs) }
    val scope = rememberCoroutineScope()
    var editing by remember { mutableStateOf<DictionaryEntry?>(null) }
    var adding by remember { mutableStateOf(false) }
    Scaffold(
        topBar = {
            TopAppBar(title = { Text("Dictionary") },
                      navigationIcon = { IconButton(onClick = { nav.popBackStack() }) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Back") } })
        },
        floatingActionButton = { FloatingActionButton(onClick = { adding = true }) { Icon(Icons.Rounded.Add, "Add a word") } },
    ) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding)) {
            item {
                Text("Names and terms the transcription should spell your way. A misspelling becomes a rule that always replaces it. Synced with your Macs.",
                     style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                     modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
            }
            items(entries, key = { it.id }) { e ->
                Row(Modifier.fillMaxWidth().clickable { editing = e }.padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = { scope.launch { graph.voiceSync.perform { toggleStar(e.id) } } }) {
                        Icon(if (e.starred) Icons.Rounded.Star else Icons.Rounded.StarBorder, "Star",
                             tint = if (e.starred) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Spacer(Modifier.width(4.dp))
                    Column(Modifier.weight(1f)) {
                        Text(e.term, style = MaterialTheme.typography.bodyLarge)
                        e.misspelling?.let { Text("“$it” → ${e.term}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                    IconButton(onClick = { scope.launch { graph.voiceSync.perform { removeEntry(e.id) } } }) { Icon(Icons.Rounded.Delete, "Remove") }
                }
                HorizontalDivider(Modifier.padding(start = 64.dp))
            }
        }
    }
    if (adding || editing != null) {
        val e = editing
        var term by remember(e) { mutableStateOf(e?.term ?: "") }
        var miss by remember(e) { mutableStateOf(e?.misspelling ?: "") }
        AlertDialog(
            onDismissRequest = { adding = false; editing = null },
            title = { Text(if (e == null) "Add a word" else "Edit") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(term, { term = it.take(60) }, singleLine = true, label = { Text("Correct spelling") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(miss, { miss = it }, singleLine = true, label = { Text("Heard as") }, modifier = Modifier.fillMaxWidth(),
                                      supportingText = { Text("Optional: a misspelling to always replace") })
                }
            },
            confirmButton = {
                TextButton(enabled = term.isNotBlank(), onClick = {
                    val t = term
                    val m = miss.ifBlank { null }
                    scope.launch {
                        graph.voiceSync.perform {
                            if (e == null) addEntry(t, m) else { setTerm(e.id, t); setMisspelling(e.id, m) }
                        }
                    }
                    adding = false; editing = null
                }) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { adding = false; editing = null }) { Text("Cancel") } },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ModesScreen(nav: NavController) {
    val graph = LocalContext.current.graph
    val docs by graph.voiceSync.docs.collectAsStateWithLifecycle()
    val modes = remember(docs) { VoiceSyncModule.modes(docs) }
    val active by graph.prefs.activeMode.flow.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var editing by remember { mutableStateOf<VoiceMode?>(null) }
    var adding by remember { mutableStateOf(false) }
    Scaffold(
        topBar = {
            TopAppBar(title = { Text("Modes") },
                      navigationIcon = { IconButton(onClick = { nav.popBackStack() }) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Back") } })
        },
        floatingActionButton = { FloatingActionButton(onClick = { adding = true }) { Icon(Icons.Rounded.Add, "Add a mode") } },
    ) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding)) {
            item {
                Text("A mode adds its own instructions to the cleanup (“Email: friendly but brief”, “Notes: bullet points”). " +
                     "Switch with the chip on the bubble or the keyboard, even while talking.",
                     style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                     modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
            }
            item {
                SettingsRow("Default", "Your custom instructions only", onClick = { graph.prefs.activeMode.value = "" }, iconColumn = false,
                            trailing = { if (active.isEmpty()) Text("Active", color = MaterialTheme.colorScheme.primary) })
            }
            items(modes, key = { it.id }) { m ->
                SettingsRow(m.name, m.prompt.lines().firstOrNull()?.take(80), onClick = { editing = m }, iconColumn = false, trailing = {
                    if (active == m.id) Text("Active", color = MaterialTheme.colorScheme.primary)
                    else TextButton(onClick = { graph.prefs.activeMode.value = m.id }) { Text("Use") }
                })
            }
        }
    }
    if (adding || editing != null) {
        val m = editing
        var name by remember(m) { mutableStateOf(m?.name ?: "") }
        var prompt by remember(m) { mutableStateOf(m?.prompt ?: "") }
        var language by remember(m) { mutableStateOf(m?.language ?: "") }
        var cleanup by remember(m) { mutableStateOf(m?.cleanup ?: true) }
        AlertDialog(
            onDismissRequest = { adding = false; editing = null },
            title = { Text(if (m == null) "New mode" else "Edit mode") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(name, { name = it }, singleLine = true, label = { Text("Name") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(prompt, { prompt = it }, label = { Text("Instructions") }, placeholder = { Text("e.g. Friendly but brief. Bullet points.") },
                                      minLines = 4, maxLines = 8, modifier = Modifier.fillMaxWidth())
                    // the hint below the field: as a label it was cut off
                    OutlinedTextField(language, { language = it }, singleLine = true, label = { Text("Language") },
                                      placeholder = { Text("Automatic") }, supportingText = { Text("A code like da or en-GB; empty for automatic") },
                                      modifier = Modifier.fillMaxWidth())
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Clean up", modifier = Modifier.weight(1f))
                        Switch(cleanup, { cleanup = it })
                    }
                    if (m != null) TextButton(onClick = {
                        scope.launch { graph.voiceSync.perform { deleteMode(m.id) } }
                        if (graph.prefs.activeMode.value == m.id) graph.prefs.activeMode.value = ""
                        editing = null
                    }) { Text("Delete mode", color = MaterialTheme.colorScheme.error) }
                }
            },
            confirmButton = {
                TextButton(enabled = name.isNotBlank(), onClick = {
                    val lang = language.trim().ifEmpty { null }
                    scope.launch {
                        graph.voiceSync.perform {
                            if (m == null) addMode(name.trim(), prompt, lang, cleanup)
                            else updateMode(m.id, name.trim(), prompt, language.trim(), cleanup) // "" clears it (automatic)
                        }
                    }
                    adding = false; editing = null
                }) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { adding = false; editing = null }) { Text("Cancel") } },
        )
    }
}
