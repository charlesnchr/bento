package com.charles.bento.core.todo

import com.charles.bento.core.fielddoc.FieldDoc
import com.charles.bento.core.fielddoc.SwiftText
import java.time.DateTimeException
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit

/** What the main list shows. */
sealed class TodoListView {
    data object Inbox : TodoListView()
    data object Today : TodoListView()
    data object Upcoming : TodoListView()
    data class Project(val id: String) : TodoListView()
    data class Label(val name: String) : TodoListView()
    data class Search(val query: String) : TodoListView()

    /** Views with a manual order (reordering, add-at-top/bottom). */
    val isManualOrder: Boolean get() = this is Inbox || this is Project

    /** The project new tasks land in (null = Inbox). */
    val projectID: String? get() = (this as? Project)?.id
}

/** One row of the main list. */
sealed class TodoRow {
    /** A group heading ("Overdue", "Thu 23 Oct · Tomorrow"); `date` is the day new tasks added under it are due. */
    data class Header(val headerId: String, val title: String, val subtitle: String?, val date: String?) : TodoRow()
    data class Task(val doc: FieldDoc) : TodoRow()

    val id: String get() = when (this) {
        is Header -> "h:$headerId"
        is Task -> doc.id
    }

    val task: FieldDoc? get() = (this as? Task)?.doc
}

/**
 * Calendar arithmetic on the protocol's floating `yyyy-MM-dd` dates, in `zone` at `now`.
 * Make a new one when the day or the time zone changes (the Mac rebuilds it on every refresh).
 */
class TodoDates(
    val zone: ZoneId = ZoneId.systemDefault(),
    val now: Instant = Instant.now(),
    val format: DateText = DateText.default(),
) {
    val todayDate: LocalDate get() = now.atZone(zone).toLocalDate()
    val today: String get() = string(todayDate)

    fun string(d: LocalDate): String = DueDate.dayString(d.year, d.monthValue, d.dayOfMonth)

    /** The day of an instant in this zone. */
    fun string(instant: Instant): String = string(instant.atZone(zone).toLocalDate())

    /** The day `s` names, rolling over out-of-range parts like Foundation; null when malformed. */
    fun date(s: String): LocalDate? {
        val p = s.split('-').filter { it.isNotEmpty() }.mapNotNull { SwiftText.parseInt(it) }
        if (p.size != 3) return null
        return try {
            LocalDate.of(p[0], 1, 1).plusMonths(p[1] - 1L).plusDays(p[2] - 1L)
        } catch (_: DateTimeException) {
            null
        }
    }

    fun adding(days: Int, to: String): String = date(to)?.let { string(it.plusDays(days.toLong())) } ?: to

    /** Whole days from today to `s` (negative = past). */
    fun days(until: String): Int {
        val d = date(until) ?: return 0
        val t = date(today) ?: return 0
        return ChronoUnit.DAYS.between(t, d).toInt()
    }

    fun isOverdue(due: DueDate): Boolean = due.isOverdue(now, zone)

    /** Todoist-style label: "Today", "Tomorrow", a weekday within the next week, "23 Oct"; plus the time. */
    fun label(due: DueDate): String = due.label(now, zone, format)

    /** Heading for a day in Upcoming: "Thu 23 Oct" and "Tomorrow" / a weekday / null. */
    fun header(s: String): Pair<String, String?> {
        val n = days(s)
        val title = format(s, if (s.take(4) == today.take(4)) DateText.HEADER else DateText.HEADER_YEAR)
        return when (n) {
            0 -> title to "Today"
            1 -> title to "Tomorrow"
            in 2..6 -> title to format(s, DateText.WEEKDAY)
            else -> title to null
        }
    }

    private fun format(s: String, skeleton: String): String {
        val d = date(s) ?: return s
        return format.format(skeleton, d.atTime(12, 0))
    }
}

/** Builds the rows of each view from the task list. Pure, so it is unit tested. */
object TodoQuery {
    private fun less(a: String, b: String) = SwiftText.compare(a, b) < 0

    /** Open tasks first by time of day (untimed last), then priority, then manual order. */
    fun dayOrder(a: FieldDoc, b: FieldDoc): Boolean {
        val ta = a.due?.time ?: "99"
        val tb = b.due?.time ?: "99"
        if (!SwiftText.equal(ta, tb)) return less(ta, tb)
        if (a.priority != b.priority) return a.priority < b.priority
        return manualOrder(a, b)
    }

    fun manualOrder(a: FieldDoc, b: FieldDoc): Boolean {
        if (a.order != b.order) return a.order < b.order
        if (a.createdAt != b.createdAt) return a.createdAt < b.createdAt
        return less(a.id, b.id)
    }

    /** Completed tasks, most recently completed first. */
    fun completedOrder(a: FieldDoc, b: FieldDoc): Boolean = (a.completedAt ?: 0) > (b.completedAt ?: 0)

    /** A Comparator from a Swift `areInIncreasingOrder` predicate. */
    fun comparator(less: (FieldDoc, FieldDoc) -> Boolean): Comparator<FieldDoc> =
        Comparator { a, b -> if (less(a, b)) -1 else if (less(b, a)) 1 else 0 }

    private val manual = comparator(::manualOrder)
    private val day = comparator(::dayOrder)
    private val completed = comparator(::completedOrder)
    private val overdueOrder = comparator { a, b ->
        val da = a.due!!.date
        val db = b.due!!.date
        if (!SwiftText.equal(da, db)) less(da, db) else dayOrder(a, b)
    }

    fun rows(view: TodoListView, tasks: List<FieldDoc>, projects: List<FieldDoc>, showCompleted: Boolean, dates: TodoDates): List<TodoRow> {
        val live = projects.map { it.id }.toSet()
        // Archived projects' tasks only show in that project (like Todoist).
        val archived = projects.filter { it.archived }.map { it.id }.toSet() - listOfNotNull(view.projectID).toSet()
        val visible = tasks.filter { t -> t.project?.let { it !in archived } ?: true }
        // Tasks of a deleted project behave like Inbox tasks until moved.
        fun inInbox(t: FieldDoc) = t.project?.let { it !in live } ?: true
        val open = visible.filter { !it.isCompleted }
        val done = visible.filter { it.isCompleted }

        fun withCompleted(rows: List<TodoRow>, matching: (FieldDoc) -> Boolean): List<TodoRow> {
            if (!showCompleted) return rows
            val c = done.filter(matching).sortedWith(completed)
            if (c.isEmpty()) return rows
            return rows + TodoRow.Header("completed", "Completed", "${c.size}", null) + c.map { TodoRow.Task(it) }
        }

        when (view) {
            TodoListView.Inbox ->
                return withCompleted(open.filter(::inInbox).sortedWith(manual).map { TodoRow.Task(it) }, ::inInbox)

            is TodoListView.Project -> {
                val match = { t: FieldDoc -> t.project == view.id }
                return withCompleted(open.filter(match).sortedWith(manual).map { TodoRow.Task(it) }, match)
            }

            is TodoListView.Label -> {
                val match = { t: FieldDoc -> t.labels.any { SwiftText.caseInsensitiveEquals(it, view.name) } }
                return withCompleted(open.filter(match).sortedWith(comparator(dayThenManual(dates))).map { TodoRow.Task(it) }, match)
            }

            TodoListView.Today -> {
                val today = dates.today
                val overdue = open.filter { less(it.due?.date ?: "9", today) }.sortedWith(overdueOrder)
                val due = open.filter { it.due?.date?.let { d -> SwiftText.equal(d, today) } == true }.sortedWith(day)
                val rows = ArrayList<TodoRow>()
                if (overdue.isNotEmpty()) {
                    rows += TodoRow.Header("overdue", "Overdue", null, null)
                    rows += overdue.map { TodoRow.Task(it) }
                    val (title, subtitle) = dates.header(today)
                    rows += TodoRow.Header(today, title, subtitle, today)
                }
                rows += due.map { TodoRow.Task(it) }
                return withCompleted(rows) { t ->
                    val c = t.completedAt ?: return@withCompleted false
                    dates.string(Instant.ofEpochMilli(c)) == today
                }
            }

            TodoListView.Upcoming -> {
                val today = dates.today
                val rows = ArrayList<TodoRow>()
                val overdue = open.filter { less(it.due?.date ?: "9", today) }.sortedWith(overdueOrder)
                if (overdue.isNotEmpty()) {
                    rows += TodoRow.Header("overdue", "Overdue", null, null)
                    rows += overdue.map { TodoRow.Task(it) }
                }
                val byDay = open.filter { !less(it.due?.date ?: "", today) }.groupBy { it.due!!.date }
                // The next week always shows every day (somewhere to add to); later only days with tasks.
                val week = (0 until 7).map { dates.adding(it, today) }
                val days = (week + byDay.keys).distinct().sortedWith { a, b -> SwiftText.compare(a, b) }
                for (d in days) {
                    val (title, subtitle) = dates.header(d)
                    rows += TodoRow.Header(d, title, subtitle, d)
                    rows += (byDay[d] ?: emptyList()).sortedWith(day).map { TodoRow.Task(it) }
                }
                return rows
            }

            is TodoListView.Search -> {
                val terms = SwiftText.lowercased(view.query).split(' ').filter { it.isNotEmpty() }
                if (terms.isEmpty()) return emptyList()
                val names = projects.associate { it.id to SwiftText.lowercased(it.name) }
                fun match(t: FieldDoc): Boolean {
                    val hay = (listOf(t.title, t.notes) + t.labels.map { "@$it" } + listOf(t.project?.let { names[it] }?.let { "#$it" } ?: "#inbox"))
                        .joinToString(" ").let(SwiftText::lowercased)
                    return terms.all { hay.contains(it) }
                }
                val rows = ArrayList<TodoRow>(open.filter(::match).sortedWith(comparator(dayThenManual(dates))).map { TodoRow.Task(it) })
                val c = done.filter(::match).sortedWith(completed)
                if (c.isNotEmpty()) {
                    rows += TodoRow.Header("completed", "Completed", "${c.size}", null)
                    rows += c.map { TodoRow.Task(it) }
                }
                return rows
            }
        }
    }

    /** Dated tasks first by date, then undated; within a date by [dayOrder]. */
    fun dayThenManual(@Suppress("UNUSED_PARAMETER") dates: TodoDates): (FieldDoc, FieldDoc) -> Boolean = { a, b ->
        val da = a.due?.date ?: "9999"
        val db = b.due?.date ?: "9999"
        if (!SwiftText.equal(da, db)) less(da, db) else dayOrder(a, b)
    }

    /** Open-task counts for the sidebar. */
    data class Counts(val inbox: Int, val today: Int, val overdue: Int, val byProject: Map<String, Int>)

    fun counts(tasks: List<FieldDoc>, projects: List<FieldDoc>, dates: TodoDates): Counts {
        val live = projects.map { it.id }.toSet()
        val archived = projects.filter { it.archived }.map { it.id }.toSet()
        var inbox = 0
        var today = 0
        var overdue = 0
        val by = HashMap<String, Int>()
        val t = dates.today
        for (x in tasks) {
            if (x.isCompleted) continue
            val p = x.project
            if (p != null && p in archived) { by[p] = (by[p] ?: 0) + 1; continue }
            if (p != null && p in live) by[p] = (by[p] ?: 0) + 1 else inbox++
            x.due?.date?.let { d ->
                if (SwiftText.equal(d, t)) today++ else if (less(d, t)) { today++; overdue++ }
            }
        }
        return Counts(inbox, today, overdue, by)
    }

    /** An `order` between two neighbours (fractional, so a move rewrites one document). */
    fun order(between: Double?, and: Double?): Double = when {
        between != null && and != null -> (between + and) / 2
        between != null -> between + 1024
        and != null -> and - 1024
        else -> 1024.0
    }
}
