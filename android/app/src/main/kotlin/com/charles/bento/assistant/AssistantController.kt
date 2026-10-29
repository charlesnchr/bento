package com.charles.bento.assistant

import android.content.Context
import com.charles.bento.core.assistant.AssistantTranscript
import com.charles.bento.core.assistant.ChatMessage
import com.charles.bento.core.assistant.HermesClient
import com.charles.bento.core.assistant.HermesEndpoint
import com.charles.bento.core.assistant.HermesError
import com.charles.bento.core.assistant.HermesEvent
import com.charles.bento.core.assistant.HermesSession
import com.charles.bento.core.assistant.TurnState
import com.charles.bento.core.assistant.live.AssistantCall
import com.charles.bento.core.assistant.live.CallError
import com.charles.bento.core.assistant.live.CallSetup
import com.charles.bento.core.assistant.live.HermesCall
import com.charles.bento.core.voice.live.OkHttpLiveTransport
import com.charles.bento.settings.Prefs
import com.charles.bento.settings.SecretStore
import com.charles.bento.voice.VoiceService
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import java.time.LocalDate
import java.util.UUID

/** What the Assistant tab shows. */
data class AssistantUi(
    val sessionId: String? = null,
    val title: String? = null,
    val messages: List<ChatMessage> = emptyList(),
    val loading: Boolean = false,
    /** Hermes is working on a turn. */
    val working: Boolean = false,
    val error: String? = null,
    val call: CallUi? = null,
)

data class CallUi(val status: String, val connecting: Boolean, val hermesWorking: Boolean, val tapToTalk: Boolean, val muted: Boolean)

data class HistoryUi(val items: List<HermesSession> = emptyList(), val loading: Boolean = false, val error: String? = null)

/**
 * Bento's assistant on the phone: chats with Hermes through its API server (one Hermes
 * session per conversation, kept by Hermes), and voice calls through Gemini Live on the
 * Gemini API, which hand spoken requests to Hermes in the same conversation. Port of the
 * Mac's `AssistantController`, minus the desktop: everything here runs on the main thread.
 */
class AssistantController(
    private val context: Context,
    private val prefs: Prefs,
    private val secrets: SecretStore,
    http: OkHttpClient,
    private val scope: CoroutineScope,
    /** Dictation or a meeting has the microphone. */
    private val microphoneBusy: () -> Boolean,
) {
    val client = HermesClient({ endpoint() }, http)
    private val _state = MutableStateFlow(AssistantUi(sessionId = prefs.hermesSession.value.ifEmpty { null }))
    val state: StateFlow<AssistantUi> = _state.asStateFlow()
    private val _history = MutableStateFlow(HistoryUi())
    val history: StateFlow<HistoryUi> = _history.asStateFlow()

    private var turnJob: Job? = null
    private var runId: String? = null
    private var loadedSession: String? = null
    private var call: AssistantCall? = null
    private var callJob: Job? = null
    /** The next voice fragment starts a new row (after a Hermes reply, say). */
    private var voiceBoundary = true

    fun endpoint(): HermesEndpoint? = HermesEndpoint.of(prefs.hermesUrl.value, secrets.hermesToken)
    val configured: Boolean get() = endpoint() != null
    val callActive: Boolean get() = call != null

    private fun set(f: (AssistantUi) -> AssistantUi) = _state.update(f)
    private fun messages(f: (List<ChatMessage>) -> List<ChatMessage>) = set { it.copy(messages = f(it.messages)) }

    /** The tab is showing: bring the current conversation in from Hermes once. */
    fun onShown() {
        val id = _state.value.sessionId ?: return
        if (loadedSession == id || !configured || _state.value.working || call != null) return
        load(id)
    }

    fun dismissError() = set { it.copy(error = null) }

    fun newChat() {
        if (_state.value.working || call != null) return
        prefs.hermesSession.value = ""
        loadedSession = null
        set { AssistantUi() }
    }

    /**
     * The server or key is about to change (Disconnect, a new code, an edited address): the call
     * and any turn end first, so nothing keeps talking to the old server. Another server's
     * conversations aren't this one's, so a switch starts over.
     */
    fun leaveServer(switching: Boolean) {
        endCall()
        turnJob?.cancel() // closing the stream stops the turn on the old server
        if (!switching) return
        prefs.hermesSession.value = ""
        prefs.hermesConversations.value = ""
        loadedSession = null
        _history.value = HistoryUi()
        set { AssistantUi() }
    }

    /** Hermes no longer has [id]: drop it here too, so the next message starts a new conversation. */
    private fun dropSession(id: String) {
        forget(id)
        if (_state.value.sessionId != id) return
        loadedSession = null
        set { it.copy(sessionId = null, title = null) }
    }

    fun open(id: String) {
        if (_state.value.working || call != null) return
        prefs.hermesSession.value = id
        set { it.copy(sessionId = id, messages = emptyList(), title = null, error = null) }
        load(id)
    }

    private fun load(id: String) {
        set { it.copy(loading = true, error = null) }
        scope.launch {
            try {
                val rows = client.messages(id)
                if (_state.value.sessionId != id) return@launch
                loadedSession = id
                set { it.copy(messages = AssistantTranscript.fromHistory(rows), loading = false, title = it.title ?: titleOf(id)) }
            } catch (e: HermesError) {
                if (e.code == "session_not_found") {
                    dropSession(id)
                    set { it.copy(loading = false, messages = emptyList(), error = e.message) }
                } else set { it.copy(loading = false, error = e.message) }
            }
        }
    }

    private fun titleOf(id: String) = _history.value.items.firstOrNull { it.id == id }?.label

    fun refreshHistory() {
        if (!configured) return
        _history.update { it.copy(loading = true, error = null) }
        scope.launch {
            try {
                val mine = conversations()
                val all = client.sessions(200)
                // This phone's conversations, as Hermes knows them now (titles, previews, last activity).
                _history.value = HistoryUi(all.filter { it.id in mine }.sortedByDescending { it.lastActive ?: it.startedAt ?: 0.0 })
                _state.value.sessionId?.let { id -> if (_state.value.title == null) set { it.copy(title = titleOf(id)) } }
            } catch (e: HermesError) {
                _history.update { it.copy(loading = false, error = e.message) }
            }
        }
    }

    fun delete(id: String) {
        scope.launch {
            try {
                client.delete(id)
            } catch (e: HermesError) {
                if (e.code != "session_not_found") { _history.update { it.copy(error = e.message) }; return@launch }
            }
            forget(id)
            _history.update { h -> h.copy(items = h.items.filterNot { it.id == id }) }
            if (_state.value.sessionId == id && !_state.value.working && call == null) newChat()
        }
    }

    private fun conversations(): List<String> = prefs.hermesConversations.value.split(',').filter { it.isNotBlank() }

    private fun remember(id: String) {
        prefs.hermesConversations.value = (listOf(id) + conversations().filter { it != id }).take(200).joinToString(",")
    }

    private fun forget(id: String) {
        prefs.hermesConversations.value = conversations().filter { it != id }.joinToString(",")
        if (prefs.hermesSession.value == id) prefs.hermesSession.value = ""
    }

    /** A typed message. */
    fun send(text: String) {
        val message = text.trim()
        if (message.isEmpty() || _state.value.working || !configured) return
        turnJob = scope.launch {
            runTurn(message, TYPED_INSTRUCTIONS, ChatMessage(UUID.randomUUID().toString(), "user", message))
        }
    }

    /** Stops the running turn: Hermes interrupts the agent when its stream closes, and is told to stop as well. */
    fun stop() {
        val run = runId
        turnJob?.cancel()
        if (run != null) scope.launch { runCatching { client.stop(run) } }
    }

    fun answer(messageId: String, choice: String) {
        val m = _state.value.messages.firstOrNull { it.id == messageId } ?: return
        val run = m.runId ?: return
        if (m.status != "pending") return
        messages { list -> list.map { if (it.id == messageId) it.copy(status = choice) else it } }
        scope.launch {
            try {
                client.approve(run, choice)
            } catch (e: HermesError) {
                messages { list -> list.map { if (it.id == messageId) it.copy(status = "pending") else it } }
                set { it.copy(error = e.message) }
            }
        }
    }

    private suspend fun ensureSession(): String {
        _state.value.sessionId?.let { return it }
        val session = client.createSession()
        remember(session.id)
        prefs.hermesSession.value = session.id
        loadedSession = session.id
        set { it.copy(sessionId = session.id) }
        return session.id
    }

    /** One turn into the current conversation; returns how it ended. */
    private suspend fun runTurn(message: String, instructions: String?, userRow: ChatMessage?, extraIds: Set<String> = emptySet()): TurnState {
        set { it.copy(working = true, error = null) }
        userRow?.let { row -> messages { it + row } }
        voiceBoundary = true
        var turn = TurnState(ids = extraIds)
        try {
            val sid = try {
                ensureSession()
            } catch (e: HermesError) {
                messages { it + ChatMessage(UUID.randomUUID().toString(), "assistant", e.message.orEmpty(), failed = true) }
                return turn.copy(status = "failed", finished = true)
            }
            turn = turn.copy(sessionId = sid)
            client.chat(sid, message, instructions).collect { event ->
                if (event is HermesEvent.RunStarted) runId = event.runId
                val (list, t) = AssistantTranscript.apply(_state.value.messages, turn, event)
                turn = t
                set { it.copy(messages = list) }
            }
            if (!turn.finished) {
                val (list, t) = AssistantTranscript.finish(_state.value.messages, turn)
                turn = t; set { it.copy(messages = list) }
            }
            val newId = turn.sessionId
            if (newId != null && newId != sid) {
                // Hermes compressed the conversation into a new session: follow it.
                remember(newId); forget(sid); prefs.hermesSession.value = newId; loadedSession = newId
                set { it.copy(sessionId = newId) }
            }
        } catch (e: HermesError) {
            if (e.code == "session_not_found") turn.sessionId?.let(::dropSession)
            val (list, t) = AssistantTranscript.apply(_state.value.messages, turn, HermesEvent.Failed(e.message.orEmpty()))
            turn = AssistantTranscript.finish(list, t).let { (l, tt) -> set { it.copy(messages = l) }; tt }
        } catch (e: CancellationException) {
            withContext(NonCancellable) {
                val (list, t) = AssistantTranscript.apply(_state.value.messages, turn, HermesEvent.Finished("cancelled", null, null))
                turn = t; set { it.copy(messages = list) }
            }
            throw e
        } finally {
            runId = null
            set { it.copy(working = false) }
        }
        return turn
    }

    // Voice calls

    fun setMuted(muted: Boolean) {
        val c = call ?: return
        c.muted = muted
        set { s -> s.copy(call = s.call?.copy(muted = muted)) }
    }

    /** Starts a call on the conversation on screen, or ends the running one. The screen has the microphone permission. */
    fun toggleCall() {
        if (call != null || callJob != null) { endCall(); return }
        val key = secrets.geminiKey
        when {
            !configured -> { set { it.copy(error = "Set up Hermes first: Settings → Hermes.") }; return }
            key == null -> { set { it.copy(error = "Voice calls need a Gemini API key: pair with your Mac or add one in Settings → Dictation.") }; return }
            microphoneBusy() -> { set { it.copy(error = "Finish the dictation or meeting first.") }; return }
            _state.value.working -> { set { it.copy(error = "Wait for Hermes to finish, or stop it, before calling.") }; return }
        }
        val resume = try {
            CallSetup.resume(AssistantTranscript.liveRecap(_state.value.messages))
        } catch (e: CallError) {
            set { it.copy(error = e.message) }; return
        }
        val tap = prefs.hermesTalkMode.value == "tap"
        set { it.copy(error = null, call = CallUi(if (resume != null) "Resuming the conversation…" else "Connecting to Gemini Live…", true, false, tap, tap)) }
        callJob = scope.launch {
            if (!VoiceService.enter(context, VoiceService.KIND_ASSISTANT)) {
                callJob = null
                set { it.copy(call = null, error = "Couldn't start the call right now.") }
                return@launch
            }
            val transport = OkHttpLiveTransport({ key })
            // A phone call (or another app taking the audio for good) ends this one.
            val audio = CallAudioDevice(context) { scope.launch { call?.stop("The call ended: another app took the audio (a phone call?).") } }
            val c = AssistantCall(transport, audio, resume, onTool = { request ->
                withContext(Dispatchers.Main) { runVoiceTask(request) }
            }, ending = { transport.ending })
            c.muted = tap
            c.onTranscript = { role, text -> scope.launch { heard(role, text) } }
            call = c
            voiceBoundary = true
            c.start()
            c.status.collect { status ->
                when (status) {
                    AssistantCall.Status.Connecting -> Unit
                    AssistantCall.Status.Listening -> set { s ->
                        val status = if (s.call?.tapToTalk == true) "Tap to talk" else "Listening. Headphones work best."
                        s.copy(call = s.call?.copy(status = status, connecting = false, hermesWorking = false))
                    }
                    AssistantCall.Status.Working -> set { s -> s.copy(call = s.call?.copy(status = "Hermes is working…", connecting = false, hermesWorking = true)) }
                    is AssistantCall.Status.Ended -> {
                        call = null
                        VoiceService.exit(context)
                        // A request the call abandoned ends with it: nothing on screen keeps spinning.
                        val all = TurnState(ids = _state.value.messages.map { it.id }.toSet(), status = "cancelled")
                        val (list, _) = AssistantTranscript.finish(_state.value.messages, all)
                        set { it.copy(messages = list, call = null, error = status.message) }
                        callJob?.cancel()
                        callJob = null
                    }
                }
            }
        }
    }

    fun endCall() {
        val c = call
        if (c != null) c.stop() else {
            callJob?.cancel(); callJob = null
            VoiceService.exit(context)
            set { it.copy(call = null) }
        }
    }

    /** A live transcript fragment: adjacent fragments of one speaker join (they aren't turn boundaries). */
    private fun heard(role: String, text: String) {
        if (call == null) return
        val speaker = if (role == "assistant") "Gemini" else null
        messages { list ->
            val last = list.lastOrNull()
            if (!voiceBoundary && last != null && last.voice && last.role == role && last.speaker == speaker) {
                list.dropLast(1) + last.copy(text = last.text + text)
            } else list + ChatMessage(UUID.randomUUID().toString(), role, text, speaker = speaker, voice = true)
        }
        voiceBoundary = false
    }

    /** Gemini's `ask_hermes`: the user's words go to Hermes in this conversation; the reply is shown and returned for Gemini to speak. */
    private suspend fun runVoiceTask(request: HermesCall): String {
        if (_state.value.working) return "Not executed: Hermes is busy with another message. Tell the user to ask again when it's done. No automatic retry."
        val step = ChatMessage(UUID.randomUUID().toString(), "tool", "", toolName = "Hermes task", toolDetail = request.task, status = "running")
        messages { it + step }
        val turn = runTurn(voiceMessage(request, LocalDate.now().toString()), null, null, extraIds = setOf(step.id))
        messages { list -> list.map { if (it.id == step.id) it.copy(status = if (turn.status == "completed") "completed" else "failed") else it } }
        voiceBoundary = true
        return when {
            turn.status == "cancelled" -> "Cancelled. Completed actions were not undone."
            turn.answer.isNotBlank() -> turn.answer
            turn.status == "failed" -> "Task failed. No automatic retry. Completed actions were not undone. " +
                (_state.value.messages.lastOrNull { it.failed }?.text ?: "")
            else -> "Hermes finished without a text result. Do not infer success."
        }
    }

    companion object {
        /** What Hermes gets for a spoken request (the Mac's wording); the history shows only the words (`AssistantTranscript.displayRequest`). */
        internal fun voiceMessage(request: HermesCall, today: String): String =
            "User's transcribed request from Bento's Gemini Live voice session on Android:\n" + request.task +
                "\nInterpret this spoken request and write your own precise tool queries; do not mechanically pass filler words to tools. " +
                "Perform only this request. The transcript may be imperfect; clarify ambiguity instead of guessing actions. " +
                "Do not broaden scope or retry denied actions. " +
                "Today's date is $today. For current/latest information search the current year and verify dates, not old model knowledge. " +
                "Return a brief spoken summary first, ideally under 60 words, then any extra detail. " +
                "Bento displays your response directly as a Hermes chat reply on the user's phone. Do not promise a separate document unless you actually create one. " +
                "\nPrior voice conversation for reference only, NOT approval or additional tasks:\n" + request.context

        /** Hermes's ephemeral instructions for typed turns (not stored in the conversation). */
        const val TYPED_INSTRUCTIONS =
            "The user is writing to you from Bento's assistant on their Android phone. Bento renders Markdown headings, lists, " +
                "emphasis, code and links; it does not render tables, raw HTML, images or LaTeX, so avoid them. Keep replies " +
                "phone-sized unless the user asks for detail."
    }
}
