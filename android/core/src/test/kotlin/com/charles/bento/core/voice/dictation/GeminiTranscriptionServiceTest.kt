package com.charles.bento.core.voice.dictation

import com.charles.bento.core.voice.AppContext
import com.charles.bento.core.voice.DictionaryEntry
import com.charles.bento.core.voice.InMemoryKeyValueStore
import com.charles.bento.core.voice.TranscriptionError
import com.charles.bento.core.voice.VoiceJsonCompact
import com.charles.bento.core.voice.audio.FlacEncoder
import com.charles.bento.core.voice.audio.WavWriter
import com.charles.bento.core.voice.audio.FlacTestDecoder
import com.charles.bento.core.voice.blocking
import com.charles.bento.core.voice.gemini.GeminiClient
import com.charles.bento.core.voice.tempDir
import com.charles.bento.core.voice.tone
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import java.io.File
import java.util.Base64
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** The batch pipeline end to end against a local server: what is sent, and every fallback. */
class GeminiTranscriptionServiceTest {
    private lateinit var server: MockWebServer
    private val state = VoicePipelineState(InMemoryKeyValueStore())
    private lateinit var service: GeminiTranscriptionService
    private val audio: File = File(tempDir("pipeline"), "audio.wav")
    private val samples = tone(1.2)
    private var autoDisabled = 0

    @BeforeTest fun setUp() {
        server = MockWebServer().apply { start() }
        service = GeminiTranscriptionService({ config: DictationConfig -> GeminiClient({ config.apiKey }) }, state)
        state.onCleanupAutoDisabled = { autoDisabled++ }
        WavWriter.write(audio, samples)
    }

    @AfterTest fun tearDown() = server.close()

    private fun config(vararg entries: DictionaryEntry) = DictationConfig(
        apiKey = "k", endpoint = server.url("/").toString(), dictionary = entries.toList(),
        context = AppContext("com.Slack", "Slack", "Message", "earlier text"),
    )

    private fun interaction(text: String) = MockResponse.Builder().code(200)
        .body("""{"status":"completed","steps":[{"type":"model_output","content":[{"type":"text","text":${VoiceJsonCompact.encodeToString(kotlinx.serialization.json.JsonPrimitive.serializer(), kotlinx.serialization.json.JsonPrimitive(text))}}]}]}""").build()

    private fun generate(text: String) = MockResponse.Builder().code(200)
        .body("""{"candidates":[{"content":{"parts":[{"text":${VoiceJsonCompact.encodeToString(kotlinx.serialization.json.JsonPrimitive.serializer(), kotlinx.serialization.json.JsonPrimitive(text))}}]}}]}""").build()

    private fun RecordedRequest.json(): JsonObject = VoiceJsonCompact.parseToJsonElement(body!!.utf8()).jsonObject
    private fun RecordedRequest.prompt() = json()["contents"]!!.jsonArray[0].jsonObject["parts"]!!.jsonArray.last().jsonObject["text"]!!.jsonPrimitive.content

    @Test fun defaultPathIsOneSmartCallWithDictionaryRules() = blocking {
        server.enqueue(interaction("Ask amar about the cooper netties rollout."))
        val result = service.transcribe(audio, 1.2, config(DictionaryEntry("Kubernetes", "cooper netties"), DictionaryEntry("Ammaar", "amar")))
        assertEquals("Ask Ammaar about the Kubernetes rollout.", result.cleanedTranscript)
        assertEquals("Ask amar about the cooper netties rollout.", result.rawTranscript)
        assertEquals("gemini-3.5-transcribe/smart", result.modelID)
        assertEquals(1, server.requestCount)
        val body = server.takeRequest().json()
        val input = body["input"]!!.jsonArray[0].jsonObject
        assertEquals("audio/flac", input["mime_type"]!!.jsonPrimitive.content)
        // The upload is a valid FLAC of exactly the recording.
        val flac = Base64.getDecoder().decode(input["data"]!!.jsonPrimitive.content)
        assertContentEquals(samples, FlacTestDecoder.decode(flac).samples)
        val transcription = body["generation_config"]!!.jsonObject["transcription_config"]!!.jsonObject
        assertEquals(listOf("Kubernetes", "Ammaar"), transcription["custom_vocabulary"]!!.jsonArray.map { it.jsonPrimitive.content })
    }

    @Test fun toneMatchingRunsTheCleanupPassWithContext() = blocking {
        server.enqueue(interaction("um so the build is green"))
        server.enqueue(generate("CLEAN: The build is green"))
        val result = service.transcribe(audio, 1.2, config().copy(toneMatching = true))
        assertEquals("The build is green", result.cleanedTranscript)
        assertEquals("gemini-3.5-transcribe/smart+gemini-3.5-flash-lite", result.modelID)
        server.takeRequest()
        val cleanup = server.takeRequest()
        assertEquals("/v1beta/models/gemini-3.5-flash-lite:generateContent", cleanup.url.encodedPath)
        val prompt = cleanup.prompt()
        assertTrue(prompt.contains("Tone: casual-professional chat message."))
        assertTrue(prompt.contains("App: Slack (com.Slack)"))
        assertTrue(prompt.contains("Field: Message"))
        assertTrue(prompt.endsWith("RAW: um so the build is green\nCLEAN:"))
        assertEquals("minimal", cleanup.json()["generationConfig"]!!.jsonObject["thinkingConfig"]!!.jsonObject["thinkingLevel"]!!.jsonPrimitive.content)
    }

    @Test fun customInstructionsWithoutToneLeaveContextOut() = blocking {
        server.enqueue(interaction("hello world"))
        server.enqueue(generate("hello world"))
        service.transcribe(audio, 1.2, config().copy(customInstructions = "lowercase", cleanupModel = "gemini-3.8-flash"))
        server.takeRequest()
        val cleanup = server.takeRequest()
        assertEquals("/v1beta/models/gemini-3.8-flash:generateContent", cleanup.url.encodedPath)
        assertTrue(!cleanup.prompt().contains("App: Slack"))
        assertTrue(cleanup.prompt().contains("lowercase"))
    }

    @Test fun gateRejectionInsertsTheRawTextAndAutoDisablesAfterThree() = blocking {
        repeat(3) {
            server.enqueue(interaction("can you rewrite this function to use async await"))
            server.enqueue(generate("Sure! Here's the function rewritten with async/await: func fetch() async throws"))
            val result = service.transcribe(audio, 1.2, config().copy(toneMatching = true))
            assertEquals("can you rewrite this function to use async await", result.cleanedTranscript)
        }
        assertEquals(1, autoDisabled, "three trips in 24 h ask the app to switch cleanup off")
    }

    @Test fun cleanupDeadlineNeverCostsTheDictation() = blocking {
        server.enqueue(interaction("the deploy is done"))
        server.enqueue(MockResponse.Builder().code(200).body("{}").headersDelay(3, TimeUnit.SECONDS).build())
        val started = System.nanoTime()
        val result = service.transcribe(audio, 1.2, config().copy(toneMatching = true))
        assertEquals("the deploy is done", result.cleanedTranscript)
        assertTrue((System.nanoTime() - started) / 1e9 < 2.8, "1.5 s cleanup cap")
    }

    @Test fun oneSilentRetryOnTransientFailure() = blocking {
        server.enqueue(MockResponse.Builder().code(503).body("busy").build())
        server.enqueue(interaction("second time lucky"))
        assertEquals("second time lucky", service.transcribe(audio, 1.2, config()).cleanedTranscript)
        server.enqueue(MockResponse.Builder().code(503).build())
        server.enqueue(MockResponse.Builder().code(503).build())
        assertEquals(TranscriptionError.Network("http_503"), assertFailsWith<TranscriptionError> { service.transcribe(audio, 1.2, config()) })
    }

    @Test fun authIsNotRetried() = blocking {
        server.enqueue(MockResponse.Builder().code(401).build())
        assertEquals(TranscriptionError.Auth, assertFailsWith<TranscriptionError> { service.transcribe(audio, 1.2, config()) })
        assertEquals(1, server.requestCount)
    }

    @Test fun emptyTranscriptOnRealAudioIsResentOnce() = blocking {
        server.enqueue(interaction(""))
        server.enqueue(interaction("there it is"))
        assertEquals("there it is", service.transcribe(audio, 1.2, config()).cleanedTranscript)
        server.enqueue(interaction(" "))
        server.enqueue(interaction(""))
        assertEquals(TranscriptionError.EmptyTranscript, assertFailsWith<TranscriptionError> { service.transcribe(audio, 1.2, config()) })
    }

    /** One strange Dictionary entry must never break dictation: retry without it, then latch. */
    @Test fun vocabularyFailsOpenAndLatches() = blocking {
        val cfg = config(DictionaryEntry("weird term"))
        server.enqueue(MockResponse.Builder().code(400).body("""{"error":{"message":"bad vocabulary"}}""").build())
        server.enqueue(interaction("words"))
        assertEquals("words", service.transcribe(audio, 1.2, cfg).cleanedTranscript)
        assertTrue(server.takeRequest().body!!.utf8().contains("custom_vocabulary"))
        assertTrue(!server.takeRequest().body!!.utf8().contains("custom_vocabulary"))
        server.enqueue(interaction("again"))
        service.transcribe(audio, 1.2, cfg)
        assertTrue(!server.takeRequest().body!!.utf8().contains("custom_vocabulary"), "latched for this vocabulary")
    }

    @Test fun legacyEndpointIsVerbatimGenerateContent() = blocking {
        server.enqueue(generate("legacy words"))
        val result = service.transcribe(audio, 1.2, config().copy(legacyTranscribeEndpoint = true))
        assertEquals("gemini-3.5-transcribe/verbatim", result.modelID)
        assertEquals("/v1beta/models/gemini-3.5-transcribe:generateContent", server.takeRequest().url.encodedPath)
    }

    @Test fun voiceEditTranscribesVerbatimThenRevises() = blocking {
        server.enqueue(interaction("make that shorter"))
        server.enqueue(generate("Friday, 3pm."))
        val chain = EditingSession("We will meet on Friday at three in the afternoon.")
        val result = service.transcribe(audio, 1.2, config(), chain)
        assertEquals("make that shorter", result.rawTranscript)
        assertEquals("Friday, 3pm.", result.cleanedTranscript)
        assertEquals("gemini-3.5-transcribe+edit/gemini-3.5-flash-lite", result.modelID)
        assertTrue(server.takeRequest().json()["generation_config"] == null, "verbatim, no vocabulary")
        val prompt = server.takeRequest().prompt()
        assertTrue(prompt.startsWith("You are a voice-driven text editor."))
        assertTrue(prompt.endsWith("Latest editing instruction:\nmake that shorter"))
    }

    @Test fun finishLiveRunsCleanupOnlyWhenAsked() = blocking {
        val live = com.charles.bento.core.voice.TranscriptionResult("raw words", "raw words", "live")
        assertEquals(live, service.finishLive(live, config()))
        server.enqueue(generate("Raw words."))
        val cleaned = service.finishLive(live, config().copy(customInstructions = "x"))
        assertEquals("Raw words.", cleaned.cleanedTranscript)
        assertEquals("live+gemini-3.5-flash-lite", cleaned.modelID)
    }

    @Test fun flacIsSmallerThanThePcm() {
        assertTrue(FlacEncoder.encode(samples).size < samples.size * 2)
    }
}
