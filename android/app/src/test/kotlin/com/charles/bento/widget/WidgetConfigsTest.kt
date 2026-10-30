package com.charles.bento.widget

import com.charles.bento.core.todo.TodoListView
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class WidgetConfigsTest {
    private val prefs = mutableMapOf<String, String>()
    private fun configs() = WidgetConfigs({ prefs[it] }, { k, v -> if (v == null) prefs.remove(k) else prefs[k] = v })

    @Test fun eachWidgetKeepsItsOwnList() {
        val c = configs()
        assertEquals("today", c.taskView(7))
        c.setTaskView(7, "inbox")
        c.setTaskView(9, "project:p1")
        assertEquals("inbox", c.taskView(7))
        assertEquals("project:p1", c.taskView(9))
        assertEquals("today", c.taskView(8))
        c.setNote(8, "n1")
        assertEquals("n1", c.note(8))
        assertNull(c.note(7))
        assertEquals("inbox", c.taskView(7))
    }

    @Test fun outlivesTheProcess() {
        configs().apply { setTaskView(3, "upcoming"); setNote(4, "n2") }
        // a new process reads the same preferences
        val c = configs()
        assertEquals("upcoming", c.taskView(3))
        assertEquals("n2", c.note(4))
    }

    @Test fun readsWidgetsConfiguredBefore() {
        prefs["widget.tasks.12"] = "label:errands"
        prefs["widget.note.13"] = "n3"
        val c = configs()
        assertEquals("label:errands", c.taskView(12))
        assertEquals("n3", c.note(13))
    }

    @Test fun changesTellRunningWidgets() {
        val c = configs()
        val before = c.changes.value
        c.setTaskView(1, "inbox")
        assertTrue(c.changes.value > before)
        val after = c.changes.value
        c.setNote(2, "n")
        assertTrue(c.changes.value > after)
    }

    @Test fun forgetsRemovedWidgetsOnly() {
        val c = configs()
        c.setTaskView(1, "inbox"); c.setNote(2, "n"); c.setTaskView(3, "upcoming")
        c.forget(intArrayOf(1, 2))
        assertEquals("today", c.taskView(1))
        assertNull(c.note(2))
        assertEquals("upcoming", c.taskView(3))
        assertEquals(setOf("widget.tasks.3"), prefs.keys)
    }

    @Test fun resolvesTheList() {
        val projects = listOf("p1")
        assertEquals(TodoListView.Today, WidgetConfigs.resolve("today", projects))
        assertEquals(TodoListView.Inbox, WidgetConfigs.resolve("inbox", projects))
        assertEquals(TodoListView.Upcoming, WidgetConfigs.resolve("upcoming", projects))
        assertEquals(TodoListView.Project("p1"), WidgetConfigs.resolve("project:p1", projects))
        assertEquals(TodoListView.Label("errands"), WidgetConfigs.resolve("label:errands", projects))
        // the project was deleted: back to Today rather than an empty list titled Inbox
        assertEquals(TodoListView.Today, WidgetConfigs.resolve("project:gone", projects))
        assertEquals(TodoListView.Today, WidgetConfigs.resolve("", projects))
    }

    @Test fun aDictatedTaskGoesIntoTheWidgetsList() {
        val projects = listOf("p1")
        assertEquals(TodoListView.Today, WidgetConfigs.addTo("today", projects))
        assertEquals(TodoListView.Label("errands"), WidgetConfigs.addTo("label:errands", projects))
        assertEquals(TodoListView.Project("p1"), WidgetConfigs.addTo("project:p1", projects))
        // as the widget shows it: Today once its project is gone
        assertEquals(TodoListView.Today, WidgetConfigs.addTo("project:gone", projects))
        // not from a task widget (the capture widget, a shortcut)
        assertEquals(TodoListView.Inbox, WidgetConfigs.addTo(null, projects))
    }

    @Test fun updatesGoToEachReceiversOwnWidget() {
        // a notes update must never reach a tasks widget's ids (and the other way round)
        val receivers = Widgets.dataWidgets.map { it.first }
        assertEquals(receivers.distinct(), receivers)
        assertEquals(setOf(NotesWidgetReceiver::class.java, NoteWidgetReceiver::class.java, TasksWidgetReceiver::class.java), receivers.toSet())
        Widgets.dataWidgets.forEach { (receiver, widget) ->
            assertEquals(receiver.getDeclaredConstructor().newInstance().glanceAppWidget::class, widget()::class, receiver.simpleName)
        }
    }
}
