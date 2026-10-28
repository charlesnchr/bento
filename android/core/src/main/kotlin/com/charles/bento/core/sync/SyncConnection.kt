package com.charles.bento.core.sync

import com.charles.bento.core.json.wireBool
import com.charles.bento.core.json.wireLong
import com.charles.bento.core.json.wireString
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.random.Random

/** Where to sync: the bento-sync server and its bearer token (null: none stored). */
data class SyncEndpoint(val server: String, val token: String?)

enum class SyncState { Disabled, NoServer, NoToken, Connecting, Connected, Polling, Offline, Unauthorized, ServerTooOld }

/** Observable sync status for the app's footers, settings and widgets. */
data class SyncStatus(
    val state: SyncState = SyncState.Disabled,
    /** Why it's offline ("no network", "timeout"…). */
    val reason: String? = null,
    val pending: Int = 0,
    /** Documents the server can't take (too large / refused); they stay local until edited. */
    val blocked: Int = 0,
    /** Wall-clock ms of the last message from the server. */
    val lastSync: Long? = null,
    val lastError: String? = null,
) {
    val isHealthy: Boolean get() = (state == SyncState.Connected || state == SyncState.Polling) && blocked == 0
    val isLive: Boolean get() = state == SyncState.Connected

    /** "Synced", "Syncing 3 changes…", "Offline · 2 changes pending"… `noun`: "note", "task". */
    fun summary(noun: String): String {
        fun changes(n: Int) = "$n change${if (n == 1) "" else "s"}"
        if (blocked > 0 && (state == SyncState.Connected || state == SyncState.Polling)) {
            return "$blocked $noun${if (blocked == 1) "" else "s"} can't sync"
        }
        return when (state) {
            SyncState.Disabled -> "Sync off"
            SyncState.NoServer -> "No sync server"
            SyncState.NoToken -> "No sync token"
            SyncState.Connecting -> "Connecting…"
            SyncState.Connected -> if (pending > 0) "Syncing ${changes(pending)}…" else "Synced"
            SyncState.Polling -> if (pending > 0) "Syncing (polling)…" else "Synced (polling)"
            SyncState.Offline -> if (pending > 0) "Offline · ${changes(pending)} pending" else "Offline (${reason ?: "retrying"})"
            SyncState.Unauthorized -> "Token rejected"
            SyncState.ServerTooOld -> "Server needs an update"
        }
    }
}

/**
 * Transport for one collection of the sync protocol (docs/SYNC_PROTOCOL.md): WebSocket
 * push with reconnect and backoff, REST polling only as a fallback when the WebSocket
 * upgrade keeps failing while REST works (a proxy). A port of the Mac's SyncClient /
 * TodoSyncClient, with the documents handled by a [CollectionSync].
 *
 * Everything runs on [scope], which must be single threaded (the same dispatcher the app
 * makes local changes on): OkHttp callbacks hop onto it before touching the engine.
 */
class SyncConnection(
    private val sync: CollectionSync,
    private val http: OkHttpClient,
    private val scope: CoroutineScope,
    /** Read on every connect, so a re-paired server or rotated token applies at once. Null: sync off. */
    private val endpoint: () -> SyncEndpoint?,
    private val userAgent: String = "Bento-Android/1",
    private val log: (String) -> Unit = {},
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val _status = MutableStateFlow(SyncStatus())
    val status: StateFlow<SyncStatus> = _status.asStateFlow()

    private var ws: WebSocket? = null
    private var helloDone = false
    private var generation = 0
    private var running = false
    private var token: String? = null
    private var base: HttpUrl? = null
    private var backoffSeconds = 1.0
    private var wsFailures = 0
    private var collectionsOK = false
    private var lastPoll: Long? = null
    private var lastReceive = 0L
    private var debounceStart: Long? = null

    private var retryJob: Job? = null
    private var sendJob: Job? = null
    private var pollJob: Job? = null
    private var wsRetryJob: Job? = null
    private var pingCheckJob: Job? = null
    private var ackWatchJob: Job? = null

    private val json = Json { ignoreUnknownKeys = true }

    // MARK: Lifecycle

    /** Starts syncing (no-op when running). */
    fun start() {
        if (running) return
        val e = endpoint()
        if (e == null) { setState(SyncState.Disabled); return }
        if (e.server.isBlank()) { setState(SyncState.NoServer); return }
        running = true
        connect()
    }

    fun stop() {
        running = false
        generation++
        listOf(retryJob, sendJob, pollJob, wsRetryJob, pingCheckJob, ackWatchJob).forEach { it?.cancel() }
        retryJob = null; sendJob = null; pollJob = null; wsRetryJob = null; pingCheckJob = null; ackWatchJob = null
        debounceStart = null
        ws?.close(1001, null)
        ws = null
        helloDone = false
        collectionsOK = false
        sync.reset()
        if (endpoint() == null) setState(SyncState.Disabled)
    }

    /** Settings changed (paired, unpaired, new server): start over. */
    fun restart() {
        stop()
        backoffSeconds = 1.0
        wsFailures = 0
        start()
    }

    /** "Sync now": reconnect immediately, or poll once in fallback mode. */
    fun syncNow() {
        if (!running) { restart(); return }
        when {
            status.value.state == SyncState.Polling -> { poll(); flushSoon(0); connect() }
            status.value.state == SyncState.Connected && ws != null -> { verifyConnection(); flushSoon(0) }
            else -> restart()
        }
    }

    /** A local document changed: send it after a short debounce (at most 2 s after the first unsent change). */
    fun localChange() {
        updatePending()
        scheduleFlush()
    }

    /** The network came back or changed (Wi-Fi ↔ cellular, VPN): reconnect or make sure the socket survived. */
    fun networkChanged(available: Boolean) {
        if (!running || !available) return
        when (status.value.state) {
            SyncState.Offline -> { backoffSeconds = 1.0; connect() }
            SyncState.Connected -> verifyConnection()
            else -> {}
        }
    }

    // MARK: Connection

    private fun connect() {
        if (!running) return
        retryJob?.cancel()
        ws?.let { old ->
            ws = null
            old.close(1001, null)
            sync.reset()
        }
        val e = endpoint()
        if (e == null) { stop(); return }
        token = e.token?.trim()?.takeIf { it.isNotEmpty() }
        if (token == null) {
            setState(SyncState.NoToken)
            scheduleRetry(maxDelay = 60.0, reason = "no token")
            return
        }
        base = baseUrl(e.server)
        val b = base
        if (b == null) {
            setState(SyncState.Offline, reason = "bad server URL")
            return
        }
        if (sync.needsCollections && !collectionsOK) { verifyCollections(); return }
        val url = b.newBuilder().addPathSegments("v1/sync").build().toString()
            .replaceFirst("https://", "wss://").replaceFirst("http://", "ws://")
        if (status.value.state != SyncState.Polling) setState(SyncState.Connecting)
        generation++
        helloDone = false
        val gen = generation
        val req = Request.Builder().url(url)
            .header("Authorization", "Bearer $token")
            .header("User-Agent", userAgent)
            .build()
        val socket = http.newWebSocket(req, Listener(gen))
        ws = socket
        val hello = buildJsonObject {
            put("type", "hello")
            put("since", sync.lastSeq)
            put("device", sync.device)
            if (sync.needsCollections) put("collections", JsonArray(listOf(JsonPrimitive(sync.collection))))
        }
        socket.send(hello.toString())
    }

    private inner class Listener(private val gen: Int) : WebSocketListener() {
        private fun onEngine(block: (WebSocket) -> Unit) {
            scope.launch {
                val s = ws
                if (gen == generation && s != null) block(s)
            }
        }

        override fun onOpen(webSocket: WebSocket, response: Response) = onEngine { log("${sync.collection}: WebSocket open") }

        override fun onMessage(webSocket: WebSocket, text: String) = onEngine { s -> if (s === webSocket) handle(text) }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = onEngine { s ->
            if (s === webSocket) connectionLost("closed ($code)", wasUpgradeFailure = false)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            val code = response?.code
            response?.close()
            onEngine { s ->
                if (s !== webSocket) return@onEngine
                if (code == 401) unauthorized() else connectionLost(t.message ?: t.javaClass.simpleName, wasUpgradeFailure = !helloDone)
            }
        }
    }

    private fun handle(text: String) {
        lastReceive = now()
        val obj = runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return
        when (obj.wireString("type")) {
            "snapshot" -> {
                val docs = (obj["notes"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
                val seq = obj.wireLong("seq") ?: 0
                if (sync.applySnapshot(docs, seq)) {
                    log("${sync.collection}: server seq went backwards ($seq); resyncing from 0")
                    connect()
                    return
                }
                sync.connectionOpened() // refused puts get another try on every connection
                helloDone = true
                backoffSeconds = 1.0
                wsFailures = 0
                pollJob?.cancel(); pollJob = null
                wsRetryJob?.cancel(); wsRetryJob = null
                _status.update { it.copy(state = SyncState.Connected, reason = null, lastError = null, lastSync = now()) }
                flushSoon(0)
            }
            "ack" -> {
                val id = obj.wireString("id") ?: return
                sync.ack(id, obj.wireLong("seq"), obj.wireBool("accepted") ?: false, ordered = true)
                markSynced()
            }
            "note" -> {
                (obj["note"] as? JsonObject)?.let { sync.applyRemote(it, ordered = true); markSynced() }
            }
            "pong" -> { pingCheckJob?.cancel(); pingCheckJob = null }
            "error" -> {
                val msg = obj.wireString("message") ?: "error"
                log("${sync.collection}: server error: $msg")
                _status.update { it.copy(lastError = msg) }
                obj.wireString("id")?.let { sync.putFailed(it) }
            }
        }
        if (!sync.hasInflight) { ackWatchJob?.cancel(); ackWatchJob = null }
        // edits made while puts were in flight, conflicted copies, documents to resend after
        // a rejection: all go out with the normal debounce
        if (helloDone && sendJob == null && sync.outgoing().isNotEmpty()) scheduleFlush()
        updatePending()
    }

    /** A put whose ack doesn't come back means the socket is dead even if the OS hasn't noticed yet. */
    private fun watchAcks() {
        if (ackWatchJob != null) return
        val socket = ws ?: return
        ackWatchJob = scope.launch {
            delay(20_000)
            ackWatchJob = null
            if (socket !== ws || !sync.hasInflight) return@launch
            if (now() - lastReceive >= 20_000) {
                log("${sync.collection}: no ack for 20 s; reconnecting")
                connectionLost("timeout", wasUpgradeFailure = false)
            } else {
                watchAcks() // traffic is flowing (big snapshot, many acks): keep watching
            }
        }
    }

    private fun connectionLost(error: String, wasUpgradeFailure: Boolean) {
        if (!running) return
        ws?.cancel()
        ws = null
        helloDone = false
        sync.reset()
        collectionsOK = false // the server may have been replaced (e.g. rolled back): check again
        _status.update { it.copy(lastError = error) }
        val gen = generation
        if (!wasUpgradeFailure) {
            if (status.value.state != SyncState.Polling) setState(SyncState.Offline, reason = shortReason(error))
            scheduleRetry(maxDelay = 60.0, reason = error)
            return
        }
        // Only a WebSocket-specific failure (REST reachable) counts towards the polling
        // fallback; a server that is simply down keeps the normal reconnect backoff.
        scope.launch {
            val reachable = health()?.containsKey("ok") == true
            if (!running || gen != generation || ws != null) return@launch
            if (reachable) wsFailures++
            if (wsFailures >= 3) {
                enterPollingFallback()
            } else {
                if (status.value.state != SyncState.Polling) setState(SyncState.Offline, reason = shortReason(error))
                scheduleRetry(maxDelay = 60.0, reason = error)
            }
        }
    }

    /** Collections other than `notes` need a server that has them, or it would store our documents as notes. */
    private fun verifyCollections() {
        if (status.value.state != SyncState.Polling) setState(SyncState.Connecting)
        val gen = generation
        scope.launch {
            val h = health()
            if (!running || gen != generation || ws != null) return@launch
            when {
                h?.wireBool("collections") == true -> { collectionsOK = true; connect() }
                h != null -> {
                    log("${sync.collection}: sync server has no collections")
                    _status.update {
                        it.copy(state = SyncState.ServerTooOld, lastError = "The sync server is too old (no collections); update bento-sync")
                    }
                    scheduleRetry(maxDelay = 300.0, reason = "server lacks collections", minDelay = 120.0)
                }
                else -> {
                    setState(SyncState.Offline, reason = "unreachable")
                    scheduleRetry(maxDelay = 60.0, reason = "health failed")
                }
            }
        }
    }

    private suspend fun health(): JsonObject? {
        val b = base ?: return null
        val req = Request.Builder().url(b.newBuilder().addPathSegments("v1/health").build()).header("User-Agent", userAgent).build()
        return runCatching {
            http.newCall(req).await().use { r ->
                if (r.code != 200) null else json.parseToJsonElement(r.body.string()) as? JsonObject
            }
        }.getOrNull()
    }

    private fun unauthorized() {
        ws?.cancel()
        ws = null
        helloDone = false
        sync.reset()
        // The token may have been replaced (re-paired): retry quickly if it changed.
        val fresh = endpoint()?.token?.trim()?.takeIf { it.isNotEmpty() }
        if (fresh != null && fresh != token) {
            token = fresh
            backoffSeconds = 1.0
            scheduleRetry(maxDelay = 1.0, reason = "token changed")
            return
        }
        _status.update { it.copy(state = SyncState.Unauthorized, lastError = "401 Unauthorized") }
        scheduleRetry(maxDelay = 60.0, reason = "unauthorized", minDelay = 30.0)
    }

    private fun scheduleRetry(maxDelay: Double, reason: String, minDelay: Double = 0.0) {
        retryJob?.cancel()
        val delaySeconds = maxOf(minDelay, minOf(backoffSeconds, maxDelay)) * Random.nextDouble(0.85, 1.15)
        backoffSeconds = minOf(backoffSeconds * 2, 60.0)
        log("${sync.collection}: retry in ${"%.1f".format(delaySeconds)}s ($reason)")
        retryJob = scope.launch {
            delay((delaySeconds * 1000).toLong())
            retryJob = null
            connect()
        }
    }

    private fun shortReason(s: String): String {
        val l = s.lowercase()
        if ("unable to resolve host" in l || "network is unreachable" in l || "failed to connect" in l) return "no network"
        return if (s.length > 40) s.take(40) + "…" else s
    }

    /** After the app returns to the foreground or the network changed: make sure the socket is alive. */
    fun verifyConnection() {
        val socket = ws ?: return
        if (!helloDone) return
        pingCheckJob?.cancel()
        pingCheckJob = scope.launch {
            delay(10_000)
            if (socket === ws) {
                log("${sync.collection}: no pong; reconnecting")
                connectionLost("timeout", wasUpgradeFailure = false)
            }
        }
        socket.send("""{"type":"ping"}""")
    }

    // MARK: Outgoing

    private fun scheduleFlush() {
        val t = now()
        val start = debounceStart ?: t.also { debounceStart = it }
        val elapsed = t - start
        flushSoon(minOf(400L, maxOf(0L, 2_000L - elapsed)))
    }

    private fun flushSoon(delayMs: Long) {
        sendJob?.cancel()
        sendJob = scope.launch {
            if (delayMs > 0) delay(delayMs)
            sendJob = null
            flush()
        }
    }

    private fun flush() {
        debounceStart = null
        val docs = sync.outgoing().filter(::sendable)
        if (docs.isEmpty()) { updatePending(); return }
        val socket = ws
        if (status.value.state == SyncState.Connected && socket != null && helloDone) {
            for (d in docs) {
                val put = buildJsonObject {
                    put("type", "put")
                    put("note", d.doc)
                }
                if (socket.send(put.toString())) {
                    sync.markSent(d)
                } else {
                    // closed or the send queue is full: the reconnect resends it
                    break
                }
            }
            watchAcks()
        } else if (status.value.state == SyncState.Polling) {
            // Fetch first so a REST put never overwrites a change we haven't seen yet.
            val p = lastPoll
            if (p != null && now() - p < 2_000) docs.forEach(::restPut) else poll()
        }
        updatePending()
    }

    /** Documents over the server's limits would be refused on every reconnect: keep them local instead. */
    private fun sendable(d: Outgoing): Boolean {
        val bytes = d.bodyBytes
        val encoded = { d.doc.toString().toByteArray().size + 32 }
        val fits = bytes <= SyncLimits.MAX_BODY_BYTES &&
            (bytes * 2 < SyncLimits.MAX_MESSAGE_BYTES - 64 * 1024 || encoded() < SyncLimits.MAX_MESSAGE_BYTES - 16 * 1024)
        if (!fits) {
            sync.markUnsendable(d)
            val mb = "%.1f".format(bytes / 1_048_576.0)
            _status.update { it.copy(lastError = "“${d.label}” is too large to sync ($mb MB, max 1 MB); it stays on this phone") }
            return false
        }
        val metaBytes = d.doc["meta"]?.toString()?.toByteArray()?.size ?: 0
        if (metaBytes > SyncLimits.MAX_META_BYTES) {
            sync.markUnsendable(d)
            _status.update { it.copy(lastError = "“${d.label}” has too much metadata to sync; it stays on this phone") }
            return false
        }
        return true
    }

    private fun updatePending() {
        val p = sync.pendingCount
        val b = sync.blockedCount
        if (status.value.pending != p || status.value.blocked != b) _status.update { it.copy(pending = p, blocked = b) }
    }

    private fun markSynced() = _status.update { it.copy(lastSync = now()) }

    private fun setState(s: SyncState, reason: String? = null) = _status.update { it.copy(state = s, reason = reason) }

    // MARK: REST fallback

    private fun enterPollingFallback() {
        log("${sync.collection}: WebSocket keeps failing; falling back to REST polling")
        setState(SyncState.Polling)
        retryJob?.cancel()
        pollJob?.cancel()
        pollJob = scope.launch {
            while (true) {
                poll()
                delay(10_000)
            }
        }
        // try the WebSocket again now and then
        wsRetryJob?.cancel()
        wsRetryJob = scope.launch {
            while (true) {
                delay(300_000)
                if (status.value.state != SyncState.Polling) continue
                wsFailures = 2 // one more failure goes straight back to polling
                connect()
            }
        }
    }

    private val notes get() = sync.collection == "notes"

    private fun listUrl(since: Long): HttpUrl? = base?.newBuilder()?.apply {
        if (notes) addPathSegments("v1/notes") else addPathSegments("v1/c").addPathSegment(sync.collection)
        addQueryParameter("since", since.toString())
    }?.build()

    private fun putUrl(id: String): HttpUrl? = base?.newBuilder()?.apply {
        if (notes) addPathSegments("v1/notes") else addPathSegments("v1/c").addPathSegment(sync.collection)
        addPathSegment(id)
    }?.build()

    private fun authed(url: HttpUrl) = Request.Builder().url(url)
        .header("Authorization", "Bearer ${token.orEmpty()}")
        .header("User-Agent", userAgent)

    private fun poll() {
        scope.launch {
            if (status.value.state != SyncState.Polling) return@launch
            when (val r = fetchSince(sync.lastSeq)) {
                is Fetch.Ok -> {
                    if (sync.applySnapshot(r.docs, r.seq)) { poll(); return@launch } // resync from 0
                    lastPoll = now()
                    _status.update { it.copy(lastError = null, lastSync = now()) }
                    flushSoon(0)
                }
                Fetch.Unauthorized -> _status.update { it.copy(lastError = "401 Unauthorized") }
                is Fetch.Failed -> _status.update { it.copy(lastError = r.error) }
            }
        }
    }

    private sealed interface Fetch {
        data class Ok(val docs: List<JsonObject>, val seq: Long) : Fetch
        data object Unauthorized : Fetch
        data class Failed(val error: String) : Fetch
    }

    private suspend fun fetchSince(since: Long): Fetch {
        val url = listUrl(since) ?: return Fetch.Failed("bad server URL")
        return try {
            http.newCall(authed(url).build()).await().use { r ->
                if (r.code == 401) return Fetch.Unauthorized
                if (r.code != 200) return Fetch.Failed("HTTP ${r.code}")
                val obj = json.parseToJsonElement(r.body.string()) as? JsonObject ?: return Fetch.Failed("bad response")
                val docs = (obj[if (notes) "notes" else "docs"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
                Fetch.Ok(docs, obj.wireLong("seq") ?: 0)
            }
        } catch (e: IOException) {
            Fetch.Failed(e.message ?: "network error")
        }
    }

    private fun restPut(d: Outgoing) {
        scope.launch { restPutNow(d) }
    }

    /** One REST put, handled like a WebSocket ack. False when it didn't get an answer. */
    private suspend fun restPutNow(d: Outgoing): Boolean {
        val url = putUrl(d.id) ?: return false
        sync.markSent(d)
        val req = authed(url).put(d.doc.toString().toRequestBody(JSON_TYPE)).build()
        try {
            http.newCall(req).await().use { r ->
                val obj = runCatching { json.parseToJsonElement(r.body.string()) as? JsonObject }.getOrNull()
                if (r.code == 413 || r.code == 400 || r.code == 409) {
                    sync.putFailed(d.id, d.updatedAt)
                    _status.update { it.copy(lastError = obj?.wireString("error")) }
                    updatePending()
                    return true
                }
                if (r.code != 200 || obj == null) {
                    sync.reset()
                    _status.update { it.copy(lastError = obj?.wireString("error") ?: "HTTP ${r.code}") }
                    return false
                }
                val stored = obj[if (notes) "note" else "doc"] as? JsonObject
                val accepted = obj.wireBool("accepted") ?: false
                sync.ack(d.id, if (accepted) stored?.wireLong("seq") else null, accepted, d.updatedAt)
                if (!accepted && stored != null) sync.applyRemote(stored, ordered = false)
                markSynced()
                updatePending()
                return true
            }
        } catch (e: IOException) {
            sync.reset()
            _status.update { it.copy(lastError = e.message) }
            return false
        } catch (e: CancellationException) {
            sync.reset() // stopped mid-put (background work cancelled): it goes out again next time
            throw e
        }
    }

    /**
     * One REST round trip without a live connection (background work, a widget tap while
     * the app is closed): fetch what changed, apply it, then put everything pending.
     * Returns true when the server answered. Does nothing while the WebSocket is live.
     */
    suspend fun syncOnce(): Boolean {
        if (running && status.value.state == SyncState.Connected) return true
        val e = endpoint() ?: return false
        token = e.token?.trim()?.takeIf { it.isNotEmpty() } ?: return false
        base = baseUrl(e.server) ?: return false
        if (sync.needsCollections && health()?.wireBool("collections") != true) return false
        var fetched = fetchSince(sync.lastSeq)
        if (fetched is Fetch.Ok && sync.applySnapshot(fetched.docs, fetched.seq)) {
            // the server lost data (restored backup): everything it lacks is dirty again, fetch it all
            fetched = fetchSince(0)
            if (fetched is Fetch.Ok) sync.applySnapshot(fetched.docs, fetched.seq)
        }
        when (fetched) {
            is Fetch.Ok -> {}
            Fetch.Unauthorized -> { _status.update { it.copy(lastError = "401 Unauthorized") }; return false }
            is Fetch.Failed -> { _status.update { it.copy(lastError = fetched.error) }; return false }
        }
        sync.connectionOpened()
        for (d in sync.outgoing().filter(::sendable)) {
            if (!restPutNow(d)) return false
        }
        markSynced()
        updatePending()
        return true
    }

    companion object {
        private val JSON_TYPE = "application/json".toMediaType()

        /** `sync.example.com` → https://sync.example.com, trailing slashes dropped. */
        fun baseUrl(server: String): HttpUrl? {
            var s = server.trim().trimEnd('/')
            if (s.isEmpty()) return null
            if ("://" !in s) s = "https://$s"
            return s.toHttpUrlOrNull()
        }
    }
}

/** Suspends until the call completes (30 s at most); cancelling the coroutine cancels the call. */
internal suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    timeout().timeout(30, TimeUnit.SECONDS) // the client has no read timeout, for the WebSocket
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (!cont.isCancelled) cont.resumeWithException(e)
        }

        override fun onResponse(call: Call, response: Response) {
            cont.resume(response) { _, _, _ -> response.close() }
        }
    })
    cont.invokeOnCancellation { runCatching { cancel() } }
}
