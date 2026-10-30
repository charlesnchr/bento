package com.charles.bento.ui.settings

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.CloudOff
import androidx.compose.material.icons.rounded.Key
import androidx.compose.material.icons.rounded.QrCodeScanner
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.charles.bento.core.assistant.HermesEndpoint
import com.charles.bento.core.assistant.HermesError
import com.charles.bento.core.assistant.HermesLink
import com.charles.bento.graph
import kotlinx.coroutines.launch

/** Settings → Hermes: where the Assistant finds Hermes's API server, its key, and how calls listen. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HermesSection(context: Context) {
    val graph = context.graph
    val prefs = graph.prefs
    val url by prefs.hermesUrl.flow.collectAsStateWithLifecycle()
    val name by prefs.hermesName.flow.collectAsStateWithLifecycle()
    val talk by prefs.hermesTalkMode.flow.collectAsStateWithLifecycle()
    val standby by prefs.hermesStandbySeconds.flow.collectAsStateWithLifecycle()
    val secretsVersion by graph.secrets.version.collectAsStateWithLifecycle()
    val configured = remember(url, secretsVersion) { graph.assistant.configured }
    var edit by remember { mutableStateOf(false) }
    var pending by remember { mutableStateOf<HermesLink?>(null) }
    var check by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    SettingsSection(
        "Hermes",
        footer = "The Assistant tab talks to Hermes's API server on your tailnet (keep it off the public internet). " +
            "Voice calls run on Gemini Live with your Gemini API key, and Hermes does the work.",
    ) {
        if (configured) {
            SettingsRow("Connected to ${name.ifBlank { "Hermes" }}", HermesEndpoint.parseUrl(url)?.toString()?.trimEnd('/') ?: url,
                        Icons.Rounded.AutoAwesome, iconTint = MaterialTheme.colorScheme.primary, onClick = { edit = true })
            SettingsRow("Test connection", check ?: "Checks the server and the key", Icons.Rounded.Refresh, onClick = {
                check = "Checking…"
                scope.launch {
                    check = try { "${graph.assistant.client.check()} answered" } catch (e: HermesError) { e.message }
                }
            })
        } else {
            SettingsRow("Scan Hermes code", "A bento://hermes code from Hermes's machine", Icons.Rounded.QrCodeScanner,
                        iconTint = MaterialTheme.colorScheme.primary, onClick = { scanHermesCode(context) { pending = it } })
            SettingsRow("Enter server and key", icon = Icons.Rounded.Key, onClick = { edit = true })
        }
        SettingsRow("Voice calls")
        val modes = listOf("continuous" to "Open mic", "tap" to "Tap to talk")
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 12.dp)) {
            modes.forEachIndexed { i, (id, label) ->
                SegmentedButton(selected = talk == id, onClick = { prefs.hermesTalkMode.value = id },
                                shape = SegmentedButtonDefaults.itemShape(i, modes.size)) { Text(label) }
            }
        }
        SettingsRow("Pause Gemini while Hermes works",
                    "After this long without speech the call leaves Gemini, which bills by the second, and reconnects to speak Hermes's answer")
        val waits = listOf(0 to "Never", 10 to "10 s", 20 to "20 s", 30 to "30 s", 60 to "1 min")
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 12.dp)) {
            waits.forEachIndexed { i, (seconds, label) ->
                SegmentedButton(selected = standby == seconds, onClick = { prefs.hermesStandbySeconds.value = seconds },
                                shape = SegmentedButtonDefaults.itemShape(i, waits.size)) { Text(label, maxLines = 1) }
            }
        }
        if (configured) {
            SettingsRow("Scan a new code", icon = Icons.Rounded.QrCodeScanner, onClick = { scanHermesCode(context) { pending = it } })
            SettingsRow("Disconnect", "Ends a call in progress. Conversations stay in Hermes", Icons.Rounded.CloudOff, onClick = {
                graph.assistant.leaveServer(switching = false)
                graph.secrets.hermesToken = null
                prefs.hermesName.value = ""
                check = null
            })
        }
    }

    pending?.let { link -> HermesLinkDialog(link) { pending = null } }
    if (edit) {
        var u by remember { mutableStateOf(url) }
        var t by remember { mutableStateOf("") }
        val valid = HermesEndpoint.parseUrl(u) != null && (t.isNotBlank() || graph.secrets.hermesToken != null)
        val problem = HermesEndpoint.problem(u)
        AlertDialog(
            onDismissRequest = { edit = false },
            title = { Text("Hermes API server") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(u, { u = it }, label = { Text("Server") }, placeholder = { Text("100.88.250.122:8642") }, singleLine = true,
                                      isError = problem != null,
                                      supportingText = { Text(problem ?: "Its tailnet address and port, or an https:// address") },
                                      keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
                    OutlinedTextField(t, { t = it }, label = { Text(if (graph.secrets.hermesToken != null) "Key (unchanged if empty)" else "Key") },
                                      singleLine = true, visualTransformation = PasswordVisualTransformation(),
                                      supportingText = { Text("API_SERVER_KEY from Hermes's .env") },
                                      keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
                }
            },
            confirmButton = {
                TextButton(enabled = valid, onClick = {
                    switchServer(context, u.trim())
                    prefs.hermesUrl.value = u.trim()
                    if (t.isNotBlank()) graph.secrets.hermesToken = t.trim()
                    check = null
                    edit = false
                }) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { edit = false }) { Text("Cancel") } },
        )
    }
}

/** Confirms a `bento://hermes` link or code before the phone uses it. */
@Composable
fun HermesLinkDialog(link: HermesLink, onDone: () -> Unit) {
    val context = LocalContext.current
    val graph = context.graph
    // The link comes from whoever made it: show exactly where it points, and keep its name short and plain.
    val where = HermesEndpoint.parseUrl(link.url)?.toString()?.trimEnd('/') ?: link.url
    val name = displayName(link.name)
    val current = graph.assistant.endpoint()?.url?.toString()?.trimEnd('/')
    AlertDialog(
        onDismissRequest = onDone,
        title = { Text(if (name.isEmpty()) "Connect to Hermes?" else "Connect to Hermes on “$name”?") },
        text = {
            Text("The Assistant will chat with Hermes at $where." +
                 (current?.let { "\n\nThis replaces your connection to $it" + (if (graph.assistant.callActive) " and ends the call in progress." else ".") } ?: "") +
                 "\n\nHermes acts with your permissions, so only use a code you made on your own machine.")
        },
        confirmButton = {
            TextButton(onClick = {
                switchServer(context, link.url)
                graph.prefs.hermesUrl.value = link.url
                graph.prefs.hermesName.value = name
                graph.secrets.hermesToken = link.token
                onDone()
            }) { Text("Connect") }
        },
        dismissButton = { TextButton(onClick = onDone) { Text("Cancel") } },
    )
}

fun scanHermesCode(context: Context, onResult: (HermesLink) -> Unit) =
    scanCode(context, HermesLink::parse, "That's not a Bento Hermes code", onResult)

/**
 * Before the address or key changes: the call and any turn end, and another server's
 * conversations aren't this one's, so the Assistant starts over.
 */
private fun switchServer(context: Context, url: String) {
    val graph = context.graph
    graph.assistant.leaveServer(switching = serverOf(graph.prefs.hermesUrl.value) != serverOf(url))
}

/** A link's `name`, as shown: printable characters only, one line, at most 40 of them. */
internal fun displayName(name: String): String {
    val plain = name.replace(Regex("\\s+"), " ")
        .filter { !it.isISOControl() && Character.getType(it) != Character.FORMAT.toInt() }
        .replace(Regex(" +"), " ").trim()
    return if (plain.length > 40) plain.take(39).trimEnd() + "…" else plain
}

private fun serverOf(url: String) = HermesEndpoint.parseUrl(url)?.toString()
