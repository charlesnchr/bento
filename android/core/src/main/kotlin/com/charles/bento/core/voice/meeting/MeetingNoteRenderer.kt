package com.charles.bento.core.voice.meeting

import java.time.ZoneId
import java.util.Locale

/**
 * A finished meeting as a Bento note body (Markdown), for the Notes module:
 *
 *     # Title
 *
 *     _October 27, 2026 at 8:45 PM · 32 min_
 *
 *     ## Summary / ## Decisions / ## Action items (as `- [ ]` tasks)
 *
 *     <details><summary>Transcript</summary>
 *
 *     **[0:00]** First paragraph…
 *
 *     </details>
 *
 * The sections match the Mac's `notes.md`; the transcript sits in the Notes module's
 * GitHub-style `<details>` expander (collapsed to its summary line in Bento, rendered
 * the same by GitHub). Transcript lines that would end the expander early are escaped
 * and an unclosed code fence is closed, as Bento's thought capture does.
 */
object MeetingNoteRenderer {
    const val TRANSCRIPT_SUMMARY = "Transcript"

    fun render(document: MeetingDocument, locale: Locale = Locale.getDefault(), zone: ZoneId = ZoneId.systemDefault()): String {
        val lines = ArrayList<String>()
        lines += "# " + oneLine(document.displayTitle(locale, zone))
        lines += ""
        lines += "_${document.subtitle(locale, zone)}_"
        lines += ""
        document.meta.summary?.let { summary ->
            val cleaned = summary.copy(
                overview = summary.overview.map(::oneLine),
                decisions = summary.decisions.map(::oneLine),
                actionItems = summary.actionItems.map { it.copy(task = oneLine(it.task), owner = it.owner?.let(::oneLine), due = it.due?.let(::oneLine)) },
            )
            lines += MeetingDocument.summarySections(cleaned)
        }
        val paragraphs = document.paragraphs
        val body = if (paragraphs.isEmpty()) "_Nothing was transcribed._"
        else paragraphs.joinToString("\n\n") { MeetingDocument.transcriptLine(it) }
        lines += "<details><summary>$TRANSCRIPT_SUMMARY</summary>"
        lines += ""
        lines += escapeBody(body)
        lines += ""
        lines += "</details>"
        return lines.joinToString("\n") + "\n"
    }

    private fun oneLine(text: String) = text.replace("\r\n", " ").replace('\n', ' ').replace('\r', ' ').trim()

    /** Escapes lines the Notes parser would read as an expander's start or end; closes an open fence. */
    internal fun escapeBody(body: String): String {
        val out = ArrayList<String>()
        var fence: String? = null
        for (line in body.replace("\r\n", "\n").replace('\r', '\n').split('\n')) {
            val trimmed = line.trim()
            val indent = line.length - line.trimStart().length
            val fenceMarker = fenceMarker(trimmed, indent)
            if (fenceMarker != null) {
                fence = if (fence == null) fenceMarker else if (trimmed.startsWith(fence)) null else fence
                out += line
                continue
            }
            if (fence == null && indent <= 3 && isExpanderSyntax(trimmed)) out += "\\" + trimmed else out += line
        }
        if (fence != null) out += fence
        return out.joinToString("\n")
    }

    private fun fenceMarker(trimmed: String, indent: Int): String? {
        if (indent > 3) return null
        val c = trimmed.firstOrNull() ?: return null
        if (c != '`' && c != '~') return null
        val run = trimmed.takeWhile { it == c }
        return if (run.length >= 3) run else null
    }

    /** `<details…>`, `</details>`, `::: details …` and `:::` (both syntaxes the Notes parser accepts). */
    internal fun isExpanderSyntax(trimmed: String): Boolean {
        val lower = trimmed.lowercase(Locale.ROOT)
        if (lower.startsWith("</details>")) return lower.removePrefix("</details>").isBlank()
        if (lower.startsWith("<details")) {
            val next = lower.getOrNull("<details".length)
            return next == '>' || next == ' ' || next == '\t'
        }
        if (trimmed.startsWith(":::")) {
            val rest = trimmed.removePrefix(":::").trim()
            return rest.isEmpty() || rest.lowercase(Locale.ROOT).startsWith("details")
        }
        return false
    }
}
