package com.charles.bento.core.todo

import com.charles.bento.core.fielddoc.FieldDoc
import com.charles.bento.core.fielddoc.FieldDocCollectionSync
import com.charles.bento.core.fielddoc.FieldDocRepository
import com.charles.bento.core.json.JSONValue
import kotlin.math.max
import kotlin.math.min

/**
 * A synced todo document: a task or a project (`collection: "todos"`), see "Todo documents"
 * in docs/SYNC_PROTOCOL.md. The typed accessors below port the Mac's `TodoDoc` extension.
 */
typealias TodoDoc = FieldDoc

object TodoKind {
    const val TASK = "task"
    const val PROJECT = "project"
}

/** The wire collection of todo documents. */
const val TODO_COLLECTION = "todos"

val FieldDoc.isTask: Boolean get() = !deleted && type == TodoKind.TASK
val FieldDoc.isProject: Boolean get() = !deleted && type == TodoKind.PROJECT

// Tasks
val FieldDoc.title: String get() = fields["title"]?.string ?: ""

/** The task's description (wire field `description`; the Mac calls it `notes`). */
val FieldDoc.notes: String get() = fields["description"]?.string ?: ""

/** Project id; null = Inbox. */
val FieldDoc.project: String? get() = fields["project"]?.string

val FieldDoc.labels: List<String> get() = (fields["labels"] as? JSONValue.Arr)?.items?.mapNotNull { it.string } ?: emptyList()

/** 1 = p1 (highest) … 4 = p4 (none). */
val FieldDoc.priority: Int
    get() {
        val p = fields["priority"]?.double ?: return 4
        return if (p >= 1 && p <= 4) p.toInt() else 4
    }

val FieldDoc.due: DueDate?
    get() {
        val o = (fields["due"] as? JSONValue.Obj)?.fields ?: return null
        val d = o["date"]?.string
        if (d.isNullOrEmpty()) return null
        return DueDate(d, o["time"]?.string)
    }

val FieldDoc.completedAt: Long? get() = fields["completed_at"]?.int64
val FieldDoc.isCompleted: Boolean get() = completedAt != null
val FieldDoc.order: Double get() = fields["order"]?.double ?: createdAt.toDouble()

// Projects
val FieldDoc.name: String get() = fields["name"]?.string ?: ""
val FieldDoc.color: String get() = fields["color"]?.string ?: "grey"
val FieldDoc.archived: Boolean get() = fields["archived"]?.bool ?: false

fun FieldDoc.setTitle(s: String, at: Long? = null) = set("title", JSONValue.Str(s), at)
fun FieldDoc.setNotes(s: String, at: Long? = null) = set("description", JSONValue.Str(s), at)
fun FieldDoc.setProject(id: String?, at: Long? = null) = set("project", id?.let { JSONValue.Str(it) } ?: JSONValue.Null, at)
fun FieldDoc.setLabels(l: List<String>, at: Long? = null) = set("labels", JSONValue.Arr(l.map { JSONValue.Str(it) }), at)
fun FieldDoc.setPriority(p: Int, at: Long? = null) = set("priority", JSONValue.Number(min(4, max(1, p)).toDouble()), at)

fun FieldDoc.setDue(d: DueDate?, at: Long? = null) {
    if (d == null) { set("due", JSONValue.Null, at); return }
    val o = LinkedHashMap<String, JSONValue>()
    o["date"] = JSONValue.Str(d.date)
    d.time?.let { o["time"] = JSONValue.Str(it) }
    set("due", JSONValue.Obj(o), at)
}

fun FieldDoc.setCompleted(ms: Long?, at: Long? = null) = set("completed_at", ms?.let { JSONValue.Number(it.toDouble()) } ?: JSONValue.Null, at)
fun FieldDoc.setOrder(o: Double, at: Long? = null) = set("order", JSONValue.Number(o), at)
fun FieldDoc.setName(s: String, at: Long? = null) = set("name", JSONValue.Str(s), at)
fun FieldDoc.setColor(s: String, at: Long? = null) = set("color", JSONValue.Str(s), at)
fun FieldDoc.setArchived(b: Boolean, at: Long? = null) = set("archived", JSONValue.Bool(b), at)

/** A new task with every field stamped, so a field never merges against "no clock". */
fun FieldDoc.Companion.newTask(
    title: String, project: String? = null, labels: List<String> = emptyList(), priority: Int = 4,
    due: DueDate? = null, order: Double, now: Long = FieldDoc.now(),
): FieldDoc {
    val d = FieldDoc(type = TodoKind.TASK, createdAt = now)
    d.setTitle(title, now)
    d.setProject(project, now)
    d.setLabels(labels, now)
    d.setPriority(priority, now)
    d.setDue(due, now)
    d.setOrder(order, now)
    d.updatedAt = now
    return d
}

fun FieldDoc.Companion.newProject(name: String, color: String = "grey", order: Double, now: Long = FieldDoc.now()): FieldDoc {
    val d = FieldDoc(type = TodoKind.PROJECT, createdAt = now)
    d.setName(name, now)
    d.setColor(color, now)
    d.setOrder(order, now)
    d.updatedAt = now
    return d
}

/** The Mac's sync label: a project's name or a task's title, "Untitled" when empty, at most 40 Characters. */
fun todoLabel(d: FieldDoc): String = FieldDocCollectionSync.shortLabel(if (d.isProject) d.name else d.title)

/** The [com.charles.bento.core.sync.CollectionSync] for `todos`, over the app's todo repository. */
fun todoCollectionSync(repo: FieldDocRepository): FieldDocCollectionSync = FieldDocCollectionSync(TODO_COLLECTION, repo, ::todoLabel)
