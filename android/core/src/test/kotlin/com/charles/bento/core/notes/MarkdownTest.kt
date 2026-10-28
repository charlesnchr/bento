package com.charles.bento.core.notes

import java.time.Instant
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

// Tests/NotesTests/MarkdownTests.swift and HeadingFoldTests.swift: the parser, NoteText,
// MarkdownCommands, ThoughtCapture, HeadingFoldTests' parser parts. (The AppKit styler,
// folding, layout and MarkdownExport cases aren't ported; neither is that code.)

class BlockParsingTest {
    private fun kind(s: String, inCode: Boolean = false) = MarkdownParser.parseLine(s, inCode).kind

    @Test fun headings() {
        assertEquals(BlockKind.Heading(1), kind("# Title"))
        assertEquals(BlockKind.Heading(2), kind("## Sub"))
        assertEquals(BlockKind.Heading(3), kind("### Third"))
        assertEquals(BlockKind.Paragraph, kind("#nospace"))
        assertEquals(BlockKind.Paragraph, kind("#"))
        val p = MarkdownParser.parseLine("## Sub", inCode = false)
        assertEquals(TextRange(0, 3), p.prefixRange)
        assertEquals(TextRange(3, 3), p.contentRange)
    }

    @Test fun lists() {
        assertEquals(BlockKind.Bullet, kind("- item"))
        assertEquals(BlockKind.Bullet, kind("* item"))
        assertEquals(BlockKind.Bullet, kind("+ item"))
        assertEquals(BlockKind.Paragraph, kind("-item"))
        assertEquals(BlockKind.Ordered(1), kind("1. one"))
        assertEquals(BlockKind.Ordered(12), kind("12) twelve"))
        assertEquals(BlockKind.Paragraph, kind("1.no"))
        assertEquals(BlockKind.Task(false), kind("- [ ] todo"))
        assertEquals(BlockKind.Task(true), kind("- [x] done"))
        assertEquals(BlockKind.Task(true), kind("- [X] done"))
        assertEquals(BlockKind.Task(false), kind("- [ ]"))
        assertEquals(BlockKind.Bullet, kind("- [y] no"))
        val nested = MarkdownParser.parseLine("    - child", inCode = false)
        assertEquals(BlockKind.Bullet, nested.kind)
        assertEquals(1, nested.level)
        assertEquals(TextRange(0, 6), nested.prefixRange)
        assertEquals(2, MarkdownParser.parseLine("        - grandchild", inCode = false).level)
        assertEquals(1, MarkdownParser.parseLine("\t- tab child", inCode = false).level)
        val task = MarkdownParser.parseLine("- [ ] todo", inCode = false)
        assertEquals(TextRange(2, 3), task.markerRange)
        assertEquals(TextRange(6, 4), task.contentRange)
    }

    @Test fun quotesRulesFences() {
        assertEquals(BlockKind.Quote(1), kind("> quote"))
        assertEquals(BlockKind.Quote(2), kind("> > nested"))
        assertEquals(BlockKind.Quote(1), kind(">no space"))
        assertEquals(BlockKind.Rule, kind("---"))
        assertEquals(BlockKind.Rule, kind("***"))
        assertEquals(BlockKind.Rule, kind("___"))
        assertEquals(BlockKind.Rule, kind("- - -"))
        assertEquals(BlockKind.Paragraph, kind("--"))
        assertEquals(BlockKind.Fence(true, "swift"), kind("```swift"))
        assertEquals(BlockKind.Fence(true, ""), kind("~~~"))
        assertEquals(BlockKind.Fence(false, ""), kind("```", inCode = true))
        assertEquals(BlockKind.Code, kind("- not a list", inCode = true))
        assertEquals(BlockKind.Code, kind("```js", inCode = true))
    }

    @Test fun parseLinesTracksFences() {
        val text = "# T\n```\n- code\n```\n- list\n"
        val lines = MarkdownParser.parseLines(text)
        assertEquals(
            listOf(BlockKind.Heading(1), BlockKind.Fence(true, ""), BlockKind.Code, BlockKind.Fence(false, ""), BlockKind.Bullet, BlockKind.Paragraph),
            lines.map { it.line.kind },
        )
        assertEquals(TextRange(text.length, 0), lines.last().range)
        assertTrue(MarkdownParser.isInCode(text, lineStart = 8))
        assertFalse(MarkdownParser.isInCode(text, lineStart = 19))
    }
}

class InlineParsingTest {
    private fun spans(s: String) = MarkdownParser.inlineSpans(s)

    @Test fun emphasis() {
        val b = spans("a **bold** b")
        assertEquals(1, b.size)
        assertEquals(InlineKind.Bold, b[0].kind)
        assertEquals(TextRange(2, 8), b[0].range)
        assertEquals(TextRange(4, 4), b[0].contentRange)
        assertEquals(listOf(TextRange(2, 2), TextRange(8, 2)), b[0].markers)
        assertEquals(InlineKind.Italic, spans("an *italic* word").first().kind)
        assertEquals(InlineKind.Italic, spans("an _italic_ word").first().kind)
        assertTrue(spans("snake_case_name").isEmpty())
        assertEquals(InlineKind.Strike, spans("~~gone~~").first().kind)
        assertEquals(InlineKind.BoldItalic, spans("***both***").first().kind)
        assertEquals(InlineKind.Underline, spans("<u>under</u>").first().kind)
        assertTrue(spans("2 * 3 * 4").isEmpty())
        assertTrue(spans("** not bold **").isEmpty())
    }

    @Test fun nestedEmphasis() {
        assertEquals(listOf(InlineKind.Bold, InlineKind.Italic), spans("**bold *it* bold**").map { it.kind })
    }

    @Test fun codeSpansProtectContent() {
        val s = spans("use `**not bold**` here")
        assertEquals(1, s.size)
        assertEquals(InlineKind.Code, s[0].kind)
        assertEquals(TextRange(5, 12), s[0].contentRange)
        assertEquals(InlineKind.Code, spans("``a ` b``").first().kind)
        assertTrue(spans("unclosed `code").isEmpty())
        // emphasis around a code span is fine
        assertEquals(listOf(InlineKind.Bold, InlineKind.Code), spans("**a `b` c**").map { it.kind })
    }

    @Test fun links() {
        val s = spans("see [Raycast](https://raycast.com) now")
        assertEquals(1, s.size)
        assertEquals(InlineKind.Link("https://raycast.com"), s[0].kind)
        assertEquals(TextRange(5, 7), s[0].contentRange)
        assertEquals(listOf(TextRange(4, 1), TextRange(12, 22)), s[0].markers)
        val bare = spans("go to https://example.com/x, ok")
        assertEquals(InlineKind.Autolink("https://example.com/x"), bare.first().kind)
        assertTrue(bare.first().markers.isEmpty())
        assertEquals(InlineKind.Autolink("https://a.b/c"), spans("<https://a.b/c>").first().kind)
        // URL inside link syntax is not a second link
        assertEquals(1, spans("[x](https://a.com)").size)
        // underscores in URLs are not italics
        assertEquals(listOf(InlineKind.Autolink("https://a.com/x_y_z")), spans("https://a.com/x_y_z").map { it.kind })
    }

    @Test fun stripInline() {
        assertEquals("a b d", MarkdownParser.stripInline("**a** [b](c) `d`"))
        assertEquals("Meeting notes", NoteText.title("\n\n## **Meeting** notes\nbody"))
        assertEquals("buy milk", NoteText.title("- [ ] buy milk"))
        assertEquals("code", NoteText.title("```\ncode\n```"))
        assertEquals("", NoteText.title(""))
    }

    @Test fun counts() {
        assertEquals(4, NoteText.characterCount("# Hi\n**ab**"))
        assertEquals(4, NoteText.wordCount("# Hello world\n- one two"))
    }
}

/** Runs a command on text with the caret marked by "|" (or a selection by "[" and "]"). */
internal fun run(marked: String, cmd: (String, TextRange) -> EditResult?): String? {
    var s = marked
    var sel = TextRange(0, 0)
    if (s.contains("[") && s.contains("]") && !s.contains("|")) {
        val a = s.indexOf('[')
        s = s.removeRange(a, a + 1)
        val b = s.indexOf(']')
        s = s.removeRange(b, b + 1)
        sel = TextRange(a, b - a)
    } else if (s.contains("|")) {
        val c = s.indexOf('|')
        sel = TextRange(c, 0)
        s = s.removeRange(c, c + 1)
    }
    val r = cmd(s, sel) ?: return null
    val out = StringBuilder(r.apply(s))
    if (r.selection.length == 0) {
        out.insert(r.selection.location, "|")
    } else {
        out.insert(r.selection.end, "]")
        out.insert(r.selection.location, "[")
    }
    return out.toString()
}

class EditingTest {
    private fun nl(t: String, s: TextRange) = MarkdownCommands.newline(t, s)

    @Test fun listContinuation() {
        assertEquals("- one\n- |", run("- one|", ::nl))
        assertEquals("* one\n* |", run("* one|", ::nl))
        assertEquals("1. one\n2. |", run("1. one|", ::nl))
        assertEquals("- [x] done\n- [ ] |", run("- [x] done|", ::nl))
        assertEquals("> quote\n> |", run("> quote|", ::nl))
        assertEquals("    - child\n    - |", run("    - child|", ::nl))
        // split in the middle
        assertEquals("- ab\n- |cd", run("- ab|cd", ::nl))
        // empty item ends the list
        assertEquals("- one\n|", run("- one\n- |", ::nl))
        assertEquals("|", run("- [ ] |", ::nl))
        // empty nested item outdents
        assertEquals("- a\n- |", run("- a\n    - |", ::nl))
        // paragraphs and headings use the default behaviour
        assertNull(run("plain|", ::nl))
        assertNull(run("# Head|", ::nl))
    }

    @Test fun codeBlockReturn() {
        assertEquals("```swift\n|\n```", run("```swift|", ::nl))
        assertEquals("```\n  let a\n  |\n```", run("```\n  let a|\n```", ::nl))
        // already closed: default
        assertNull(run("```|\nx\n```", ::nl))
    }

    @Test fun indentOutdent() {
        assertEquals("- a\n    - b|", run("- a\n- b|") { t, s -> MarkdownCommands.indent(t, s, outdent = false) })
        assertEquals("- a\n- b|", run("- a\n    - b|") { t, s -> MarkdownCommands.indent(t, s, outdent = true) })
        assertNull(run("plain|") { t, s -> MarkdownCommands.indent(t, s, outdent = false) })
        assertEquals("    [- a\n    - b]", run("[- a\n- b]") { t, s -> MarkdownCommands.indent(t, s, outdent = false) })
    }

    @Test fun inlineToggles() {
        fun inline(f: InlineFormat): (String, TextRange) -> EditResult? = { t, s -> MarkdownCommands.toggleInline(t, s, f) }
        assertEquals("make **[this]** bold", run("make [this] bold", inline(InlineFormat.Bold)))
        assertEquals("make [this] bold", run("make **[this]** bold", inline(InlineFormat.Bold)))
        assertEquals("make [this] bold", run("make [**this**] bold", inline(InlineFormat.Bold)))
        assertEquals("*wo|rd*", run("wo|rd", inline(InlineFormat.Italic)))
        assertEquals("a `|` b", run("a | b", inline(InlineFormat.Code)))
        assertEquals("x bo|ld y", run("x **bo|ld** y", inline(InlineFormat.Bold)))
        // second ⌘B at the end of the span steps out of it
        assertEquals("x **bold**| y", run("x **bold|** y", inline(InlineFormat.Bold)))
        assertEquals("a `code`|", run("a `code|`", inline(InlineFormat.Code)))
        assertEquals(" ~~[two words]~~ ", run("[ two words ]", inline(InlineFormat.Strike)))
        assertEquals("<u>[u]</u>", run("[u]", inline(InlineFormat.Underline)))
        assertEquals("- **[a**\n- **b]**", run("- [a\n- b]", inline(InlineFormat.Bold)))
    }

    @Test fun blockFormats() {
        fun block(f: BlockFormat): (String, TextRange) -> EditResult? = { t, s -> MarkdownCommands.setBlock(t, s, f) }
        assertEquals("# Title|", run("Title|", block(BlockFormat.Heading(1))))
        assertEquals("Title|", run("# Title|", block(BlockFormat.Heading(1))))
        assertEquals("## Title|", run("# Title|", block(BlockFormat.Heading(2))))
        assertEquals("1. [a\n2. b]", run("[a\nb]", block(BlockFormat.Ordered)))
        assertEquals("- [ ] item|", run("- item|", block(BlockFormat.Task)))
        assertEquals("item|", run("- [ ] item|", block(BlockFormat.Task)))
        assertEquals("    1. item|", run("    - item|", block(BlockFormat.Ordered)))
        assertEquals("> quote|", run("quote|", block(BlockFormat.Quote)))
        assertEquals("x|", run("- x|", block(BlockFormat.Paragraph)))
        assertEquals("```\nlet a|\n```", run("let a|", block(BlockFormat.CodeBlock)))
        assertEquals("let a|", run("```\nlet a|\n```", block(BlockFormat.CodeBlock)))
    }

    @Test fun tasks() {
        assertEquals("- [x] a|", run("- [ ] a|") { t, s -> MarkdownCommands.toggleTasks(t, s) })
        assertEquals("- [ ] a|", run("- [x] a|") { t, s -> MarkdownCommands.toggleTasks(t, s) })
        assertNull(run("plain|") { t, s -> MarkdownCommands.toggleTasks(t, s) })
        assertEquals(
            "- [x] parent|\n    - [x] kid\n    - [x] kid2\n- [ ] sibling",
            run("- [ ] parent|\n    - [ ] kid\n    - [x] kid2\n- [ ] sibling") { t, s -> MarkdownCommands.toggleTasks(t, s, cascade = true) },
        )
    }

    @Test fun inputRules() {
        fun rule(typed: String): (String, TextRange) -> EditResult? = { t, s -> MarkdownCommands.inputRule(t, s, typed) }
        assertEquals("- [ ] |", run("[]|", rule(" ")))
        assertEquals("- [x] |", run("[x]|", rule(" ")))
        assertEquals("- [ ] |", run("- []|", rule(" ")))
        assertEquals("    - [ ] |", run("    []|", rule(" ")))
        assertEquals("```\n|\n```", run("```|", rule(" ")))
        assertEquals("```py\n|\n```", run("```py|", rule(" ")))
        assertEquals("---\n|", run("--|", rule("-")))
        assertNull(run("a--|", rule("-")))
        assertNull(run("hello|", rule(" ")))
        assertNull(run("```\n[]|\n```", rule(" ")))
    }

    @Test fun moveLines() {
        fun move(up: Boolean): (String, TextRange) -> EditResult? = { t, s -> MarkdownCommands.moveLines(t, s, up) }
        assertEquals("b|\na\nc", run("a\nb|\nc", move(true)))
        assertEquals("a\nc\nb|", run("a\nb|\nc", move(false)))
        assertNull(run("a|\nb", move(true)))
        assertNull(run("a\nb|", move(false)))
        assertEquals("- y\n- x|\n", run("- x|\n- y\n", move(false)))
    }

    @Test fun deletion() {
        assertEquals("|item", run("- |item") { t, s -> MarkdownCommands.backspace(t, s) })
        assertEquals("|Head", run("## |Head") { t, s -> MarkdownCommands.backspace(t, s) })
        assertNull(run("plain\n|text") { t, s -> MarkdownCommands.backspace(t, s) })
        assertEquals("one|two", run("one|\n- two") { t, s -> MarkdownCommands.deleteForward(t, s) })
        assertNull(run("one|\ntwo") { t, s -> MarkdownCommands.deleteForward(t, s) })
    }

    @Test fun caretSnapping() {
        val t = "para\n- item"
        // inside the hidden "- " prefix -> content start
        assertEquals(7, MarkdownCommands.snapCaret(t, proposed = 5, previous = 0))
        assertEquals(7, MarkdownCommands.snapCaret(t, proposed = 6, previous = 0))
        // moving left from the content start jumps to the previous line's end
        assertEquals(4, MarkdownCommands.snapCaret(t, proposed = 6, previous = 7))
        assertEquals(2, MarkdownCommands.snapCaret(t, proposed = 2, previous = 0))
    }

    @Test fun links() {
        assertEquals("[site](https://a.b)|", run("[site]") { t, s -> MarkdownCommands.insertLink(t, s, "https://a.b") })
        assertEquals("[site](|)", run("[site]") { t, s -> MarkdownCommands.insertLink(t, s, null) })
    }

    @Test fun emptyCodeBlockToggleDoesNotOverlap() {
        // used to produce two overlapping edits -> NSRangeException in the text view
        assertEquals("|next", run("```|\n```\nnext") { t, s -> MarkdownCommands.setBlock(t, s, BlockFormat.CodeBlock) })
        assertEquals("|", run("```|\n```") { t, s -> MarkdownCommands.setBlock(t, s, BlockFormat.CodeBlock) })
    }

    @Test fun movingTheEmptyLastLineIsANoOp() {
        assertNull(run("a\n|") { t, s -> MarkdownCommands.moveLines(t, s, up = true) })
    }
}

/**
 * Every command on random text (emoji, CJK, RTL, lists, fences) and random selections
 * must produce in-bounds, non-overlapping edits and a valid selection: the editor applies
 * them to its text, where anything else throws.
 */
class CommandFuzzTest {
    private val pieces = listOf(
        "# ", "## ", "- ", "    - ", "1. ", "2) ", "- [ ] ", "- [x] ", "> ", "> > ", "```", "```swift", "~~~", "---", "___",
        "**b**", "*i*", "_u_", "~~s~~", "`c`", "<u>u</u>", "[l](https://x.y)", "https://a.b/c", "😀", "👩‍👩‍👧", "🇩🇰",
        "日本語", "مرحبا", "שלום", "text", " ", "\t", "\n", "\n", "\n", "[]", "[x]", "*", "**", "`", "|",
    )

    private fun check(r: EditResult?, text: String, label: String, failures: MutableList<String>) {
        r ?: return
        var prevEnd = 0
        for (e in r.edits.sortedBy { it.range.location }) {
            if (e.range.location < prevEnd) failures.add("$label: overlapping edits in ${esc(text)}")
            if (e.range.end > text.length) failures.add("$label: edit out of bounds in ${esc(text)}")
            prevEnd = e.range.end
        }
        if (!r.edits.all { it.range.end <= text.length }) return
        val out = r.apply(text)
        if (r.selection.end > out.length) failures.add("$label: selection out of bounds in ${esc(text)}")
    }

    @Test fun commandsNeverProduceInvalidEdits() {
        val rng = SeededRNG(42UL, rotate = false)
        val failures = mutableListOf<String>()
        repeat(1500) {
            val n = rng.intClosed(0, 12)
            val text = (0 until n).joinToString("") { rng.pick(pieces) }
            val a = rng.intClosed(0, text.length)
            val b = rng.intClosed(a, text.length)
            val sel = if (rng.bool()) TextRange(a, 0) else TextRange(a, b - a)
            check(MarkdownCommands.newline(text, sel), text, "newline", failures)
            check(MarkdownCommands.indent(text, sel, outdent = false), text, "indent", failures)
            check(MarkdownCommands.indent(text, sel, outdent = true), text, "outdent", failures)
            check(MarkdownCommands.backspace(text, sel), text, "backspace", failures)
            check(MarkdownCommands.deleteForward(text, sel), text, "deleteForward", failures)
            check(MarkdownCommands.toggleTasks(text, sel, cascade = true), text, "toggleTasks", failures)
            check(MarkdownCommands.moveLines(text, sel, up = true), text, "moveUp", failures)
            check(MarkdownCommands.moveLines(text, sel, up = false), text, "moveDown", failures)
            check(MarkdownCommands.insertLink(text, sel, "https://a.b"), text, "link", failures)
            for (typed in listOf(" ", "-")) check(MarkdownCommands.inputRule(text, sel, typed), text, "inputRule", failures)
            for (f in InlineFormat.entries) check(MarkdownCommands.toggleInline(text, sel, f), text, "inline $f", failures)
            for (f in listOf(BlockFormat.Paragraph, BlockFormat.Heading(1), BlockFormat.Heading(3), BlockFormat.Bullet, BlockFormat.Ordered,
                BlockFormat.Task, BlockFormat.Quote, BlockFormat.CodeBlock)) {
                check(MarkdownCommands.setBlock(text, sel, f), text, "block $f", failures)
            }
        }
        assertTrue(failures.isEmpty(), failures.take(20).joinToString("\n"))
    }
}

/** HeadingFoldTests' parser parts (the folding itself is the Mac editor's). */
class HeadingSectionTest {
    private val text = "# Note\nintro\n## A\nline a\n### A1\ndeep\n## B\nline b"
    private fun at(s: String) = text.indexOf(s)

    @Test fun sectionEndsAtTheNextHeadingOfTheSameOrAHigherLevel() {
        val a = SwiftText.lineRange(text, at("## A"))
        assertEquals(at("## B"), MarkdownParser.sectionEnd(a, 2, text))
        val a1 = SwiftText.lineRange(text, at("### A1"))
        assertEquals(at("## B"), MarkdownParser.sectionEnd(a1, 3, text))
        assertEquals(text.length, MarkdownParser.sectionEnd(SwiftText.lineRange(text, 0), 1, text))
        // a "#" line in a code block isn't a heading
        val code = "## A\n```\n# not\n```\nx\n# B"
        assertEquals(code.indexOf("# B"), MarkdownParser.sectionEnd(SwiftText.lineRange(code, 0), 2, code))
    }

    @Test fun crlfSections() {
        val t = "## A\r\nbody\r\n## B"
        assertEquals(12, MarkdownParser.sectionEnd(SwiftText.lineRange(t, 0), 2, t))
    }

    @Test fun capturedThoughtHeadings() {
        assertTrue(ThoughtCapture.isEntryHeading("2026-10-26 14:05 · An idea"))
        assertFalse(ThoughtCapture.isEntryHeading("Meeting 2026-10-26 14:05 · x"))
    }

    @Test fun expanderSyntaxIsPlainText() {
        for (line in listOf("::: details A", ":::", "<details><summary>X</summary>", "</details>")) {
            assertEquals(BlockKind.Paragraph, MarkdownParser.parseLine(line, false).kind, line)
        }
        assertEquals("before\n:::\nafter", NoteText.plainText("before\n:::\nafter"))
        assertEquals(":::", NoteText.title(":::\nafter"))
    }
}

class ThoughtCaptureTest {
    private val date = Instant.ofEpochSecond(1_793_021_145) // 2026-10-26 13:25:45 UTC
    private val utc = ZoneId.of("UTC")

    @Test fun entryIsAHeadingWithTimestampAndFirstWords() {
        val e = ThoughtCapture.entry("  Add a capture mode to the transcribe shortcut that appends to a note.\n", date, utc)
        assertEquals("### 2026-10-26 13:25 · Add a capture mode to the…\nAdd a capture mode to the transcribe shortcut that appends to a note.", e)
        assertEquals("### 2026-10-26 13:25 · Short one\nShort one", ThoughtCapture.entry("Short one", date, utc))
        assertNull(ThoughtCapture.entry(" \n\n ", date))
        assertEquals("2026-10-26 13:25", ThoughtCapture.timestamp(date, ZoneId.of("Europe/London")))
        assertTrue(ThoughtCapture.isEntryHeading(e!!.drop(4).takeWhile { it != '\n' }))
    }

    @Test fun bodyIsCleaned() {
        assertEquals("a\n\nb", ThoughtCapture.cleaned("a\r\n\r\n\r\nb\n\n"))
        // a heading would end the entry's section
        assertEquals("a\n\\# Big\n\\### small\nb", ThoughtCapture.cleaned("a\n# Big\n  ### small\nb"))
        assertEquals("look:\n```\ncode\n```", ThoughtCapture.cleaned("look:\n```\ncode"))
        assertEquals("one two three", ThoughtCapture.summary("one\ntwo  three"))
    }

    @Test fun appendsAsSeparateEntries() {
        assertEquals("E1\n", ThoughtCapture.append("E1", ""))
        assertEquals("  \n\nE1\n", ThoughtCapture.append("E1", "  \n"))
        assertEquals("# Random snippets\nold text\n\n\nE2\n", ThoughtCapture.append("E2", "# Random snippets\nold text\n\n\n"))
    }

    @Test fun appendPreservesExistingWhitespaceAndClosesAnOpenFence() {
        val body = "# Note\nA hard break  \n\n\n"
        assertEquals(body + "E\n", ThoughtCapture.append("E", body))
        val fenced = "# Note\n~~~~swift\nlet x = 1"
        assertEquals("$fenced\n~~~~\n\nE\n", ThoughtCapture.append("E", fenced))
        assertEquals("~~~~swift\nlet x = 1\n~~~~", ThoughtCapture.cleaned("~~~~swift\nlet x = 1"))
        assertEquals("~~~```lang\ncode\n~~~", ThoughtCapture.cleaned("~~~```lang\ncode"))
    }

    /** Captures appended to an existing note are one section each, leaving the note's other lines alone. */
    @Test fun appendedEntriesAreSections() {
        var body = "# Random snippets\n- [ ] a task"
        for (text in listOf("First idea with quite a few words in it", "Second:\n\n## a heading\nwith a stray heading")) {
            body = ThoughtCapture.append(ThoughtCapture.entry(text, date, utc)!!, body)
        }
        val lines = MarkdownParser.parseLines(body)
        val headings = lines.filter { it.line.kind is BlockKind.Heading }
        assertEquals(listOf(1, 3, 3), headings.map { (it.line.kind as BlockKind.Heading).level })
        val entries = headings.drop(1).map { body.substring(it.range.location + 4, it.range.end) }
        assertTrue(entries.all { ThoughtCapture.isEntryHeading(it) })
        // each entry's section ends where the next one starts
        val first = SwiftText.lineRange(body, headings[1].range.location)
        assertEquals(headings[2].range.location, MarkdownParser.sectionEnd(first, 3, body))
        assertEquals("Random snippets", NoteText.title(body))
        assertEquals(BlockKind.Task(false), lines[1].line.kind)
        assertTrue(body.endsWith("· Second: ## a heading with a…\nSecond:\n\n\\## a heading\nwith a stray heading\n"))
    }

    /** CaptureControllerTests' expectations of the text a capture writes (NotesController.capture). */
    @Test fun capturesIntoANewThoughtsNoteOrAnExistingOne() {
        fun capture(body: String, text: String) = ThoughtCapture.append(ThoughtCapture.entry(text)!!, body)
        val first = capture("# Thoughts", "First thought")
        assertTrue(first.startsWith("# Thoughts\n\n### "))
        assertTrue(first.endsWith("\nFirst thought\n"))
        val second = capture(first, "Second thought")
        assertTrue(second.startsWith(first + "\n### "))
        assertTrue(second.endsWith("\nSecond thought\n"))
        val typed = "# Note\nold unsaved"
        val captured = capture(typed, "Captured thought")
        assertTrue(captured.startsWith("$typed\n\n### "))
        assertTrue(captured.endsWith("\nCaptured thought\n"))
    }
}
