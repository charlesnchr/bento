package com.charles.bento

import android.app.Application
import com.charles.bento.core.todo.TodoListView
import com.charles.bento.core.todo.title
import com.charles.bento.settings.Prefs
import com.charles.bento.settings.SecretStore
import com.charles.bento.sync.SyncHub
import com.charles.bento.update.Updater
import com.charles.bento.voice.DictationController
import com.charles.bento.voice.DictationSinks
import com.charles.bento.voice.VoicePipeline
import com.charles.bento.voice.VoiceRequest
import com.charles.bento.voice.VoiceSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import okhttp3.OkHttpClient
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** The process's singletons. Created once in [BentoApp]; reached through `context.graph`. */
class AppGraph(val app: Application) {
    val prefs = Prefs(app)
    val secrets = SecretStore(app)

    /** UI-side coordination (dictation, overlays). */
    val main: CoroutineScope = MainScope()

    /** The stores' and sync engines' thread: every document change happens here, in order. */
    val engineDispatcher = Executors.newSingleThreadExecutor { r -> Thread(r, "bento-engine").apply { isDaemon = true } }
        .asCoroutineDispatcher()
    val engine: CoroutineScope = CoroutineScope(SupervisorJob() + engineDispatcher)

    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // WebSockets and streaming; requests set their own
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    val sync = SyncHub(app, prefs, secrets, http, engine)
    val updater = Updater(app, http, prefs)

    val todo = com.charles.bento.todo.TodoModule(app, prefs, sync, engineDispatcher)
    val voiceSync = com.charles.bento.voice.VoiceSyncModule(app, prefs, sync, engineDispatcher)

    var voicePipeline: VoicePipeline = Unwired
    var captureThought: suspend (noteId: String?, text: String) -> String? = { _, _ -> null }
    var dictationSinks: DictationSinks = object : DictationSinks {
        override suspend fun captureThought(noteId: String?, text: String): String? = this@AppGraph.captureThought(noteId, text)
        override suspend fun addTask(text: String): String? = todo.perform {
            val (defaults, anchor) = addDefaults(TodoListView.Inbox)
            quickAdd(text, defaults, anchor)?.title
        }
    }
    var voiceModes: () -> List<Pair<String, String>> = {
        com.charles.bento.voice.VoiceSyncModule.modes(voiceSync.docs.value).map { it.id to it.name }
    }
    val widgetData = com.charles.bento.widget.AppWidgetData(this)

    var voiceLists: com.charles.bento.ui.voice.VoiceLists = object : com.charles.bento.ui.voice.VoiceLists {
        override val meetings = kotlinx.coroutines.flow.MutableStateFlow(emptyList<com.charles.bento.ui.voice.MeetingRow>())
        override val history = kotlinx.coroutines.flow.MutableStateFlow(emptyList<com.charles.bento.ui.voice.HistoryRow>())
        override val recordingMeeting = kotlinx.coroutines.flow.MutableStateFlow<String?>(null)
        override fun startMeeting(): String? = null
        override fun stopMeeting() {}
        override fun retry(historyId: String) {}
    }

    var meetingSource: com.charles.bento.ui.voice.MeetingSource = object : com.charles.bento.ui.voice.MeetingSource {
        override fun meeting(id: String) = kotlinx.coroutines.flow.MutableStateFlow<com.charles.bento.ui.voice.MeetingUi?>(null)
        override fun stop(id: String) {}
        override fun retry(id: String) {}
    }

    val dictation = DictationController(app, prefs, main, { voicePipeline }, { dictationSinks }, { voiceModes() })

    fun start() {
        sync.start()
        Updater.schedule(app)
    }

    /** After a background sync: refresh widgets. */
    suspend fun onBackgroundSync() {}

    private object Unwired : VoicePipeline {
        override fun open(request: VoiceRequest, onPartial: (String) -> Unit): VoiceSession = error("Voice engine not available")
        override suspend fun edit(instruction: String, text: String, request: VoiceRequest): String = text
        override fun unavailableReason(): String = "Voice engine not available"
    }
}
