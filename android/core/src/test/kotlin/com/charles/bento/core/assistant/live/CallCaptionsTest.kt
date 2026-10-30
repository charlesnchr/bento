package com.charles.bento.core.assistant.live

import com.charles.bento.core.voice.FakeTransport
import com.charles.bento.core.voice.Frames
import com.charles.bento.core.voice.blocking
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CallCaptionsTest {
    private val sockets = CopyOnWriteArrayList<FakeTransport>()
    private val heard = CopyOnWriteArrayList<Caption>()
    private var captions: LiveCaptions? = null

    /** Captions over sockets from [script], one per connection (the last repeats). */
    private fun captions(vararg script: () -> FakeTransport, idle: Double = 20.0, clock: () -> Double = { System.nanoTime() / 1e9 }): LiveCaptions {
        val c = LiveCaptions({ script[minOf(sockets.size, script.size - 1)]().also(sockets::add) }, idleSeconds = idle, retrySeconds = 0.05,
                             clock = clock)
        c.start { heard.add(it) }
        captions = c
        return c
    }

    private fun ready() = FakeTransport(listOf(Frames.setupComplete()))

    @AfterTest fun stop() { captions?.stop() }

    private suspend fun until(check: () -> Boolean) = withTimeout(5_000) { while (!check()) delay(10) }

    @Test fun aSocketOpensWithTheFirstAudioAndStreamsIt() = blocking {
        val c = captions({ ready() })
        delay(200)
        assertTrue(sockets.isEmpty(), "no audio, no socket: a muted call pays for nothing")
        repeat(3) { c.feed(ByteArray(640)) }
        until { sockets.size == 1 && sockets[0].sentKinds.count { it == "audio" } == 3 }
        assertEquals("setup", sockets[0].sentKinds.first())
        val setup = Json.parseToJsonElement(sockets[0].sent.first()).jsonObject["setup"]!!.jsonObject
        assertEquals("models/gemini-3.5-transcribe-live", setup["model"]!!.jsonPrimitive.content)
        assertNull(setup["realtimeInputConfig"], "the server finds where utterances end, as in a meeting")
        assertTrue(sockets[0].sent.first().contains("Hermes"))
    }

    @Test fun guessesArriveAsCaptionsAndTheUtteranceEnds() = blocking {
        val c = captions({ ready() })
        c.feed(ByteArray(640))
        until { sockets.size == 1 && sockets[0].sentKinds.contains("audio") }
        sockets[0].push(Frames.activity("ACTIVITY_START"))
        sockets[0].push(Frames.partial("What's the"))
        sockets[0].push(Frames.partial("What's the weather "))
        sockets[0].push(Frames.final("What's the weather?"))
        sockets[0].push(Frames.activity("ACTIVITY_END"))
        until { heard.size == 4 }
        assertTrue(heard[0] is Caption.Started)
        assertEquals(listOf(Caption.Partial("What's the"), Caption.Partial("What's the weather"), Caption.Ended), heard.drop(1))
    }

    @Test fun anUtteranceStartsWhenItsAudioWasCapturedThroughMutes() = blocking {
        var now = 100.0
        val c = captions({ ready() }, clock = { now })
        // 0.1 s of audio, a mute, then another 0.1 s.
        repeat(5) { c.feed(ByteArray(640)); now += 0.02 }
        now = 200.0
        repeat(5) { c.feed(ByteArray(640)); now += 0.02 }
        until { sockets.size == 1 && sockets[0].sentKinds.count { it == "audio" } == 10 }
        sockets[0].push(Frames.activity("ACTIVITY_START", "0.04s"))
        sockets[0].push(Frames.activity("ACTIVITY_END", "0.06s"))
        sockets[0].push(Frames.activity("ACTIVITY_START", "0.14s"))
        until { heard.size == 3 }
        assertEquals(100.04, (heard[0] as Caption.Started).at!!, 1e-9)
        assertEquals(200.04, (heard[2] as Caption.Started).at!!, 1e-9)
    }

    @Test fun pauseEndsTheUtteranceNow() = blocking {
        val c = captions({ ready() })
        c.feed(ByteArray(640))
        until { sockets.size == 1 && sockets[0].sentKinds.contains("audio") }
        c.pause()
        until { sockets[0].sentKinds.last() == "audioStreamEnd" }
    }

    @Test fun aRotatedConnectionIsReplacedAtTheNextAudio() = blocking {
        val c = captions({ ready() })
        c.feed(ByteArray(640))
        until { sockets.size == 1 && sockets[0].sentKinds.contains("audio") }
        sockets[0].push(Frames.activity("ACTIVITY_START"))
        sockets[0].push("""{"goAway":{"timeLeft":"5s"}}""")
        until { sockets[0].closeCount > 0 }
        assertTrue(heard.size == 2 && heard[0] is Caption.Started && heard[1] == Caption.Ended, "an utterance the socket took with it ends: $heard")
        c.feed(ByteArray(640))
        until { sockets.size == 2 && sockets[1].sentKinds.contains("audio") }
    }

    @Test fun anIdleSocketClosesAndAudioOpensAnother() = blocking {
        val c = captions({ ready() }, idle = 0.2)
        c.feed(ByteArray(640))
        until { sockets.size == 1 && sockets[0].closeCount > 0 }
        c.feed(ByteArray(640))
        until { sockets.size == 2 && sockets[1].sentKinds.contains("audio") }
    }

    @Test fun aCaptionerGeminiRefusesGivesUp() = blocking {
        val c = captions({ FakeTransport(listOf(Frames.error("API key not valid"))) })
        repeat(20) { c.feed(ByteArray(640)); delay(30) }
        until { sockets.size == 3 }
        repeat(10) { c.feed(ByteArray(640)); delay(30) }
        assertEquals(3, sockets.size, "three refusals and the call goes on without captions")
        assertTrue(sockets.all { it.closeCount > 0 })
    }

    @Test fun aSocketThatBreaksWithoutCaptionsIsAFailureEvenAfterAnUtteranceStarted() = blocking {
        val c = captions({ FakeTransport(listOf(Frames.setupComplete(), Frames.activity("ACTIVITY_START"), Frames.error("Internal error"))) })
        repeat(30) { c.feed(ByteArray(640)); delay(30) }
        until { sockets.size == 3 }
        repeat(10) { c.feed(ByteArray(640)); delay(30) }
        assertEquals(3, sockets.size, "no captions, three breaks: the captioner gives up")
    }

    @Test fun captionsKeepTheCaptionerGoingThroughBreaks() = blocking {
        val c = captions({ FakeTransport(listOf(Frames.setupComplete(), Frames.partial("Hi"), Frames.error("Internal error"))) })
        repeat(40) { c.feed(ByteArray(640)); delay(30) }
        until { sockets.size >= 5 }
    }

    @Test fun stopClosesTheSocket() = blocking {
        val c = captions({ ready() })
        c.feed(ByteArray(640))
        until { sockets.size == 1 && sockets[0].sentKinds.contains("audio") }
        c.stop()
        until { sockets[0].closeCount > 0 }
    }
}
