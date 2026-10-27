package com.charles.bento.ui.settings

import android.Manifest
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.BatteryChargingFull
import androidx.compose.material.icons.rounded.Bolt
import androidx.compose.material.icons.rounded.Cloud
import androidx.compose.material.icons.rounded.CloudOff
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.Keyboard
import androidx.compose.material.icons.rounded.Key
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.Notifications
import androidx.compose.material.icons.rounded.Palette
import androidx.compose.material.icons.rounded.QrCodeScanner
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.SettingsAccessibility
import androidx.compose.material.icons.rounded.SystemUpdate
import androidx.compose.material.icons.rounded.Widgets
import androidx.compose.material.icons.rounded.TouchApp
import androidx.compose.material.icons.automirrored.rounded.VolumeDown
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavController
import com.charles.bento.BuildConfig
import com.charles.bento.core.sync.SyncState
import com.charles.bento.graph
import com.charles.bento.settings.Pairing
import com.charles.bento.ui.DictionaryRoute
import com.charles.bento.ui.ModesRoute
import com.charles.bento.update.Updater
import com.charles.bento.voice.BentoAccessibilityService
import com.google.android.gms.common.moduleinstall.ModuleInstall
import com.google.android.gms.common.moduleinstall.ModuleInstallRequest
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(nav: NavController) {
    val context = LocalContext.current
    val graph = context.graph
    val prefs = graph.prefs
    var tick by remember { mutableIntStateOf(0) } // re-read system state when we come back from Settings
    LifecycleResumeEffect(Unit) { tick++; onPauseOrDispose { } }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = { IconButton(onClick = { nav.popBackStack() }) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Back") } },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).navigationBarsPadding()) {
            SyncSection(context)
            DictationSection(context, nav)
            TriggersSection(context, tick)
            SetupSection(context, tick)
            AppearanceSection(context)
            UpdatesSection(context)
            Text(
                "Bento ${BuildConfig.VERSION_NAME} · MIT licensed · Google Sans Flex and Code under the SIL OFL · earcons from Jot (Apache 2.0)",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(24.dp),
            )
        }
    }
}

@Composable
private fun SyncSection(context: Context) {
    val graph = context.graph
    val prefs = graph.prefs
    val server by prefs.server.flow.collectAsStateWithLifecycle()
    val pairedWith by prefs.pairedWith.flow.collectAsStateWithLifecycle()
    val deviceName by prefs.deviceName.flow.collectAsStateWithLifecycle()
    val secretsVersion by graph.secrets.version.collectAsStateWithLifecycle()
    var manual by remember { mutableStateOf(false) }
    var rename by remember { mutableStateOf(false) }
    var pendingPair by remember { mutableStateOf<Pairing?>(null) }
    val paired = server.isNotBlank() && remember(secretsVersion) { graph.secrets.syncToken } != null

    SettingsSection(
        "Sync",
        footer = if (paired) null else "On your Mac: Bento Settings → Notes → Pair Android Phone, then scan the code. " +
            "Notes, tasks, the dictionary and instructions sync through your bento-sync server.",
    ) {
        if (paired) {
            SettingsRow("Paired with ${pairedWith.ifBlank { "your Mac" }}", server, Icons.Rounded.Cloud, iconTint = MaterialTheme.colorScheme.primary)
            listOf("notes" to "Notes", "todos" to "Tasks", "voice" to "Dictionary").forEach { (col, label) ->
                val status = graph.sync.status(col)?.collectAsStateWithLifecycle()?.value
                if (status != null) {
                    val noun = when (col) { "notes" -> "note"; "todos" -> "task"; else -> "entry" }
                    SettingsRow(label, status.summary(noun) + (status.lastError?.takeIf { status.state != SyncState.Connected }?.let { " · $it" } ?: ""))
                }
            }
            SettingsRow("Sync now", icon = Icons.Rounded.Refresh, onClick = { graph.sync.syncNow() })
            SettingsRow("This phone's name", deviceName, Icons.Rounded.Edit, onClick = { rename = true })
            SettingsRow("Pair again", "Scan a new code from your Mac", Icons.Rounded.QrCodeScanner, onClick = { scanPairingCode(context) { pendingPair = it } })
            SettingsRow("Unpair", "Notes and tasks stay on this phone", Icons.Rounded.CloudOff, onClick = {
                prefs.server.value = ""
                prefs.pairedWith.value = ""
                graph.secrets.syncToken = null
            })
        } else {
            SettingsRow("Scan pairing code", "From Bento on your Mac", Icons.Rounded.QrCodeScanner, iconTint = MaterialTheme.colorScheme.primary,
                        onClick = { scanPairingCode(context) { pendingPair = it } })
            SettingsRow("Enter server and token", icon = Icons.Rounded.Key, onClick = { manual = true })
        }
    }

    pendingPair?.let { p -> PairingDialog(p) { pendingPair = null } }
    if (manual) {
        var s by remember { mutableStateOf(server) }
        var t by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { manual = false },
            title = { Text("Sync server") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(s, { s = it }, label = { Text("Server") }, placeholder = { Text("sync.example.com") }, singleLine = true)
                    OutlinedTextField(t, { t = it }, label = { Text("Token") }, singleLine = true, visualTransformation = PasswordVisualTransformation())
                }
            },
            confirmButton = {
                TextButton(enabled = s.isNotBlank() && t.isNotBlank(), onClick = {
                    pendingPair = Pairing(s.trim(), t.trim(), "", null)
                    manual = false
                }) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { manual = false }) { Text("Cancel") } },
        )
    }
    if (rename) {
        var n by remember { mutableStateOf(deviceName) }
        AlertDialog(
            onDismissRequest = { rename = false },
            title = { Text("This phone's name") },
            text = { OutlinedTextField(n, { n = it }, singleLine = true, supportingText = { Text("Shown in conflicted copies on your Macs") }) },
            confirmButton = { TextButton(onClick = { if (n.isNotBlank()) prefs.deviceName.value = n.trim(); rename = false }) { Text("Save") } },
            dismissButton = { TextButton(onClick = { rename = false }) { Text("Cancel") } },
        )
    }
}

/** Google's code scanner: no camera permission, downloaded once by Play services. */
fun scanPairingCode(context: Context, onResult: (Pairing) -> Unit) {
    val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).enableAutoZoom().build()
    val scanner = GmsBarcodeScanning.getClient(context, options)
    ModuleInstall.getClient(context).installModules(ModuleInstallRequest.newBuilder().addApi(scanner).build())
    scanner.startScan()
        .addOnSuccessListener { code ->
            val p = code.rawValue?.let(Pairing::parse)
            if (p != null) onResult(p) else Toast.makeText(context, "That's not a Bento pairing code", Toast.LENGTH_LONG).show()
        }
        .addOnFailureListener { Toast.makeText(context, "Scanner unavailable: ${it.message}", Toast.LENGTH_LONG).show() }
}

@Composable
private fun DictationSection(context: Context, nav: NavController) {
    val graph = context.graph
    val prefs = graph.prefs
    val live by prefs.liveTranscription.flow.collectAsStateWithLifecycle()
    val model by prefs.cleanupModel.flow.collectAsStateWithLifecycle()
    val secretsVersion by graph.secrets.version.collectAsStateWithLifecycle()
    val hasKey = remember(secretsVersion) { graph.secrets.geminiKey != null }
    var editKey by remember { mutableStateOf(false) }
    var pickModel by remember { mutableStateOf(false) }

    SettingsSection("Dictation", footer = "Gemini Transcribe through your own API key, as on the Mac: the live transcript while you talk, a cleanup pass when you stop.") {
        SettingsRow("Gemini API key", if (hasKey) "Set" else "Not set: dictation and meetings need it", Icons.Rounded.Key,
                    iconTint = if (hasKey) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error, onClick = { editKey = true })
        SwitchRow("Live transcript", live, "Show and use Gemini Live's transcript while you talk") { prefs.liveTranscription.value = it }
        val tone by prefs.toneMatching.flow.collectAsStateWithLifecycle()
        SwitchRow("Match the app's tone", tone, "Cleanup writes like the app you're in (chat, email, notes), using the field and the text before the cursor as context") {
            prefs.toneMatching.value = it
        }
        VoiceSyncedSettings()
        SettingsRow("Cleanup model", CLEANUP_MODELS.firstOrNull { it.first == model }?.second ?: model, onClick = { pickModel = true })
        SettingsRow("Dictionary", "Names and terms, synced with your Macs", onClick = { nav.navigate(DictionaryRoute) })
        SettingsRow("Modes", "Profiles with their own instructions (switch while talking)", onClick = { nav.navigate(ModesRoute) })
    }

    if (editKey) {
        var k by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { editKey = false },
            title = { Text("Gemini API key") },
            text = {
                OutlinedTextField(k, { k = it }, singleLine = true, label = { Text(if (hasKey) "Replace key" else "Key") },
                                  visualTransformation = PasswordVisualTransformation(),
                                  keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
            },
            confirmButton = { TextButton(enabled = k.isNotBlank(), onClick = { graph.secrets.geminiKey = k; editKey = false }) { Text("Save") } },
            dismissButton = {
                Row {
                    if (hasKey) TextButton(onClick = { graph.secrets.geminiKey = null; editKey = false }) { Text("Remove") }
                    TextButton(onClick = { editKey = false }) { Text("Cancel") }
                }
            },
        )
    }
    if (pickModel) {
        AlertDialog(
            onDismissRequest = { pickModel = false },
            title = { Text("Cleanup model") },
            text = {
                Column {
                    CLEANUP_MODELS.forEach { (id, name) ->
                        SettingsRow(name, id, onClick = { prefs.cleanupModel.value = id; pickModel = false })
                    }
                }
            },
            confirmButton = { TextButton(onClick = { pickModel = false }) { Text("Close") } },
        )
    }
}

/** The cleanup models (CleanupModels.swift, ported). */
val CLEANUP_MODELS: List<Pair<String, String>> = com.charles.bento.core.voice.gemini.CleanupModels.builtIn.map { it.id to it.name }

@Composable
private fun TriggersSection(context: Context, tick: Int) {
    val prefs = context.graph.prefs
    val bubble by prefs.bubbleEnabled.flow.collectAsStateWithLifecycle()
    val size by prefs.bubbleSize.flow.collectAsStateWithLifecycle()
    val hold by prefs.volumeHold.flow.collectAsStateWithLifecycle()
    val holdKey by prefs.holdKey.flow.collectAsStateWithLifecycle()
    val holdMs by prefs.holdMillis.flow.collectAsStateWithLifecycle()
    val haptics by prefs.haptics.flow.collectAsStateWithLifecycle()
    val sounds by prefs.sounds.flow.collectAsStateWithLifecycle()
    val icons by prefs.separateIcons.flow.collectAsStateWithLifecycle()
    var learning by remember { mutableStateOf(false) }
    val a11y = remember(tick) { Setup.accessibilityEnabled(context) }

    SettingsSection(
        "Ways to dictate",
        footer = "The bubble and the held key work in any app, beside your usual keyboard. " +
            "To use the Find X9 Pro's Snap Key, turn on separate icons and choose “Bento Dictate” as the app it opens.",
    ) {
        SwitchRow("Floating bubble", bubble, "Beside the keyboard when a text field is focused. Tap to talk, hold for push-to-talk, drag to the bottom edge to hide it in that app",
                  Icons.Rounded.TouchApp, enabled = a11y) { prefs.bubbleEnabled.value = it }
        if (bubble && a11y) SliderRow("Bubble size", size.toFloat(), 40f..72f, "$size dp") { prefs.bubbleSize.value = it.toInt() }
        SwitchRow("Hold ${keyName(holdKey)} to talk", hold, "Over a text field; a short press still changes the volume",
                  Icons.AutoMirrored.Rounded.VolumeDown, enabled = a11y) { prefs.volumeHold.value = it }
        if (hold && a11y) {
            SliderRow("Hold for", holdMs.toFloat(), 150f..700f, "$holdMs ms") { prefs.holdMillis.value = it.toInt() }
            SettingsRow("Use another key", if (learning) "Press the key now…" else "Any key the accessibility service can see", onClick = {
                learning = true
                BentoAccessibilityService.keyLearner = { code -> prefs.holdKey.value = code; learning = false }
            })
        }
        SettingsRow(
            "Bento keyboard", if (Setup.keyboardSelected(context)) "In use" else if (Setup.keyboardEnabled(context)) "Enabled: switch with the keyboard key" else "A voice-first keyboard, for fields the bubble can't reach",
            Icons.Rounded.Keyboard,
            onClick = { if (Setup.keyboardEnabled(context)) Setup.pickKeyboard(context) else Setup.openKeyboards(context) },
        )
        SettingsRow("Quick Settings tile", "Capture a thought into a note, even from the lock screen", Icons.Rounded.Bolt,
                    onClick = { Setup.requestTile(context) {} })
        SettingsRow("Home screen widgets", "Notes, tasks and a capture button", Icons.Rounded.Widgets, onClick = { requestWidget(context) })
        SwitchRow("Separate icons for shortcuts", icons, "Adds “Bento Dictate”, “Bento Meeting” and “Bento Quick Add” to the app list (for the Snap Key)") {
            prefs.separateIcons.value = it
            setSeparateIcons(context, it)
        }
        SwitchRow("Haptics", haptics) { prefs.haptics.value = it }
        SwitchRow("Sounds", sounds) { prefs.sounds.value = it }
    }
}

fun keyName(code: Int) = when (code) {
    25 -> "Volume Down"
    24 -> "Volume Up"
    else -> android.view.KeyEvent.keyCodeToString(code).removePrefix("KEYCODE_").lowercase().replace('_', ' ').replaceFirstChar(Char::uppercase)
}

fun setSeparateIcons(context: Context, on: Boolean) {
    val pm = context.packageManager
    listOf("DictateLauncher", "MeetingLauncher", "QuickAddLauncher").forEach { alias ->
        pm.setComponentEnabledSetting(
            ComponentName(context.packageName, "com.charles.bento.$alias"),
            if (on) PackageManager.COMPONENT_ENABLED_STATE_ENABLED else PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
            PackageManager.DONT_KILL_APP,
        )
    }
}

private fun requestWidget(context: Context) {
    val awm = AppWidgetManager.getInstance(context)
    val provider = ComponentName(context.packageName, "com.charles.bento.widget.NotesWidgetReceiver")
    if (!awm.isRequestPinAppWidgetSupported || !awm.requestPinAppWidget(provider, null, null)) {
        Toast.makeText(context, "Long-press the home screen → Widgets → Bento", Toast.LENGTH_LONG).show()
    }
}

@Composable
private fun SetupSection(context: Context, tick: Int) {
    val mic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    val notifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    val hasMic = remember(tick) { Setup.hasMic(context) }
    val a11y = remember(tick) { Setup.accessibilityEnabled(context) }
    val notif = remember(tick) { Setup.hasNotifications(context) }
    val battery = remember(tick) { Setup.ignoringBatteryOptimizations(context) }
    fun state(ok: Boolean) = if (ok) "On" else "Off: tap to turn on"
    SettingsSection(
        "Permissions",
        footer = "ColorOS stops apps it thinks are idle. Allowing background activity keeps live sync and the bubble reliable. " +
            "If the accessibility switch is greyed out, open App info → ⋮ → Allow restricted settings first (Android does this for apps installed outside the Play Store).",
    ) {
        SettingsRow("Microphone", state(hasMic), Icons.Rounded.Mic, onClick = { mic.launch(Manifest.permission.RECORD_AUDIO) })
        SettingsRow("Accessibility service", if (a11y) "On" else "Off: needed for the bubble and the held key", Icons.Rounded.SettingsAccessibility,
                    onClick = { Setup.openAccessibility(context) })
        if (!a11y) SettingsRow("App info", "Allow restricted settings, battery", onClick = { Setup.openAppInfo(context) })
        SettingsRow("Notifications", state(notif), Icons.Rounded.Notifications,
                    onClick = { if (android.os.Build.VERSION.SDK_INT >= 33) notifications.launch(Manifest.permission.POST_NOTIFICATIONS) })
        SettingsRow("Background activity", if (battery) "Allowed" else "Restricted: tap to allow", Icons.Rounded.BatteryChargingFull,
                    onClick = { Setup.requestBatteryExemption(context) })
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AppearanceSection(context: Context) {
    val prefs = context.graph.prefs
    val theme by prefs.theme.flow.collectAsStateWithLifecycle()
    SettingsSection("Appearance") {
        SettingsRow("Theme", icon = Icons.Rounded.Palette)
        val options = listOf("system" to "Standard", "graphite" to "Graphite", "paper" to "Paper")
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
            options.forEachIndexed { i, (id, label) ->
                SegmentedButton(selected = theme == id, onClick = { prefs.theme.value = id },
                                shape = SegmentedButtonDefaults.itemShape(i, options.size)) { Text(label) }
            }
        }
        Spacer(Modifier.height(8.dp))
    }
}

@Composable
private fun UpdatesSection(context: Context) {
    val graph = context.graph
    val state by graph.updater.state.collectAsStateWithLifecycle()
    val auto by graph.prefs.autoUpdateCheck.flow.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    SettingsSection("Updates") {
        when (val s = state) {
            is Updater.State.Available -> SettingsRow("Install Bento ${s.release.version}", "Downloads from GitHub and restarts Bento",
                                                      Icons.Rounded.SystemUpdate, iconTint = MaterialTheme.colorScheme.primary,
                                                      onClick = { scope.launch { graph.updater.install(s.release) } })
            is Updater.State.Downloading -> Column(Modifier.padding(16.dp)) {
                Text("Downloading ${s.release.version}…")
                LinearProgressIndicator(progress = { s.progress }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
            }
            is Updater.State.Installing -> SettingsRow("Installing ${s.release.version}…")
            else -> SettingsRow(
                "Check for updates",
                when (s) {
                    Updater.State.Checking -> "Checking…"
                    Updater.State.UpToDate -> "Bento ${BuildConfig.VERSION_NAME} is the latest"
                    is Updater.State.Failed -> s.message
                    else -> "Bento ${BuildConfig.VERSION_NAME}"
                },
                Icons.Rounded.SystemUpdate,
                onClick = { scope.launch { graph.updater.check() } },
            )
        }
        SwitchRow("Check daily", auto) { graph.prefs.autoUpdateCheck.value = it }
    }
}
