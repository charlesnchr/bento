package com.charles.bento.core.assistant.live

import com.charles.bento.core.voice.blocking
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The phone's host for a typed chat on the shared voice core, against a scripted text model: the
 * bundle the app ships runs the chat, and the host makes its requests and runs its tasks. What the
 * core decides is tested in voice-core/ (test/chat.test.ts) and held to its scenarios by
 * [com.charles.bento.core.voicecore.VoiceCoreConformanceTest]; this is the wiring.
 */
class CoreChatTest {
    private val source = File(System.getProperty("voiceCore.dir") ?: "../../voice-core").resolve("dist/voice-core.js").readText()

    /** A text model that answers each request with the next of [answers] (each a list of stream chunks, or an error). */
    private class Scripted(vararg answers: Any) : ChatModel {
        private val left = ArrayDeque(answers.toList())
        val bodies = CopyOnWriteArrayList<JsonObject>()
        val models = CopyOnWriteArrayList<String>()
        /** Held until completed: a request that is still under way. */
        @Volatile var gate: CompletableDeferred<Unit>? = null
        @Volatile var cancelled = 0

        override fun generate(model: String, body: String): Flow<String> = flow {
            models.add(model)
            bodies.add(Json.parseToJsonElement(body).jsonObject)
            val answer = synchronized(left) { left.removeFirstOrNull() } ?: error("the chat asked the model more than the script answers")
            try {
                gate?.await()
            } catch (e: CancellationException) {
                cancelled++
                throw e
            }
            if (answer is Exception) throw answer
            @Suppress("UNCHECKED_CAST")
            for (chunk in answer as List<String>) emit(chunk)
        }

        fun contents(request: Int) = bodies[request]["contents"]!!.jsonArray.map { it.jsonObject }
        fun texts(request: Int) = contents(request).map { c ->
            c["parts"]!!.jsonArray.joinToString("|") { p ->
                val part = p.jsonObject
                part["text"]?.jsonPrimitive?.content ?: part["functionCall"]?.let { "call:" + it.jsonObject["name"]!!.jsonPrimitive.content }
                    ?: ("response:" + part["functionResponse"]!!.jsonObject["name"]!!.jsonPrimitive.content)
            }
        }
    }

    private fun words(vararg pieces: String) = pieces.map { """{"candidates":[{"content":{"role":"model","parts":[{"text":${Json.encodeToString(it)}}]}}]}""" }
    private fun calls(name: String, args: String = "{}") =
        listOf("""{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"$name","args":$args,"id":"call_1"},"thoughtSignature":"sig"}]},"finishReason":"STOP"}]}""")

    private class Heard {
        val lines = LinkedHashMap<Int, String>()
        val errors = CopyOnWriteArrayList<String>()
        @Synchronized fun word(line: Int, text: String) { lines[line] = (lines[line] ?: "") + text }
        @Synchronized fun said() = lines.values.toList()
    }

    private fun chat(model: ChatModel, heard: Heard = Heard(), history: List<CoreCall.Line> = emptyList(), onTool: suspend (HermesCall) -> ToolReply = { ToolReply("") }) =
        CoreChat(source, CoreChat.config(history, "2026-11-22"), model, onTool, tickMillis = 20).also {
            it.onWords = heard::word
            it.onError = { message -> heard.errors.add(message) }
        }

    private suspend fun until(what: String, seconds: Long = 5, check: () -> Boolean) {
        try {
            withTimeout(seconds * 1000) { while (!check()) delay(10) }
        } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
            throw AssertionError("timed out waiting for $what")
        }
    }

    @Test fun aMessageGoesToTheTextModelAndItsAnswerComesBackInPieces() = blocking {
        val model = Scripted(words("Sunlight scatters", " off the air."))
        val heard = Heard()
        val c = chat(model, heard)
        c.start()
        c.say("Why is the sky blue?")
        until("the answer") { heard.said() == listOf("Sunlight scatters off the air.") }
        until("the turn's end") { !c.thinking.value }
        assertEquals("models/gemini-3.8-flash", model.models.single())
        val body = model.bodies.single()
        assertTrue(body["systemInstruction"].toString().contains("You are the main thread of the user's assistant in Bento on Android"))
        assertEquals(listOf("Why is the sky blue?"), model.texts(0))
        assertEquals(12, c.version!!.length)
        assertNull(c.ended.value)
        c.stop()
        assertEquals("", c.ended.first { it != null })
    }

    @Test fun aRequestBecomesAHermesTaskAndTheChatGoesOnWhileItRuns() = blocking {
        val model = Scripted(calls("ask_hermes", """{"label":"Copenhagen weather"}"""), words("144."), words("Yes, bring one."))
        val heard = Heard()
        val asked = CopyOnWriteArrayList<HermesCall>()
        val reply = CompletableDeferred<ToolReply>()
        val c = chat(model, heard) { call -> asked.add(call); reply.await() }
        c.start()
        c.say("What's the weather in Copenhagen tomorrow?")
        until("the task") { asked.size == 1 }
        val task = asked.single()
        assertEquals("What's the weather in Copenhagen tomorrow?", task.task)
        assertEquals("Copenhagen weather", task.label)
        assertEquals("1", task.taskId)
        assertFalse(task.followUp)
        assertTrue(task.message!!.startsWith("User's typed request from Bento's assistant on Android:\nWhat's the weather in Copenhagen tomorrow?\n"))
        until("the hand-off's end") { !c.thinking.value }
        // The hand-off took one request, and nothing waits for Hermes: the next message is answered at once.
        assertEquals(1, model.bodies.size)
        c.say("What's 12 squared?")
        until("the answer") { heard.said() == listOf("144.") }
        c.progress("1", "Using web_search")
        reply.complete(ToolReply("Sunny, 12 degrees."))
        delay(200)
        assertEquals(2, model.bodies.size)
        c.say("Should I bring a coat?")
        until("the second answer") { heard.said().last() == "Yes, bring one." }
        // The model has the hand-off, its answer and a note of Hermes's reply, in order.
        val texts = model.texts(2)
        assertEquals("call:ask_hermes", texts[1])
        assertEquals("response:ask_hermes", texts[2])
        assertEquals("What's 12 squared?", texts[3])
        assertEquals("144.", texts[4])
        assertTrue(texts[5].startsWith("<bento_note>\nFrom Bento, not the user's words: \"Copenhagen weather\" has finished"))
        assertTrue(texts[5].endsWith("Sunny, 12 degrees.\n</bento_note>"))
        assertEquals("Should I bring a coat?", texts[6])
        c.stop()
    }

    @Test fun aTaskThatAsksSomethingWaitsForTheAnswerAndGetsIt() = blocking {
        val model = Scripted(calls("ask_hermes", """{"label":"Noma table"}"""), calls("ask_hermes"))
        val asked = CopyOnWriteArrayList<HermesCall>()
        val c = chat(model) { call -> asked.add(call); ToolReply(if (call.followUp) "Booked." else "There's a table at eight. Shall I book it?") }
        c.start()
        c.say("Book a table at Noma")
        until("the question") { c.questions.value == mapOf("1" to "Shall I book it?") }
        c.say("Yes please")
        until("the follow-up") { asked.size == 2 }
        assertEquals("1", asked[1].taskId)
        assertTrue(asked[1].followUp)
        assertEquals("Yes please", asked[1].task)
        until("the question's end") { c.questions.value.isEmpty() }
        c.stop()
    }

    @Test fun aModelThatFailsIsSaidAndTheChatGoesOn() = blocking {
        val model = Scripted(ChatModelError("HTTP 503: overloaded", 503), words("Hello."))
        val heard = Heard()
        val c = chat(model, heard)
        c.start()
        c.say("Hello?")
        until("the error") { heard.errors.size == 1 }
        assertEquals("Gemini didn't answer: HTTP 503: overloaded. Nothing was started; send it again.", heard.errors.single())
        until("the turn's end") { !c.thinking.value }
        assertNull(c.ended.value)
        c.say("Hello again")
        until("the answer") { heard.said() == listOf("Hello.") }
        c.stop()
    }

    @Test fun stopDropsTheAnswerBeingWrittenAndCancelStopsATask() = blocking {
        val model = Scripted(calls("ask_hermes"), words("Never sent."))
        val running = CompletableDeferred<Unit>()
        val cancelled = CompletableDeferred<Unit>()
        val c = chat(model) {
            running.complete(Unit)
            try { delay(60_000) } catch (e: CancellationException) { cancelled.complete(Unit); throw e }
            ToolReply("")
        }
        c.start()
        c.say("Find a taxi")
        withTimeout(5000) { running.await() }
        c.cancelTask("1")
        withTimeout(5000) { cancelled.await() }
        // A request under way is dropped when the user presses stop.
        model.gate = CompletableDeferred()
        c.say("Tell me a story")
        until("the request") { model.bodies.size == 2 && c.thinking.value }
        c.interrupt()
        until("the dropped request") { model.cancelled == 1 && !c.thinking.value }
        c.stop()
        assertEquals("", c.ended.first { it != null })
    }

    @Test fun aChatContinuesTheConversationOnScreen() = blocking {
        val model = Scripted(words("Madrid."))
        val heard = Heard()
        val c = chat(model, heard, history = listOf(CoreCall.Line("user", "What's the capital of France?"), CoreCall.Line("assistant", "Paris.", "Gemini")))
        c.start()
        c.say("And of Spain?")
        until("the answer") { heard.said() == listOf("Madrid.") }
        assertTrue(model.texts(0)[0].contains("<earlier_conversation>\nUser: What's the capital of France?\nGemini: Paris.\n</earlier_conversation>"))
        c.stop()
    }

    @Test fun aBundleThatWontLoadEndsTheChatWithWhy() = blocking {
        val c = CoreChat("this is not JavaScript (", CoreChat.config(today = "2026-11-22"), Scripted(), { ToolReply("") })
        c.start()
        assertEquals(CoreChat.LOAD_FAILED, withTimeout(5000) { c.ended.first { it != null } })
    }
}
