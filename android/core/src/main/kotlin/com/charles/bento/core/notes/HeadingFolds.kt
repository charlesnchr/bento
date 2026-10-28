package com.charles.bento.core.notes

/**
 * A heading's section: the heading line from [lineStart] to [headingEnd] (its end, before
 * the newline) and the body after it, down to the next heading of the same or a higher
 * level outside code. [bodyEnd] is the end of the section's last line, before its newline:
 * a folded section hides `headingEnd until bodyEnd` (the heading's newline included), so
 * the last line's newline still starts the line after it.
 */
data class HeadingSection(val lineStart: Int, val headingEnd: Int, val bodyEnd: Int, val level: Int, val entry: Boolean) {
    val foldable: Boolean get() = bodyEnd > headingEnd
}

/** A folded heading as shown: `start until end` (from its heading's end) is hidden. */
data class Fold(val lineStart: Int, val start: Int, val end: Int)

object HeadingSections {
    /** Every heading's section, in text order. */
    fun of(text: String): List<HeadingSection> {
        val lines = runCatching { MarkdownParser.parseLines(text) }.getOrDefault(emptyList())
        val out = ArrayList<HeadingSection>()
        for (pl in lines) {
            val k = pl.line.kind as? BlockKind.Heading ?: continue
            val headingEnd = pl.range.end
            val full = SwiftText.lineRange(text, pl.range.location)
            val sectionEnd = MarkdownParser.sectionEnd(full, k.level, text)
            val bodyEnd = if (sectionEnd <= full.end) headingEnd
                else MarkdownParser.contentRange(SwiftText.lineRange(text, sectionEnd - 1), text).end
            val c = pl.line.contentRange
            val content = text.substring(pl.range.location + c.location, minOf(pl.range.location + c.end, text.length))
            out += HeadingSection(pl.range.location, headingEnd, maxOf(headingEnd, bodyEnd), k.level, ThoughtCapture.isEntryHeading(content))
        }
        return out
    }
}

/**
 * Which heading sections are folded in one editor, as on the Mac: any heading's section
 * folds; captured thoughts start folded, other headings open. Never written to the note.
 *
 * Every heading the editor has seen is open or folded, known by its line's start, which
 * [edited] carries through each change to the text, so a fold survives typing elsewhere,
 * edits to its heading and merged-in remote changes, and a captured thought that arrives
 * starts folded without disturbing the others. A folded heading also keeps where its
 * hidden part ends: that's its section's end when it folds, and lines typed after it
 * (Enter at the end of the folded heading, [newline]) stay visible below it until it's
 * opened, though in the text they're still the section's last lines.
 *
 * Typing never changes hidden text: Enter, Backspace and Delete next to a fold have their own
 * edits ([newline], [backspace], [deleteForward]) and any other local edit that would change
 * part of a hidden part is refused ([allows]). The same rules as the Mac's HeadingFolds.swift,
 * which keeps the hidden lines as a range instead of their end.
 */
class HeadingFolds private constructor(
    val text: String,
    /** Folded headings' line starts → the end of their hidden part. */
    private val folded: Map<Int, Int>,
    /** Open headings' line starts. */
    private val open: Set<Int>,
) {
    val sections: List<HeadingSection> by lazy { HeadingSections.of(text) }

    /** The folds shown: folded headings that aren't inside another fold, in text order. */
    val folds: List<Fold> by lazy {
        val out = ArrayList<Fold>()
        var hiddenUntil = -1
        for (s in sections) {
            if (s.lineStart <= hiddenUntil) continue
            val end = folded[s.lineStart] ?: continue
            if (end <= s.headingEnd) continue
            out += Fold(s.lineStart, s.headingEnd, end)
            hiddenUntil = end
        }
        out
    }

    /** Every folded heading's hidden part, those inside other folds too. */
    private val hidden: List<Fold> by lazy {
        sections.mapNotNull { s -> folded[s.lineStart]?.takeIf { it > s.headingEnd }?.let { Fold(s.lineStart, s.headingEnd, it) } }
    }

    fun isFolded(lineStart: Int): Boolean = folds.any { it.lineStart == lineStart }

    /** Whether the heading at `lineStart` is visible (not inside a fold). */
    fun isShown(lineStart: Int): Boolean = folds.none { lineStart > it.start && lineStart <= it.end }

    /** The innermost section with `loc` on its heading line or in its body. */
    fun sectionAt(loc: Int): HeadingSection? {
        var best: HeadingSection? = null
        for (s in sections) {
            if (s.lineStart > loc) break
            if (loc <= s.bodyEnd) best = s
        }
        return best
    }

    /** Folds or opens the heading whose line starts at `lineStart` (folding hides its whole section). */
    fun toggled(lineStart: Int): HeadingFolds {
        val s = sections.firstOrNull { it.lineStart == lineStart } ?: return this
        return when {
            lineStart in folded -> opened(listOf(lineStart))
            s.foldable -> HeadingFolds(text, folded + (lineStart to s.bodyEnd), open - lineStart)
            else -> this
        }
    }

    private fun opened(lineStarts: Collection<Int>): HeadingFolds =
        if (lineStarts.none { it in folded }) this else HeadingFolds(text, folded - lineStarts.toSet(), open + lineStarts)

    /**
     * The text changed to `new`. `local`: typed here (a heading being typed starts open);
     * else merged in from elsewhere (a captured thought arriving starts folded, and text
     * added right at the end of a folded section's hidden part joins it). `edits`: the
     * replacements that made it, when known (else they're diffed).
     */
    fun edited(new: String, local: Boolean, edits: List<TextEdit>? = null): HeadingFolds {
        if (new == text) return this
        @Suppress("NAME_SHADOWING")
        val edits = edits?.filter { it.range.length > 0 || it.replacement.isNotEmpty() }?.sortedBy { it.range.location } ?: TextMerge.edits(text, new)
        val sections = HeadingSections.of(new)
        val byStart = sections.associateBy { it.lineStart }
        val newFolded = HashMap<Int, Int>()
        val newOpen = HashSet<Int>()
        // where each known heading went (null end: open); a heading whose line start was
        // replaced loses to one that only moved there
        val oldBodyEnd = this.sections.associate { it.lineStart to it.bodyEnd }
        val moved = (folded.entries.map { it.key to it.value } + open.map { it to null })
            .mapNotNull { (l, end) -> mapLineStart(l, edits)?.let { (at, weak) -> Triple(at, weak, l to end) } }
            .sortedBy { it.second }
        for ((at, _, old) in moved) {
            val (l, end) = old
            val s = byStart[at] ?: continue
            if (at in newFolded || at in newOpen) continue
            if (end == null) { newOpen += at; continue }
            // merged-in changes: a fold that hid its whole section still does
            if (!local && end >= (oldBodyEnd[l] ?: Int.MAX_VALUE)) {
                if (s.foldable) newFolded[at] = s.bodyEnd else newOpen += at
                continue
            }
            var e = TextMerge.map(end, edits, pastInsertions = !local, insideToEnd = true)
            // whole lines: text added at the end of the last hidden line is hidden too
            e = MarkdownParser.contentRange(SwiftText.lineRange(new, e.coerceIn(0, new.length)), new).end
            e = e.coerceAtMost(s.bodyEnd)
            if (e > s.headingEnd) newFolded[at] = e else newOpen += at
        }
        // headings new to this editor: open while being typed, else as by default
        for (s in sections) {
            if (s.lineStart in newFolded || s.lineStart in newOpen) continue
            val typed = local && edits.any { e ->
                val a = TextMerge.map(e.range.location, edits, pastInsertions = false, insideToEnd = false)
                s.lineStart <= a + e.replacement.length && s.headingEnd >= a
            }
            if (s.entry && s.foldable && !typed) newFolded[s.lineStart] = s.bodyEnd else newOpen += s.lineStart
        }
        return HeadingFolds(new, newFolded, newOpen)
    }

    /**
     * Text merged in from elsewhere: the folds after it and where the caret or selection
     * `sel` goes (mapped like the editor's, then kept out of hidden text; a caret at the
     * note's end, as a note opens, stays at its end when that's in a fold now).
     */
    fun merged(new: String, sel: TextRange): Pair<HeadingFolds, TextRange> {
        val mapped = TextMerge.map(sel, TextMerge.edits(text, new))
        val f = edited(new, local = false)
        val c = f.caret(mapped, mapped)
        val end = TextRange(new.length, 0)
        if (c != mapped && sel == TextRange(text.length, 0) && f.caret(end, end) == end) return f to end
        return f to c
    }

    /**
     * Whether local edits (in this text's coordinates) keep hidden text intact: each must
     * leave every folded section's hidden part (and the line break that ends it) alone or
     * delete all of it, as a selection across the fold does. Anything else is refused (Enter,
     * Backspace and Delete next to a fold have their own edits: [newline], [backspace],
     * [deleteForward]).
     */
    fun allows(edits: List<TextEdit>): Boolean = hidden.none { f -> edits.any { touches(f, it) } }

    private fun touches(f: Fold, e: TextEdit): Boolean {
        val a = e.range.location
        val b = e.range.end
        if (a == b) return a > f.start && a <= f.end
        if (a <= f.start && b >= f.end) return false
        return a <= f.end && b > f.start
    }

    /**
     * A local edit left the selection inside a folded section (Enter in the middle of its
     * heading, which moves the rest of the heading into it): it opens. (A caret at the
     * hidden part's end goes to the heading's end instead, see [caret].)
     */
    fun revealing(sel: TextRange): HeadingFolds {
        val inside = hidden.filter { f ->
            if (sel.length == 0) sel.location > f.start && sel.location < f.end
            else (sel.location > f.start && sel.location < f.end) || (sel.end > f.start && sel.end < f.end)
        }
        return opened(inside.map { it.lineStart })
    }

    /**
     * Where a selection that moved from `previous` to `sel` goes. A caret never lands in
     * hidden text: moving forward from the folded heading it skips to the line after the
     * fold, else it goes to the heading's end. A selection reaching into hidden text covers
     * the whole hidden part.
     */
    fun caret(sel: TextRange, previous: TextRange): TextRange {
        if (sel.length != 0) {
            var start = sel.location
            var end = sel.end
            folds.firstOrNull { start > it.start && start <= it.end }?.let { start = it.start }
            folds.firstOrNull { end > it.start && end <= it.end }?.let { end = it.end }
            return TextRange(start, end - start)
        }
        val c = sel.location
        val f = folds.firstOrNull { c > it.start && c <= it.end } ?: return sel
        if (previous.length == 0 && previous.location <= f.start && f.end < text.length) {
            return TextRange(SwiftText.lineRange(text, f.end).end, 0)
        }
        return TextRange(f.start, 0)
    }

    /**
     * Enter on a folded heading: at its end, a new line after the whole section, which stays
     * folded (rather than one inside the hidden part); at the start of its text (or of the
     * line), an empty line above. null elsewhere (in the middle of the heading's text too).
     */
    fun newline(sel: TextRange): EditResult? {
        if (sel.length != 0) return null
        folds.firstOrNull { it.start == sel.location }?.let { f ->
            return EditResult(listOf(TextEdit(TextRange(f.end, 0), "\n")), TextRange(f.end + 1, 0))
        }
        val l = MarkdownCommands.line(sel.location, text)
        if (folds.none { it.lineStart == l.range.location } || sel.location > l.contentStart) return null
        return EditResult(listOf(TextEdit(TextRange(l.range.location, 0), "\n")), TextRange(sel.location + 1, 0))
    }

    /**
     * Backspace at the start of the line after a folded section: that line joins the heading
     * (the visible line above), or goes when it's empty. The hidden part isn't touched.
     */
    fun backspace(sel: TextRange): EditResult? {
        if (sel.length != 0) return null
        val f = folds.firstOrNull { it.end < text.length && SwiftText.lineRange(text, it.end).end == sel.location } ?: return null
        return join(f)
    }

    /** Delete at the end of a folded heading: the line after its section joins it, as [backspace]. */
    fun deleteForward(sel: TextRange): EditResult? {
        if (sel.length != 0) return null
        val f = folds.firstOrNull { it.start == sel.location } ?: return null
        if (f.end == text.length) return EditResult(emptyList(), sel)
        return join(f)
    }

    /** Moves the line after `f`'s hidden part (without its block marker) to the end of its heading. */
    private fun join(f: Fold): EditResult {
        val nextStart = SwiftText.lineRange(text, f.end).end
        val next = MarkdownCommands.line(nextStart, text)
        val p = next.parsed
        val marker = !next.inCode && p.hasPrefix &&
            (p.kind is BlockKind.Heading || p.kind == BlockKind.Bullet || p.kind is BlockKind.Ordered || p.kind is BlockKind.Task || p.kind is BlockKind.Quote)
        val content = text.substring(if (marker) next.contentStart else next.range.location, next.end)
        // the line and its newline; a last line takes the newline before it instead
        val removed = if (next.full.end > next.end) TextRange(nextStart, next.full.end - nextStart) else TextRange(f.end, next.end - f.end)
        val edits = listOf(TextEdit(removed, "")) + (if (content.isEmpty()) emptyList() else listOf(TextEdit(TextRange(f.start, 0), content)))
        return EditResult(edits, TextRange(f.start, 0))
    }


    /** The state to keep across an activity's recreation: each heading by its line, see [restore]. */
    fun saved(): ArrayList<String> {
        val out = ArrayList<String>()
        for ((s, key) in keys(text, sections)) {
            val end = folded[s.lineStart]
            out += if (end != null) "F${end - s.headingEnd}:$key" else if (s.lineStart in open) "O:$key" else continue
        }
        return out
    }

    override fun equals(other: Any?) = other is HeadingFolds && other.text == text && other.folded == folded && other.open == open
    override fun hashCode() = text.hashCode() * 31 + folded.hashCode()

    companion object {
        /** A note as it opens: captured thoughts folded, other headings open. */
        fun of(text: String): HeadingFolds = HeadingFolds("", emptyMap(), emptySet()).edited(text, local = false)

        /**
         * What a keyboard change from `old` to `new` replaced, as one edit (the unchanged start
         * and end trimmed; a finer diff could split a deletion across a fold into pieces).
         */
        fun change(old: String, new: String): List<TextEdit> {
            if (old == new) return emptyList()
            var p = 0
            while (p < old.length && p < new.length && old[p] == new[p]) p++
            var s = 0
            while (s < minOf(old.length, new.length) - p && old[old.length - 1 - s] == new[new.length - 1 - s]) s++
            return listOf(TextEdit(TextRange(p, old.length - s - p), new.substring(p, new.length - s)))
        }

        /** [saved] state applied to `text` (the same note, perhaps changed since). */
        fun restore(text: String, saved: List<String>?): HeadingFolds {
            val base = of(text)
            if (saved.isNullOrEmpty()) return base
            val states = HashMap<String, Int?>()
            for (item in saved) {
                val colon = item.indexOf(':')
                if (colon < 1) continue
                states[item.substring(colon + 1)] = if (item[0] == 'F') item.substring(1, colon).toIntOrNull() ?: 0 else null
            }
            val folded = HashMap(base.folded)
            val open = HashSet(base.open)
            for ((s, key) in keys(text, base.sections)) {
                if (key !in states) continue
                val len = states[key]
                folded.remove(s.lineStart); open.remove(s.lineStart)
                if (len != null && s.foldable) {
                    val e = MarkdownParser.contentRange(SwiftText.lineRange(text, minOf(s.headingEnd + maxOf(len, 1), text.length)), text).end
                    folded[s.lineStart] = e.coerceIn(s.headingEnd + 1, s.bodyEnd)
                } else {
                    open += s.lineStart
                }
            }
            return HeadingFolds(text, folded, open)
        }

        /** Headings by their line and its occurrence (captures can repeat a heading), as on the Mac. */
        private fun keys(text: String, sections: List<HeadingSection>): List<Pair<HeadingSection, String>> {
            val seen = HashMap<String, Int>()
            return sections.map { s ->
                val line = text.substring(s.lineStart, s.headingEnd)
                val n = seen.merge(line, 1, Int::plus)!! - 1
                s to "$line\u0000$n"
            }
        }

        /**
         * Where the line starting at `l` starts after `edits`: null when its start was deleted
         * (its newline removed); `weak` when an edit replaced text from its start.
         */
        private fun mapLineStart(l: Int, edits: List<TextEdit>): Pair<Int, Boolean>? {
            var delta = 0
            for (e in edits) {
                val a = e.range.location
                val b = e.range.end
                if (l < a) break
                if (a == b) {
                    // text typed at the start of the line goes into it, a line inserted there goes above it
                    if (l == a) return (if (e.replacement.endsWith("\n")) l + delta + e.replacement.length else l + delta) to false
                    delta += e.replacement.length
                    continue
                }
                if (l >= b) { delta += e.replacement.length - (b - a); continue }
                return if (l == a) (a + delta) to true else null
            }
            return (l + delta) to false
        }
    }
}
