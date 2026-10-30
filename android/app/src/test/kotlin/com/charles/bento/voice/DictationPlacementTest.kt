package com.charles.bento.voice

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class DictationPlacementTest {
    @Test fun placeholderReadAsTextCountsAsEmpty() {
        // WhatsApp's empty message box: its hint comes back as the text, cursor at the start
        assertTrue(TextInserter.isPlaceholder("Message", 0, listOf("Message")))
        assertTrue(TextInserter.isPlaceholder("Message", -1, listOf("Message")))
        assertTrue(TextInserter.isPlaceholder("Search ", 0, listOf("Search")))
        // only the description or the label says so
        assertTrue(TextInserter.isPlaceholder("Message", 0, listOf("Type here", "Message")))
    }

    @Test fun realTextIsKept() {
        // typed text, even when it matches the hint, has the cursor after it (or is selected: the far end is passed)
        assertFalse(TextInserter.isPlaceholder("Message", 7, listOf("Message")))
        assertFalse(TextInserter.isPlaceholder("Hello", 0, listOf("Message")))
        assertFalse(TextInserter.isPlaceholder("Message", 0, emptyList()))
        assertFalse(TextInserter.isPlaceholder("", 0, listOf("")))
    }

    private fun top(fieldTop: Int?, fieldBottom: Int?, keyboardTop: Int = 1_500, keyboardBottom: Int = 2_400) =
        DictationOverlay.pillTop(height = 150, keyboardTop = keyboardTop, keyboardBottom = keyboardBottom, fieldTop = fieldTop,
                                 fieldBottom = fieldBottom, minTop = 80, screenBottom = 2_400, gap = 20)

    @Test fun pillSitsAboveTheKeyboardWhenTheFieldIsHigherUp() {
        // a search box at the top of the screen
        assertEquals(1_330, top(200, 320))
        // no field bounds: above the keyboard
        assertEquals(1_330, top(null, null))
    }

    @Test fun pillGoesAboveAFieldThatSitsOnTheKeyboard() {
        // a chat's message box right above the keyboard
        val y = top(1_360, 1_480)
        assertEquals(1_190, y)
        assertTrue(y + 150 <= 1_360)
    }

    @Test fun pillMovesOverTheKeyboardWhenTheFieldFillsTheScreen() {
        // a note editor from the top bar to the keyboard: no room above or below it
        val y = top(150, 1_490)
        assertEquals(1_520, y)
        assertTrue(y >= 1_490)
    }

    @Test fun pillGoesBelowATallFieldWithRoomUnderIt() {
        // a floating keyboard (1500–1650) over a tall editor that ends lower down
        assertEquals(1_720, top(100, 1_700, keyboardBottom = 1_650))
        // the floating keyboard reaches past the field: below both
        assertEquals(1_820, top(100, 1_700, keyboardBottom = 1_800))
        // a docked keyboard over a field that runs behind it: along the keyboard's top, not over the keys
        assertEquals(1_520, top(150, 2_000))
    }

    @Test fun pillStaysOnScreen() {
        assertEquals(80, top(null, null, keyboardTop = 100))
        assertEquals(2_250, top(100, 2_390, keyboardTop = 2_390))
    }
}
