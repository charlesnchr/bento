package com.charles.bento.core.voice.gemini

import com.charles.bento.core.voice.TranscriptionError
import com.charles.bento.core.voice.VoiceJsonCompact
import com.charles.bento.core.voice.blocking
import com.charles.bento.core.voice.live.LiveProtocol
import com.charles.bento.core.voice.live.LiveSetup
import com.charles.bento.core.voice.live.LiveTranscriptionSession
import com.charles.bento.core.voice.live.OkHttpLiveTransport
import com.charles.bento.core.voice.meeting.MeetingLiveProtocol
import com.charles.bento.core.voice.meeting.MeetingLiveSession
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.Base64
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Request shapes and the status → error matrix, against a local server. */
class GeminiClientTest {
    private lateinit var server: MockWebServer
    private val client = GeminiClient({ "test-key" })
    private val endpoint get() = server.url("/").toString()

    @BeforeTest fun setUp() { server = MockWebServer().apply { start() } }
    @AfterTest fun tearDown() = server.close()

    private fun enqueue(code: Int, body: String, vararg headers: Pair<String, String>) =
        server.enqueue(MockResponse.Builder().code(code).body(body).apply { headers.forEach { addHeader(it.first, it.second) } }.build())

    private fun RecordedRequest.json(): JsonObject = VoiceJsonCompact.parseToJsonElement(body!!.utf8()).jsonObject

    private val interactionOK = """{"id":"x","status":"completed","steps":[{"type":"model_output","content":[{"type":"text","text":"Hello there."}]}]}"""
    private val generateOK = """{"candidates":[{"content":{"parts":[{"text":"Cleaned"},{"text":" text."}]},"finishReason":"STOP"}]}"""

    @Test fun batchTranscriptionRequestShape() = blocking {
        enqueue(200, interactionOK)
        val text = client.transcribeInteraction(byteArrayOf(1, 2, 3), "audio/flac", "gemini-3.5-transcribe", endpoint,
            GeminiClient.TranscriptionMode.SMART, listOf("Ammaar", "gRPC"), deadline = 10.0)
        assertEquals("Hello there.", text)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/v1beta/interactions", request.url.encodedPath)
        assertNull(request.url.queryParameter("key"), "the key never rides in the query string")
        assertEquals("test-key", request.headers["x-goog-api-key"])
        assertTrue(request.headers["Content-Type"]!!.startsWith("application/json"))
        val body = request.json()
        assertEquals("gemini-3.5-transcribe", body["model"]!!.jsonPrimitive.content)
        val input = body["input"]!!.jsonArray.single().jsonObject
        assertEquals("audio", input["type"]!!.jsonPrimitive.content)
        assertEquals("audio/flac", input["mime_type"]!!.jsonPrimitive.content)
        assertEquals(Base64.getEncoder().encodeToString(byteArrayOf(1, 2, 3)), input["data"]!!.jsonPrimitive.content)
        val config = body["generation_config"]!!.jsonObject["transcription_config"]!!.jsonObject
        assertEquals("smart", config["mode"]!!.jsonPrimitive.content)
        assertEquals(listOf("Ammaar", "gRPC"), config["custom_vocabulary"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertFalse(body.toString().contains("language"), "never language_codes")
    }

    @Test fun verbatimWithoutVocabularyOmitsTheConfig() = blocking {
        enqueue(200, interactionOK)
        client.transcribeInteraction(byteArrayOf(1), "audio/flac", "m", endpoint, GeminiClient.TranscriptionMode.VERBATIM, emptyList(), 10.0)
        assertNull(server.takeRequest().json()["generation_config"])
    }

    @Test fun legacyTranscribeRequestShape() = blocking {
        enqueue(200, generateOK)
        client.transcribe(byteArrayOf(9), "gemini-3.5-transcribe", endpoint, 10.0, listOf("Kubernetes"))
        val request = server.takeRequest()
        assertEquals("/v1beta/models/gemini-3.5-transcribe:generateContent", request.url.encodedPath)
        val body = request.json()
        val part = body["contents"]!!.jsonArray[0].jsonObject["parts"]!!.jsonArray[0].jsonObject
        assertEquals("audio/flac", part["inline_data"]!!.jsonObject["mime_type"]!!.jsonPrimitive.content)
        val generation = body["generationConfig"]!!.jsonObject
        assertEquals(0, generation["temperature"]!!.jsonPrimitive.content.toInt())
        val audio = generation["audioTranscriptionConfig"]!!.jsonObject
        assertEquals("true", audio["wordTimestamp"]!!.jsonPrimitive.content)
        assertEquals("false", audio["diarization"]!!.jsonPrimitive.content)
        assertEquals("Kubernetes", audio["customVocabulary"]!!.jsonArray.single().jsonPrimitive.content)
    }

    @Test fun cleanupRequestShapeAndThinkingPerModel() = blocking {
        val cases = mapOf("gemini-3.5-flash-lite" to ("thinkingLevel" to "minimal"), "gemini-3.8-flash" to ("thinkingLevel" to "low"),
            "gemini-2.5-flash" to ("thinkingBudget" to "0"))
        for ((model, expected) in cases) {
            enqueue(200, generateOK)
            assertEquals("Cleaned text.", client.cleanup("PROMPT", model, endpoint, 5.0))
            val request = server.takeRequest()
            assertEquals("/v1beta/models/$model:generateContent", request.url.encodedPath)
            assertEquals("test-key", request.headers["x-goog-api-key"])
            val body = request.json()
            val parts = body["contents"]!!.jsonArray[0].jsonObject["parts"]!!.jsonArray
            assertEquals("user", body["contents"]!!.jsonArray[0].jsonObject["role"]!!.jsonPrimitive.content)
            assertEquals("PROMPT", parts.single().jsonObject["text"]!!.jsonPrimitive.content)
            val generation = body["generationConfig"]!!.jsonObject
            assertEquals("0", generation["temperature"]!!.jsonPrimitive.content)
            val thinking = generation["thinkingConfig"]!!.jsonObject
            assertEquals(expected.second, thinking[expected.first]!!.jsonPrimitive.content, model)
            assertEquals(1, thinking.size)
        }
    }

    @Test fun cleanupWithAudioPutsTheAudioFirst() = blocking {
        enqueue(200, generateOK)
        client.cleanup("P", "gemini-3.8-flash", endpoint, 5.0, audio = byteArrayOf(5))
        val parts = server.takeRequest().json()["contents"]!!.jsonArray[0].jsonObject["parts"]!!.jsonArray
        assertEquals("audio/flac", parts[0].jsonObject["inlineData"]!!.jsonObject["mimeType"]!!.jsonPrimitive.content)
        assertEquals("P", parts[1].jsonObject["text"]!!.jsonPrimitive.content)
    }

    @Test fun statusMatrix() = blocking {
        suspend fun call() = client.cleanup("p", "gemini-3.5-flash-lite", endpoint, 5.0)
        enqueue(401, """{"error":{"message":"nope"}}""")
        assertEquals(TranscriptionError.Auth, assertFailsWith<TranscriptionError> { call() })
        enqueue(404, """{"error":{"message":"models/x is not found"}}""")
        val unavailable = assertIs<TranscriptionError.ModelUnavailable>(assertFailsWith<TranscriptionError> { call() })
        assertEquals("gemini-3.5-flash-lite", unavailable.model)
        assertEquals("models/x is not found", unavailable.detail)
        enqueue(400, """{"error":{"message":"API key not valid"}}""")
        assertEquals(TranscriptionError.BadRequest("API key not valid"), assertFailsWith<TranscriptionError> { call() })
        enqueue(503, "busy")
        assertEquals(TranscriptionError.Network("http_503"), assertFailsWith<TranscriptionError> { call() })
        enqueue(429, """{"error":{"details":[{"quotaId":"GenerateRequestsPerDayPerProject"}]}}""")
        assertEquals(TranscriptionError.RateLimitedDaily, assertFailsWith<TranscriptionError> { call() })
        enqueue(429, """{"error":{"message":"slow down"}}""")
        assertEquals(TranscriptionError.RateLimitedTransient, assertFailsWith<TranscriptionError> { call() })
        enqueue(200, """{"promptFeedback":{"blockReason":"SAFETY"}}""")
        assertEquals(TranscriptionError.SafetyBlocked, assertFailsWith<TranscriptionError> { call() })
    }

    /** A 403/404 on interactions is about the endpoint, not the model: retryable network. */
    @Test fun interactions404IsNotAModelProblem() = blocking {
        enqueue(404, """[{"error":{"message":"not found"}}]""")
        val error = assertFailsWith<TranscriptionError> {
            client.transcribeInteraction(byteArrayOf(1), "audio/flac", "m", endpoint, GeminiClient.TranscriptionMode.SMART, emptyList(), 5.0)
        }
        assertEquals(TranscriptionError.Network("interactions_unavailable_404"), error)
    }

    @Test fun shortRetryDelayIsHonouredOnce() = blocking {
        enqueue(429, """{"error":{"details":[{"retryDelay":"0.2s"}]}}""")
        enqueue(200, generateOK)
        assertEquals("Cleaned text.", client.cleanup("p", "gemini-3.5-flash-lite", endpoint, 5.0))
        assertEquals(2, server.requestCount)
        enqueue(429, "", "Retry-After" to "0")
        enqueue(429, "", "Retry-After" to "0")
        assertEquals(TranscriptionError.RateLimitedTransient, assertFailsWith<TranscriptionError> { client.cleanup("p", "m", endpoint, 5.0) })
    }

    @Test fun deadlineIsAWallClock() = blocking {
        server.enqueue(MockResponse.Builder().code(200).body(generateOK).headersDelay(3, TimeUnit.SECONDS).build())
        val started = System.nanoTime()
        assertEquals(TranscriptionError.Timeout, assertFailsWith<TranscriptionError> { client.cleanup("p", "m", endpoint, 0.5) })
        assertTrue((System.nanoTime() - started) / 1e9 < 2.5)
    }

    @Test fun unreachableHostIsOffline() = blocking {
        val error = assertFailsWith<TranscriptionError> { client.cleanup("p", "m", "http://127.0.0.1:1", 2.0) }
        assertEquals(TranscriptionError.Offline, error)
    }

    @Test fun interactionStatusAndEnvelopes() {
        assertEquals("", GeminiClient.extractInteractionText("""{"status":"completed","steps":[]}"""))
        assertEquals(TranscriptionError.SafetyBlocked, assertFailsWith<TranscriptionError> {
            GeminiClient.extractInteractionText("""{"status":"failed","error":{"message":"Blocked for safety"}}""")
        })
        assertEquals(TranscriptionError.Network("interaction_status_in_progress"), assertFailsWith<TranscriptionError> {
            GeminiClient.extractInteractionText("""{"status":"in_progress"}""")
        })
        assertEquals("API key not valid", GeminiClient.errorMessage("""[{"error":{"message":"API key not valid"}}]"""))
        assertEquals("x", GeminiClient.errorMessage("""{"error":{"message":"x"}}"""))
        assertNull(GeminiClient.errorMessage("""{"code":"not_found"}"""))
        assertEquals(2.0, GeminiClient.retryDelaySeconds("""{"retryDelay": "2s"}""", null))
        assertEquals(7.0, GeminiClient.retryDelaySeconds("", "7"))
    }

    @Test fun keyValidation() = blocking {
        enqueue(200, "{}")
        assertEquals(GeminiClient.KeyCheck.Valid, client.validateKey(endpoint))
        val request = server.takeRequest()
        assertEquals("/v1beta/models", request.url.encodedPath)
        assertEquals("1", request.url.queryParameter("pageSize"))
        enqueue(400, """{"error":{"message":"API key not valid"}}""")
        assertEquals(GeminiClient.KeyCheck.Rejected("API key not valid"), client.validateKey(endpoint))
        enqueue(500, "")
        assertEquals(GeminiClient.KeyCheck.Unreachable, client.validateKey(endpoint))
        assertEquals(GeminiClient.KeyCheck.Unreachable, client.validateKey("http://127.0.0.1:1"))
    }
}

/** The Live socket's upgrade request and setup messages, against a local WebSocket server. */
class LiveSocketShapeTest {
    private lateinit var server: MockWebServer
    private val received = LinkedBlockingQueue<String>()

    @BeforeTest fun setUp() { server = MockWebServer().apply { start() } }
    @AfterTest fun tearDown() = server.close()

    private fun upgrade(onMessage: (WebSocket, String) -> Unit) = server.enqueue(MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) {
            received.add(text)
            onMessage(webSocket, text)
        }
        override fun onOpen(webSocket: WebSocket, response: Response) {}
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
    }).build())

    private val wsUrl get() = server.url("/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent").toString().replaceFirst("http", "ws")

    @Test fun dictationSessionSetupShape() = blocking {
        upgrade { ws, text ->
            if (text.contains("\"setup\"")) ws.send("""{"setupComplete":{}}""")
            if (text.contains("\"activityEnd\"")) {
                ws.send("""{"serverContent":{"inputTranscription":{"text":"Hello."}}}""")
            }
        }
        val transport = OkHttpLiveTransport({ "live-key" }, wsUrl)
        val session = LiveTranscriptionSession(transport, LiveSetup(model = GeminiModels.TRANSCRIBE_LIVE, smart = true, customVocabulary = listOf("Bento")))
        session.start()
        session.enqueue(ByteArray(3_200) { 1 })
        delay(100)
        val outcome = session.finish(3.0)
        assertEquals(LiveTranscriptionSession.Outcome.Completed("Hello."), outcome)
        val request = server.takeRequest()
        assertEquals("live-key", request.headers["x-goog-api-key"])
        assertEquals("/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent", request.url.encodedPath)
        assertNull(request.url.queryParameter("key"))

        val setup = VoiceJsonCompact.parseToJsonElement(received.poll(2, TimeUnit.SECONDS)!!).jsonObject["setup"]!!.jsonObject
        assertEquals("models/gemini-3.5-transcribe-live", setup["model"]!!.jsonPrimitive.content)
        assertEquals("TEXT", setup["generationConfig"]!!.jsonObject["responseModalities"]!!.jsonArray.single().jsonPrimitive.content)
        val transcription = setup["inputAudioTranscription"]!!.jsonObject
        assertEquals("SMART", transcription["mode"]!!.jsonPrimitive.content)
        assertEquals("Bento", transcription["customVocabulary"]!!.jsonArray.single().jsonPrimitive.content)
        assertEquals("true", setup["realtimeInputConfig"]!!.jsonObject["automaticActivityDetection"]!!.jsonObject["disabled"]!!.jsonPrimitive.content)
        assertEquals(LiveProtocol.activityStartFrame(), received.poll(2, TimeUnit.SECONDS))
        val audio = VoiceJsonCompact.parseToJsonElement(received.poll(2, TimeUnit.SECONDS)!!).jsonObject["realtimeInput"]!!.jsonObject["audio"]!!.jsonObject
        assertEquals("audio/pcm;rate=16000", audio["mimeType"]!!.jsonPrimitive.content)
        assertEquals(3_200, Base64.getDecoder().decode(audio["data"]!!.jsonPrimitive.content).size)
        assertEquals(LiveProtocol.activityEndFrame(), received.poll(2, TimeUnit.SECONDS))
    }

    @Test fun meetingSessionSetupShape() = blocking {
        upgrade { ws, text -> if (text.contains("\"setup\"")) ws.send("""{"setupComplete":{}}""") }
        val session = MeetingLiveSession(OkHttpLiveTransport({ "live-key" }, wsUrl),
            MeetingLiveProtocol.setupFrame(GeminiModels.TRANSCRIBE_LIVE, listOf("Priya")))
        session.start()
        session.abort()
        val setup = VoiceJsonCompact.parseToJsonElement(received.poll(2, TimeUnit.SECONDS)!!).jsonObject["setup"]!!.jsonObject
        assertEquals("models/gemini-3.5-transcribe-live", setup["model"]!!.jsonPrimitive.content)
        val transcription = setup["inputAudioTranscription"]!!.jsonObject
        assertEquals("VERBATIM", transcription["mode"]!!.jsonPrimitive.content)
        assertEquals("Priya", (transcription["customVocabulary"] as JsonArray).single().jsonPrimitive.content)
        assertNull(setup["realtimeInputConfig"], "meetings keep automatic activity detection")
        assertEquals("live-key", server.takeRequest().headers["x-goog-api-key"])
    }

    @Test fun refusedUpgradeFailsTheHandshake() = blocking {
        server.enqueue(MockResponse.Builder().code(403).body("forbidden").build())
        val transport = OkHttpLiveTransport({ "bad" }, wsUrl)
        assertFailsWith<Exception> { LiveTranscriptionSession(transport, LiveSetup()).start(2.0) }
        assertEquals(403, transport.ending.httpStatus)
    }

}
