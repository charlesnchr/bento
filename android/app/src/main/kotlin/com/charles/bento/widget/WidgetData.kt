package com.charles.bento.widget

import android.content.Context
import androidx.glance.appwidget.updateAll
import com.charles.bento.graph
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** What the widgets show, read from the stores (on the engine thread). */
interface WidgetData {
    suspend fun notes(limit: Int): List<NoteCard>
    suspend fun note(id: String): NoteCard?
    suspend fun tasks(view: String, limit: Int): TaskList
    /** Inbox, Today, Upcoming, then projects: (view id, label). */
    suspend fun taskViews(): List<Pair<String, String>>
    suspend fun toggleTask(id: String)
    /** Ticks or unticks the `- [ ]` item on a body line of a note. */
    suspend fun toggleChecklistItem(noteId: String, line: Int)
}

data class NoteCard(
    val id: String,
    val title: String,
    /** First lines after the title, plain text, for the list widget. */
    val snippet: String,
    val pinned: Boolean,
    val updatedAt: Long,
    /** The body as display lines, for the single-note widget. */
    val lines: List<NoteLine> = emptyList(),
)

sealed interface NoteLine {
    val index: Int
    data class Text(override val index: Int, val text: String, val heading: Boolean) : NoteLine
    data class Check(override val index: Int, val text: String, val checked: Boolean) : NoteLine
    data class Bullet(override val index: Int, val text: String) : NoteLine
}

data class TaskList(val title: String, val tasks: List<TaskCard>, val overdueCount: Int)

data class TaskCard(
    val id: String,
    val title: String,
    /** "Today", "Tomorrow 17:00", "Mon 3 Nov"; null without a date. */
    val due: String?,
    val overdue: Boolean,
    /** 1…4 (p1 highest). */
    val priority: Int,
    val project: String?,
    val completed: Boolean,
)

/** Redraws every Bento widget, at most a few times a second. */
object Widgets {
    private var pending: Job? = null

    fun refresh(context: Context, delayMs: Long = 300) {
        val app = context.applicationContext
        pending?.cancel()
        pending = app.graph.main.launch {
            delay(delayMs)
            NotesWidget().updateAll(app)
            NoteWidget().updateAll(app)
            TasksWidget().updateAll(app)
        }
    }
}
