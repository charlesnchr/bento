package com.charles.bento.core.assistant.live

import com.charles.bento.core.voice.VoiceLog
import com.charles.bento.core.voice.blocking
import com.charles.bento.core.voice.live.OkHttpLiveTransport
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import java.io.File
import java.time.LocalDate
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicLong
import kotlin.test.Test
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The phone's host and the shared core in a real call, spoken with recorded clips: a question the
 * model answers itself, a request it hands to Hermes (faked here) and tells the result of, and a
 * goodbye that hangs up. Skipped unless VOICE_CORE_RELAY names the voice core's dev server
 * (voice-core/dev/server.mjs, `http://127.0.0.1:8770` on homelab), whose relay speaks to the model
 * with its own credentials, so nothing here spends the Gemini API key the phone uses.
 *
 *     VOICE_CORE_RELAY=http://127.0.0.1:8770 gradle :core:test --tests '*CoreCallLiveTest'
 *
 * The clips are the dev server's (`~/.local/share/voice-core/clips`, or VOICE_CORE_CLIPS): 16 kHz
 * mono WAVs made with voice-core/dev/tts.mjs.
 */
class CoreCallLiveTest {
    private val relay: String? = System.getenv("VOICE_CORE_RELAY")?.trimEnd('/')?.takeIf { it.isNotBlank() }
    private val clips = File(System.getenv("VOICE_CORE_CLIPS") ?: "${System.getProperty("user.home")}/.local/share/voice-core/clips")
    private val source = File(System.getProperty("voiceCore.dir") ?: "../../voice-core").resolve("dist/voice-core.js").readText()

    @BeforeEach fun requireRelay() {
        assumeTrue(relay != null, "VOICE_CORE_RELAY not set: skipping the live call through the dev server")
        assumeTrue(clips.resolve("capital.wav").isFile, "no clips in $clips: skipping the live call")
    }

    /** A microphone that gives a quiet room's noise in 20 ms frames, or a clip while one is being said; a speaker that counts. */
    private class ClipAudio : CallAudio {
        private val saying = ConcurrentLinkedQueue<ByteArray>()
        val played = AtomicLong()
        @Volatile var playedAt = 0L
        @Volatile var stopped = false
        val cues = CopyOnWriteArrayList<Earcon>()

        /** Says a 16 kHz mono PCM16 WAV into the call. */
        fun say(wav: File) {
            val bytes = wav.readBytes()
            val data = bytes.indexOfSlice("data".toByteArray()) + 8
            var at = data
            while (at < bytes.size) {
                saying.add(bytes.copyOfRange(at, minOf(bytes.size, at + 640)).copyOf(640))
                at += 640
            }
        }

        val speaking get() = saying.isNotEmpty()

        override fun start(onPcm: (ByteArray) -> Unit): Boolean {
            Thread {
                var next = System.nanoTime()
                while (!stopped) {
                    onPcm(saying.poll() ?: FakeAudio.QUIET.copyOf())
                    next += 20_000_000
                    val wait = next - System.nanoTime()
                    if (wait > 0) Thread.sleep(wait / 1_000_000, (wait % 1_000_000).toInt())
                }
            }.apply { isDaemon = true; start() }
            return true
        }

        override fun play(pcm: ByteArray) { played.addAndGet(pcm.size.toLong()); playedAt = System.nanoTime() }
        override fun cue(earcon: Earcon) { cues.add(earcon) }
        override fun flush() {}
        override fun restartMicrophone() {}
        override fun stop() { stopped = true }

        private fun ByteArray.indexOfSlice(slice: ByteArray): Int {
            for (i in 0..size - slice.size) if (slice.indices.all { this[i + it] == slice[it] }) return i
            error("not a WAV: no data chunk")
        }
    }

    @Test fun aSpokenCallAnswersHandsWorkToHermesAndHangsUp() = blocking {
        val http = relay!!
        val model = OkHttpClient().newCall(Request.Builder().url("$http/config").build()).execute().use {
            Json.parseToJsonElement(it.body.string()).jsonObject
        }
        // The relay speaks Vertex or the Gemini API, as the dev server is set up: the core is told which.
        val config = JsonObject(CoreCall.config(today = LocalDate.now().toString()) + mapOf(
            "api" to JsonPrimitive(if (model["route"]!!.jsonPrimitive.content == "vertex") "vertex" else "gemini"),
            "model" to model["model"]!!,
        ))
        val log = CopyOnWriteArrayList<String>()
        VoiceLog.sink = { level, tag, message -> log.add("$level $tag: $message") }
        val audio = ClipAudio()
        val asked = CopyOnWriteArrayList<HermesCall>()
        val said = CopyOnWriteArrayList<Pair<String, String>>()
        val call = CoreCall(
            source, config, { OkHttpLiveTransport({ "relay" }, endpoint = http.replaceFirst("http", "ws") + "/live") }, audio,
            onTool = { request ->
                asked.add(request)
                delay(1_500)
                ToolReply("The top story today: Copenhagen opened a new metro line to the airport, and it was on time.")
            },
        )
        call.onTranscript = { role, text -> said.add(role to text) }
        fun words(role: String) = said.filter { it.first == role }.joinToString("") { it.second }
        suspend fun quiet() {
            // The reply has played out: nothing new for a second and a half, and what came has had time to play.
            withTimeout(60_000) {
                while (audio.speaking || audio.playedAt == 0L || System.nanoTime() - audio.playedAt < 1_500_000_000L) delay(100)
            }
        }
        try {
            call.start()
            withTimeout(30_000) { call.status.first { it == AssistantCall.Status.Listening } }

            audio.say(clips.resolve("capital.wav"))
            withTimeout(30_000) { while (words("assistant").isBlank() || audio.played.get() == 0L) delay(100) }
            quiet()
            assertTrue(asked.isEmpty(), "a question the model knows is answered at once, without Hermes: ${words("assistant")}")

            val before = words("assistant").length
            audio.say(clips.resolve("news.wav"))
            withTimeout(40_000) { while (asked.isEmpty()) delay(100) }
            val request = asked.single()
            assertTrue(request.task.isNotBlank() && request.message!!.contains(request.task), "Hermes gets the user's own words: $request")
            withTimeout(60_000) { while (!words("assistant").drop(before).contains("metro", ignoreCase = true)) delay(100) }
            assertTrue(Earcon.TaskStarted in audio.cues && Earcon.ResultArrived in audio.cues, "the tones: ${audio.cues}")
            quiet()

            audio.say(clips.resolve("goodbye.wav"))
            val ended = withTimeout(30_000) { call.status.first { it is AssistantCall.Status.Ended } as AssistantCall.Status.Ended }
            assertNull(ended.message, "a goodbye ends the call cleanly")
            assertTrue(audio.stopped)
        } finally {
            call.stop()
            VoiceLog.sink = null
            println("core ${call.version}\n" + said.joinToString("\n") { "${it.first}: ${it.second}" } + "\nasked: ${asked.map { it.task }}\n" + log.joinToString("\n"))
        }
    }
}
