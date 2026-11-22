package com.charles.bento.core.assistant.live

import com.charles.bento.core.voice.blocking
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import java.io.File
import java.time.LocalDate
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The phone's host and the shared core in a real typed chat: a question the text model answers
 * itself, a request it hands to Hermes (faked here) while the chat goes on, and a follow-up that
 * continues the task. Skipped unless VOICE_CORE_RELAY names the voice core's dev server
 * (voice-core/dev/server.mjs), whose /generate speaks to the model with its own credentials, so
 * nothing here spends the Gemini API key the phone uses.
 *
 *     VOICE_CORE_RELAY=http://127.0.0.1:8770 gradle :core:test --tests '*CoreChatLiveTest'
 */
class CoreChatLiveTest {
    private val relay: String? = System.getenv("VOICE_CORE_RELAY")?.trimEnd('/')?.takeIf { it.isNotBlank() }
    private val source = File(System.getProperty("voiceCore.dir") ?: "../../voice-core").resolve("dist/voice-core.js").readText()

    @BeforeEach fun requireRelay() {
        assumeTrue(relay != null, "VOICE_CORE_RELAY not set: skipping the live chat through the dev server")
    }

    @Test fun aRealChatAnswersHandsWorkToHermesAndFollowsItUp() = blocking {
        val lines = LinkedHashMap<Int, String>()
        val errors = CopyOnWriteArrayList<String>()
        val asked = CopyOnWriteArrayList<HermesCall>()
        val model = GeminiChatModel({ null }, OkHttpClient()) { "$relay/generate" }
        val chat = CoreChat(source, CoreChat.config(today = LocalDate.now().toString()), model, onTool = { call ->
            asked.add(call)
            delay(1500)
            ToolReply(if (call.followUp) "The day after: rain, 9 degrees." else "Tomorrow in Copenhagen: sunny, 12 degrees.")
        })
        chat.onWords = { line, text -> synchronized(lines) { lines[line] = (lines[line] ?: "") + text } }
        chat.onError = { errors.add(it) }
        fun said() = synchronized(lines) { lines.values.toList() }
        suspend fun settled(what: String, check: () -> Boolean) = try {
            withTimeout(60_000) { while (!check()) delay(50) }
        } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
            throw AssertionError("timed out waiting for $what; said ${said()}, errors $errors, asked ${asked.map { it.task }}")
        }
        chat.start()

        chat.say("What is the capital of Denmark? Answer in one word.")
        settled("the model's own answer") { said().size == 1 && !chat.thinking.value }
        assertTrue(said()[0].contains("Copenhagen"), said().toString())
        assertTrue(asked.isEmpty())

        chat.say("Look up the weather in Copenhagen for tomorrow on the web.")
        settled("the hand-off") { asked.size == 1 }
        assertEquals("Look up the weather in Copenhagen for tomorrow on the web.", asked[0].task)
        // The chat goes on while Hermes works.
        chat.say("Meanwhile, what is 12 times 12? Just the number.")
        settled("the answer during the task") { said().any { it.contains("144") } && !chat.thinking.value }
        delay(2000)

        chat.say("And the day after tomorrow?")
        settled("the follow-up") { asked.size == 2 }
        assertEquals("1", asked[1].taskId)
        assertTrue(asked[1].followUp)
        assertTrue(errors.isEmpty(), errors.toString())
        chat.stop()
    }
}
