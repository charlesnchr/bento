package com.charles.bento.core.assistant.live

import com.charles.bento.core.assistant.live.CallProtocol.Companion.str
import com.charles.bento.core.voice.live.LiveSocketEnding
import com.charles.bento.core.voice.live.LiveTransport
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.util.Base64

/** The call's audio: microphone in (16 kHz PCM16) and the voice out (24 kHz PCM16). */
interface CallAudio {
    /** Starts the microphone; [onPcm] gets frames on the audio thread. False when it can't open. */
    fun start(onPcm: (ByteArray) -> Unit): Boolean
    fun play(pcm: ByteArray)
    /** Drops what hasn't played yet (the user spoke over Gemini). */
    fun flush()
    fun stop()
}

/**
 * A voice call with Gemini Live over the Gemini API that hands spoken requests to Hermes:
 * port of the Mac's `GeminiLiveController`. Bento sends microphone audio and function
 * results and plays the reply; Gemini's one tool, `ask_hermes`, carries no arguments, so
 * Hermes only ever gets the user's own transcribed words ([CallProtocol]).
 *
 * State is confined to one thread. Interrupting Gemini's speech flushes playback but
 * never cancels Hermes; [stop] ends the call and abandons a running request.
 *
 * A call has no time limit. Gemini closes a connection after about ten minutes, warning
 * with `goAway` first; with [reconnect] the session carries on over a new socket from its
 * latest resumption handle, and audio keeps going to the old one until the new one is set up.
 *
 * Gemini bills a connection by the second, so a call waiting on Hermes in silence for
 * [standbyAfter] seconds leaves it ([Status.Standby]): the socket closes and the microphone
 * keeps running unheard. When Hermes finishes, or on [wake], a new session starts with the
 * conversation so far ([recap]); a result that outlived its session goes in as a new turn
 * for Gemini to speak ([CallSetup.resultFrame]), since the old session's call is gone with it.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AssistantCall(
    transport: LiveTransport,
    private val audio: CallAudio,
    private val resume: CallSetup.Resume?,
    private val onTool: suspend (HermesCall) -> String,
    private val ending: (LiveTransport) -> LiveSocketEnding = { LiveSocketEnding() },
    private val limits: Limits = Limits(),
    private val clock: () -> Double = { System.nanoTime() / 1e9 },
    /** A new socket for when Gemini rotates the connection; without one the call ends at its time limit and never stands by. */
    private val reconnect: (() -> LiveTransport)? = null,
    /** Seconds without speech after which a call waiting on Hermes leaves Gemini (0 = never); read as the call goes. */
    private val standbyAfter: () -> Double = { 0.0 },
    /** The conversation so far, for the session a call starts when it comes back from standby. */
    private val recap: () -> CallSetup.Resume? = { null },
) {
    data class Limits(
        val connect: Double = 25.0,
        val capture: Double = 5.0,
        val tickMillis: Long = 1000,
        val settleQuiet: Double = 0.8,
        val settleMax: Double = 5.0,
    )

    sealed interface Status {
        data object Connecting : Status
        data object Listening : Status
        /** Hermes is working on a spoken request. */
        data object Working : Status
        /** Hermes is working and the call has left Gemini until it finishes or [wake]. */
        data object Standby : Status
        /** Coming back from standby: a new session is being set up. */
        data object Waking : Status
        data class Ended(val message: String?) : Status
    }

    private val confined = Dispatchers.Default.limitedParallelism(1)
    private val scope = CoroutineScope(SupervisorJob() + confined)
    private val protocol = CallProtocol()
    private val mic = Channel<ByteArray>(24)
    private val _status = MutableStateFlow<Status>(Status.Connecting)
    val status: StateFlow<Status> = _status.asStateFlow()

    /** (role, text) fragments as they're heard: "user" for the user, "assistant" for Gemini. Called on the call's thread. */
    var onTranscript: ((String, String) -> Unit)? = null

    private var socket = transport
    private var active = false
    private var listening = false
    private var goingAway = false
    /** The latest handle Gemini says the session can resume from. */
    private var resumeHandle: String? = null
    private var rotating = false
    private var started = 0.0
    @Volatile private var lastCaptureAt: Double? = null
    @Volatile private var mutedNow = false
    private var streamEnded = false
    private var toolTask: Job? = null
    private var runningTurn: Int? = null
    private val cancelledCalls = HashSet<String>()
    /** How the current session was set up: the call's [resume], or after standby the conversation then. */
    private var setupResume = resume
    private var hermesWorking = false
    private var standby = false
    private var waking = false
    private var wakeStarted = 0.0
    /** The running request outlived the session its call came from: its result goes back as a turn. */
    private var parked = false
    /** A parked result waiting for the session being set up. */
    private var delivery: String? = null
    /** When someone last spoke, and when Gemini's speech already received finishes playing. */
    private var lastSpeech = 0.0
    private var speechUntil = 0.0

    private fun now() = clock()

    /** Tap-to-talk: while muted nothing is sent, and Gemini is told the stream paused so it answers. */
    var muted: Boolean
        get() = mutedNow
        set(value) {
            mutedNow = value
            scope.launch {
                if (!active || !listening) return@launch
                if (value && !streamEnded) {
                    streamEnded = true
                    send(STREAM_END)
                } else if (!value) {
                    streamEnded = false
                    // Tap to talk: talking brings the call back.
                    if (standby) comeBack()
                }
            }
        }

    fun start() {
        scope.launch {
            if (active) return@launch
            active = true
            started = now()
            lastSpeech = started
            _status.value = Status.Connecting
            launch { receiveLoop() }
            launch { watchdog() }
        }
    }

    private suspend fun receiveLoop() {
        val first = socket
        try {
            first.connect()
            first.send(CallSetup.setupFrame(setupResume))
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException && !active) return
            if (active) fail(endingMessage(ending(first), goingAway))
            return
        }
        read(first)
    }

    /** Reads [from] until it closes; one already replaced, about to be, or left for standby ends quietly. */
    private suspend fun read(from: LiveTransport) {
        try {
            while (active && from === socket) {
                val frame = from.receive()
                if (standby && !waking) return
                receive(frame)
            }
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException && !active) return
            if (!active || from !== socket || rotating) return
            if (waking) fail(RECONNECT_FAILED) else if (!standby) fail(endingMessage(ending(from), goingAway))
        }
    }

    /** Moves the call to a new socket that resumes the session; the old one carries audio until it's set up. */
    private fun rotate() {
        val make = reconnect ?: return
        val handle = resumeHandle ?: return
        if (rotating) return
        rotating = true
        scope.launch {
            val next = make()
            var moved = false
            try {
                val ready = withTimeoutOrNull((limits.connect * 1000).toLong()) {
                    runCatching {
                        next.connect()
                        next.send(CallSetup.setupFrame(setupResume, handle))
                        // The resumed session already has the recap and the microphone: wait for it to take input.
                        while (Json.parseToJsonElement(next.receive()).let { it as? JsonObject }?.get("setupComplete") == null) Unit
                    }.isSuccess
                } == true
                rotating = false
                if (!active) return@launch
                if (!ready) { fail("Gemini voice couldn't reconnect. Start again to continue."); return@launch }
                val old = socket
                socket = next
                moved = true
                goingAway = false
                old.close()
                launch { read(next) }
            } finally {
                if (!moved) next.close()
            }
        }
    }

    private suspend fun watchdog() {
        while (scope.isActive && active) {
            delay(limits.tickMillis)
            if (!active) return
            val t = now()
            when {
                !listening && t - started >= limits.connect -> { fail("Gemini didn't answer. The call timed out."); return }
                listening && t - (lastCaptureAt ?: started) >= limits.capture -> { fail("The microphone stopped delivering audio. The call ended."); return }
                waking && t - wakeStarted >= limits.connect -> { fail(RECONNECT_FAILED); return }
                idleWhileHermesWorks(t) -> standBy()
            }
        }
    }

    /** Hermes is working and nobody has spoken (Gemini included) for the standby time. */
    private fun idleWhileHermesWorks(t: Double): Boolean {
        val after = standbyAfter()
        return after > 0 && hermesWorking && listening && !standby && !rotating && reconnect != null &&
            t - maxOf(lastSpeech, speechUntil) >= after
    }

    /** Leaves Gemini while Hermes works: the socket closes, and the microphone runs on unheard. */
    private fun standBy() {
        standby = true
        parked = true
        goingAway = false
        resumeHandle = null
        _status.value = Status.Standby
        socket.close()
    }

    /** Brings a call in standby back now, to talk before Hermes finishes. */
    fun wake() {
        scope.launch { comeBack() }
    }

    /** A new session with the conversation so far; the read loop finishes it at setupComplete ([cameBack]). */
    private fun comeBack() {
        if (!active || !standby || waking) return
        val make = reconnect ?: return
        waking = true
        wakeStarted = now()
        _status.value = Status.Waking
        setupResume = runCatching { recap() }.getOrNull()
        val next = make()
        socket = next
        scope.launch {
            try {
                next.connect()
                next.send(CallSetup.setupFrame(setupResume))
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException && !active) return@launch
                if (active && socket === next) fail(RECONNECT_FAILED)
                return@launch
            }
            read(next)
        }
    }

    /** Back from standby: a result that was waiting goes in for Gemini to speak. */
    private suspend fun cameBack() {
        lastSpeech = now()
        speechUntil = 0.0
        delivery?.let { delivery = null; send(CallSetup.resultFrame(it), resend = true) }
        _status.value = if (hermesWorking) Status.Working else Status.Listening
    }

    /** A parked request's result: spoken now, or once the call is back from standby. */
    private suspend fun deliver(result: String) {
        when {
            waking -> delivery = result
            standby -> { delivery = result; comeBack() }
            else -> send(CallSetup.resultFrame(result), resend = true)
        }
    }

    private suspend fun receive(frame: String) {
        if (frame.length > 4 * 1024 * 1024) return
        val event = runCatching { Json.parseToJsonElement(frame) as? JsonObject }.getOrNull() ?: return
        (event["sessionResumptionUpdate"] as? JsonObject)?.let { update ->
            val handle = update.str("newHandle")
            if ((update["resumable"] as? JsonPrimitive)?.booleanOrNull == true && !handle.isNullOrEmpty()) resumeHandle = handle
        }
        // Gemini warns before closing a connection at its time limit.
        if (event["goAway"] != null) { goingAway = true; rotate() }
        (event["error"] as? JsonObject)?.let {
            fail("Gemini voice failed: " + (it.str("message") ?: "unknown error") + ". No task was retried.")
            return
        }
        if (event["setupComplete"] != null) {
            val back = waking
            if (back) { waking = false; standby = false }
            setupResume?.let { send(CallSetup.recapFrame(it.recap)) }
            if (back) cameBack() else listen()
        }
        when ((event["voiceActivity"] as? JsonObject)?.str("type")) {
            "ACTIVITY_START" -> { protocol.activityStarted(now()); lastSpeech = now() }
            "ACTIVITY_END" -> { protocol.activityEnded(now()); lastSpeech = now() }
        }
        val content = event["serverContent"] as? JsonObject ?: JsonObject(emptyMap())
        // Transcripts arrive inside serverContent; the reference also allows them top level.
        for (source in listOf(content, event)) {
            (source["inputTranscription"] as? JsonObject)?.str("text")?.takeIf { it.isNotEmpty() }?.let {
                protocol.transcript("user", it, now()); onTranscript?.invoke("user", it); lastSpeech = now()
            }
            (source["outputTranscription"] as? JsonObject)?.str("text")?.takeIf { it.isNotEmpty() }?.let {
                protocol.transcript("assistant", it, now()); onTranscript?.invoke("assistant", it); lastSpeech = now()
            }
        }
        if ((content["interrupted"] as? JsonPrimitive)?.booleanOrNull == true) audio.flush()
        val parts = ((content["modelTurn"] as? JsonObject)?.get("parts") as? JsonArray).orEmpty()
        for (part in parts) {
            val inline = (part as? JsonObject)?.get("inlineData") as? JsonObject ?: continue
            val mime = inline.str("mimeType") ?: continue
            if (!mime.startsWith("audio/")) continue
            val pcm = inline.str("data")?.let { runCatching { Base64.getDecoder().decode(it) }.getOrNull() }
            if (mime != OUTPUT_MIME || pcm == null || pcm.isEmpty() || pcm.size % 2 != 0 || pcm.size > 480_000) {
                fail("Gemini sent audio Bento can't play. Start a new call."); return
            }
            audio.play(pcm)
            // 24 kHz 16-bit mono: Gemini is still speaking until this has played.
            speechUntil = maxOf(speechUntil, now()) + pcm.size / 48_000.0
        }
        ((event["toolCallCancellation"] as? JsonObject)?.get("ids") as? JsonArray)?.take(32)?.forEach { id ->
            (id as? JsonPrimitive)?.contentOrNull?.let(cancelledCalls::add)
        }
        val calls = ((event["toolCall"] as? JsonObject)?.get("functionCalls") as? JsonArray).orEmpty()
        for (call in calls) {
            if (!active) return
            (call as? JsonObject)?.let(::delegate)
        }
    }

    private fun listen() {
        if (listening) return
        listening = true
        lastCaptureAt = now()
        scope.launch {
            for (pcm in mic) {
                if (!active) return@launch
                if (standby) continue
                send(audioFrame(pcm))
            }
        }
        val ok = audio.start { pcm ->
            lastCaptureAt = now()
            if (mutedNow) return@start
            if (mic.trySend(pcm).isFailure) scope.launch { fail("Microphone streaming fell behind. The call ended.") }
        }
        if (!ok) { scope.launch { fail("Couldn't open the microphone.") }; return }
        _status.value = Status.Listening
    }

    private fun delegate(call: JsonObject) {
        val name = call.str("name")
        val id = call.str("id")
        val d = protocol.delegation(name, id, now())
        if (d == null) {
            // Anything but a new ask_hermes call is answered, never run, so the model isn't left waiting.
            if (!id.isNullOrEmpty() && id.length < 200 && name != null && name != CallProtocol.TOOL && name.length < 200) {
                scope.launch { respond(id, "Not executed: unknown tool. Only ask_hermes exists.", executed = false, name = name) }
            }
            return
        }
        if (toolTask != null) {
            // A different turn is consumed so a later call cannot replay it; a repeat of the
            // running call's turn leaves it to that call.
            val duplicate = d.turn != null && d.turn == runningTurn
            if (!duplicate) protocol.discardRequest(d)
            scope.launch {
                respond(d.id, if (duplicate) "Not executed: Hermes is already working on this request. Wait for its result. No automatic retry."
                              else "Not executed: Hermes is still working on an earlier request, so this one was not started. Tell the user to ask again after that result. No automatic retry.",
                        executed = false)
            }
            return
        }
        runningTurn = d.turn
        toolTask = scope.launch {
            fun finish() {
                toolTask = null; runningTurn = null; parked = false
                if (active && !standby) _status.value = Status.Listening
            }
            if (!settle(d)) return@launch
            // Gemini cancels a call when the user interrupts; one cancelled before Hermes starts never runs.
            val request = protocol.request(d)
            if (d.id in cancelledCalls) { finish(); return@launch }
            if (request == null) {
                respond(d.id, "Not executed: no complete new transcribed request could be identified. Ask the user to repeat a short, specific request. No action was run.", executed = false)
                finish(); return@launch
            }
            _status.value = Status.Working
            hermesWorking = true
            val result = runCatching { onTool(request) }.getOrElse {
                if (it is kotlinx.coroutines.CancellationException) throw it
                "Task failed. No automatic retry. Completed actions were not undone. " + (it.message ?: "")
            }
            hermesWorking = false
            if (!active) return@launch
            if (parked) { deliver(result); finish(); return@launch }
            if (d.id in cancelledCalls) { finish(); return@launch } // Gemini dropped the call; the reply stays in the chat.
            respond(d.id, result, executed = true)
            finish()
        }
    }

    /** Waits for the call's turn to end with words and go quiet, since its transcript can trail the call. */
    private suspend fun settle(d: CallProtocol.Delegation): Boolean {
        if (d.turn == null) return active
        while (true) {
            delay(100)
            if (!active) return false
            val turn = protocol.turnState(d)
            val t = now()
            if (turn.complete && t - (turn.changed ?: d.at) >= limits.settleQuiet || t - d.at >= limits.settleMax) return true
        }
    }

    private suspend fun respond(id: String, message: String, executed: Boolean, name: String = CallProtocol.TOOL) {
        if (!active) return
        send(CallProtocol.response(id, name, message, executed), resend = true)
    }

    /** A frame the old socket couldn't take while the call moves is dropped, or with [resend] sent on the new one. */
    private suspend fun send(frame: String, resend: Boolean = false) {
        if (!active || standby) return
        val to = socket
        try {
            to.send(frame)
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            if (!rotating && to === socket) { fail("Lost the connection to Gemini. Completed actions were not undone."); return }
            if (!resend) return // waiting would back the microphone up
            while (rotating && active) delay(50)
            if (socket !== to) send(frame)
        }
    }

    private fun fail(message: String) = stop(message)

    /** Ends the call at once; a running Hermes request is abandoned, not undone. */
    fun stop(message: String? = null) {
        scope.launch {
            if (!active) return@launch
            active = false
            audio.stop()
            mic.close()
            socket.close()
            _status.value = Status.Ended(message)
            scope.cancel()
        }
    }

    companion object {
        const val OUTPUT_MIME = "audio/pcm;rate=24000"
        const val RECONNECT_FAILED = "Gemini voice couldn't reconnect after standby. The call ended."
        internal const val STREAM_END = """{"realtimeInput":{"audioStreamEnd":true}}"""

        fun audioFrame(pcm: ByteArray): String = buildJsonObject {
            putJsonObject("realtimeInput") {
                putJsonObject("audio") {
                    put("mimeType", "audio/pcm;rate=16000")
                    put("data", Base64.getEncoder().encodeToString(pcm))
                }
            }
        }.toString()

        /** What the user hears when the socket ends without an error event (the Mac's `GeminiLiveEnding`). */
        fun endingMessage(e: LiveSocketEnding, goingAway: Boolean): String {
            if (goingAway) return "Gemini ended the call at its time limit. Start again to continue."
            // A bad key upgrades and then closes with 1007; a key without access is refused with 403.
            val keyRejected = e.httpStatus == 401 || e.httpStatus == 403 ||
                e.closeCode == 1007 && e.closeReason?.contains("API key", ignoreCase = true) == true
            if (keyRejected) return "Gemini rejected the API key. Check it in Settings → Dictation."
            val detail = listOfNotNull(e.httpStatus?.let { "HTTP $it" }, e.closeCode?.takeIf { it != 1000 }?.let { "close $it" })
            if (detail.isEmpty()) return "Gemini voice disconnected. No task was retried."
            return "Gemini voice failed (${detail.joinToString(", ")}). No task was retried."
        }
    }
}
