package com.charles.bento.core.notes

import java.text.Normalizer
import kotlin.math.max
import kotlin.math.min

/**
 * Small fuzzy matcher for the notes list (Raycast-like: subsequence match with bonuses
 * for word starts and consecutive characters). A port of FuzzyMatch.swift.
 */
object FuzzyMatch {
    /** Score of `query` against `text` (higher is better), null when not matched. */
    fun score(query: String, text: String): Int? {
        val q = scalars(SwiftText.lowercased(query)).filter { !SwiftText.isWhitespace(it) }
        if (q.isEmpty()) return 0
        val lower = SwiftText.lowercased(text)
        val t = scalars(lower)
        if (t.size < q.size) return null
        // Exact substring gets a big bonus.
        val pos = characterOffsetOf(lower, SwiftText.trimWhitespaces(SwiftText.lowercased(query)))
        if (pos != null) return 1000 - min(pos, 500) + (if (pos == 0) 200 else 0)
        var score = 0
        var ti = 0
        var prevMatch = -2
        for (qc in q) {
            var found = false
            while (ti < t.size) {
                if (t[ti] == qc) {
                    var s = 10
                    if (ti == prevMatch + 1) s += 15
                    if (ti == 0 || !SwiftText.isAlphanumeric(t[ti - 1])) s += 20
                    score += s
                    prevMatch = ti
                    ti++
                    found = true
                    break
                }
                ti++
            }
            if (!found) return null
        }
        return score - min(t.size / 10, 50)
    }

    /** Scores a note: title (fuzzy) weighs more than body (substring/fuzzy on words). */
    fun noteScore(query: String, title: String, body: String): Int? {
        val q = SwiftText.trimWhitespaces(query)
        if (q.isEmpty()) return 0
        var best: Int? = null
        score(q, title)?.let { best = it + 500 }
        // body: every word of the query must appear
        val words = splitOnSpaceCharacters(SwiftText.lowercased(q))
        val lower = SwiftText.lowercased(body)
        if (words.all { characterOffsetOf(lower, it) != null }) {
            val s = 300 - min(Graphemes.count(lower) / 200, 100)
            best = max(best ?: Int.MIN_VALUE, s)
        }
        return best
    }

    private fun scalars(s: String): IntArray = s.codePoints().toArray()

    /**
     * Foundation's `range(of:)` (canonically equivalent; a match must end a cluster), as
     * the number of characters before the match; null when not found or `needle` is empty.
     */
    private fun characterOffsetOf(hay: String, needle: String): Int? {
        if (needle.isEmpty()) return null
        find(hay, needle)?.let { return Graphemes.count(hay.substring(0, it)) }
        val h = Normalizer.normalize(hay, Normalizer.Form.NFC)
        val n = Normalizer.normalize(needle, Normalizer.Form.NFC)
        if (h == hay && n == needle) return null
        return find(h, n)?.let { Graphemes.count(h.substring(0, it)) }
    }

    private fun find(hay: String, needle: String): Int? {
        var from = 0
        while (true) {
            val i = hay.indexOf(needle, from)
            if (i < 0) return null
            if (SwiftText.foundationMatchEnds(hay, i + needle.length) && !(i > 0 && hay[i].isLowSurrogate())) return i
            from = i + 1
        }
    }

    /** `split(separator: " ")`: at characters that are exactly a space, no empty pieces. */
    private fun splitOnSpaceCharacters(s: String): List<String> {
        val out = ArrayList<String>()
        val b = Graphemes.boundaries(s)
        var start = 0
        for (k in 0 until b.size - 1) {
            if (b[k + 1] - b[k] == 1 && s[b[k]] == ' ') {
                if (b[k] > start) out.add(s.substring(start, b[k]))
                start = b[k + 1]
            }
        }
        if (s.length > start) out.add(s.substring(start))
        return out
    }
}
