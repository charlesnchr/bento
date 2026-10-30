package com.charles.bento.core.assistant.live

import com.charles.bento.core.voice.blocking
import com.charles.bento.core.voice.gemini.GeminiModels
import com.charles.bento.core.voice.live.OkHttpLiveTransport
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Base64
import java.util.Locale
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The call's setup against the real Gemini API, skipped unless GEMINI_API_KEY is set: the
 * model accepts it, and a request it can't answer itself becomes an `ask_hermes` call.
 * Text in, so it costs a few hundred tokens; the captions test streams about 20 seconds of speech.
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

    /**
     * Why calls have captions. Real speech (Gemini TTS) goes in real time into the call's Gemini
     * Live session and into [LiveCaptions] side by side, and the test prints when each heard it.
     * On 2026-10-30 gemini-3.8-live sent its whole inputTranscription 0.9 s after 12.4 s of
     * speech ended, nothing before; the captioner's first guess came 1.2 s into it.
     */
    @Test fun captionsArriveWhileTheUserIsStillSpeaking() = blocking {
        val pcm = speech("Could you ask Hermes to look up the weather in London for this weekend, and then check whether " +
            "my dentist appointment on Thursday is still at ten in the morning?")
        val live = OkHttpLiveTransport({ key!! })
        val captions = LiveCaptions({ OkHttpLiveTransport({ key!! }) })
        val log = CopyOnWriteArrayList<String>()
        var start = 0L
        fun at() = (System.nanoTime() - start) / 1e9
        fun note(what: String) { log.add(String.format(Locale.ROOT, "%6.2fs %s", at(), what)) }
        var firstCaption: Double? = null
        var geminiHeard: Double? = null
        try {
            live.connect()
            live.send(CallSetup.setupFrame())
            withTimeout(20_000) { while (Json.parseToJsonElement(live.receive()).jsonObject["setupComplete"] == null) Unit }
            start = System.nanoTime()
            captions.start { c ->
                if (c is Caption.Partial && firstCaption == null) firstCaption = at()
                note("caption $c")
            }
            val reader = launch {
                while (true) {
                    val o = Json.parseToJsonElement(live.receive()).jsonObject
                    o["voiceActivity"]?.let { note("Gemini Live voiceActivity $it") }
                    o["serverContent"]?.jsonObject?.get("inputTranscription")?.let {
                        if (geminiHeard == null) geminiHeard = at()
                        note("Gemini Live inputTranscription $it")
                    }
                    o["toolCall"]?.jsonObject?.get("functionCalls")?.jsonArray?.forEach { call ->
                        val id = call.jsonObject["id"]!!.jsonPrimitive.content
                        live.send(CallProtocol.response(id, message = "Not executed: test.", executed = false))
                    }
                }
            }
            val silence = ByteArray(640)
            val frames = pcm.toList().chunked(640).map { it.toByteArray() } + List(150) { silence }
            for ((i, frame) in frames.withIndex()) {
                if (i == frames.size - 150) note("speech ended")
                live.send(AssistantCall.audioFrame(frame))
                captions.feed(frame)
                // Real time, as a microphone delivers it.
                val due = start + (i + 1) * 20_000_000L
                delay(maxOf(0L, (due - System.nanoTime()) / 1_000_000))
            }
            reader.cancel()
        } finally {
            captions.stop()
            live.close()
        }
        val speechEnded = pcm.size / 32_000.0
        println("Speech: %.1f s\n%s".format(Locale.ROOT, speechEnded, log.joinToString("\n")))
        val caption = firstCaption
        assertTrue(caption != null && caption < speechEnded - 2, "a caption arrives while the user is speaking (first at $caption s of $speechEnded s)")
        assertTrue(geminiHeard != null, "Gemini Live transcribed the speech")
    }

    /** [text] spoken by Gemini TTS, as the call's microphone would deliver it: 16 kHz mono PCM16. */
    private suspend fun speech(text: String): ByteArray = withContext(Dispatchers.IO) {
        val body = """{"contents":[{"parts":[{"text":${Json.encodeToString(String.serializer(), text)}}]}],""" +
            """"generationConfig":{"responseModalities":["AUDIO"],"speechConfig":{"voiceConfig":{"prebuiltVoiceConfig":{"voiceName":"Kore"}}}}}"""
        val request = Request.Builder().url("${GeminiModels.ENDPOINT}/v1beta/models/$TTS_MODEL:generateContent")
            .header("x-goog-api-key", key!!).post(body.toRequestBody("application/json".toMediaType())).build()
        val client = OkHttpClient.Builder().readTimeout(60, TimeUnit.SECONDS).build()
        val reply = client.newCall(request).execute().use { it.body!!.string() }
        val inline = Json.parseToJsonElement(reply).jsonObject["candidates"]!!.jsonArray[0].jsonObject["content"]!!
            .jsonObject["parts"]!!.jsonArray[0].jsonObject["inlineData"]!!.jsonObject
        val audio = Base64.getDecoder().decode(inline["data"]!!.jsonPrimitive.content)
        val mime = inline["mimeType"]!!.jsonPrimitive.content
        val (rate, samples) = if (String(audio, 0, 4) == "RIFF") wav(audio) else
            (Regex("rate=(\\d+)").find(mime)?.groupValues?.get(1)?.toInt() ?: 24_000) to audio
        resample(samples, rate, 16_000)
    }

    /** The sample rate and PCM16 data of a WAV file. */
    private fun wav(bytes: ByteArray): Pair<Int, ByteArray> {
        val b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        var rate = 24_000
        var at = 12
        while (at + 8 <= bytes.size) {
            val id = String(bytes, at, 4)
            val size = b.getInt(at + 4)
            if (id == "fmt ") rate = b.getInt(at + 12)
            if (id == "data") return rate to bytes.copyOfRange(at + 8, minOf(bytes.size, at + 8 + size))
            at += 8 + size + (size and 1)
        }
        error("no data chunk")
    }

    private fun resample(pcm: ByteArray, from: Int, to: Int): ByteArray {
        val input = ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
        val n = input.remaining()
        val out = ByteBuffer.allocate((n.toLong() * to / from).toInt() * 2).order(ByteOrder.LITTLE_ENDIAN)
        for (i in 0 until out.capacity() / 2) {
            val x = i.toDouble() * from / to
            val j = x.toInt().coerceAtMost(n - 1)
            val k = (j + 1).coerceAtMost(n - 1)
            out.putShort((input[j] + (input[k] - input[j]) * (x - j)).toInt().toShort())
        }
        return out.array()
    }

    private companion object {
        const val TTS_MODEL = "gemini-3.8-flash-tts"
    }
}
