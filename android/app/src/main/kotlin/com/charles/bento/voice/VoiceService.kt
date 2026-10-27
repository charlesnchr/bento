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
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

/**
 * A microphone foreground service for as long as Bento listens (a dictation into another
 * app, a captured thought, a meeting). Android only lets an app record while it is in
 * the foreground or runs one of these, so it starts before the microphone opens and
 * stops right after.
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
        private const val EXTRA_KIND = "kind"
        const val KIND_DICTATION = "dictation"
        const val KIND_MEETING = "meeting"
        const val NOTIFICATION_ID = 41
        const val CHANNEL_LISTENING = "listening"
        private var ready: CompletableDeferred<Boolean>? = null

        /** Starts the service and waits until it's in the foreground (false: not allowed right now). */
        suspend fun enter(context: Context, kind: String): Boolean {
            ensureChannels(context)
            val d = CompletableDeferred<Boolean>()
            ready = d
            val ok = runCatching {
                ContextCompat.startForegroundService(context, Intent(context, VoiceService::class.java).putExtra(EXTRA_KIND, kind))
            }.isSuccess
            if (!ok) return false
            return withTimeoutOrNull(3_000) { d.await() } ?: false
        }

        fun exit(context: Context) {
            runCatching { context.startService(Intent(context, VoiceService::class.java).setAction(ACTION_STOP)) }
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
                Intent(context, MainActivity::class.java).setAction(if (kind == KIND_MEETING) MainActivity.ACTION_OPEN_MEETING else Intent.ACTION_MAIN),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            return NotificationCompat.Builder(context, CHANNEL_LISTENING)
                .setSmallIcon(R.drawable.ic_stat_mic)
                .setContentTitle(if (kind == KIND_MEETING) "Recording meeting" else "Listening")
                .setOngoing(true)
                .setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .setContentIntent(open)
                .build()
        }
    }
}
