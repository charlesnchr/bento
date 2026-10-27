package com.charles.bento.ui

import android.Manifest
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.automirrored.outlined.StickyNote2
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.automirrored.rounded.StickyNote2
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import com.charles.bento.MainActivity
import com.charles.bento.graph
import com.charles.bento.settings.Pairing
import com.charles.bento.ui.settings.PairingDialog
import com.charles.bento.ui.settings.SettingsScreen
import com.charles.bento.ui.settings.WelcomeSheet
import com.charles.bento.ui.settings.scanPairingCode
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.Serializable

@Serializable data object HomeRoute
@Serializable data class NoteRoute(val id: String)
@Serializable data object SettingsRoute
@Serializable data object TrashRoute
@Serializable data class MeetingRoute(val id: String)
@Serializable data object DictionaryRoute
@Serializable data object ModesRoute

enum class Tab(val label: String, val icon: ImageVector, val selectedIcon: ImageVector) {
    Notes("Notes", Icons.AutoMirrored.Outlined.StickyNote2, Icons.AutoMirrored.Rounded.StickyNote2),
    Todo("Todo", Icons.Outlined.CheckCircle, Icons.Rounded.CheckCircle),
    Voice("Voice", Icons.Outlined.Mic, Icons.Rounded.Mic),
}

/** Asks the home screen to do something (from a deep link, widget or shortcut). */
sealed interface HomeAction {
    data object QuickAdd : HomeAction
    data class ShowTab(val tab: Tab) : HomeAction
}

@Composable
fun BentoRoot(activity: MainActivity, pendingIntent: MutableStateFlow<Intent?>) {
    val graph = activity.graph
    val nav = rememberNavController()
    var tab by rememberSaveable { mutableStateOf(Tab.Notes) }
    var pairing by remember { mutableStateOf<Pairing?>(null) }
    val homeAction = remember { MutableStateFlow<HomeAction?>(null) }
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    val intent by pendingIntent.collectAsStateWithLifecycle()

    LaunchedEffect(intent) {
        val i = intent ?: return@LaunchedEffect
        pendingIntent.value = null
        val id = i.getStringExtra(MainActivity.EXTRA_ID)
        // actions that land on a tab start from the home screen, whatever was open
        if (i.action in setOf(MainActivity.ACTION_QUICK_ADD, MainActivity.ACTION_OPEN_TODO, MainActivity.ACTION_OPEN_TASK,
                              MainActivity.ACTION_OPEN_MEETING, MainActivity.ACTION_TOGGLE_MEETING)) {
            nav.popBackStack(HomeRoute, inclusive = false)
        }
        when (i.action) {
            Intent.ACTION_VIEW -> i.dataString?.let { link ->
                Pairing.parse(link)?.let { pairing = it }
                    ?: Routes.fromLink(link)?.let { nav.navigate(it) }
            }
            MainActivity.ACTION_GRANT_MIC -> micPermission.launch(Manifest.permission.RECORD_AUDIO)
            MainActivity.ACTION_OPEN_NOTE -> id?.let { nav.navigate(NoteRoute(it)) }
            MainActivity.ACTION_NEW_NOTE -> nav.navigate(NoteRoute(Routes.NEW))
            MainActivity.ACTION_QUICK_ADD -> { tab = Tab.Todo; homeAction.value = HomeAction.QuickAdd }
            MainActivity.ACTION_OPEN_TODO -> tab = Tab.Todo
            MainActivity.ACTION_OPEN_TASK -> { tab = Tab.Todo; id?.let { Routes.openTask.value = it } }
            MainActivity.ACTION_OPEN_MEETING -> { tab = Tab.Voice; (id ?: graph.meetings.recording.value)?.let { nav.navigate(MeetingRoute(it)) } }
            MainActivity.ACTION_TOGGLE_MEETING -> {
                tab = Tab.Voice
                val rec = graph.meetings.recording.value
                if (rec != null) { graph.meetings.stop(rec); nav.navigate(MeetingRoute(rec)) } else graph.meetings.start()
            }
            MainActivity.ACTION_OPEN_UPDATES -> nav.navigate(SettingsRoute)
        }
    }

    NavHost(nav, startDestination = HomeRoute, enterTransition = { fadeIn() }, exitTransition = { fadeOut() }) {
        composable<HomeRoute> {
            Scaffold(
                bottomBar = {
                    NavigationBar {
                        Tab.entries.forEach { t ->
                            NavigationBarItem(
                                selected = tab == t,
                                onClick = { tab = t },
                                icon = { Icon(if (tab == t) t.selectedIcon else t.icon, contentDescription = null) },
                                label = { Text(t.label) },
                            )
                        }
                    }
                },
            ) { padding ->
                // each tab draws its own top bar (with the status bar inset); this only reserves the navigation bar
                val m = Modifier.padding(bottom = padding.calculateBottomPadding())
                when (tab) {
                    Tab.Notes -> Screens.notes(m, nav)
                    Tab.Todo -> Screens.todo(m, nav, homeAction)
                    Tab.Voice -> Screens.voice(m, nav)
                }
            }
        }
        composable<NoteRoute> { Screens.noteEditor(it.toRoute<NoteRoute>().id, nav) }
        composable<SettingsRoute> { SettingsScreen(nav) }
        composable<TrashRoute> { Screens.trash(nav) }
        composable<MeetingRoute> { Screens.meeting(it.toRoute<MeetingRoute>().id, nav) }
        composable<DictionaryRoute> { Screens.dictionary(nav) }
        composable<ModesRoute> { Screens.modes(nav) }
    }

    pairing?.let { p -> PairingDialog(p) { pairing = null } }

    val onboarded by graph.prefs.onboarded.flow.collectAsStateWithLifecycle()
    val server by graph.prefs.server.flow.collectAsStateWithLifecycle()
    if (!onboarded && server.isBlank()) {
        WelcomeSheet(
            onScan = { graph.prefs.onboarded.value = true; scanPairingCode(activity) { pairing = it } },
            onDismiss = { graph.prefs.onboarded.value = true },
        )
    }
}

object Routes {
    const val NEW = "new"
    /** A task to open in the Todo tab (from a widget or notification). */
    val openTask = MutableStateFlow<String?>(null)

    /** bento://note/<id>, bento://settings */
    fun fromLink(link: String): Any? {
        val uri = android.net.Uri.parse(link)
        if (uri.scheme != "bento") return null
        return when (uri.host) {
            "note" -> uri.lastPathSegment?.let(::NoteRoute)
            "settings" -> SettingsRoute
            else -> null
        }
    }
}
