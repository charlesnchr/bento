package com.charles.bento.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.charles.bento.core.sync.CollectionSync
import com.charles.bento.core.sync.SyncConnection
import com.charles.bento.core.sync.SyncEndpoint
import com.charles.bento.core.sync.SyncStatus
import com.charles.bento.graph
import com.charles.bento.settings.Prefs
import com.charles.bento.settings.SecretStore
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * Keeps the collections (notes, todos, voice) in sync with the paired server: live
 * WebSockets while Bento is in use (an activity, the keyboard, a dictation, a meeting),
 * REST round trips from WorkManager otherwise, so widgets and the next launch are fresh
 * without a connection held open in the background.
 */
class SyncHub(
    private val context: Context,
    private val prefs: Prefs,
    private val secrets: SecretStore,
    private val http: OkHttpClient,
    /** Single-threaded: the engines' and stores' thread. */
    private val engine: CoroutineScope,
) {
    private val entries = mutableListOf<Pair<CollectionSync, SyncConnection>>()
    private var foreground = false
    private var holds = 0
    private var stopJob: Job? = null

    private val endpoint: () -> SyncEndpoint? = {
        if (!prefs.syncEnabled.value || prefs.server.value.isBlank() || prefs.resetPending.value) null
        else SyncEndpoint(prefs.server.value, secrets.syncToken)
    }

    /** The server and token while paired and syncing (for image blobs). */
    fun endpointNow(): SyncEndpoint? = endpoint()

    /** Adds a collection (call before [start]). */
    fun register(sync: CollectionSync): SyncConnection {
        sync.device = prefs.deviceName.value
        val c = SyncConnection(sync, http, engine, endpoint, userAgent = "Bento-Android/${com.charles.bento.BuildConfig.VERSION_NAME}",
                               log = { Log.i("BentoSync", it) })
        entries += sync to c
        return c
    }

    fun status(collection: String): StateFlow<SyncStatus>? = entries.firstOrNull { it.first.collection == collection }?.second?.status

    val connections: List<SyncConnection> get() = entries.map { it.second }

    fun start() {
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) { foreground = true; update() }
            override fun onStop(owner: LifecycleOwner) { foreground = false; update() }
        })
        // re-paired, unpaired, renamed: start over
        engine.launch {
            combine(prefs.server.flow, prefs.syncEnabled.flow, secrets.version, prefs.deviceName.flow) { s, e, v, d -> listOf(s, e, v, d) }
                .distinctUntilChanged().drop(1).collect {
                    entries.forEach { (sync, c) -> sync.device = prefs.deviceName.value; c.restart() }
                    if (!live) entries.forEach { it.second.stop() }
                    com.charles.bento.widget.Widgets.scheduleSync(context)
                }
        }
        context.getSystemService(ConnectivityManager::class.java).registerNetworkCallback(
            NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(),
            object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) { engine.launch { connections.forEach { it.networkChanged(true) } } }
                override fun onLost(network: Network) {}
            },
        )
        SyncWorker.schedulePeriodic(context)
    }

    /** Something besides an activity needs live sync (the keyboard, a meeting): balance with [release]. */
    fun hold() { holds++; update() }
    fun release() { holds = maxOf(0, holds - 1); update() }

    private val live get() = foreground || holds > 0

    private fun update() {
        engine.launch {
            if (live) {
                stopJob?.cancel(); stopJob = null
                connections.forEach { it.start(); it.verifyConnection() }
            } else if (stopJob == null) {
                // linger a little: switching apps and back shouldn't reconnect
                stopJob = engine.launch {
                    delay(45_000)
                    stopJob = null
                    if (!live) {
                        connections.forEach { it.stop() }
                        // anything still pending goes out in the background
                        if (entries.any { it.first.pendingCount > 0 }) SyncWorker.runSoon(context)
                    }
                }
            }
        }
    }

    /** A local change: send it now if connected, else soon from the background. */
    fun localChange(collection: String) {
        engine.launch {
            val c = entries.firstOrNull { it.first.collection == collection }?.second ?: return@launch
            if (live) c.localChange() else SyncWorker.runSoon(context)
        }
    }

    fun syncNow() { engine.launch { connections.forEach { it.syncNow() } } }

    /** Paired with a server and syncing. */
    val paired: Boolean get() = endpoint() != null

    // the periodic, widget and catch-up workers are separate unique works: one round trip at a time
    private val once = Mutex()

    /** Whether every server answered, and whether anything arrived from one. */
    data class Once(val ok: Boolean, val changed: Boolean)

    /** One REST round trip per collection (background). */
    suspend fun syncOnce(): Once = once.withLock {
        withContext(engine.coroutineContext[kotlin.coroutines.ContinuationInterceptor]!!) {
            if (live || endpoint() == null) return@withContext Once(ok = true, changed = false) // live, or not paired: nothing to do
            val before = entries.map { it.first.lastSeq }
            val ok = entries.map { it.second.syncOnce() }.all { it }
            Once(ok, changed = entries.map { it.first.lastSeq } != before)
        }
    }
}

/** Background sync: every few hours, and right after a change made while Bento wasn't open. */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val g = applicationContext.graph
        val result = g.sync.syncOnce()
        if (result.changed) g.onBackgroundSync()
        return if (result.ok) Result.success() else Result.retry()
    }

    companion object {
        private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        fun schedulePeriodic(context: Context) {
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                "sync", ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<SyncWorker>(3, TimeUnit.HOURS).setConstraints(online).build(),
            )
        }

        /** While a widget shows notes or tasks (and Bento is paired): every half hour too, so edits made elsewhere reach it. */
        fun scheduleForWidgets(context: Context, on: Boolean) {
            val work = WorkManager.getInstance(context)
            if (!on) { work.cancelUniqueWork("sync-widgets"); return }
            work.enqueueUniquePeriodicWork(
                "sync-widgets", ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<SyncWorker>(30, TimeUnit.MINUTES).setConstraints(online).build(),
            )
        }

        fun runSoon(context: Context) {
            WorkManager.getInstance(context).enqueueUniqueWork(
                // after one already running (it may have read the documents before this change)
                "sync-now", ExistingWorkPolicy.APPEND_OR_REPLACE,
                OneTimeWorkRequestBuilder<SyncWorker>().setConstraints(online)
                    .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST).build(),
            )
        }
    }
}
