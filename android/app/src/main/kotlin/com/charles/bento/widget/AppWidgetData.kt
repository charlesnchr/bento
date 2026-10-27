package com.charles.bento.widget

import com.charles.bento.AppGraph
import com.charles.bento.core.todo.TodoListView
import com.charles.bento.core.todo.TodoRow
import com.charles.bento.core.todo.TodoStore
import com.charles.bento.core.todo.due
import com.charles.bento.core.todo.isCompleted
import com.charles.bento.core.todo.name
import com.charles.bento.core.todo.priority
import com.charles.bento.core.todo.project
import com.charles.bento.core.todo.title
import com.charles.bento.ui.todo.SnapshotRepo
import com.charles.bento.ui.todo.decodeView

/** The widgets' view of the stores (snapshots: no engine-thread hop needed to read). */
class AppWidgetData(private val graph: AppGraph) : WidgetData {
    private var notesSource: WidgetNotes? = null

    /** Notes come from the notes module once it's wired. */
    interface WidgetNotes {
        fun notes(limit: Int): List<NoteCard>
        fun note(id: String): NoteCard?
        suspend fun toggleChecklistItem(noteId: String, line: Int)
    }

    fun attachNotes(n: WidgetNotes) { notesSource = n }

    override suspend fun notes(limit: Int) = notesSource?.notes(limit).orEmpty()
    override suspend fun note(id: String) = notesSource?.note(id)
    override suspend fun toggleChecklistItem(noteId: String, line: Int) { notesSource?.toggleChecklistItem(noteId, line) }

    override suspend fun tasks(view: String, limit: Int): TaskList {
        val todo = graph.todo
        val store = TodoStore(SnapshotRepo(todo.docs.value))
        val dates = todo.dates()
        val v = decodeView(view)
        val tasks = store.rows(v, false, dates).filterIsInstance<TodoRow.Task>().map { it.doc }.take(limit)
        val overdue = tasks.count { t -> t.due?.let(dates::isOverdue) == true }
        return TaskList(store.title(v), tasks.map { t ->
            TaskCard(
                id = t.id, title = t.title, due = t.due?.let(dates::label),
                overdue = t.due?.let(dates::isOverdue) == true, priority = t.priority,
                project = if (v is TodoListView.Project) null else t.project?.let { pid -> store.projects.firstOrNull { it.id == pid }?.name },
                completed = t.isCompleted,
            )
        }, overdue)
    }

    override suspend fun taskViews(): List<Pair<String, String>> {
        val store = TodoStore(SnapshotRepo(graph.todo.docs.value))
        return listOf("today" to "Today", "inbox" to "Inbox", "upcoming" to "Upcoming") +
            store.projects.map { "project:${it.id}" to it.name } + store.labels.map { "label:$it" to "@$it" }
    }

    override suspend fun toggleTask(id: String) {
        graph.todo.perform { toggleComplete(listOf(id)) }
    }
}
