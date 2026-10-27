package com.charles.bento

import android.app.Application
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

    var voicePipeline: VoicePipeline = Unwired
    var dictationSinks: DictationSinks = object : DictationSinks {
        override suspend fun captureThought(noteId: String?, text: String): String? = null
        override suspend fun addTask(text: String): String? = null
    }
    var voiceModes: () -> List<Pair<String, String>> = { emptyList() }
    var widgetData: com.charles.bento.widget.WidgetData = object : com.charles.bento.widget.WidgetData {
        override suspend fun notes(limit: Int) = emptyList<com.charles.bento.widget.NoteCard>()
        override suspend fun note(id: String): com.charles.bento.widget.NoteCard? = null
        override suspend fun tasks(view: String, limit: Int) = com.charles.bento.widget.TaskList("Today", emptyList(), 0)
        override suspend fun taskViews() = emptyList<Pair<String, String>>()
        override suspend fun toggleTask(id: String) {}
        override suspend fun toggleChecklistItem(noteId: String, line: Int) {}
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
