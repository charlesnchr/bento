package com.charles.bento.core.voice.format

import java.util.regex.Pattern

/**
 * The Dictionary's hard guarantee: explicit wrong→right rules applied to every
 * transcript on every path (batch, live, cleanup accepted or rejected, meetings).
 */
object ReplacementEngine {
    data class Rule(val wrong: String, val right: String)

    /**
     * ICU's `\w` (what the Mac's NSRegularExpression uses), spelled out so the JVM and
     * Android agree without UNICODE_CHARACTER_CLASS, which Android does not support.
     */
    internal const val WORD_CHAR = "[\\p{L}\\p{M}\\p{N}\\p{Pc}]"

    fun apply(rules: List<Rule>, text: String): String {
        if (rules.isEmpty()) return text
        var result = text
        // Longest wrong-form first so "gemini api" wins over "gemini".
        for (rule in rules.sortedByDescending { it.wrong.codePointCount(0, it.wrong.length) }) {
            if (rule.wrong.isEmpty()) continue
            // Lookarounds instead of \b: word boundaries never match when the wrong
            // form starts or ends with punctuation ("e.g.", "c++").
            val pattern = try {
                Pattern.compile("(?<!$WORD_CHAR)${Pattern.quote(rule.wrong)}(?!$WORD_CHAR)",
                    Pattern.CASE_INSENSITIVE or Pattern.UNICODE_CASE)
            } catch (_: Exception) {
                continue
            }
            val matcher = pattern.matcher(result)
            val out = StringBuilder()
            var last = 0
            while (matcher.find()) {
                out.append(result, last, matcher.start())
                out.append(propagateCase(matcher.group(), rule.right, rule.wrong))
                last = matcher.end()
            }
            if (last == 0 && out.isEmpty()) continue
            out.append(result, last, result.length)
            result = out.toString()
        }
        return result
    }

    /**
     * "KUBERNETES"→"GRPC" stays caps; "Kubernetes" follows the rule's casing unless the
     * match was ALL-CAPS or the rule carries EXPLICIT casing: its right side has an
     * uppercase letter (gRPC, iPhone), or its wrong side does ("NPM"→"npm" is a
     * deliberate lowercase rule).
     */
    internal fun propagateCase(original: String, replacement: String, wrong: String = ""): String {
        val hasExplicitCasing = replacement.drop(1).any { it.isUpperCase() } ||
            replacement.firstOrNull()?.isUpperCase() == true ||
            wrong.any { it.isUpperCase() } ||
            (wrong.isNotEmpty() && wrong.lowercase() == replacement.lowercase())
        if (hasExplicitCasing) return replacement
        if (original == original.uppercase() && original.codePointCount(0, original.length) > 1) {
            return replacement.uppercase()
        }
        if (original.firstOrNull()?.isUpperCase() == true) {
            return replacement.take(1).uppercase() + replacement.drop(1)
        }
        return replacement
    }
}
