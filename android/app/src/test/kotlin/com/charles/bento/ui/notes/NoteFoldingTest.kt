package com.charles.bento.ui.notes

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import com.charles.bento.core.notes.HeadingFolds
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// The fold logic is HeadingFoldsTest's (core); this is the editor's transformation of it.
class NoteFoldingTest {
    private val note = "# Thoughts\n\n### 2026-10-27 23:12 · Idea for the garden…\nPlant tulips.\n\n### 2026-10-27 23:13 · Hey Sam…\nRunning late.\n"
    private val colors = MarkdownColors(Color.Black, Color.Gray, Color.Gray, Color.Blue, Color.LightGray)

    @Test fun capturedThoughtsShowAsTheirHeadings() {
        val all = sections(note)
        assertEquals(3, all.size, all.toString())
        assertEquals(listOf(false, true, true), all.map { it.entry })
        assertEquals("\nPlant tulips.\n", note.substring(all[1].start, all[1].end))
    }

    @Test fun hiddenTextIsReplacedByTheMarkerAndMapsToTheHeadingsEnd() {
        val folds = HeadingFolds.of(note)
        val t = FoldingVisual(MarkdownVisual(colors), folds, Color.Gray).filter(AnnotatedString(note))
        assertEquals("# Thoughts\n\n### 2026-10-27 23:12 · Idea for the garden… ⋯\n### 2026-10-27 23:13 · Hey Sam… ⋯\n", t.text.text)
        val m = t.offsetMapping
        val first = folds.folds[0]
        assertEquals(first.start, m.transformedToOriginal(m.originalToTransformed(first.start)))
        // the marker, and just after it (a tap at the line's end), go to the heading's end
        for (i in 1..FoldingVisual.MARKER.length) assertEquals(first.start, m.transformedToOriginal(m.originalToTransformed(first.start) + i))
        // the next line maps through
        val next = note.indexOf("### 2026-10-27 23:13")
        assertEquals(next, m.transformedToOriginal(m.originalToTransformed(next)))
        assertEquals(note.length, m.transformedToOriginal(t.text.length))
        assertEquals(t.text.length, m.originalToTransformed(note.length))
        for (o in 0..note.length) assertTrue(m.originalToTransformed(o) in 0..t.text.length)
        for (o in 0..t.text.length) assertTrue(m.transformedToOriginal(o) in 0..note.length)
    }

    @Test fun chevronTargetsOfStackedHeadingsDontOverlap() {
        // two headings on consecutive lines, then one further down
        val t = chevronTargets(listOf(0f to 60f, 60f to 120f, 300f to 360f), slack = 18f)
        assertEquals(listOf(-18f to 60f, 60f to 138f, 282f to 378f), t)
        for (i in 1 until t.size) assertTrue(t[i - 1].second <= t[i].first)
        // a small gap: they meet halfway
        assertEquals(listOf(-18f to 65f, 65f to 148f), chevronTargets(listOf(0f to 60f, 70f to 130f), slack = 18f))
    }

    @Test fun theBlankSpaceBelowAFoldShrinksToWhatTheScrollPositionNeeds() {
        // laid out with 1000 of blank space: the text alone scrolls to 400, the position is 700
        assertEquals(300, FoldAnchor.trimmed(tail = 1000, laidOut = 1000, value = 700, maxValue = 1400))
        // scrolled back up within the text: none needed
        assertEquals(0, FoldAnchor.trimmed(tail = 300, laidOut = 300, value = 200, maxValue = 700))
        // never grows
        assertEquals(100, FoldAnchor.trimmed(tail = 100, laidOut = 100, value = 900, maxValue = 500))
        // trimmed again before the layout: measured against what was laid out, not the new height
        assertEquals(300, FoldAnchor.trimmed(tail = 300, laidOut = 1000, value = 700, maxValue = 1400))
    }

    @Test fun aStaleFoldStateStillGivesAValidMapping() {
        val folds = HeadingFolds.of(note)
        val changed = note.replace("Plant tulips.", "x")
        val t = FoldingVisual(MarkdownVisual(colors), folds, Color.Gray).filter(AnnotatedString(changed))
        for (o in 0..changed.length) assertTrue(t.offsetMapping.originalToTransformed(o) in 0..t.text.length)
    }
}
