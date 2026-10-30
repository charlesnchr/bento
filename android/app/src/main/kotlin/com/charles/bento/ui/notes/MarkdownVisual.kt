package com.charles.bento.ui.notes

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp
import com.charles.bento.core.notes.BlockKind
import com.charles.bento.core.notes.InlineKind
import com.charles.bento.core.notes.MarkdownParser
import com.charles.bento.core.notes.NoteImage
import com.charles.bento.core.notes.TextRange
import com.charles.bento.ui.theme.SansCode

/** Colours for the editor's Markdown, from the theme. */
data class MarkdownColors(
    val text: Color,
    val muted: Color,
    val marker: Color,
    val accent: Color,
    val codeBackground: Color,
)

/**
 * Raycast-notes styling with the syntax kept visible but quiet (offsets stay 1:1, so the
 * caret and remote merges work on the real text): headings sized, emphasis applied, code
 * in Google Sans Code, links tinted, done tasks struck through, markers and image lines dimmed.
 */
class MarkdownVisual(private val colors: MarkdownColors, private val baseSize: TextUnit = 16.sp) : VisualTransformation {
    override fun filter(text: AnnotatedString): TransformedText = TransformedText(style(text.text), OffsetMapping.Identity)

    fun style(s: String): AnnotatedString = buildAnnotatedString {
        append(s)
        if (s.isEmpty()) return@buildAnnotatedString
        val lines = runCatching { MarkdownParser.parseLines(s) }.getOrDefault(emptyList())
        for (pl in lines) {
            val start = pl.range.location
            val line = pl.line
            fun span(r: TextRange?, style: SpanStyle) {
                r ?: return
                val a = (start + r.location).coerceIn(0, s.length)
                val b = (start + r.end).coerceIn(a, s.length)
                if (b > a) addStyle(style, a, b)
            }
            val whole = TextRange(0, pl.range.length)
            when (val k = line.kind) {
                is BlockKind.Heading -> {
                    val size = when (k.level) { 1 -> baseSize * 1.6f; 2 -> baseSize * 1.35f; 3 -> baseSize * 1.18f; else -> baseSize * 1.05f }
                    span(whole, SpanStyle(fontSize = size, fontWeight = FontWeight.Bold, color = colors.text))
                    span(line.prefixRange, SpanStyle(color = colors.marker, fontWeight = FontWeight.Normal))
                }
                is BlockKind.Task -> {
                    span(line.prefixRange, SpanStyle(color = colors.marker))
                    span(line.markerRange, SpanStyle(color = if (k.checked) colors.accent else colors.muted, fontWeight = FontWeight.Bold, fontFamily = SansCode))
                    if (k.checked) span(line.contentRange, SpanStyle(color = colors.muted, textDecoration = TextDecoration.LineThrough))
                }
                BlockKind.Bullet, is BlockKind.Ordered -> span(line.prefixRange, SpanStyle(color = colors.accent, fontWeight = FontWeight.Medium))
                is BlockKind.Quote -> {
                    span(line.prefixRange, SpanStyle(color = colors.marker))
                    span(line.contentRange, SpanStyle(color = colors.muted, fontStyle = FontStyle.Italic))
                }
                BlockKind.Rule -> span(whole, SpanStyle(color = colors.marker))
                is BlockKind.Fence -> span(whole, SpanStyle(color = colors.marker, fontFamily = SansCode, fontSize = baseSize * 0.9f))
                BlockKind.Code -> span(whole, SpanStyle(fontFamily = SansCode, background = colors.codeBackground, fontSize = baseSize * 0.9f))
                BlockKind.Paragraph -> if (NoteImage.hash(s.substring(start, start + pl.range.length)) != null) {
                    // an image (shown above the text): its line stays small and quiet
                    span(whole, SpanStyle(color = colors.marker, fontFamily = SansCode, fontSize = baseSize * 0.65f))
                    continue
                }
            }
            if (line.kind is BlockKind.Code || line.kind is BlockKind.Fence) continue
            // inline styles within the line's content
            val content = line.contentRange
            val spans = runCatching {
                MarkdownParser.inlineSpans(s, TextRange(start + content.location, content.length))
            }.getOrDefault(emptyList())
            for (sp in spans) {
                val style = when (val ik = sp.kind) {
                    InlineKind.Bold -> SpanStyle(fontWeight = FontWeight.Bold)
                    InlineKind.Italic -> SpanStyle(fontStyle = FontStyle.Italic)
                    InlineKind.BoldItalic -> SpanStyle(fontWeight = FontWeight.Bold, fontStyle = FontStyle.Italic)
                    InlineKind.Strike -> SpanStyle(textDecoration = TextDecoration.LineThrough, color = colors.muted)
                    InlineKind.Underline -> SpanStyle(textDecoration = TextDecoration.Underline)
                    InlineKind.Code -> SpanStyle(fontFamily = SansCode, background = colors.codeBackground)
                    is InlineKind.Link, is InlineKind.Autolink -> SpanStyle(color = colors.accent, textDecoration = TextDecoration.Underline)
                }
                addSafe(style, sp.contentRange, s)
                for (m in sp.markers) addSafe(SpanStyle(color = colors.marker), m, s)
            }
        }
    }

    private fun AnnotatedString.Builder.addSafe(style: SpanStyle, r: TextRange, s: String) {
        val a = r.location.coerceIn(0, s.length)
        val b = r.end.coerceIn(a, s.length)
        if (b > a) addStyle(style, a, b)
    }
}
