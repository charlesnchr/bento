package com.charles.bento.assistant

import com.charles.bento.core.assistant.AssistantTranscript
import com.charles.bento.core.assistant.HermesMessage
import com.charles.bento.core.assistant.live.HermesCall
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** A spoken request goes to Hermes wrapped, and comes back from its history as the words alone. */
class VoiceMessageTest {
    @Test fun theWrapperRoundTrips() {
        val message = AssistantController.voiceMessage(HermesCall("c1", "What's on my calendar tomorrow?", "assistant: Hi"), "2026-10-28")
        assertTrue(message.contains("Today's date is 2026-10-28."))
        assertTrue(message.endsWith("additional tasks:\nassistant: Hi"))
        assertTrue(AssistantTranscript.isVoiceRequest(message))
        assertEquals("What's on my calendar tomorrow?", AssistantTranscript.displayRequest(message))
        val row = AssistantTranscript.fromHistory(listOf(HermesMessage("user", message))).single()
        assertTrue(row.voice)
        assertEquals("What's on my calendar tomorrow?", row.text)
    }

    @Test fun aFollowUpSaysSoAndStillShowsAsTheWords() {
        val message = AssistantController.voiceMessage(HermesCall("c2", "Make it 8pm instead.", "", followUp = true), "2026-10-30")
        assertTrue(message.contains("It follows up your earlier work in this conversation"))
        assertEquals("Make it 8pm instead.", AssistantTranscript.displayRequest(message))
        assertTrue("follows up" !in AssistantController.voiceMessage(HermesCall("c1", "Book a table.", ""), "2026-10-30"))
    }
}
