package com.charles.bento

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.view.KeyEvent
import com.charles.bento.voice.BentoAccessibilityService

/**
 * Debug builds only: feeds a key event to the accessibility service's key filter, the way
 * a hardware button would (adb's injected keys bypass accessibility filtering), so the
 * hold-to-talk path can be driven from tests:
 * `adb shell am broadcast -a com.charles.bento.debug.KEY --ei code 25 --es action down`
 */
class DebugKeyReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == "com.charles.bento.debug.PIN") {
            // `--es widget NotesWidgetReceiver`: the system's "Add to home screen" sheet for it
            val provider = android.content.ComponentName(context.packageName, "com.charles.bento.widget." + intent.getStringExtra("widget"))
            android.appwidget.AppWidgetManager.getInstance(context).requestPinAppWidget(provider, null, null)
            return
        }
        if (intent.action == "com.charles.bento.debug.MIC") {
            // `--es file <name in the app's files dir>` replaces the microphone; no extra: the real one again
            com.charles.bento.voice.AudioCapture.testSource = intent.getStringExtra("file")?.let { java.io.File(context.getExternalFilesDir(null), it) }
            return
        }
        val code = intent.getIntExtra("code", KeyEvent.KEYCODE_VOLUME_DOWN)
        val action = if (intent.getStringExtra("action") == "up") KeyEvent.ACTION_UP else KeyEvent.ACTION_DOWN
        val now = SystemClock.uptimeMillis()
        BentoAccessibilityService.instance?.debugKey(KeyEvent(now, now, action, code, 0))
    }
}
