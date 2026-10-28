package com.charles.bento.widget

import android.appwidget.AppWidgetManager
import android.content.Context
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import com.charles.bento.core.todo.TodoStore
import com.charles.bento.graph
import com.charles.bento.ui.theme.BentoTheme
import com.charles.bento.ui.todo.SnapshotRepo
import com.charles.bento.ui.todo.ViewPickerSheet
import com.charles.bento.ui.todo.encode
import kotlinx.coroutines.launch

/**
 * Chooses what a note widget shows (which note) or a task widget (which list: the app's own
 * list picker, over the home screen). Opened by the launcher (placing, reconfiguring) and
 * by the widgets themselves.
 */
class WidgetConfigActivity : ComponentActivity() {
    private var appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        appWidgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        setResult(RESULT_CANCELED, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) { finish(); return }
        val kind = intent.getStringExtra(EXTRA_KIND) ?: kindFor(appWidgetId)
        setContent {
            val theme by graph.prefs.theme.flow.collectAsStateWithLifecycle()
            BentoTheme(theme) {
                if (kind == KIND_NOTE) NotePicker() else ListPicker()
            }
        }
    }

    @Composable
    private fun ListPicker() {
        val docs by graph.todo.docs.collectAsStateWithLifecycle()
        val store = remember(docs) { TodoStore(SnapshotRepo(docs)) }
        val counts = remember(docs) { store.counts(graph.todo.dates()) }
        val view = remember(docs) { WidgetConfigs.resolve(graph.widgetConfigs.taskView(appWidgetId), store.projects.map { it.id }) }
        ViewPickerSheet(view, counts, store.projects, store.labels, onPick = { v ->
            graph.widgetConfigs.setTaskView(appWidgetId, v.encode())
            done(TasksWidget())
        }, onDismiss = ::finish)
    }

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    private fun NotePicker() {
        val all by graph.notes.notes.collectAsStateWithLifecycle()
        val options = remember(all) { graph.widgetData.notes(200) }
        Scaffold(topBar = { TopAppBar(title = { Text("Choose a note") }) }) { padding ->
            LazyColumn(Modifier.fillMaxSize().padding(padding)) {
                items(options, key = { it.id }) { note ->
                    Column(Modifier.fillMaxWidth().clickable {
                        graph.widgetConfigs.setNote(appWidgetId, note.id)
                        done(NoteWidget())
                    }) {
                        Text(note.title.ifBlank { "Untitled" }, style = MaterialTheme.typography.bodyLarge,
                             modifier = Modifier.padding(horizontal = 20.dp, vertical = 16.dp))
                        HorizontalDivider()
                    }
                }
            }
        }
    }

    /** Saved: redraw this widget (a running one redraws itself too) and close. */
    private fun done(widget: GlanceAppWidget) {
        lifecycleScope.launch {
            widget.update(this@WidgetConfigActivity, GlanceAppWidgetManager(this@WidgetConfigActivity).getGlanceIdBy(appWidgetId))
            setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
            finish()
        }
    }

    private fun kindFor(appWidgetId: Int): String {
        val info = AppWidgetManager.getInstance(this).getAppWidgetInfo(appWidgetId)
        return if (info?.provider?.className == NoteWidgetReceiver::class.java.name) KIND_NOTE else KIND_TASKS
    }

    companion object {
        const val EXTRA_KIND = "kind"
        const val KIND_NOTE = "note"
        const val KIND_TASKS = "tasks"

        /** From a widget: a fresh picker for that widget (never another widget's, left open behind the home screen). */
        fun intent(context: Context, appWidgetId: Int, kind: String): Intent =
            Intent(context, WidgetConfigActivity::class.java).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
                .putExtra(EXTRA_KIND, kind).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
    }
}
