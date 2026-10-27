package com.charles.bento.core.todo

import com.charles.bento.core.fielddoc.FieldDoc
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val dates = TodoDates(Fixed.zone, Fixed.now, Fixed.gb)

private fun t(
    title: String, due: String? = null, time: String? = null, project: String? = null, labels: List<String> = emptyList(),
    priority: Int = 4, order: Double = 0.0, done: Boolean = false,
): FieldDoc {
    val d = FieldDoc.newTask(title, project, labels, priority, due?.let { DueDate(it, time) }, order, now = 1000)
    d.id = title
    if (done) d.setCompleted(Fixed.now.toEpochMilli(), 2000)
    return d
}

private fun titles(rows: List<TodoRow>) = rows.map { r ->
    when (r) {
        is TodoRow.Header -> "[${r.title}]"
        is TodoRow.Task -> r.doc.title
    }
}

/** Port of Tests/TodoTests/ModelTests.swift (the AppKit key routing suite stays on the Mac). */
class TodoModelTest {
    private val project = FieldDoc.newProject("Work", order = 1.0, now = 1).also { it.id = "work" }

    // Queries
    @Test fun todayGroupsOverdueThenTodayByTimeAndPriority() {
        val tasks = listOf(
            t("late", due = "2026-10-19"), t("p1", due = "2026-10-21", priority = 1), t("nine", due = "2026-10-21", time = "09:00"),
            t("p4", due = "2026-10-21"), t("tomorrow", due = "2026-10-22"), t("none"),
        )
        val rows = TodoQuery.rows(TodoListView.Today, tasks, emptyList(), false, dates)
        assertEquals(listOf("[Overdue]", "late", "[Wed 21 Oct]", "nine", "p1", "p4"), titles(rows))
    }

    @Test fun upcomingShowsEveryDayOfTheWeekThenLaterDaysWithTasks() {
        val tasks = listOf(t("fri", due = "2026-10-23"), t("dec", due = "2026-12-01"))
        val rows = TodoQuery.rows(TodoListView.Upcoming, tasks, emptyList(), false, dates)
        assertEquals(8, rows.count { it.task == null })
        assertEquals(listOf("[Tue 1 Dec]", "dec"), titles(rows).takeLast(2))
        assertTrue("fri" in titles(rows))
    }

    @Test fun inboxProjectsAndCompleted() {
        val tasks = listOf(t("b", order = 2.0), t("a", order = 1.0), t("w", project = "work"), t("orphan", project = "gone", order = 3.0), t("done", done = true))
        assertEquals(listOf("a", "b", "orphan"), titles(TodoQuery.rows(TodoListView.Inbox, tasks, listOf(project), false, dates)))
        assertEquals(listOf("a", "b", "orphan", "[Completed]", "done"), titles(TodoQuery.rows(TodoListView.Inbox, tasks, listOf(project), true, dates)))
        assertEquals(listOf("w"), titles(TodoQuery.rows(TodoListView.Project("work"), tasks, listOf(project), false, dates)))
    }

    @Test fun searchMatchesTitleLabelsAndProject() {
        val tasks = listOf(t("Email Bob", labels = listOf("admin")), t("Ship it", project = "work"), t("Other"))
        fun s(q: String) = titles(TodoQuery.rows(TodoListView.Search(q), tasks, listOf(project), false, dates))
        assertEquals(listOf("Email Bob"), s("bob"))
        assertEquals(listOf("Email Bob"), s("@admin"))
        assertEquals(listOf("Ship it"), s("#work"))
        assertEquals(emptyList(), s(""))
    }

    @Test fun countsAndOrderBetween() {
        val tasks = listOf(t("a", due = "2026-10-20"), t("b", due = "2026-10-21", project = "work"), t("c"))
        val c = TodoQuery.counts(tasks, listOf(project), dates)
        assertTrue(c.inbox == 2 && c.today == 2 && c.overdue == 1 && c.byProject["work"] == 1, "$c")
        assertEquals(2.0, TodoQuery.order(1.0, 3.0))
        assertTrue(TodoQuery.order(null, 100.0) < 100)
        assertTrue(TodoQuery.order(100.0, null) > 100)
    }

    @Test fun labels() {
        assertEquals("Today", dates.label(DueDate("2026-10-21")))
        assertEquals("Tomorrow", dates.label(DueDate("2026-10-22")))
        assertEquals("Tomorrow", dates.header("2026-10-22").second)
        assertTrue(dates.isOverdue(DueDate("2026-10-21", "09:00")))
        assertFalse(dates.isOverdue(DueDate("2026-10-21", "11:00")))
    }

    // Undo
    @Test fun undoRevertsOnlyWhatTheChangeTouched() {
        val before = t("x")
        val after = before.copy().apply { setCompleted(5000, 5000) }
        val cur = after.copy().apply { setTitle("renamed on the phone", 6000) }
        val r = TodoActions.restore(cur, before, after)!!
        assertTrue(r.completedAt == null && r.title == "renamed on the phone" && r.dirty)
        assertTrue(r.clocks.getValue("completed_at") > 6000)
        // the field was changed again since: nothing left to revert
        val again = after.copy().apply { setCompleted(7000, 7000) }
        assertNull(TodoActions.restore(again, before, after))
    }

    @Test fun undoDeletionAndCreation() {
        val before = t("x")
        val after = before.copy().apply { markDeleted(6000) }
        val back = TodoActions.restore(after, before, after)!!
        assertTrue(!back.deleted && back.title == "x" && back.maxClock > 6000)
        assertTrue(TodoActions.restore(before, null, before)!!.deleted)
        assertNull(TodoActions.restore(after, null, before))
    }

    // Archived
    @Test fun archivedProjectTasksOnlyShowInTheirProject() {
        val p = FieldDoc.newProject("Old", order = 1.0, now = 1)
        p.id = "old"
        p.setArchived(true, 2)
        val tasks = listOf(t("kept", due = "2026-10-21", project = "old"), t("inbox", due = "2026-10-21"))
        assertEquals(listOf("inbox"), titles(TodoQuery.rows(TodoListView.Inbox, tasks, listOf(p), false, dates)))
        assertEquals(listOf("inbox"), titles(TodoQuery.rows(TodoListView.Today, tasks, listOf(p), false, dates)))
        assertEquals(listOf("kept"), titles(TodoQuery.rows(TodoListView.Project("old"), tasks, listOf(p), false, dates)))
        val c = TodoQuery.counts(tasks, listOf(p), dates)
        assertTrue(c.inbox == 1 && c.today == 1)
    }

    // Typed accessors
    @Test fun typedAccessorsAndDefaults() {
        val d = FieldDoc(type = TodoKind.TASK, createdAt = 77)
        assertEquals("", d.title)
        assertEquals(4, d.priority)
        assertEquals(77.0, d.order)
        assertNull(d.project)
        assertNull(d.due)
        assertFalse(d.isCompleted)
        d.setPriority(9, 100)
        assertEquals(4, d.priority)
        d.setPriority(0, 101)
        assertEquals(1, d.priority)
        d.setLabels(listOf("a", "b"), 102)
        assertEquals(listOf("a", "b"), d.labels)
        val p = FieldDoc(type = TodoKind.PROJECT, createdAt = 1)
        assertEquals("grey", p.color)
        assertFalse(p.archived)
        assertTrue(p.isProject && !p.isTask)
        p.markDeleted(5)
        assertFalse(p.isProject)
    }

    @Test fun styleData() {
        assertEquals(17, TodoStyle.palette.size)
        assertEquals("Berry Red", TodoStyle.title("berry_red"))
        assertEquals(0xFFD1453B.toInt(), TodoStyle.priority(1)!!.argb)
        assertNull(TodoStyle.priority(4))
        assertNotNull(TodoStyle.due(DueDate("2026-10-20"), dates))
    }
}
