package com.charles.bento.voice

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import com.charles.bento.MainActivity
import com.charles.bento.graph
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Quick Settings: the wake word on or off. Off works from anywhere. Android lets Bento start
 * listening from the background only in some cases (its accessibility service is on), so when
 * that's refused, turning it on opens Bento for a moment.
 */
class WakeTileService : TileService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var showing: Job? = null

    override fun onStartListening() {
        showing = scope.launch { applicationContext.graph.wake.state.collect { show(it) } }
    }

    override fun onStopListening() {
        showing?.cancel()
        showing = null
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    override fun onClick() {
        val wake = applicationContext.graph.wake
        if (wake.state.value.let { it is WakeState.Listening || it is WakeState.Paused || it is WakeState.Starting }) { wake.setEnabled(false); return }
        wake.setEnabled(true)
        scope.launch {
            val settled = withTimeoutOrNull(5_000) { wake.state.first { it != WakeState.Starting } }
            // refused in the background: open Bento, which starts it
            if ((settled as? WakeState.Blocked)?.needsBento == true) openBento()
        }
    }

    private fun openBento() {
        val intent = MainActivity.internal(this, MainActivity.ACTION_WAKE_ON).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 3, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }

    private fun show(state: WakeState) {
        val tile = qsTile ?: return
        tile.state = when (state) {
            WakeState.Listening, WakeState.Starting, is WakeState.Paused -> Tile.STATE_ACTIVE
            else -> Tile.STATE_INACTIVE
        }
        tile.subtitle = when (state) {
            WakeState.Listening, WakeState.Starting -> "Listening"
            is WakeState.Paused -> "Paused"
            is WakeState.Blocked, WakeState.Off -> "Off"
        }
        tile.updateTile()
    }
}
