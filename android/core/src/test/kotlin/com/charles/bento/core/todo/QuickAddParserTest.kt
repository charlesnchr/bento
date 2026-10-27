package com.charles.bento.core.todo

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private val projects = listOf("Inbox", "Work", "Side Project", "Side", "Plan Tomorrow", "Errands")
private val labels = listOf("errands", "Waiting For", "home")

private fun qa(s: String, projects: List<String> = com.charles.bento.core.todo.projects, labels: List<String> = com.charles.bento.core.todo.labels) =
    QuickAddParser.parse(s, projects, labels, Fixed.now, Fixed.zone)

/** The highlighted substrings by kind, in text order. */
private fun tokens(s: String, r: QuickAddResult) = r.tokens.map { "${it.kind.name.lowercase()}:" + it.range.of(s) }

/** Port of Tests/TodoTests/QuickAddParserTests.swift. */
class QuickAddParserTest {
    @Test fun everything() {
        val s = "Buy milk tomorrow #Errands @shop p1"
        val r = qa(s)
        assertEquals("Buy milk", r.title)
        assertEquals("Errands", r.project)
        assertEquals(listOf("shop"), r.labels)
        assertEquals(1, r.priority)
        assertEquals(DueDate("2026-10-22"), r.due)
        assertFalse(r.clearDue)
        assertEquals(listOf("date:tomorrow", "project:#Errands", "label:@shop", "priority:p1"), tokens(s, r))
    }

    @Test fun plainText() {
        assertEquals(QuickAddResult(title = "just a task"), qa("  just   a   task "))
    }

    @Test fun multiWordProjectsPreferLongest() {
        var r = qa("#Side Project fix bug")
        assertEquals("Side Project", r.project)
        assertEquals("fix bug", r.title)
        r = qa("#Side Project fix bug", projects = listOf("Side"))
        assertEquals("Side", r.project)
        assertEquals("Project fix bug", r.title)
        r = qa("fix bug #side project")
        assertEquals("Side Project", r.project) // canonical spelling
        assertEquals("fix bug", r.title)
        r = qa("fix #Side Projector")
        assertEquals("Side", r.project)
        assertEquals("fix Projector", r.title)
        r = qa("fix #Side Project, then ship")
        assertEquals("Side Project", r.project)
        assertEquals("fix, then ship", r.title)
    }

    @Test fun unknownAndPartialProjects() {
        assertEquals("foo", qa("x #foo").project)
        assertEquals("Workshop", qa("x #Workshop").project) // "Work" must end at a word boundary
        assertEquals("Work", qa("x #work").project)
        assertEquals("Work", qa("x #work.").project)
        assertNull(qa("x #").project)
        assertEquals("x #", qa("x #").title)
        assertNull(qa("C# tips").project)
        assertEquals("C# tips", qa("C# tips").title)
        assertNull(qa("see page#2").project)
    }

    @Test fun lastProjectWins() {
        val s = "#Work email #Errands"
        val r = qa(s)
        assertEquals("Errands", r.project)
        assertEquals("#Work email", r.title)
        assertEquals(listOf("project:#Errands"), tokens(s, r))
    }

    @Test fun labels() {
        var r = qa("call @phone @Home @home @phone x")
        assertEquals(listOf("phone", "home"), r.labels) // known spelling, deduplicated
        assertEquals("call x", r.title)
        assertEquals(4, r.tokens.size)
        r = qa("ping @waiting for reply")
        assertEquals(listOf("Waiting For"), r.labels)
        assertEquals("ping reply", r.title)
        r = qa("x @foo-bar_2 @café @a.b @")
        assertEquals(listOf("foo-bar_2"), r.labels)
        assertEquals("x @café @a.b @", r.title)
        r = qa("ok @done.")
        assertEquals(listOf("done"), r.labels)
        assertEquals("ok.", r.title)
    }

    @Test fun emailsAndURLsAreNotTokens() {
        val s = "mail bob@example.com about https://x.com/@me/#top and www.y.com/tomorrow"
        val r = qa(s)
        assertTrue(r.labels.isEmpty())
        assertNull(r.project)
        assertNull(r.due)
        assertEquals(s, r.title)
    }

    @Test fun priority() {
        assertEquals(1, qa("x p1").priority)
        assertEquals(2, qa("x P2").priority)
        assertEquals(3, qa("p3 x").priority)
        assertEquals(4, qa("x p4.").priority)
        assertEquals("x.", qa("x p4.").title)
        for (s in listOf("x p5", "x p0", "x p1x", "x top1", "x p11", "x #p1", "x @p1")) assertNull(qa(s).priority, s)
        val r = qa("p1 then p3")
        assertEquals(3, r.priority)
        assertEquals("p1 then", r.title)
    }

    @Test fun dates() {
        var r = qa("Call mom tomorrow at 5pm #Work")
        assertEquals(DueDate("2026-10-22", "17:00"), r.due)
        assertEquals("Call mom", r.title)
        r = qa("Pay rent oct 25 p2")
        assertEquals(DueDate("2026-10-25"), r.due)
        assertEquals("Pay rent", r.title)
        r = qa("fri: move tomorrow at 5pm") // longest wins, the other stays text
        assertEquals(DueDate("2026-10-22", "17:00"), r.due)
        assertEquals("fri: move", r.title)
        r = qa("buy 17 eggs")
        assertNull(r.due)
        assertEquals("buy 17 eggs", r.title)
    }

    @Test fun datesInsideProjectsAndLabelsAreIgnored() {
        var r = qa("#Plan Tomorrow write")
        assertEquals("Plan Tomorrow", r.project)
        assertNull(r.due)
        assertEquals("write", r.title)
        r = qa("x #today @tomorrow")
        assertEquals("today", r.project)
        assertEquals(listOf("tomorrow"), r.labels)
        assertNull(r.due)
        r = qa("#Plan Tomorrow write friday")
        assertEquals(DueDate("2026-10-23"), r.due)
        assertEquals("write", r.title)
    }

    @Test fun clearDue() {
        val s = "fix #Work no date"
        val r = qa(s)
        assertTrue(r.clearDue)
        assertNull(r.due)
        assertEquals("fix", r.title)
        assertEquals(listOf("project:#Work", "date:no date"), tokens(s, r))
        assertTrue(qa("x no due date").clearDue)
    }

    @Test fun punctuationTidy() {
        assertEquals("Call Bob, then email", qa("Call Bob tomorrow, then email").title)
        assertEquals("Buy milk", qa("Buy milk, tomorrow").title)
        assertEquals("Buy milk ()", qa("Buy milk (tomorrow)").title)
        assertEquals("", qa("tomorrow").title)
    }

    @Test fun utf16RangesWithEmoji() {
        val s = "👨‍👩‍👧 party 🎉 #Side Project @home tomorrow 5pm p2 🎂"
        val r = qa(s)
        assertEquals(listOf("project:#Side Project", "label:@home", "date:tomorrow 5pm", "priority:p2"), tokens(s, r))
        assertEquals(TextRange(18, 31), r.tokens[0].range)
        assertEquals("👨‍👩‍👧 party 🎉 🎂", r.title)
        assertEquals(DueDate("2026-10-22", "17:00"), r.due)
    }

    @Test fun charactersNotCodeUnits() {
        // A keycap emoji isn't a project sigil, and a space with a combining mark is one whitespace Character (as in Swift).
        assertNull(qa("x #\uFE0F\u20E3 tomorrow").project)
        assertEquals("a b", qa("a \u0301b tomorrow").title)
    }

    // Completion
    private fun ctx(s: String, caret: Int? = null) = QuickAddParser.completionContext(s, caret ?: s.length)

    @Test fun projectAndLabel() {
        var c = ctx("#Wo")
        assertEquals(CompletionContext(QuickAddResult.Token.Kind.PROJECT, "Wo", TextRange(0, 3)), c)
        c = ctx("fix @ho")
        assertEquals(CompletionContext(QuickAddResult.Token.Kind.LABEL, "ho", TextRange(4, 7)), c)
        c = ctx("fix #")
        assertEquals(CompletionContext(QuickAddResult.Token.Kind.PROJECT, "", TextRange(4, 5)), c)
    }

    @Test fun caretInsideWordCoversWholeWord() {
        val c = ctx("a #Work b", 5)
        assertEquals("Wo", c?.query)
        assertEquals(TextRange(2, 7), c?.range)
    }

    @Test fun noContext() {
        assertNull(ctx(""))
        assertNull(ctx("plain"))
        assertNull(ctx("mail a@b"))
        assertNull(ctx("C#"))
        assertNull(ctx("#work fix"))
        assertNull(ctx("#work "))
        assertNull(ctx("#Wo", 0))
        assertEquals("Wo", ctx("#Wo", 99)?.query) // clamped
    }

    @Test fun emojiOffsets() {
        val s = "🎉 buy @gro"
        val c = ctx(s)
        assertEquals("gro", c?.query)
        assertEquals(TextRange(7, 11), c?.range)
        assertEquals("@gro", c!!.range.of(s))
    }
}
