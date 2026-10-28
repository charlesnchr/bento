package com.charles.bento.ui.settings

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.charles.bento.graph
import com.charles.bento.settings.Pairing
import com.charles.bento.settings.save
import com.charles.bento.settings.serverKey

/**
 * Confirms a pairing. Re-pairing with the same server (a new token) keeps everything; a
 * different server starts fresh, because this phone's sync state describes the old one.
 */
@Composable
fun PairingDialog(p: Pairing, fromLink: Boolean = false, onDone: () -> Unit) {
    val context = LocalContext.current
    val graph = context.graph
    // the server the documents on this phone came from, even after unpairing
    val current = graph.prefs.syncedServer.value.trimEnd('/')
    val switching = current.isNotBlank() && current != serverKey(p.server)
    AlertDialog(
        onDismissRequest = onDone,
        title = { Text("Pair with ${p.macName.ifBlank { "this Mac" }}?") },
        text = {
            Text(
                (if (switching) {
                    "This phone syncs with $current. Switching to ${p.server} starts fresh: Bento restarts, and notes and tasks " +
                        "that only exist on this phone are removed. Everything on the new server comes down."
                } else {
                    "Notes, tasks and your dictionary sync with ${p.server}."
                }) +
                    (if (p.geminiKey != null) " Dictation will use the Gemini API key in this code." else "") +
                    // a link can come from anywhere (a web page, a message): the code on your own Mac is the one to trust
                    (if (fromLink) "\n\nOnly pair with a code from your own Mac." else ""),
            )
        },
        confirmButton = {
            TextButton(onClick = {
                if (switching) startFresh(context, p) else p.save(graph.prefs, graph.secrets)
                onDone()
            }) { Text(if (switching) "Switch and restart" else "Pair") }
        },
        dismissButton = { TextButton(onClick = onDone) { Text("Cancel") } },
    )
}

/** Saves the new pairing and restarts the app, which drops the old server's documents and sync state as it starts. */
private fun startFresh(context: Context, p: Pairing) {
    val graph = context.graph
    graph.prefs.resetPending.value = true // first: sync stops before the new server is set
    p.save(graph.prefs, graph.secrets)
    graph.prefs.flush()
    graph.secrets.flush()
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
        ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
    context.startActivity(launch)
    Runtime.getRuntime().exit(0)
}

/** First launch, not paired yet: one tap to bring the Mac's notes and tasks over. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WelcomeSheet(onScan: () -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 24.dp, vertical = 8.dp),
               verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Bento on your phone", style = MaterialTheme.typography.headlineSmall)
            Text("Your notes and tasks, synced live with Bento on your Mac, plus dictation and meeting notes. " +
                 "On the Mac: Settings → Notes → Pair Android Phone, then scan the code.",
                 style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Button(onClick = onScan, modifier = Modifier.fillMaxWidth()) { Text("Scan pairing code") }
            TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("Not now") }
        }
    }
}
