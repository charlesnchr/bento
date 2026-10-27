package com.charles.bento.core.todo

import com.charles.bento.core.fielddoc.FieldDoc
import com.charles.bento.core.fielddoc.InMemoryFieldDocRepository
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The UI-independent todo operations (the Mac's TodoController commands). */
class TodoActionsTest {
    private val repo = InMemoryFieldDocRepository()
    private var flushes = 0
    private var ms = Fixed.now.toEpochMilli()
    private val actions = TodoActions(repo, device = { "pixel" }, dates = { TodoDates(Fixed.zone, Fixed.now, Fixed.gb) }, onLocalChange = { flushes++ })

    @BeforeTest fun clock() {
        FieldDoc.clock = { ms++ }
    }

    @AfterTest fun restoreClock() {
        FieldDoc.clock = { System.currentTimeMillis() }
    }

    private fun tasks() = actions.store.tasks

    @Test fun quickAddUsesProjectsLabelsAndDates() {
        val work = actions.createProject("Work", "blue")
        actions.quickAdd("Old label @Errands")
        val t = actions.quickAdd("Call mom tomorrow 5pm #work @errands p2", TaskDefaults(label = "phone"))!!
        assertEquals("Call mom", t.title)
        assertEquals(work.id, t.project)
        assertEquals(listOf("phone", "Errands"), t.labels) // the existing spelling
        assertEquals(2, t.priority)
        assertEquals(DueDate("2026-10-22", "17:00"), t.due)
        assertTrue(t.dirty && t.device == "pixel")
        assertTrue(flushes >= 2)
        // unknown projects stay in the title; "#inbox" means no project
        assertEquals("Buy milk #Shop", actions.quickAdd("Buy milk #Shop")!!.title)
        assertNull(actions.quickAdd("x #inbox", TaskDefaults(project = work.id))!!.project)
        assertNull(actions.quickAdd("   "))
    }

    @Test fun addDefaultsFollowTheView() {
        val (today, top) = actions.addDefaults(TodoListView.Today, top = true)
        assertEquals(DueDate("2026-10-21"), today.due)
        assertEquals(TaskAnchor.Top, top)
        val (up, anchor) = actions.addDefaults(TodoListView.Upcoming, groupDate = "2026-10-24")
        assertEquals(DueDate("2026-10-24"), up.due)
        assertEquals(TaskAnchor.EndOfGroup("h:2026-10-24"), anchor)
        assertEquals("home", actions.addDefaults(TodoListView.Label("home")).first.label)
        assertEquals("p", actions.addDefaults(TodoListView.Project("p")).first.project)
    }

    @Test fun completeAndUndo() {
        val t = actions.quickAdd("Task")!!
        val c = actions.toggleComplete(listOf(t.id))!!
        assertEquals("Task completed", c.message)
        assertTrue(actions.store.task(t.id)!!.isCompleted)
        assertEquals("Undone: Task completed", actions.undo(c.id))
        assertFalse(actions.store.task(t.id)!!.isCompleted)
        assertEquals("Already undone", actions.undo(c.id))
        actions.toggleComplete(listOf(t.id))
        assertEquals("Marked 1 task not done", actions.toggleComplete(listOf(t.id))!!.message)
    }

    @Test fun undoKeepsEditsMadeSince() {
        val t = actions.quickAdd("Task")!!
        val c = actions.setPriority(1, listOf(t.id))!!
        actions.setTitle(t.id, "Renamed elsewhere")
        actions.undo(c.id)
        val now = actions.store.task(t.id)!!
        assertEquals(4, now.priority)
        assertEquals("Renamed elsewhere", now.title)
        // undoing a creation deletes the task
        actions.undo()
        actions.undo()
        assertNull(actions.store.task(t.id))
        assertEquals("Nothing to undo", actions.undo())
    }

    @Test fun scheduleMoveDelete() {
        val p = actions.createProject("Home")
        val a = actions.quickAdd("A")!!
        val b = actions.quickAdd("B")!!
        assertEquals("Scheduled for Tomorrow", actions.setDue(DueDate("2026-10-22"), listOf(a.id))!!.message)
        assertEquals("Date removed", actions.setDue(null, listOf(a.id))!!.message)
        assertEquals("Moved to Home", actions.move(listOf(a.id, b.id), p.id)!!.message)
        val moved = listOf(a, b).map { actions.store.task(it.id)!! }
        assertTrue(moved.all { it.project == p.id })
        assertEquals(1024.0, moved[1].order - moved[0].order)
        assertEquals("2 tasks deleted", actions.delete(listOf(a.id, b.id))!!.message)
        assertTrue(tasks().isEmpty())
    }

    @Test fun reorderAndDragPlaceBetweenNeighbours() {
        val a = actions.quickAdd("A")!!
        val b = actions.quickAdd("B")!!
        val c = actions.quickAdd("C")!!
        fun inbox() = actions.store.rows(TodoListView.Inbox, dates = TodoDates(Fixed.zone, Fixed.now, Fixed.gb)).mapNotNull { it.task?.title }
        assertEquals(listOf("A", "B", "C"), inbox())
        assertEquals(TodoActions.ReorderResult.MOVED, actions.reorder(c.id, -1, TodoListView.Inbox))
        assertEquals(listOf("A", "C", "B"), inbox())
        assertEquals(TodoActions.ReorderResult.NO_MOVE, actions.reorder(a.id, -1, TodoListView.Inbox))
        assertEquals(TodoActions.ReorderResult.NOT_MANUAL_ORDER, actions.reorder(a.id, 1, TodoListView.Today))
        actions.moveTask(a.id, afterId = b.id, beforeId = null)
        assertEquals(listOf("C", "B", "A"), inbox())
        // after ~50 halvings the gaps are respaced instead of running out of precision
        repeat(60) { actions.moveTask(a.id, afterId = c.id, beforeId = b.id); actions.moveTask(b.id, afterId = c.id, beforeId = a.id) }
        assertEquals(3, inbox().size)
        val orders = tasks().map { it.order }.sorted()
        assertTrue(orders.zipWithNext().all { (x, y) -> y - x > 1e-6 }, "$orders")
    }

    @Test fun addAfterATaskGoesBetween() {
        val a = actions.quickAdd("A")!!
        actions.quickAdd("C")
        actions.quickAdd("B", anchor = TaskAnchor.After(a.id))
        assertEquals(listOf("A", "B", "C"), actions.store.rows(TodoListView.Inbox).mapNotNull { it.task?.title })
        actions.quickAdd("Top", anchor = TaskAnchor.Top)
        assertEquals("Top", actions.store.rows(TodoListView.Inbox).first().task?.title)
    }

    @Test fun projectsAndLabels() {
        val p = actions.createProject("Work")
        val q = actions.createProject("Home")
        assertEquals(listOf("Work", "Home"), actions.store.projectNames)
        actions.moveProject(q.id, -1)
        assertEquals(listOf("Home", "Work"), actions.store.projectNames)
        assertEquals("Renamed", actions.renameProject(p.id, "  Job ")!!.message)
        assertEquals("Job", actions.store.projectName(p.id))
        actions.setProjectColor(p.id, "teal")
        assertEquals("teal", repo.doc(p.id)!!.color)
        assertEquals("Archived", actions.setArchived(p.id, true)!!.message)
        assertEquals(listOf("Home"), actions.store.projectNames)
        val t = actions.quickAdd("x @Old @keep", TaskDefaults(project = p.id))!!
        assertEquals("Label renamed", actions.renameLabel("old", "new")!!.message)
        assertEquals(listOf("new", "keep"), actions.store.task(t.id)!!.labels)
        actions.toggleLabel(listOf(t.id), "keep", remove = true)
        assertEquals(listOf("new"), actions.store.task(t.id)!!.labels)
        assertEquals("Label @NEW removed", actions.deleteLabel("NEW")!!.message)
        assertEquals(emptyList(), actions.store.task(t.id)!!.labels)
        assertEquals("Project “Job” deleted", actions.deleteProject(p.id)!!.message)
        assertNull(actions.store.task(t.id))
        assertEquals("a_b", TodoActions.labelName(" a b "))
    }

    @Test fun editsWriteOnlyWhatChangedAndSurviveARemoteDeletion() {
        val t = actions.quickAdd("Title")!!
        actions.setDescription(t.id, "notes from the Mac")
        val snapshot = actions.store.task(t.id)!!
        assertIs<TodoActions.EditResult.Saved>(actions.saveEdit(t.id, "New title p1", "notes from the Mac", "Title", "notes from the Mac", snapshot))
        val edited = actions.store.task(t.id)!!
        assertEquals("New title", edited.title)
        assertEquals(1, edited.priority)
        assertEquals(snapshot.clocks["description"], edited.clocks["description"]) // untouched
        // deleted on another device while editing: the changed draft becomes a new task
        repo.save(repo.doc(t.id)!!.apply { markDeleted() }, remote = true)
        val r = actions.saveEdit(t.id, "Draft", "", "New title", "notes from the Mac", edited)
        assertIs<TodoActions.EditResult.Recreated>(r)
        assertEquals("Draft", r.task.title)
        assertEquals(1, r.task.priority)
        assertNotNull(actions.store.task(r.task.id))
    }
}
