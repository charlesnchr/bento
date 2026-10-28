package com.charles.bento.core.notes

import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Folding heading sections in the Android editor. The editor's glue is mirrored by [Editor]:
 * a caret move goes through [HeadingFolds.caret]; Enter, Backspace and Delete next to a fold
 * through [HeadingFolds.newline], [HeadingFolds.backspace] and [HeadingFolds.deleteForward];
 * other edits must pass [HeadingFolds.allows], then go through [HeadingFolds.edited].
 */
class HeadingFoldsTest {
    private val thoughts = "# Thoughts\n\n" +
        "### 2026-10-27 23:12 · Idea for the garden…\nPlant tulips.\nAnd roses.\n\n" +
        "### 2026-10-27 23:13 · Hey Sam…\nRunning late.\n\n" +
        "### 2026-10-27 23:14 · Last one\nThe end.\n"

    private fun at(text: String, s: String) = text.indexOf(s).also { check(it >= 0) { s } }

    /** What the editor shows: hidden parts replaced by " ⋯". */
    private fun shown(f: HeadingFolds): String {
        val sb = StringBuilder()
        var at = 0
        for (fold in f.folds) {
            sb.append(f.text, at, fold.start).append(" ⋯")
            at = fold.end
        }
        return sb.append(f.text.substring(at)).toString()
    }

    /** The editor: text, caret and folds, changed the way NoteEditorScreen changes them. */
    private class Editor(text: String, caret: Int = text.length) {
        var folds = HeadingFolds.of(text)
        var sel = folds.caret(TextRange(caret, 0), TextRange(caret, 0))
        val text get() = folds.text

        /** A tap or keyboard caret move. */
        fun move(to: Int) { sel = folds.caret(TextRange(to, 0), sel) }

        /** The keyboard replaced the selection with `s` (Enter is "\n", Backspace ""). false: refused. */
        fun type(s: String): Boolean {
            if (s.isEmpty() && sel.length == 0 && sel.location == 0) return true
            val r = if (s.isEmpty() && sel.length == 0) TextRange(sel.location - 1, 1) else sel
            if (s == "\n") folds.newline(sel)?.let { return apply(it, user = false) }
            if (s.isEmpty() && sel.length == 0) folds.backspace(sel)?.let { return apply(it, user = false) }
            return key(EditResult(listOf(TextEdit(r, s)), TextRange(r.location + s.length, 0)))
        }

        fun forwardDelete(): Boolean {
            folds.deleteForward(sel)?.let { return apply(it, user = false) }
            return key(EditResult(listOf(TextEdit(TextRange(sel.location, 1), "")), sel))
        }

        /** A keyboard edit: the editor only sees the new text, so its edit is [HeadingFolds.change]'s. */
        private fun key(r: EditResult) = apply(r, edits = HeadingFolds.change(text, r.apply(text)))

        /**
         * A local change: `user` for typing and commands (refused when it would change hidden
         * text), not for the fold-aware edits above or undo. `edits`: what it replaced, if known.
         */
        fun apply(r: EditResult, user: Boolean = true, edits: List<TextEdit>? = r.edits): Boolean {
            val new = r.apply(text)
            if (user && !folds.allows(edits ?: HeadingFolds.change(text, new))) return false
            folds = folds.edited(new, local = true, edits).let { if (user) it.revealing(r.selection) else it }
            sel = folds.caret(r.selection, r.selection)
            return true
        }

        /** Text merged in from elsewhere (the caret mapped like the editor's). */
        fun remote(new: String) {
            val (f, c) = folds.merged(new, sel)
            folds = f
            sel = c
        }

        fun toggle(heading: String) {
            val l = text.indexOf(heading).also { check(it >= 0) }
            val folding = !folds.isFolded(l)
            folds = folds.toggled(l)
            val s = folds.sections.first { it.lineStart == l }
            if (folding && sel.location > s.headingEnd && sel.location <= s.bodyEnd + 1) sel = TextRange(s.headingEnd, 0)
        }
    }

    @Test fun sections() {
        val t = "# Note\nintro\n## A\nline a\n### A1\ndeep\n## B\nline b\n```\n# not\n```\n## C\n## D\n"
        val s = HeadingSections.of(t)
        assertEquals(listOf("# Note", "## A", "### A1", "## B", "## C", "## D"), s.map { t.substring(it.lineStart, it.headingEnd) })
        assertEquals(t.length - 1, s[0].bodyEnd) // the last line's newline isn't hidden
        assertEquals(at(t, "\n## B"), s[1].bodyEnd)
        assertEquals(at(t, "\n## B"), s[2].bodyEnd)
        assertEquals(at(t, "\n## C"), s[3].bodyEnd) // through the code block
        assertFalse(s[4].foldable)
        assertFalse(s[5].foldable)
        assertFalse(HeadingSections.of("### A\n")[0].foldable)
        assertEquals(7, HeadingSections.of("### A\nx")[0].bodyEnd)
        assertEquals(listOf(false, true, true, true), HeadingSections.of(thoughts).map { it.entry })
    }

    @Test fun capturedThoughtsStartFoldedAndOtherHeadingsOpen() {
        val f = HeadingFolds.of(thoughts)
        assertEquals(3, f.folds.size)
        assertEquals(
            "# Thoughts\n\n### 2026-10-27 23:12 · Idea for the garden… ⋯\n### 2026-10-27 23:13 · Hey Sam… ⋯\n### 2026-10-27 23:14 · Last one ⋯\n",
            shown(f),
        )
        // the caret where a note opens, at its end, is on the empty last line
        assertEquals(thoughts.length, Editor(thoughts).sel.location)
        // without a final newline the end is hidden: the caret goes to the heading's end
        val t = thoughts.dropLast(1)
        assertEquals(at(t, "\nThe end."), Editor(t).sel.location)
    }

    @Test fun togglingFoldsTheWholeSectionAndNestedOnesKeepTheirState() {
        val t = "# Note\nintro\n## A\nline a\n### A1\ndeep\n## B\nline b"
        var f = HeadingFolds.of(t)
        assertTrue(f.folds.isEmpty())
        f = f.toggled(at(t, "### A1"))
        assertEquals("# Note\nintro\n## A\nline a\n### A1 ⋯\n## B\nline b", shown(f))
        f = f.toggled(at(t, "## A"))
        assertEquals("# Note\nintro\n## A ⋯\n## B\nline b", shown(f))
        assertFalse(f.isShown(at(t, "### A1")))
        f = f.toggled(at(t, "## A"))
        assertEquals("# Note\nintro\n## A\nline a\n### A1 ⋯\n## B\nline b", shown(f))
        // the first and last sections
        f = f.toggled(0)
        assertEquals("# Note ⋯", shown(f))
        f = f.toggled(0).toggled(at(t, "## B"))
        assertEquals("# Note\nintro\n## A\nline a\n### A1 ⋯\n## B ⋯", shown(f))
        // a heading with nothing under it doesn't fold; nor does a line that isn't a heading
        assertEquals(f, f.toggled(at(t, "intro")))
        val empty = HeadingFolds.of("## A\n## B\nx")
        assertEquals(empty, empty.toggled(0))
    }

    @Test fun identicalHeadingsFoldIndependently() {
        val t = "## Same\nbody\n## Same\nbody\nafter"
        val f = HeadingFolds.of(t).toggled(0)
        assertEquals("## Same ⋯\n## Same\nbody\nafter", shown(f))
        assertEquals("## Same\nbody\n## Same ⋯", shown(f.toggled(0).toggled(at(t, "body\n## Same") + 5)))
    }

    @Test fun enterAtTheEndOfAFoldedHeadingAddsALineAfterTheSection() {
        for (heading in listOf("### 2026-10-27 23:12", "### 2026-10-27 23:13", "### 2026-10-27 23:14")) {
            val ed = Editor(thoughts)
            val l = at(thoughts, heading)
            val end = thoughts.indexOf('\n', l)
            ed.move(end)
            assertEquals(end, ed.sel.location)
            ed.type("\n")
            assertEquals(3, ed.folds.folds.size, heading) // nothing opened
            ed.type("Hello")
            val s = shown(ed.folds)
            val line = s.lines().indexOfFirst { it.startsWith(heading) }
            assertTrue(s.lines()[line].endsWith(" ⋯"), s)
            assertEquals("Hello", s.lines()[line + 1], s)
            // in the text the new line is the section's last, after its blank line
            val body = ed.text.substring(l)
            assertTrue(Regex("^[^\n]*\n[^#]*\n\nHello\n").containsMatchIn(body) || body.contains("The end.\nHello\n"), body)
            // and Backspace takes it away again
            repeat(6) { ed.type("") }
            assertEquals(thoughts, ed.text, heading)
            assertEquals(end, ed.sel.location)
            assertEquals(3, ed.folds.folds.size)
        }
    }

    @Test fun enterAfterTheLastSectionWithoutAFinalNewline() {
        val t = "# N\n### 2026-10-27 23:14 · Last\nThe end."
        val ed = Editor(t)
        assertEquals(at(t, "\nThe end."), ed.sel.location)
        ed.type("\n")
        ed.type("x")
        assertEquals("$t\nx", ed.text)
        assertEquals("# N\n### 2026-10-27 23:14 · Last ⋯\nx", shown(ed.folds))
        // folding it again takes the line in: it's in the section
        ed.toggle("### 2026"); ed.toggle("### 2026")
        assertEquals("# N\n### 2026-10-27 23:14 · Last ⋯", shown(ed.folds))
        assertEquals(at(t, "\nThe end."), ed.sel.location)
    }

    @Test fun enterElsewhereOnAFoldedHeading() {
        val t = "### 2026-10-27 23:12 · Idea\nbody\n"
        // at its start: a line above, the heading stays folded
        val ed = Editor(t)
        ed.move(0)
        ed.type("\n")
        assertEquals("\n### 2026-10-27 23:12 · Idea ⋯\n", shown(ed.folds))
        assertEquals(1, ed.sel.location)
        // at the start of its text, too (the caret stays there)
        val text = Editor(t)
        text.move(4)
        text.type("\n")
        assertEquals("\n### 2026-10-27 23:12 · Idea ⋯\n", shown(text.folds))
        assertEquals(5, text.sel.location)
        // in its middle: the rest of the heading goes into the section, which opens
        val mid = Editor(t)
        mid.move(8)
        mid.type("\n")
        assertTrue(mid.folds.folds.isEmpty())
        assertEquals(9, mid.sel.location)
    }

    @Test fun theCaretNeverGoesIntoHiddenText() {
        val ed = Editor(thoughts)
        val first = at(thoughts, "### 2026-10-27 23:12")
        val end = thoughts.indexOf('\n', first)
        val next = at(thoughts, "### 2026-10-27 23:13")
        // a keyboard move forward from the heading's end skips the fold
        ed.move(end)
        ed.move(end + 1)
        assertEquals(next, ed.sel.location) // the line after the fold (the blank line before it is hidden)
        // back from there: the heading's end
        ed.move(next - 1)
        assertEquals(end, ed.sel.location)
        // anywhere else inside
        ed.move(next)
        ed.move(end + 5)
        assertEquals(end, ed.sel.location)
        // a selection may span folds
        assertEquals(TextRange(0, thoughts.length), ed.folds.caret(TextRange(0, thoughts.length), ed.sel))
    }

    @Test fun backspaceAndDeleteNeverChangeHiddenTextUnseen() {
        val t = "### 2026-10-27 23:12 · Idea\nbody\n- a line\nmore\n"
        val l = "### 2026-10-27 23:12 · Idea"
        // Backspace at the start of the line after a fold joins that line onto the heading (without its marker)
        val body = "### 2026-10-27 23:12 · Idea\nbody\n"
        val tail = Editor(body + "- a line\n")
        tail.folds = HeadingFolds.of(body).edited(body + "- a line\n", local = true) // "- a line" typed after the fold
        assertEquals("$l ⋯\n- a line\n", shown(tail.folds))
        tail.move(at(tail.text, "- a line"))
        assertTrue(tail.type(""))
        assertEquals("### 2026-10-27 23:12 · Ideaa line\nbody\n", tail.text)
        assertEquals("### 2026-10-27 23:12 · Ideaa line ⋯\n", shown(tail.folds))
        assertEquals(l.length, tail.sel.location)
        // an empty line there just goes
        val empty = Editor(body)
        empty.move(l.length); empty.type("\n")
        assertEquals(body + "\n", empty.text)
        empty.type("")
        assertEquals(body, empty.text)
        assertEquals("$l ⋯\n", shown(empty.folds))
        // Delete at the heading's end does the same with the line after the section
        val del = Editor("$body\n## Next\nx")
        del.move(l.length)
        assertTrue(del.forwardDelete()) // the blank line is in the section: the next visible line is "## Next"
        assertEquals("### 2026-10-27 23:12 · IdeaNext\nbody\n\nx", del.text)
        // at the end of the note it does nothing
        val last = Editor("### 2026-10-27 23:12 · Idea\nbody")
        last.move(l.length)
        assertTrue(last.forwardDelete())
        assertEquals("### 2026-10-27 23:12 · Idea\nbody", last.text)
        // anything else that would change hidden text is refused
        val refused = Editor(t)
        refused.sel = TextRange(at(t, "body"), 0) // (a caret can't get there; as from a stale selection)
        assertFalse(refused.type("x"))
        refused.sel = TextRange(at(t, "Idea"), at(t, "body") + 2 - at(t, "Idea"))
        assertFalse(refused.type(""))
        assertEquals(t, refused.text)
        // selecting across a fold and deleting removes what was selected, hidden part included
        val sel = Editor(t + "# After")
        sel.sel = TextRange(at(t, "Idea"), at(sel.text, "After") - at(t, "Idea"))
        assertTrue(sel.type(""))
        assertEquals("### 2026-10-27 23:12 · After", sel.text)
        // typing at the heading's end edits the heading, which stays folded
        val typing = Editor(t)
        typing.move(l.length)
        typing.type("s")
        assertEquals("### 2026-10-27 23:12 · Ideas ⋯\n", shown(typing.folds))
        typing.type("")
        assertEquals("$l ⋯\n", shown(typing.folds))
    }

    @Test fun removingAHeadingsMarkerKeepsItsLinesWhereTheyAre() {
        val t = "### 2026-10-27 23:12 · Idea\nbody\n### Plain\nmore"
        val ed = Editor(t)
        ed.move(at(t, "Plain"))
        // Backspace at the heading's content start removes "### " (MarkdownCommands.backspace)
        ed.apply(MarkdownCommands.backspace(ed.text, ed.sel)!!)
        assertEquals("### 2026-10-27 23:12 · Idea\nbody\nPlain\nmore", ed.text)
        // now in the folded section above, but shown below it, with the caret
        assertEquals("### 2026-10-27 23:12 · Idea ⋯\nPlain\nmore", shown(ed.folds))
        assertEquals(at(ed.text, "Plain"), ed.sel.location)
    }

    @Test fun foldsSurviveEditsElsewhereAndToTheirHeading() {
        val t = "# Note\nintro\n## A\nline a\n## B\nline b"
        val ed = Editor(t, caret = at(t, "intro"))
        ed.toggle("## A")
        ed.type("x")
        assertEquals("# Note\nxintro\n## A ⋯\n## B\nline b", shown(ed.folds))
        // a new line above it
        ed.move(0); ed.type("\n")
        assertEquals("\n# Note\nxintro\n## A ⋯\n## B\nline b", shown(ed.folds))
        // its heading's text
        ed.move(at(ed.text, "\nline a")); ed.type("!")
        assertEquals("\n# Note\nxintro\n## A! ⋯\n## B\nline b", shown(ed.folds))
        // its level, typed at the line's start or replaced
        ed.move(at(ed.text, "## A")); ed.type("#")
        assertEquals("\n# Note\nxintro\n### A! ⋯\n## B\nline b", shown(ed.folds))
        ed.sel = TextRange(at(ed.text, "### A"), 3); ed.type("#")
        assertEquals("\n# Note\nxintro\n# A! ⋯\n## B\nline b", shown(ed.folds))
        // an opened capture stays open
        val c = Editor(thoughts, caret = 0)
        c.toggle("### 2026-10-27 23:13")
        c.type("x")
        assertEquals(2, c.folds.folds.size)
        assertFalse(c.folds.isFolded(at(c.text, "### 2026-10-27 23:13")))
    }

    @Test fun aHeadingBeingTypedStartsOpen() {
        val ed = Editor("# Thoughts\nbody\n")
        for (ch in "### 2026-10-28 09:00 · New") ed.type(ch.toString())
        ed.type("\n")
        ed.type("text")
        assertTrue(ed.folds.folds.isEmpty(), shown(ed.folds))
        // made from a paragraph line (a heading marker added): open, folding nothing else
        val p = Editor("a\nb\n## X\nc", caret = 0)
        p.type("# ")
        assertTrue(p.folds.folds.isEmpty())
    }

    @Test fun remoteChangesKeepFoldsAndNewCapturesArriveFolded() {
        val ed = Editor(thoughts)
        ed.toggle("### 2026-10-27 23:13") // opened here
        ed.toggle("# Thoughts"); ed.toggle("# Thoughts")
        ed.move(thoughts.length)
        assertEquals(listOf(at(thoughts, "### 2026-10-27 23:12"), at(thoughts, "### 2026-10-27 23:14")), ed.folds.folds.map { it.lineStart })
        // the Mac edits above, inside a hidden body and at a hidden line's end
        var t = thoughts.replace("# Thoughts\n", "# Thoughts\nIntro line\n")
            .replace("Plant tulips.", "Plant many tulips.").replace("The end.", "The end. Really.")
        ed.remote(t)
        assertEquals(
            "# Thoughts\nIntro line\n\n### 2026-10-27 23:12 · Idea for the garden… ⋯\n### 2026-10-27 23:13 · Hey Sam…\nRunning late.\n\n### 2026-10-27 23:14 · Last one ⋯\n",
            shown(ed.folds),
        )
        // a captured thought appended: folded, the others as they were
        t = ThoughtCapture.append("### 2026-10-28 08:00 · New one\nNew text.", t)
        ed.remote(t)
        assertEquals(
            "# Thoughts\nIntro line\n\n### 2026-10-27 23:12 · Idea for the garden… ⋯\n### 2026-10-27 23:13 · Hey Sam…\nRunning late.\n\n### 2026-10-27 23:14 · Last one ⋯\n### 2026-10-28 08:00 · New one ⋯\n",
            shown(ed.folds),
        )
        assertEquals(t.length, ed.sel.location)
        // the Mac renames a folded heading: still folded
        t = t.replace("Last one", "Final one")
        ed.remote(t)
        assertTrue(ed.folds.isFolded(at(t, "### 2026-10-27 23:14")))
        // a line the Mac adds at a folded section's end is in the section
        t = t.replace("The end. Really.", "The end. Really.\nP.S.")
        ed.remote(t)
        assertFalse(shown(ed.folds).contains("P.S."))
    }

    @Test fun remoteChangesNeverLeaveTheCaretHidden() {
        val t = "### 2026-10-27 23:12 · Idea\nbody"
        val ed = Editor(t)
        ed.type("\n"); ed.type("mine")
        // the Mac edits the hidden body: the line typed below the fold stays shown, with the caret
        ed.remote("### 2026-10-27 23:12 · Idea\nmore body\nmine")
        assertEquals("### 2026-10-27 23:12 · Idea ⋯\nmine", shown(ed.folds))
        assertEquals(ed.text.length, ed.sel.location)
        // the caret's line goes into a hidden part: the caret goes to the heading's end
        val ed2 = Editor("### 2026-10-27 23:12 · Idea\nbody\n# Top\nmine", caret = 40)
        ed2.remote("### 2026-10-27 23:12 · Idea\nbody\nmine")
        assertEquals(at(ed2.text, "\nbody"), ed2.sel.location)
    }

    @Test fun undoAndRedoKeepTheSectionFolded() {
        val t = "### 2026-10-27 23:12 · Idea\nbody\n## B"
        val ed = Editor(t)
        ed.move(at(t, "\nbody"))
        ed.type("\n"); ed.type("x")
        val typed = ed.text
        // undo (the editor's history restores whole values; not refused, nothing opens)
        assertTrue(ed.apply(EditResult(listOf(TextEdit(TextRange(0, typed.length), t)), TextRange(at(t, "\nbody"), 0)), user = false, edits = null))
        assertEquals("### 2026-10-27 23:12 · Idea ⋯\n## B", shown(ed.folds))
        assertTrue(ed.apply(EditResult(listOf(TextEdit(TextRange(0, t.length), typed)), TextRange(typed.indexOf("x") + 1, 0)), user = false, edits = null))
        assertEquals("### 2026-10-27 23:12 · Idea ⋯\nx\n## B", shown(ed.folds))
        // an undo that changes hidden text (typed while it was open) is allowed too; the caret leaves it
        val open = Editor("## A\nbody\n## B", caret = 9)
        open.type("!")
        open.toggle("## A")
        open.apply(EditResult(listOf(TextEdit(TextRange(9, 1), "")), TextRange(9, 0)), user = false)
        assertEquals("## A ⋯\n## B", shown(open.folds))
        assertEquals(4, open.sel.location)
    }

    @Test fun aSelectionReachingIntoHiddenTextCoversIt() {
        val t = "### 2026-10-27 23:12 · Idea\nbody\nmore\n## B"
        val f = HeadingFolds.of(t)
        val s = at(t, "\nbody")
        val e = at(t, "\n## B")
        assertEquals(TextRange(0, e), f.caret(TextRange(0, s + 3), TextRange(0, 0)))
        assertEquals(TextRange(s, t.length - s), f.caret(TextRange(s + 2, t.length - s - 2), TextRange(t.length, 0)))
        assertEquals(TextRange(0, s), f.caret(TextRange(0, s), TextRange(0, 0)))
    }

    @Test fun savedStateRestoresByHeading() {
        val ed = Editor(thoughts)
        ed.toggle("### 2026-10-27 23:13")
        ed.toggle("# Thoughts"); ed.toggle("# Thoughts")
        ed.move(at(thoughts, "\nThe end."))
        ed.type("\n"); ed.type("Tail")
        val saved = ed.folds.saved()
        val same = HeadingFolds.restore(ed.text, saved)
        assertEquals(shown(ed.folds), shown(same))
        // the note changed meanwhile (a capture appended): matched by heading
        val changed = ThoughtCapture.append("### 2026-10-28 08:00 · New\nx", "Above\n" + ed.text)
        val restored = HeadingFolds.restore(changed, saved)
        assertEquals("Above\n" + shown(ed.folds) + "\n### 2026-10-28 08:00 · New ⋯\n", shown(restored))
        assertEquals(shown(HeadingFolds.of(thoughts)), shown(HeadingFolds.restore(thoughts, null)))
        assertEquals(shown(HeadingFolds.of(thoughts)), shown(HeadingFolds.restore(thoughts, arrayListOf("junk", ":", "Fx:y"))))
    }

    @Test fun sectionAtTheCaret() {
        val f = HeadingFolds.of(thoughts)
        assertEquals(at(thoughts, "### 2026-10-27 23:13"), f.sectionAt(at(thoughts, "Running"))?.lineStart)
        assertEquals(at(thoughts, "### 2026-10-27 23:13"), f.sectionAt(at(thoughts, "### 2026-10-27 23:13") + 3)?.lineStart)
        assertEquals(0, f.sectionAt(1)?.lineStart)
        assertNull(HeadingFolds.of("plain\ntext").sectionAt(3))
        assertNotNull(f.newline(TextRange(at(thoughts, "\nPlant"), 0)))
        assertNull(f.newline(TextRange(at(thoughts, "Plant"), 0)))
        assertNull(f.newline(TextRange(at(thoughts, "\nPlant"), 1)))
    }

    @Test fun randomEditsKeepFoldsInsideTheText() { for (seed in listOf(73, 7, 2026, 11, 5)) fuzz(seed) }

    private fun fuzz(seed: Int) {
        val rng = Random(seed)
        val pieces = listOf("## A\n", "# B\n", "```\n", "\r\n", "😀", "- [ ] task\n", "", "text", "\n", "### 2026-10-26 14:05 · C\n")
        val ed = Editor(thoughts + "## Other\nstuff\n### 2026-10-26 14:05 · B\n😀\n")
        repeat(1500) { i ->
            val t = ed.text
            val a = rng.nextInt(0, t.length + 1)
            val b = rng.nextInt(a, minOf(t.length, a + 12) + 1)
            val rep = pieces[rng.nextInt(pieces.size)]
            val new = t.substring(0, a) + rep + t.substring(b)
            val before = ed.folds
            val selected = before.caret(TextRange(a, b - a), ed.sel)
            val op = rng.nextInt(8)
            when (op) {
                0 -> ed.remote(new)
                1 -> { ed.sel = selected; ed.type(rep) }
                2 -> { ed.move(a); ed.type("\n") }
                3 -> ed.move(a)
                4 -> { ed.move(a); ed.type("") }
                5 -> { ed.move(a); if (ed.sel.location < t.length) ed.forwardDelete() }
                6 -> { ed.move(a); ed.type(rep) }
                else -> ed.folds.sections.randomOrNull(rng)?.let { s -> ed.folds = ed.folds.toggled(s.lineStart); ed.sel = ed.folds.caret(ed.sel, ed.sel) }
            }
            val f = ed.folds
            // typing never changes hidden text: each hidden part is still there as it was (hidden, inside
            // another fold, or shown when its heading was edited away), unless a selection took all of it
            if (op != 0 && f.text != t) {
                for (fold in before.folds) {
                    val was = t.substring(fold.start, fold.end)
                    val covered = op == 1 && selected.location <= fold.start && selected.end >= fold.end
                    // (an empty last hidden line can become the note's last line, see deleteForward)
                    if (!covered) assertTrue(was.trimEnd('\n') in f.text, "$seed:$i op $op: hidden \"$was\" changed")
                }
            }
            var last = -1
            for (fold in f.folds) {
                assertTrue(fold.start > last && fold.start < fold.end && fold.end <= f.text.length, "$i $fold in ${f.text.length}")
                val s = f.sections.first { it.lineStart == fold.lineStart }
                assertEquals(s.headingEnd, fold.start)
                assertTrue(fold.end <= s.bodyEnd)
                last = fold.end
            }
            if (ed.sel.length == 0) assertTrue(f.folds.none { ed.sel.location > it.start && ed.sel.location <= it.end }, "$i caret ${ed.sel} in ${f.folds}")
            assertEquals(f, HeadingFolds.restore(f.text, f.saved()), "$i restore")
        }
    }
}
