package com.charles.bento.core.assistant.live

import com.charles.bento.core.voice.blocking
import com.charles.bento.core.voice.live.OkHttpLiveTransport
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import kotlin.test.Test
import kotlin.test.assertEquals

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
}
