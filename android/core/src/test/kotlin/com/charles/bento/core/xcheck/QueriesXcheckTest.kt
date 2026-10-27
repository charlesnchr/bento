package com.charles.bento.core.xcheck

import com.charles.bento.core.todo.DueDate
import com.charles.bento.core.todo.JvmDateText
import com.charles.bento.core.todo.TodoDates
import com.charles.bento.core.todo.TodoListView
import com.charles.bento.core.todo.TodoQuery
import com.charles.bento.core.todo.TodoRow
import com.charles.bento.core.xcheck.Vectors.arr
import com.charles.bento.core.xcheck.Vectors.boolValue
import com.charles.bento.core.xcheck.Vectors.contentOrNull
import com.charles.bento.core.xcheck.Vectors.intValue
import com.charles.bento.core.xcheck.Vectors.isNull
import com.charles.bento.core.xcheck.Vectors.obj
import kotlinx.serialization.json.jsonPrimitive
import java.util.Locale
import kotlin.test.Test

/** Todo views (rows, headings, counts) and due labels against the Mac's (en_GB, and en_US labels). */
class QueriesXcheckTest {
    private fun view(name: String): TodoListView = when {
        name == "inbox" -> TodoListView.Inbox
        name == "today" -> TodoListView.Today
        name == "upcoming" -> TodoListView.Upcoming
        name.startsWith("project:") -> TodoListView.Project(name.removePrefix("project:"))
        name.startsWith("label:") -> TodoListView.Label(name.removePrefix("label:"))
        else -> TodoListView.Search(name.removePrefix("search:"))
    }

    @Test fun viewsMatchTheMac() {
        val m = Mismatches("views")
        for (rec in Vectors.load("queries").arr) {
            val o = rec.obj
            val ctx = Vectors.contexts[o["c"]!!.intValue()]
            val dates = TodoDates(ctx.zone, ctx.now, JvmDateText(Locale.UK))
            val tasks = o["tasks"]!!.arr.map { Vectors.doc(it)!! }
            val projects = o["projects"]!!.arr.map { Vectors.doc(it)!! }
            for (v in o["views"]!!.arr) {
                val name = v.arr[0].jsonPrimitive.content
                val completed = v.arr[1].boolValue()
                val mac = v.arr[2].arr.map { r ->
                    if (r.arr[0].jsonPrimitive.content == "t") TodoRow.Task(tasks.first { it.id == r.arr[1].jsonPrimitive.content })
                    else TodoRow.Header(r.arr[1].jsonPrimitive.content, r.arr[2].jsonPrimitive.content, r.arr[3].contentOrNull(), r.arr[4].contentOrNull())
                }
                val ours = TodoQuery.rows(view(name), tasks, projects, completed, dates)
                m.check(ours.map { it.id } == mac.map { it.id }) { "  ctx ${o["c"]} round ${o["round"]} $name completed=$completed\n    mac    ${mac.map { it.id }}\n    kotlin ${ours.map { it.id }}" }
                m.check(ours.filterIsInstance<TodoRow.Header>().map { it.copy(title = cldr(it.title)) } == mac.filterIsInstance<TodoRow.Header>()) {
                    "  headers ctx ${o["c"]} $name\n    mac    ${mac.filterIsInstance<TodoRow.Header>()}\n    kotlin ${ours.filterIsInstance<TodoRow.Header>()}"
                }
            }
            val c = o["counts"]!!.arr
            val counts = TodoQuery.counts(tasks, projects, dates)
            val by = c[3].obj.mapValues { it.value.intValue() }
            m.check(counts == TodoQuery.Counts(c[0].intValue(), c[1].intValue(), c[2].intValue(), by)) { "  counts ctx ${o["c"]}: mac $c kotlin $counts" }
        }
        m.assertNone()
    }

    /**
     * The JDK's CLDR abbreviates September "Sept" in en_GB, macOS's ICU "Sep": locale data,
     * not our code (the Android app formats with the device's ICU anyway).
     */
    private fun cldr(s: String) = s.replace("Sept", "Sep")

    @Test fun dueLabelsMatchTheMac() {
        val m = Mismatches("due labels")
        val gb = JvmDateText(Locale.UK)
        val us = JvmDateText(Locale.US)
        var deviations = 0
        for (r in Vectors.load("due_labels").arr) {
            val a = r.arr
            val ctx = Vectors.contexts[a[0].intValue()]
            val due = DueDate(a[1].jsonPrimitive.content, a[2].contentOrNull())
            val dates = TodoDates(ctx.zone, ctx.now, gb)
            fun where() = "ctx ${a[0]} $due"
            // Known deviations (see the report): year 0 is 1 BC in Foundation's Julian/Gregorian
            // calendar; on a day whose midnight doesn't exist (America/Santiago's DST day),
            // Foundation counts some day differences from 01:00 and gets one less.
            val julian = due.date.startsWith("0000")
            val macDays = if (a[6].isNull()) null else a[6].intValue()
            val skippedMidnight = ctx.zone.id == "America/Santiago" && macDays != null && due.days(ctx.now, ctx.zone) == macDays + 1
            if (julian || skippedMidnight) {
                deviations++
                continue
            }
            val labelGB = cldr(due.label(ctx.now, ctx.zone, gb))
            m.check(labelGB == a[3].jsonPrimitive.content) { "  en_GB ${where()}: mac ${esc(a[3].jsonPrimitive.content)} kotlin ${esc(labelGB)}" }
            val labelUS = due.label(ctx.now, ctx.zone, us)
            m.check(labelUS == a[4].jsonPrimitive.content) { "  en_US ${where()}: mac ${esc(a[4].jsonPrimitive.content)} kotlin ${esc(labelUS)}" }
            m.check(due.isOverdue(ctx.now, ctx.zone) == a[5].boolValue()) { "  overdue ${where()}" }
            val days = if (a[6].isNull()) null else a[6].intValue()
            m.check(due.days(ctx.now, ctx.zone) == days) { "  days ${where()}: mac $days kotlin ${due.days(ctx.now, ctx.zone)}" }
            val (title, subtitle) = dates.header(due.date)
            m.check(cldr(title) == a[7].jsonPrimitive.content && subtitle == a[8].contentOrNull()) {
                "  header ${where()}: mac ${esc(a[7].jsonPrimitive.content)}/${a[8]} kotlin ${esc(title)}/$subtitle"
            }
        }
        m.assertNone()
        println("due labels: $deviations rows skipped as known deviations (year 0, Santiago's skipped midnight)")
    }
}
