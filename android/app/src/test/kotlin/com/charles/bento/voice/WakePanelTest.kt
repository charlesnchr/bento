package com.charles.bento.voice

import com.charles.bento.assistant.AssistantUi
import com.charles.bento.assistant.CallUi
import com.charles.bento.assistant.TaskUi
import com.charles.bento.assistant.latestExchange
import com.charles.bento.core.assistant.ChatMessage
import kotlin.test.Test
import kotlin.test.assertEquals

class WakePanelTest {
    private fun said(text: String) = ChatMessage(text, "user", text, voice = true, call = true)
    private fun reply(text: String) = ChatMessage(text, "assistant", text, speaker = "Gemini", voice = true, call = true)
    private val listening = CallUi("Listening. Headphones work best.", connecting = false, hermesWorking = false, tapToTalk = false, muted = false)

    @Test fun nothingSaidYet() {
        assertEquals(null to null, AssistantUi().latestExchange())
    }

    @Test fun theCaptionWhileSpeakingHidesTheLastReply() {
        val s = AssistantUi(messages = listOf(said("What's on today?"), reply("Two meetings.")), caption = "And tomor")
        assertEquals("And tomor" to null, s.latestExchange())
    }

    @Test fun theLastWordsAndTheReplyToThem() {
        val s = AssistantUi(messages = listOf(said("Hi"), reply("Hello."), said(" What's on today? "), reply("Two meetings.")))
        assertEquals("What's on today?" to "Two meetings.", s.latestExchange())
    }

    @Test fun noReplyYetToTheLatestWords() {
        val s = AssistantUi(messages = listOf(said("Hi"), reply("Hello."), said("What's on today?")))
        assertEquals("What's on today?" to null, s.latestExchange())
    }

    @Test fun onlyTheCallsRowsCount() {
        val typed = ChatMessage("t", "user", "typed earlier")
        val hermes = ChatMessage("h", "assistant", "Hermes's reply in the chat")
        assertEquals("Hi" to null, AssistantUi(messages = listOf(typed, said("Hi"), hermes)).latestExchange())
    }

    @Test fun aTaskResultArrivingLateIsntTheReply() {
        // Hermes's result for the first question lands (call row, not spoken) after the second question
        val result = ChatMessage("r", "assistant", "Two meetings today.", call = true)
        val s = AssistantUi(messages = listOf(said("What's on today?"), reply("On it."), said("And tomorrow's weather?"), result))
        assertEquals("And tomorrow's weather?" to null, s.latestExchange())
    }

    @Test fun anEarlierCallsWordsDontCount() {
        val s = AssistantUi(messages = listOf(said("Hi"), reply("Hello."), said("Next call")))
        assertEquals("Next call" to null, s.latestExchange(after = "Hello."))
        assertEquals(null to null, AssistantUi(messages = listOf(said("Hi"), reply("Hello."))).latestExchange(after = "Hello."))
    }

    @Test fun statusFollowsTheCall() {
        assertEquals("Listening…", panelStatus(AssistantUi(), null))
        assertEquals("Connecting…", panelStatus(AssistantUi(call = listening.copy(connecting = true)), null))
        assertEquals("Listening…", panelStatus(AssistantUi(call = listening), null))
        val working = listening.copy(hermesWorking = true, tasks = listOf(TaskUi("1", "look it up", progress = "Searching the web")))
        assertEquals("Hermes: Searching the web", panelStatus(AssistantUi(call = working), null))
        assertEquals("Hermes is working…", panelStatus(AssistantUi(call = listening.copy(hermesWorking = true)), null))
        assertEquals("The microphone hears nothing", panelStatus(AssistantUi(call = listening.copy(micSilent = true)), null))
        assertEquals("Call ended", panelStatus(AssistantUi(call = listening), Ended()))
        assertEquals("The call failed", panelStatus(AssistantUi(), Ended("Gemini rejected the API key.")))
    }
}
