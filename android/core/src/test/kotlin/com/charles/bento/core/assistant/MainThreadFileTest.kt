package com.charles.bento.core.assistant

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** The main thread's conversation as the phone keeps it between runs ([AssistantTranscript.encode]). */
class MainThreadFileTest {
    @Test fun whatWasSaidAndTheRepliesComeBackAsTheyWere() {
        val rows = listOf(
            ChatMessage("1", "user", "What's the weather in Copenhagen?", call = true),
            ChatMessage("2", "assistant", "Sunny, 12 degrees.", speaker = "Hermes · Copenhagen weather", link = "session-1", call = true),
            ChatMessage("3", "user", "Thanks", voice = true, call = true),
            ChatMessage("4", "assistant", "You're welcome.", speaker = "Gemini", voice = true, call = true),
            ChatMessage("5", "assistant", "Gemini didn't answer.", speaker = "Gemini", failed = true, call = true),
        )
        assertEquals(rows, AssistantTranscript.decode(AssistantTranscript.encode(rows)))
    }

    @Test fun aTurnsStepsAndAHalfWrittenAnswersStateAreLeftOut() {
        val rows = listOf(
            ChatMessage("1", "user", "Run it"),
            ChatMessage("2", "tool", "", toolName = "terminal", status = "running"),
            ChatMessage("3", "approval", "rm -rf", status = "pending", choices = listOf("once", "deny"), runId = "r1"),
            ChatMessage("4", "assistant", "Half an answ", speaker = "Gemini", streaming = true, thinking = "hm"),
            ChatMessage("5", "assistant", "   "),
        )
        assertEquals(listOf(ChatMessage("1", "user", "Run it"), ChatMessage("4", "assistant", "Half an answ", speaker = "Gemini")),
                     AssistantTranscript.decode(AssistantTranscript.encode(rows)))
    }

    @Test fun onlyTheLatestRowsAreKeptAndAFileThatIsntOneGivesNothing() {
        val rows = (1..250).map { ChatMessage("$it", "user", "message $it") }
        val kept = AssistantTranscript.decode(AssistantTranscript.encode(rows))
        assertEquals(200, kept.size)
        assertEquals("message 250", kept.last().text)
        assertTrue(AssistantTranscript.decode("not json").isEmpty())
        assertTrue(AssistantTranscript.decode("""{"id":"1"}""").isEmpty())
        assertEquals(1, AssistantTranscript.decode("""[{"role":"user","text":"kept"},{"role":"tool","text":"x"},{"role":"user"},7]""").size)
    }
}
