package com.charles.bento.core.notes

import java.util.regex.Pattern
import kotlin.math.max
import kotlin.math.min

/** A set of non-overlapping edits plus the selection to set afterwards (final coordinates). */
data class EditResult(val edits: List<TextEdit>, val selection: TextRange) {
    /** Applies the edits to a string. */
    fun apply(text: String): String {
        val sb = StringBuilder(text)
        for (e in edits.sortedByDescending { it.range.location }) sb.replace(e.range.location, e.range.end, e.replacement)
        return sb.toString()
    }
}

sealed class BlockFormat {
    data object Paragraph : BlockFormat()
    data class Heading(val level: Int) : BlockFormat()
    data object Bullet : BlockFormat()
    data object Ordered : BlockFormat()
    data object Task : BlockFormat()
    data object Quote : BlockFormat()
    data object CodeBlock : BlockFormat()
}

enum class InlineFormat {
    Bold, Italic, Strike, Code, Underline;

    val open: String
        get() = when (this) {
            Bold -> "**"
            Italic -> "*"
            Strike -> "~~"
            Code -> "`"
            Underline -> "<u>"
        }

    val close: String get() = if (this == Underline) "</u>" else open

    fun matches(k: InlineKind): Boolean = when (this) {
        Bold -> k == InlineKind.Bold || k == InlineKind.BoldItalic
        Italic -> k == InlineKind.Italic || k == InlineKind.BoldItalic
        Strike -> k == InlineKind.Strike
        Code -> k == InlineKind.Code
        Underline -> k == InlineKind.Underline
    }
}

/**
 * Pure markdown editing operations on (text, selection), with UTF-16 offsets. Every
 * function returns the edits to apply or null when the default text-view behaviour
 * should run. A port of the Mac's MarkdownCommands.swift.
 */
object MarkdownCommands {
    data class Line(
        /** Without terminator. */
        val range: TextRange,
        /** With terminator. */
        val full: TextRange,
        /** Ranges relative to `range`. */
        val parsed: ParsedLine,
        /** Fence state before the line. */
        val inCode: Boolean,
    ) {
        val contentStart: Int get() = range.location + parsed.contentRange.location
        val end: Int get() = range.end
        fun text(t: String): String = t.substring(range.location, range.end)
    }

    private fun sub(text: String, r: TextRange) = text.substring(r.location, r.end)

    fun line(loc: Int, text: String): Line {
        val full = SwiftText.lineRange(text, min(loc, text.length))
        var end = full.end
        if (end > full.location && text[end - 1] == '\n') end--
        if (end > full.location && text[end - 1] == '\r') end--
        val r = TextRange(full.location, end - full.location)
        val inCode = MarkdownParser.isInCode(text, full.location)
        return Line(r, full, MarkdownParser.parseLine(sub(text, r), inCode), inCode)
    }

    /**
     * Lines touched by a selection (a selection ending right after a newline does not
     * include the next line).
     */
    fun lines(sel: TextRange, text: String): List<Line> {
        val first = line(sel.location, text)
        var lastLoc = sel.end
        if (sel.length > 0 && text[lastLoc - 1] == '\n') lastLoc--
        val out = mutableListOf(first)
        var inCode = first.inCode
        (first.parsed.kind as? BlockKind.Fence)?.let { inCode = it.opening }
        var cur = first
        // Continue while the selection reaches the next line and the current line has a terminator.
        while (cur.full.end <= lastLoc && cur.full.length > cur.range.length) {
            val full = SwiftText.lineRange(text, cur.full.end)
            var end = full.end
            if (end > full.location && text[end - 1] == '\n') end--
            val r = TextRange(full.location, end - full.location)
            val p = MarkdownParser.parseLine(sub(text, r), inCode)
            cur = Line(r, full, p, inCode)
            out.add(cur)
            (p.kind as? BlockKind.Fence)?.let { inCode = it.opening }
        }
        return out
    }

    // MARK: Return

    fun newline(text: String, sel: TextRange): EditResult? {
        val l = line(sel.location, text)
        val rel = sel.location - l.range.location
        val kind = l.parsed.kind
        when {
            kind == BlockKind.Code -> {
                val ws = leadingWhitespace(text, l.range, rel)
                return EditResult(listOf(TextEdit(sel, "\n" + ws)), TextRange(sel.location + 1 + ws.length, 0))
            }
            kind is BlockKind.Fence && kind.opening -> {
                if (!(sel.length == 0 && rel == l.range.length && !hasClosingFence(text, l))) return null
                val fence = fenceChars(text, l.range)
                return EditResult(listOf(TextEdit(sel, "\n\n" + fence)), TextRange(sel.location + 1, 0))
            }
            kind == BlockKind.Details -> {
                // Return at the end of a summary starts the body; an unclosed expander gets its
                // closing line, like a code fence
                if (!(sel.length == 0 && rel >= l.parsed.contentRange.end)) return null
                val html = l.parsed.markerRange?.let { text[l.range.location + it.location] == '<' } ?: false
                val close = if (MarkdownParser.expanderEnd(l.full, text) == null) "\n" + (if (html) "</details>" else ":::") else ""
                return EditResult(listOf(TextEdit(TextRange(l.end, 0), "\n" + close)), TextRange(l.end + 1, 0))
            }
            kind == BlockKind.Bullet || kind is BlockKind.Ordered || kind is BlockKind.Task || kind is BlockKind.Quote -> {
                val p = l.parsed
                val content = text.substring(l.contentStart, l.end)
                if (sel.length == 0 && SwiftText.trimWhitespaces(content).isEmpty()) {
                    if (p.kind.isList && p.level > 0) {
                        val removed = outdentLength(text, l.range)
                        return EditResult(listOf(TextEdit(TextRange(l.range.location, removed), "")), TextRange(sel.location - removed, 0))
                    }
                    return EditResult(listOf(TextEdit(TextRange(l.range.location, l.range.length), "")), TextRange(l.range.location, 0))
                }
                var target = sel
                if (target.location < l.contentStart) {
                    target = TextRange(l.contentStart, max(0, sel.end - l.contentStart))
                }
                val prefix = continuationPrefix(text, l)
                return EditResult(listOf(TextEdit(target, "\n" + prefix)), TextRange(target.location + 1 + prefix.length, 0))
            }
            else -> return null
        }
    }

    /** The prefix a new item after `l` gets. */
    fun continuationPrefix(text: String, l: Line): String {
        val p = l.parsed
        val indent = leadingWhitespace(text, l.range, p.markerRange?.location ?: 0)
        return when (val k = p.kind) {
            BlockKind.Bullet -> indent + "${p.bulletChar} "
            is BlockKind.Ordered -> indent + "${k.number + 1}${p.bulletChar} "
            is BlockKind.Task -> indent + "${p.bulletChar} [ ] "
            is BlockKind.Quote -> "> ".repeat(k.depth)
            else -> ""
        }
    }

    fun hasClosingFence(text: String, l: Line): Boolean {
        var loc = l.full.end
        while (loc < text.length) {
            val full = SwiftText.lineRange(text, loc)
            var end = full.end
            if (end > full.location && text[end - 1] == '\n') end--
            val f = MarkdownParser.isFence(text.substring(full.location, end))
            if (f != null && f.lang.isEmpty()) return true
            if (full.length == 0) break
            loc = full.end
        }
        return false
    }

    private fun fenceChars(text: String, r: TextRange): String {
        val chars = Graphemes.characters(SwiftText.trimWhitespaces(sub(text, r)))
        val c = chars.firstOrNull() ?: "`"
        return chars.takeWhile { it == c }.joinToString("")
    }

    fun leadingWhitespace(text: String, r: TextRange, upTo: Int): String {
        var i = 0
        while (i < min(upTo, r.length)) {
            val c = text[r.location + i]
            if (c != ' ' && c != '\t') break
            i++
        }
        return text.substring(r.location, r.location + i)
    }

    /** Characters removed from the start of a line to outdent it one level. */
    fun outdentLength(text: String, r: TextRange): Int {
        var i = 0
        var cols = 0
        while (i < r.length && cols < 4) {
            val c = text[r.location + i]
            if (c == '\t') {
                if (cols == 0) i++
                break
            }
            if (c != ' ') break
            cols++
            i++
        }
        return i
    }

    // MARK: Tab / Shift-Tab

    fun indent(text: String, sel: TextRange, outdent: Boolean): EditResult? {
        val ls = lines(sel, text).filter { it.parsed.kind.isList && !it.inCode }
        if (ls.isEmpty()) return null
        val edits = ArrayList<TextEdit>()
        for (l in ls) {
            if (outdent) {
                val n = outdentLength(text, l.range)
                if (n > 0) edits.add(TextEdit(TextRange(l.range.location, n), ""))
            } else {
                edits.add(TextEdit(TextRange(l.range.location, 0), MarkdownParser.INDENT_UNIT))
            }
        }
        if (edits.isEmpty()) return EditResult(emptyList(), sel)
        return EditResult(edits, map(sel, edits))
    }

    // MARK: Inline formats

    fun toggleInline(text: String, sel: TextRange, format: InlineFormat): EditResult {
        val f = format
        val open = f.open
        val close = f.close
        val ol = open.length
        val cl = close.length
        if (sel.length == 0) {
            val l = line(sel.location, text)
            val spans = MarkdownParser.inlineSpans(text, TextRange(l.contentStart, l.end - l.contentStart))
            val s = if (l.inCode) null else spans.firstOrNull {
                f.matches(it.kind) && it.contentRange.location <= sel.location && sel.location <= it.contentRange.end
            }
            if (s != null) {
                // At the end of the span: step out of it (typing continues unformatted).
                val closeMarker = s.markers.lastOrNull()
                if (sel.location == s.contentRange.end && closeMarker != null) {
                    return EditResult(emptyList(), TextRange(closeMarker.end, 0))
                }
                return unwrap(s, f, sel)
            }
            val w = wordRange(text, sel.location, l.range)
            if (w.length > 0) {
                val edits = listOf(TextEdit(TextRange(w.location, 0), open), TextEdit(TextRange(w.end, 0), close))
                return EditResult(edits, TextRange(sel.location + ol, 0))
            }
            return EditResult(listOf(TextEdit(sel, open + close)), TextRange(sel.location + ol, 0))
        }

        val s = sub(text, sel)
        // Selection includes the markers: **text**
        if (s.length >= ol + cl && nsHasPrefix(s, open) && nsHasSuffix(s, close) &&
            !(f == InlineFormat.Italic && nsHasPrefix(s, "**") && !nsHasPrefix(s, "***"))
        ) {
            val inner = s.substring(ol, s.length - cl)
            return EditResult(listOf(TextEdit(sel, inner)), TextRange(sel.location, inner.length))
        }
        // Markers right outside the selection: **[text]**
        if (sel.location >= ol && sel.end + cl <= text.length &&
            text.substring(sel.location - ol, sel.location) == open &&
            text.substring(sel.end, sel.end + cl) == close &&
            !(f == InlineFormat.Italic && isStarRun(text, sel.location - ol))
        ) {
            val edits = listOf(TextEdit(TextRange(sel.location - ol, ol), ""), TextEdit(TextRange(sel.end, cl), ""))
            return EditResult(edits, TextRange(sel.location - ol, sel.length))
        }
        // Selection inside an existing span of this kind.
        val l = line(sel.location, text)
        if (sel.end <= l.full.end) {
            val spans = MarkdownParser.inlineSpans(text, TextRange(l.contentStart, l.end - l.contentStart))
            val sp = spans.firstOrNull { f.matches(it.kind) && it.range.contains(sel.location) && sel.end <= it.range.end }
            if (sp != null) return unwrap(sp, f, sel)
        }
        // Wrap (per line, trimming whitespace and skipping block prefixes).
        val edits = ArrayList<TextEdit>()
        for (ln in lines(sel, text)) {
            val start = max(sel.location, if (ln.inCode) ln.range.location else ln.contentStart)
            val end = min(sel.end, ln.end)
            if (end <= start) continue
            var a = start
            var b = end
            while (a < b && isSpace(text[a])) a++
            while (b > a && isSpace(text[b - 1])) b--
            if (b <= a) continue
            edits.add(TextEdit(TextRange(a, 0), open))
            edits.add(TextEdit(TextRange(b, 0), close))
        }
        if (edits.isEmpty()) return EditResult(emptyList(), sel)
        // Select the inner text: from after the first opening marker to before the last closing one.
        var delta = 0
        var selStart = 0
        var selEnd = 0
        for ((i, e) in edits.withIndex()) {
            if (i == 0) selStart = e.range.location + delta + ol
            if (i == edits.size - 1) selEnd = e.range.location + delta
            delta += e.replacement.length
        }
        return EditResult(edits, TextRange(selStart, max(0, selEnd - selStart)))
    }

    private fun unwrap(s: InlineSpan, f: InlineFormat, sel: TextRange): EditResult {
        // boldItalic toggled by one format: replace *** with the other's marker.
        val edits = if (s.kind == InlineKind.BoldItalic) {
            val keep = if (f == InlineFormat.Bold) "*" else "**"
            listOf(TextEdit(s.markers[0], keep), TextEdit(s.markers[1], keep))
        } else {
            s.markers.map { TextEdit(it, "") }
        }
        return EditResult(edits, map(sel, edits))
    }

    private fun isStarRun(text: String, loc: Int): Boolean = loc > 0 && text[loc - 1] == '*'

    private fun isSpace(c: Char): Boolean = c == ' ' || c == '\t' || c == '\n'

    private fun isWordChar(c: Char): Boolean {
        if (c.isSurrogate()) return true // surrogates: treat as word
        return SwiftText.isAlphanumeric(c.code) || c == '\''
    }

    /** The word around `loc` (only when loc is inside or at the edge of a word). */
    fun wordRange(text: String, loc: Int, within: TextRange): TextRange {
        var a = loc
        var b = loc
        while (a > within.location && isWordChar(text[a - 1])) a--
        while (b < within.end && isWordChar(text[b])) b++
        // caret must be strictly inside the word
        if (!(a < loc && loc < b)) return TextRange(loc, 0)
        return TextRange(a, b - a)
    }

    // MARK: Block formats

    /**
     * Wraps the selected lines in an expander ("<details>"), with "Details" selected as
     * the summary to type over. A single line with text becomes the summary instead, with
     * the caret on the empty body line below.
     */
    fun wrapInExpander(text: String, sel: TextRange): EditResult? {
        val ls = lines(sel, text)
        val first = ls.firstOrNull() ?: return null
        val last = ls.last()
        if (ls.any { it.inCode }) return null
        if (ls.size == 1 && first.parsed.kind == BlockKind.Details) return null
        val range = TextRange(first.range.location, last.end - first.range.location)
        val body = sub(text, range)
        val open = "<details><summary>"
        if (ls.size == 1 && sel.length == 0 && SwiftText.trimWhitespaces(body).isNotEmpty()) {
            val summary = SwiftText.trimWhitespaces(body)
            val replacement = "$open$summary</summary>\n\n</details>"
            val bodyStart = range.location + open.length + summary.length + "</summary>\n".length
            return EditResult(listOf(TextEdit(range, replacement)), TextRange(bodyStart, 0))
        }
        val inner = if (SwiftText.trimWhitespacesAndNewlines(body).isEmpty()) "" else body
        val replacement = open + "Details</summary>\n" + inner + "\n</details>"
        return EditResult(listOf(TextEdit(range, replacement)), TextRange(range.location + open.length, 7))
    }

    fun setBlock(text: String, sel: TextRange, format: BlockFormat): EditResult? {
        val ls = lines(sel, text)
        if (format == BlockFormat.CodeBlock) return toggleCodeBlock(text, sel, ls)
        val editable = ls.filter { l ->
            if (l.inCode) return@filter false
            when (l.parsed.kind) {
                is BlockKind.Fence, BlockKind.Code, BlockKind.Rule, BlockKind.Details, BlockKind.DetailsEnd -> false
                else -> true
            }
        }
        if (editable.isEmpty()) return null
        fun matches(k: BlockKind): Boolean = when (format) {
            is BlockFormat.Heading -> k is BlockKind.Heading && k.level == format.level
            BlockFormat.Bullet -> k == BlockKind.Bullet
            BlockFormat.Ordered -> k is BlockKind.Ordered
            BlockFormat.Task -> k is BlockKind.Task
            BlockFormat.Quote -> k is BlockKind.Quote
            BlockFormat.Paragraph -> k == BlockKind.Paragraph
            BlockFormat.CodeBlock -> false
        }
        val allSame = editable.all { matches(it.parsed.kind) }
        val edits = ArrayList<TextEdit>()
        var number = 1
        for (l in editable) {
            val p = l.parsed
            val keepIndent = if (p.kind.isList) leadingWhitespace(text, l.range, p.markerRange?.location ?: 0) else ""
            val prefix: String = if (allSame || format == BlockFormat.Paragraph) {
                ""
            } else {
                when (format) {
                    is BlockFormat.Heading -> "#".repeat(format.level) + " "
                    BlockFormat.Bullet -> "$keepIndent- "
                    BlockFormat.Ordered -> "$keepIndent$number. ".also { number++ }
                    BlockFormat.Task -> {
                        val k = p.kind
                        if (k is BlockKind.Task) keepIndent + "- [${if (k.checked) "x" else " "}] " else "$keepIndent- [ ] "
                    }
                    BlockFormat.Quote -> "> "
                    BlockFormat.Paragraph, BlockFormat.CodeBlock -> ""
                }
            }
            val old = TextRange(l.range.location, p.prefixRange.length)
            if (sub(text, old) != prefix) edits.add(TextEdit(old, prefix))
        }
        if (edits.isEmpty()) return EditResult(emptyList(), sel)
        return EditResult(edits, map(sel, edits, prefixAware = true))
    }

    private fun toggleCodeBlock(text: String, sel: TextRange, ls: List<Line>): EditResult? {
        val first = ls.firstOrNull() ?: return null
        val last = ls.last()
        val firstKind = first.parsed.kind
        val insideFirst = first.inCode || (firstKind is BlockKind.Fence && firstKind.opening)
        if (insideFirst) {
            // Remove the enclosing fences.
            val all = MarkdownParser.parseLines(text)
            val idx = all.indexOfFirst { it.range.contains(first.range.location) || it.range.location == first.range.location }
            if (idx < 0) return null
            var openIdx: Int? = null
            var i = idx
            while (i >= 0) {
                val k = all[i].line.kind
                if (k is BlockKind.Fence && k.opening) {
                    openIdx = i
                    break
                }
                i--
            }
            val o = openIdx ?: return null
            var closeIdx: Int? = null
            var j = o + 1
            while (j < all.size) {
                val k = all[j].line.kind
                if (k is BlockKind.Fence && !k.opening) {
                    closeIdx = j
                    break
                }
                j++
            }
            val openFull = SwiftText.lineRange(text, all[o].range.location)
            var edits = listOf(TextEdit(openFull, ""))
            if (closeIdx != null) {
                val cr = all[closeIdx].range
                edits = if (cr.location <= openFull.end) {
                    // empty block: the fences are adjacent, remove both lines in one edit
                    val closeFull = SwiftText.lineRange(text, cr.location)
                    listOf(TextEdit(TextRange(openFull.location, closeFull.end - openFull.location), ""))
                } else {
                    // remove the closing line including the newline before it
                    edits + TextEdit(TextRange(cr.location - 1, cr.length + 1), "")
                }
            }
            return EditResult(edits, map(sel, edits))
        }
        val edits = listOf(TextEdit(TextRange(first.range.location, 0), "```\n"), TextEdit(TextRange(last.end, 0), "\n```"))
        return EditResult(edits, TextRange(sel.location + 4, sel.length))
    }

    // MARK: Tasks

    /**
     * Flips the checkbox of every task line touched by the selection. With `cascade`,
     * nested tasks below a single toggled task follow its new state.
     */
    fun toggleTasks(text: String, sel: TextRange, cascade: Boolean = false): EditResult? {
        val ls = lines(sel, text).filter { it.parsed.kind is BlockKind.Task && !it.inCode }
        if (ls.isEmpty()) return null
        val edits = ArrayList<TextEdit>()
        var newState = false
        for (l in ls) {
            val k = l.parsed.kind as? BlockKind.Task ?: continue
            val m = l.parsed.markerRange ?: continue
            newState = !k.checked
            edits.add(TextEdit(TextRange(l.range.location + m.location + 1, 1), if (k.checked) " " else "x"))
        }
        if (cascade && ls.size == 1) {
            val parent = ls[0]
            var loc = parent.full.end
            while (loc < text.length) {
                val l = line(loc, text)
                if (!(l.parsed.kind.isList && l.parsed.level > parent.parsed.level && !l.inCode)) break
                val k = l.parsed.kind
                val m = l.parsed.markerRange
                if (k is BlockKind.Task && k.checked != newState && m != null) {
                    edits.add(TextEdit(TextRange(l.range.location + m.location + 1, 1), if (newState) "x" else " "))
                }
                if (l.full.length == 0) break
                loc = l.full.end
            }
        }
        return EditResult(edits, sel)
    }

    // MARK: Input rules (markdown shortcuts while typing)

    /** ICU `\s` (see MarkdownParser). */
    private const val WS = "\\t\\n\\u000B\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000"
    private val taskShortcutRE = Pattern.compile("^([$WS]*)(?:[-*+] )?\\[([ xX]?)\\]$")
    private val fenceShortcutRE = Pattern.compile("^(```|~~~)[^$WS`]*$")

    fun inputRule(text: String, sel: TextRange, typed: String): EditResult? {
        if (!(sel.length == 0 && (typed == " " || typed == "-"))) return null
        val l = line(sel.location, text)
        if (l.inCode) return null
        if (l.parsed.kind == BlockKind.Code) return null
        val before = text.substring(l.range.location, sel.location)
        val afterEmpty = sel.location == l.end

        if (typed == " ") {
            // [] / [ ] / [x]  ->  - [ ]
            val m = taskShortcutRE.matcher(before)
            if (m.find()) {
                val indent = m.group(1)
                val mark = if (m.end(2) > m.start(2)) m.group(2) else " "
                val checked = SwiftText.lowercased(mark) == "x"
                val rep = indent + "- [${if (checked) "x" else " "}] "
                return EditResult(listOf(TextEdit(TextRange(l.range.location, before.length), rep)), TextRange(l.range.location + rep.length, 0))
            }
            // ``` / ```lang / ~~~ + space -> code block
            if (afterEmpty) {
                val f = fenceShortcutRE.matcher(before)
                if (f.find()) {
                    val fence = f.group(1)
                    val rep = before + "\n\n" + fence
                    return EditResult(listOf(TextEdit(TextRange(l.range.location, before.length), rep)), TextRange(l.range.location + before.length + 1, 0))
                }
            }
            // ___ + space -> rule
            if (afterEmpty && before == "___") {
                return EditResult(listOf(TextEdit(TextRange(l.range.location, 3), "---\n")), TextRange(l.range.location + 4, 0))
            }
        } else if (typed == "-" && afterEmpty && before == "--") {
            // --- -> rule, caret moves to a new line below
            return EditResult(listOf(TextEdit(sel, "-\n")), TextRange(sel.location + 2, 0))
        }
        return null
    }

    // MARK: Move lines

    fun moveLines(text: String, sel: TextRange, up: Boolean): EditResult? {
        val ls = lines(sel, text)
        val first = ls.firstOrNull() ?: return null
        val last = ls.last()
        // the empty line after a final newline isn't a line that can move
        if (ls.size == 1 && first.full.length == 0) return null
        val blockStart = first.full.location
        val blockEnd = last.full.end
        val other: TextRange
        if (up) {
            if (blockStart <= 0) return null
            other = SwiftText.lineRange(text, blockStart - 1)
        } else {
            if (!(blockEnd < text.length || (blockEnd == text.length && last.full.length > last.range.length))) return null
            if (blockEnd >= text.length) return null
            other = SwiftText.lineRange(text, blockEnd)
        }
        val cLoc = min(blockStart, other.location)
        val combined = TextRange(cLoc, max(blockEnd, other.end) - cLoc)
        val combinedText = sub(text, combined)
        val trailingNewline = swiftHasSuffix(combinedText, "\n")
        val blockText = text.substring(blockStart, blockEnd)
        val otherText = sub(text, other)
        fun strip(s: String) = if (swiftHasSuffix(s, "\n")) s.dropLast(1) else s
        val parts = if (up) listOf(strip(blockText), strip(otherText)) else listOf(strip(otherText), strip(blockText))
        val rep = parts.joinToString("\n") + (if (trailingNewline) "\n" else "")
        val shift = if (up) -(strip(otherText).length + 1) else strip(otherText).length + 1
        // a selection that included the block's newline can't extend past the moved text
        val newEnd = combined.location + rep.length
        val start = min(sel.location + shift, newEnd)
        return EditResult(listOf(TextEdit(combined, rep)), TextRange(start, max(0, min(sel.length, newEnd - start))))
    }

    // MARK: Deletion

    /** Backspace at the start of a heading/list/quote removes its marker. */
    fun backspace(text: String, sel: TextRange): EditResult? {
        if (!(sel.length == 0 && sel.location > 0)) return null
        val l = line(sel.location, text)
        if (l.inCode || !l.parsed.hasPrefix || sel.location != l.contentStart) return null
        return when (l.parsed.kind) {
            is BlockKind.Heading, BlockKind.Bullet, is BlockKind.Ordered, is BlockKind.Task, is BlockKind.Quote ->
                EditResult(listOf(TextEdit(TextRange(l.range.location, l.parsed.prefixRange.length), "")), TextRange(l.range.location, 0))
            else -> null
        }
    }

    /** Forward delete at a line end joins the next line's content without its marker. */
    fun deleteForward(text: String, sel: TextRange): EditResult? {
        if (!(sel.length == 0 && sel.location < text.length && text[sel.location] == '\n')) return null
        val next = line(sel.location + 1, text)
        if (next.inCode || !next.parsed.hasPrefix) return null
        return when (next.parsed.kind) {
            is BlockKind.Heading, BlockKind.Bullet, is BlockKind.Ordered, is BlockKind.Task, is BlockKind.Quote ->
                EditResult(listOf(TextEdit(TextRange(sel.location, 1 + next.parsed.prefixRange.length), "")), sel)
            else -> null
        }
    }

    // MARK: Caret snapping

    /** Keeps a caret out of hidden block markers (heading/list/quote prefixes). */
    fun snapCaret(text: String, proposed: Int, previous: Int): Int {
        val l = line(proposed, text)
        if (l.inCode || !l.parsed.hasPrefix || proposed >= l.contentStart || proposed < l.range.location) return proposed
        when (l.parsed.kind) {
            is BlockKind.Heading, BlockKind.Bullet, is BlockKind.Ordered, is BlockKind.Task, is BlockKind.Quote -> {}
            else -> return proposed
        }
        if (previous == l.contentStart && proposed < previous && l.range.location > 0) return l.range.location - 1
        return l.contentStart
    }

    // MARK: Links

    fun insertLink(text: String, sel: TextRange, url: String?): EditResult {
        val label = sub(text, sel)
        if (!url.isNullOrEmpty()) {
            val rep = "[${label.ifEmpty { url }}]($url)"
            return EditResult(listOf(TextEdit(sel, rep)), TextRange(sel.location + rep.length, 0))
        }
        val rep = "[$label]()"
        val caret = if (label.isEmpty()) sel.location + 1 else sel.location + rep.length - 1
        return EditResult(listOf(TextEdit(sel, rep)), TextRange(caret, 0))
    }

    // MARK: Position mapping

    /**
     * Maps a range through edits given in original coordinates.
     * - insertBefore: insertions exactly at the range start land before it.
     * - prefixAware: positions inside a replaced prefix move to its end (as on the Mac,
     *   this is what every replaced range does).
     */
    @Suppress("UNUSED_PARAMETER")
    fun map(r: TextRange, edits: List<TextEdit>, insertBefore: Boolean = false, prefixAware: Boolean = false): TextRange {
        fun mapPos(p: Int, stickToEnd: Boolean): Int {
            var delta = 0
            for (e in edits) {
                val repLen = e.replacement.length
                if (e.range.length == 0) {
                    if (e.range.location < p || (e.range.location == p && stickToEnd)) delta += repLen
                } else if (e.range.end <= p) {
                    delta += repLen - e.range.length
                } else if (e.range.location < p) {
                    // inside a replaced range: snap to the end of the replacement
                    delta += (e.range.location + repLen) - p
                }
            }
            return p + delta
        }
        val s = mapPos(r.location, stickToEnd = !insertBefore)
        val e = if (r.length == 0) s else mapPos(r.end, stickToEnd = true)
        return TextRange(s, max(0, e - s))
    }

    /** NSString `hasPrefix` (anchored, not literal) for an ASCII marker. */
    private fun nsHasPrefix(s: String, p: String): Boolean = s.startsWith(p) && SwiftText.foundationMatchEnds(s, p.length)

    /** NSString `hasSuffix` (anchored, not literal) for an ASCII marker. */
    private fun nsHasSuffix(s: String, p: String): Boolean = s.endsWith(p)
}
