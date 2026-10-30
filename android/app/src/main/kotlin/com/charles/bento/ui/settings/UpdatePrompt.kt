package com.charles.bento.ui.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.charles.bento.BuildConfig
import com.charles.bento.graph
import com.charles.bento.update.Updater

/**
 * "Update now?" when the updater finds a newer release, over whatever screen is open; then
 * the download's progress, until the installer takes over, and a failure. Later asks again
 * the next time Bento is opened, Skip not until a newer version.
 */
@Composable
fun UpdatePrompt() {
    val graph = LocalContext.current.graph
    val updater = graph.updater
    val offer by updater.offer.collectAsStateWithLifecycle(null)
    val state by updater.state.collectAsStateWithLifecycle()
    // kept by the updater, so a rotation or a new screen still shows the download
    val following by updater.following.collectAsStateWithLifecycle()

    when (val s = state) {
        is Updater.State.Available -> offer?.let { release ->
            val busy = graph.meetings.isBusy || graph.assistant.callActive
            AlertDialog(
                onDismissRequest = { updater.later(release) },
                title = { Text("Update Bento?") },
                text = {
                    Text(
                        "Bento ${release.version} is available (you have ${BuildConfig.VERSION_NAME}). It downloads from GitHub " +
                            "and Bento restarts." + if (busy) " That ends the recording or call in progress." else "",
                    )
                },
                confirmButton = {
                    // the app's scope: leaving this screen mustn't stop the download
                    TextButton(onClick = { updater.start(release, graph.main) }) { Text("Update now") }
                },
                dismissButton = {
                    Row {
                        TextButton(onClick = { updater.skip(release) }) { Text("Skip this version") }
                        TextButton(onClick = { updater.later(release) }) { Text("Later") }
                    }
                },
            )
        }
        is Updater.State.Downloading -> if (following == s.release.version) {
            AlertDialog(
                onDismissRequest = { updater.following.value = null },
                title = { Text("Downloading Bento ${s.release.version}") },
                text = {
                    Column {
                        Text("Settings → Updates shows the progress too.")
                        LinearProgressIndicator(progress = { s.progress }, modifier = Modifier.fillMaxWidth().padding(top = 16.dp))
                    }
                },
                confirmButton = { TextButton(onClick = { updater.following.value = null }) { Text("Hide") } },
            )
        }
        is Updater.State.Failed -> if (s.installing && following != null) {
            AlertDialog(
                onDismissRequest = { updater.following.value = null },
                title = { Text("Bento couldn't update") },
                text = { Text(s.message) },
                confirmButton = { TextButton(onClick = { updater.following.value = null }) { Text("OK") } },
            )
        }
        else -> {}
    }
}
