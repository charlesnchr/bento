package com.charles.bento.core.fielddoc

import com.charles.bento.core.json.compareCodePoints
import java.text.BreakIterator
import java.text.Collator
import java.text.Normalizer
import java.util.Locale

/**
 * String semantics of the Swift code this module ports, where they differ from Kotlin's:
 * Swift compares strings by canonical equivalence (NFC), iterates Characters (extended
 * grapheme clusters, so a space followed by a combining mark is one whitespace
 * Character), and Foundation's `CharacterSet`s and case-insensitive compares follow
 * Unicode properties rather than Java's `Character.isWhitespace`.
 */
object SwiftText {
    /** Unicode White_Space, which Swift's `Character.isWhitespace` tests on a Character's first scalar. */
    fun isWhiteSpace(cp: Int): Boolean = when (cp) {
        in 0x09..0x0D, 0x20, 0x85, 0xA0, 0x1680, in 0x2000..0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000 -> true
        else -> false
    }

    /** Foundation's `CharacterSet.whitespaces`: space separators (Zs) and tab. */
    fun isWhitespacesMember(cp: Int): Boolean = cp == 0x09 || Character.getType(cp) == Character.SPACE_SEPARATOR.toInt()

    /** Foundation's `CharacterSet.whitespacesAndNewlines`. */
    fun isWhitespacesAndNewlinesMember(cp: Int): Boolean =
        isWhitespacesMember(cp) || cp in 0x0A..0x0D || cp == 0x85 || cp == 0x2028 || cp == 0x2029

    fun nfc(s: String): String =
        if (s.all { it.code < 0x300 } || Normalizer.isNormalized(s, Normalizer.Form.NFC)) s
        else Normalizer.normalize(s, Normalizer.Form.NFC)

    /** Swift's `a < b` / `==` on String: Unicode scalars of the NFC forms (cross-checked on macOS). */
    fun compare(a: String, b: String): Int = compareCodePoints(nfc(a), nfc(b))

    fun equal(a: String, b: String): Boolean = a == b || nfc(a) == nfc(b)

    /** Per-Character case folding, for Foundation's case-insensitive comparisons ("Straße" = "STRASSE"). */
    fun fold(s: String): String = nfc(s).uppercase(Locale.ROOT).lowercase(Locale.ROOT)

    /** `a.caseInsensitiveCompare(b) == .orderedSame`. */
    fun caseInsensitiveEquals(a: String, b: String): Boolean = a.equals(b, ignoreCase = true) || fold(a) == fold(b)

    /** Swift's `lowercased()` (locale independent). */
    fun lowercased(s: String): String = s.lowercase(Locale.ROOT)

    /** `localizedCaseInsensitiveCompare` for display sorting. */
    fun localizedCaseInsensitiveComparator(locale: Locale = Locale.getDefault()): Comparator<String> {
        val c = Collator.getInstance(locale).apply { strength = Collator.SECONDARY }
        return Comparator { a, b -> c.compare(a, b) }
    }

    /** `localizedCaseInsensitiveContains`. */
    fun localizedCaseInsensitiveContains(haystack: String, needle: String): Boolean =
        needle.isEmpty() || fold(haystack).contains(fold(needle))

    /** Boundaries of the Characters (extended grapheme clusters) of `s`, as UTF-16 offsets from 0 to `s.length`. */
    fun characterBoundaries(s: String): IntArray {
        if (s.isEmpty()) return intArrayOf(0)
        val it = BreakIterator.getCharacterInstance(Locale.ROOT)
        it.setText(s)
        val out = ArrayList<Int>(s.length + 1)
        var b = it.first()
        while (b != BreakIterator.DONE) {
            out += b
            b = it.next()
        }
        return out.toIntArray()
    }

    /** Swift's `String.count`. */
    fun characterCount(s: String): Int = if (s.all { it.code < 0x300 && it != '\r' }) s.length else characterBoundaries(s).size - 1

    fun trimmingWhitespaces(s: String): String = trim(s, ::isWhitespacesMember)

    fun trimmingWhitespacesAndNewlines(s: String): String = trim(s, ::isWhitespacesAndNewlinesMember)

    private inline fun trim(s: String, member: (Int) -> Boolean): String {
        var lo = 0
        var hi = s.length
        while (lo < hi) {
            val cp = s.codePointAt(lo)
            if (!member(cp)) break
            lo += Character.charCount(cp)
        }
        while (hi > lo) {
            val cp = s.codePointBefore(hi)
            if (!member(cp)) break
            hi -= Character.charCount(cp)
        }
        return s.substring(lo, hi)
    }

    /** Swift's `Int(s)`: optional sign and ASCII digits only; null on overflow. */
    fun parseInt(s: String): Int? {
        if (s.isEmpty()) return null
        val start = if (s[0] == '+' || s[0] == '-') 1 else 0
        if (start == s.length) return null
        for (i in start until s.length) if (s[i] !in '0'..'9') return null
        return s.toIntOrNull()
    }
}

/** The Characters of a string, indexed: what Swift's `String.Index` arithmetic walks over. */
class SwiftChars(val text: String) {
    private val bounds: IntArray = SwiftText.characterBoundaries(text)

    /** Number of Characters. */
    val count: Int get() = bounds.size - 1

    /** UTF-16 offset where Character `k` starts (`k == count`: the end). */
    fun offset(k: Int): Int = bounds[k]

    /** Character `k` as written. */
    operator fun get(k: Int): String = text.substring(bounds[k], bounds[k + 1])

    /** Character `k` in NFC, for comparing with literals as Swift does. */
    fun nfc(k: Int): String = SwiftText.nfc(get(k))

    fun isWhitespace(k: Int): Boolean = SwiftText.isWhiteSpace(text.codePointAt(bounds[k]))

    fun substring(from: Int, to: Int): String = text.substring(bounds[from], bounds[to])

    /** First whitespace Character at or after `from`, or `count`. */
    fun firstWhitespace(from: Int): Int {
        var k = from
        while (k < count && !isWhitespace(k)) k++
        return k
    }
}
