package com.charles.bento.core.voice

import com.charles.bento.core.voice.audio.Pcm
import com.charles.bento.core.voice.dictation.DictationConfig
import com.charles.bento.core.voice.dictation.DictationEngine
import com.charles.bento.core.voice.dictation.DictationOutcome
import com.charles.bento.core.voice.gemini.GeminiClient
import com.charles.bento.core.voice.gemini.GeminiModels
import com.charles.bento.core.voice.meeting.MeetingConfig
import com.charles.bento.core.voice.meeting.MeetingEngine
import com.charles.bento.core.voice.meeting.MeetingRecorder
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import java.io.File
import java.security.MessageDigest
import java.time.ZoneId
import java.util.Base64
import java.util.Locale
import java.util.concurrent.TimeUnit
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.sin
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Real calls to the Gemini API, skipped unless GEMINI_API_KEY is set. Known speech is
 * generated with the TTS model (cached under build/, so reruns cost no TTS calls),
 * resampled to 16 kHz mono PCM16 and fed through the real pipeline: batch transcription
 * plus cleanup, a live dictation fed in real time, and a short meeting with a summary.
 * The key is read from the environment only and never printed.
 */
class GeminiEndToEndTest {
    private val key: String? = System.getenv("GEMINI_API_KEY")?.takeIf { it.isNotBlank() }
    private val http = OkHttpClient.Builder().callTimeout(90, TimeUnit.SECONDS).readTimeout(90, TimeUnit.SECONDS).build()

    @BeforeEach fun requireKey() = assumeTrue(key != null, "GEMINI_API_KEY not set: skipping the live Gemini tests")

    private fun log(message: String) = println("[e2e] $message")

    private fun words(text: String) = text.lowercase().split(Regex("[^\\p{L}\\p{N}]+")).filter { it.isNotEmpty() }.toSet()

    private fun assertHeard(text: String, vararg expected: String) {
        val heard = words(text)
        val missing = expected.filter { it.lowercase() !in heard }
        assertTrue(missing.isEmpty(), "missing $missing in: $text")
    }

    // MARK: - Speech

    private val dictationLine = "Please send the quarterly report to Margaret before Friday afternoon."
    private val meetingLines = "Okay everyone, let's start the budget review. We agreed to hire two engineers in January. " +
        "Priya will send the revised budget deck to the finance team by Friday. " +
        "Marcus will book a room for next week's planning session."

    /** 16 kHz mono PCM16 speech for `text`, from the TTS model (cached by text). */
    private fun speech(text: String): ShortArray {
        val digest = MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }.take(16)
        val cache = File("build/e2e-audio/$digest.pcm16")
        if (cache.exists()) return Pcm.toShorts(cache.readBytes())
        val body = """{"contents":[{"role":"user","parts":[{"text":${VoiceJsonCompact.encodeToString(kotlinx.serialization.json.JsonPrimitive.serializer(), kotlinx.serialization.json.JsonPrimitive(text))}}]}],""" +
            """"generationConfig":{"responseModalities":["AUDIO"],"speechConfig":{"voiceConfig":{"prebuiltVoiceConfig":{"voiceName":"Kore"}}}}}"""
        val request = Request.Builder()
            .url("${GeminiModels.ENDPOINT}/v1beta/models/$TTS_MODEL:generateContent")
            .header("x-goog-api-key", key!!)
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()
        val started = System.nanoTime()
        val json = http.newCall(request).execute().use { response ->
            val text = response.body.string()
            check(response.code == 200) { "TTS failed: HTTP ${response.code}" }
            VoiceJsonCompact.parseToJsonElement(text).jsonObject
        }
        val inline = json["candidates"]!!.jsonArray[0].jsonObject["content"]!!.jsonObject["parts"]!!.jsonArray
            .map { it.jsonObject }.first { it.containsKey("inlineData") }["inlineData"]!!.jsonObject
        val mime = inline["mimeType"]!!.jsonPrimitive.content
        val bytes = Base64.getDecoder().decode(inline["data"]!!.jsonPrimitive.content)
        val (rate, pcm) = decodeTts(bytes, mime)
        val samples = resample(pcm, rate, 16_000)
        log("TTS $TTS_MODEL: ${"%.1f".format(samples.size / 16_000.0)} s of speech ($mime) in ${ms(started)} ms")
        cache.parentFile.mkdirs()
        cache.writeBytes(Pcm.toBytes(samples))
        return samples
    }

    /** WAV (what the TTS model returns today) or raw L16 with the rate in the MIME type. */
    private fun decodeTts(bytes: ByteArray, mime: String): Pair<Int, ShortArray> {
        if (bytes.size > 12 && String(bytes, 0, 4, Charsets.US_ASCII) == "RIFF") {
            var position = 12
            var rate = 24_000
            while (position + 8 <= bytes.size) {
                val id = String(bytes, position, 4, Charsets.US_ASCII)
                val size = le32(bytes, position + 4)
                if (id == "fmt ") {
                    check(le16(bytes, position + 10) == 1 && le16(bytes, position + 22) == 16) { "TTS WAV is not mono 16-bit" }
                    rate = le32(bytes, position + 12)
                }
                if (id == "data") return rate to Pcm.toShorts(bytes, position + 8, minOf(size, bytes.size - position - 8))
                position += 8 + size + (size and 1)
            }
            error("TTS WAV has no data")
        }
        val rate = Regex("rate=(\\d+)").find(mime)?.groupValues?.get(1)?.toInt() ?: 24_000
        return rate to Pcm.toShorts(bytes)
    }

    private fun le16(b: ByteArray, at: Int) = (b[at].toInt() and 0xFF) or ((b[at + 1].toInt() and 0xFF) shl 8)
    private fun le32(b: ByteArray, at: Int) = le16(b, at) or (le16(b, at + 2) shl 16)

    /** Windowed-sinc resampling (low-passed below the new Nyquist). */
    private fun resample(input: ShortArray, from: Int, to: Int): ShortArray {
        if (from == to) return input
        val ratio = from.toDouble() / to
        val cutoff = 0.45 * minOf(1.0, to.toDouble() / from)
        val half = 16
        val out = ShortArray((input.size / ratio).toInt())
        for (i in out.indices) {
            val center = i * ratio
            val first = floor(center).toInt() - half
            var sum = 0.0
            var weights = 0.0
            for (k in first..first + 2 * half) {
                if (k < 0 || k >= input.size) continue
                val x = k - center
                val sinc = if (x == 0.0) 2 * cutoff else sin(2 * PI * cutoff * x) / (PI * x)
                val window = 0.5 + 0.5 * cos(PI * x / (half + 1))
                val w = sinc * window
                sum += input[k] * w
                weights += w
            }
            out[i] = (sum / weights).toInt().coerceIn(-32768, 32767).toShort()
        }
        return out
    }

    private fun ms(since: Long) = (System.nanoTime() - since) / 1_000_000

    private fun config(live: Boolean) = DictationConfig(
        apiKey = key!!,
        live = live,
        toneMatching = true,
        dictionary = listOf(DictionaryEntry("Margaret", "margret")),
        context = AppContext(packageName = "com.google.android.gm", appLabel = "Gmail", fieldHint = "Message"),
        // A phone on a real network: give cleanup more than the Mac's 1.5 s LAN budget so
        // the test exercises the cleanup model rather than its fallback.
        cleanupDeadline = 8.0,
    )

    // MARK: - Tests

    @Test fun batchTranscriptionPlusCleanup() = blocking {
        val samples = speech(dictationLine)
        val root = tempDir("e2e-batch")
        val engine = DictationEngine(root)
        val session = assertNotNull(engine.start(config(live = false)))
        var offset = 0
        while (offset < samples.size) {
            val n = minOf(1_600, samples.size - offset)
            session.feed(samples, offset, n)
            offset += n
        }
        val started = System.nanoTime()
        val outcome = assertIs<DictationOutcome.Transcribed>(session.stop(), "outcome")
        val result = outcome.result
        log("batch: '${result.text}' via ${result.modelID} in ${ms(started)} ms (raw: '${result.rawTranscript}')")
        assertHeard(result.text, "quarterly", "report", "Margaret", "Friday", "afternoon")
        assertEquals("gemini-3.5-transcribe/smart+gemini-3.5-flash-lite", result.modelID)
        assertTrue(!result.usedLive)
        assertEquals(result.text, engine.history.records().single().displayText)

        // Voice editing over the dictated text.
        val editStarted = System.nanoTime()
        val edit = engine.applyVoiceEdit("replace Friday with Thursday", result.text, config(live = false))
        log("voice edit: '${edit.revision}' in ${ms(editStarted)} ms")
        assertHeard(edit.revision, "Thursday", "Margaret")
        engine.close()
    }

    @Test fun liveDictationFedInRealTime() = blocking {
        val samples = speech(dictationLine)
        val root = tempDir("e2e-live")
        val engine = DictationEngine(root)
        val session = assertNotNull(engine.start(config(live = true)))
        val partials = ArrayList<String>()
        val collector = launch { session.partialTranscript.collect { if (it.isNotEmpty()) synchronized(partials) { partials += it } } }
        // 100 ms buffers every 90 ms: real time, slightly faster.
        val buffer = 1_600
        var offset = 0
        val feedStarted = System.nanoTime()
        while (offset < samples.size) {
            val n = minOf(buffer, samples.size - offset)
            session.feed(samples, offset, n)
            offset += n
            delay(90)
        }
        repeat(5) { session.feed(ShortArray(buffer)); delay(90) } // the room after the last word
        val stopped = System.nanoTime()
        val outcome = assertIs<DictationOutcome.Transcribed>(session.stop(), "outcome")
        collector.cancel()
        val result = outcome.result
        log("live: fed ${"%.1f".format(samples.size / 16_000.0)} s in ${(stopped - feedStarted) / 1_000_000} ms; final '${result.text}' via ${result.modelID} " +
            "${ms(stopped)} ms after stop; ${partials.size} partial(s), last '${partials.lastOrNull()}'; " +
            "live stats: ${engine.liveStats.summary}")
        assertTrue(result.usedLive, "the live transcript should be used (stats: ${engine.liveStats.summary})")
        assertTrue(result.modelID.startsWith(GeminiModels.TRANSCRIBE_LIVE), result.modelID)
        assertHeard(result.text, "quarterly", "report", "Margaret", "Friday")
        assertTrue(partials.isNotEmpty(), "partials should stream while speaking")
        engine.close()
    }

    @Test fun shortMeetingWithSummary() = blocking {
        val samples = speech(meetingLines)
        val root = tempDir("e2e-meeting")
        val engine = MeetingEngine(root).apply { locale = Locale.UK; zone = ZoneId.of("Europe/London") }
        val meetingConfig = MeetingConfig(apiKey = key!!, dictionary = listOf(DictionaryEntry("Priya")))
        val session = engine.start(meetingConfig)
        val connectStarted = System.nanoTime()
        val connection = withTimeout(10_000) { session.connection.first { it != MeetingRecorder.Connection.CONNECTING } }
        log("meeting live connection: $connection after ${ms(connectStarted)} ms")
        val buffer = 1_600
        var offset = 0
        while (offset < samples.size) {
            val n = minOf(buffer, samples.size - offset)
            session.feed(samples, offset, n)
            offset += n
            delay(90)
        }
        repeat(15) { session.feed(ShortArray(buffer)); delay(90) } // a pause so the last utterance ends
        val liveParagraphs = session.paragraphs.first()
        log("meeting live transcript before stop: ${liveParagraphs.size} paragraph(s): '${liveParagraphs.joinToString(" ") { it.text }}'")
        val stopped = System.nanoTime()
        val notes = session.stop()
        val meta = notes.document.meta
        log("meeting finished ${ms(stopped)} ms after stop; chunks ${meta.chunks.map { it.status }}; usage ${meta.usage}; " +
            "summary ${meta.summary}")
        log("meeting note:\n${notes.noteMarkdown}")
        assertEquals(MeetingRecorder.Connection.LIVE, connection)
        val summary = assertNotNull(notes.summary, "summary (error: ${meta.summaryError})")
        assertTrue(summary.title.isNotBlank())
        assertTrue(summary.actionItems.isNotEmpty())
        assertHeard(notes.document.plainTranscript, "budget", "engineers", "January", "Priya", "Friday", "Marcus")
        assertTrue(notes.noteMarkdown.startsWith("# ${summary.title}"))
        assertTrue(notes.noteMarkdown.contains("\n## Transcript\n"))
        assertTrue(notes.noteMarkdown.contains("- [ ] "))
        assertTrue(!notes.incomplete)
        engine.close()
    }

    @Test fun keyValidation() = blocking {
        assertEquals(GeminiClient.KeyCheck.Valid, GeminiClient({ key }).validateKey())
        assertIs<GeminiClient.KeyCheck.Rejected>(GeminiClient({ "not-a-key" }).validateKey())
    }

    private companion object {
        const val TTS_MODEL = "gemini-3.8-flash-tts"
    }
}
