package com.charles.bento.core.notes

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Dictated thoughts appended to the capture note, one expander each:
 *
 *     <details><summary>2026-10-26 14:05 · Add a capture mode to the…</summary>
 *     Add a capture mode to the transcribe shortcut that appends to a note.
 *     </details>
 *
 * The summary is the local date and time (no seconds) and the first few words; the body
 * is the full text. Entries are separated by a blank line. Plain markdown text, so sync
 * and other clients see an ordinary note body (GitHub and most renderers show the same
 * expander). A port of the Mac's ThoughtCapture.swift; the Mac's controller appends to
 * the note set in its settings, or to a new note with the body "# Thoughts".
 */
object ThoughtCapture {
    /** Words of the text shown in the summary. */
    const val SUMMARY_WORDS = 6

    fun entry(text: String, at: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String? {
        val body = cleaned(text)
        if (body.isEmpty()) return null
        val summary = SwiftText.replacingOccurrences(summary(body), "<", "‹")
        return "<details><summary>${timestamp(at, zone)} · $summary</summary>\n$body\n</details>"
    }

    /** `body` with `entry` appended after a blank line. */
    fun append(entry: String, body: String): String {
        var head = body
        unclosedFence(head)?.let { fence -> head += (if (swiftHasSuffix(head, "\n")) "" else "\n") + fence + "\n" }
        val separator = when {
            head.isEmpty() || swiftHasSuffix(head, "\n\n") -> ""
            swiftHasSuffix(head, "\n") -> "\n"
            else -> "\n\n"
        }
        return head + separator + entry + "\n"
    }

    private val stampFormat = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm", Locale.US)

    /** "2026-10-26 14:05". */
    fun timestamp(at: Instant, zone: ZoneId = ZoneId.systemDefault()): String = stampFormat.withZone(zone).format(at)

    /** The first `SUMMARY_WORDS` words on one line, "…" when there are more. */
    fun summary(text: String): String {
        // split at characters that are whitespace (Swift's Character.isWhitespace: the first scalar)
        val words = ArrayList<String>()
        val b = Graphemes.boundaries(text)
        var start = -1
        for (k in 0 until b.size - 1) {
            val space = SwiftText.isWhiteSpaceProperty(text.codePointAt(b[k]))
            if (space) {
                if (start >= 0) words.add(text.substring(start, b[k]))
                start = -1
            } else if (start < 0) {
                start = b[k]
            }
        }
        if (start >= 0) words.add(text.substring(start))
        val head = words.take(SUMMARY_WORDS).joinToString(" ")
        return if (words.size > SUMMARY_WORDS) "$head…" else head
    }

    /**
     * Trimmed, "\n" line ends, no blank-line runs, and no line that would end the expander
     * early (expander syntax is escaped, an open code fence closed).
     */
    fun cleaned(text: String): String {
        val normalised = SwiftText.trimWhitespacesAndNewlines(
            SwiftText.replacingOccurrences(
                SwiftText.replacingOccurrences(SwiftText.replacingOccurrences(text, "\r\n", "\n"), "\r", "\n"),
                "\u0000",
                "",
            ),
        )
        val lines = ArrayList<String>()
        for (line in normalised.split("\n")) {
            val blank = SwiftText.trimWhitespaces(line).isEmpty()
            if (blank && lines.lastOrNull()?.isEmpty() != false) continue
            when (MarkdownParser.parseLine(line, inCode = false).kind) {
                BlockKind.Details, BlockKind.DetailsEnd -> lines.add("\\" + SwiftText.trimWhitespaces(line))
                else -> lines.add(if (blank) "" else line)
            }
        }
        var body = SwiftText.trimWhitespacesAndNewlines(lines.joinToString("\n"))
        // an unclosed code fence would swallow the closing "</details>"
        unclosedFence(body)?.let { body += "\n" + it }
        return body
    }

    private fun unclosedFence(body: String): String? {
        var fence: String? = null
        for ((range, line) in MarkdownParser.parseLines(body)) {
            val k = line.kind
            if (k is BlockKind.Fence) {
                val raw = SwiftText.trimWhitespaces(body.substring(range.location, range.end))
                val chars = Graphemes.characters(raw)
                val marker = chars.firstOrNull() ?: "`"
                fence = if (k.opening) chars.takeWhile { it == marker }.joinToString("") else null
            }
        }
        return fence
    }
}
