package com.charles.bento.widget

import com.charles.bento.core.notes.BlockKind
import com.charles.bento.core.notes.MarkdownCommands
import com.charles.bento.core.notes.MarkdownParser
import com.charles.bento.core.notes.Note
import com.charles.bento.core.notes.NoteQueries
import com.charles.bento.core.notes.NoteText
import com.charles.bento.core.notes.TextRange
import com.charles.bento.notes.NotesModule
import com.charles.bento.ui.notes.sections
import com.charles.bento.ui.notes.snippet

/** Notes for the widgets, from the store's snapshot; checklist taps go through the notes module. */
class NotesWidgetSource(private val notes: NotesModule) : AppWidgetData.WidgetNotes {
    override fun notes(limit: Int): List<NoteCard> = NoteQueries.liveNotes(notes.notes.value).take(limit).map(::card)

    override fun note(id: String): NoteCard? = notes.notes.value.firstOrNull { it.id == id && it.isLive }?.let { card(it, lines = true) }

    override suspend fun toggleChecklistItem(noteId: String, line: Int) {
        val n = notes.notes.value.firstOrNull { it.id == noteId } ?: return
        val start = lineStart(n.body, line) ?: return
        val r = MarkdownCommands.toggleTasks(n.body, TextRange(start, 0)) ?: return
        notes.setBody(noteId, r.apply(n.body))
    }

    private fun card(n: Note, lines: Boolean = false) = NoteCard(
        id = n.id, title = NoteText.title(n.body), snippet = snippet(n.body, 3), pinned = n.pinned, updatedAt = n.updatedAt,
        lines = if (lines) displayLines(n.body) else emptyList(),
    )

    /** The body as widget lines (after the title line), with each line's index in the body. */
    private fun displayLines(body: String): List<NoteLine> {
        val title = NoteText.title(body)
        var titleSkipped = false
        var inCode = false
        // captured thoughts show as their headings, as they start folded in the editor
        val folded = sections(body).filter { it.entry }
        var offset = 0
        return body.split('\n').mapIndexedNotNull { i, raw ->
            val lineStart = offset
            offset += raw.length + 1
            if (folded.any { lineStart > it.start && lineStart <= it.end }) return@mapIndexedNotNull null
            val p = MarkdownParser.parseLine(raw, inCode)
            if (p.kind is BlockKind.Fence) inCode = (p.kind as BlockKind.Fence).opening
            val content = raw.substring(p.contentRange.location, p.contentRange.end).let { MarkdownParser.stripInline(it) }.trim()
            if (!titleSkipped && content.isNotEmpty()) {
                titleSkipped = true
                if (content == title) return@mapIndexedNotNull null
            }
            when (val k = p.kind) {
                is BlockKind.Task -> NoteLine.Check(i, content, k.checked)
                BlockKind.Bullet, is BlockKind.Ordered -> NoteLine.Bullet(i, content)
                is BlockKind.Heading -> NoteLine.Text(i, content, heading = true)
                BlockKind.Rule, is BlockKind.Fence -> null
                else -> if (content.isEmpty()) null else NoteLine.Text(i, content, heading = false)
            }
        }.take(60)
    }

    private fun lineStart(body: String, line: Int): Int? {
        var at = 0
        repeat(line) {
            val nl = body.indexOf('\n', at)
            if (nl < 0) return null
            at = nl + 1
        }
        return at
    }
}
