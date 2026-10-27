package com.charles.bento.core.todo

import com.charles.bento.core.fielddoc.SwiftChars
import com.charles.bento.core.fielddoc.SwiftText
import java.time.Instant
import java.time.ZoneId

/** What Todoist-style quick add text means: "Buy milk tomorrow #Errands @shop p1". */
data class QuickAddResult(
    /** The text without the recognised tokens, whitespace collapsed. */
    val title: String,
    /**
     * Project name after `#`: an existing project's spelling when one matched, else the raw
     * word (the caller decides whether to create it or fall back to the Inbox).
     */
    val project: String? = null,
    /** Labels after `@`, deduplicated case-insensitively, in order. */
    val labels: List<String> = emptyList(),
    /** 1 (p1, highest) … 4. */
    val priority: Int? = null,
    val due: DueDate? = null,
    /** "no date" / "no due date": remove the due date. */
    val clearDue: Boolean = false,
    /** Recognised tokens in text order, for highlighting in the input field. */
    val tokens: List<Token> = emptyList(),
) {
    data class Token(val kind: Kind, /** UTF-16 range in the input text. */ val range: TextRange) {
        enum class Kind { PROJECT, LABEL, PRIORITY, DATE }
    }
}

/** Autocomplete context at the caret: typing "#Wo|" gives (PROJECT, "Wo", range of "#Wo"). */
data class CompletionContext(val kind: QuickAddResult.Token.Kind, val query: String, val range: TextRange)

/**
 * Parses quick add text; exact port of the Mac's `QuickAddParser`:
 * - `#Project`: the longest existing project (case-insensitive, may contain spaces) that the
 *   text continues with up to a word boundary, else the word after `#`.
 * - `@label`: likewise with existing labels, else `[A-Za-z0-9_-]+`.
 * - `p1`…`p4` as a standalone word.
 * - one date phrase ([DateParser.findPhrase], the longest; the last on ties).
 *
 * `#`/`@` only count at the start of a word, so e-mail addresses (a@b.com), URLs
 * (x.com/@me, page#anchor) and "C#" stay in the title. When the text has several projects
 * or priorities the last one wins and the others stay in the title.
 */
object QuickAddParser {
    private typealias Kind = QuickAddResult.Token.Kind

    /** Character index range [lo, hi) in a [SwiftChars]. */
    private data class Span(val lo: Int, val hi: Int)

    fun parse(
        text: String, projects: List<String>, labels: List<String>,
        now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault(),
    ): QuickAddResult {
        val c = SwiftChars(text)
        val resultLabels = ArrayList<String>()
        val found = ArrayList<Pair<Kind, Span>>()
        var projectToken: Pair<String, Span>? = null
        var priorityToken: Pair<Int, Span>? = null
        val excluded = ArrayList<Span>()

        var i = 0
        while (i < c.count) {
            if (c.isWhitespace(i)) { i++; continue }
            val wordEnd = c.firstWhitespace(i)
            val word = trimmed(c, Span(i, wordEnd))
            var end = wordEnd
            when (c[i]) {
                "#" -> sigil(c, i, projects) { true }?.let { (name, e) ->
                    projectToken = name to Span(i, e)
                    excluded += Span(i, e)
                    end = maxOf(e, end)
                }
                "@" -> sigil(c, i, labels, ::isLabelWord)?.let { (name, e) ->
                    if (resultLabels.none { SwiftText.caseInsensitiveEquals(it, name) }) resultLabels += name
                    found += Kind.LABEL to Span(i, e)
                    excluded += Span(i, e)
                    end = maxOf(e, end)
                }
                else -> {
                    val n = if (word.hi - word.lo == 2) wholeNumberValue(c[word.hi - 1]) else null
                    if (n != null && n in 1..4 && (c[word.lo] == "p" || c[word.lo] == "P")) {
                        priorityToken = n to word
                        excluded += Span(i, wordEnd)
                    }
                }
            }
            // A multi-word name may end inside a word ("#Side Project," ends before ",").
            i = if (end > wordEnd) c.firstWhitespace(end) else wordEnd
        }
        var project: String? = null
        projectToken?.let { (name, span) ->
            project = name
            found += Kind.PROJECT to span
        }
        var priority: Int? = null
        priorityToken?.let { (value, span) ->
            priority = value
            found += Kind.PRIORITY to span
        }
        var due: DueDate? = null
        var clearDue = false
        DateParser.findPhrase(text, excluded.map { range(c, it) }, now, zone)?.let { m ->
            when (val p = m.phrase) {
                is DateParser.Phrase.Due -> due = p.due
                DateParser.Phrase.Clear -> clearDue = true
            }
            found += Kind.DATE to Span(index(c, m.range.start), index(c, m.range.end))
        }
        val sorted = found.sortedBy { it.second.lo }
        return QuickAddResult(
            title = title(c, sorted.map { it.second }),
            project = project,
            labels = resultLabels,
            priority = priority,
            due = due,
            clearDue = clearDue,
            tokens = sorted.map { QuickAddResult.Token(it.first, range(c, it.second)) },
        )
    }

    /**
     * Autocomplete context at the caret (UTF-16 offset): the query runs from the sigil to the
     * caret; the range covers the whole word so accepting a completion replaces all of it.
     */
    fun completionContext(text: String, caret: Int): CompletionContext? {
        val u = text
        val at = caret.coerceIn(0, u.length)
        fun isSpace(ch: Char) = ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' || ch == '\u00A0'
        var start = at
        while (start > 0 && !isSpace(u[start - 1])) {
            start--
            if (u[start] != '#' && u[start] != '@') continue
            if (!(start == 0 || isSpace(u[start - 1]))) return null
            var end = at
            while (end < u.length && !isSpace(u[end])) end++
            val query = u.substring(start + 1, at)
            return CompletionContext(if (u[start] == '#') Kind.PROJECT else Kind.LABEL, query, TextRange(start, end))
        }
        return null
    }

    // MARK: - Helpers

    private val trailing = setOf(".", ",", ";", ":", "!", "?", ")", "]", "\"", "'")

    private fun range(c: SwiftChars, s: Span) = TextRange(c.offset(s.lo), c.offset(s.hi))

    /** The Character index starting at UTF-16 `offset` (always a Character boundary here). */
    private fun index(c: SwiftChars, offset: Int): Int {
        var lo = 0
        var hi = c.count
        while (lo < hi) {
            val mid = (lo + hi) / 2
            if (c.offset(mid) < offset) lo = mid + 1 else hi = mid
        }
        return lo
    }

    private fun trimmed(c: SwiftChars, s: Span): Span {
        var hi = s.hi
        while (hi > s.lo && c.nfc(hi - 1) in trailing) hi--
        return Span(s.lo, hi)
    }

    private fun isLabelWord(word: String): Boolean = word.isNotEmpty() &&
        word.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it == '_' || it == '-' }

    /** Swift's `Character.wholeNumberValue`: single-scalar Characters with an integral numeric value. */
    internal fun wholeNumberValue(ch: String): Int? {
        val cp = ch.codePointAt(0)
        if (Character.charCount(cp) != ch.length) return null
        when (Character.getType(cp)) {
            Character.DECIMAL_DIGIT_NUMBER.toInt(), Character.LETTER_NUMBER.toInt(), Character.OTHER_NUMBER.toInt() -> {}
            else -> return hanNumber(cp)
        }
        val v = Character.getNumericValue(cp)
        return if (v >= 0) v else null
    }

    /** Han numerals Swift (ICU) gives a numeric value and Java doesn't; only 1…4 matter here. */
    private fun hanNumber(cp: Int): Int? = when (cp) {
        0x4E00, 0x58F9, 0x5F0C -> 1 // 一 壹 弌
        0x4E8C, 0x8CB3, 0x8D30, 0x5F0D, 0x5169, 0x4E24 -> 2 // 二 貳 贰 弍 兩 两
        0x4E09, 0x53C1, 0x53C3, 0x5F0E -> 3 // 三 叁 參 弎
        0x56DB, 0x8086, 0x4E96 -> 4 // 四 肆 亖
        else -> null
    }

    /**
     * The name after the sigil at `i` and the end of the token: the longest `known` name
     * ending at a word boundary, else the word (if `isValid`).
     */
    private fun sigil(c: SwiftChars, i: Int, known: List<String>, isValid: (String) -> Boolean): Pair<String, Int>? {
        val start = i + 1
        var best: Pair<String, Int>? = null
        for (name in known) {
            if (name.isEmpty()) continue
            val e = anchoredMatch(c, start, name) ?: continue
            if (e <= (best?.second ?: start) || !isBoundary(c, e)) continue
            best = name to e
        }
        if (best != null) return best
        val word = trimmed(c, Span(start, c.firstWhitespace(start)))
        val w = c.substring(word.lo, word.hi)
        return if (w.isNotEmpty() && isValid(w)) w to word.hi else null
    }

    /**
     * `text.range(of: name, options: [.caseInsensitive, .anchored], range: start…)`: the end
     * (Character index) of `name` matched case-insensitively at `start`, or null.
     */
    private fun anchoredMatch(c: SwiftChars, start: Int, name: String): Int? {
        val n = SwiftChars(name)
        val target = StringBuilder().apply { for (k in 0 until n.count) append(SwiftText.fold(n[k])) }.toString()
        val acc = StringBuilder()
        var k = start
        while (k < c.count) {
            acc.append(SwiftText.fold(c[k]))
            k++
            if (acc.length >= target.length) return if (acc.toString() == target) k else null
            if (!target.startsWith(acc)) return null
        }
        return null
    }

    /** End of text, whitespace, or trailing punctuation. */
    private fun isBoundary(c: SwiftChars, k: Int): Boolean = k == c.count || c.isWhitespace(k) || c.nfc(k) in trailing

    /**
     * `text` without `ranges` (sorted, disjoint), whitespace collapsed. Punctuation that
     * followed a removed token sticks to the previous word ("Call Bob tomorrow, then" →
     * "Call Bob, then"), and a dangling "," or ";" at the end is dropped.
     */
    private fun title(c: SwiftChars, ranges: List<Span>): String {
        if (ranges.isEmpty()) return collapse(c.text)
        val out = StringBuilder()
        var pos = 0
        for (r in ranges) {
            out.append(c.substring(pos, r.lo))
            pos = r.hi
            if (pos < c.count && c.nfc(pos) in setOf(",", ";", ":", ".", "!", "?")) {
                while (true) {
                    val last = lastCharacter(out) ?: break
                    if (!SwiftText.isWhiteSpace(last.codePointAt(0))) break
                    out.setLength(out.length - last.length)
                }
            }
        }
        out.append(c.substring(pos, c.count))
        val title = StringBuilder(collapse(out.toString()))
        while (true) {
            val last = lastCharacter(title) ?: break
            if (last != "," && last != ";" && last != ":") break
            title.setLength(title.length - last.length)
        }
        return SwiftText.trimmingWhitespaces(title.toString())
    }

    private fun lastCharacter(s: CharSequence): String? {
        if (s.isEmpty()) return null
        val str = s.toString()
        val b = SwiftText.characterBoundaries(str)
        return str.substring(b[b.size - 2])
    }

    private fun collapse(s: String): String {
        val c = SwiftChars(s)
        val words = ArrayList<String>()
        var k = 0
        while (k < c.count) {
            if (c.isWhitespace(k)) { k++; continue }
            val e = c.firstWhitespace(k)
            words += c.substring(k, e)
            k = e
        }
        return words.joinToString(" ")
    }
}
