package com.charles.bento.core.assistant.live

import com.charles.bento.core.assistant.AssistantTranscript
import com.charles.bento.core.assistant.HermesClient
import com.charles.bento.core.assistant.HermesEndpoint
import com.charles.bento.core.assistant.HermesEvent
import com.charles.bento.core.assistant.TurnState
import com.charles.bento.core.voice.FakeTransport
import com.charles.bento.core.voice.Frames
import com.charles.bento.core.voice.blocking
import com.charles.bento.core.voice.live.LiveSocketEnding
import com.charles.bento.core.voice.live.LiveTransport
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockResponseBody
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import okio.BufferedSink
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The phone's host for the shared voice core, against a scripted Gemini socket: the bundle the app
 * ships (voice-core/dist/voice-core.js) runs the call, and the host carries its commands out on a
 * fake socket, microphone and speaker. What the core decides is tested in voice-core/ and held to
 * its scenarios by [com.charles.bento.core.voicecore.VoiceCoreConformanceTest]; this is the wiring.
 */
class CoreCallTest {
    private val source = File(System.getProperty("voiceCore.dir") ?: "../../voice-core").resolve("dist/voice-core.js").readText()
    private val fast = mapOf("settleQuiet" to 0.1, "settleMax" to 1.5, "tick" to 0.05)

    private class Captions : CallCaptions {
        @Volatile var fed = 0
        @Volatile var pauses = 0
        @Volatile var stopped = false
        @Volatile private var onCaption: ((Caption) -> Unit)? = null

        override fun start(onCaption: (Caption) -> Unit) { this.onCaption = onCaption }
        override fun feed(pcm: ByteArray) { fed++ }
        override fun pause() { pauses++ }
        override fun stop() { stopped = true }
        fun say(caption: Caption) = onCaption!!(caption)
    }

    private fun call(
        sockets: List<LiveTransport>,
        audio: CallAudio = FakeAudio(),
        onTool: suspend (HermesCall) -> ToolReply = { ToolReply("") },
        standbyAfter: Double = 0.0,
        hangUpAfter: Double = 0.0,
        history: List<CoreCall.Line> = emptyList(),
        captions: CallCaptions? = null,
        opening: (() -> ByteArray?)? = null,
        ending: (LiveTransport) -> LiveSocketEnding = { LiveSocketEnding() },
        toolScope: CoroutineScope? = null,
    ): CoreCall {
        val left = ArrayDeque(sockets)
        return CoreCall(
            source, CoreCall.config(history, "2026-11-22", standbyAfter, hangUpAfter, fast), { left.removeFirst() }, audio, onTool,
            ending = ending, captions = captions, opening = opening, tickMillis = 20, toolScope = toolScope,
        )
    }

    private suspend fun FakeTransport.awaitSent(timeout: Long = 5_000, check: (List<String>) -> Boolean) {
        withTimeout(timeout) { while (!check(sent)) delay(20) }
    }

    private suspend fun CoreCall.ended(): AssistantCall.Status.Ended =
        withTimeout(5_000) { status.first { it is AssistantCall.Status.Ended } as AssistantCall.Status.Ended }

    private suspend fun CoreCall.awaitStatus(wanted: AssistantCall.Status) = withTimeout(5_000) { status.first { it == wanted } }

    private suspend fun <T> List<T>.awaitSize(n: Int) = withTimeout(5_000) { while (size < n) delay(10) }

    private fun microphone(frame: String): ByteArray =
        Base64.getDecoder().decode(Json.parseToJsonElement(frame).jsonObject["realtimeInput"]!!.jsonObject["audio"]!!.jsonObject["data"]!!.jsonPrimitive.content)

    private fun FakeTransport.responses(): List<JsonObject> = sent.filter { "toolResponse" in it }.map {
        Json.parseToJsonElement(it).jsonObject["toolResponse"]!!.jsonObject["functionResponses"]!!.jsonArray.single().jsonObject
    }

    @Test fun theCoresSetupGoesFirstThenTheMicrophone() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete()))
        val audio = FakeAudio()
        val call = call(listOf(transport), audio)
        call.start()
        call.awaitStatus(AssistantCall.Status.Listening)
        transport.awaitSent { s -> s.count { "realtimeInput" in it } >= 3 }
        val setup = Json.parseToJsonElement(transport.sent.first()).jsonObject["setup"]!!.jsonObject
        assertEquals("models/gemini-3.8-live", setup["model"]!!.jsonPrimitive.content)
        val instruction = setup["systemInstruction"]!!.jsonObject["parts"]!!.jsonArray[0].jsonObject["text"]!!.jsonPrimitive.content
        assertTrue(instruction.startsWith("You are Gemini Live, the continuous voice front end in Bento on Android."), "the core's instruction, for the phone")
        assertTrue(transport.sent.none { "clientContent" in it }, "a new call sends no recap")
        assertContentEquals(FakeAudio.QUIET, microphone(transport.sent[1]))
        assertNotNull(call.version)
        call.stop()
        assertNull(call.ended().message)
        assertTrue(audio.stopped)
        assertEquals(1, transport.closeCount)
    }

    @Test fun aCallOnAConversationRecapsIt() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete()))
        val history = listOf(
            CoreCall.Line("user", "What's on my calendar?"),
            CoreCall.Line("assistant", "A dentist at ten.", speaker = "Hermes · Calendar"),
            CoreCall.Line("assistant", "It broke.", failed = true),
        )
        val call = call(listOf(transport), history = history)
        call.start()
        transport.awaitSent { s -> s.any { "clientContent" in it } }
        val recap = transport.sent.first { "clientContent" in it }
        assertTrue("User: What's on my calendar?" in recap && "Hermes · Calendar: A dentist at ten." in recap, recap)
        assertFalse("It broke." in recap, "a failed reply isn't recapped")
        call.stop()
    }

    @Test fun aSpokenRequestGoesToHermesAndItsReplyBackToGemini() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete()))
        val audio = FakeAudio()
        val asked = CompletableDeferred<HermesCall>()
        val reply = CompletableDeferred<ToolReply>()
        val call = call(listOf(transport), audio, onTool = { asked.complete(it); reply.await() })
        val heard = CopyOnWriteArrayList<Pair<String, String>>()
        call.onTranscript = { role, text -> heard.add(role to text) }
        call.start()
        call.awaitStatus(AssistantCall.Status.Listening)
        Live.turn(transport, "What's the weather in Copenhagen?")
        transport.push(Live.call("c1", args = mapOf("label" to "Copenhagen weather")))
        val request = withTimeout(5_000) { asked.await() }
        assertEquals("What's the weather in Copenhagen?", request.task)
        assertEquals("Copenhagen weather", request.label)
        assertFalse(request.followUp)
        val message = assertNotNull(request.message, "the core words what Hermes gets")
        assertTrue(message.startsWith("User's transcribed request from Bento's Gemini Live voice session on Android:\nWhat's the weather in Copenhagen?"), message)
        assertTrue("Today's date is 2026-11-22." in message && "on the user's phone" in message, message)
        call.awaitStatus(AssistantCall.Status.Working)
        transport.awaitSent { transport.responses().isNotEmpty() }
        assertEquals("started", transport.responses().first()["response"]!!.jsonObject["status"]!!.jsonPrimitive.content)
        assertEquals(listOf(Earcon.TaskStarted), audio.cues.toList())
        reply.complete(ToolReply("Sunny, twelve degrees."))
        transport.awaitSent { s -> s.any { "Sunny, twelve degrees." in it } }
        call.awaitStatus(AssistantCall.Status.Listening)
        assertEquals(listOf(Earcon.TaskStarted, Earcon.ResultArrived), audio.cues.toList())
        assertEquals(listOf("user" to "What's the weather in Copenhagen?"), heard.toList())
        call.stop()
        assertNull(call.ended().message)
    }

    @Test fun geminisVoiceIsPlayedAndAnInterruptionFlushesIt() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete()))
        val audio = FakeAudio()
        val call = call(listOf(transport), audio)
        val heard = CopyOnWriteArrayList<Pair<String, String>>()
        call.onTranscript = { role, text -> heard.add(role to text) }
        call.start()
        call.awaitStatus(AssistantCall.Status.Listening)
        val voice = ByteArray(4_800) { (it % 7).toByte() }
        transport.push(Live.said("Hello there."))
        transport.push(Live.audio(voice))
        withTimeout(5_000) { while (audio.played.isEmpty()) delay(10) }
        assertContentEquals(voice, audio.played.single())
        assertEquals(listOf("assistant" to "Hello there."), heard.toList())
        transport.push(Live.interrupted())
        withTimeout(5_000) { while (audio.flushes == 0) delay(10) }
        call.stop()
    }

    @Test fun wordsSaidBeforeTheCallConnectedGoFirst() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete()))
        val audio = FakeAudio()
        val opening = ByteArray(6_400) { 0x11 }
        var micOpenAtTaking: Boolean? = null
        val call = call(listOf(transport), audio, opening = { micOpenAtTaking = audio.started; opening })
        call.start()
        transport.awaitSent { s -> s.count { "realtimeInput" in it } >= 4 }
        // taken before the call's own microphone opened, so the wake listener could let go of it first
        assertEquals(false, micOpenAtTaking)
        val frames = transport.sent.filter { "realtimeInput" in it }.map(::microphone)
        assertContentEquals(opening.copyOfRange(0, 3_200), frames[0])
        assertContentEquals(opening.copyOfRange(3_200, 6_400), frames[1])
        assertContentEquals(FakeAudio.QUIET, frames[2])
        call.stop()
    }

    @Test fun aMutedCallSendsNoAudioUntilItsUnmuted() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete()))
        val call = call(listOf(transport))
        call.muted = true
        call.start()
        call.awaitStatus(AssistantCall.Status.Listening)
        delay(300)
        assertTrue(transport.sent.none { "\"audio\":{" in it }, "tap-to-talk starts muted")
        call.muted = false
        transport.awaitSent { s -> s.count { "\"audio\":{" in it } >= 3 }
        call.muted = true
        transport.awaitSent { s -> s.any { "audioStreamEnd" in it } }
        call.stop()
    }

    @Test fun aMicrophoneThatWontOpenEndsTheCall() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete()))
        val call = call(listOf(transport), FakeAudio(opens = false))
        call.start()
        assertEquals("Couldn't open the microphone.", call.ended().message)
        assertEquals(1, transport.closeCount)
    }

    @Test fun aRefusedKeyEndsTheCallWithTheCoresWords() = blocking {
        val transport = FakeTransport(emptyList()).apply { connectError = IOException("403") }
        val call = call(listOf(transport), ending = { LiveSocketEnding(httpStatus = 403) })
        call.start()
        assertEquals("Gemini rejected the API key. Check it in Settings → Dictation.", call.ended().message)
    }

    @Test fun endingTheCallCancelsItsHermesTask() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete()))
        val cancelled = CompletableDeferred<Unit>()
        val call = call(listOf(transport), onTool = {
            try { CompletableDeferred<ToolReply>().await() } catch (e: CancellationException) { cancelled.complete(Unit); throw e }
        })
        call.start()
        call.awaitStatus(AssistantCall.Status.Listening)
        Live.turn(transport, "Book the dentist."); transport.push(Live.call("c1"))
        call.awaitStatus(AssistantCall.Status.Working)
        call.stop("The call ended: another app took the audio (a phone call?).")
        assertEquals("The call ended: another app took the audio (a phone call?).", call.ended().message)
        withTimeout(5_000) { cancelled.await() }
    }

    @Test fun cancellingATaskFromTheScreenStopsHermesAndTheCallGoesOn() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete()))
        val asked = CompletableDeferred<HermesCall>()
        val cancelled = CompletableDeferred<Unit>()
        val call = call(listOf(transport), onTool = {
            asked.complete(it)
            try { CompletableDeferred<ToolReply>().await() } catch (e: CancellationException) { cancelled.complete(Unit); throw e }
        })
        call.start()
        call.awaitStatus(AssistantCall.Status.Listening)
        Live.turn(transport, "Book the dentist."); transport.push(Live.call("c1"))
        val task = withTimeout(5_000) { asked.await() }.taskId
        call.cancelTask(task)
        withTimeout(5_000) { cancelled.await() }
        call.awaitStatus(AssistantCall.Status.Listening)
        call.stop()
    }

    @Test fun aFailedTaskIsToldAsOne() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete()))
        val call = call(listOf(transport), onTool = { throw IOException("Hermes is unreachable") })
        call.start()
        call.awaitStatus(AssistantCall.Status.Listening)
        Live.turn(transport, "Book the dentist."); transport.push(Live.call("c1"))
        transport.awaitSent { s -> s.any { "Task failed." in it && "Hermes is unreachable" in it } }
        call.stop()
    }

    @Test fun aCallWaitingOnHermesStandsByAndTalkingBringsItBack() = blocking {
        val first = FakeTransport(listOf(Frames.setupComplete()))
        val second = FakeTransport(listOf(Frames.setupComplete()))
        val audio = FakeAudio()
        val call = call(listOf(first, second), audio, onTool = { CompletableDeferred<ToolReply>().await() }, standbyAfter = 0.3)
        call.start()
        first.awaitSent { s -> s.any { "realtimeInput" in it } }
        Live.turn(first, "What's on my calendar?"); first.push(Live.call("c1", args = mapOf("label" to "Calendar")))
        call.awaitStatus(AssistantCall.Status.Standby)
        assertEquals(1, first.closeCount, "standby leaves Gemini")
        delay(300)
        assertTrue(second.sent.isEmpty(), "silence doesn't wake it")
        audio.loud = true
        call.awaitStatus(AssistantCall.Status.Working)
        second.awaitSent { s -> s.count { "realtimeInput" in it } >= 10 }
        assertTrue("\"setup\"" in second.sent[0])
        // The new session hears the conversation so far and the task still running, from the core's own record.
        assertTrue("clientContent" in second.sent[1] && "User: What's on my calendar?" in second.sent[1] && "Calendar" in second.sent[1], second.sent[1])
        val loud = Base64.getEncoder().encodeToString(FakeAudio.LOUD)
        assertTrue(second.sent.drop(2).any { loud in it }, "the words that woke it reach the new session")
        call.stop()
    }

    @Test fun wordsSaidWhileASlowSocketOpensReachTheNewSessionWhole() = blocking {
        val first = FakeTransport(listOf(Frames.setupComplete()))
        val second = FakeTransport(listOf(Frames.setupComplete()))
        // Three seconds to connect: the core keeps what's said meanwhile and replays it in one answer,
        // far more frames than may wait on a socket that has fallen behind (AUDIO_BACKLOG).
        val slow = object : LiveTransport by second {
            override suspend fun connect() { delay(3_000); second.connect() }
        }
        val audio = FakeAudio().apply { numbered = true }
        val call = call(listOf(first, slow), audio, onTool = { CompletableDeferred<ToolReply>().await() }, standbyAfter = 0.3)
        call.start()
        first.awaitSent { s -> s.any { "realtimeInput" in it } }
        Live.turn(first, "What's on my calendar?"); first.push(Live.call("c1"))
        call.awaitStatus(AssistantCall.Status.Standby)
        val began = audio.count
        audio.loud = true
        withTimeout(10_000) { call.status.first { it == AssistantCall.Status.Working } }
        audio.quiet = true
        delay(200)
        val last = audio.count - 1
        assertTrue(last - began > CoreCall.AUDIO_BACKLOG, "more was said than a socket's backlog holds ($began to $last)")
        second.awaitSent { s -> s.any { "realtimeInput" in it && ByteBuffer.wrap(microphone(it)).int == last } }
        val heard = second.sent.filter { "realtimeInput" in it }.map { ByteBuffer.wrap(microphone(it)).int }
        assertEquals((heard.first()..last).toList(), heard, "no frame is dropped or out of order")
        assertTrue(heard.first() <= began, "from the first word (${heard.first()}, and the speech began at $began)")
        call.stop()
    }

    @Test fun aMicrophoneLentInStandbyHoldsTheComebackUntilItsReclaimed() = blocking {
        val first = FakeTransport(listOf(Frames.setupComplete()))
        val second = FakeTransport(listOf(Frames.setupComplete()))
        val audio = FakeAudio()
        val reply = CompletableDeferred<ToolReply>()
        val call = call(listOf(first, second), audio, onTool = { reply.await() }, standbyAfter = 0.3)
        call.start()
        first.awaitSent { s -> s.any { "realtimeInput" in it } }
        assertFalse(call.lend(), "a call on Gemini keeps the microphone")
        Live.turn(first, "What's on my calendar?"); first.push(Live.call("c1"))
        call.awaitStatus(AssistantCall.Status.Standby)
        assertTrue(call.lend())
        assertFalse(call.lend(), "lent once at a time")
        audio.loud = true // the user dictating
        reply.complete(ToolReply("A dentist at ten."))
        call.wake()
        delay(500)
        assertEquals(AssistantCall.Status.Standby, call.status.value, "neither the dictation, the answer nor wake brings it back while lent")
        assertTrue(second.sent.isEmpty())
        assertEquals(listOf(Earcon.TaskStarted), audio.cues.toList(), "the dictation never hears the result's tone")
        audio.loud = false
        delay(100) // the last of the dictation's frames are captured before the microphone comes back
        audio.numbered = true
        call.reclaim()
        second.awaitSent { s -> s.any { "A dentist at ten." in it } }
        call.awaitStatus(AssistantCall.Status.Listening)
        assertTrue(second.sent.filter { "realtimeInput" in it }.none { microphone(it).contentEquals(FakeAudio.LOUD) }, "none of the dictation's audio goes to Gemini")
        assertFalse(call.lend())
        call.stop()
        assertNull(call.ended().message)
        assertFalse(call.lend(), "a call that's over lends nothing")
    }

    @Test fun captionsShowTheUserSpeakingUntilGeminisTranscriptReplacesThem() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete()))
        val captions = Captions()
        val asked = CompletableDeferred<HermesCall>()
        val call = call(listOf(transport), captions = captions, onTool = { asked.complete(it); ToolReply("Sunny.") })
        val shown = CopyOnWriteArrayList<String?>()
        val heard = CopyOnWriteArrayList<String>()
        call.onCaption = { shown.add(it) }
        call.onTranscript = { role, text -> if (role == "user") heard.add(text) }
        call.start()
        withTimeout(5_000) { while (captions.fed == 0) delay(10) }
        captions.say(Caption.Started())
        captions.say(Caption.Partial("What's the"))
        captions.say(Caption.Partial("What's the weather in Londo"))
        shown.awaitSize(2)
        transport.push(Live.activity("ACTIVITY_START"))
        transport.push(Live.heard("What's the weather in London?"))
        transport.push(Live.activity("ACTIVITY_END"))
        heard.awaitSize(1)
        // The transcript takes the caption's place in the app's one update: no separate null.
        assertEquals(listOf<String?>("What's the", "What's the weather in Londo"), shown.toList())
        // The captioner's late guesses at the same words are stale; its next utterance shows again.
        captions.say(Caption.Partial("What's the weather in London?"))
        captions.say(Caption.Ended)
        delay(600)
        captions.say(Caption.Started())
        captions.say(Caption.Partial("Thanks"))
        shown.awaitSize(3)
        assertEquals("Thanks", shown.last())
        transport.push(Live.call("c1"))
        assertEquals("What's the weather in London?", withTimeout(5_000) { asked.await() }.task, "Hermes gets Gemini's words, never a caption")
        call.stop()
        call.ended()
        assertTrue(captions.stopped)
    }

    @Test fun aCallWithNothingLeftHangsUpAfterTheQuiet() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete()))
        val call = call(listOf(transport), hangUpAfter = 0.5)
        call.start()
        assertNull(call.ended().message)
    }

    @Test fun sayingGoodbyeHangsUp() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete()))
        val call = call(listOf(transport))
        call.start()
        call.awaitStatus(AssistantCall.Status.Listening)
        Live.turn(transport, "Goodbye.")
        assertNull(call.ended().message)
    }

    @Test fun aBundleThatWontLoadEndsTheCallWithoutCrashing() = blocking {
        val call = CoreCall("this is not JavaScript (", CoreCall.config(today = "2026-11-22"), { FakeTransport(emptyList()) }, FakeAudio(), { ToolReply("") })
        call.start()
        assertEquals(CoreCall.LOAD_FAILED, call.ended().message)
    }

    @Test fun hangingUpWithToolScopeLeavesDispatchedHermesTaskRunning() = blocking {
        val toolScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val transport = FakeTransport(listOf(Frames.setupComplete()))
            val audio = FakeAudio()
            val captions = Captions()
            val asked = CompletableDeferred<HermesCall>()
            val reply = CompletableDeferred<ToolReply>()
            val cancelled = CompletableDeferred<Unit>()
            val finished = CompletableDeferred<String>()
            val call = call(
                listOf(transport), audio, captions = captions, toolScope = toolScope,
                onTool = { req ->
                    asked.complete(req)
                    try {
                        reply.await().also { finished.complete(it.text) }
                    } catch (e: CancellationException) {
                        cancelled.complete(Unit)
                        throw e
                    }
                },
            )
            call.start()
            call.awaitStatus(AssistantCall.Status.Listening)
            Live.turn(transport, "Book the dentist.")
            transport.push(Live.call("c1", args = mapOf("label" to "Dentist")))
            withTimeout(5_000) { asked.await() }
            call.awaitStatus(AssistantCall.Status.Working)

            call.stop()
            assertNull(call.ended().message)
            assertTrue(audio.stopped)
            assertTrue(captions.stopped)
            assertEquals(1, transport.closeCount)

            val sentAtEnd = transport.sent.size
            val cuesAtEnd = audio.cues.size
            delay(200)
            assertFalse(cancelled.isCompleted, "hanging up must not cancel an already-dispatched Hermes task")

            reply.complete(ToolReply("Booked for Tuesday at 10am."))
            assertEquals("Booked for Tuesday at 10am.", withTimeout(5_000) { finished.await() })
            delay(150)
            assertEquals(sentAtEnd, transport.sent.size, "late result must not write to the closed Gemini socket")
            assertEquals(cuesAtEnd, audio.cues.size, "late result must not play cues on stopped call audio")
        } finally {
            toolScope.cancel()
        }
    }

    @Test fun sayingGoodbyeWithToolScopeLeavesDispatchedHermesTaskRunning() = blocking {
        val toolScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val transport = FakeTransport(listOf(Frames.setupComplete()))
            val audio = FakeAudio()
            val asked = CompletableDeferred<HermesCall>()
            val reply = CompletableDeferred<ToolReply>()
            val cancelled = CompletableDeferred<Unit>()
            val finished = CompletableDeferred<String>()
            val call = call(
                listOf(transport), audio, toolScope = toolScope,
                onTool = { req ->
                    asked.complete(req)
                    try {
                        reply.await().also { finished.complete(it.text) }
                    } catch (e: CancellationException) {
                        cancelled.complete(Unit)
                        throw e
                    }
                },
            )
            call.start()
            call.awaitStatus(AssistantCall.Status.Listening)
            Live.turn(transport, "Book the dentist.")
            transport.push(Live.call("c1"))
            withTimeout(5_000) { asked.await() }
            call.awaitStatus(AssistantCall.Status.Working)

            Live.turn(transport, "Goodbye.")
            assertNull(call.ended().message)
            assertTrue(audio.stopped)
            assertEquals(1, transport.closeCount)
            delay(200)
            assertFalse(cancelled.isCompleted, "saying goodbye must not cancel a dispatched Hermes task")

            reply.complete(ToolReply("Booked."))
            assertEquals("Booked.", withTimeout(5_000) { finished.await() })
        } finally {
            toolScope.cancel()
        }
    }

    @Test fun explicitCancelStillCancelsHermesTaskWithToolScope() = blocking {
        val toolScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val transport = FakeTransport(listOf(Frames.setupComplete()))
            val asked = CompletableDeferred<HermesCall>()
            val cancelled = CompletableDeferred<Unit>()
            val call = call(
                listOf(transport), toolScope = toolScope,
                onTool = { req ->
                    asked.complete(req)
                    try {
                        CompletableDeferred<ToolReply>().await()
                    } catch (e: CancellationException) {
                        cancelled.complete(Unit)
                        throw e
                    }
                },
            )
            call.start()
            call.awaitStatus(AssistantCall.Status.Listening)
            Live.turn(transport, "Book the dentist.")
            transport.push(Live.call("c1"))
            val taskId = withTimeout(5_000) { asked.await() }.taskId
            call.cancelTask(taskId)
            withTimeout(5_000) { cancelled.await() }
            call.awaitStatus(AssistantCall.Status.Listening)
            call.stop()
        } finally {
            toolScope.cancel()
        }
    }

    @Test fun hangingUpMidHermesSseStreamKeepsSessionAliveAndNeverCallsStop() = blocking {
        val server = MockWebServer().apply { start() }
        val toolScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val streamStarted = CompletableDeferred<String>()
        val releaseRest = CountDownLatch(1)
        val finalAnswer = CompletableDeferred<Pair<String?, String>>()
        val stopCalls = CopyOnWriteArrayList<String>()
        val http = OkHttpClient()
        try {
            val client = HermesClient({ HermesEndpoint(server.url("/"), "secret-token") }, http)
            server.enqueue(MockResponse.Builder().code(201).addHeader("Content-Type", "application/json")
                .body("""{"object":"hermes.session","session":{"id":"api_detached_1","source":"api_server"}}""").build())
            val sseBody = object : MockResponseBody {
                override val contentLength: Long = -1L
                override fun writeTo(sink: BufferedSink) {
                    sink.writeUtf8("event: run.started\ndata: {\"run_id\":\"run_detached_1\",\"session_id\":\"api_detached_1\"}\n\n")
                    sink.writeUtf8("event: tool.started\ndata: {\"tool_name\":\"web_search\",\"preview\":\"Copenhagen weather\"}\n\n")
                    sink.flush()
                    assertTrue(releaseRest.await(10, TimeUnit.SECONDS))
                    sink.writeUtf8("event: tool.completed\ndata: {\"tool_name\":\"web_search\",\"preview\":\"12C sunny\"}\n\n")
                    sink.writeUtf8("event: assistant.delta\ndata: {\"delta\":\"Sunny, twelve degrees.\"}\n\n")
                    sink.writeUtf8("event: assistant.completed\ndata: {\"content\":\"Sunny, twelve degrees.\",\"session_id\":\"api_detached_1\"}\n\n")
                    sink.writeUtf8("event: run.completed\ndata: {\"status\":\"completed\",\"session_id\":\"api_detached_1\"}\n\n")
                    sink.writeUtf8("event: done\ndata: {}\n\n")
                    sink.flush()
                }
            }
            server.enqueue(MockResponse.Builder().code(200).addHeader("Content-Type", "text/event-stream").body(sseBody).build())

            val transport = FakeTransport(listOf(Frames.setupComplete()))
            val audio = FakeAudio()
            val call = call(
                listOf(transport), audio, toolScope = toolScope,
                onTool = { req ->
                    val sid = client.createSession().id
                    var turn = TurnState(sessionId = sid)
                    var rows = emptyList<com.charles.bento.core.assistant.ChatMessage>()
                    var runId: String? = null
                    try {
                        client.chat(sid, req.message ?: req.task).collect { event ->
                            if (event is HermesEvent.RunStarted) {
                                runId = event.runId
                                streamStarted.complete(event.runId)
                            }
                            val (next, t) = AssistantTranscript.apply(rows, turn, event)
                            rows = next
                            turn = t
                        }
                    } catch (e: CancellationException) {
                        runId?.let { stopCalls.add(it) }
                        throw e
                    }
                    finalAnswer.complete(turn.sessionId to turn.answer)
                    ToolReply(turn.answer)
                },
            )

            call.start()
            call.awaitStatus(AssistantCall.Status.Listening)
            Live.turn(transport, "What's the weather in Copenhagen?")
            transport.push(Live.call("c1", args = mapOf("label" to "Copenhagen weather")))
            assertEquals("run_detached_1", withTimeout(5_000) { streamStarted.await() })

            // Hang up mid-stream while Hermes is still running.
            call.stop()
            assertNull(call.ended().message)
            assertTrue(audio.stopped)
            assertEquals(1, transport.closeCount)

            // Hermes finishes after the call ended: SSE stream stays open and completes cleanly.
            releaseRest.countDown()
            val (sid, answer) = withTimeout(5_000) { finalAnswer.await() }
            assertEquals("api_detached_1", sid)
            assertEquals("Sunny, twelve degrees.", answer)
            assertTrue(stopCalls.isEmpty(), "hanging up must not invoke /v1/runs/{run}/stop")
            assertEquals(2, server.requestCount, "only createSession + chat/stream, no stop request")
            assertEquals("/api/sessions", server.takeRequest().url.encodedPath)
            assertEquals("/api/sessions/api_detached_1/chat/stream", server.takeRequest().url.encodedPath)
        } finally {
            releaseRest.countDown()
            toolScope.cancel()
            server.close()
            http.dispatcher.executorService.shutdown()
            http.connectionPool.evictAll()
        }
    }

    @Test fun aFailedTaskWithToolScopeIsToldAsOne() = blocking {
        val toolScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val transport = FakeTransport(listOf(Frames.setupComplete()))
            val call = call(listOf(transport), toolScope = toolScope, onTool = { throw IOException("Hermes is unreachable") })
            call.start()
            call.awaitStatus(AssistantCall.Status.Listening)
            Live.turn(transport, "Book the dentist.")
            transport.push(Live.call("c1"))
            transport.awaitSent { s -> s.any { "Task failed." in it && "Hermes is unreachable" in it } }
            call.stop()
        } finally {
            toolScope.cancel()
        }
    }

    @Test fun cancellingToolScopeStopsInFlightTaskWithoutCrashingTheCall() = blocking {
        val serverScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val asked = CompletableDeferred<Unit>()
        val cancelled = CompletableDeferred<Unit>()
        val transport = FakeTransport(listOf(Frames.setupComplete()))
        val call = call(
            listOf(transport), toolScope = serverScope,
            onTool = {
                asked.complete(Unit)
                try {
                    CompletableDeferred<ToolReply>().await()
                } catch (e: CancellationException) {
                    cancelled.complete(Unit)
                    throw e
                }
            },
        )
        call.start()
        call.awaitStatus(AssistantCall.Status.Listening)
        Live.turn(transport, "Book the dentist.")
        transport.push(Live.call("c1"))
        withTimeout(5_000) { asked.await() }

        // Simulates leaveServer(): cancelling the server-owned scope cancels the Hermes task immediately.
        serverScope.cancel()
        withTimeout(5_000) { cancelled.await() }
        call.stop()
        assertNull(call.ended().message)
    }
}
