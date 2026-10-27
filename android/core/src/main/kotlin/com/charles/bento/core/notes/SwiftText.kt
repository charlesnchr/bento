package com.charles.bento.core.notes

import com.charles.bento.core.notes.UnicodeTables.GB_CONTROL
import com.charles.bento.core.notes.UnicodeTables.GB_EXTEND
import com.charles.bento.core.notes.UnicodeTables.GB_EXTENDED_PICTOGRAPHIC
import com.charles.bento.core.notes.UnicodeTables.GB_L
import com.charles.bento.core.notes.UnicodeTables.GB_LV
import com.charles.bento.core.notes.UnicodeTables.GB_LVT
import com.charles.bento.core.notes.UnicodeTables.GB_PREPEND
import com.charles.bento.core.notes.UnicodeTables.GB_REGIONAL_INDICATOR
import com.charles.bento.core.notes.UnicodeTables.GB_SPACING_MARK
import com.charles.bento.core.notes.UnicodeTables.GB_T
import com.charles.bento.core.notes.UnicodeTables.GB_V
import com.charles.bento.core.notes.UnicodeTables.GB_ZWJ
import java.text.Normalizer

/**
 * A range of UTF-16 offsets (`NSRange`): `location` and `length`, `end` is
 * `NSMaxRange`.
 */
data class TextRange(val location: Int, val length: Int) {
    val end: Int get() = location + length
    fun contains(i: Int): Boolean = i >= location && i < end
    override fun toString(): String = "{$location, $length}"
}

/**
 * Swift `Character`s: a port of Swift 6.2's grapheme breaking (stdlib
 * StringGraphemeBreaking.swift: UAX #29 with its quick pairs, GB9c with the six Indic
 * viramas as linkers), over the standard library's Unicode data as read off the Mac, so a
 * note splits into the same characters on every Android version.
 */
internal object Graphemes {
    /** UTF-16 offset of every character boundary of `s`, starting with 0 and ending with its length. */
    fun boundaries(s: String): IntArray {
        val n = s.length
        if (n == 0) return intArrayOf(0)
        val out = IntArray(n + 1)
        var count = 0
        out[count++] = 0
        forEachBoundary(s) { out[count++] = it }
        return out.copyOf(count)
    }

    /** Number of characters (`String.count`). */
    fun count(s: String): Int {
        if (s.isEmpty()) return 0
        var c = 0
        forEachBoundary(s) { c++ }
        return c
    }

    /** The characters of `s` as strings. */
    fun characters(s: String): List<String> {
        val b = boundaries(s)
        return List(b.size - 1) { s.substring(b[it], b[it + 1]) }
    }

    /**
     * Calls `f` with the end offset of every character, in order (`_nextGraphemeClusterBoundary`:
     * a fresh state for every character).
     */
    inline fun forEachBoundary(s: String, f: (Int) -> Unit) {
        val n = s.length
        val st = State()
        var scalar = s.codePointAt(0)
        var i = Character.charCount(scalar)
        while (i < n) {
            val scalar2 = s.codePointAt(i)
            if (st.shouldBreak(scalar, scalar2)) {
                f(i)
                st.reset()
            }
            scalar = scalar2
            i += Character.charCount(scalar2)
        }
        f(n)
    }

    /** `Unicode._GraphemeBreakProperty(from:)`. */
    fun property(cp: Int): Int = when {
        cp < 0x20 -> GB_CONTROL
        cp < 0x7F -> 0
        else -> UnicodeTables.value(UnicodeTables.swiftGraphemeBreak, cp)
    }

    private fun isInCBConsonant(cp: Int): Boolean = cp >= 0x900 && UnicodeTables.contains(UnicodeTables.swiftInCBConsonant, cp)

    /** Assuming the scalar is already an Extend or ZWJ. */
    private fun isInCBExtend(cp: Int): Boolean = !(isInCBConsonant(cp) || isInCBLinker(cp) || cp == 0x200C)

    private fun isInCBLinker(cp: Int): Boolean =
        cp == 0x94D || cp == 0x9CD || cp == 0xACD || cp == 0xB4D || cp == 0xC4D || cp == 0xD4D

    /** `_quickHasGraphemeBreakBetween`. */
    private fun quickBreak(lhs: Int, rhs: Int): Boolean? {
        // GB3: CR-LF is a special case: no break between these
        if (lhs == 0x0D && rhs == 0x0A) return false
        if (hasBreakWhenPaired(lhs) && hasBreakWhenPaired(rhs)) return true
        return null
    }

    private fun hasBreakWhenPaired(x: Int): Boolean =
        x in 0x3400..0xA4CF || x in 0x0000..0x02FF || x in 0x3041..0x3096 || x in 0x30A1..0x30FC || x in 0x0400..0x0482 ||
            x in 0x061D..0x064A || x in 0xAC00..0xD7AF || x in 0x2010..0x2029 || x in 0x3000..0x3029 || x in 0xFF01..0xFF9D

    /** `_GraphemeBreakingState`. */
    class State {
        private var hasSeenInCBLinker = false
        private var isInEmojiSequence = false
        private var isInIndicSequence = false
        private var shouldBreakRI = false

        fun reset() {
            hasSeenInCBLinker = false
            isInEmojiSequence = false
            isInIndicSequence = false
            shouldBreakRI = false
        }

        /** `shouldBreak(between:and:)`. */
        fun shouldBreak(scalar1: Int, scalar2: Int): Boolean {
            quickBreak(scalar1, scalar2)?.let { return it }
            val x = property(scalar1)
            // GB4 handled here because we don't need to know `y` for this case
            if (x == GB_CONTROL) return true
            var enterEmojiSequence = false
            var enterIndicSequence = false
            try {
                val y = property(scalar2)
                return when {
                    x == 0 && y == 0 -> true
                    y == GB_CONTROL -> true // GB5
                    x == GB_L && (y == GB_L || y == GB_V || y == GB_LV || y == GB_LVT) -> false // GB6
                    (x == GB_LV || x == GB_V) && (y == GB_V || y == GB_T) -> false // GB7
                    (x == GB_LVT || x == GB_T) && y == GB_T -> false // GB8
                    y == GB_EXTEND || y == GB_ZWJ -> { // GB9 (partial GB9c and partial GB11)
                        if (x == GB_EXTENDED_PICTOGRAPHIC || (isInEmojiSequence && x == GB_EXTEND)) enterEmojiSequence = true
                        val consonant1 = isInCBConsonant(scalar1)
                        val extend2 = isInCBExtend(scalar2)
                        val linker2 = isInCBLinker(scalar2)
                        when {
                            consonant1 && extend2 && !linker2 -> enterIndicSequence = true
                            consonant1 && !extend2 && linker2 -> {
                                enterIndicSequence = true
                                hasSeenInCBLinker = true
                            }
                            !consonant1 && extend2 && !linker2 -> if (isInIndicSequence) enterIndicSequence = true
                            !consonant1 && !extend2 && linker2 -> if (isInIndicSequence) {
                                enterIndicSequence = true
                                hasSeenInCBLinker = true
                            }
                        }
                        false
                    }
                    y == GB_SPACING_MARK -> false // GB9a
                    x == GB_PREPEND -> false // GB9b
                    x == GB_ZWJ && y == GB_EXTENDED_PICTOGRAPHIC -> !isInEmojiSequence // GB11
                    x == GB_REGIONAL_INDICATOR && y == GB_REGIONAL_INDICATOR -> { // GB12 & GB13
                        val r = shouldBreakRI
                        shouldBreakRI = !shouldBreakRI
                        r
                    }
                    else -> { // GB999
                        // GB9c
                        if (isInIndicSequence && hasSeenInCBLinker && isInCBConsonant(scalar2)) {
                            hasSeenInCBLinker = false
                            false
                        } else {
                            true
                        }
                    }
                }
            } finally {
                isInEmojiSequence = enterEmojiSequence
                isInIndicSequence = enterIndicSequence
            }
        }
    }
}

/**
 * `NSString.rangeOfComposedCharacterSequence(at:)`, which is not the same as Swift's
 * characters (it splits CR LF and drops ZWNJ, joins a control character with a
 * following mark or ZWJ, a virama with a following letter...): a port of
 * CoreFoundation's `CFStringGetRangeOfCharacterClusterAtIndex` for
 * `kCFStringComposedCharacterCluster` (swift-corelibs-foundation, CFString.c) as the Mac runs it
 * (ZWJ extends a sequence like a mark; one Prepend character before an emoji), with
 * CoreFoundation's character sets and ICU's properties from the Mac.
 */
internal object ComposedCharacters {
    private const val ZWJ = 0x200D
    private const val CGJ = 0x034F
    private const val NOT_FOUND = -1

    fun range(text: String, index: Int): TextRange {
        require(index >= 0 && index < text.length) { "index $index out of 0..<${text.length}" }
        return Buffer(text).clusterRange(index)
    }

    private fun isHigh(c: Int) = c in 0xD800..0xDBFF
    private fun isLow(c: Int) = c in 0xDC00..0xDFFF
    private fun pair(h: Int, l: Int) = ((h - 0xD800) shl 10) + (l - 0xDC00) + 0x10000
    private fun nonBase(c: Int) = c >= 0x300 && UnicodeTables.contains(UnicodeTables.cfNonBase, c)
    private fun letter(c: Int) = UnicodeTables.contains(UnicodeTables.cfLetters, c)
    private fun isVirama(c: Int) = c == CGJ || (c >= 0x900 && c < 0x10000 && UnicodeTables.contains(UnicodeTables.viramas, c))
    private fun isFitzpatrick(c: Int) = c in 0x1F3FB..0x1F3FF
    private fun isTag(c: Int) = c in 0xE0020..0xE007F
    private fun behavesLikeCombiningMark(c: Int) = c == 0xFF9E || c == 0xFF9F || (c and 0x1FFFF0) == 0xF870
    private fun isExtend(c: Int) =
        UnicodeTables.contains(UnicodeTables.graphemeExtend, c) || UnicodeTables.contains(UnicodeTables.emojiModifier, c)
    private fun isPictograph(c: Int) = c >= 0xA9 && UnicodeTables.contains(UnicodeTables.extendedPictographic, c)
    private fun isPrecore(c: Int) = UnicodeTables.contains(UnicodeTables.icuPrepend, c)
    private fun isPostcore(c: Int) = c == ZWJ || isExtend(c) || UnicodeTables.contains(UnicodeTables.icuSpacingMark, c)
    private fun isHangulLVT(c: Int) = (c - 0xAC00) % 28 != 0

    private const val L = 0
    private const val V = 1
    private const val T = 2
    private const val LV = 3
    private const val LVT = 4
    private const val BREAK = 5
    private val transcodingHintLength = intArrayOf(2, 3, 4, 4, 4, 4, 4, 2, 2, 2, 2, 4, 0, 0, 0, 0)

    /** A mutable CFRange. */
    private class R(var location: Int, var length: Int)

    private class Component(var location: Int, var length: Int, var firstExtendIndex: Int, var zwjIndex: Int, var pictographIndex: Int)

    private class Buffer(val s: String) {
        val length = s.length

        /** CFStringGetCharacterFromInlineBuffer: 0 outside the string. */
        fun get(i: Int): Int = if (i < 0 || i >= length) 0 else s[i].code

        fun clusterRange(charIndex: Int): TextRange {
            val range = composedRange(charIndex)
            // Do grapheme joiners
            var character = get(range.location)
            if (range.length > 1 && isHigh(character) && isLow(get(range.location + 1))) {
                character = pair(character, get(range.location + 1))
            }
            if (character == ZWJ || letter(character)) {
                // Check if preceded by grapheme joiners (U+034F and viramas)
                val otherLocation = range.location
                var currentIndex = range.location
                while (currentIndex > 1) {
                    character = get(--currentIndex)
                    // (viramas assumed in the BMP)
                    if ((isVirama(character) || (character == ZWJ && isVirama(get(--currentIndex)))) && currentIndex > 0) {
                        --currentIndex
                    } else {
                        break
                    }
                    currentIndex = composedRange(currentIndex).location
                    character = get(currentIndex)
                    val member = if (isLow(character) && isHigh(get(currentIndex - 1))) {
                        // CoreFoundation pairs these the wrong way round: never a letter
                        --currentIndex
                        false
                    } else {
                        letter(character)
                    }
                    if (!member) break
                    range.location = currentIndex
                }
                range.length += otherLocation - range.location

                // Check if followed by grapheme joiners
                if (range.length > 1 && range.location + range.length < length) {
                    var otherEnd = range.location + range.length
                    currentIndex = range.location + range.length
                    do {
                        character = get(currentIndex - 1)
                        if (character != ZWJ && !isVirama(character)) break
                        character = get(currentIndex)
                        if (character == ZWJ) character = get(++currentIndex)
                        if (isHigh(character) && isLow(get(currentIndex + 1))) character = pair(character, get(currentIndex + 1))
                        // We only conjoin letters
                        if (!letter(character)) break
                        val other = composedRange(currentIndex)
                        currentIndex = other.location + other.length
                        otherEnd = currentIndex
                    } while (otherEnd < length)
                    range.length = currentIndex - range.location
                }
            }

            // Check if we're part of prefix transcoding hints
            var currentIndex = maxOf(0, range.location + range.length - 5)
            while (currentIndex <= range.location) {
                character = get(currentIndex)
                if ((character and 0x1FFFF0) == 0xF860) {
                    var otherIndex = currentIndex + transcodingHintLength[character - 0xF860] + 1
                    if (otherIndex >= range.location + range.length) {
                        if (otherIndex <= length) {
                            var checkIndex = currentIndex + 1
                            while (checkIndex < otherIndex) {
                                val check = composedRange(checkIndex)
                                checkIndex = check.location + check.length
                                // Don't include any part of a composed range that extends beyond the hint range
                                if (checkIndex > otherIndex) {
                                    otherIndex = check.location
                                    break
                                }
                            }
                            range.location = currentIndex
                            range.length = otherIndex - currentIndex
                        }
                        break
                    }
                }
                ++currentIndex
            }

            // Regional flag
            if (range.length == 2 && isRegionalIndicatorAt(range.location)) {
                currentIndex = range.location
                while (currentIndex > 1 && isRegionalIndicatorAt(currentIndex - 2)) currentIndex -= 2
                if (range.location > currentIndex && (range.location - currentIndex) % 4 != 0) { // currentIndex is the 2nd RI
                    range.location -= 2
                    range.length += 2
                }
                if (range.length == 2 && range.location + range.length + 2 <= length && isRegionalIndicatorAt(range.location + range.length)) {
                    range.length += 2
                }
            }

            // Expand to pictographic sequences (emoji and otherwise), never shrinking the range
            val cluster = extendedPictographicSequence(range.location)
            if (cluster != null && range.location >= cluster.location && range.location + range.length <= cluster.location + cluster.length) {
                range.location = cluster.location
                range.length = cluster.length
            }

            // Gather the final grapheme extends: backwards...
            if (range.location > 0 && range.length == 1 && get(range.location) == ZWJ) {
                val final = composedRange(range.location - 1)
                if (range.location == final.location + final.length) {
                    range.location = final.location
                    range.length = final.length + 1
                }
            }
            // ...and forwards
            if (range.location + range.length < length && get(range.location + range.length) == ZWJ) range.length++
            return TextRange(range.location, range.length)
        }

        private fun isRegionalIndicatorAt(i: Int) = get(i) == 0xD83C && get(i + 1) in 0xDDE6..0xDDFF

        /** _CFStringInlineBufferGetComposedRange (composed character clusters). */
        fun composedRange(start0: Int): R {
            var start = start0
            var end = start + 1
            var character = get(start)
            if (isHigh(character) && isLow(get(start + 1))) {
                ++end
                character = pair(character, get(start + 1))
            }
            // Extend backward
            while (start > 0) {
                if (character < 0x10000 && isLow(character) && isHigh(get(start - 1))) {
                    character = pair(get(start - 1), character)
                    if (--start == 0) break // starting with non-BMP combining mark
                }
                val fitzpatrick = start > 0 && isFitzpatrick(character)
                if (!fitzpatrick && !nonBase(character) && !isTag(character) && !behavesLikeCombiningMark(character) && character != ZWJ) break
                --start
                character = get(start)
            }

            // Hangul
            if (character in 0x1100..0x11F9 || character in 0xAC00..0xD7AF) {
                var state = when {
                    character < 0x1160 -> L
                    character < 0x11A8 -> V
                    character < 0xAC00 -> T
                    isHangulLVT(character) -> LVT
                    else -> LV
                }
                val initialState = state
                // Extend backward
                while (true) {
                    val c = get(start - 1)
                    if (!(c >= 0x1100 && c <= 0xD7AF && (c <= 0x11F9 || c >= 0xAC00))) break
                    state = when (state) {
                        V -> when {
                            c <= 0x115F -> L
                            c in 0xAC00..0xD7AF && !isHangulLVT(c) -> LV
                            c > 0x11A2 -> BREAK
                            else -> state
                        }
                        T -> when {
                            c in 0x1160..0x11A2 -> V
                            c in 0xAC00..0xD7AF -> if (isHangulLVT(c)) LVT else LV
                            c < 0x1160 -> BREAK
                            else -> state
                        }
                        else -> if (c < 0x1160) L else BREAK
                    }
                    if (state == BREAK) break
                    --start
                }
                // Extend forward
                state = initialState
                while (true) {
                    val c = get(end)
                    if (!(c > 0 && (c in 0x1100..0x11F9 || c in 0xAC00..0xD7AF))) break
                    state = when (state) {
                        LV, V -> if (c in 0x1160..0x11F9) (if (c < 0x11A8) V else T) else BREAK
                        LVT, T -> if (c in 0x11A8..0x11F9) T else BREAK
                        else -> when {
                            c < 0x1160 -> L
                            c < 0x11A8 -> V
                            c >= 0xAC00 -> if (isHangulLVT(c)) LVT else LV
                            else -> BREAK
                        }
                    }
                    if (state == BREAK) break
                    ++end
                }
            }

            // Extend forward
            while (true) {
                var c = get(end)
                if (c <= 0) break
                var step = 1
                if (isHigh(c) && isLow(get(end + 1))) {
                    c = pair(c, get(end + 1))
                    step = 2
                }
                if (!isFitzpatrick(c) && !nonBase(c) && !isTag(c) && !behavesLikeCombiningMark(c) && c != ZWJ) break
                end += step
            }
            return R(start, end - start)
        }

        /** __CFStringGetLongCharacterFromInlineBuffer: the code point at `idx` and the range it covers. */
        private fun long(idx: Int, read: R): Int {
            if (idx < 0 || idx >= length) {
                read.location = NOT_FOUND
                read.length = 0
                return 0
            }
            read.location = idx
            read.length = 1
            var character = get(idx)
            if (isHigh(character) && idx < length - 1) {
                val low = get(idx + 1)
                if (isLow(low)) {
                    read.length++
                    character = pair(character, low)
                }
            } else if (isLow(character) && idx > 0) {
                val high = get(idx - 1)
                if (isHigh(high)) {
                    read.location--
                    read.length++
                    character = pair(high, character)
                }
            }
            return character
        }

        /**
         * __CFStringGetExtendedPictographicSequenceComponent: the lone starting
         * \p{Extended_Pictographic} at `index`, or the (Extend* ZWJ \p{Extended_Pictographic})
         * containing it.
         */
        private fun component(index: Int): Component? {
            if (index < 0 || index >= length) return null
            val match = Component(NOT_FOUND, 0, -1, -1, -1)
            val current = R(index, 0)
            while (current.location >= 0) {
                val character = long(current.location, current)
                if (isExtend(character)) {
                    match.firstExtendIndex = current.location
                } else if (character == ZWJ) {
                    if (match.firstExtendIndex != -1 || match.zwjIndex != -1) break
                    match.zwjIndex = current.location
                } else if (isPictograph(character)) {
                    if (match.pictographIndex != -1 || match.zwjIndex != -1 || match.firstExtendIndex != -1) break
                    match.pictographIndex = current.location
                } else {
                    break
                }
                match.location = current.location
                match.length += current.length
                current.location--
            }
            if (match.pictographIndex == -1) {
                if (match.zwjIndex == -1 && match.firstExtendIndex == -1) return null
            } else {
                if (match.firstExtendIndex != -1 && match.zwjIndex == -1) {
                    // the variation selector (or similar) of a preceding cluster: start at the pictograph
                    match.location = match.pictographIndex
                    match.length -= match.pictographIndex - match.firstExtendIndex
                }
                return match
            }
            current.location = match.location + match.length
            current.length = 0
            while (match.pictographIndex == -1 && current.location < length) {
                val character = long(current.location, current)
                if (isExtend(character)) {
                    if (match.zwjIndex != -1) break
                } else if (character == ZWJ) {
                    if (match.zwjIndex != -1) break
                    match.zwjIndex = current.location
                } else if (isPictograph(character)) {
                    match.pictographIndex = current.location
                } else {
                    break
                }
                match.length += current.length
                current.location += current.length
                current.length = 0
            }
            return if (match.pictographIndex == -1) null else match
        }

        /** __CFStringGetExtendedPictographicSequence: precore* core postcore* around `index`. */
        private fun extendedPictographicSequence(index: Int): TextRange? {
            if (index < 0 || index >= length) return null
            val current = R(0, 0)
            var character = long(index, current)
            val postcore = R(current.length, 0)
            while (isPostcore(character)) {
                postcore.location = current.location
                postcore.length += current.length
                if (postcore.location == 0) return null
                character = long(postcore.location - 1, current)
            }
            var last = Component(NOT_FOUND, 0, -1, -1, -1)
            val core = R(current.location, 0)
            while (true) {
                val c = component(current.location) ?: break
                last = c
                core.location = c.location
                core.length += c.length
                current.location = c.location - 1
                current.length = 0
                if (c.zwjIndex == -1) break // the start of the sequence
            }
            var lookForPrecore = true
            if (last.firstExtendIndex != -1 || last.zwjIndex != -1) {
                // characters before the pictograph that don't form a component: start at the pictograph
                core.location = last.pictographIndex
                core.length -= last.pictographIndex - last.location
                current.location = last.pictographIndex + 1
                lookForPrecore = false
            }
            if (postcore.length > 0 && core.length == 0) return null
            val precore = R(current.location, 0)
            // The Mac takes one Prepend character, the one right before the sequence (or at
            // `index`), where swift-corelibs-foundation takes a run of them both ways.
            if (lookForPrecore && current.location >= 0) {
                character = long(current.location, current)
                if (isPrecore(character)) {
                    precore.location = current.location
                    precore.length = current.length
                }
            }
            if (precore.length == 0 && core.length == 0) return null
            if (core.length == 0) {
                core.location = precore.location + precore.length
                core.length = 0
                current.location = core.location
                current.length = 0
            } else {
                current.location = core.location + core.length
                current.length = 0
            }
            while (true) {
                val c = component(current.location) ?: break
                if (core.length > 0 && c.zwjIndex == -1) break // the next sequence
                core.length += c.length
                current.location += c.length
            }
            if (postcore.length > 0) {
                val onePastCore = core.location + core.length
                if (onePastCore >= postcore.location + postcore.length) {
                    postcore.location = onePastCore
                    postcore.length = 0
                }
                current.location = postcore.location + postcore.length
                current.length = 0
            } else {
                postcore.location = current.location
                postcore.length = current.length
            }
            if (current.location < length) {
                character = long(current.location, current)
                while (isPostcore(character)) {
                    postcore.length += current.length
                    current.location += current.length
                    character = long(current.location, current)
                }
            }
            if (core.length <= 0) return null
            var location = core.location
            var len = core.length
            if (precore.length > 0) {
                location = precore.location
                len += precore.length
            }
            if (postcore.length > 0) len += postcore.length
            return TextRange(location, len)
        }
    }
}

/** Foundation and Swift string behaviour the Notes code depends on. */
internal object SwiftText {
    private const val LF = '\n'
    private const val CR = '\r'
    /** Lowercase of U+0130 (İ): "i" + combining dot above. */
    private val LOWER_DOTTED_I = String(intArrayOf(0x69, 0x307), 0, 2)

    /** `CharacterSet.whitespaces` (tab, space separators and U+200B, as CoreFoundation has it). */
    fun isWhitespace(c: Int): Boolean =
        c == 0x20 || c == 0x09 || (c >= 0xA0 && UnicodeTables.contains(UnicodeTables.cfWhitespaces, c))

    /** `CharacterSet.whitespacesAndNewlines`. */
    fun isWhitespaceOrNewline(c: Int): Boolean =
        c == 0x20 || c in 0x09..0x0D || (c >= 0x85 && UnicodeTables.contains(UnicodeTables.cfWhitespacesAndNewlines, c))

    /** `CharacterSet.alphanumerics`. */
    fun isAlphanumeric(c: Int): Boolean = when {
        c < 0x80 -> c in 0x30..0x39 || c in 0x41..0x5A || c in 0x61..0x7A
        else -> UnicodeTables.contains(UnicodeTables.cfAlphanumerics, c)
    }

    /** `Unicode.Scalar.Properties.isWhitespace` (White_Space); ICU regex `\s` is the same set. */
    fun isWhiteSpaceProperty(c: Int): Boolean = c == 0x20 || c in 0x09..0x0D || (c >= 0x85 && UnicodeTables.contains(UnicodeTables.whiteSpace, c))

    /** `trimmingCharacters(in:)` with a scalar predicate. */
    inline fun trim(s: String, set: (Int) -> Boolean): String {
        var a = 0
        var b = s.length
        while (a < b) {
            val c = s.codePointAt(a)
            if (!set(c)) break
            a += Character.charCount(c)
        }
        while (b > a) {
            val c = s.codePointBefore(b)
            if (!set(c)) break
            b -= Character.charCount(c)
        }
        return s.substring(a, b)
    }

    fun trimWhitespaces(s: String): String = trim(s, ::isWhitespace)
    fun trimWhitespacesAndNewlines(s: String): String = trim(s, ::isWhitespaceOrNewline)

    /** `String.lowercased()`: each scalar's full lowercase mapping, no context (Σ is always σ). */
    fun lowercased(s: String): String {
        var ascii = true
        for (ch in s) if (ch.code >= 0x80) { ascii = false; break }
        if (ascii) return s.lowercase()
        val sb = StringBuilder(s.length)
        var i = 0
        while (i < s.length) {
            val c = s.codePointAt(i)
            if (c == 0x130) sb.append(LOWER_DOTTED_I) else sb.appendCodePoint(Character.toLowerCase(c))
            i += Character.charCount(c)
        }
        return sb.toString()
    }

    /**
     * Whether `cp` continues the cluster before it for Foundation's searches (not literal:
     * `replacingOccurrences(of:with:)`, `range(of:)`, NSString `hasPrefix`), which go by
     * CoreFoundation's grapheme clusters: Grapheme_Extend, emoji modifiers, tags and the
     * marks CoreFoundation treats alike (not ZWJ).
     */
    fun foundationExtends(cp: Int): Boolean =
        cp >= 0x300 && (UnicodeTables.contains(UnicodeTables.graphemeExtend, cp) || cp in 0x1F3FB..0x1F3FF ||
            cp in 0xE0020..0xE007F || cp == 0xFF9E || cp == 0xFF9F || (cp and 0x1FFFF0) == 0xF870)

    /** A match of a needle ending at `end` ends a cluster for Foundation's searches. */
    fun foundationMatchEnds(s: String, end: Int): Boolean = end >= s.length || !foundationExtends(s.codePointAt(end))

    /** Foundation's `replacingOccurrences(of:with:)` (no options) for a needle that starts with a base character. */
    fun replacingOccurrences(s: String, target: String, replacement: String): String {
        var i = s.indexOf(target)
        if (i < 0) return s
        val sb = StringBuilder()
        var from = 0
        while (i >= 0) {
            if (foundationMatchEnds(s, i + target.length)) {
                sb.append(s, from, i).append(replacement)
                from = i + target.length
                i = s.indexOf(target, from)
            } else {
                i = s.indexOf(target, i + 1)
            }
        }
        return sb.append(s, from, s.length).toString()
    }

    /** Swift's `==` on strings: canonical equivalence. */
    fun canonicallyEqual(a: String, b: String): Boolean =
        a == b || Normalizer.normalize(a, Normalizer.Form.NFC) == Normalizer.normalize(b, Normalizer.Form.NFC)

    private fun isLineTerminator(c: Char) = c == LF || c == CR || c.code == 0x85 || c.code == 0x2028 || c.code == 0x2029

    /**
     * `NSString.lineRange(for: NSRange(location: loc, length: 0))`: the line containing
     * `loc` with its terminator (LF, CR, CR LF, NEL, LS or PS).
     */
    fun lineRange(text: String, loc: Int): TextRange {
        var start = minOf(loc, text.length)
        // the LF of a CR LF belongs to the line the CR ends
        if (start < text.length && start > 0 && text[start] == '\n' && text[start - 1] == '\r') start--
        while (start > 0 && !isLineTerminator(text[start - 1])) start--
        var end = maxOf(loc, start)
        while (end < text.length && !isLineTerminator(text[end])) end++
        if (end < text.length) {
            end += if (text[end] == '\r' && end + 1 < text.length && text[end + 1] == '\n') 2 else 1
        }
        return TextRange(start, end - start)
    }

    /**
     * `String.enumerateLines`: each line without its terminator; nothing after a final
     * terminator.
     */
    inline fun enumerateLines(text: String, f: (line: String, full: TextRange) -> Unit) {
        var loc = 0
        while (loc < text.length) {
            val full = lineRange(text, loc)
            var contentEnd = full.end
            if (contentEnd > full.location) {
                val last = text[contentEnd - 1]
                if (last == '\n' && contentEnd - 1 > full.location && text[contentEnd - 2] == '\r') contentEnd -= 2
                else if (isLineTerminatorChar(last)) contentEnd -= 1
            }
            f(text.substring(full.location, contentEnd), full)
            loc = full.end
        }
    }

    fun isLineTerminatorChar(c: Char) = isLineTerminator(c)
}
