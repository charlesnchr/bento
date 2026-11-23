package com.charles.bento.core.assistant.live

import com.charles.bento.core.assistant.live.CallProtocol.Companion.str
import com.charles.bento.core.voice.VoiceLog
import com.charles.bento.core.voicecore.VoiceCore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import java.util.concurrent.Executors

/**
 * A typed chat run by the shared voice core (`voice-core/`, its `medium: "text"`): the main
 * thread a voice call has, in text. Gemini (a text model, [ChatModel]) answers what it can itself
 * and hands the rest to Hermes as tasks in sessions of their own, several at once, with the same
 * tools and the same logic as [CoreCall]: follow-ups continue their task, an answer goes to the
 * task that asked, and `list_tasks`, `check_task` and `cancel_task` work. Nothing waits for a
 * task: the user can type on while Hermes works.
 *
 * This is the core's host for it on the phone: it makes the model's requests, runs the tasks in
 * Hermes ([onTool]) and passes on what the core says to show. One thread runs the core and
 * everything here ("bento-chat"), as in [CoreCall]; the callbacks are called on it.
 */
class CoreChat(
    /** The core's bundle, `voice-core/dist/voice-core.js`. */
    private val source: String,
    /** The chat's settings, merged over the core's defaults ([config]). */
    private val config: JsonObject,
    private val model: ChatModel,
    /** Runs one task in Hermes and returns its reply; cancelled when the task or the chat is. */
    private val onTool: suspend (HermesCall) -> ToolReply,
    private val clock: () -> Double = { System.nanoTime() / 1e9 },
    /** How often the core's timers run while the model is answering (a request that has gone quiet is given up). */
    private val tickMillis: Long = 250,
) {
    private val executor = Executors.newSingleThreadExecutor { run -> Thread(run, "bento-chat").apply { isDaemon = true } }
    private val scope = CoroutineScope(SupervisorJob() + executor.asCoroutineDispatcher())

    /** Gemini is writing its answer (or deciding to hand the message to Hermes). */
    private val _thinking = MutableStateFlow(false)
    val thinking: StateFlow<Boolean> = _thinking.asStateFlow()
    /** Tasks waiting for the user's answer, by key, with what Hermes asked. */
    private val _questions = MutableStateFlow<Map<String, String>>(emptyMap())
    val questions: StateFlow<Map<String, String>> = _questions.asStateFlow()
    /** Null while the chat is on; once it has ended, why (empty when it was simply stopped). */
    private val _ended = MutableStateFlow<String?>(null)
    val ended: StateFlow<String?> = _ended.asStateFlow()
    /** Gemini's words as they come: fragments with the same [line] are one message. */
    var onWords: ((line: Int, text: String) -> Unit)? = null
    /** Something the user should see that the chat survives: Gemini didn't answer, say. */
    var onError: ((String) -> Unit)? = null

    /** The build of the core this chat runs, once it has started. */
    @Volatile var version: String? = null
        private set

    // Everything below is the chat thread's.
    private var core: VoiceCore? = null
    private var id = 0
    private var started = false
    private var over = false
    private var tornDown = false
    private val queue = ArrayDeque<String>()
    private var pumping = false
    private val jobs = HashMap<String, Job>()
    private val requests = HashMap<Int, Job>()
    private var ticker: Job? = null

    /** Runs [block] on the chat's thread; one that throws ends the chat rather than the app. */
    private fun post(block: () -> Unit) {
        scope.launch {
            try {
                block()
            } catch (e: Exception) {
                VoiceLog.e(TAG, "the chat failed: ${e.message}")
                finish("The chat stopped: something in it failed. Completed actions were not undone.")
                tearDown()
            }
        }
    }

    fun start() = post {
        if (started || over) return@post
        started = true
        val first = try {
            val loaded = VoiceCore(source)
            core = loaded
            version = loaded.version
            VoiceLog.i(TAG, "the chat runs voice core ${loaded.version}")
            val created = Json.parseToJsonElement(loaded.create(config.toString(), clock())) as JsonObject
            id = (created["id"] as JsonPrimitive).intOrNull ?: error("the core gave the chat no id")
            created["commands"] as JsonArray
        } catch (e: Throwable) {
            // An Error too: a native library that won't load isn't an Exception.
            VoiceLog.e(TAG, "the voice core didn't start: $e")
            finish(LOAD_FAILED)
            tearDown()
            return@post
        }
        pump(first)
    }

    /** What the user typed. */
    fun say(text: String) = post { push(event("say") { put("text", text) }) }

    /** A task reply that landed outside this chat (e.g. a detached voice-call task): added to model context without triggering a turn. With [inHistory], the text is already in the startup recap; [id] identifies the task across updates and restarts. */
    fun note(label: String, text: String, failed: Boolean = false, inHistory: Boolean = false, id: String? = null) = post {
        push(event("note") {
            if (!id.isNullOrBlank()) put("id", id)
            put("label", label)
            put("text", text)
            if (failed) put("failed", true)
            if (inHistory) put("inHistory", true)
        })
    }

    /** The screen's progress line for a task, for check_task and list_tasks. */
    fun progress(taskId: String, text: String) = post { push(event("task.progress") { put("task", taskId); put("text", text) }) }

    /** Cancels one running task; the chat and the other tasks go on. */
    fun cancelTask(taskId: String) = post { push(event("cancelTask") { put("task", taskId) }) }

    /** Stops the answer Gemini is writing; tasks go on. */
    fun interrupt() = post { push(event("interrupt")) }

    /** Ends the chat; running Hermes tasks are cancelled, not undone. */
    fun stop() = post {
        if (over) return@post
        if (!started) { started = true; finish(""); tearDown(); return@post }
        push(event("stop"))
    }

    // The core: events in, commands out.

    private fun event(type: String, build: JsonObjectBuilder.() -> Unit = {}): String =
        buildJsonObject { put("t", clock()); put("type", type); build() }.toString()

    private fun push(event: String) {
        if (over || !started) return
        queue.addLast(event)
        pump(null)
    }

    /** Carries out [first], then gives the core each waiting event and carries out its answer, in order. */
    private fun pump(first: JsonArray?) {
        if (pumping) return
        pumping = true
        try {
            first?.let(::carryOut)
            while (!over) {
                val next = queue.removeFirstOrNull() ?: break
                val answer = core!!.push(id, next)
                if (answer.length > 2) carryOut(Json.parseToJsonElement(answer) as JsonArray)
            }
        } catch (e: Exception) {
            VoiceLog.e(TAG, "the chat's logic failed: ${e.message}")
            finish("The chat stopped: its logic failed. Completed actions were not undone.")
        } finally {
            pumping = false
            if (over) tearDown()
        }
    }

    private fun carryOut(commands: JsonArray) {
        for (command in commands) {
            if (over) return
            val c = command as? JsonObject ?: continue
            when (c.str("type")) {
                "llm.request" -> c.int("id")?.let { request(it, c.str("model").orEmpty(), c.str("body").orEmpty()) }
                "llm.cancel" -> requests.remove(c.int("id"))?.cancel()
                "thinking" -> thinking((c["on"] as? JsonPrimitive)?.booleanOrNull == true)
                "error" -> onError?.invoke(c.str("message").orEmpty())
                "tool.call" -> tool(c)
                "tool.cancel" -> jobs.remove(c.str("run"))?.cancel()
                // The phone can't add to a Hermes run that's underway: the core queues the follow-up instead.
                "tool.steer" -> push(event("tool.steerFailed") { put("run", c.str("run").orEmpty()); put("text", c.str("text").orEmpty()) })
                "transcript" -> if (c.str("role") == "assistant") c.int("line")?.let { onWords?.invoke(it, c.str("text").orEmpty()) }
                "questions" -> _questions.value = (c["questions"] as? JsonObject).orEmpty()
                    .mapNotNull { (task, asked) -> (asked as? JsonPrimitive)?.takeIf { it.isString }?.let { task to it.content } }.toMap()
                "status" -> if (c.str("status") == "ended") finish(c.str("message").orEmpty())
                "log" -> if (c.str("level") == "warn") VoiceLog.w(TAG, c.str("message").orEmpty()) else VoiceLog.i(TAG, c.str("message").orEmpty())
                // "task": the app follows a task through its Hermes turn. The user's own words it has already shown.
                else -> Unit
            }
        }
    }

    /** While Gemini answers, the core's timers run: one gives up a request that has gone quiet. */
    private fun thinking(on: Boolean) {
        _thinking.value = on
        ticker?.cancel()
        ticker = if (!on) null else scope.launch {
            while (true) {
                delay(tickMillis)
                push(event("tick"))
            }
        }
    }

    /** One request to the text model: each response of its stream goes to the core as it comes. */
    private fun request(request: Int, name: String, body: String) {
        requests[request] = scope.launch {
            try {
                model.generate(name, body).collect { data -> push(event("llm.data") { put("id", request); put("data", data) }) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (requests.remove(request) != null) {
                    push(event("llm.end") { put("id", request); put("error", e.message ?: e.javaClass.simpleName); (e as? ChatModelError)?.status?.let { put("status", it) } })
                }
                return@launch
            }
            if (requests.remove(request) != null) push(event("llm.end") { put("id", request) })
        }
    }

    private fun tool(c: JsonObject) {
        val run = c.str("run") ?: return
        if (c.str("kind") != "hermes" || c.str("agent") == "t3") {
            push(event("tool.error") { put("run", run); put("message", "Bento on the phone has no such tool.") })
            return
        }
        val request = HermesCall(
            id = run, task = c.str("request").orEmpty(), context = "", taskId = c.str("taskId").orEmpty(),
            followUp = (c["followUp"] as? JsonPrimitive)?.booleanOrNull == true, label = c.str("label").orEmpty(), message = c.str("message"),
        )
        jobs[run] = scope.launch {
            val reply = try {
                onTool(request)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (jobs.remove(run) != null) push(event("tool.error") { put("run", run); put("message", e.message.orEmpty()) })
                return@launch
            }
            if (jobs.remove(run) != null) push(event("tool.result") { put("run", run); put("text", reply.text); if (reply.failed) put("failed", true) })
        }
    }

    /** The chat is over: its requests and tasks stop, and the app is told. */
    private fun finish(message: String) {
        if (over) return
        over = true
        ticker?.cancel()
        for (job in requests.values) job.cancel()
        requests.clear()
        for (job in jobs.values) job.cancel()
        jobs.clear()
        queue.clear()
        _thinking.value = false
        _ended.value = message
    }

    private fun tearDown() {
        if (tornDown) return
        tornDown = true
        scope.cancel()
        core?.let { c -> runCatching { c.dispose(id); c.close() } }
        core = null
        executor.shutdown()
    }

    private fun JsonObject.int(key: String): Int? = (this[key] as? JsonPrimitive)?.intOrNull

    companion object {
        private const val TAG = "CoreChat"
        const val LOAD_FAILED = "The chat couldn't start: the voice core failed to load."

        /**
         * The phone's settings for a chat: the conversation it continues ([history], oldest first),
         * today's date for Hermes, and with [model] another text model than the core's own
         * (`models/…` on the Gemini API).
         */
        fun config(history: List<CoreCall.Line> = emptyList(), today: String, model: String? = null): JsonObject = buildJsonObject {
            put("medium", "text")
            put("platform", "Android")
            put("device", "phone")
            put("today", today)
            if (model != null) put("text", buildJsonObject { put("model", model) })
            putJsonArray("history") {
                for (line in history.takeLast(CoreCall.HISTORY_LINES)) addJsonObject {
                    put("role", line.role)
                    line.speaker?.let { put("speaker", it) }
                    put("text", line.text)
                    if (line.failed) put("failed", true)
                }
            }
        }
    }
}
