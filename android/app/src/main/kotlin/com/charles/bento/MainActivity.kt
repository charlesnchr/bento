package com.charles.bento

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.charles.bento.ui.BentoRoot
import com.charles.bento.ui.theme.BentoTheme
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    /** The latest intent (deep link, widget tap, shortcut) for the UI to act on. */
    val pendingIntent = MutableStateFlow<Intent?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        pendingIntent.value = intent
        setContent {
            val theme by graph.prefs.theme.flow.collectAsStateWithLifecycle()
            BentoTheme(theme) { BentoRoot(this, pendingIntent) }
        }
    }

    override fun onStart() {
        super.onStart()
        lifecycleScope.launch { graph.updater.checkOnOpen() }
    }

    override fun onStop() {
        super.onStop()
        // Bento was left, not rotated: an update put off with "Later" is offered again next time
        if (!isChangingConfigurations) graph.updater.offerAgain()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        pendingIntent.value = intent
    }

    companion object {
        const val ACTION_GRANT_MIC = "com.charles.bento.GRANT_MIC"
        const val ACTION_OPEN_MEETING = "com.charles.bento.OPEN_MEETING"
        const val ACTION_TOGGLE_MEETING = "com.charles.bento.TOGGLE_MEETING"
        const val ACTION_OPEN_UPDATES = "com.charles.bento.OPEN_UPDATES"
        const val ACTION_OPEN_NOTE = "com.charles.bento.OPEN_NOTE"
        const val ACTION_NEW_NOTE = "com.charles.bento.NEW_NOTE"
        const val ACTION_OPEN_TASK = "com.charles.bento.OPEN_TASK"
        const val ACTION_QUICK_ADD = "com.charles.bento.QUICK_ADD"
        const val ACTION_OPEN_TODO = "com.charles.bento.OPEN_TODO"
        const val ACTION_OPEN_ASSISTANT = "com.charles.bento.OPEN_ASSISTANT"
        /** A new Hermes chat with a voice call on it (the Hermes call widget). */
        const val ACTION_NEW_CALL = "com.charles.bento.NEW_HERMES_CALL"
        const val EXTRA_ID = "id"
        private const val INTERNAL_ENTRY = "com.charles.bento.InternalEntry"

        /** An intent only Bento can send (the alias isn't exported): needed for [ACTION_TOGGLE_MEETING]. */
        fun internal(context: Context, action: String): Intent =
            Intent(action).setComponent(ComponentName(context.packageName, INTERNAL_ENTRY))

        fun isInternal(intent: Intent) = intent.component?.className == INTERNAL_ENTRY
    }
}
