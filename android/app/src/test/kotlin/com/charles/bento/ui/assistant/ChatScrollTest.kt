package com.charles.bento.ui.assistant

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ChatScrollTest {
    @Test fun comesBackToTheSamePlace() {
        val s = ChatScroll("sess 1", index = 12, offset = 340, messages = 30, lastLength = 210, pinned = false)
        assertEquals(s, ChatScroll.restore(s.encode(), "sess 1"))
    }

    @Test fun onlyForItsOwnConversation() {
        val saved = ChatScroll("a", 3, 0, 5, 40, pinned = false).encode()
        assertNull(ChatScroll.restore(saved, "b"))
        assertNull(ChatScroll.restore(saved, null))
        assertNull(ChatScroll.restore("", "a"))
        assertNull(ChatScroll.restore("x 0 5 40 0 a", "a"))
    }

    @Test fun newMessagesMoveItOnlyWhenAtTheBottom() {
        val reading = ChatScroll("a", 3, 120, messages = 10, lastLength = 80, pinned = false)
        assertFalse(reading.follows(14, 300))
        val atBottom = ChatScroll("a", 8, 40, messages = 10, lastLength = 80, pinned = true)
        assertFalse(atBottom.follows(10, 80))
        assertTrue(atBottom.follows(12, 80))
        // the reply that was streaming when the user left has grown
        assertTrue(atBottom.follows(10, 400))
    }

    @Test fun followsTheConversationToANewSession() {
        val saved = ChatScroll("a", 3, 120, messages = 10, lastLength = 80, pinned = false).encode()
        assertEquals(ChatScroll("b", 3, 120, 10, 80, pinned = false), ChatScroll.restore(ChatScroll.moved(saved, "a", "b"), "b"))
        assertEquals(saved, ChatScroll.moved(saved, "c", "b"))
    }
}
