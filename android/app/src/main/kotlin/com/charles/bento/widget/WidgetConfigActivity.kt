package com.charles.bento.widget

import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.charles.bento.graph
import com.charles.bento.ui.theme.BentoTheme
import kotlinx.coroutines.launch

/** Chooses what a note widget shows (which note) or a task widget (which view). */
class WidgetConfigActivity : ComponentActivity() {
    @OptIn(ExperimentalMaterial3Api::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val appWidgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        setResult(RESULT_CANCELED, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) { finish(); return }
        val kind = intent.getStringExtra(EXTRA_KIND) ?: kindFor(appWidgetId)
        setContent {
            val theme by graph.prefs.theme.flow.collectAsStateWithLifecycle()
            val scope = rememberCoroutineScope()
            var options by remember { mutableStateOf<List<Pair<String, String>>>(emptyList()) }
            LaunchedEffect(kind) {
                options = if (kind == KIND_NOTE) graph.widgetData.notes(200).map { it.id to it.title.ifBlank { "Untitled" } }
                          else graph.widgetData.taskViews()
            }
            BentoTheme(theme) {
                Scaffold(topBar = { TopAppBar(title = { Text(if (kind == KIND_NOTE) "Choose a note" else "Show tasks from") }) }) { padding ->
                    LazyColumn(Modifier.fillMaxSize().padding(padding)) {
                        items(options) { (id, label) ->
                            Column(Modifier.fillMaxWidth().clickable {
                                graph.prefs.putString(if (kind == KIND_NOTE) noteWidgetKey(appWidgetId) else tasksWidgetKey(appWidgetId), id)
                                scope.launch {
                                    val glanceId = GlanceAppWidgetManager(this@WidgetConfigActivity).getGlanceIdBy(appWidgetId)
                                    if (kind == KIND_NOTE) NoteWidget().update(this@WidgetConfigActivity, glanceId)
                                    else TasksWidget().update(this@WidgetConfigActivity, glanceId)
                                    setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
                                    finish()
                                }
                            }) {
                                Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(horizontal = 20.dp, vertical = 16.dp))
                                HorizontalDivider()
                            }
                        }
                    }
                }
            }
        }
    }

    private fun kindFor(appWidgetId: Int): String {
        val info = AppWidgetManager.getInstance(this).getAppWidgetInfo(appWidgetId)
        return if (info?.provider?.className?.endsWith("NoteWidgetReceiver") == true) KIND_NOTE else KIND_TASKS
    }

    companion object {
        const val EXTRA_KIND = "kind"
        const val KIND_NOTE = "note"
        const val KIND_TASKS = "tasks"
    }
}
