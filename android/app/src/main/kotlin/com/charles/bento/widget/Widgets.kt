package com.charles.bento.widget

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalSize
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionParametersOf
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.lazy.items
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextDecoration
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import com.charles.bento.MainActivity
import com.charles.bento.R
import com.charles.bento.ShortcutActivity
import com.charles.bento.graph
import com.charles.bento.ui.theme.PriorityColors
import com.charles.bento.voice.CaptureActivity

private val noteIdKey = ActionParameters.Key<String>("noteId")
private val lineKey = ActionParameters.Key<Int>("line")
private val taskIdKey = ActionParameters.Key<String>("taskId")

private fun open(context: Context, action: String, id: String? = null) =
    Intent(context, MainActivity::class.java).setAction(action).apply { id?.let { putExtra(MainActivity.EXTRA_ID, it) } }
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

private fun capture(context: Context, kind: String) = CaptureActivity.intent(context, kind)

// MARK: Notes (like Google Keep's list widget)

class NotesWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val notes = context.graph.widgetData.notes(30)
        provideContent { GlanceTheme { NotesContent(context, notes) } }
    }
}

class NotesWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = NotesWidget()
}

@Composable
private fun NotesContent(context: Context, notes: List<NoteCard>) {
    WidgetSurface {
        Header(
            title = "Notes",
            onTitle = actionStartActivity(open(context, Intent.ACTION_MAIN)),
            buttons = listOf(
                R.drawable.ic_w_mic to actionStartActivity(capture(context, CaptureActivity.KIND_THOUGHT)),
                R.drawable.ic_w_add to actionStartActivity(open(context, MainActivity.ACTION_NEW_NOTE)),
            ),
        )
        if (notes.isEmpty()) {
            Empty("No notes yet")
        } else {
            LazyColumn(GlanceModifier.fillMaxSize()) {
                items(notes, itemId = { it.id.hashCode().toLong() }) { n ->
                    Column(GlanceModifier.fillMaxWidth().padding(bottom = 6.dp)) {
                        Column(
                            GlanceModifier.fillMaxWidth().cornerRadius(14.dp).background(GlanceTheme.colors.secondaryContainer)
                                .padding(horizontal = 12.dp, vertical = 10.dp)
                                .clickable(actionStartActivity(open(context, MainActivity.ACTION_OPEN_NOTE, n.id))),
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                if (n.pinned) {
                                    Image(ImageProvider(R.drawable.ic_w_pin), "Pinned", GlanceModifier.size(14.dp),
                                          colorFilter = ColorFilter.tint(GlanceTheme.colors.primary))
                                    Spacer(GlanceModifier.width(4.dp))
                                }
                                Text(n.title.ifBlank { "Untitled" }, maxLines = 1,
                                     style = TextStyle(color = GlanceTheme.colors.onSecondaryContainer, fontWeight = FontWeight.Medium, fontSize = 14.sp))
                            }
                            if (n.snippet.isNotBlank()) {
                                Text(n.snippet, maxLines = 3, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 13.sp))
                            }
                        }
                    }
                }
            }
        }
    }
}

// MARK: One note (with tappable checklists)

class NoteWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val appWidgetId = GlanceAppWidgetManager(context).getAppWidgetId(id)
        val noteId = context.graph.prefs.getString(noteWidgetKey(appWidgetId))
        val note = noteId?.let { context.graph.widgetData.note(it) }
        provideContent { GlanceTheme { NoteContent(context, appWidgetId, note) } }
    }
}

class NoteWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = NoteWidget()
}

fun noteWidgetKey(appWidgetId: Int) = "widget.note.$appWidgetId"

@Composable
private fun NoteContent(context: Context, appWidgetId: Int, note: NoteCard?) {
    WidgetSurface {
        if (note == null) {
            val pick = Intent(context, WidgetConfigActivity::class.java).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
                .putExtra(WidgetConfigActivity.EXTRA_KIND, WidgetConfigActivity.KIND_NOTE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            Box(GlanceModifier.fillMaxSize().clickable(actionStartActivity(pick)), contentAlignment = Alignment.Center) {
                Text("Tap to choose a note", style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant))
            }
            return@WidgetSurface
        }
        val openNote = actionStartActivity(open(context, MainActivity.ACTION_OPEN_NOTE, note.id))
        Text(note.title.ifBlank { "Untitled" }, maxLines = 2, modifier = GlanceModifier.fillMaxWidth().padding(bottom = 6.dp).clickable(openNote),
             style = TextStyle(color = GlanceTheme.colors.onSurface, fontWeight = FontWeight.Bold, fontSize = 16.sp))
        LazyColumn(GlanceModifier.fillMaxSize()) {
            items(note.lines, itemId = { it.index.toLong() }) { line ->
                when (line) {
                    is NoteLine.Check -> Row(
                        GlanceModifier.fillMaxWidth().padding(vertical = 3.dp)
                            .clickable(actionRunCallback<ToggleChecklistAction>(actionParametersOf(noteIdKey to note.id, lineKey to line.index))),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Image(ImageProvider(if (line.checked) R.drawable.ic_w_box_checked else R.drawable.ic_w_box_unchecked),
                              if (line.checked) "Done" else "To do", GlanceModifier.size(20.dp),
                              colorFilter = ColorFilter.tint(if (line.checked) GlanceTheme.colors.primary else GlanceTheme.colors.onSurfaceVariant))
                        Spacer(GlanceModifier.width(8.dp))
                        Text(line.text, maxLines = 2, style = TextStyle(
                            color = if (line.checked) GlanceTheme.colors.onSurfaceVariant else GlanceTheme.colors.onSurface, fontSize = 14.sp,
                            textDecoration = if (line.checked) TextDecoration.LineThrough else TextDecoration.None,
                        ))
                    }
                    is NoteLine.Bullet -> Text("•  ${line.text}", modifier = GlanceModifier.padding(vertical = 2.dp).clickable(openNote),
                                               style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 14.sp))
                    is NoteLine.Text -> Text(line.text, modifier = GlanceModifier.padding(vertical = 2.dp).clickable(openNote),
                                             style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = if (line.heading) 15.sp else 14.sp,
                                                               fontWeight = if (line.heading) FontWeight.Bold else FontWeight.Normal))
                }
            }
        }
    }
}

class ToggleChecklistAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val note = parameters[noteIdKey] ?: return
        val line = parameters[lineKey] ?: return
        context.graph.widgetData.toggleChecklistItem(note, line)
        NoteWidget().update(context, glanceId)
    }
}

// MARK: Tasks (like Todoist's list widget)

class TasksWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val appWidgetId = GlanceAppWidgetManager(context).getAppWidgetId(id)
        val view = context.graph.prefs.getString(tasksWidgetKey(appWidgetId)) ?: "today"
        val list = context.graph.widgetData.tasks(view, 40)
        provideContent { GlanceTheme { TasksContent(context, appWidgetId, list) } }
    }
}

class TasksWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TasksWidget()
}

fun tasksWidgetKey(appWidgetId: Int) = "widget.tasks.$appWidgetId"

@Composable
private fun TasksContent(context: Context, appWidgetId: Int, list: TaskList) {
    val configure = Intent(context, WidgetConfigActivity::class.java).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
        .putExtra(WidgetConfigActivity.EXTRA_KIND, WidgetConfigActivity.KIND_TASKS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    WidgetSurface {
        Header(
            title = list.title,
            subtitle = if (list.overdueCount > 0) "${list.overdueCount} overdue" else list.tasks.count { !it.completed }.takeIf { it > 0 }?.toString(),
            onTitle = actionStartActivity(configure),
            buttons = listOf(
                R.drawable.ic_w_mic to actionStartActivity(capture(context, CaptureActivity.KIND_TASK)),
                R.drawable.ic_w_add to actionStartActivity(open(context, MainActivity.ACTION_QUICK_ADD)),
            ),
        )
        if (list.tasks.isEmpty()) {
            Empty("All clear")
        } else {
            LazyColumn(GlanceModifier.fillMaxSize()) {
                items(list.tasks, itemId = { it.id.hashCode().toLong() }) { t ->
                    Row(GlanceModifier.fillMaxWidth().padding(vertical = 5.dp), verticalAlignment = Alignment.Top) {
                        val color = PriorityColors[(t.priority - 1).coerceIn(0, 3)]
                        Image(
                            ImageProvider(if (t.completed) R.drawable.ic_w_check else R.drawable.ic_w_circle),
                            if (t.completed) "Completed" else "Complete", GlanceModifier.size(22.dp)
                                .clickable(actionRunCallback<ToggleTaskAction>(actionParametersOf(taskIdKey to t.id))),
                            colorFilter = ColorFilter.tint(ColorProvider(if (t.priority == 4) color.copy(alpha = 0.8f) else color)),
                        )
                        Spacer(GlanceModifier.width(10.dp))
                        Column(GlanceModifier.defaultWeight().clickable(actionStartActivity(open(context, MainActivity.ACTION_OPEN_TASK, t.id)))) {
                            Text(t.title, maxLines = 2, style = TextStyle(
                                color = if (t.completed) GlanceTheme.colors.onSurfaceVariant else GlanceTheme.colors.onSurface, fontSize = 14.sp,
                                textDecoration = if (t.completed) TextDecoration.LineThrough else TextDecoration.None,
                            ))
                            val meta = listOfNotNull(t.due, t.project).joinToString("  ·  ")
                            if (meta.isNotEmpty()) {
                                Text(meta, maxLines = 1, style = TextStyle(
                                    color = if (t.overdue) ColorProvider(Color(0xFFD1453B)) else GlanceTheme.colors.onSurfaceVariant, fontSize = 12.sp,
                                ))
                            }
                        }
                    }
                }
            }
        }
    }
}

class ToggleTaskAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val id = parameters[taskIdKey] ?: return
        context.graph.widgetData.toggleTask(id)
        TasksWidget().update(context, glanceId)
    }
}

// MARK: Capture buttons

class CaptureWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Responsive(setOf(androidx.compose.ui.unit.DpSize(60.dp, 60.dp), androidx.compose.ui.unit.DpSize(180.dp, 60.dp)))

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent { GlanceTheme { CaptureContent(context) } }
    }
}

class CaptureWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = CaptureWidget()
}

@Composable
private fun CaptureContent(context: Context) {
    val wide = LocalSize.current.width >= 170.dp
    val meeting = Intent(context, ShortcutActivity::class.java).setData(android.net.Uri.parse("bento://shortcut/meeting"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    Row(
        GlanceModifier.fillMaxSize().cornerRadius(28.dp).background(GlanceTheme.colors.widgetBackground).padding(6.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CaptureButton(R.drawable.ic_w_mic, "Capture thought", primary = true, actionStartActivity(capture(context, CaptureActivity.KIND_THOUGHT)))
        if (wide) {
            Spacer(GlanceModifier.width(8.dp))
            CaptureButton(R.drawable.ic_w_task, "New task by voice", primary = false, actionStartActivity(capture(context, CaptureActivity.KIND_TASK)))
            Spacer(GlanceModifier.width(8.dp))
            CaptureButton(R.drawable.ic_w_meeting, "Record meeting", primary = false, actionStartActivity(meeting))
        }
    }
}

@Composable
private fun CaptureButton(icon: Int, description: String, primary: Boolean, onClick: androidx.glance.action.Action) {
    Box(
        GlanceModifier.size(48.dp).cornerRadius(24.dp)
            .background(if (primary) GlanceTheme.colors.primary else GlanceTheme.colors.secondaryContainer).clickable(onClick),
        contentAlignment = Alignment.Center,
    ) {
        Image(ImageProvider(icon), description, GlanceModifier.size(24.dp),
              colorFilter = ColorFilter.tint(if (primary) GlanceTheme.colors.onPrimary else GlanceTheme.colors.onSecondaryContainer))
    }
}

// MARK: Shared pieces

@Composable
private fun WidgetSurface(content: @Composable () -> Unit) {
    Column(
        GlanceModifier.fillMaxSize().cornerRadius(24.dp).background(GlanceTheme.colors.widgetBackground).padding(12.dp),
    ) { content() }
}

@Composable
private fun Header(title: String, subtitle: String? = null, onTitle: androidx.glance.action.Action, buttons: List<Pair<Int, androidx.glance.action.Action>>) {
    Row(GlanceModifier.fillMaxWidth().padding(bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(GlanceModifier.defaultWeight().clickable(onTitle), verticalAlignment = Alignment.CenterVertically) {
            Text(title, maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSurface, fontWeight = FontWeight.Bold, fontSize = 18.sp))
            if (subtitle != null) {
                Spacer(GlanceModifier.width(8.dp))
                Text(subtitle, maxLines = 1, style = TextStyle(color = GlanceTheme.colors.primary, fontSize = 13.sp))
            }
        }
        buttons.forEach { (icon, action) ->
            Spacer(GlanceModifier.width(6.dp))
            Box(
                GlanceModifier.size(36.dp).cornerRadius(18.dp).background(GlanceTheme.colors.secondaryContainer).clickable(action),
                contentAlignment = Alignment.Center,
            ) {
                Image(ImageProvider(icon), null, GlanceModifier.size(20.dp), colorFilter = ColorFilter.tint(GlanceTheme.colors.onSecondaryContainer))
            }
        }
    }
}

@Composable
private fun Empty(text: String) {
    Box(GlanceModifier.fillMaxSize().height(60.dp), contentAlignment = Alignment.Center) {
        Text(text, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 14.sp))
    }
}
