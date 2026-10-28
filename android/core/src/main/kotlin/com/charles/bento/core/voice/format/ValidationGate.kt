package com.charles.bento.core.voice.format

import java.util.Locale
import java.util.regex.Pattern

/**
 * The cleanup safety net: a cleanup model's output is only inserted when it still
 * looks like the speaker's words. Catches answering instead of cleaning, AI
 * self-reference, runaway expansion and content divergence. Constants tuned against
 * the Mac's live probe fixtures.
 */
object ValidationGate {
    data class Verdict(val accepted: Boolean, val reason: String?) {
        companion object {
            val OK = Verdict(true, null)
            fun fail(reason: String) = Verdict(false, reason)
        }
    }

    internal const val MIN_LENGTH_RATIO = 0.20
    internal const val MAX_LENGTH_RATIO = 1.60
    internal const val MIN_CONTAINMENT = 0.50
    internal const val MIN_TRIGRAM_SIMILARITY = 0.55

    private val fencePattern = Regex("```[a-z]*\n?")

    /** Strips model artifacts that are not failures: code fences, "CLEAN:" labels, wrapping quotes. */
    fun stripArtifacts(text: String): String {
        var s = text.trim()
        if (s.startsWith("```")) {
            s = fencePattern.replace(s, "")
            s = s.replace("```", "")
            s = s.trim()
        }
        for (label in listOf("CLEAN:", "Clean:", "Transcript:", "TRANSCRIPT:")) {
            if (s.startsWith(label)) s = s.substring(label.length).trim()
        }
        if (s.codePointCount(0, s.length) > 1 && s.startsWith("\"") && s.endsWith("\"")) {
            s = s.substring(1, s.length - 1)
        }
        return s
    }

    fun validate(raw: String, cleaned: String): Verdict {
        val rawWords = contentWords(raw)
        val cleanWords = contentWords(cleaned)

        if (cleanWords.isEmpty()) {
            return if (rawWords.isEmpty()) Verdict.OK else Verdict.fail("empty_output")
        }
        // An answering model PREPENDS words that are not in the dictation; a faithful
        // cleanup keeps the speaker's opener. So the pattern only fires when the first
        // word changed — a dictation that starts with "Okay," keeps its own opener.
        if (answerPattern.matcher(cleaned).find() && cleanWords.firstOrNull() != rawWords.firstOrNull()) {
            return Verdict.fail("answer_pattern")
        }
        val lowered = cleaned.lowercase(Locale.ROOT)
        if (lowered.contains("as an ai") || lowered.contains("language model")) {
            return Verdict.fail("ai_selfreference")
        }
        if (rawWords.isEmpty()) return Verdict.OK

        val ratio = cleanWords.size.toDouble() / rawWords.size.toDouble()
        // Expansion is most dangerous on short raws (hallucinated content), so the upper
        // bound kicks in early; shrink is legitimate (fillers, self-corrections), so the
        // lower bound only applies to longer raws.
        if (rawWords.size >= 3 && ratio > MAX_LENGTH_RATIO) {
            return Verdict.fail("expansion_ratio_${fmt(ratio)}")
        }
        if (rawWords.size >= 6 && ratio < MIN_LENGTH_RATIO) {
            return Verdict.fail("shrink_ratio_${fmt(ratio)}")
        }

        val rawSet = rawWords.toHashSet()
        val contained = cleanWords.count { it in rawSet }
        val containment = contained.toDouble() / cleanWords.size.toDouble()
        val trigram = trigramSimilarity(normalize(raw), normalize(cleaned))
        // Reject only when BOTH content signals diverge: cleanup legitimately rewrites
        // number words and punctuation words, hurting each one individually.
        if (containment < MIN_CONTAINMENT && trigram < MIN_TRIGRAM_SIMILARITY) {
            return Verdict.fail("content_divergence_c${fmt(containment)}_t${fmt(trigram)}")
        }
        return Verdict.OK
    }

    private fun fmt(value: Double) = String.format(Locale.ROOT, "%.2f", value)

    private val answerPattern: Pattern = Pattern.compile(
        "^(sure|okay|certainly|of course|great question|here('s| is)|i can('|no)t|as an ai|i'm (sorry|an ai))\\b",
        Pattern.CASE_INSENSITIVE or Pattern.UNICODE_CASE,
    )

    /** Lowercased alphanumeric words, spoken numbers normalized to digits ("three" matches "3"). */
    fun contentWords(text: String): List<String> = splitAlphanumeric(normalize(text))

    internal fun normalize(text: String): String {
        var s = text.lowercase(Locale.ROOT)
        for ((word, regex, digit) in numberWords) {
            if (s.contains(word)) s = regex.replace(s, digit)
        }
        return s
    }

    private val numberWords: List<Triple<String, Regex, String>> = listOf(
        "zero" to "0", "one" to "1", "two" to "2", "three" to "3", "four" to "4",
        "five" to "5", "six" to "6", "seven" to "7", "eight" to "8", "nine" to "9",
        "ten" to "10", "eleven" to "11", "twelve" to "12", "twenty" to "20",
        "thirty" to "30", "forty" to "40", "fifty" to "50", "hundred" to "100",
    ).map { (word, digit) -> Triple(word, Regex("\\b$word\\b"), digit) }

    internal fun trigramSimilarity(a: String, b: String): Double {
        val ta = trigrams(a)
        val tb = trigrams(b)
        if (ta.isEmpty() || tb.isEmpty()) return if (a == b) 1.0 else 0.0
        val intersection = ta.count { it in tb }
        return intersection.toDouble() / minOf(ta.size, tb.size).toDouble()
    }

    private fun trigrams(s: String): Set<String> {
        val chars = s.codePoints().filter { !Character.isWhitespace(it) && !Character.isSpaceChar(it) }
            .toArray().map { String(Character.toChars(it)) }
        if (chars.size < 3) return if (chars.isEmpty()) emptySet() else setOf(chars.joinToString(""))
        val set = HashSet<String>()
        for (i in 0..chars.size - 3) set.add(chars[i] + chars[i + 1] + chars[i + 2])
        return set
    }

    /** Splits on everything outside Unicode letters, marks and numbers (Foundation's `alphanumerics`). */
    internal fun splitAlphanumeric(text: String): List<String> {
        val out = ArrayList<String>()
        val current = StringBuilder()
        var i = 0
        while (i < text.length) {
            val cp = text.codePointAt(i)
            if (isAlphanumeric(cp)) current.appendCodePoint(cp)
            else if (current.isNotEmpty()) { out.add(current.toString()); current.setLength(0) }
            i += Character.charCount(cp)
        }
        if (current.isNotEmpty()) out.add(current.toString())
        return out
    }

    internal fun isAlphanumeric(cp: Int): Boolean = when (Character.getType(cp).toByte()) {
        Character.UPPERCASE_LETTER, Character.LOWERCASE_LETTER, Character.TITLECASE_LETTER,
        Character.MODIFIER_LETTER, Character.OTHER_LETTER,
        Character.NON_SPACING_MARK, Character.ENCLOSING_MARK, Character.COMBINING_SPACING_MARK,
        Character.DECIMAL_DIGIT_NUMBER, Character.LETTER_NUMBER, Character.OTHER_NUMBER -> true
        else -> false
    }
}
