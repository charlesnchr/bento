package com.charles.bento.voice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.charles.bento.MainActivity
import com.charles.bento.R
import com.charles.bento.graph
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

/**
 * A microphone foreground service for as long as Bento listens (a dictation into another
 * app, a captured thought, a meeting, a voice call with Hermes). Android only lets an app
 * record while it is in the foreground or runs one of these, so it starts before the
 * microphone opens and stops right after. A dictation while a call is in standby shares it:
 * the service stops when the last of them leaves.
 */
class VoiceService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val kind = intent?.getStringExtra(EXTRA_KIND) ?: KIND_DICTATION
        if (intent?.action == ACTION_STOP) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_END_CALL) {
            // the call's notification: ending the call takes the service down with it
            applicationContext.graph.assistant.endCall()
            return START_NOT_STICKY
        }
        val ok = runCatching {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(this, kind), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        }.isSuccess
        ready?.complete(ok)
        ready = null
        if (!ok) stopSelf()
        return START_NOT_STICKY
    }

    companion object {
        private const val ACTION_STOP = "com.charles.bento.voice.STOP"
        private const val ACTION_END_CALL = "com.charles.bento.voice.END_CALL"
        private const val EXTRA_KIND = "kind"
        const val KIND_DICTATION = "dictation"
        const val KIND_MEETING = "meeting"
        const val KIND_ASSISTANT = "assistant"
        const val NOTIFICATION_ID = 41
        const val CHANNEL_LISTENING = "listening"
        private var ready: CompletableDeferred<Boolean>? = null
        private val holders = VoiceHolders()

        /** Starts the service and waits until it's in the foreground (false: not allowed right now). Main thread. */
        suspend fun enter(context: Context, kind: String): Boolean {
            if (!holders.empty) {
                // already in the foreground for another (a call in standby, during a dictation; a meeting
                // still finishing its notes, as a call starts): this one joins it
                holders.add(kind)?.let { show(context, it) }
                return true
            }
            ensureChannels(context)
            val d = CompletableDeferred<Boolean>()
            ready = d
            val ok = runCatching {
                ContextCompat.startForegroundService(context, Intent(context, VoiceService::class.java).putExtra(EXTRA_KIND, kind))
            }.isSuccess
            if (!ok) return false
            val started = withTimeoutOrNull(3_000) { d.await() } ?: false
            if (started) holders.add(kind)
            return started
        }

        /** [kind] is done: the service stops when nothing else is in it, else shows what's left. Main thread. */
        fun exit(context: Context, kind: String) {
            val changed = holders.remove(kind)
            // also when kind never got in: an enter cancelled midway may still have started the service
            if (holders.empty) {
                runCatching { context.startService(Intent(context, VoiceService::class.java).setAction(ACTION_STOP)) }
                return
            }
            changed?.let { show(context, it) }
        }

        /** Replaces the running service's notification with [kind]'s. */
        private fun show(context: Context, kind: String) {
            runCatching { context.getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(context, kind)) }
        }

        fun ensureChannels(context: Context) {
            val nm = context.getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL_LISTENING) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_LISTENING, "Listening", NotificationManager.IMPORTANCE_LOW).apply {
                        description = "Shown while Bento records a dictation or a meeting"
                        setShowBadge(false)
                    },
                )
            }
        }

        fun notification(context: Context, kind: String): Notification {
            val open = PendingIntent.getActivity(
                context, 0,
                Intent(context, MainActivity::class.java).setAction(
                    when (kind) {
                        KIND_MEETING -> MainActivity.ACTION_OPEN_MEETING
                        KIND_ASSISTANT -> MainActivity.ACTION_OPEN_ASSISTANT
                        else -> Intent.ACTION_MAIN
                    },
                ),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val builder = NotificationCompat.Builder(context, CHANNEL_LISTENING)
                .setSmallIcon(R.drawable.ic_stat_mic)
                .setContentTitle(when (kind) { KIND_MEETING -> "Recording meeting"; KIND_ASSISTANT -> "Voice call with Hermes"; else -> "Listening" })
                .setOngoing(true)
                .setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .setContentIntent(open)
            if (kind == KIND_ASSISTANT) {
                val end = PendingIntent.getService(
                    context, 1, Intent(context, VoiceService::class.java).setAction(ACTION_END_CALL),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                )
                builder.addAction(R.drawable.ic_stat_mic, "End call", end)
            }
            return builder.build()
        }
    }
}

/**
 * The kinds in the [VoiceService] and the one whose notification it shows: the call's while
 * there is one (it has End call), else the latest to come in. Main thread.
 */
internal class VoiceHolders {
    private val kinds = LinkedHashSet<String>()
    val empty: Boolean get() = kinds.isEmpty()
    val shown: String? get() = if (VoiceService.KIND_ASSISTANT in kinds) VoiceService.KIND_ASSISTANT else kinds.lastOrNull()

    /** Adds [kind]; the notification to show now, or null when it stays as it is. */
    fun add(kind: String): String? = change { kinds.remove(kind); kinds.add(kind) }

    /** Removes [kind] (fine if it never got in); the notification to show now, or null when it stays or nothing is left. */
    fun remove(kind: String): String? = change { kinds.remove(kind) }

    private inline fun change(f: () -> Unit): String? {
        val before = shown
        f()
        return shown.takeIf { it != before }
    }
}
