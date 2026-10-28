package com.charles.bento.widget

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.glance.appwidget.updateAll
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.charles.bento.graph
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.LocalDate
import java.time.LocalDateTime
import java.util.concurrent.TimeUnit

/** What the widgets show, from the stores' snapshots (cheap, any thread). */
interface WidgetData {
    fun notes(limit: Int): List<NoteCard>
    fun note(id: String): NoteCard?
    fun tasks(view: String, limit: Int): TaskList
    /** Inbox, Today, Upcoming, then projects: (view id, label). */
    fun taskViews(): List<Pair<String, String>>
    suspend fun toggleTask(id: String)
    /** Ticks or unticks the `- [ ]` item on a body line of a note. */
    suspend fun toggleChecklistItem(noteId: String, line: Int)
}

data class NoteCard(
    val id: String,
    val title: String,
    /** First lines after the title, plain text, for the list widget. */
    val snippet: String,
    val pinned: Boolean,
    val updatedAt: Long,
    /** The body as display lines, for the single-note widget. */
    val lines: List<NoteLine> = emptyList(),
)

sealed interface NoteLine {
    val index: Int
    data class Text(override val index: Int, val text: String, val heading: Boolean) : NoteLine
    data class Check(override val index: Int, val text: String, val checked: Boolean) : NoteLine
    data class Bullet(override val index: Int, val text: String) : NoteLine
}

data class TaskList(val title: String, val tasks: List<TaskCard>, val overdueCount: Int)

data class TaskCard(
    val id: String,
    val title: String,
    /** "Today", "Tomorrow 17:00", "Mon 3 Nov"; null without a date. */
    val due: String?,
    val overdue: Boolean,
    /** 1…4 (p1 highest). */
    val priority: Int,
    val project: String?,
    val completed: Boolean,
)

/** Redraws every Bento widget, at most a few times a second. */
object Widgets {
    private var pending: Job? = null
    private val _today = MutableStateFlow(LocalDate.now())
    /** Today, as of the last redraw: what's due today or overdue depends on it. */
    val today: StateFlow<LocalDate> = _today

    fun refresh(context: Context, delayMs: Long = 300) {
        val app = context.applicationContext
        pending?.cancel()
        pending = app.graph.main.launch {
            delay(delayMs)
            updateNow(app)
        }
    }

    suspend fun updateNow(context: Context) {
        val app = context.applicationContext
        _today.value = LocalDate.now()
        NotesWidget().updateAll(app)
        NoteWidget().updateAll(app)
        TasksWidget().updateAll(app)
    }

    /** A redraw just after midnight every day (Today becomes tomorrow's list). */
    fun scheduleDaily(context: Context) {
        val untilMidnight = Duration.between(LocalDateTime.now(), LocalDate.now().plusDays(1).atStartOfDay()).plusMinutes(1)
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            "widgets-daily", ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<WidgetDayWorker>(1, TimeUnit.DAYS).setInitialDelay(untilMidnight.toMillis(), TimeUnit.MILLISECONDS).build(),
        )
    }
}

class WidgetDayWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        Widgets.updateNow(applicationContext)
        return Result.success()
    }
}

/** The clock or the time zone changed: the day may have too. */
class WidgetClockReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = Widgets.refresh(context, delayMs = 0)
}
