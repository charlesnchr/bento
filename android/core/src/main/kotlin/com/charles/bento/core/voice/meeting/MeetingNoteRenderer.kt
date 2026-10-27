package com.charles.bento.core.voice.meeting

import com.charles.bento.core.notes.BlockKind
import com.charles.bento.core.notes.MarkdownParser
import com.charles.bento.core.notes.SwiftText
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
 *     ## Transcript
 *
 *     **[0:00]** First paragraph…
 *
 * The sections match the Mac's `notes.md`. The transcript is the last section, so the
 * Notes editor collapses it with its heading like any section. Transcript lines the Notes
 * parser would read as headings (they would end or split the section) are escaped and an
 * unclosed code fence is closed, as Bento's thought capture does.
 */
object MeetingNoteRenderer {
    const val TRANSCRIPT_HEADING = "Transcript"

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
        lines += "## $TRANSCRIPT_HEADING"
        lines += ""
        lines += escapeBody(body)
        return lines.joinToString("\n") + "\n"
    }

    private fun oneLine(text: String) = text.replace("\r\n", " ").replace('\n', ' ').replace('\r', ' ').trim()

    /** Escapes lines the Notes parser reads as headings (outside code); closes an open fence. */
    internal fun escapeBody(body: String): String {
        val out = ArrayList<String>()
        var inCode = false
        var fence: String? = null
        for (line in body.replace("\r\n", "\n").replace('\r', '\n').split('\n')) {
            when (val k = MarkdownParser.parseLine(line, inCode).kind) {
                is BlockKind.Fence -> {
                    inCode = k.opening
                    fence = if (k.opening) SwiftText.trimWhitespaces(line).let { t -> t.takeWhile { it == t[0] } } else null
                    out += line
                }
                is BlockKind.Heading -> out += "\\" + SwiftText.trimWhitespaces(line)
                else -> out += line
            }
        }
        if (fence != null) out += fence
        return out.joinToString("\n")
    }
}
