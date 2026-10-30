package com.charles.bento

import android.app.Application
import com.charles.bento.core.todo.title
import com.charles.bento.settings.Prefs
import com.charles.bento.settings.SecretStore
import com.charles.bento.sync.SyncHub
import com.charles.bento.update.Updater
import com.charles.bento.voice.DictationController
import com.charles.bento.voice.DictationSinks
import com.charles.bento.voice.VoicePipeline
import com.charles.bento.widget.WidgetConfigs
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

    init {
        if (prefs.resetPending.value) {
            // paired with another server: this phone's documents and sync state described the old one
            listOf("notes.db", "todos.db", "voice.db").forEach(app::deleteDatabase)
            // the notes' images too: pending uploads belong to the old server's notes
            java.io.File(app.filesDir, com.charles.bento.notes.NotesModule.IMAGES_DIR).deleteRecursively()
            prefs.thoughtNote.value = ""
            prefs.resetPending.value = false
            prefs.flush()
        } else if (prefs.syncedServer.value.isEmpty() && prefs.server.value.isNotBlank()) {
            prefs.syncedServer.value = com.charles.bento.settings.serverKey(prefs.server.value)
        }
    }

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

    val notes = com.charles.bento.notes.NotesModule(app, prefs, sync, http, engineDispatcher, engine)
    val todo = com.charles.bento.todo.TodoModule(app, prefs, sync, engineDispatcher)

    init {
        // images still to upload count as unsent changes: background sync sends them
        sync.pendingImages = { notes.images.store.pendingUploads.isNotEmpty() }
        sync.uploadImages = { notes.images.syncNow() }
    }
    val voiceSync = com.charles.bento.voice.VoiceSyncModule(app, prefs, sync, engineDispatcher)

    /** Files text as a new Bento note; returns its id. */
    val createNote: suspend (body: String) -> String? = { body -> notes.create(body) }
    val voice = com.charles.bento.voice.GeminiVoice(app, prefs, secrets, voiceSync, main)
    val voicePipeline: VoicePipeline get() = voice
    val meetings: com.charles.bento.voice.MeetingController = com.charles.bento.voice.MeetingController(app, prefs, secrets, voiceSync, main, { dictation.isBusy || assistant.callActive }) { _, md -> createNote(md) }
    val assistant = com.charles.bento.assistant.AssistantController(app, prefs, secrets, http, main) { dictation.isBusy || meetings.isBusy }
    val captureThought: suspend (noteId: String?, text: String) -> String? = { id, text -> notes.captureThought(id, text) }
    var dictationSinks: DictationSinks = object : DictationSinks {
        override suspend fun captureThought(noteId: String?, text: String): String? = this@AppGraph.captureThought(noteId, text)
        override suspend fun addTask(text: String, view: String?): String? = todo.perform {
            val (defaults, anchor) = addDefaults(WidgetConfigs.addTo(view, store.projects.map { it.id }))
            quickAdd(spokenTask(text), defaults, anchor)?.title
        }
    }
    var voiceModes: () -> List<Pair<String, String>> = {
        com.charles.bento.voice.VoiceSyncModule.modes(voiceSync.docs.value).map { it.id to it.name }
    }
    val widgetData = com.charles.bento.widget.AppWidgetData(this).also { it.attachNotes(com.charles.bento.widget.NotesWidgetSource(notes)) }
    val widgetConfigs = com.charles.bento.widget.WidgetConfigs(prefs::getString, prefs::putString)

    val voiceLists: com.charles.bento.ui.voice.VoiceLists = object : com.charles.bento.ui.voice.VoiceLists {
        override val meetings get() = this@AppGraph.meetings.list
        override val history get() = voice.history
        override val recordingMeeting get() = this@AppGraph.meetings.recording
        override fun startMeeting() = this@AppGraph.meetings.start()
        override fun stopMeeting() { this@AppGraph.meetings.recording.value?.let(this@AppGraph.meetings::stop) }
        override fun retry(historyId: String) = voice.retry(historyId)
    }
    val meetingSource: com.charles.bento.ui.voice.MeetingSource get() = meetings

    val dictation: DictationController = DictationController(app, prefs, main, { voicePipeline }, { dictationSinks }, { voiceModes() },
        claimMicrophone = {
            when {
                meetings.isBusy -> "A meeting is recording. Stop it to dictate"
                // a call in standby lends its microphone; one listening or speaking keeps it
                !assistant.lendMicrophone() -> "The voice call with Hermes is listening. Dictate once it pauses, or end it"
                else -> null
            }
        },
        releaseMicrophone = { assistant.reclaimMicrophone() })

    fun start() {
        sync.start()
        Updater.schedule(app)
        com.charles.bento.widget.Widgets.scheduleDaily(app)
        com.charles.bento.widget.Widgets.scheduleSync(app)
        voice.recover()
        meetings.recover()
        // recordings that waited for a connection go out as soon as there is one
        app.getSystemService(android.net.ConnectivityManager::class.java).registerDefaultNetworkCallback(
            object : android.net.ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: android.net.Network) = voice.recover()
            },
        )
    }

    /** After a background sync that brought changes: refresh widgets. */
    suspend fun onBackgroundSync() = com.charles.bento.widget.Widgets.updateNow(app)

}

/** Dictated task text as quick add expects it: "5 p.m." → "5 pm", no closing full stop. */
internal fun spokenTask(text: String): String =
    text.trim()
        .replace(Regex("\\b([ap])\\.m\\.", RegexOption.IGNORE_CASE)) { "${it.groupValues[1].lowercase()}m" }
        .trimEnd('.', '!', ' ')
