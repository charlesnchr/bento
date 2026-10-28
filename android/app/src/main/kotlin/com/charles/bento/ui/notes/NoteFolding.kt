package com.charles.bento.ui.notes

import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.Saver
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.charles.bento.core.notes.Fold
import com.charles.bento.core.notes.HeadingFolds
import com.charles.bento.core.notes.HeadingSections
import kotlin.math.roundToInt

/** A heading's section: the heading line ends at `start` (its newline), the body runs to `end`. */
data class Section(val headingStart: Int, val start: Int, val end: Int, val entry: Boolean)

/** Every heading section (for the notes widget: captured thoughts show as their headings). */
fun sections(text: String): List<Section> =
    HeadingSections.of(text).map { Section(it.lineStart, it.headingEnd, it.bodyEnd, it.entry) }

/**
 * The editor's [HeadingFolds]. Kept in memory per note while the app runs (switching notes,
 * rotation), carried through whatever changed in the note meanwhile; after the process was
 * recreated, from the saved state by heading. [state] starts the first time it's asked for.
 */
class EditorFolds(private val saved: List<String>?) {
    private var state: MutableState<HeadingFolds>? = null

    fun state(id: String, text: String): MutableState<HeadingFolds> = state ?: mutableStateOf(
        remembered[id]?.edited(text, local = false) ?: HeadingFolds.restore(text, saved),
    ).also { state = it }

    companion object {
        private val remembered = HashMap<String, HeadingFolds>()

        /** The editor of note `id` is going away with these folds. */
        fun leaving(id: String, folds: HeadingFolds) { remembered[id] = folds }

        val Saver = Saver<EditorFolds, ArrayList<String>>(
            save = { it.state?.value?.saved() ?: it.saved?.let(::ArrayList) },
            restore = { EditorFolds(it) },
        )
    }
}

/**
 * Markdown styling plus folding: a folded section's hidden part is replaced by " ⋯" after its
 * heading, with an offset mapping so the caret, selection and edits stay on the real text.
 */
class FoldingVisual(private val markdown: MarkdownVisual, private val folds: HeadingFolds, private val markerColor: Color) : VisualTransformation {
    override fun filter(text: AnnotatedString): TransformedText {
        val styled = markdown.style(text.text)
        // (the folds always describe the field's text; this only guards a frame in between)
        val shown = (if (folds.text == text.text) folds else folds.edited(text.text, local = false)).folds
        if (shown.isEmpty()) return TransformedText(styled, OffsetMapping.Identity)
        val out = buildAnnotatedString {
            var at = 0
            for (f in shown) {
                append(styled.subSequence(at, f.start))
                pushStyle(SpanStyle(color = markerColor))
                append(MARKER)
                pop()
                at = f.end
            }
            append(styled.subSequence(at, styled.length))
        }
        return TransformedText(out, FoldMapping(shown, text.length))
    }

    override fun equals(other: Any?) = other is FoldingVisual && other.folds == folds && other.markerColor == markerColor
    override fun hashCode() = folds.hashCode()

    /** Hidden text maps to the marker; the marker (or a tap just after it) to the heading's end. */
    class FoldMapping(private val folds: List<Fold>, private val length: Int) : OffsetMapping {
        override fun originalToTransformed(offset: Int): Int {
            var shift = 0
            for (f in folds) {
                if (offset <= f.start) break
                if (offset < f.end) return f.start + shift
                if (offset == f.end) return f.start + shift + MARKER.length
                shift += MARKER.length - (f.end - f.start)
            }
            return offset + shift
        }

        override fun transformedToOriginal(offset: Int): Int {
            var shift = 0
            for (f in folds) {
                val markerStart = f.start + shift
                if (offset <= markerStart) break
                if (offset <= markerStart + MARKER.length) return f.start
                shift += MARKER.length - (f.end - f.start)
            }
            return (offset - shift).coerceIn(0, length)
        }
    }

    companion object {
        const val MARKER = " ⋯"
    }
}

/** Left of the text: room for the fold chevrons. */
val FoldGutter = 28.dp

/**
 * Tap targets over the text field (laid out at `textStart`, `textTop` in this box): a chevron
 * in the gutter beside each heading that has something to fold (pointing right while folded),
 * and the " ⋯" of a folded one. Taps on them toggle the section without moving the caret or
 * touching the keyboard.
 */
@Composable
fun FoldControls(folds: HeadingFolds, layout: TextLayoutResult?, textStart: Dp, textTop: Dp, color: Color, onToggle: (Int) -> Unit) {
    layout ?: return
    val density = LocalDensity.current
    val mapping = remember(folds) { FoldingVisual.FoldMapping(folds.folds, folds.text.length) }
    val length = layout.layoutInput.text.length
    val slack = with(density) { 6.dp.toPx() }
    val top = with(density) { textTop.toPx() }
    val start = with(density) { textStart.toPx() }
    fun lineBounds(transformed: Int): Pair<Float, Float> {
        val line = layout.getLineForOffset(transformed.coerceIn(0, length))
        return layout.getLineTop(line) + top to layout.getLineBottom(line) + top
    }
    for (s in folds.sections) {
        if (!s.foldable || !folds.isShown(s.lineStart)) continue
        val folded = folds.isFolded(s.lineStart)
        val (y0, y1) = lineBounds(mapping.originalToTransformed(s.lineStart))
        key(s.lineStart) {
            Box(
                Modifier
                    .offset { IntOffset(0, (y0 - slack).roundToInt()) }
                    .size(48.dp, with(density) { (y1 - y0 + 2 * slack).toDp() })
                    .clickable(remember { MutableInteractionSource() }, indication = null, role = Role.Button,
                               onClickLabel = if (folded) "Unfold section" else "Fold section") { onToggle(s.lineStart) },
            ) {
                Icon(
                    if (folded) Icons.AutoMirrored.Rounded.KeyboardArrowRight else Icons.Rounded.KeyboardArrowDown,
                    if (folded) "Folded section" else "Open section",
                    tint = if (folded) color else color.copy(alpha = 0.45f),
                    modifier = Modifier.align(Alignment.CenterStart).padding(start = (textStart - 20.dp) / 2).size(20.dp),
                )
            }
        }
    }
    for (f in folds.folds) {
        val marker = mapping.originalToTransformed(f.start) + 1 // the "⋯"
        if (marker >= length) continue
        val box = layout.getBoundingBox(marker)
        val (y0, y1) = lineBounds(marker)
        val pad = with(density) { 14.dp.toPx() }
        key("marker", f.lineStart) {
            Box(
                Modifier
                    .offset { IntOffset((start + box.left - pad).roundToInt(), (y0 - slack).roundToInt()) }
                    .size(with(density) { (box.width + 2 * pad).toDp() }, with(density) { (y1 - y0 + 2 * slack).toDp() })
                    .clickable(remember { MutableInteractionSource() }, indication = null, role = Role.Button, onClickLabel = "Unfold section") {
                        onToggle(f.lineStart)
                    },
            )
        }
    }
}
