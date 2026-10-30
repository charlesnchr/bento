package com.charles.bento.voice

import android.Manifest
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.widget.Toast
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.charles.bento.MainActivity
import com.charles.bento.R
import com.charles.bento.core.voice.DictionaryEntry
import com.charles.bento.core.voice.meeting.MeetingConfig
import com.charles.bento.core.voice.meeting.MeetingDocument
import com.charles.bento.core.voice.meeting.MeetingEngine
import com.charles.bento.core.voice.meeting.MeetingMeta
import com.charles.bento.core.voice.meeting.MeetingNotes
import com.charles.bento.core.voice.meeting.MeetingParagraph
import com.charles.bento.core.voice.meeting.MeetingRecorder
import com.charles.bento.core.voice.meeting.MeetingSession
import com.charles.bento.settings.Prefs
import com.charles.bento.settings.SecretStore
import com.charles.bento.ui.voice.MeetingRow
import com.charles.bento.ui.voice.MeetingSource
import com.charles.bento.ui.voice.MeetingUi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/**
 * Meeting notes on the phone (the Mac's Meetings, mic only: Android doesn't let apps
 * record other apps' calls). Records under a microphone foreground service, shows the
 * transcript tidied as it goes, and files the finished notes as a synced Bento note.
 */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class MeetingController(
    private val context: Context,
    private val prefs: Prefs,
    private val secrets: SecretStore,
    private val voiceSync: VoiceSyncModule,
    private val scope: CoroutineScope,
    /** A dictation has the microphone. */
    private val dictating: () -> Boolean,
    /** Saves the notes as a Bento note (body markdown); returns its id. */
    private val fileNote: suspend (meetingId: String, markdown: String) -> String?,
) : MeetingSource {
    val engine = MeetingEngine(File(context.filesDir, "voice"))
    private var session: MeetingSession? = null
    private var capture: AudioCapture? = null
    private val finishing = MutableStateFlow<Set<String>>(emptySet())
    private val failures = MutableStateFlow<Map<String, String>>(emptyMap())
    private val _recording = MutableStateFlow<String?>(null)
    val recording: StateFlow<String?> = _recording.asStateFlow()
    private val _list = MutableStateFlow<List<MeetingRow>>(emptyList())
    val list: StateFlow<List<MeetingRow>> = _list.asStateFlow()
    private val active = MutableStateFlow<MeetingSession?>(null)
    private var timer: Job? = null
    private var starting = false

    /** Recording, or about to. */
    val isBusy: Boolean get() = session != null || starting

    init { refresh() }

    private fun config(key: String) = MeetingConfig(
        apiKey = key,
        dictionary = VoiceSyncModule.dictionary(voiceSync.docs.value).map { DictionaryEntry(it.term, it.misspelling, it.starred) },
        summary = prefs.meetingSummary.value,
        textModel = prefs.cleanupModel.value,
    )

    /** Starts recording; false when it can't (no key, no microphone permission, already recording). */
    fun start(): Boolean {
        if (isBusy) return false
        if (dictating()) {
            Toast.makeText(context, "Finish the dictation first", Toast.LENGTH_SHORT).show()
            return false
        }
        val key = secrets.geminiKey ?: run {
            Toast.makeText(context, "Meetings need a Gemini API key: pair with your Mac or add one in Settings", Toast.LENGTH_LONG).show()
            return false
        }
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            context.startActivity(Intent(context, MainActivity::class.java).setAction(MainActivity.ACTION_GRANT_MIC).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return false
        }
        starting = true
        scope.launch {
            try { begin(key) } finally { starting = false }
        }
        return true
    }

    private suspend fun begin(key: String) {
        if (!VoiceService.enter(context, VoiceService.KIND_MEETING)) {
            Toast.makeText(context, "Couldn't start recording right now", Toast.LENGTH_LONG).show()
            return
        }
        val s = runCatching { engine.start(config(key)) }.getOrElse {
            VoiceService.exit(context, VoiceService.KIND_MEETING)
            Toast.makeText(context, it.message ?: "Couldn't start the meeting", Toast.LENGTH_LONG).show()
            return
        }
        val c = AudioCapture(onFrame = { s.feed(it) }, noiseSuppression = true)
        if (!c.start()) {
            runCatching { s.stop() }
            VoiceService.exit(context, VoiceService.KIND_MEETING)
            Toast.makeText(context, "The microphone is in use by another app", Toast.LENGTH_LONG).show()
            return
        }
        session = s
        capture = c
        active.value = s
        _recording.value = s.id
        showRecordingNotification(s)
        refresh()
    }

    override fun stop(id: String) {
        val s = session?.takeIf { it.id == id } ?: return
        session = null
        capture?.stop()
        capture = null
        _recording.value = null
        finishing.value = finishing.value + id
        timer?.cancel()
        scope.launch {
            val notes = runCatching { s.stop() }
            VoiceService.exit(context, VoiceService.KIND_MEETING)
            notes.onSuccess { n -> file(id, n) }
                .onFailure { e -> failures.value = failures.value + (id to (e.message ?: "Couldn't finish the notes")) }
            finishing.value = finishing.value - id
            active.value = null
            refresh()
        }
    }

    override fun retry(id: String) {
        val key = secrets.geminiKey ?: return
        failures.value = failures.value - id
        finishing.value = finishing.value + id
        scope.launch {
            val notes = runCatching { withContext(Dispatchers.IO) { engine.retry(id, config(key)) } }
            notes.getOrNull()?.let { file(id, it) }
                ?: run { failures.value = failures.value + (id to (notes.exceptionOrNull()?.message ?: "Still couldn't transcribe it")) }
            finishing.value = finishing.value - id
            refresh()
        }
    }

    /** At launch: meetings a crash interrupted are finished and filed. */
    fun recover() {
        val key = secrets.geminiKey ?: return
        scope.launch {
            val recovered = runCatching { withContext(Dispatchers.IO) { engine.recoverInterrupted(config(key)) } }.getOrDefault(emptyList())
            recovered.forEach { file(it.document.meta.id, it) }
            if (recovered.isNotEmpty()) refresh()
            withContext(Dispatchers.IO) { runCatching { engine.purgeExpiredAudio(prefs.audioRetentionDays.value) } }
        }
    }

    /** The note a meeting was filed as. */
    fun noteFor(meetingId: String): String? = prefs.getString(noteKey(meetingId))

    private suspend fun file(id: String, notes: MeetingNotes) {
        val noteId = fileNote(id, notes.noteMarkdown)
        if (noteId != null) prefs.putString(noteKey(id), noteId)
        notifyDone(id, notes.title)
    }

    private fun noteKey(id: String) = "meeting.note.$id"

    private fun refresh() {
        scope.launch(Dispatchers.IO) {
            val fmt = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT).withZone(ZoneId.systemDefault())
            _list.value = engine.list().map { e ->
                val m = e.meta
                MeetingRow(
                    id = m.id,
                    title = m.title?.takeIf { it.isNotBlank() } ?: "Meeting",
                    subtitle = listOfNotNull(fmt.format(m.startedAt), m.endedAt?.let { duration(it.epochSecond - m.startedAt.epochSecond) }).joinToString(" · "),
                    recording = m.id == _recording.value,
                )
            }
        }
    }

    override fun meeting(id: String): StateFlow<MeetingUi?> {
        val live = active.flatMapLatest { s ->
            if (s == null || s.id != id) flowOf(null)
            else combine(s.document, s.interim, s.phase, finishing, failures) { doc, interim, phase, fin, fail ->
                ui(doc, interim, if (id in fin) MeetingUi.Phase.Finishing else if (phase == MeetingRecorder.Phase.IDLE) MeetingUi.Phase.Finishing else MeetingUi.Phase.Recording, fail[id])
            }
        }
        val stored = combine(finishing, failures, _list) { fin, fail, _ -> Triple(fin, fail, Unit) }
        return combine(live, stored) { l, (fin, fail, _) ->
            l ?: engine.load(id)?.let { doc ->
                ui(doc, "", when {
                    id in fin -> MeetingUi.Phase.Finishing
                    fail[id] != null -> MeetingUi.Phase.Failed
                    else -> MeetingUi.Phase.Done
                }, fail[id])
            }
        }.flowOn(Dispatchers.IO) // reading a finished meeting's file
            .stateIn(scope, SharingStarted.WhileSubscribed(5_000), null)
    }

    private fun ui(doc: MeetingDocument, interim: String, phase: MeetingUi.Phase, error: String?): MeetingUi {
        val m: MeetingMeta = doc.meta
        val summary = m.summary?.let { s -> (s.overview + s.decisions.map { "Decision: $it" }).joinToString("\n").ifBlank { null } }
        return MeetingUi(
            id = m.id,
            title = m.title?.takeIf { it.isNotBlank() } ?: "Meeting",
            startedAt = m.startedAt.toEpochMilli(),
            endedAt = m.endedAt?.toEpochMilli(),
            phase = phase,
            blocks = doc.paragraphs.mapNotNull { p ->
                when (val k = p.kind) {
                    MeetingParagraph.Kind.Cleaned -> MeetingUi.Block(p.text, tidy = true)
                    MeetingParagraph.Kind.Pending -> MeetingUi.Block(p.text, tidy = false)
                    is MeetingParagraph.Kind.Gap -> if (k.failed) MeetingUi.Block("[${k.seconds.toInt()} s not transcribed]", tidy = false) else null
                }
            },
            pending = interim,
            summary = summary,
            noteId = noteFor(m.id),
            error = error,
        )
    }

    private fun showRecordingNotification(s: MeetingSession) {
        val nm = context.getSystemService(NotificationManager::class.java)
        val open = PendingIntent.getActivity(
            context, 3, Intent(context, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN_MEETING).putExtra(MainActivity.EXTRA_ID, s.id),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stopIntent = PendingIntent.getActivity(
            context, 4, MainActivity.internal(context, MainActivity.ACTION_TOGGLE_MEETING),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val started = System.currentTimeMillis()
        nm.notify(
            VoiceService.NOTIFICATION_ID,
            NotificationCompat.Builder(context, VoiceService.CHANNEL_LISTENING)
                .setSmallIcon(R.drawable.ic_stat_mic).setContentTitle("Recording meeting")
                .setContentText("Tap to see the live transcript")
                .setWhen(started).setUsesChronometer(true).setShowWhen(true)
                .setOngoing(true).setSilent(true).setContentIntent(open)
                .addAction(0, "Stop", stopIntent)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .build(),
        )
    }

    private fun notifyDone(id: String, title: String) {
        val nm = context.getSystemService(NotificationManager::class.java)
        val open = PendingIntent.getActivity(
            context, 5, Intent(context, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN_MEETING).putExtra(MainActivity.EXTRA_ID, id),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        nm.notify(
            id.hashCode(),
            NotificationCompat.Builder(context, VoiceService.CHANNEL_LISTENING)
                .setSmallIcon(R.drawable.ic_stat_bento).setContentTitle("Meeting notes ready").setContentText(title)
                .setAutoCancel(true).setContentIntent(open).build(),
        )
    }

    private fun duration(seconds: Long): String = if (seconds >= 3600) "${seconds / 3600} h ${seconds / 60 % 60} min" else "${maxOf(1, seconds / 60)} min"
}
