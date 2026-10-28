package com.charles.bento.core.assistant

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AssistantTranscriptTest {
    private fun ids(): () -> String { var n = 0; return { "m${n++}" } }

    private fun replay(events: List<HermesEvent>, start: List<ChatMessage> = emptyList()): Pair<List<ChatMessage>, TurnState> {
        var messages = start
        var turn = TurnState()
        val id = ids()
        for (e in events) {
            val (m, t) = AssistantTranscript.apply(messages, turn, e, id)
            messages = m; turn = t
        }
        return messages to turn
    }

    private fun recordedEvents(): List<HermesEvent> {
        val parser = SseParser()
        return javaClass.getResource("/assistant/chat-stream-tool.sse")!!.readText().lines()
            .mapNotNull { parser.line(it)?.let(HermesEvent::decode) }
    }

    @Test fun theRecordedTurnReadsInOrder() {
        val (messages, turn) = replay(recordedEvents())
        assertEquals(listOf("assistant", "tool", "assistant"), messages.map { it.role })
        assertEquals("Let me use a tool. ", messages[0].text, "commentary streamed before the tool stays its own row")
        assertEquals("tool_search", messages[1].toolName)
        assertEquals("failed", messages[1].status)
        assertTrue(messages[2].text.startsWith("Done: I used **the tool** for you."), "the final answer replaces the streamed text")
        assertTrue(messages.none { it.streaming })
        assertTrue(turn.finished)
        assertEquals("completed", turn.status)
        assertEquals("run_40358cf849ec4cb6a613f33c1525e962", turn.runId)
        assertTrue(turn.answer.startsWith("Done:"))
    }

    @Test fun deltasStreamIntoOneRow() {
        val (messages, turn) = replay(listOf(HermesEvent.Delta("Hel"), HermesEvent.Delta("lo")))
        assertEquals(listOf(ChatMessage("m0", "assistant", "Hello", streaming = true)), messages)
        assertEquals("Hello", turn.answer)
    }

    @Test fun anEmptyReplyBeforeAToolDisappears() {
        val (messages, _) = replay(listOf(HermesEvent.Delta(""), HermesEvent.ToolStarted("web_search", "news"), HermesEvent.ToolFinished("web_search", null, false)))
        assertEquals(listOf("tool"), messages.map { it.role })
        assertEquals("completed", messages[0].status)
        assertEquals("news", messages[0].toolDetail, "a finish without a preview keeps the start's")
    }

    @Test fun commentaryNotStreamedIsShown() {
        val (messages, _) = replay(listOf(HermesEvent.Commentary("Checking.", alreadyStreamed = false), HermesEvent.Commentary("dup", alreadyStreamed = true)))
        assertEquals(listOf("Checking."), messages.map { it.text })
    }

    @Test fun aStoppedTurnSaysSoAndSettlesItsTools() {
        val (messages, turn) = replay(listOf(HermesEvent.ToolStarted("terminal", "ls"), HermesEvent.Finished("cancelled", null, null)))
        assertEquals("failed", messages[0].status)
        assertEquals("Stopped.", messages[1].text)
        assertEquals("notice", messages[1].role)
        assertTrue(turn.finished)
    }

    @Test fun aFailedTurnWithoutAnAnswerExplains() {
        val (messages, _) = replay(listOf(HermesEvent.Finished("failed", null, "budget_exhausted")))
        assertEquals("Hermes didn't finish (budget_exhausted).", messages.single().text)
        assertTrue(messages.single().failed)
    }

    @Test fun anErrorEventIsAFailedRow() {
        val (messages, turn) = replay(listOf(HermesEvent.Failed("provider down"), HermesEvent.Done))
        assertTrue(messages.single().failed)
        assertEquals("failed", turn.status)
    }

    @Test fun approvalsLapseWhenTheTurnEnds() {
        val (messages, _) = replay(listOf(HermesEvent.Approval("r", "rm x", "Delete x", listOf("once", "deny")), HermesEvent.Done))
        assertEquals("approval", messages.single().role)
        assertEquals("expired", messages.single().status)
        assertEquals("r", messages.single().runId)
    }

    @Test fun aCompressedConversationsNewIdIsKept() {
        val (_, turn) = replay(listOf(HermesEvent.RunStarted("r", "s1"), HermesEvent.Finished("completed", "s2", null)))
        assertEquals("s2", turn.sessionId)
    }

    @Test fun eventsTouchOnlyTheirOwnTurn() {
        val earlier = listOf(ChatMessage("old", "tool", "", toolName = "web", status = "running"))
        val (messages, _) = replay(listOf(HermesEvent.ToolFinished("web", null, false), HermesEvent.Done), earlier)
        assertEquals("running", messages.single().status, "a previous turn's row is left alone")
    }

    @Test fun storedHistoryBecomesRows() {
        val json = HermesJson.parseToJsonElement(javaClass.getResource("/assistant/history.json")!!.readText()) as JsonObject
        val rows = (json["data"] as JsonArray).map { HermesMessage.parse(it as JsonObject)!! }
        val messages = AssistantTranscript.fromHistory(rows, ids())
        assertEquals(listOf("user", "assistant", "user", "assistant", "user", "assistant", "tool", "assistant"), messages.map { it.role })
        assertTrue(messages[1].failed, "Hermes's placeholder for a turn that didn't run")
        assertEquals("tool_search", messages[6].toolName)
        assertEquals("todo", messages[6].toolDetail, "one string argument stands for the call")
        assertEquals("failed", messages[6].status, "the tool's error result")
        assertTrue(messages[7].text.startsWith("Done:"))
    }

    @Test fun voiceRequestsShowWhatWasSaid() {
        val wrapped = "User's transcribed request from Bento's Gemini Live voice session on Android:\nWhat's on my calendar?\n" +
            "Interpret this spoken request and write your own precise tool queries."
        assertTrue(AssistantTranscript.isVoiceRequest(wrapped))
        assertEquals("What's on my calendar?", AssistantTranscript.displayRequest(wrapped))
        val mac = "User's transcribed request from Bento's Azure voice session:\nOpen Safari\nPerform only this request."
        assertEquals("Open Safari", AssistantTranscript.displayRequest(mac))
        assertFalse(AssistantTranscript.isVoiceRequest("Just typing"))
        val rows = AssistantTranscript.fromHistory(listOf(HermesMessage("user", wrapped)), ids())
        assertEquals(ChatMessage("m0", "user", "What's on my calendar?", voice = true), rows.single())
    }

    @Test fun theRecapIsWhatWasSaidNewestLast() {
        val messages = listOf(
            ChatMessage("1", "user", "Hello   there"),
            ChatMessage("2", "tool", "", toolName = "web"),
            ChatMessage("3", "assistant", "Hi!"),
            ChatMessage("4", "assistant", "Hermes is on it.", speaker = "Gemini", voice = true),
            ChatMessage("5", "assistant", "oops", failed = true),
        )
        assertEquals("User: Hello there\nHermes: Hi!\nGemini: Hermes is on it.", AssistantTranscript.liveRecap(messages))
        assertNull(AssistantTranscript.liveRecap(emptyList()))
        val long = (1..50).map { ChatMessage("$it", "user", "x".repeat(700)) }
        val recap = AssistantTranscript.liveRecap(long)!!
        assertTrue(recap.length <= 6000)
        assertTrue(recap.lines().all { it.length == "User: ".length + 603 })
    }

    @Test fun sessionLabels() {
        assertEquals("Trip plan", HermesSession("a", title = "Trip plan", preview = "x").label)
        assertEquals("Open Safari", HermesSession("a", preview = "User's transcribed request from Bento's Azure voice session:\nOpen Safari\nPerform only this request.").label)
        assertEquals("New conversation", HermesSession("a").label)
    }
}
