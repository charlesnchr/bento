package com.charles.bento.voice

import com.charles.bento.voice.VoiceService.Companion.KIND_ASSISTANT
import com.charles.bento.voice.VoiceService.Companion.KIND_DICTATION
import com.charles.bento.voice.VoiceService.Companion.KIND_MEETING
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class VoiceHoldersTest {
    @Test fun aDictationDuringACallKeepsTheCallsNotificationAndTheServiceUntilBothLeave() {
        val h = VoiceHolders()
        assertEquals(KIND_ASSISTANT, h.add(KIND_ASSISTANT))
        assertNull(h.add(KIND_DICTATION), "the call's notification stays")
        assertNull(h.remove(KIND_DICTATION))
        assertFalse(h.empty, "the dictation leaving doesn't stop the call's service")
        assertNull(h.remove(KIND_ASSISTANT))
        assertTrue(h.empty)
    }

    @Test fun theCallEndingMidDictationHandsTheNotificationToTheDictation() {
        val h = VoiceHolders()
        h.add(KIND_ASSISTANT)
        h.add(KIND_DICTATION)
        assertEquals(KIND_DICTATION, h.remove(KIND_ASSISTANT))
        assertFalse(h.empty)
        h.remove(KIND_DICTATION)
        assertTrue(h.empty)
    }

    @Test fun aCallStartingWhileAMeetingFinishesShowsTheCallAndOutlivesTheMeeting() {
        val h = VoiceHolders()
        h.add(KIND_MEETING)
        // stopped: the meeting holds the service while it files its notes, and a call starts meanwhile
        assertEquals(KIND_ASSISTANT, h.add(KIND_ASSISTANT))
        assertNull(h.remove(KIND_MEETING), "still the call's notification")
        assertFalse(h.empty)
        assertEquals(KIND_ASSISTANT, h.shown)
    }

    @Test fun leavingWithoutHavingComeInChangesNothing() {
        val h = VoiceHolders()
        assertNull(h.remove(KIND_DICTATION))
        assertTrue(h.empty)
        h.add(KIND_ASSISTANT)
        assertNull(h.remove(KIND_DICTATION))
        assertEquals(KIND_ASSISTANT, h.shown)
    }
}
