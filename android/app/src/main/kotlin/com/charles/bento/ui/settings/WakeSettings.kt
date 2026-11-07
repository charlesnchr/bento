package com.charles.bento.ui.settings

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.provider.Settings
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.BatterySaver
import androidx.compose.material.icons.rounded.Bolt
import androidx.compose.material.icons.rounded.Keyboard
import androidx.compose.material.icons.rounded.PictureInPictureAlt
import androidx.compose.material.icons.rounded.RecordVoiceOver
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.core.net.toUri
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.charles.bento.R
import com.charles.bento.graph
import com.charles.bento.voice.WakePanel
import com.charles.bento.voice.WakeState
import com.charles.bento.voice.WakeTileService

/** Settings → Wake word: "Woodhouse" starts a voice call with Hermes, around the clock. */
@Composable
fun WakeSection(context: Context, tick: Int) {
    val graph = context.graph
    val prefs = graph.prefs
    val on by prefs.wakeWord.flow.collectAsStateWithLifecycle()
    val saver by prefs.wakePauseOnSaver.flow.collectAsStateWithLifecycle()
    val threshold by prefs.wakeThreshold.flow.collectAsStateWithLifecycle()
    val panel by prefs.wakePanel.flow.collectAsStateWithLifecycle()
    val canShowPanel = remember(tick) { WakePanel.canShow(context) }
    val overApps = remember(tick) { Settings.canDrawOverlays(context) }
    val state by graph.wake.state.collectAsStateWithLifecycle()
    val mic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> if (granted) graph.wake.setEnabled(true) }
    val notifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}

    SettingsSection(
        "Wake word",
        footer = "Say “Woodhouse” and a voice call with Hermes starts in a new chat, hearing what you say after the word. " +
            "It hangs up after 15 seconds of quiet. The Echo's model runs on the phone and nothing leaves it until you say the word; " +
            "in a quiet room it doesn't run at all. Android shows the microphone in use while Bento listens.",
    ) {
        val status = when (val s = state) {
            WakeState.Off -> "Off"
            WakeState.Listening -> "Listening"
            WakeState.Starting -> "Starting…"
            is WakeState.Paused -> s.why
            is WakeState.Blocked -> s.why
        }
        SwitchRow("Listen for “Woodhouse”", on, status, Icons.Rounded.RecordVoiceOver) { enable ->
            when {
                !enable -> graph.wake.setEnabled(false)
                !Setup.hasMic(context) -> mic.launch(Manifest.permission.RECORD_AUDIO)
                !graph.assistant.canCall -> Toast.makeText(context, "Set up Hermes and a Gemini API key first", Toast.LENGTH_LONG).show()
                else -> {
                    if (!Setup.hasNotifications(context) && Build.VERSION.SDK_INT >= 33) notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                    graph.wake.setEnabled(true)
                }
            }
        }
        SwitchRow(
            "Show it on screen", panel && canShowPanel,
            if (canShowPanel) "What you say and the reply, over any app" else "Allow Bento to appear over other apps",
            Icons.Rounded.PictureInPictureAlt,
        ) { show ->
            prefs.wakePanel.value = show
            if (show && !canShowPanel) allowOverApps(context)
        }
        if (panel && canShowPanel && !overApps) {
            // as the accessibility service's overlay it sits above the keyboard, over what you're typing in
            SettingsRow("Allow it over other apps", "So the keyboard covers it, not your typing", Icons.Rounded.Keyboard, onClick = { allowOverApps(context) })
        }
        SwitchRow("Pause in battery saver", saver, "And while the battery is low", Icons.Rounded.BatterySaver) { prefs.wakePauseOnSaver.value = it }
        SliderRow("Sensitivity", (100 - threshold).toFloat(), 10f..50f, "${100 - threshold}%".let { if (threshold == 70) "$it (as the Echo)" else it }, steps = 7) {
            prefs.wakeThreshold.value = 100 - it.toInt()
        }
        SettingsRow("Quick Settings tile", "Turn it on or off from anywhere", Icons.Rounded.Bolt, onClick = { requestWakeTile(context) })
    }
}

private fun allowOverApps(context: Context) =
    context.startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, "package:${context.packageName}".toUri()))

private fun requestWakeTile(context: Context) {
    if (Build.VERSION.SDK_INT < 33) {
        Toast.makeText(context, "Edit Quick Settings and drag in “Woodhouse”", Toast.LENGTH_LONG).show()
        return
    }
    context.getSystemService(android.app.StatusBarManager::class.java).requestAddTileService(
        ComponentName(context, WakeTileService::class.java), "Woodhouse",
        Icon.createWithResource(context, R.drawable.ic_stat_mic), context.mainExecutor,
    ) {}
}
