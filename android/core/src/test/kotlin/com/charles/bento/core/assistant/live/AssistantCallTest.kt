package com.charles.bento.core.assistant.live

import com.charles.bento.core.voice.FakeTransport
import com.charles.bento.core.voice.Frames
import com.charles.bento.core.voice.blocking
import com.charles.bento.core.voice.json
import com.charles.bento.core.voice.live.LiveSocketEnding
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.io.IOException
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicLong
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** A microphone that delivers 20 ms frames until stopped, and a speaker that records. */
private class FakeAudio(private val delivers: Boolean = true, private val opens: Boolean = true) : CallAudio {
    val played = CopyOnWriteArrayList<ByteArray>()
    @Volatile var flushes = 0
    @Volatile var stopped = false
    @Volatile var started = false
    private var thread: Thread? = null

    override fun start(onPcm: (ByteArray) -> Unit): Boolean {
        if (!opens) return false
        started = true
        if (delivers) thread = Thread {
            while (!stopped) { onPcm(ByteArray(640)); Thread.sleep(20) }
        }.apply { isDaemon = true; start() }
        return true
    }

    override fun play(pcm: ByteArray) { played.add(pcm) }
    override fun flush() { flushes++ }
    override fun stop() { stopped = true }
}

private object Live {
    fun activity(type: String) = json("voiceActivity" to mapOf("type" to type))
    fun heard(text: String) = json("serverContent" to mapOf("inputTranscription" to mapOf("text" to text)))
    fun said(text: String) = json("serverContent" to mapOf("outputTranscription" to mapOf("text" to text)))
    fun call(id: String, name: String = CallProtocol.TOOL) = json("toolCall" to mapOf("functionCalls" to listOf(mapOf("id" to id, "name" to name, "args" to emptyMap<String, Any>()))))
    fun audio(bytes: ByteArray, mime: String = AssistantCall.OUTPUT_MIME) =
        json("serverContent" to mapOf("modelTurn" to mapOf("parts" to listOf(mapOf("inlineData" to mapOf("mimeType" to mime, "data" to Base64.getEncoder().encodeToString(bytes)))))))
    fun interrupted() = json("serverContent" to mapOf("interrupted" to true))
    fun resumable(handle: String) = json("sessionResumptionUpdate" to mapOf("newHandle" to handle, "resumable" to true))
    const val GO_AWAY = """{"goAway":{"timeLeft":"10s"}}"""
}

class AssistantCallTest {
    private val fast = AssistantCall.Limits(settleQuiet = 0.1, settleMax = 1.5, tickMillis = 50)

    private fun FakeTransport.responses(): List<JsonObject> = sent.filter { "toolResponse" in it }.map {
        Json.parseToJsonElement(it).jsonObject["toolResponse"]!!.jsonObject["functionResponses"]!!.jsonArray.single().jsonObject
    }

    private suspend fun FakeTransport.awaitSent(timeout: Long = 5_000, check: (List<String>) -> Boolean) {
        withTimeout(timeout) { while (!check(sent)) delay(20) }
    }

    private suspend fun AssistantCall.ended(): AssistantCall.Status.Ended =
        withTimeout(5_000) { status.first { it is AssistantCall.Status.Ended } as AssistantCall.Status.Ended }

    @Test fun setupFirstThenTheMicrophone() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete()))
        val audio = FakeAudio()
        val call = AssistantCall(transport, audio, null, { "" }, limits = fast)
        call.start()
        withTimeout(5_000) { call.status.first { it == AssistantCall.Status.Listening } }
        transport.awaitSent { s -> s.count { "realtimeInput" in it } >= 3 }
        assertEquals("setup", transport.sentKinds.first())
        val setup = Json.parseToJsonElement(transport.sent.first()).jsonObject["setup"]!!.jsonObject
        assertEquals("models/gemini-3.8-live", setup["model"]!!.jsonPrimitive.content)
        assertTrue(transport.sent.none { "clientContent" in it }, "a new call sends no recap")
        assertTrue(transport.sent.drop(1).first().contains("audio/pcm;rate=16000"))
        call.stop()
        assertNull(call.ended().message)
        assertTrue(audio.stopped)
        assertEquals(1, transport.closeCount)
    }

    @Test fun aResumedCallSendsItsRecapBeforeAnyAudio() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete()))
        val resume = CallSetup.resume("User: hello\nHermes: hi")!!
        val call = AssistantCall(transport, FakeAudio(), resume, { "" }, limits = fast)
        call.start()
        transport.awaitSent { s -> s.any { "realtimeInput" in it } }
        assertTrue(transport.sent[0].contains(CallSetup.RESUME_INSTRUCTION), "the instruction carries the resume line")
        assertTrue(transport.sent[1].contains("clientContent"))
        assertTrue(transport.sent[1].contains("<earlier_conversation>"))
        call.stop()
    }

    @Test fun aSpokenRequestGoesToHermesAndTheResultBack() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete()))
        val asked = CompletableDeferred<HermesCall>()
        val call = AssistantCall(transport, FakeAudio(), null, { c -> asked.complete(c); "It's sunny in London." }, limits = fast)
        val heard = CopyOnWriteArrayList<Pair<String, String>>()
        call.onTranscript = { r, t -> heard.add(r to t) }
        call.start()
        transport.awaitSent { s -> s.any { "realtimeInput" in it } }
        transport.push(Live.said("Hi, how can I help?"))
        delay(50)
        transport.push(Live.activity("ACTIVITY_START"))
        transport.push(Live.heard("What's the weather"))
        transport.push(Live.heard(" in London?"))
        transport.push(Live.activity("ACTIVITY_END"))
        transport.push(Live.call("c1"))
        val request = withTimeout(5_000) { asked.await() }
        assertEquals("What's the weather in London?", request.task)
        assertEquals("assistant: Hi, how can I help?", request.context)
        transport.awaitSent { s -> s.any { "toolResponse" in it } }
        val response = transport.responses().single()
        assertEquals("c1", response["id"]!!.jsonPrimitive.content)
        assertEquals("WHEN_IDLE", response["scheduling"]!!.jsonPrimitive.content)
        assertEquals("ok", response["response"]!!.jsonObject["status"]!!.jsonPrimitive.content)
        assertEquals("It's sunny in London.", response["response"]!!.jsonObject["message"]!!.jsonPrimitive.content)
        assertTrue(("user" to "What's the weather") in heard)
        assertTrue(("assistant" to "Hi, how can I help?") in heard)
        call.stop()
    }

    @Test fun aCallWithoutWordsRunsNothing() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete()))
        var ran = false
        val call = AssistantCall(transport, FakeAudio(), null, { ran = true; "" }, limits = fast)
        call.start()
        transport.awaitSent { s -> s.any { "realtimeInput" in it } }
        transport.push(Live.call("c1"))
        transport.awaitSent { s -> s.any { "toolResponse" in it } }
        assertFalse(ran)
        assertEquals("not_executed", transport.responses().single()["response"]!!.jsonObject["status"]!!.jsonPrimitive.content)
        call.stop()
    }

    @Test fun unknownToolsAndRepeatsAreAnsweredNotRun() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete()))
        val gate = CompletableDeferred<String>()
        var runs = 0
        val call = AssistantCall(transport, FakeAudio(), null, { runs++; gate.await() }, limits = fast)
        call.start()
        transport.awaitSent { s -> s.any { "realtimeInput" in it } }
        transport.push(Live.call("x1", name = "open_door"))
        transport.push(Live.activity("ACTIVITY_START"))
        transport.push(Live.heard("Book a table"))
        transport.push(Live.activity("ACTIVITY_END"))
        transport.push(Live.call("c1"))
        withTimeout(5_000) { call.status.first { it == AssistantCall.Status.Working } }
        transport.push(Live.activity("ACTIVITY_START"))
        transport.push(Live.heard("And a taxi"))
        transport.push(Live.activity("ACTIVITY_END"))
        transport.push(Live.call("c2"))
        transport.push(Live.call("c1")) // a repeated id is ignored outright
        transport.awaitSent { s -> s.count { "toolResponse" in it } >= 2 }
        val early = transport.responses()
        assertEquals("open_door", early[0]["name"]!!.jsonPrimitive.content)
        assertTrue(early[1]["response"]!!.jsonObject["message"]!!.jsonPrimitive.content.contains("still working on an earlier request"))
        gate.complete("Booked.")
        transport.awaitSent { s -> s.count { "toolResponse" in it } >= 3 }
        assertEquals(1, runs)
        assertEquals("c1", transport.responses()[2]["id"]!!.jsonPrimitive.content)
        withTimeout(5_000) { call.status.first { it == AssistantCall.Status.Listening } }
        call.stop()
    }

    @Test fun aCancelledCallIsNotAnswered() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete()))
        val gate = CompletableDeferred<String>()
        val call = AssistantCall(transport, FakeAudio(), null, { gate.await() }, limits = fast)
        call.start()
        transport.awaitSent { s -> s.any { "realtimeInput" in it } }
        transport.push(Live.activity("ACTIVITY_START"))
        transport.push(Live.heard("Email Sam"))
        transport.push(Live.activity("ACTIVITY_END"))
        transport.push(Live.call("c1"))
        withTimeout(5_000) { call.status.first { it == AssistantCall.Status.Working } }
        transport.push(json("toolCallCancellation" to mapOf("ids" to listOf("c1"))))
        delay(100)
        gate.complete("Sent.")
        withTimeout(5_000) { call.status.first { it == AssistantCall.Status.Listening } }
        assertTrue(transport.responses().isEmpty())
        call.stop()
    }

    @Test fun playbackAndInterruption() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete()))
        val audio = FakeAudio()
        val call = AssistantCall(transport, audio, null, { "" }, limits = fast)
        call.start()
        transport.awaitSent { s -> s.any { "realtimeInput" in it } }
        transport.push(Live.audio(ByteArray(480) { 1 }))
        transport.push(Live.interrupted())
        withTimeout(5_000) { while (audio.flushes == 0) delay(10) }
        assertEquals(480, audio.played.single().size)
        transport.push(Live.audio(ByteArray(10), mime = "audio/pcm;rate=16000"))
        assertEquals("Gemini sent audio Bento can't play. Start a new call.", call.ended().message)
    }

    @Test fun mutingPausesTheStream() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete()))
        val call = AssistantCall(transport, FakeAudio(), null, { "" }, limits = fast)
        call.start()
        transport.awaitSent { s -> s.any { "realtimeInput" in it } }
        call.muted = true
        transport.awaitSent { s -> s.any { "audioStreamEnd" in it } }
        delay(100)
        val count = transport.sent.size
        delay(200)
        assertEquals(count, transport.sent.size, "nothing is sent while muted")
        call.muted = false
        transport.awaitSent { s -> s.size > count }
        assertEquals(1, transport.sent.count { "audioStreamEnd" in it })
        assertIs<AssistantCall.Status>(call.status.value)
        call.stop()
    }

    @Test fun aSilentMicrophoneEndsTheCall() = blocking {
        val call = AssistantCall(FakeTransport(listOf(Frames.setupComplete())), FakeAudio(delivers = false), null, { "" },
                                 limits = fast.copy(capture = 0.3))
        call.start()
        assertEquals("The microphone stopped delivering audio. The call ended.", call.ended().message)
    }

    @Test fun aMicrophoneThatWontOpen() = blocking {
        val call = AssistantCall(FakeTransport(listOf(Frames.setupComplete())), FakeAudio(opens = false), null, { "" }, limits = fast)
        call.start()
        assertEquals("Couldn't open the microphone.", call.ended().message)
    }

    @Test fun noAnswerTimesOut() = blocking {
        val transport = FakeTransport(emptyList()).apply { receiveHangs = true }
        val call = AssistantCall(transport, FakeAudio(), null, { "" }, limits = fast.copy(connect = 0.3))
        call.start()
        assertEquals("Gemini didn't answer. The call timed out.", call.ended().message)
    }

    @Test fun anErrorFrameEndsTheCall() = blocking {
        val call = AssistantCall(FakeTransport(listOf(Frames.error("quota"))), FakeAudio(), null, { "" }, limits = fast)
        call.start()
        assertEquals("Gemini voice failed: quota. No task was retried.", call.ended().message)
    }

    @Test fun aDroppedSocketSaysHowItEnded() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete()))
        val call = AssistantCall(transport, FakeAudio(), null, { "" }, ending = { LiveSocketEnding(closeCode = 1007, closeReason = "API key not valid") }, limits = fast)
        call.start()
        transport.awaitSent { s -> s.any { "realtimeInput" in it } }
        transport.close()
        assertEquals("Gemini rejected the API key. Check it in Settings → Dictation.", call.ended().message)
    }

    @Test fun aCallHasNoTimeLimit() = blocking {
        val hours = AtomicLong(0)
        val transport = FakeTransport(listOf(Frames.setupComplete()))
        val call = AssistantCall(transport, FakeAudio(), null, { "" }, limits = fast, clock = { System.nanoTime() / 1e9 + hours.get() * 3600 })
        call.start()
        withTimeout(5_000) { call.status.first { it == AssistantCall.Status.Listening } }
        hours.set(3)
        delay(300) // several watchdog ticks
        assertEquals(AssistantCall.Status.Listening, call.status.value)
        call.stop()
        assertNull(call.ended().message)
    }

    @Test fun goAwayMovesTheCallToANewSocketThatResumesTheSession() = blocking {
        val first = FakeTransport(listOf(Frames.setupComplete(), Live.resumable("h1")))
        val second = FakeTransport(listOf(Frames.setupComplete()))
        val asked = CompletableDeferred<HermesCall>()
        val call = AssistantCall(first, FakeAudio(), CallSetup.resume("User: hi"), { c -> asked.complete(c); "Done." },
                                 limits = fast, reconnect = { second })
        call.start()
        first.awaitSent { s -> s.any { "realtimeInput" in it } }
        assertEquals(JsonObject(emptyMap()), Json.parseToJsonElement(first.sent.first()).jsonObject["setup"]!!.jsonObject["sessionResumption"])
        first.push(Live.GO_AWAY)
        second.awaitSent { s -> s.any { "realtimeInput" in it } }
        val setup = Json.parseToJsonElement(second.sent.first()).jsonObject["setup"]!!.jsonObject
        assertEquals("h1", setup["sessionResumption"]!!.jsonObject["handle"]!!.jsonPrimitive.content)
        assertTrue(second.sent.none { "clientContent" in it }, "the resumed session already has the recap")
        assertEquals(1, first.closeCount)
        assertEquals(AssistantCall.Status.Listening, call.status.value)
        // The conversation carries on over the new socket.
        second.push(Live.activity("ACTIVITY_START"))
        second.push(Live.heard("Turn on the lights"))
        second.push(Live.activity("ACTIVITY_END"))
        second.push(Live.call("c1"))
        assertEquals("Turn on the lights", withTimeout(5_000) { asked.await() }.task)
        second.awaitSent { s -> s.any { "toolResponse" in it } }
        assertTrue(first.sent.none { "toolResponse" in it })
        call.stop()
        assertNull(call.ended().message)
        assertEquals(1, second.closeCount)
    }

    @Test fun anOldSocketThatClosesEarlyDropsAudioWithoutEndingTheCall() = blocking {
        val first = FakeTransport(listOf(Frames.setupComplete(), Live.resumable("h1")))
        val second = FakeTransport(emptyList())
        val call = AssistantCall(first, FakeAudio(), null, { "" }, limits = fast, reconnect = { second })
        call.start()
        first.awaitSent { s -> s.any { "realtimeInput" in it } }
        first.push(Live.GO_AWAY)
        second.awaitSent { s -> s.any { "setup" in it } } // the move has begun
        first.sendErrorAfter = first.sent.size
        delay(800) // far more audio than the microphone buffer holds
        assertEquals(AssistantCall.Status.Listening, call.status.value)
        second.push(Frames.setupComplete())
        second.awaitSent { s -> s.any { "realtimeInput" in it } }
        assertEquals(AssistantCall.Status.Listening, call.status.value)
        call.stop()
        assertNull(call.ended().message)
    }

    @Test fun goAwayWithoutAHandleStillEndsAtTheLimit() = blocking {
        val first = FakeTransport(listOf(Frames.setupComplete(), json("sessionResumptionUpdate" to mapOf("resumable" to false))))
        var made = 0
        val call = AssistantCall(first, FakeAudio(), null, { "" }, limits = fast, reconnect = { made++; FakeTransport(emptyList()) })
        call.start()
        first.awaitSent { s -> s.any { "realtimeInput" in it } }
        first.push(Live.GO_AWAY)
        delay(100)
        first.close()
        assertEquals("Gemini ended the call at its time limit. Start again to continue.", call.ended().message)
        assertEquals(0, made)
    }

    @Test fun aFailedReconnectEndsTheCall() = blocking {
        val first = FakeTransport(listOf(Frames.setupComplete(), Live.resumable("h1")))
        val second = FakeTransport(emptyList()).apply { connectError = IOException("offline") }
        val call = AssistantCall(first, FakeAudio(), null, { "" }, limits = fast, reconnect = { second })
        call.start()
        first.awaitSent { s -> s.any { "realtimeInput" in it } }
        first.push(Live.GO_AWAY)
        assertEquals("Gemini voice couldn't reconnect. Start again to continue.", call.ended().message)
        assertEquals(1, second.closeCount)
    }

    /** A request Hermes is still working on, asked on [first], with standby after 0.3 s. */
    private suspend fun waitingOnHermes(first: FakeTransport, next: () -> FakeTransport, result: CompletableDeferred<String>,
                                        standbyAfter: Double = 0.3): AssistantCall {
        val call = AssistantCall(first, FakeAudio(), null, { result.await() }, limits = fast, reconnect = next,
                                 standbyAfter = { standbyAfter }, recap = { CallSetup.resume("User: what's on my calendar?") })
        call.start()
        first.awaitSent { s -> s.any { "realtimeInput" in it } }
        first.push(Live.activity("ACTIVITY_START"))
        first.push(Live.heard("What's on my calendar?"))
        first.push(Live.activity("ACTIVITY_END"))
        first.push(Live.call("c1"))
        withTimeout(5_000) { call.status.first { it == AssistantCall.Status.Working } }
        return call
    }

    private fun FakeTransport.turns(): List<JsonObject> = sent.filter { "clientContent" in it }.map { Json.parseToJsonElement(it).jsonObject["clientContent"]!!.jsonObject }

    @Test fun silenceWhileHermesWorksLeavesGeminiAndItsAnswerBringsTheCallBack() = blocking {
        val first = FakeTransport(listOf(Frames.setupComplete()))
        val second = FakeTransport(listOf(Frames.setupComplete()))
        val result = CompletableDeferred<String>()
        var made = 0
        val call = waitingOnHermes(first, { made++; second }, result)
        withTimeout(5_000) { call.status.first { it == AssistantCall.Status.Standby } }
        assertEquals(1, first.closeCount)
        assertEquals(0, made, "standby makes no new socket until it's needed")
        val sentBefore = first.sent.size
        delay(300)
        assertEquals(sentBefore, first.sent.size, "nothing goes to the closed socket, the microphone included")
        result.complete("You have a dentist appointment at 3pm.")
        second.awaitSent { s -> s.any { "turnComplete\":true" in it } }
        assertEquals(1, made)
        // A new session with the conversation so far, then the answer as a turn for Gemini to speak.
        assertTrue(second.sent[0].contains(CallSetup.RESUME_INSTRUCTION))
        val turns = second.turns()
        assertEquals(2, turns.size)
        assertTrue(turns[0].toString().contains("<earlier_conversation>"))
        assertEquals("false", turns[0]["turnComplete"]!!.jsonPrimitive.content)
        assertEquals(CallSetup.resultText("You have a dentist appointment at 3pm."),
                     turns[1]["turns"]!!.jsonArray[0].jsonObject["parts"]!!.jsonArray[0].jsonObject["text"]!!.jsonPrimitive.content)
        assertTrue(first.responses().isEmpty() && second.responses().isEmpty(), "the old session's call went with it")
        withTimeout(5_000) { call.status.first { it == AssistantCall.Status.Listening } }
        second.awaitSent { s -> s.any { "realtimeInput" in it } }
        call.stop()
        assertNull(call.ended().message)
    }

    @Test fun talkingFirstBringsTheCallBackAndTheAnswerFollowsAsATurn() = blocking {
        val first = FakeTransport(listOf(Frames.setupComplete()))
        val second = FakeTransport(listOf(Frames.setupComplete()))
        val result = CompletableDeferred<String>()
        val call = waitingOnHermes(first, { second }, result, standbyAfter = 0.3)
        withTimeout(5_000) { call.status.first { it == AssistantCall.Status.Standby } }
        call.wake()
        withTimeout(5_000) { call.status.first { it == AssistantCall.Status.Working } }
        second.awaitSent { s -> s.any { "realtimeInput" in it } }
        assertEquals(1, second.turns().size, "only the recap: Hermes hasn't answered")
        result.complete("Done.")
        second.awaitSent { s -> s.any { "turnComplete\":true" in it } }
        assertTrue(second.responses().isEmpty())
        withTimeout(5_000) { call.status.first { it == AssistantCall.Status.Listening } }
        call.stop()
    }

    @Test fun speechKeepsTheCallOnGemini() = blocking {
        val first = FakeTransport(listOf(Frames.setupComplete()))
        val result = CompletableDeferred<String>()
        var made = 0
        val call = waitingOnHermes(first, { made++; FakeTransport(emptyList()) }, result, standbyAfter = 0.5)
        // Gemini says Hermes is working: 0.4 s of audio, then the user keeps talking.
        first.push(Live.audio(ByteArray(19_200)))
        repeat(4) { delay(200); first.push(Live.heard("and")) }
        assertEquals(AssistantCall.Status.Working, call.status.value)
        assertEquals(0, first.closeCount)
        result.complete("Done.")
        first.awaitSent { s -> s.any { "toolResponse" in it } }
        assertEquals("Done.", first.responses().single()["response"]!!.jsonObject["message"]!!.jsonPrimitive.content)
        assertEquals(0, made)
        call.stop()
    }

    @Test fun neverMeansNoStandby() = blocking {
        val first = FakeTransport(listOf(Frames.setupComplete()))
        val result = CompletableDeferred<String>()
        val call = waitingOnHermes(first, { FakeTransport(emptyList()) }, result, standbyAfter = 0.0)
        delay(600)
        assertEquals(AssistantCall.Status.Working, call.status.value)
        assertEquals(0, first.closeCount)
        call.stop()
    }

    @Test fun aFailedComebackEndsTheCall() = blocking {
        val first = FakeTransport(listOf(Frames.setupComplete()))
        val second = FakeTransport(emptyList()).apply { connectError = IOException("offline") }
        val result = CompletableDeferred<String>()
        val call = waitingOnHermes(first, { second }, result)
        withTimeout(5_000) { call.status.first { it == AssistantCall.Status.Standby } }
        result.complete("Done.")
        assertEquals(AssistantCall.RECONNECT_FAILED, call.ended().message)
        assertEquals(1, second.closeCount)
    }

    @Test fun aComebackGeminiNeverSetsUpTimesOut() = blocking {
        val first = FakeTransport(listOf(Frames.setupComplete()))
        val second = FakeTransport(emptyList())
        val call = AssistantCall(first, FakeAudio(), null, { CompletableDeferred<String>().await() }, limits = fast.copy(connect = 1.0),
                                 reconnect = { second }, standbyAfter = { 0.3 })
        call.start()
        first.awaitSent { s -> s.any { "realtimeInput" in it } }
        first.push(Live.activity("ACTIVITY_START")); first.push(Live.heard("Book it")); first.push(Live.activity("ACTIVITY_END"))
        first.push(Live.call("c1"))
        withTimeout(5_000) { call.status.first { it == AssistantCall.Status.Standby } }
        call.wake()
        assertEquals(AssistantCall.RECONNECT_FAILED, call.ended().message)
    }

    @Test fun endings() {
        assertEquals("Gemini ended the call at its time limit. Start again to continue.", AssistantCall.endingMessage(LiveSocketEnding(), goingAway = true))
        assertEquals("Gemini rejected the API key. Check it in Settings → Dictation.", AssistantCall.endingMessage(LiveSocketEnding(httpStatus = 403), false))
        assertEquals("Gemini voice disconnected. No task was retried.", AssistantCall.endingMessage(LiveSocketEnding(closeCode = 1000), false))
        assertEquals("Gemini voice failed (HTTP 500, close 1011). No task was retried.", AssistantCall.endingMessage(LiveSocketEnding(500, 1011), false))
    }
}

/** The phone's setup is the Mac's helper setup, word for word where the platforms agree. */
class CallSetupTest {
    private val helper = File("../../helper")

    @Test fun theSetupMatchesTheHelpers() {
        val mac = Json.parseToJsonElement(File(helper, "gemini_live_setup.json").readText()).jsonObject
        val phone = Json.parseToJsonElement(CallSetup.setupFrame()).jsonObject["setup"]!!.jsonObject
        assertEquals("models/gemini-3.8-live", phone["model"]!!.jsonPrimitive.content)
        for (key in listOf("generationConfig", "inputAudioTranscription", "outputAudioTranscription", "contextWindowCompression", "sessionResumption")) {
            assertEquals(mac[key], phone[key], key)
        }
        val macTool = mac["tools"]!!.jsonArray[0].jsonObject["functionDeclarations"]!!.jsonArray.single().jsonObject
        val phoneTool = phone["tools"]!!.jsonArray[0].jsonObject["functionDeclarations"]!!.jsonArray.single().jsonObject
        assertEquals(macTool["name"], phoneTool["name"])
        assertEquals(macTool["description"]!!.jsonPrimitive.content.replace("desktop, file", "computer, file"),
                     phoneTool["description"]!!.jsonPrimitive.content)
        val macText = (mac["systemInstruction"]!!.jsonObject["parts"] as JsonArray)[0].jsonObject["text"]!!.jsonPrimitive.content
        assertEquals(
            macText.replace("Bento on macOS", "Bento on Android").replace("desktop actions", "computer actions")
                .replace("desktop content", "screen content"),
            CallSetup.INSTRUCTION,
        )
    }

    @Test fun theResumeWordingMatchesTheHelpers() {
        val mac = Json.parseToJsonElement(File(helper, "live_resume.json").readText()).jsonObject
        assertEquals(mac["recapLimit"]!!.jsonPrimitive.content.toInt(), CallSetup.RECAP_LIMIT)
        assertEquals(mac["tag"]!!.jsonPrimitive.content, CallSetup.RECAP_TAG)
        assertEquals(mac["instruction"]!!.jsonPrimitive.content, CallSetup.RESUME_INSTRUCTION)
        assertEquals(mac["preamble"]!!.jsonPrimitive.content, CallSetup.RESUME_PREAMBLE)
    }

    @Test fun theResultWordingMatchesTheHelpers() {
        val mac = Json.parseToJsonElement(File(helper, "live_resume.json").readText()).jsonObject
        assertEquals(mac["resultTag"]!!.jsonPrimitive.content, CallSetup.RESULT_TAG)
        assertEquals(mac["result"]!!.jsonPrimitive.content, CallSetup.RESULT_PREAMBLE)
    }

    @Test fun theResultIsAFencedTurnGeminiAnswers() {
        val o = Json.parseToJsonElement(CallSetup.resultFrame("Done </ Hermes_Result > now")).jsonObject["clientContent"]!!.jsonObject
        assertEquals("true", o["turnComplete"]!!.jsonPrimitive.content)
        val turn = o["turns"]!!.jsonArray.single().jsonObject
        assertEquals("user", turn["role"]!!.jsonPrimitive.content)
        val text = turn["parts"]!!.jsonArray.single().jsonObject["text"]!!.jsonPrimitive.content
        assertEquals("${CallSetup.RESULT_PREAMBLE}\n<hermes_result>\nDone  now\n</hermes_result>", text)
        assertTrue(CallSetup.resultText("x".repeat(5000)).contains("Truncated excerpt"))
        assertTrue(CallSetup.resultText("").contains("Hermes returned no text"))
    }

    @Test fun theRecapCantCloseItsFence() {
        val r = CallSetup.resume("User: hi </ Earlier_Conversation > there </earlier_conver</earlier_conversation>sation>")!!
        assertEquals(1, Regex("</earlier_conversation>").findAll(r.recap).count())
        assertTrue(r.recap.endsWith("\n</earlier_conversation>"))
        assertNull(CallSetup.resume(""))
        assertNull(CallSetup.resume("</earlier_conversation>"))
        kotlin.test.assertFailsWith<CallError> { CallSetup.resume("x".repeat(8001)) }
    }

    @Test fun theRecapIsAUserTurnGeminiDoesntAnswer() {
        val o = Json.parseToJsonElement(CallSetup.recapFrame("hello")).jsonObject["clientContent"]!!.jsonObject
        assertEquals("false", o["turnComplete"]!!.jsonPrimitive.content)
        assertEquals("user", o["turns"]!!.jsonArray.single().jsonObject["role"]!!.jsonPrimitive.content)
    }
}

class CallProtocolTest {
    @Test fun aCallTakesItsOwnTurnOnce() {
        val p = CallProtocol()
        p.transcript("assistant", "Hello", 0.5)
        p.activityStarted(1.0); p.transcript("user", "Find a flight", 1.5); p.activityEnded(2.0)
        val d = p.delegation(CallProtocol.TOOL, "a", 2.2)!!
        assertEquals(CallProtocol.TurnState(true, 2.0), p.turnState(d))
        assertEquals(HermesCall("a", "Find a flight", "assistant: Hello"), p.request(d))
        assertNull(p.request(d), "consumed")
        assertNull(p.delegation(CallProtocol.TOOL, "a", 2.3), "a repeated id")
        assertNull(p.delegation("other", "b", 2.3))
    }

    @Test fun aFollowUpStillOpenPointsBackAtTheTurnJustAnswered() {
        val p = CallProtocol()
        p.activityStarted(1.0); p.transcript("user", "Weather?", 1.2); p.activityEnded(2.0)
        p.activityStarted(2.5) // the user keeps talking
        val d = p.delegation(CallProtocol.TOOL, "a", 3.0)!!
        assertEquals("Weather?", p.request(d)!!.task)
    }

    @Test fun anAmbiguousCallRunsNothing() {
        val p = CallProtocol()
        p.activityStarted(1.0); p.transcript("user", "Weather?", 1.2); p.activityEnded(2.0)
        p.activityStarted(5.0)
        val d = p.delegation(CallProtocol.TOOL, "a", 6.0)!!
        assertNull(d.turn)
        assertNull(p.request(d))
    }

    @Test fun staleSpeechIsNotARequest() {
        val p = CallProtocol()
        p.activityStarted(1.0); p.transcript("user", "Something", 1.2); p.activityEnded(2.0)
        assertNull(p.request(p.delegation(CallProtocol.TOOL, "a", 20.0)!!))
    }

    @Test fun theModelGetsTheWholeReply() {
        assertEquals("Hermes returned no text. Do not infer success.", CallProtocol.fullResult(""))
        val long = "word ".repeat(8000)
        assertEquals(long, CallProtocol.fullResult(long))
        assertEquals("x".repeat(64_000), CallProtocol.fullResult("x".repeat(64_000)))
        val marker = " [Bento cut Hermes's reply here at 64000 characters.]"
        assertEquals("x".repeat(64_000) + marker, CallProtocol.fullResult("x".repeat(70_000)))
        assertEquals("x".repeat(63_999) + marker, CallProtocol.fullResult("x".repeat(63_999) + "😀".repeat(10)))
    }
}
