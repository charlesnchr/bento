package com.charles.bento.core.todo

import com.charles.bento.core.fielddoc.FieldDoc
import com.charles.bento.core.fielddoc.FieldDocRepository
import com.charles.bento.core.fielddoc.SwiftText
import java.util.UUID
import kotlin.math.abs
import kotlin.math.max

/** What a new task gets when nothing in its text says otherwise (the view it's added in). */
data class TaskDefaults(val project: String? = null, val due: DueDate? = null, val label: String? = null)

/** Where a new task goes in its project's manual order. */
sealed class TaskAnchor {
    data object Top : TaskAnchor()
    data object Bottom : TaskAnchor()
    data class After(val id: String) : TaskAnchor()

    /** At the end of the group under this header row id (Today/Upcoming days): the bottom of its project. */
    data class EndOfGroup(val headerRowId: String) : TaskAnchor()
}

/**
 * The todo operations a UI needs, independent of any UI: Android screens, widgets and the
 * quick-add tile all call these. Port of the model-level commands of the Mac's
 * `TodoController` (quick add, complete, edit, move, reorder, schedule, labels, projects,
 * undo), with the same messages for toasts.
 *
 * Every change is a local change: documents are stamped with fresh field clocks, marked
 * dirty, carry [device], are saved in one [FieldDocRepository.saveAll], and [onLocalChange]
 * tells the sync transport to flush. Not thread safe: call from the dispatcher the sync
 * engine runs on.
 */
class TodoActions(
    val repo: FieldDocRepository,
    /** This device's name (the sync engine's `device`). */
    private val device: () -> String = { "" },
    /** Today, time zone and date text (labels in messages, default due dates). */
    private val dates: () -> TodoDates = { TodoDates() },
    /** A local change was saved: schedule a sync flush. */
    private val onLocalChange: () -> Unit = {},
) {
    val store = TodoStore(repo)

    /** A change that can be undone: show [message] (if any) with an Undo button calling [undo] with [id]. */
    data class Change(val id: String, val message: String?)

    /** One undoable change: each document before (null: created) and after it. */
    private class UndoEntry(val changes: List<Pair<FieldDoc?, FieldDoc>>, val message: String, val id: String = UUID.randomUUID().toString())

    private val undoStack = ArrayList<UndoEntry>()

    val canUndo: Boolean get() = undoStack.isNotEmpty()

    // MARK: Quick add

    /** Parses quick add text against the current projects and labels. */
    fun parse(text: String): QuickAddResult {
        val d = dates()
        return QuickAddParser.parse(text, store.projectNames, store.labels, d.now, d.zone)
    }

    /**
     * Adds a task from quick add text ("Buy milk tomorrow #Errands p1"); null when the text
     * is blank. `defaults` are the view's (see [addDefaults]).
     */
    fun quickAdd(text: String, defaults: TaskDefaults = TaskDefaults(), anchor: TaskAnchor = TaskAnchor.Bottom, notes: String = ""): FieldDoc? {
        val t = SwiftText.trimmingWhitespacesAndNewlines(text)
        if (t.isEmpty()) return null
        return createTask(parse(t), SwiftText.trimmingWhitespacesAndNewlines(notes), defaults, anchor)
    }

    /** What adding in `view` defaults to, and where the new task goes (the Mac's `beginAdd`). */
    fun addDefaults(view: TodoListView, top: Boolean = false, after: String? = null, groupDate: String? = null): Pair<TaskDefaults, TaskAnchor> {
        var d = TaskDefaults(project = view.projectID)
        var anchor: TaskAnchor = if (top) TaskAnchor.Top else TaskAnchor.Bottom
        val today = dates().today
        when (view) {
            TodoListView.Today -> d = d.copy(due = DueDate(today))
            is TodoListView.Label -> d = d.copy(label = view.name)
            TodoListView.Upcoming -> {
                // add to the day of the focused task's group, else today
                val day = groupDate ?: today
                d = d.copy(due = DueDate(day))
                anchor = TaskAnchor.EndOfGroup("h:$day")
            }
            else -> {}
        }
        if (after != null) anchor = TaskAnchor.After(after)
        return d to anchor
    }

    /** Applies quick-add results to a task. Unknown #projects stay in the title. */
    fun apply(p: QuickAddResult, t: FieldDoc, setTitle: Boolean) {
        var title = p.title
        p.project?.let { name ->
            val proj = store.projects.firstOrNull { SwiftText.caseInsensitiveEquals(it.name, name) }
            if (proj != null) {
                if (t.project != proj.id) {
                    t.setProject(proj.id)
                    t.setOrder(nextOrder(proj.id, top = false))
                }
            } else if (SwiftText.caseInsensitiveEquals(name, "inbox")) {
                t.setProject(null)
            } else {
                title += " #$name"
            }
        }
        if (p.labels.isNotEmpty()) {
            val known = store.labels
            val l = ArrayList(t.labels)
            for (x in p.labels) {
                val name = known.firstOrNull { SwiftText.caseInsensitiveEquals(it, x) } ?: x
                if (l.none { SwiftText.caseInsensitiveEquals(it, name) }) l += name
            }
            t.setLabels(l)
        }
        p.priority?.let { t.setPriority(it) }
        if (p.due != null) t.setDue(p.due) else if (p.clearDue) t.setDue(null)
        if (setTitle) t.setTitle(title.ifEmpty { t.title })
    }

    fun createTask(p: QuickAddResult, notes: String = "", defaults: TaskDefaults = TaskDefaults(), anchor: TaskAnchor = TaskAnchor.Bottom): FieldDoc {
        val project = defaults.project?.takeIf { repo.doc(it)?.isProject == true }
        val t = FieldDoc.newTask(
            title = p.title, project = project, labels = listOfNotNull(defaults.label),
            due = defaults.due, order = order(anchor, project), now = FieldDoc.now(),
        )
        t.device = device()
        apply(p, t, setTitle = true)
        if (notes.isNotEmpty()) t.setNotes(notes)
        t.dirty = true
        commit(listOf(t), listOf(null), null)
        return t
    }

    /** How saving an edit went. */
    sealed class EditResult {
        data object Saved : EditResult()
        data object Unchanged : EditResult()
        /** The task was deleted on another device meanwhile; the changed draft became this new task. */
        data class Recreated(val task: FieldDoc, val message: String) : EditResult()
        data object Gone : EditResult()
    }

    /**
     * Saves an edited task (title text with quick-add tokens, description). Only what the
     * user changed is written, so a title or description changed on another device meanwhile
     * isn't overwritten. `original*`: what the editor started with; `snapshot`: the task then.
     */
    fun saveEdit(id: String, text: String, notes: String, originalTitle: String, originalNotes: String, snapshot: FieldDoc? = null): EditResult {
        val t = SwiftText.trimmingWhitespacesAndNewlines(text)
        if (t.isEmpty()) return EditResult.Unchanged
        val n = SwiftText.trimmingWhitespacesAndNewlines(notes)
        val parsed = parse(t)
        val changedText = t != SwiftText.trimmingWhitespacesAndNewlines(originalTitle)
        val changedNotes = n != SwiftText.trimmingWhitespacesAndNewlines(originalNotes)
        if (store.task(id) == null) {
            // Deleted on another device while editing: a changed draft becomes a new task.
            if ((changedText || changedNotes) && snapshot != null) {
                val r = restoreDraft(snapshot, if (changedText) parsed else null, if (changedNotes) n else null)
                return EditResult.Recreated(r, "Deleted on another device, saved as a new task")
            }
            return EditResult.Gone
        }
        val c = mutate(listOf(id), null) { d ->
            if (changedText) apply(parsed, d, setTitle = true)
            if (changedNotes) d.setNotes(n)
        }
        return if (c != null) EditResult.Saved else EditResult.Unchanged
    }

    private fun restoreDraft(old: FieldDoc, parsed: QuickAddResult?, notes: String?): FieldDoc {
        val project = old.project?.takeIf { repo.doc(it)?.isProject == true }
        val t = FieldDoc.newTask(
            title = old.title, project = project, labels = old.labels, priority = old.priority,
            due = old.due, order = order(TaskAnchor.Bottom, project), now = FieldDoc.now(),
        )
        t.device = device()
        (notes ?: old.notes.ifEmpty { null })?.let { t.setNotes(it) }
        parsed?.let { apply(it, t, setTitle = true) }
        t.dirty = true
        commit(listOf(t), listOf(null), "Deleted on another device, saved as a new task")
        return t
    }

    // MARK: Order

    /**
     * Fractional orders halve a gap on every insert between the same neighbours; after ~50
     * they run out of precision. Respace a project's tasks before that happens.
     */
    private fun renumberIfCrowded(project: String?) {
        val siblings = store.tasks.filter { it.project == project }.sortedWith(TodoQuery.comparator(TodoQuery::manualOrder))
        val crowded = siblings.zipWithNext().any { (a, b) -> b.order - a.order < 1e-6 * max(1.0, abs(a.order)) }
        if (!crowded) return
        val out = ArrayList<FieldDoc>()
        for ((i, t) in siblings.withIndex()) {
            val d = t.copy()
            d.setOrder((i + 1) * 1024.0)
            d.dirty = true
            d.device = device()
            if (d != t) out += d
        }
        repo.saveAll(out)
        onLocalChange()
    }

    private fun order(anchor: TaskAnchor, project: String?): Double {
        renumberIfCrowded(project)
        return when (anchor) {
            TaskAnchor.Top -> nextOrder(project, top = true)
            TaskAnchor.Bottom, is TaskAnchor.EndOfGroup -> nextOrder(project, top = false)
            is TaskAnchor.After -> {
                val a = store.task(anchor.id)
                if (a == null || a.project != project) return nextOrder(project, top = false)
                val siblings = store.tasks.filter { it.project == project && !it.isCompleted }
                    .sortedWith(TodoQuery.comparator(TodoQuery::manualOrder))
                val next = siblings.dropWhile { it.id != anchor.id }.drop(1).firstOrNull()
                TodoQuery.order(a.order, next?.order)
            }
        }
    }

    fun nextOrder(project: String?, top: Boolean): Double {
        val orders = store.tasks.filter { it.project == project }.map { it.order }
        return if (top) TodoQuery.order(null, orders.minOrNull()) else TodoQuery.order(orders.maxOrNull(), null)
    }

    // MARK: Mutations

    /** Applies `f` to each document as a local change, with undo. Null when nothing changed. */
    fun mutate(ids: List<String>, message: String?, f: (FieldDoc) -> Unit): Change? {
        val changed = ArrayList<FieldDoc>()
        val previous = ArrayList<FieldDoc?>()
        for (id in ids) {
            val old = repo.doc(id) ?: continue
            val d = old.copy()
            f(d)
            if (d == old) continue
            d.dirty = true
            d.device = device()
            changed += d
            previous += old
        }
        if (changed.isEmpty()) return null
        return commit(changed, previous, message)
    }

    private fun commit(docs: List<FieldDoc>, previous: List<FieldDoc?>, message: String?): Change {
        val entry = UndoEntry(previous.zip(docs), message ?: "Change")
        undoStack += entry
        if (undoStack.size > 100) repeat(undoStack.size - 100) { undoStack.removeAt(0) }
        repo.saveAll(docs)
        onLocalChange()
        return Change(entry.id, message)
    }

    /** Reverts the newest change, or the one with `id` (a toast's Undo button). Returns the message to show. */
    fun undo(id: String? = null): String {
        val i = if (id != null) undoStack.indexOfLast { it.id == id } else undoStack.size - 1
        if (i < 0) return if (id == null) "Nothing to undo" else "Already undone"
        val entry = undoStack.removeAt(i)
        val out = ArrayList<FieldDoc>()
        for ((before, after) in entry.changes) {
            val cur = repo.doc(after.id) ?: continue
            val d = restore(cur, before, after) ?: continue
            d.device = device()
            out += d
        }
        repo.saveAll(out)
        onLocalChange()
        return "Undone: ${entry.message}"
    }

    private fun plural(n: Int, s: String) = if (n == 1) "1 $s" else "$n ${s}s"

    /** Completes the tasks, or reopens them when all of them are completed. */
    fun toggleComplete(ids: List<String>): Change? {
        if (ids.isEmpty()) return null
        val completing = ids.any { store.task(it)?.isCompleted == false }
        val now = FieldDoc.now()
        val message = if (completing) (if (ids.size == 1) "Task completed" else "${ids.size} tasks completed")
        else "Marked ${plural(ids.size, "task")} not done"
        return mutate(ids, message) { it.setCompleted(if (completing) now else null) }
    }

    fun setCompleted(ids: List<String>, completed: Boolean): Change? {
        val now = FieldDoc.now()
        val message = if (completed) (if (ids.size == 1) "Task completed" else "${ids.size} tasks completed")
        else "Marked ${plural(ids.size, "task")} not done"
        return mutate(ids, message) { t -> if (completed != t.isCompleted) t.setCompleted(if (completed) now else null) }
    }

    fun setDue(due: DueDate?, ids: List<String>): Change? {
        if (ids.isEmpty()) return null
        val d = dates()
        return mutate(ids, due?.let { "Scheduled for ${d.label(it)}" } ?: "Date removed") { it.setDue(due) }
    }

    fun setPriority(p: Int, ids: List<String>): Change? {
        if (ids.isEmpty()) return null
        return mutate(ids, "Priority $p") { it.setPriority(p) }
    }

    fun setTitle(id: String, title: String): Change? = mutate(listOf(id), null) { it.setTitle(title) }

    fun setDescription(id: String, notes: String): Change? = mutate(listOf(id), null) { it.setNotes(notes) }

    fun setLabels(ids: List<String>, labels: List<String>): Change? = mutate(ids, null) { it.setLabels(labels) }

    /** The label picker: adds `name` to every task, or removes it when `remove` (all of them had it). */
    fun toggleLabel(ids: List<String>, name: String, remove: Boolean): Change? = mutate(ids, null) { t ->
        val l = ArrayList(t.labels)
        if (remove) l.removeAll { it == name } else if (name !in l) l += name
        t.setLabels(l)
    }

    fun move(ids: List<String>, project: String?): Change? {
        var order = nextOrder(project, top = false)
        return mutate(ids, "Moved to ${store.projectName(project)}") { t ->
            if (t.project == project) return@mutate
            t.setProject(project)
            t.setOrder(order)
            order += 1024
        }
    }

    fun delete(ids: List<String>): Change? {
        if (ids.isEmpty()) return null
        return mutate(ids, if (ids.size == 1) "Task deleted" else "${ids.size} tasks deleted") { it.markDeleted() }
    }

    /** How a reorder went. */
    enum class ReorderResult { MOVED, NOT_MANUAL_ORDER, NO_MOVE }

    /**
     * Moves a task one place up (`delta` -1) or down (+1) among the open tasks of a manually
     * ordered view (the Mac's ⌥↑/⌥↓). Message for NOT_MANUAL_ORDER: "Tasks are sorted by date here".
     */
    fun reorder(id: String, delta: Int, view: TodoListView): ReorderResult {
        if (!view.isManualOrder) return ReorderResult.NOT_MANUAL_ORDER
        renumberIfCrowded(store.task(id)?.project)
        val list = store.rows(view, showCompleted = false, dates = dates()).mapNotNull { it.task }.filter { !it.isCompleted }
        val i = list.indexOfFirst { it.id == id }
        if (i < 0) return ReorderResult.NO_MOVE
        val j = i + delta
        if (j !in list.indices) return ReorderResult.NO_MOVE
        // place beyond the neighbour: between it and the one after it
        val neighbour = list[j]
        val beyond = list.getOrNull(j + delta)?.order
        val o = if (delta < 0) TodoQuery.order(beyond, neighbour.order) else TodoQuery.order(neighbour.order, beyond)
        mutate(listOf(id), null) { it.setOrder(o) }
        return ReorderResult.MOVED
    }

    /**
     * Drag and drop: puts a task between two tasks of its project (`afterId` above it,
     * `beforeId` below it; null at either end). One document is rewritten.
     */
    fun moveTask(id: String, afterId: String?, beforeId: String?): Change? {
        val t = store.task(id) ?: return null
        renumberIfCrowded(t.project)
        val above = afterId?.let { store.task(it) }
        val below = beforeId?.let { store.task(it) }
        val o = TodoQuery.order(above?.order, below?.order)
        return mutate(listOf(id), null) { it.setOrder(o) }
    }

    // MARK: Projects

    fun createProject(name: String, color: String = "grey"): FieldDoc {
        val order = (store.projects.maxOfOrNull { it.order } ?: 0.0) + 1024
        val p = FieldDoc.newProject(name, color, order)
        p.device = device()
        p.dirty = true
        commit(listOf(p), listOf(null), "Project “$name” created")
        return p
    }

    fun renameProject(id: String, name: String): Change? {
        val n = SwiftText.trimmingWhitespaces(name)
        if (n.isEmpty()) return null
        return mutate(listOf(id), "Renamed") { it.setName(n) }
    }

    fun setProjectColor(id: String, color: String): Change? = mutate(listOf(id), null) { it.setColor(color) }

    fun setArchived(id: String, archived: Boolean): Change? =
        mutate(listOf(id), if (archived) "Archived" else "Unarchived") { it.setArchived(archived) }

    /** Moves a project one place up/down among the non-archived ones (the sidebar order). */
    fun moveProject(id: String, delta: Int): Change? {
        val list = store.projects.filter { !it.archived }
        val i = list.indexOfFirst { it.id == id }
        if (i < 0 || (i + delta) !in list.indices) return null
        val j = i + delta
        val beyond = list.getOrNull(j + delta)?.order
        val o = if (delta < 0) TodoQuery.order(beyond, list[j].order) else TodoQuery.order(list[j].order, beyond)
        return mutate(listOf(id), null) { it.setOrder(o) }
    }

    /** Deletes a project and its tasks. */
    fun deleteProject(id: String): Change? {
        val p = repo.doc(id)?.takeIf { it.isProject } ?: return null
        val ids = listOf(id) + repo.allDocs.filter { it.isTask && it.project == id }.map { it.id }
        return mutate(ids, "Project “${p.name}” deleted") { it.markDeleted() }
    }

    // MARK: Labels

    /** Renames a label on every task that has it (case-insensitively), deduplicating. */
    fun renameLabel(old: String, new: String): Change? {
        val ids = store.tasks.filter { t -> t.labels.any { SwiftText.caseInsensitiveEquals(it, old) } }.map { it.id }
        return mutate(ids, "Label renamed") { t ->
            val seen = HashSet<String>()
            t.setLabels(t.labels.map { if (SwiftText.caseInsensitiveEquals(it, old)) new else it }.filter { seen.add(SwiftText.lowercased(it)) })
        }
    }

    fun deleteLabel(name: String): Change? {
        val ids = store.tasks.filter { t -> t.labels.any { SwiftText.caseInsensitiveEquals(it, name) } }.map { it.id }
        return mutate(ids, "Label @$name removed") { t -> t.setLabels(t.labels.filter { !SwiftText.caseInsensitiveEquals(it, name) }) }
    }

    companion object {
        /** A label name as the Mac's rename prompt makes it: trimmed, spaces as underscores. */
        fun labelName(input: String): String = SwiftText.trimmingWhitespaces(input).replace(" ", "_")

        /**
         * Reverts what one change did (`before` → `after`) to the document as it is now
         * (`cur`), as a new local change with fresh clocks so it wins everywhere. Only the
         * fields that change touched, and only where they still hold the value it wrote:
         * edits made since, here or on another device, are kept. Null when there is nothing
         * left to revert.
         */
        fun restore(cur: FieldDoc, before: FieldDoc?, after: FieldDoc): FieldDoc? {
            val d = cur.copy()
            val c = FieldDoc.nextClock(cur.updatedAt, cur.maxClock)
            if (before == null) {
                // undo a creation
                if (cur.deleted) return null
                d.markDeleted(c)
                d.dirty = true
                return d
            }
            if (after.deleted && !before.deleted) {
                // undo a deletion
                if (!cur.deleted) return null
                d.deleted = false
                d.type = before.type
                d.fields = before.fields
                d.clocks = d.clocks + before.fields.keys.associateWith { c }
                d.updatedAt = c
                d.dirty = true
                return d
            }
            if (cur.deleted) return null
            for (k in before.fields.keys + after.fields.keys) {
                if (before.fields[k] != after.fields[k] && cur.fields[k] == after.fields[k]) {
                    d.set(k, before.fields[k] ?: com.charles.bento.core.json.JSONValue.Null, c)
                }
            }
            if (d == cur) return null
            d.dirty = true
            return d
        }
    }
}
