package com.charles.bento.core.assistant.live

import com.charles.bento.core.assistant.live.CallProtocol.Companion.str
import com.charles.bento.core.voice.VoiceLog
import com.charles.bento.core.voice.live.LiveSocketEnding
import com.charles.bento.core.voice.live.LiveTransport
import com.charles.bento.core.voicecore.VoiceCore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
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
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.addJsonObject
import java.util.Base64
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

/**
 * A voice call run by the shared voice core (`voice-core/`, [VoiceCore]): the same call logic the
 * web surface, the Mac and the Echo bridge run. The core decides everything (what goes to Gemini,
 * which turn a function call answers, tasks and follow-ups, when a result may go in, standby and
 * coming back, the goAway rotation, a lost connection, a dead microphone, the recap, "stop" and
 * "goodbye" said aloud); this is its host on the phone, which owns the sockets, the microphone,
 * the speaker and Hermes, and does what the core's commands say (voice-core/src/types.ts).
 *
 * One thread runs the core and everything here ("bento-call"): QuickJS wants a single thread, and
 * the core's answer to one event is carried out before the next goes in. Sockets are read and
 * written by coroutines on that thread; the microphone's frames cross from the audio thread
 * through a queue that drops the oldest when the call falls behind.
 *
 * What the core doesn't know stays here, as [AssistantCall] had it: captions of the user's speech
 * ([CallCaptions], [CaptionTracker]), the words said before the call connected ([opening]), and
 * the frames a dictation recorded while it had the microphone ([lend]), which never reach Gemini.
 */
class CoreCall(
    /** The core's bundle, `voice-core/dist/voice-core.js`. */
    private val source: String,
    /** The call's settings, merged over the core's defaults ([config]). */
    private val config: JsonObject,
    /** A new socket to Gemini Live: the first, one for each rotation, and one after standby. */
    private val transport: () -> LiveTransport,
    private val audio: CallAudio,
    /** Runs one task in Hermes and returns its reply; cancelled on explicit task cancellation, or when the call ends if [toolScope] is null. */
    private val onTool: suspend (HermesCall) -> ToolReply,
    private val ending: (LiveTransport) -> LiveSocketEnding = { LiveSocketEnding() },
    private val clock: () -> Double = { System.nanoTime() / 1e9 },
    /** Captions of the user's speech while Gemini hasn't transcribed it yet ([LiveCaptions]). */
    private val captions: CallCaptions? = null,
    /**
     * What the user said before the call's microphone opened (the words after a wake word): taken
     * once, just before it opens, and heard first. Called on the call's thread.
     */
    private val opening: (() -> ByteArray?)? = null,
    /** How often the core's timers get to run. */
    private val tickMillis: Long = 100,
    captionLinger: Double = 4.0,
    /**
     * Scope for dispatched Hermes tool runs. When set, tool runs outlive call hang-up/teardown and
     * are cancelled only on explicit task cancellation (`tool.cancel` with `reason: "cancelled"`).
     */
    private val toolScope: CoroutineScope? = null,
) : VoiceCall {
    private val executor = Executors.newSingleThreadExecutor { run -> Thread(run, "bento-call").apply { isDaemon = true } }
    private val scope = CoroutineScope(SupervisorJob() + executor.asCoroutineDispatcher())

    private val _status = MutableStateFlow<AssistantCall.Status>(AssistantCall.Status.Connecting)
    override val status: StateFlow<AssistantCall.Status> = _status.asStateFlow()
    private val _microphoneSilent = MutableStateFlow(false)
    override val microphoneSilent: StateFlow<Boolean> = _microphoneSilent.asStateFlow()
    private val _questions = MutableStateFlow<Map<String, String>>(emptyMap())
    override val questions: StateFlow<Map<String, String>> = _questions.asStateFlow()
    override var onTranscript: ((String, String) -> Unit)? = null
    override var onCaption: ((String?) -> Unit)? = null

    /** The build of the core this call runs, once it has started. */
    @Volatile var version: String? = null
        private set

    // Everything below is the call thread's, but for the fields marked volatile.
    private var core: VoiceCore? = null
    private var id = 0
    private var started = false
    @Volatile private var ended = false
    private var tornDown = false
    @Volatile private var mutedNow = false
    /** The core's latest status, as it names it. */
    private var coreStatus = "connecting"
    /** Events waiting for the core, and whether one is being answered now: a command that makes an event queues it. */
    /** The user ended the call by saying so. */
    private var hungUp = false
    private val queue = ArrayDeque<String>()
    private var pumping = false

    private class Sock(val transport: LiveTransport) {
        val out = Channel<String>(Channel.UNLIMITED)
        /** Microphone frames waiting to be written, and how many were when the core's answer now being carried out began. */
        var audioQueued = 0
        var audioBehind = 0
        var job: Job? = null
    }

    private val sockets = HashMap<Int, Sock>()
    private val jobs = HashMap<String, Job>()
    /** Dispatched tool runs executing in [toolScope]; cancelled only on explicit task cancellation, not call teardown. */
    private val toolJobs = HashMap<String, Job>()
    /** Microphone frames, each with the [lends] count it was captured under; when it's full the oldest goes ([offer]). */
    private val mic = Channel<Pair<Int, ByteArray>>(AssistantCall.MIC_FRAMES)
    private var micJob: Job? = null
    /** Microphone audio dropped because the call's thread or the socket fell behind, logged once a second. */
    private val droppedBytes = AtomicLong()
    /** The microphone is lent to a dictation ([lend]). */
    private var lent = false
    /** Counts [lend] and [reclaim]: a frame captured under an earlier count was the dictation's, or from before it. */
    @Volatile private var lends = 0
    private val tracker = CaptionTracker(captionLinger) { onCaption?.invoke(it) }

    /** Runs [block] on the call's thread; one that throws ends the call rather than the app. */
    private fun post(block: () -> Unit) {
        scope.launch {
            try {
                block()
            } catch (e: Exception) {
                VoiceLog.e(TAG, "the call failed: ${e.message}")
                finish("The call ended: something in it failed. Completed actions were not undone.")
                tearDown()
            }
        }
    }

    override var muted: Boolean
        get() = mutedNow
        set(value) {
            mutedNow = value
            post {
                if (!started) return@post // the call starts with it ([start])
                if (value) captions?.pause()
                push(event(if (value) "mute" else "unmute"))
            }
        }

    override fun start() = post {
        if (started || ended) return@post
        started = true
        val first = try {
            val loaded = VoiceCore(source)
            core = loaded
            version = loaded.version
            VoiceLog.i(TAG, "the call runs voice core ${loaded.version}")
            val settings = JsonObject(config + ("muted" to JsonPrimitive(mutedNow)))
            val created = Json.parseToJsonElement(loaded.create(settings.toString(), clock())) as JsonObject
            id = (created["id"] as JsonPrimitive).intOrNull ?: error("the core gave the call no id")
            created["commands"] as JsonArray
        } catch (e: Throwable) {
            // An Error too: a native library that won't load isn't an Exception.
            VoiceLog.e(TAG, "the voice core didn't start: $e")
            finish(LOAD_FAILED)
            tearDown()
            return@post
        }
        captions?.start { caption -> post { if (!ended) tracker.caption(caption, clock(), coreStatus == "standby") } }
        scope.launch {
            var logged = clock()
            while (true) {
                delay(tickMillis)
                val t = clock()
                tracker.tick(t)
                if (t - logged >= 1) {
                    logged = t
                    droppedBytes.getAndSet(0).takeIf { it > 0 }?.let { VoiceLog.w(TAG, "the call fell behind the microphone: dropped ${it / 32} ms of audio") }
                }
                push(event("tick"))
            }
        }
        pump(first)
    }

    override fun wake() = post { push(event("resume")) }

    override fun lend(): Boolean = try {
        executor.submit(Callable {
            // The core lends only in standby, and "standby" is its status exactly then: not once it's coming back.
            if (!started || ended || lent || coreStatus != "standby") return@Callable false
            lent = true
            lends++
            push(event("lend"))
            true
        }).get()
    } catch (e: Exception) {
        false // the call is over
    }

    override fun reclaim() = post {
        if (!lent) return@post
        lent = false
        lends++
        push(event("reclaim"))
    }

    override fun progress(taskId: String, text: String) = post { push(event("task.progress") { put("task", taskId); put("text", text) }) }

    override fun cancelTask(taskId: String) = post { push(event("cancelTask") { put("task", taskId) }) }

    override fun stop(message: String?) = post {
        if (ended) return@post
        if (!started) { started = true; finish(message); tearDown(); return@post }
        push(event("stop") { message?.let { put("message", it) } })
    }

    // The core: events in, commands out.

    private fun event(type: String, t: Double = clock(), build: JsonObjectBuilder.() -> Unit = {}): String =
        buildJsonObject { put("t", t); put("type", type); build() }.toString()

    private fun push(event: String) {
        if (ended || !started) return
        queue.addLast(event)
        pump(null)
    }

    /** Carries out [first], then gives the core each waiting event and carries out its answer, in order. */
    private fun pump(first: JsonArray?) {
        if (pumping) return
        pumping = true
        try {
            first?.let(::carryOut)
            while (!ended) {
                val next = queue.removeFirstOrNull() ?: break
                val answer = core!!.push(id, next)
                if (answer.length > 2) carryOut(Json.parseToJsonElement(answer) as JsonArray)
            }
        } catch (e: Exception) {
            VoiceLog.e(TAG, "the call's logic failed: ${e.message}")
            finish("The call ended: its logic failed. Completed actions were not undone.")
        } finally {
            pumping = false
            if (ended) tearDown()
        }
    }

    private fun carryOut(commands: JsonArray) {
        for (sock in sockets.values) sock.audioBehind = sock.audioQueued
        for (command in commands) {
            if (ended) return
            val c = command as? JsonObject ?: continue
            when (c.str("type")) {
                "ws.connect" -> c.int("sid")?.let(::connect)
                "ws.send" -> send(c.int("sid"), c.str("data").orEmpty())
                "ws.close" -> sockets.remove(c.int("sid"))?.let(::close)
                "mic.start" -> startMicrophone()
                "mic.restart" -> audio.restartMicrophone()
                // The microphone and the speaker stop together, when the call ends ([finish]).
                "mic.stop" -> Unit
                "play" -> c.str("pcm")?.let(::decode)?.let(audio::play)
                "flush" -> audio.flush()
                "cue" -> audio.cue(if (c.str("earcon") == "taskStarted") Earcon.TaskStarted else Earcon.ResultArrived)
                "tool.call" -> tool(c)
                "tool.cancel" -> {
                    val run = c.str("run")
                    jobs.remove(run)?.cancel()
                    if (c.str("reason") == "cancelled") toolJobs.remove(run)?.cancel() else toolJobs.remove(run)
                }
                // The phone can't add to a Hermes run that's underway: the core queues the follow-up instead.
                "tool.steer" -> push(event("tool.steerFailed") { put("run", c.str("run").orEmpty()); put("text", c.str("text").orEmpty()) })
                // The phone makes no spoken headlines of its own: Gemini tells the result.
                "brief" -> push(event("brief.failed") { put("id", c.str("id").orEmpty()) })
                "status" -> status(c.str("status").orEmpty(), c.str("message"))
                "transcript" -> transcript(c.str("role").orEmpty(), c.str("text").orEmpty())
                "questions" -> _questions.value = (c["questions"] as? JsonObject).orEmpty()
                    .mapNotNull { (task, asked) -> (asked as? JsonPrimitive)?.takeIf { it.isString }?.let { task to it.content } }.toMap()
                "micSilent" -> _microphoneSilent.value = (c["silent"] as? JsonPrimitive)?.booleanOrNull == true
                "log" -> if (c.str("level") == "warn") VoiceLog.w(TAG, c.str("message").orEmpty()) else VoiceLog.i(TAG, c.str("message").orEmpty())
                "voiceCommand" -> {
                    VoiceLog.i(TAG, "heard the spoken command ${c.str("command")}")
                    if (c.str("command") == "hangUp") hungUp = true
                }
                // "task" and "wakeword": the app follows a task through its Hermes turn, and the phone's
                // wake word starts calls, it doesn't interrupt them.
                else -> Unit
            }
        }
    }

    private fun status(name: String, message: String?) {
        coreStatus = name
        when (name) {
            "connecting" -> _status.value = AssistantCall.Status.Connecting
            "listening", "dormant" -> _status.value = AssistantCall.Status.Listening
            "working" -> _status.value = AssistantCall.Status.Working
            "standby" -> {
                _status.value = AssistantCall.Status.Standby
                captions?.pause()
                tracker.takeDown()
            }
            "waking" -> _status.value = AssistantCall.Status.Waking
            // The user said goodbye: the call just ends, as when they press the button. The core's "You hung up." is for a log.
            "ended" -> finish(message.takeUnless { hungUp })
        }
    }

    private fun transcript(role: String, text: String) {
        if (role == "user") tracker.userTranscript(clock(), text) { onTranscript?.invoke(role, text) }
        else onTranscript?.invoke(role, text)
    }

    /** The call is over: the audio and sockets stop, call-scoped waiters stop, and the app is told. */
    private fun finish(message: String?) {
        if (ended) return
        ended = true
        runCatching { audio.stop() }
        captions?.stop()
        mic.close()
        for (sock in sockets.values) close(sock)
        sockets.clear()
        for (job in jobs.values) job.cancel()
        jobs.clear()
        // Dispatched runs in toolScope outlive the call: drop references without cancelling them.
        toolJobs.clear()
        queue.clear()
        _status.value = AssistantCall.Status.Ended(message)
    }

    private fun tearDown() {
        if (tornDown) return
        tornDown = true
        scope.cancel()
        core?.let { c -> runCatching { c.dispose(id); c.close() } }
        core = null
        executor.shutdown()
    }

    // Sockets.

    private fun connect(sid: Int) {
        val sock = Sock(transport())
        sockets[sid] = sock
        sock.job = scope.launch {
            try {
                sock.transport.connect()
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                lost(sid, sock)
                return@launch
            }
            if (sockets[sid] !== sock) return@launch
            push(event("ws.open") { put("sid", sid) })
            // Writes wait for the socket to take them (its backpressure), one at a time and in order.
            launch {
                for (frame in sock.out) {
                    try {
                        sock.transport.send(frame)
                    } catch (e: Exception) {
                        if (e is CancellationException) throw e
                        lost(sid, sock)
                        return@launch
                    }
                    if (frame.startsWith(AUDIO_PREFIX)) sock.audioQueued--
                }
            }
            try {
                while (true) {
                    val frame = sock.transport.receive()
                    if (sockets[sid] !== sock) return@launch
                    val t = clock()
                    voiceActivity(frame, t)
                    push(event("ws.message", t) { put("sid", sid); put("data", frame) })
                }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                lost(sid, sock)
            }
        }
    }

    /** The socket closed or failed on its own: the core hears how, and decides whether the call goes on. */
    private fun lost(sid: Int, sock: Sock) {
        if (sockets[sid] !== sock) return
        sockets.remove(sid)
        val how = ending(sock.transport)
        sock.transport.close()
        push(event("ws.closed") {
            put("sid", sid)
            how.httpStatus?.let { put("httpStatus", it) }
            how.closeCode?.let { put("code", it) }
            how.closeReason?.let { put("reason", it) }
        })
        sock.job?.cancel()
    }

    private fun close(sock: Sock) {
        sock.transport.close()
        sock.job?.cancel()
    }

    private fun send(sid: Int?, frame: String) {
        val sock = sockets[sid] ?: return
        if (frame.startsWith(AUDIO_PREFIX)) {
            // What Gemini hears, the captioner hears.
            captions?.let { c -> decode(frame.substring(AUDIO_PREFIX.length, frame.length - AUDIO_SUFFIX.length))?.let(c::feed) }
            // A socket that has stopped taking audio loses the newest of it, never the call: nothing else is dropped.
            // It's behind by what waited before this answer: audio the core kept through standby or a
            // reconnect comes in one answer, however long, and is the start of what the user said.
            if (sock.audioBehind >= AUDIO_BACKLOG) { droppedBytes.addAndGet((frame.length - AUDIO_PREFIX.length) * 3L / 4); return }
            sock.audioQueued++
        }
        sock.out.trySend(frame)
    }

    /** Gemini's word that the user started or stopped speaking, for the captions: the core reads the frame for the rest. */
    private fun voiceActivity(frame: String, t: Double) {
        if (captions == null || !frame.contains("\"voiceActivity\"")) return
        val activity = runCatching { (Json.parseToJsonElement(frame) as? JsonObject)?.get("voiceActivity") as? JsonObject }.getOrNull()
        when (activity?.str("type")) {
            "ACTIVITY_START" -> tracker.activityStarted(t)
            "ACTIVITY_END" -> tracker.activityEnded(t)
        }
    }

    // The microphone.

    private fun startMicrophone() {
        // Taken before the microphone opens: whoever recorded it lets go of the microphone first.
        val before = runCatching { opening?.invoke() }.getOrNull()
        val ok = audio.start { pcm -> offer(lends to pcm) }
        if (!ok) { push(event("stop") { put("message", "Couldn't open the microphone.") }); return }
        if (before != null && before.isNotEmpty()) {
            VoiceLog.i(TAG, "the call starts with ${before.size / 32} ms said before it connected")
            var at = 0
            while (at < before.size) {
                push(micEvent(before.copyOfRange(at, minOf(before.size, at + AssistantCall.OPENING_CHUNK))))
                at += AssistantCall.OPENING_CHUNK
            }
        }
        if (micJob == null) micJob = scope.launch {
            for ((captured, pcm) in mic) {
                if (ended) return@launch
                // A dictation's frames, or ones from before it, are never the call's.
                if (captured != lends) continue
                push(micEvent(pcm))
            }
        }
    }

    private fun micEvent(pcm: ByteArray) = "{\"t\":${clock()},\"type\":\"mic\",\"pcm\":\"${Base64.getEncoder().encodeToString(pcm)}\"}"

    /** Queues a microphone frame for the call's thread; one behind (a busy phone) loses the oldest audio, never the call. Audio thread. */
    private fun offer(frame: Pair<Int, ByteArray>) {
        val result = mic.trySend(frame)
        if (result.isSuccess || result.isClosed) return
        mic.tryReceive().getOrNull()?.let { droppedBytes.addAndGet(it.second.size.toLong()) }
        if (mic.trySend(frame).isFailure && !mic.isClosedForSend) droppedBytes.addAndGet(frame.second.size.toLong())
    }

    // Hermes.

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
        val external = toolScope
        if (external != null) {
            // Hoist onTool so the decoupled coroutine does not retain this CoreCall after teardown.
            val runTool = onTool
            val outcome = CompletableDeferred<Result<ToolReply>>()
            val work = external.launch {
                val result = try {
                    Result.success(runTool(request))
                } catch (e: CancellationException) {
                    outcome.cancel(e)
                    throw e
                } catch (e: Exception) {
                    Result.failure(e)
                }
                outcome.complete(result)
            }
            toolJobs[run] = work
            jobs[run] = scope.launch {
                val result = try {
                    outcome.await()
                } catch (e: CancellationException) {
                    throw e
                } finally {
                    toolJobs.remove(run, work)
                }
                if (jobs.remove(run) != null) {
                    result.fold(
                        onSuccess = { reply -> push(event("tool.result") { put("run", run); put("text", reply.text); if (reply.failed) put("failed", true) }) },
                        onFailure = { e -> push(event("tool.error") { put("run", run); put("message", e.message.orEmpty()) }) },
                    )
                }
            }
        } else {
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
    }

    private fun JsonObject.int(key: String): Int? = (this[key] as? JsonPrimitive)?.intOrNull

    private fun decode(base64: String): ByteArray? = runCatching { Base64.getDecoder().decode(base64) }.getOrNull()?.takeIf { it.isNotEmpty() }

    /** One line of the conversation a call continues, as the core recaps it to Gemini. */
    data class Line(val role: String, val text: String, val speaker: String? = null, val failed: Boolean = false)

    companion object {
        private const val TAG = "CoreCall"
        const val LOAD_FAILED = "The call couldn't start: the voice core failed to load. Settings → Hermes → Call engine has the built-in call."
        /** How the core frames microphone audio for Gemini (voice-core/src/call.ts, audioFrameOf). */
        internal const val AUDIO_PREFIX = "{\"realtimeInput\":{\"audio\":{\"mimeType\":\"audio/pcm;rate=16000\",\"data\":\""
        internal const val AUDIO_SUFFIX = "\"}}}"
        /** Two seconds of 20 ms microphone frames may wait for a slow socket; more are dropped, but for audio the core replays at once ([send]). */
        const val AUDIO_BACKLOG = 100
        /** The most lines of the conversation handed to the core: it recaps the latest that fit. */
        const val HISTORY_LINES = 200

        /**
         * The phone's settings for the core: the conversation the call continues ([history], oldest
         * first), today's date for Hermes, the standby and hang-up times in seconds (0 = never),
         * and any of the core's limits to change (tests shorten them).
         */
        fun config(
            history: List<Line> = emptyList(),
            today: String,
            standbyAfter: Double = 0.0,
            hangUpAfter: Double = 0.0,
            limits: Map<String, Double> = emptyMap(),
        ): JsonObject = buildJsonObject {
            put("api", "gemini")
            put("platform", "Android")
            put("device", "phone")
            put("today", today)
            put("reconnect", true)
            put("standbyAfter", standbyAfter)
            put("hangUpAfter", hangUpAfter)
            putJsonArray("history") {
                for (line in history.takeLast(HISTORY_LINES)) addJsonObject {
                    put("role", line.role)
                    line.speaker?.let { put("speaker", it) }
                    put("text", line.text)
                    if (line.failed) put("failed", true)
                }
            }
            if (limits.isNotEmpty()) put("limits", buildJsonObject { for ((name, value) in limits) put(name, value) })
        }
    }
}
