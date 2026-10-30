package com.charles.bento.ui.notes

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.BringIntoViewSpec
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
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
 * The editor's [HeadingFolds]. Kept by heading ([HeadingFolds.saved]) per note while the app
 * runs (switching notes, rotation) and in the saved state when the process is recreated, and
 * applied to the note as it is when its editor comes back. [state] starts the first time it's
 * asked for.
 */
class EditorFolds(private val saved: List<String>?) {
    private var state: MutableState<HeadingFolds>? = null

    fun state(id: String, text: String): MutableState<HeadingFolds> =
        state ?: mutableStateOf(HeadingFolds.restore(text, remembered[id] ?: saved)).also { state = it }

    companion object {
        /** Each note's folds when its editor last went away, by heading ([HeadingFolds.saved]). */
        private val remembered = HashMap<String, List<String>>()

        /** The editor of note `id` is going away with these folds. */
        fun leaving(id: String, folds: HeadingFolds) { remembered[id] = folds.saved() }

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

/**
 * The chevrons' tap targets beside heading lines (`lines`: top and bottom, in order): each
 * line plus `slack` above and below, stopping halfway to the line before or after, so stacked
 * headings' targets don't overlap.
 */
fun chevronTargets(lines: List<Pair<Float, Float>>, slack: Float): List<Pair<Float, Float>> = lines.mapIndexed { i, (y0, y1) ->
    val prev = lines.getOrNull(i - 1)?.second?.takeIf { it <= y0 }
    val next = lines.getOrNull(i + 1)?.first?.takeIf { it >= y1 }
    maxOf(y0 - slack, prev?.let { (it + y0) / 2 } ?: Float.NEGATIVE_INFINITY) to minOf(y1 + slack, next?.let { (y1 + it) / 2 } ?: Float.POSITIVE_INFINITY)
}

/**
 * Keeps a tapped heading where it is on screen while its section folds or opens. The text
 * field scrolls its caret into view whenever its shown text changes, which a fold does, so for
 * the frames a fold takes the editor's scroll ignores those requests ([base] answers the rest);
 * and so a fold near the end doesn't pull the text down as the note gets shorter under the
 * scroll position, blank space below the text ([tail]) makes up the difference until the user
 * scrolls back up.
 */
@OptIn(ExperimentalFoundationApi::class)
class FoldAnchor(private val scroll: ScrollState, private val base: BringIntoViewSpec) : BringIntoViewSpec {
    private var holding = false
    private var toggles by mutableIntStateOf(0)

    /** Blank space below the text, in pixels. */
    var tail by mutableIntStateOf(0)
        private set

    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float =
        if (holding) 0f else base.calculateScrollDistance(offset, size, containerSize)

    /**
     * A fold is about to toggle in text laid out `textHeight` tall (as far as a fold can shorten
     * it), on top of the blank space an earlier fold still needs.
     */
    fun toggling(textHeight: Int) {
        holding = true
        tail += textHeight
        toggles++
    }

    /** The blank space's height in the last layout (what [ScrollState.maxValue] includes). */
    private var laidOutTail = 0

    /** The blank space was laid out `height` tall. */
    fun laidOut(height: Int) { laidOutTail = height }

    private fun trim() {
        tail = trimmed(laidOutTail, scroll.value, scroll.maxValue)
    }

    @Composable
    fun Effects() {
        LaunchedEffect(toggles) {
            if (toggles == 0) return@LaunchedEffect
            // the fold's layout, then the caret request the field launches from it
            repeat(2) { withFrameNanos {} }
            holding = false
            trim()
        }
        LaunchedEffect(Unit) { snapshotFlow { scroll.value to scroll.maxValue }.collect { if (!holding) trim() } }
    }

    companion object {
        /**
         * Only the blank space still needed to fill the screen below the scroll position `value`:
         * `maxValue` is the last layout's, with `laidOut` of blank space in it. Never more than
         * that (the scroll can't pass `maxValue`), but it can be all of it again: a fling going
         * on down before a trim is laid out keeps what it scrolls into. None when nothing scrolls.
         */
        fun trimmed(laidOut: Int, value: Int, maxValue: Int): Int =
            if (maxValue == 0) 0 else maxOf(0, value - (maxValue - laidOut))
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
    val headings = folds.sections.filter { it.foldable && folds.isShown(it.lineStart) }.map { it.lineStart }
    val lines = headings.map { lineBounds(mapping.originalToTransformed(it)) }
    val targets = chevronTargets(lines, slack)
    val icon = with(density) { 20.dp.toPx() }
    for (i in headings.indices) {
        val lineStart = headings[i]
        val (y0, y1) = lines[i]
        val (boxTop, boxBottom) = targets[i]
        val folded = folds.isFolded(lineStart)
        key(lineStart) {
            Box(
                Modifier
                    .offset { IntOffset(0, boxTop.roundToInt()) }
                    .size(48.dp, with(density) { (boxBottom - boxTop).toDp() })
                    .clickable(remember { MutableInteractionSource() }, indication = null, role = Role.Button,
                               onClickLabel = if (folded) "Unfold section" else "Fold section") { onToggle(lineStart) },
            ) {
                Icon(
                    if (folded) Icons.AutoMirrored.Rounded.KeyboardArrowRight else Icons.Rounded.KeyboardArrowDown,
                    if (folded) "Folded section" else "Open section",
                    tint = if (folded) color else color.copy(alpha = 0.45f),
                    // centred on the heading's line
                    modifier = Modifier.offset { IntOffset(((textStart - 20.dp) / 2).roundToPx(), ((y0 + y1 - icon) / 2 - boxTop).roundToInt()) }.size(20.dp),
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
