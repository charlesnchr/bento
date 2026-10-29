package com.charles.bento.core.assistant

import com.charles.bento.core.notes.BlockKind
import com.charles.bento.core.notes.InlineKind
import com.charles.bento.core.notes.MarkdownParser
import com.charles.bento.core.notes.TextRange

/**
 * A reply's Markdown for reading, not editing: the notes parser's blocks and inline spans
 * with the syntax removed, so the screen draws headings, lists, quotes, code blocks, rules,
 * emphasis, code and links (raw HTML and equations stay as text).
 */
object ChatMarkdown {
    /** An inline style over `[start, end)` of a block's text. */
    data class Span(val start: Int, val end: Int, val kind: InlineKind)

    sealed interface Block {
        data class Text(val text: String, val spans: List<Span>, val style: Style = Style.Paragraph) : Block
        data class Code(val lang: String, val text: String) : Block
        data object Rule : Block
        /** A blank line between paragraphs. */
        data object Gap : Block
    }

    sealed interface Style {
        data object Paragraph : Style
        data class Heading(val level: Int) : Style
        /** `marker` is what the list shows: "•", "3." or a checkbox. */
        data class Item(val marker: String, val level: Int, val checked: Boolean? = null) : Style
        data class Quote(val depth: Int) : Style
    }

    fun parse(markdown: String): List<Block> {
        val text = markdown.trim('\n', '\r')
        if (text.isBlank()) return emptyList()
        val lines = runCatching { MarkdownParser.parseLines(text) }.getOrElse { return listOf(Block.Text(text, emptyList())) }
        val out = ArrayList<Block>()
        var code: StringBuilder? = null
        var lang = ""
        for (pl in lines) {
            val raw = text.substring(pl.range.location, pl.range.end)
            when (val k = pl.line.kind) {
                is BlockKind.Fence -> if (k.opening) { code = StringBuilder(); lang = k.lang } else {
                    out.add(Block.Code(lang, code?.toString()?.removeSuffix("\n").orEmpty())); code = null
                }
                BlockKind.Code -> code?.append(raw)?.append('\n')
                BlockKind.Rule -> out.add(Block.Rule)
                else -> {
                    if (raw.isBlank()) { if (out.isNotEmpty() && out.last() != Block.Gap) out.add(Block.Gap); continue }
                    val content = TextRange(pl.range.location + pl.line.contentRange.location, pl.line.contentRange.length)
                    val (t, spans) = inline(text, content)
                    val style = when (k) {
                        is BlockKind.Heading -> Style.Heading(k.level)
                        BlockKind.Bullet -> Style.Item("•", pl.line.level)
                        is BlockKind.Ordered -> Style.Item("${k.number}.", pl.line.level)
                        is BlockKind.Task -> Style.Item(if (k.checked) "☑" else "☐", pl.line.level, k.checked)
                        is BlockKind.Quote -> Style.Quote(k.depth)
                        else -> Style.Paragraph
                    }
                    out.add(Block.Text(t, spans, style))
                }
            }
        }
        // A fence the reply hasn't closed yet (still streaming) shows as code so far.
        code?.let { out.add(Block.Code(lang, it.toString().removeSuffix("\n"))) }
        while (out.lastOrNull() == Block.Gap) out.removeAt(out.lastIndex)
        return out
    }

    /** The content with inline markers removed, and the spans moved to match. */
    private fun inline(text: String, content: TextRange): Pair<String, List<Span>> {
        val spans = runCatching { MarkdownParser.inlineSpans(text, content) }.getOrDefault(emptyList())
        val hidden = BooleanArray(content.length)
        for (s in spans) for (m in s.markers) {
            for (i in m.location until m.end) (i - content.location).takeIf { it in hidden.indices }?.let { hidden[it] = true }
        }
        // Link URLs live in the markers' range (`](url)`); they go with the markers.
        val map = IntArray(content.length + 1)
        val sb = StringBuilder()
        for (i in 0 until content.length) {
            map[i] = sb.length
            if (!hidden[i]) sb.append(text[content.location + i])
        }
        map[content.length] = sb.length
        fun at(abs: Int) = map[(abs - content.location).coerceIn(0, content.length)]
        val moved = spans.mapNotNull { s ->
            val a = at(s.contentRange.location)
            val b = at(s.contentRange.end)
            if (b > a) Span(a, b, s.kind) else null
        }
        return sb.toString() to moved
    }
}
