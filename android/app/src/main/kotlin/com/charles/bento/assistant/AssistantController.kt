package com.charles.bento.assistant

import android.content.Context
import com.charles.bento.core.assistant.AssistantTranscript
import com.charles.bento.core.assistant.ChatMessage
import com.charles.bento.core.assistant.HermesChoice
import com.charles.bento.core.assistant.HermesClient
import com.charles.bento.core.assistant.HermesEndpoint
import com.charles.bento.core.assistant.HermesError
import com.charles.bento.core.assistant.HermesEvent
import com.charles.bento.core.assistant.HermesModelOptions
import com.charles.bento.core.assistant.HermesSession
import com.charles.bento.core.assistant.TurnState
import com.charles.bento.core.assistant.live.AssistantCall
import com.charles.bento.core.assistant.live.CallError
import com.charles.bento.core.assistant.live.CallSetup
import com.charles.bento.core.assistant.live.HermesCall
import com.charles.bento.core.voice.live.LiveSocketEnding
import com.charles.bento.core.voice.live.OkHttpLiveTransport
import com.charles.bento.settings.Prefs
import com.charles.bento.settings.SecretStore
import com.charles.bento.ui.assistant.ChatScroll
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

data class CallUi(
    val status: String,
    val connecting: Boolean,
    val hermesWorking: Boolean,
    val tapToTalk: Boolean,
    val muted: Boolean,
    /** Off Gemini while Hermes works ([AssistantCall.Status.Standby]). */
    val standby: Boolean = false,
    /** The call's Hermes tasks, in the order they started. */
    val tasks: List<TaskUi> = emptyList(),
)

/** One spoken request Hermes works on in a session of its own, while the call goes on. */
data class TaskUi(
    /** The task's number in the call, as Gemini says it. */
    val id: String,
    /** What the user said. */
    val request: String,
    /** "running", "waiting" (for an approval), "completed", "failed" or "cancelled". */
    val status: String = "running",
    /** The latest step: the tool Hermes is using, or that it's writing its reply. */
    val progress: String? = null,
    /** The task's Hermes session, once created. */
    val sessionId: String? = null,
    /** The task's own conversation as it streams: the request, Hermes's tools and its reply. */
    val messages: List<ChatMessage> = emptyList(),
) {
    val active: Boolean get() = status == "running" || status == "waiting"
}

/** Hermes's model list for the picker: loaded on demand, kept until the server changes. */
data class ModelsUi(val options: HermesModelOptions? = null, val loading: Boolean = false, val error: String? = null)

data class HistoryUi(val items: List<HermesSession> = emptyList(), val loading: Boolean = false, val error: String? = null)

/**
 * Bento's assistant on the phone: chats with Hermes through its API server (one Hermes
 * session per conversation, kept by Hermes), and voice calls through Gemini Live on the
 * Gemini API, which hand each spoken request to Hermes as a task in a session of its own,
 * several at once. Port of the Mac's `AssistantController`, minus the desktop: everything
 * here runs on the main thread.
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
    private val _models = MutableStateFlow(ModelsUi())
    val models: StateFlow<ModelsUi> = _models.asStateFlow()
    /** Bumped when the server changes: a model list asked of the old one is dropped when it arrives. */
    private var modelsServer = 0

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
        // Another server has other models: the pick and the list are this one's.
        prefs.hermesModelProvider.value = ""
        prefs.hermesModel.value = ""
        prefs.hermesLocked.value = ""
        modelsServer++
        _models.value = ModelsUi()
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

    // Model and effort

    /** What this phone asks Hermes for (Prefs). */
    val choice: HermesChoice
        get() {
            val provider = prefs.hermesModelProvider.value
            val model = prefs.hermesModel.value
            val picked = provider.isNotEmpty() && model.isNotEmpty()
            return HermesChoice(provider.takeIf { picked }, model.takeIf { picked }, prefs.hermesEffort.value.takeIf { it in HermesChoice.EFFORTS })
        }

    /** Picks the model for the next turns: one of [provider]'s, or Hermes's default when either is null. */
    fun pickModel(provider: String?, model: String?) {
        val picked = provider != null && model != null
        prefs.hermesModelProvider.value = if (picked) provider.orEmpty() else ""
        prefs.hermesModel.value = if (picked) model.orEmpty() else ""
    }

    fun pickEffort(effort: String?) {
        prefs.hermesEffort.value = effort?.takeIf { it in HermesChoice.EFFORTS }.orEmpty()
    }

    /** Loads Hermes's model list for the picker, once per server unless [force]. */
    fun loadModels(force: Boolean = false) {
        val m = _models.value
        if (!configured || m.loading || (m.options != null && !force)) return
        _models.update { it.copy(loading = true, error = null) }
        val server = modelsServer
        scope.launch {
            val loaded = try {
                ModelsUi(client.modelOptions())
            } catch (e: HermesError) {
                ModelsUi(_models.value.options, error = e.message)
            }
            if (server == modelsServer) _models.value = loaded
        }
    }

    private fun locked(): List<String> = prefs.hermesLocked.value.split(',').filter { it.isNotBlank() }

    /**
     * The turn's choice for conversation [sid]. Once this phone has locked a conversation to a
     * model, the default goes by name, so it needs Hermes's list; without one the turn says
     * nothing about the model rather than fail.
     */
    private suspend fun choiceFor(sid: String): HermesChoice {
        val c = choice
        val isLocked = sid in locked()
        if (!c.picked && isLocked && _models.value.options == null) {
            val server = modelsServer
            runCatching { client.modelOptions() }.getOrNull()?.let { o -> if (server == modelsServer) _models.update { it.copy(options = o) } }
        }
        return c.forConversation(isLocked, _models.value.options)
    }

    /** Hermes took a turn that named a model, so [sid] keeps that lock until a turn names another. */
    private fun markLocked(sid: String) {
        val l = locked()
        if (sid !in l) prefs.hermesLocked.value = (listOf(sid) + l).take(200).joinToString(",")
    }

    /** Hermes compressed [old] into [new]: the lock, if any, is the new session's too. */
    private fun followLock(old: String, new: String) {
        val l = locked()
        if (old in l) prefs.hermesLocked.value = (listOf(new) + l.filter { it != old }).take(200).joinToString(",")
    }

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
        val m = (_state.value.messages + _state.value.call?.tasks.orEmpty().flatMap { it.messages }).firstOrNull { it.id == messageId } ?: return
        val run = m.runId ?: return
        if (m.status != "pending") return
        approval(messageId, choice)
        scope.launch {
            try {
                client.approve(run, choice)
            } catch (e: HermesError) {
                approval(messageId, "pending")
                set { it.copy(error = e.message) }
            }
        }
    }

    /** An approval's status, in the chat and in the call task it came from. */
    private fun approval(messageId: String, status: String) {
        fun List<ChatMessage>.mark() = map { if (it.id == messageId) it.copy(status = status) else it }
        set { s -> s.copy(messages = s.messages.mark(), call = s.call?.copy(tasks = s.call.tasks.map { t -> t.copy(messages = t.messages.mark()) })) }
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
            val choice = choiceFor(sid)
            client.chat(sid, message, instructions, choice).collect { event ->
                if (event is HermesEvent.RunStarted) {
                    runId = event.runId
                    // Hermes stores the lock before the run starts; a refused turn stores none.
                    if (choice.picked) markLocked(sid)
                }
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
                remember(newId); forget(sid); followLock(sid, newId); prefs.hermesSession.value = newId; loadedSession = newId
                prefs.hermesScroll.value = ChatScroll.moved(prefs.hermesScroll.value, sid, newId)
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
            }, ending = { (it as? OkHttpLiveTransport)?.ending ?: LiveSocketEnding() }, reconnect = { OkHttpLiveTransport({ key }) },
                standbyAfter = { prefs.hermesStandbySeconds.value.toDouble() },
                // Back from standby, a new session hears the conversation so far, the call's words and Hermes's replies.
                recap = { runCatching { CallSetup.resume(AssistantTranscript.liveRecap(_state.value.messages)) }.getOrNull() })
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
                        s.copy(call = s.call?.copy(status = status, connecting = false, hermesWorking = false, standby = false))
                    }
                    AssistantCall.Status.Working -> set { s ->
                        val status = if (s.call?.tapToTalk == true) "Tap to talk. Hermes is working." else "Listening while Hermes works."
                        s.copy(call = s.call?.copy(status = status, connecting = false, hermesWorking = true, standby = false))
                    }
                    AssistantCall.Status.Standby -> set { s ->
                        s.copy(call = s.call?.copy(status = "Paused Gemini while Hermes works, so it can't hear you. It comes back with the first answer.",
                                                   connecting = false, hermesWorking = true, standby = true))
                    }
                    AssistantCall.Status.Waking -> set { s -> s.copy(call = s.call?.copy(status = "Reconnecting to Gemini…", connecting = true, standby = false)) }
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

    /** Back from standby before Hermes finishes, to talk. */
    fun wakeCall() { call?.wake() }

    /** Cancels one of the call's tasks; the call and the other tasks go on, and Gemini is told. */
    fun cancelTask(id: String) { call?.cancelTask(id) }

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

    private fun task(id: String, f: (TaskUi) -> TaskUi) =
        set { s -> s.copy(call = s.call?.copy(tasks = s.call.tasks.map { if (it.id == id) f(it) else it })) }

    /**
     * Gemini's `ask_hermes`: the user's words go to Hermes as a task in a session of its own, so
     * several run at once. The chat shows a row for the task, any approval it asks for and its
     * reply; the call's task list shows its progress. Returns the reply for Gemini to speak.
     */
    private suspend fun runVoiceTask(request: HermesCall): String {
        val id = request.taskId
        val row = ChatMessage(UUID.randomUUID().toString(), "tool", "", toolName = "Hermes task $id", toolDetail = request.task, status = "running")
        messages { it + row }
        voiceBoundary = true
        set { s -> s.copy(call = s.call?.copy(tasks = s.call.tasks + TaskUi(id, request.task, messages = listOf(
            ChatMessage(UUID.randomUUID().toString(), "user", request.task, voice = true))))) }
        var turn = TurnState()
        var run: String? = null
        fun shown() = _state.value.call?.tasks?.firstOrNull { it.id == id }?.messages.orEmpty()
        fun apply(event: HermesEvent) {
            val (list, t) = AssistantTranscript.apply(shown(), turn, event)
            turn = t
            show(id, list, t)
        }
        try {
            val sid = try {
                client.createSession().id
            } catch (e: HermesError) {
                apply(HermesEvent.Failed(e.message.orEmpty()))
                return finished(id, row, turn.copy(status = "failed"))
            }
            remember(sid)
            turn = turn.copy(sessionId = sid)
            task(id) { it.copy(sessionId = sid) }
            messages { list -> list.map { if (it.id == row.id) it.copy(link = sid) else it } }
            val choice = choiceFor(sid)
            client.chat(sid, voiceMessage(request, LocalDate.now().toString()), null, choice).collect { event ->
                if (event is HermesEvent.RunStarted) {
                    run = event.runId
                    if (choice.picked) markLocked(sid)
                }
                apply(event)
            }
            if (!turn.finished) AssistantTranscript.finish(shown(), turn).let { (list, t) -> turn = t; show(id, list, t) }
            val newId = turn.sessionId
            if (newId != null && newId != sid) {
                // Hermes compressed the task's conversation into a new session: its link follows.
                remember(newId); forget(sid); followLock(sid, newId)
                task(id) { it.copy(sessionId = newId) }
                messages { list -> list.map { if (it.id == row.id) it.copy(link = newId) else it } }
            }
        } catch (e: HermesError) {
            if (e.code == "session_not_found") turn.sessionId?.let(::forget)
            apply(HermesEvent.Failed(e.message.orEmpty()))
            AssistantTranscript.finish(shown(), turn).let { (list, t) -> turn = t; show(id, list, t) }
        } catch (e: CancellationException) {
            // Cancelled by the user, Gemini or the call ending: closing the stream stops the turn, and Hermes is told too.
            withContext(NonCancellable) {
                run?.let { r -> scope.launch { runCatching { client.stop(r) } } }
                apply(HermesEvent.Finished("cancelled", null, null))
                finished(id, row, turn)
            }
            throw e
        }
        return finished(id, row, turn)
    }

    /** The task's conversation after an event: its progress for Gemini and the screen, and approvals in the chat. */
    private fun show(id: String, list: List<ChatMessage>, turn: TurnState) {
        val mine = list.filter { it.id in turn.ids }
        val waiting = mine.any { it.role == "approval" && it.status == "pending" }
        val latest = mine.lastOrNull { it.role == "tool" || it.role == "approval" || it.role == "assistant" }
        val progress = when {
            waiting -> "Waiting for the user to approve a command on the phone"
            latest?.role == "tool" && latest.status == "running" -> "Using ${latest.toolName}" + (latest.toolDetail?.let { ": $it" } ?: "")
            latest?.role == "assistant" && latest.streaming -> "Writing its reply"
            else -> null
        }
        task(id) { t -> t.copy(messages = list, progress = progress ?: t.progress, status = if (t.active) (if (waiting) "waiting" else "running") else t.status) }
        progress?.let { call?.progress(id, it) }
        // An approval waits for the user wherever they look: the chat shows it too.
        val known = _state.value.messages.map { it.id }.toSet()
        val approvals = mine.filter { it.role == "approval" && it.id !in known }
        if (approvals.isNotEmpty()) messages { it + approvals }
    }

    /** Marks the task done and its chat row; the reply joins the chat. Returns what Gemini hears. */
    private fun finished(id: String, row: ChatMessage, turn: TurnState): String {
        val status = when (turn.status) {
            "completed" -> "completed"
            "cancelled" -> "cancelled"
            null -> if (turn.answer.isNotBlank()) "completed" else "failed"
            else -> "failed"
        }
        val failure = _state.value.call?.tasks?.firstOrNull { it.id == id }?.messages?.lastOrNull { it.failed }?.text
        task(id) { it.copy(status = status, progress = null) }
        messages { list ->
            // Approvals nobody answered lapse with the task.
            val (marked, _) = AssistantTranscript.finish(list.map { if (it.id == row.id) it.copy(status = status) else it },
                                                         TurnState(ids = turn.ids.filter { i -> list.any { it.id == i && it.role == "approval" } }.toSet()))
            if (turn.answer.isNotBlank() && status != "cancelled") {
                marked + ChatMessage(UUID.randomUUID().toString(), "assistant", turn.answer, speaker = "Hermes · task $id")
            } else marked
        }
        voiceBoundary = true
        return when {
            status == "cancelled" -> "Cancelled. Completed actions were not undone."
            turn.answer.isNotBlank() -> turn.answer
            status == "failed" -> "Task failed. No automatic retry. Completed actions were not undone. " + failure.orEmpty()
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
