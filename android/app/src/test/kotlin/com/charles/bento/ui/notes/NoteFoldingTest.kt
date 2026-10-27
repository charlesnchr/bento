package com.charles.bento.ui.notes

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class NoteFoldingTest {
    private val note = "# Thoughts\n\n### 2026-10-27 23:12 · Idea for the garden…\nPlant tulips.\n\n### 2026-10-27 23:13 · Hey Sam…\nRunning late.\n"

    @Test fun capturedThoughtsStartFolded() {
        val all = sections(note)
        assertEquals(3, all.size, all.toString())
        val folded = foldedSections(note, FoldState())
        assertEquals(2, folded.size, all.toString())
        assertTrue(folded.all { it.entry })
        // the first entry's body ends before the newline that starts the second heading
        val first = folded[0]
        assertEquals("\nPlant tulips.\n", note.substring(first.start, first.end))
    }
}
