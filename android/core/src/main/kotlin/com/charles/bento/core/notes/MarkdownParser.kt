package com.charles.bento.core.notes

import java.util.regex.MatchResult
import java.util.regex.Pattern

/**
 * Block type of one line. The editor is line based: every line is one block, like a
 * paragraph in Raycast's editor.
 */
sealed class BlockKind {
    data object Paragraph : BlockKind()
    data class Heading(val level: Int) : BlockKind()
    data object Bullet : BlockKind()
    data class Ordered(val number: Int) : BlockKind()
    data class Task(val checked: Boolean) : BlockKind()
    data class Quote(val depth: Int) : BlockKind()
    data object Rule : BlockKind()
    /** A ``` / ~~~ line. `opening` is false for the closing fence. */
    data class Fence(val opening: Boolean, val lang: String) : BlockKind()
    /** A line inside a fenced code block. */
    data object Code : BlockKind()
    /**
     * "<details><summary>Summary</summary>" (GitHub's HTML) or "::: details Summary"
     * (VitePress / markdown-it-container syntax): opens an expander.
     */
    data object Details : BlockKind()
    /** "</details>" or ":::": closes an expander. */
    data object DetailsEnd : BlockKind()

    val isList: Boolean get() = this is Bullet || this is Ordered || this is Task
}

/** Parse result of one line. Ranges are UTF-16 offsets relative to the line. */
data class ParsedLine(
    val kind: BlockKind,
    /** Nesting level for list items (0 = top level). */
    val level: Int = 0,
    /** Block syntax at the start of the line (indentation + marker), hidden in the editor. */
    val prefixRange: TextRange,
    /** Everything after the prefix (up to the suffix). */
    val contentRange: TextRange,
    /** Syntax after the content, hidden in the editor: an expander summary's "</summary>". */
    val suffixRange: TextRange? = null,
    /** Bullet char / "1." / "[ ]" etc. inside the prefix. */
    val markerRange: TextRange? = null,
    /** The literal list marker character: '-', '*', '+', or '.' / ')' for ordered lists. */
    val bulletChar: Char = '-',
) {
    val hasPrefix: Boolean get() = prefixRange.length > 0
}

sealed class InlineKind {
    data object Bold : InlineKind()
    data object Italic : InlineKind()
    data object BoldItalic : InlineKind()
    data object Strike : InlineKind()
    data object Underline : InlineKind()
    data object Code : InlineKind()
    data class Link(val url: String) : InlineKind()
    /** Bare URL or <url>; no hidden markers for bare URLs. */
    data class Autolink(val url: String) : InlineKind()
}

/** One inline construct. `range` includes the markers. */
data class InlineSpan(val kind: InlineKind, val range: TextRange, val contentRange: TextRange, val markers: List<TextRange>)

/** A line of a text with its parse result (`range` without the terminator). */
data class ParsedTextLine(val range: TextRange, val line: ParsedLine)

/** A code fence line: its character ('`' or '~') and info string. */
data class FenceInfo(val char: Char, val lang: String)

/** Markdown parsing for the editor, titles and plain text (port of MarkdownParser.swift). */
object MarkdownParser {
    private const val SPACE = ' '
    private const val TAB = '\t'
    private const val HASH = '#'
    private const val GT = '>'
    private const val DASH = '-'
    private const val STAR = '*'
    private const val PLUS = '+'
    private const val UNDERSCORE = '_'
    private const val BACKTICK = '`'
    private const val TILDE = '~'
    private const val LBRACKET = '['
    private const val RBRACKET = ']'
    private const val DOT = '.'
    private const val RPAREN = ')'
    private const val COLON = ':'
    private const val LT = '<'
    private const val DETAILS_WORD = "details"
    private const val DETAILS_TAG = "<details"
    private const val DETAILS_CLOSE = "</details>"
    private const val SUMMARY_TAG = "<summary>"
    private const val SUMMARY_CLOSE = "</summary>"

    /** Number of spaces one list nesting level is written with. */
    const val INDENT_UNIT = "    "

    // MARK: Blocks

    fun parseLine(u: String, inCode: Boolean): ParsedLine {
        val n = u.length
        val whole = TextRange(0, n)
        val empty = TextRange(n, 0)

        if (inCode) {
            if (isFence(u)?.lang?.isEmpty() == true) {
                return ParsedLine(BlockKind.Fence(opening = false, lang = ""), prefixRange = whole, contentRange = empty)
            }
            return ParsedLine(BlockKind.Code, prefixRange = TextRange(0, 0), contentRange = whole)
        }

        var i = 0
        var cols = 0
        while (i < n && (u[i] == SPACE || u[i] == TAB)) {
            cols += if (u[i] == TAB) 4 - cols % 4 else 1
            i++
        }

        if (cols <= 3) {
            val f = isFence(u)
            if (f != null) return ParsedLine(BlockKind.Fence(opening = true, lang = f.lang), prefixRange = whole, contentRange = empty)
        }

        if (cols <= 3) {
            val d = detailsLine(u, i) ?: detailsTagLine(u, i)
            if (d != null) return d
        }

        // Heading: up to 6 '#' followed by a space.
        if (cols <= 3 && i < n && u[i] == HASH) {
            var j = i
            while (j < n && u[j] == HASH) j++
            val level = j - i
            if (level <= 6 && j < n && u[j] == SPACE) {
                var k = j
                while (k < n && u[k] == SPACE) k++
                return ParsedLine(BlockKind.Heading(level), prefixRange = TextRange(0, k), contentRange = TextRange(k, n - k),
                    markerRange = TextRange(i, level))
            }
        }

        if (cols <= 3 && isRule(u, i)) {
            return ParsedLine(BlockKind.Rule, prefixRange = whole, contentRange = empty)
        }

        // Blockquote: one or more '>' each optionally followed by a space.
        if (cols <= 3 && i < n && u[i] == GT) {
            var j = i
            var depth = 0
            while (j < n && u[j] == GT) {
                depth++
                j++
                if (j < n && u[j] == SPACE) j++
                // allow "> > nested"
                var k = j
                while (k < n && u[k] == SPACE) k++
                if (k < n && u[k] == GT) j = k else break
            }
            return ParsedLine(BlockKind.Quote(depth), prefixRange = TextRange(0, j), contentRange = TextRange(j, n - j),
                markerRange = TextRange(i, j - i))
        }

        val level = (cols + 3) / 4

        // Bullet / task: [-*+] followed by a space.
        if (i < n && (u[i] == DASH || u[i] == STAR || u[i] == PLUS) && i + 1 < n && u[i + 1] == SPACE) {
            val bullet = u[i]
            var j = i + 2
            // Task: "[ ]" / "[x]" followed by a space or end of line.
            if (j + 2 < n && u[j] == LBRACKET && u[j + 2] == RBRACKET &&
                (u[j + 1] == SPACE || u[j + 1] == 'x' || u[j + 1] == 'X') &&
                (j + 3 == n || u[j + 3] == SPACE)
            ) {
                val checked = u[j + 1] != SPACE
                val marker = TextRange(j, 3)
                j += 3
                if (j < n) j++
                return ParsedLine(BlockKind.Task(checked), level, prefixRange = TextRange(0, j), contentRange = TextRange(j, n - j),
                    markerRange = marker, bulletChar = bullet)
            }
            return ParsedLine(BlockKind.Bullet, level, prefixRange = TextRange(0, j), contentRange = TextRange(j, n - j),
                markerRange = TextRange(i, 1), bulletChar = bullet)
        }

        // Ordered: 1-9 digits, '.' or ')', then a space.
        if (i < n && u[i] in '0'..'9') {
            var j = i
            while (j < n && j - i < 9 && u[j] in '0'..'9') j++
            if (j < n && (u[j] == DOT || u[j] == RPAREN) && j + 1 < n && u[j + 1] == SPACE) {
                val number = u.substring(i, j).toIntOrNull() ?: 1
                return ParsedLine(BlockKind.Ordered(number), level, prefixRange = TextRange(0, j + 2), contentRange = TextRange(j + 2, n - j - 2),
                    markerRange = TextRange(i, j - i + 1), bulletChar = u[j])
            }
        }

        return ParsedLine(BlockKind.Paragraph, prefixRange = TextRange(0, 0), contentRange = whole)
    }

    /** ``` or ~~~ (3+) at the start (after ≤3 spaces); returns the info string. */
    fun isFence(u: String): FenceInfo? {
        var i = 0
        while (i < u.length && i < 4 && u[i] == SPACE) i++
        if (!(i < 4 && i < u.length && (u[i] == BACKTICK || u[i] == TILDE))) return null
        val c = u[i]
        var j = i
        while (j < u.length && u[j] == c) j++
        if (j - i < 3) return null
        val rest = SwiftText.trimWhitespaces(u.substring(j))
        if (c == BACKTICK && containsCharacter(rest, "`")) return null
        return FenceInfo(c, rest)
    }

    /** Swift's `String.contains` for a one-character needle: some character is exactly it. */
    private fun containsCharacter(s: String, c: String): Boolean {
        if (!s.contains(c)) return false
        val b = Graphemes.boundaries(s)
        for (k in 0 until b.size - 1) if (s.regionMatches(b[k], c, 0, c.length) && b[k + 1] - b[k] == c.length) return true
        return false
    }

    /** "::: details <summary>" (an expander's header) or a bare ":::" (its end). */
    private fun detailsLine(u: String, i: Int): ParsedLine? {
        val n = u.length
        if (!(i + 2 < n && u[i] == COLON && u[i + 1] == COLON && u[i + 2] == COLON)) return null
        var j = i + 3
        while (j < n && (u[j] == SPACE || u[j] == TAB)) j++
        if (j == n) {
            return ParsedLine(BlockKind.DetailsEnd, prefixRange = TextRange(0, n), contentRange = TextRange(n, 0))
        }
        val w = DETAILS_WORD.length
        if (!(j + w <= n && u.regionMatches(j, DETAILS_WORD, 0, w) && (j + w == n || u[j + w] == SPACE))) return null
        var k = j + w
        while (k < n && u[k] == SPACE) k++
        return ParsedLine(BlockKind.Details, prefixRange = TextRange(0, k), contentRange = TextRange(k, n - k),
            markerRange = TextRange(i, j + w - i))
    }

    /**
     * "<details>" / "<details open>", optionally followed by "<summary>Summary</summary>"
     * on the same line (an expander's header), or "</details>" (its end). Tags are
     * matched case-insensitively.
     */
    private fun detailsTagLine(u: String, i: Int): ParsedLine? {
        val n = u.length
        if (!(i < n && u[i] == LT)) return null
        fun at(j: Int, word: String): Boolean {
            if (j + word.length > n) return false
            for (k in word.indices) if (lower(u[j + k]) != word[k]) return false
            return true
        }
        if (at(i, DETAILS_CLOSE)) {
            var j = i + DETAILS_CLOSE.length
            while (j < n && (u[j] == SPACE || u[j] == TAB)) j++
            if (j != n) return null
            return ParsedLine(BlockKind.DetailsEnd, prefixRange = TextRange(0, n), contentRange = TextRange(n, 0))
        }
        if (!at(i, DETAILS_TAG)) return null
        var j = i + DETAILS_TAG.length
        if (!(j < n && (u[j] == GT || u[j] == SPACE || u[j] == TAB))) return null
        while (j < n && u[j] != GT) j++
        if (j >= n) return null
        val tagEnd = j + 1
        var k = tagEnd
        while (k < n && (u[k] == SPACE || u[k] == TAB)) k++
        if (at(k, SUMMARY_TAG)) k += SUMMARY_TAG.length
        var end = n
        var suffix: TextRange? = null
        val c = (k until n).firstOrNull { at(it, SUMMARY_CLOSE) }
        if (c != null) {
            end = c
            suffix = TextRange(c, n - c)
        }
        return ParsedLine(BlockKind.Details, prefixRange = TextRange(0, k), contentRange = TextRange(k, end - k),
            suffixRange = suffix, markerRange = TextRange(i, tagEnd - i))
    }

    private fun lower(c: Char): Char = if (c in 'A'..'Z') c + 32 else c

    /** Whether an expander header line asks to start open ("<details open>"). */
    fun detailsStartsOpen(line: String): Boolean {
        val t = SwiftText.lowercased(SwiftText.trimWhitespaces(line))
        if (!swiftHasPrefix(t, "<details")) return false
        // by character, as Swift's firstIndex(of:) and split(whereSeparator:) see it
        val chars = Graphemes.characters(t)
        val close = chars.indexOf(">")
        if (close < 0) return false
        val words = ArrayList<List<String>>()
        var cur = ArrayList<String>()
        for (ch in chars.subList(0, close)) {
            if (ch == " " || ch == "\t") {
                if (cur.isNotEmpty()) words.add(cur)
                cur = ArrayList()
            } else {
                cur.add(ch)
            }
        }
        if (cur.isNotEmpty()) words.add(cur)
        return words.drop(1).any { w -> w == OPEN || (w.size >= OPEN_EQ.size && w.subList(0, OPEN_EQ.size) == OPEN_EQ) }
    }

    private val OPEN = listOf("o", "p", "e", "n")
    private val OPEN_EQ = listOf("o", "p", "e", "n", "=")

    /**
     * End of the visible text of the line `full`: before a summary's "</summary>", else
     * before the line terminator.
     */
    fun visibleEnd(full: TextRange, text: String): Int {
        val r = contentRange(full, text)
        val p = parseLine(text.substring(r.location, r.end), inCode = false)
        val sr = p.suffixRange
        if (p.kind != BlockKind.Details || sr == null) return r.end
        return r.location + sr.location
    }

    fun isRule(s: String): Boolean = isRule(s, 0)

    fun isRule(u: String, start: Int): Boolean {
        var ch = 0.toChar()
        var count = 0
        for (i in start until u.length) {
            val c = u[i]
            if (c == SPACE || c == TAB) continue
            if (!(c == DASH || c == STAR || c == UNDERSCORE)) return false
            if (ch.code == 0) ch = c else if (c != ch) return false
            count++
        }
        return count >= 3
    }

    /**
     * Lines of `text` with their ranges and parse results, tracking fences.
     * `startInCode` is the fence state before `range`.
     */
    fun parseLines(text: String, range: TextRange? = null, startInCode: Boolean = false): List<ParsedTextLine> {
        val r = range ?: TextRange(0, text.length)
        val out = ArrayList<ParsedTextLine>()
        var inCode = startInCode
        var loc = r.location
        val end = r.end
        while (true) {
            val lineRange = SwiftText.lineRange(text, loc)
            var contentEnd = lineRange.end
            // strip the line terminator
            if (contentEnd > lineRange.location && text[contentEnd - 1] == '\n') contentEnd--
            if (contentEnd > lineRange.location && text[contentEnd - 1] == '\r') contentEnd--
            val lr = TextRange(lineRange.location, contentEnd - lineRange.location)
            val p = parseLine(text.substring(lr.location, lr.end), inCode)
            val k = p.kind
            if (k is BlockKind.Fence) inCode = k.opening
            out.add(ParsedTextLine(lr, p))
            loc = lineRange.end
            // A final "\n" is followed by an empty last line.
            val trailingEmptyLine = loc == text.length && lineRange.length > 0 && text[loc - 1] == '\n'
            if (loc > end || (loc == end && !trailingEmptyLine) || lineRange.length == 0) break
        }
        return out
    }

    /**
     * The closing "</details>" or ":::" line (without newline) of the expander whose
     * summary line is `summary`; null when another expander or the end of the note comes
     * first.
     */
    fun expanderEnd(summary: TextRange, text: String): TextRange? {
        if (!(summary.location >= 0 && summary.length > 0 && summary.location <= text.length &&
                summary.length <= text.length - summary.location)) return null
        var loc = summary.end
        val header = contentRange(summary, text)
        if (!(header.length < summary.length &&
                parseLine(text.substring(header.location, header.end), inCode = false).kind == BlockKind.Details)) return null
        var inCode = false
        while (loc < text.length) {
            val full = SwiftText.lineRange(text, loc)
            val r = contentRange(full, text)
            when (val k = parseLine(text.substring(r.location, r.end), inCode).kind) {
                BlockKind.DetailsEnd -> return r
                BlockKind.Details -> return null
                is BlockKind.Fence -> inCode = k.opening
                else -> {}
            }
            loc = full.end
        }
        return null
    }

    /** A full line range without its LF, CRLF or CR terminator. */
    fun contentRange(full: TextRange, text: String): TextRange {
        var end = full.end
        if (end > full.location && text[end - 1] == '\n') end--
        if (end > full.location && text[end - 1] == '\r') end--
        return TextRange(full.location, end - full.location)
    }

    /**
     * Whether the line starting at `lineStart` is inside a fenced code block (i.e. an odd
     * number of fence lines precede it).
     */
    fun isInCode(text: String, lineStart: Int): Boolean {
        var inCode = false
        var loc = 0
        while (loc < lineStart) {
            val lr = SwiftText.lineRange(text, loc)
            // cheap pre-check before decoding the line
            val first = firstNonSpace(text, lr)
            if (first == BACKTICK || first == TILDE) {
                val cr = contentRange(lr, text)
                val f = isFence(text.substring(cr.location, cr.end))
                if (f != null) {
                    if (inCode) {
                        if (f.lang.isEmpty()) inCode = false
                    } else {
                        inCode = true
                    }
                }
            }
            if (lr.length == 0) break
            loc = lr.end
        }
        return inCode
    }

    private fun firstNonSpace(text: String, r: TextRange): Char {
        var i = r.location
        while (i < r.end && i - r.location < 4) {
            val c = text[i]
            if (c != SPACE) return c
            i++
        }
        return 0.toChar()
    }

    // MARK: Inline

    /*
     * The Mac's patterns run on ICU (NSRegularExpression). java.util.regex has other
     * meanings for \s, \S, \w and `.` (ASCII only; `.` also crosses VT and FF), and
     * Android's engine others again, so they're spelled out as ICU defines them.
     */
    /** ICU `\s`: White_Space. */
    private const val WS = "\\t\\n\\u000B\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000"
    /** ICU `\w`: Alphabetic, marks, decimal digits, connector punctuation, ZWNJ, ZWJ. */
    private const val W = "\\p{L}\\p{M}\\p{Nd}\\p{Pc}\\p{Nl}\\u200C\\u200D\\u24B6-\\u24E9" +
        "\\x{1F130}-\\x{1F149}\\x{1F150}-\\x{1F169}\\x{1F170}-\\x{1F189}"
    /** ICU `.`: anything but a line terminator. */
    private const val ANY = "[^\\n\\u000B\\f\\r\\u0085\\u2028\\u2029]"
    /** ICU `\S`. */
    private const val NS = "[^$WS]"

    private fun re(p: String): Pattern = Pattern.compile(p)
    private val linkRE = re("\\[([^\\[\\]\\n]+)\\]\\(([^()$WS]*)\\)")
    private val angleRE = re("<((?:https?|mailto|ftp)://[^$WS<>]+|mailto:[^$WS<>]+)>")
    private val urlRE = re("(?<![$W/@])(?:https?://|www\\.)[^$WS<>\\[\\]]+")
    private val underlineRE = re("<u>($ANY+?)</u>")
    private val boldItalicRE = re("(?<![\\\\*])(\\*\\*\\*|___)(?=$NS)($ANY+?)(?<=$NS)\\1(?!\\*)")
    private val boldRE = re("(?<![\\\\*])(\\*\\*|__)(?=$NS)($ANY+?)(?<=[^$WS\\\\])\\1")
    private val strikeRE = re("(?<!\\\\)~~(?=$NS)($ANY+?)(?<=$NS)~~")
    private val italicStarRE = re("(?<![\\*\\\\])\\*(?=[^$WS\\*])($ANY+?)(?<=[^$WS\\*\\\\])\\*(?!\\*)")
    private val italicUnderRE = re("(?<![_$W\\\\])_(?=[^${WS}_])($ANY+?)(?<=[^${WS}_\\\\])_(?![_$W])")

    /** All non-overlapping matches, left to right (NSRegularExpression.matches). */
    internal fun matches(p: Pattern, text: String): List<MatchResult> {
        val m = p.matcher(text)
        val out = ArrayList<MatchResult>()
        while (m.find()) out.add(m.toMatchResult())
        return out
    }

    private fun MatchResult.range(group: Int = 0): TextRange = TextRange(start(group), end(group) - start(group))

    private fun intersects(a: TextRange, b: TextRange): Boolean = maxOf(a.location, b.location) < minOf(a.end, b.end)

    /**
     * Inline spans in `text` (one line or a content range of it). Ranges are in `text`'s
     * coordinates; pass `range` to restrict to part of the string.
     */
    fun inlineSpans(text: String, range: TextRange? = null): List<InlineSpan> {
        val r = range ?: TextRange(0, text.length)
        if (r.length <= 0) return emptyList()
        if (!(r.location == 0 && r.length == text.length)) {
            val sub = text.substring(r.location, r.end)
            fun shift(x: TextRange) = TextRange(x.location + r.location, x.length)
            return inlineSpansOfWhole(sub).map { sp ->
                InlineSpan(sp.kind, shift(sp.range), shift(sp.contentRange), sp.markers.map(::shift))
            }
        }
        return inlineSpansOfWhole(text)
    }

    private fun inlineSpansOfWhole(text: String): List<InlineSpan> {
        val r = TextRange(0, text.length)
        if (r.length <= 0) return emptyList()
        val spans = ArrayList<InlineSpan>()
        // Ranges no other construct may partially overlap (code spans, link urls).
        val hard = ArrayList<TextRange>()

        // 1. Code spans.
        var i = r.location
        val end = r.end
        while (i < end) {
            if (text[i] == BACKTICK) {
                var j = i
                while (j < end && text[j] == BACKTICK) j++
                val k = j - i
                // find closing run of exactly k
                var m = j
                var found = -1
                while (m < end) {
                    if (text[m] == BACKTICK) {
                        var e = m
                        while (e < end && text[e] == BACKTICK) e++
                        if (e - m == k) {
                            found = m
                            break
                        }
                        m = e
                    } else {
                        m++
                    }
                }
                if (found > j) {
                    val full = TextRange(i, found + k - i)
                    spans.add(InlineSpan(InlineKind.Code, full, TextRange(j, found - j), listOf(TextRange(i, k), TextRange(found, k))))
                    hard.add(full)
                    i = found + k
                    continue
                }
                i = j
                continue
            }
            i++
        }

        fun free(x: TextRange) = hard.none { intersects(it, x) }
        fun allowed(whole: TextRange, markers: List<TextRange>): Boolean {
            // markers must not touch hard ranges; hard ranges must be fully inside or outside.
            for (h in hard) {
                for (mk in markers) if (intersects(h, mk)) return false
                val lo = maxOf(h.location, whole.location)
                val hi = minOf(h.end, whole.end)
                if (hi > lo && hi - lo != h.length) return false
            }
            return true
        }

        // 2. Links [text](url)
        for (m in matches(linkRE, text)) {
            val whole = m.range()
            if (!free(whole)) continue
            val textR = m.range(1)
            val urlR = m.range(2)
            val open = TextRange(whole.location, 1)
            val close = TextRange(textR.end, whole.end - textR.end)
            spans.add(InlineSpan(InlineKind.Link(text.substring(urlR.location, urlR.end)), whole, textR, listOf(open, close)))
            hard.add(open)
            hard.add(close)
        }
        // 3. <url> and bare URLs
        for (m in matches(angleRE, text)) {
            if (!free(m.range())) continue
            val inner = m.range(1)
            spans.add(InlineSpan(InlineKind.Autolink(text.substring(inner.location, inner.end)), m.range(), inner,
                listOf(TextRange(m.start(), 1), TextRange(inner.end, 1))))
            hard.add(m.range())
        }
        for (m in matches(urlRE, text)) {
            var u = m.range()
            // trim trailing punctuation
            while (u.length > 0) {
                val c = text[u.end - 1]
                if (c in ".,;:!?)'\"*_~") u = TextRange(u.location, u.length - 1) else break
            }
            if (!(u.length > 4 && free(u) && spans.none { intersects(it.range, u) })) continue
            var url = text.substring(u.location, u.end)
            if (swiftHasPrefix(url, "www.")) url = "https://$url"
            spans.add(InlineSpan(InlineKind.Autolink(url), u, u, emptyList()))
            hard.add(u)
        }

        // 4. Emphasis-like constructs.
        val used = ArrayList<TextRange>() // marker ranges already claimed
        fun add(re: Pattern, kind: InlineKind, markerLen: Int) {
            for (m in matches(re, text)) {
                val whole = m.range()
                val open = TextRange(whole.location, markerLen)
                val close = TextRange(whole.end - markerLen, markerLen)
                if (!allowed(whole, listOf(open, close)) || used.any { intersects(it, open) || intersects(it, close) }) continue
                spans.add(InlineSpan(kind, whole, TextRange(open.end, close.location - open.end), listOf(open, close)))
                used.add(open)
                used.add(close)
            }
        }
        for (m in matches(underlineRE, text)) {
            val whole = m.range()
            val open = TextRange(whole.location, 3)
            val close = TextRange(whole.end - 4, 4)
            if (!allowed(whole, listOf(open, close))) continue
            spans.add(InlineSpan(InlineKind.Underline, whole, m.range(1), listOf(open, close)))
            used.add(open)
            used.add(close)
        }
        add(boldItalicRE, InlineKind.BoldItalic, 3)
        add(boldRE, InlineKind.Bold, 2)
        add(strikeRE, InlineKind.Strike, 2)
        add(italicStarRE, InlineKind.Italic, 1)
        add(italicUnderRE, InlineKind.Italic, 1)

        return spans.sortedBy { it.range.location }
    }

    /** Inline markdown removed: `**a** [b](c)` -> `a b`. */
    fun stripInline(s: String): String {
        val spans = inlineSpans(s)
        if (spans.isEmpty()) return s
        val remove = BooleanArray(s.length)
        for (sp in spans) for (m in sp.markers) for (k in m.location until m.end) remove[k] = true
        val out = StringBuilder(s.length)
        for (k in s.indices) if (!remove[k]) out.append(s[k])
        return out.toString()
    }
}

/**
 * Swift's `hasPrefix` for an ASCII prefix: by characters, so "<details" isn't a prefix of
 * "<detailś".
 */
internal fun swiftHasPrefix(s: String, prefix: String): Boolean {
    if (!s.startsWith(prefix)) return false
    if (s.length == prefix.length || prefix.isEmpty()) return true
    return isCharacterBoundary(s, prefix.length)
}

/** Swift's `hasSuffix` for an ASCII suffix: "a\r\n" doesn't end with "\n". */
internal fun swiftHasSuffix(s: String, suffix: String): Boolean {
    if (!s.endsWith(suffix)) return false
    if (s.length == suffix.length || suffix.isEmpty()) return true
    return isCharacterBoundary(s, s.length - suffix.length)
}

/** Whether a Swift character boundary falls at UTF-16 offset `i` of `s`. */
internal fun isCharacterBoundary(s: String, i: Int): Boolean {
    if (i <= 0 || i >= s.length) return true
    // characters never span more than the text since the previous line break or the start
    var from = i - 1
    while (from > 0 && s[from - 1] != '\n') from--
    var to = i
    while (to < s.length && s[to] != '\n') to++
    if (to < s.length) to++
    val b = Graphemes.boundaries(s.substring(from, to))
    return b.binarySearch(i - from) >= 0
}
