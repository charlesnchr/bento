package com.charles.bento.ui.notes

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import com.charles.bento.core.notes.BlockKind
import com.charles.bento.core.notes.MarkdownParser
import com.charles.bento.core.notes.TextRange
import com.charles.bento.core.notes.ThoughtCapture

/**
 * Which heading sections are folded, as on the Mac: any heading's section (down to the
 * next heading of the same or a higher level) can fold; captured thoughts start folded.
 * Kept per editor, never written to the note. Headings are known by their line's text.
 */
class FoldState {
    private val opened = HashSet<String>() // captured thoughts the user opened
    private val folded = HashSet<String>() // other headings the user folded
    var version by mutableIntStateOf(0)
        private set

    fun isFolded(key: String, entry: Boolean) = if (entry) key !in opened else key in folded

    fun toggle(f: Section) {
        val set = if (f.entry) opened else folded
        if (!set.remove(f.key)) set.add(f.key)
        version++
    }
}

/** A heading's section: the heading line ends at `start` (its newline), the body runs to `end`. */
data class Section(val headingStart: Int, val start: Int, val end: Int, val key: String, val entry: Boolean)

/** Every heading section, outermost first per position. */
fun sections(text: String): List<Section> {
    val lines = runCatching { MarkdownParser.parseLines(text) }.getOrDefault(emptyList())
    val out = ArrayList<Section>()
    for (pl in lines) {
        val k = pl.line.kind as? BlockKind.Heading ?: continue
        val lineStart = pl.range.location
        val lineEnd = text.indexOf('\n', lineStart).let { if (it < 0 || it > pl.range.end) pl.range.end else it }
        val content = text.substring(lineStart + pl.line.contentRange.location, (lineStart + pl.line.contentRange.end).coerceAtMost(text.length))
        // sectionEnd wants the heading's whole line, newline included (parseLines' ranges stop before it)
        val fullLine = TextRange(lineStart, minOf(text.length, lineEnd + 1) - lineStart)
        val end = MarkdownParser.sectionEnd(fullLine, k.level, text)
        // keep the newline before the next heading visible, so it starts its own line
        val bodyEnd = if (end < text.length) end - 1 else text.length
        out += Section(lineStart, lineEnd, maxOf(lineEnd, bodyEnd), text.substring(lineStart, lineEnd), ThoughtCapture.isEntryHeading(content))
    }
    return out
}

/** The folded sections to hide (nested ones inside a folded section are already hidden). */
fun foldedSections(text: String, state: FoldState): List<Section> {
    val out = ArrayList<Section>()
    var hiddenUntil = -1
    for (s in sections(text)) {
        if (s.headingStart < hiddenUntil) continue
        if (s.end > s.start && state.isFolded(s.key, s.entry)) {
            out += s
            hiddenUntil = s.end
        }
    }
    return out
}

/** The section the caret is in (the innermost heading at or above it). */
fun sectionAt(text: String, caret: Int): Section? =
    sections(text).filter { caret >= it.headingStart && caret <= maxOf(it.end, it.start) }.maxByOrNull { it.headingStart }

/**
 * Markdown styling plus folding: a folded section's body is hidden behind " ⋯" after its
 * heading, with an offset mapping so the caret, selection and edits stay on the real text.
 */
class FoldingVisual(private val markdown: MarkdownVisual, private val state: FoldState, private val markerColor: Color) : VisualTransformation {
    override fun filter(text: AnnotatedString): TransformedText {
        val styled = markdown.style(text.text)
        val folds = foldedSections(text.text, state)
        if (folds.isEmpty()) return TransformedText(styled, OffsetMapping.Identity)
        val out = buildAnnotatedString {
            var at = 0
            for (f in folds) {
                append(styled.subSequence(at, f.start))
                pushStyle(SpanStyle(color = markerColor))
                append(MARKER)
                pop()
                at = f.end
            }
            append(styled.subSequence(at, styled.length))
        }
        return TransformedText(out, FoldMapping(folds, text.length))
    }

    private class FoldMapping(private val folds: List<Section>, private val length: Int) : OffsetMapping {
        override fun originalToTransformed(offset: Int): Int {
            var shift = 0
            for (f in folds) {
                if (offset <= f.start) break
                if (offset < f.end) return f.start + shift + MARKER.length // inside the hidden body: after the marker
                shift += MARKER.length - (f.end - f.start)
            }
            return offset + shift
        }

        override fun transformedToOriginal(offset: Int): Int {
            var shift = 0
            for (f in folds) {
                val markerStart = f.start + shift
                if (offset <= markerStart) break
                if (offset < markerStart + MARKER.length) return f.start // on the marker: the heading's end
                shift += MARKER.length - (f.end - f.start)
            }
            return (offset - shift).coerceIn(0, length)
        }
    }

    companion object {
        const val MARKER = " ⋯"
    }
}
