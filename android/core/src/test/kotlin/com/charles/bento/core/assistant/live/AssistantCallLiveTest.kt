package com.charles.bento.core.assistant.live

import com.charles.bento.core.voice.blocking
import com.charles.bento.core.voice.live.OkHttpLiveTransport
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The call's setup against the real Gemini API, skipped unless GEMINI_API_KEY is set: the
 * model accepts it, and a request it can't answer itself becomes an `ask_hermes` call.
 * Text in, so it costs a few hundred tokens.
 */
class AssistantCallLiveTest {
    private val key: String? = System.getenv("GEMINI_API_KEY")?.takeIf { it.isNotBlank() }

    @BeforeEach fun requireKey() = assumeTrue(key != null, "GEMINI_API_KEY not set: skipping the live call test")

    @Test fun geminiAcceptsTheSetupAndDelegatesToHermes() = blocking {
        val transport = OkHttpLiveTransport({ key!! })
        try {
            transport.connect()
            transport.send(CallSetup.setupFrame())
            withTimeout(20_000) {
                do { val frame = Json.parseToJsonElement(transport.receive()).jsonObject } while (frame["setupComplete"] == null)
            }
            transport.send("""{"realtimeInput":{"text":"Please ask Hermes to check my calendar for tomorrow."}}""")
            val call = withTimeout(30_000) {
                while (true) {
                    val o = Json.parseToJsonElement(transport.receive()).jsonObject
                    o["toolCall"]?.let { return@withTimeout it.jsonObject["functionCalls"]!!.jsonArray.first().jsonObject }
                }
                @Suppress("UNREACHABLE_CODE") error("unreachable")
            }
            assertEquals(CallProtocol.TOOL, call["name"]!!.jsonPrimitive.content)
        } finally {
            transport.close()
        }
    }

    /** What a call does when Gemini rotates its connection: a new socket picks the session up from its handle. */
    @Test fun aNewSocketResumesTheSessionFromItsHandle() = blocking {
        // Gemini may hand a memory question to Hermes; as a call would, it gets an answer (here: answer it yourself).
        suspend fun OkHttpLiveTransport.next(): JsonObject = Json.parseToJsonElement(receive()).jsonObject.also { o ->
            o["toolCall"]?.jsonObject?.get("functionCalls")?.jsonArray?.forEach { call ->
                val id = call.jsonObject["id"]!!.jsonPrimitive.content
                send(CallProtocol.response(id, message = "Not executed: answer from this conversation yourself.", executed = false))
            }
        }
        val first = OkHttpLiveTransport({ key!! })
        val handle = try {
            first.connect()
            first.send(CallSetup.setupFrame())
            withTimeout(20_000) { while (first.next()["setupComplete"] == null) Unit }
            first.send("""{"realtimeInput":{"text":"Remember the code word pineapple. Just acknowledge it briefly."}}""")
            withTimeout(30_000) {
                var handle: String? = null
                // A tool call's answer starts another turn: closing before it ends leaves it running in the session.
                var turns = 1
                while (handle == null || turns > 0) {
                    val o = first.next()
                    o["sessionResumptionUpdate"]?.jsonObject?.get("newHandle")?.jsonPrimitive?.content?.takeIf { it.isNotEmpty() }?.let { handle = it }
                    if (o["toolCall"] != null) turns++
                    if (o["serverContent"]?.jsonObject?.get("turnComplete") != null) turns--
                }
                handle!!
            }
        } finally {
            first.close()
        }
        val second = OkHttpLiveTransport({ key!! })
        try {
            second.connect()
            second.send(CallSetup.setupFrame(handle = handle))
            withTimeout(20_000) { while (second.next()["setupComplete"] == null) Unit }
            second.send("""{"realtimeInput":{"text":"What was the code word? Answer in one word."}}""")
            // The transcript can trail turnComplete, so read until the word or the deadline.
            val said = StringBuilder()
            withTimeoutOrNull(30_000) {
                while ("pineapple" !in said.toString().lowercase()) {
                    val content = second.next()["serverContent"]?.jsonObject ?: continue
                    content["outputTranscription"]?.jsonObject?.get("text")?.jsonPrimitive?.content?.let(said::append)
                }
            }
            assertTrue("pineapple" in said.toString().lowercase(), "heard: $said")
        } finally {
            second.close()
        }
    }
}
