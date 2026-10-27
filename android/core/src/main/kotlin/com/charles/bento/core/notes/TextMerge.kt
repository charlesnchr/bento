package com.charles.bento.core.notes

import kotlin.math.max
import kotlin.math.min

/** One replacement in original-text coordinates. */
data class TextEdit(val range: TextRange, val replacement: String) {
    constructor(location: Int, length: Int, replacement: String) : this(TextRange(location, length), replacement)
}

/**
 * Text diffs, three-way merges and selection mapping for live sync. Ranges are UTF-16
 * offsets (Kotlin string indices, like NSString's) and never split a composed character
 * (emoji, accents).
 *
 * A port of the Mac's TextMerge.swift that must give the same edits and merges byte for
 * byte: characters are Swift's (see [Graphemes]), the unchanged start and end are aligned
 * to NSString's composed character sequences (see [ComposedCharacters]), and two edits
 * are "the same change" when Swift's `==` says so (canonical equivalence).
 */
object TextMerge {
    /** The edits that turn `old` into `new`: sorted, non-overlapping, in `old`'s coordinates. */
    fun edits(old: String, new: String): List<TextEdit> {
        // unchanged start and end (cheap, UTF-16), on composed-character boundaries
        var p = 0
        while (p < old.length && p < new.length && old[p] == new[p]) p++
        if (p == old.length && p == new.length) return emptyList()
        if (p < old.length) p = min(p, ComposedCharacters.range(old, p).location)
        if (p < new.length) p = min(p, ComposedCharacters.range(new, p).location)
        var s = 0
        while (s < min(old.length, new.length) - p && old[old.length - 1 - s] == new[new.length - 1 - s]) s++
        fun endAligned(str: String, s: Int): Int {
            val e = str.length - s
            if (!(e > p && e < str.length)) return s
            val r = ComposedCharacters.range(str, e)
            return if (r.location < e) str.length - r.end else s
        }
        s = max(0, min(endAligned(old, s), endAligned(new, s)))
        val oldMid = old.substring(p, old.length - s)
        val newMid = new.substring(p, new.length - s)
        // the middle by character, compared as exact UTF-16
        val interned = Interner()
        val oa = Graphemes.boundaries(oldMid)
        val ob = Graphemes.boundaries(newMid)
        val a = IntArray(oa.size - 1) { interned.id(oldMid, oa[it], oa[it + 1]) }
        val b = IntArray(ob.size - 1) { interned.id(newMid, ob[it], ob[it + 1]) }
        fun edit(h: Hunk): TextEdit {
            val lo = ob[h.bLo]
            val hi = ob[h.bHi]
            return TextEdit(TextRange(p + oa[h.aLo], oa[h.aHi] - oa[h.aLo]), newMid.substring(lo, hi))
        }
        val whole = edit(Hunk(0, a.size, 0, b.size))
        val result = absorbed(shifted(align(a, 0, a.size, b, 0, b.size).map(::edit), old), old)
        // Tokens compare exact UTF-16, so this holds; never hand out edits that don't.
        if (apply(result, old) != new) return listOf(whole)
        return result
    }

    /**
     * Moves an insertion or deletion sideways into its neighbour when the unchanged text
     * between them repeats at its own end or start ("A line" + kept "\n" + inserted "\n"
     * is one insertion "A line\n"), so the same change diffs the same way against
     * different texts and merges don't duplicate it.
     */
    private fun shifted(edits: List<TextEdit>, old: String): List<TextEdit> {
        if (edits.size <= 1) return edits
        // the inserted or deleted text, null for replacements
        fun text(e: TextEdit): String? {
            if (e.range.length == 0) return e.replacement
            return if (e.replacement.isEmpty()) old.substring(e.range.location, e.range.end) else null
        }
        val out = mutableListOf(edits[0])
        for (i in 1 until edits.size) {
            var e = edits[i]
            val prev = out[out.size - 1]
            val gap = old.substring(prev.range.end, e.range.location)
            val t = text(e)
            if (t != null && gap.isNotEmpty() && t.length >= gap.length && t.endsWith(gap)) {
                val g = gap.length
                e = if (e.range.length == 0) {
                    TextEdit(TextRange(prev.range.end, 0), gap + t.substring(0, t.length - g))
                } else {
                    e.copy(range = TextRange(prev.range.end, e.range.length))
                }
            }
            if (e.range.location == prev.range.end) {
                out[out.size - 1] = TextEdit(TextRange(prev.range.location, prev.range.length + e.range.length), prev.replacement + e.replacement)
            } else {
                out.add(e)
            }
        }
        return out
    }

    /**
     * Joins edits separated by unchanged text no longer than the edits on either side
     * when one of them deletes text: "base" → "edited" is one replacement, not pieces
     * around a shared "e" that would merge into a mix of two different rewrites. (Text
     * between two pure insertions really is unchanged.)
     */
    private fun absorbed(edits: List<TextEdit>, old: String): List<TextEdit> {
        val out = mutableListOf<TextEdit>()
        fun size(x: TextEdit) = max(x.range.length, x.replacement.length)
        for (e in edits) {
            val prev = out.lastOrNull()
            if (prev == null) {
                out.add(e)
                continue
            }
            val gap = e.range.location - prev.range.end
            if ((prev.range.length > 0 || e.range.length > 0) && gap <= size(prev) && gap <= size(e)) {
                val kept = old.substring(prev.range.end, prev.range.end + gap)
                out[out.size - 1] = TextEdit(TextRange(prev.range.location, e.range.end - prev.range.location), prev.replacement + kept + e.replacement)
            } else {
                out.add(e)
            }
        }
        return out
    }

    /**
     * Applies sorted, non-overlapping edits (several may start at one offset: insertions
     * first, in order).
     */
    fun apply(edits: List<TextEdit>, text: String): String {
        val out = StringBuilder()
        var pos = 0
        for (e in edits) {
            out.append(text, pos, e.range.location)
            out.append(e.replacement)
            pos = e.range.end
        }
        out.append(text, pos, text.length)
        return out.toString()
    }

    /**
     * `base` became `local` on this device and `remote` on another: both changes applied
     * together, or null when they touch the same text. Symmetric (merging remote into
     * local gives the same text as local into remote), so two devices merging the same
     * pair of versions agree.
     */
    fun merge(base: String, local: String, remote: String): String? {
        if (local == remote || base == remote) return local
        if (base == local) return remote
        val l = edits(base, local)
        val r = edits(base, remote)
        val out = mutableListOf<TextEdit>()
        var i = 0
        var j = 0
        while (i < l.size && j < r.size) {
            val x = l[i]
            val y = r[j]
            if (sameEdit(x, y)) { // the same change on both
                out.add(x)
                i++
                j++
                continue
            }
            if (x.range.length == 0 && y.range.length == 0 && x.range.location == y.range.location) {
                val both = combine(x.replacement, y.replacement) ?: return null
                out.add(TextEdit(x.range, both))
                i++
                j++
                continue
            }
            if (x.range.end <= y.range.location) {
                out.add(x)
                i++
            } else if (y.range.end <= x.range.location) {
                out.add(y)
                j++
            } else {
                return null // overlapping changes
            }
        }
        out.addAll(l.subList(i, l.size))
        out.addAll(r.subList(j, r.size))
        return apply(out, base)
    }

    /** Swift's `TextEdit ==`: the same range and canonically equivalent replacements. */
    private fun sameEdit(x: TextEdit, y: TextEdit) = x.range == y.range && SwiftText.canonicallyEqual(x.replacement, y.replacement)

    /**
     * Two insertions at the same spot (both typed there): both, in an order both devices
     * agree on. null when one starts or ends with the other: that's the same typing seen
     * from two different bases, and keeping both would duplicate it.
     */
    fun combine(x: String, y: String): String? {
        fun contains(l: String, s: String) = l.startsWith(s) || l.endsWith(s)
        if (contains(x, y) || contains(y, x)) return null
        return if (x < y) x + y else y + x
    }

    /**
     * Where a selection ends up after `edits` (sorted, in its text's coordinates), like
     * Google Docs: text inserted or deleted before it shifts it, text after it doesn't
     * (text inserted right at a caret goes after it). A selection doesn't grow to take in
     * text inserted at its ends.
     */
    fun map(sel: TextRange, edits: List<TextEdit>): TextRange {
        if (edits.isEmpty()) return sel
        if (sel.length == 0) return TextRange(map(sel.location, edits, pastInsertions = false, insideToEnd = true), 0)
        val a = map(sel.location, edits, pastInsertions = true, insideToEnd = false)
        val b = map(sel.end, edits, pastInsertions = false, insideToEnd = true)
        return TextRange(a, max(0, b - a))
    }

    /**
     * Maps one offset. `pastInsertions`: text inserted exactly at it ends up before it.
     * `insideToEnd`: an offset inside replaced text goes to the end of the replacement
     * (else to its start).
     */
    fun map(x: Int, edits: List<TextEdit>, pastInsertions: Boolean, insideToEnd: Boolean): Int {
        var delta = 0
        for (e in edits) {
            val start = e.range.location
            val end = e.range.end
            val len = e.replacement.length
            if (x < start || (x == start && (e.range.length > 0 || !pastInsertions))) break
            if (x >= end) {
                delta += len - e.range.length
                continue
            }
            return start + delta + (if (insideToEnd) len else 0)
        }
        return x + delta
    }

    // MARK: Diff

    /** Token ranges `aLo until aHi` in a, `bLo until bHi` in b. */
    private data class Hunk(val aLo: Int, val aHi: Int, val bLo: Int, val bHi: Int)

    /*
     * Myers' diff takes O((n + m)·D) time and O(D²) memory for D differences, so it gives
     * up past a limit: long stretches are diffed by line first, then the changed lines by
     * character; whatever is still too different becomes one replacement.
     */
    private const val MAX_CHAR_TOKENS = 10_000
    private const val MAX_CHAR_CHANGES = 300
    private const val MAX_LINES = 40_000
    private const val MAX_LINE_CHANGES = 1_000

    /** Changed stretches between `a[raLo until raHi]` and `b[rbLo until rbHi]` (token indices). */
    private fun align(a: IntArray, raLo: Int, raHi: Int, b: IntArray, rbLo: Int, rbHi: Int): List<Hunk> {
        if (raLo == raHi && rbLo == rbHi) return emptyList()
        if (raLo == raHi || rbLo == rbHi) return listOf(Hunk(raLo, raHi, rbLo, rbHi))
        charDiff(a, raLo, raHi, b, rbLo, rbHi)?.let { return it }
        val la = lines(a, raLo, raHi)
        val lb = lines(b, rbLo, rbHi)
        if (la.size + lb.size > MAX_LINES) return listOf(Hunk(raLo, raHi, rbLo, rbHi))
        val ids = HashMap<List<Int>, Int>()
        fun id(t: IntArray, r: IntRange): Int = ids.getOrPut(t.asList().subList(r.first, r.last + 1)) { ids.size }
        val ia = IntArray(la.size) { id(a, la[it]) }
        val ib = IntArray(lb.size) { id(b, lb[it]) }
        val lineHunks = diff(ia, ib, MAX_LINE_CHANGES) ?: return listOf(Hunk(raLo, raHi, rbLo, rbHi))
        // token span of the lines `lo until hi`
        fun span(lines: List<IntRange>, lo: Int, hi: Int, end: Int): IntArray {
            if (lo == hi) {
                val at = if (lo < lines.size) lines[lo].first else end
                return intArrayOf(at, at)
            }
            return intArrayOf(lines[lo].first, lines[hi - 1].last + 1)
        }
        return lineHunks.flatMap { h ->
            val ta = span(la, h.aLo, h.aHi, raHi)
            val tb = span(lb, h.bLo, h.bHi, rbHi)
            if (ta[0] == ta[1] || tb[0] == tb[1]) listOf(Hunk(ta[0], ta[1], tb[0], tb[1]))
            else charDiff(a, ta[0], ta[1], b, tb[0], tb[1]) ?: listOf(Hunk(ta[0], ta[1], tb[0], tb[1]))
        }
    }

    private fun charDiff(a: IntArray, raLo: Int, raHi: Int, b: IntArray, rbLo: Int, rbHi: Int): List<Hunk>? {
        if ((raHi - raLo) + (rbHi - rbLo) > MAX_CHAR_TOKENS) return null
        val h = diff(a.copyOfRange(raLo, raHi), b.copyOfRange(rbLo, rbHi), MAX_CHAR_CHANGES) ?: return null
        return h.map { Hunk(it.aLo + raLo, it.aHi + raLo, it.bLo + rbLo, it.bHi + rbLo) }
    }

    /** Token ranges of the lines in `t[lo until hi]`, each with its line break. */
    private fun lines(t: IntArray, lo: Int, hi: Int): List<IntRange> {
        val out = ArrayList<IntRange>()
        var start = lo
        for (i in lo until hi) {
            if (t[i] == Interner.NEWLINE || t[i] == Interner.CRLF || t[i] == 13) {
                out.add(start..i)
                start = i + 1
            }
        }
        if (start < hi) out.add(start until hi)
        return out
    }

    /** Changed stretches between two token arrays (Myers), null past `maxChanges`. */
    private fun diff(a: IntArray, b: IntArray, maxChanges: Int): List<Hunk>? {
        val n = a.size
        val m = b.size
        val limit = min(maxChanges, n + m)
        val off = limit + 1
        val v = IntArray(2 * limit + 3)
        // trace[d]: the furthest x per diagonal k in -d-1...d+1 before step d
        val trace = ArrayList<IntArray>()
        var done = false
        search@ for (d in 0..limit) {
            trace.add(v.copyOfRange(off - d - 1, off + d + 2))
            var k = -d
            while (k <= d) {
                var x = if (k == -d || (k != d && v[off + k - 1] < v[off + k + 1])) v[off + k + 1] else v[off + k - 1] + 1
                var y = x - k
                while (x < n && y < m && a[x] == b[y]) {
                    x++
                    y++
                }
                v[off + k] = x
                if (x >= n && y >= m) {
                    done = true
                    break@search
                }
                k += 2
            }
        }
        if (!done) return null
        val removed = BooleanArray(n)
        val inserted = BooleanArray(m)
        var x = n
        var y = m
        for (d in trace.size - 1 downTo 1) {
            val t = trace[d]
            val k = x - y
            fun at(k: Int) = t[k + d + 1]
            val down = k == -d || (k != d && at(k - 1) < at(k + 1))
            val pk = if (down) k + 1 else k - 1
            val px = at(pk)
            val py = px - pk
            if (down) inserted[py] = true else removed[px] = true
            x = px
            y = py
        }
        val out = ArrayList<Hunk>()
        var i = 0
        var j = 0
        while (i < n || j < m) {
            if (i < n && j < m && !removed[i] && !inserted[j]) {
                i++
                j++
                continue
            }
            val si = i
            val sj = j
            while (i < n && removed[i]) i++
            while (j < m && inserted[j]) j++
            out.add(Hunk(si, i, sj, j))
        }
        return out
    }

    /**
     * Characters as integers that are equal only for identical UTF-16 (Swift's `==`
     * treats canonically equivalent characters as equal, which would lose bytes).
     */
    private class Interner {
        private val ids = HashMap<String, Int>().apply { put("\r\n", CRLF) }

        fun id(s: String, start: Int, end: Int): Int {
            if (end - start == 1) return s[start].code
            val key = s.substring(start, end)
            return ids.getOrPut(key) { 0x10000 + ids.size }
        }

        companion object {
            const val NEWLINE = 10
            const val CRLF = 0x10000
        }
    }
}
