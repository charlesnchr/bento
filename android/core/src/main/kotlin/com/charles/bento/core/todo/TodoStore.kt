package com.charles.bento.core.todo

import com.charles.bento.core.fielddoc.FieldDoc
import com.charles.bento.core.fielddoc.FieldDocRepository
import com.charles.bento.core.fielddoc.SwiftText
import java.util.Locale

/**
 * The queries of the Mac's `TodoStore` over any todo repository (the app's SQLite store
 * implements [FieldDocRepository]; persistence and change notifications live there).
 */
class TodoStore(val repo: FieldDocRepository, private val locale: Locale = Locale.getDefault()) {
    fun doc(id: String): FieldDoc? = repo.doc(id)

    /** The task with `id`, if it is a live task. */
    fun task(id: String): FieldDoc? = repo.doc(id)?.takeIf { it.isTask }

    val tasks: List<FieldDoc> get() = repo.allDocs.filter { it.isTask }

    /** Live projects, archived ones last, by order. */
    val projects: List<FieldDoc>
        get() = repo.allDocs.filter { it.isProject }.sortedWith { a, b ->
            when {
                a.archived != b.archived -> if (!a.archived) -1 else 1
                a.order != b.order -> a.order.compareTo(b.order)
                else -> SwiftText.compare(a.id, b.id)
            }
        }

    /** Names of the projects quick add can pick (not archived). */
    val projectNames: List<String> get() = projects.filter { !it.archived }.map { it.name }

    /** Every label used by an open task, sorted (case-insensitively deduplicated: the first spelling seen wins). */
    val labels: List<String>
        get() {
            val seen = LinkedHashMap<String, String>()
            for (t in repo.allDocs) {
                if (!t.isTask || t.isCompleted) continue
                for (l in t.labels) seen.putIfAbsent(SwiftText.lowercased(l), l)
            }
            return seen.values.sortedWith(SwiftText.localizedCaseInsensitiveComparator(locale))
        }

    /** A project's name, or "Inbox" for null / a project that no longer exists. */
    fun projectName(id: String?): String {
        val p = id?.let { repo.doc(it) }
        return if (p != null && p.isProject) p.name else "Inbox"
    }

    /** The heading of a view (Inbox, Today, a project's name, "@label", Search). */
    fun title(view: TodoListView): String = when (view) {
        TodoListView.Inbox -> "Inbox"
        TodoListView.Today -> "Today"
        TodoListView.Upcoming -> "Upcoming"
        is TodoListView.Project -> projectName(view.id)
        is TodoListView.Label -> "@" + view.name
        is TodoListView.Search -> "Search"
    }

    fun rows(view: TodoListView, showCompleted: Boolean = false, dates: TodoDates = TodoDates()): List<TodoRow> =
        TodoQuery.rows(view, tasks, projects, showCompleted, dates)

    fun counts(dates: TodoDates = TodoDates()): TodoQuery.Counts = TodoQuery.counts(tasks, projects, dates)
}
