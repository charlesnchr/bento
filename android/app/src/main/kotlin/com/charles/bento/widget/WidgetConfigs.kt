package com.charles.bento.widget

import com.charles.bento.core.todo.TodoListView
import com.charles.bento.ui.todo.decodeView
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

/**
 * What each placed widget shows, by app widget id: a task widget's list, a note widget's note.
 * In the app's preferences, so it outlives the process, app updates and reboots.
 */
class WidgetConfigs(private val get: (String) -> String?, private val put: (String, String?) -> Unit) {
    private val _changes = MutableStateFlow(0L)
    /** Bumped on every change: running widget sessions collect it and redraw. */
    val changes: StateFlow<Long> = _changes

    /** The stored view id ("today", "inbox", "upcoming", "project:<id>", "label:<name>"). */
    fun taskView(appWidgetId: Int): String = get(tasksKey(appWidgetId)) ?: TODAY
    fun setTaskView(appWidgetId: Int, view: String) = set(tasksKey(appWidgetId), view)

    fun note(appWidgetId: Int): String? = get(noteKey(appWidgetId))
    fun setNote(appWidgetId: Int, noteId: String) = set(noteKey(appWidgetId), noteId)

    /** Widgets removed from the home screen. */
    fun forget(appWidgetIds: IntArray) {
        appWidgetIds.forEach { put(tasksKey(it), null); put(noteKey(it), null) }
        _changes.update { it + 1 }
    }

    private fun set(key: String, value: String) {
        put(key, value)
        _changes.update { it + 1 }
    }

    companion object {
        const val TODAY = "today"

        // the keys the first widgets were configured under
        fun tasksKey(appWidgetId: Int) = "widget.tasks.$appWidgetId"
        fun noteKey(appWidgetId: Int) = "widget.note.$appWidgetId"

        /** The list a task widget shows: its stored view, or Today once its project is gone. */
        fun resolve(view: String, projectIds: Collection<String>): TodoListView =
            when (val v = decodeView(view)) {
                is TodoListView.Project -> if (v.id in projectIds) v else TodoListView.Today
                else -> v
            }
    }
}
