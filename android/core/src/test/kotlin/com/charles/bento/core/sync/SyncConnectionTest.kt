package com.charles.bento.core.sync

import com.charles.bento.core.json.wireBool
import com.charles.bento.core.json.wireLong
import com.charles.bento.core.json.wireString
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import java.io.File
import java.net.ServerSocket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The transport against the real bento-sync server (server/target/release/bento-sync,
 * built with `cargo build --release`; skipped when it isn't there), with a minimal
 * last-writer-wins engine standing in for the notes/todo engines.
 */
class SyncConnectionTest {
    private val token = "test-token-0123456789"
    private lateinit var server: TestServer
    private val dispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val http = OkHttpClient.Builder().readTimeout(0, TimeUnit.MILLISECONDS).build()
    private val connections = mutableListOf<SyncConnection>()

    @BeforeEach
    fun setUp() {
        val binary = File("../../server/target/release/bento-sync").absoluteFile
        assumeTrue(binary.canExecute(), "bento-sync not built (cd server && cargo build --release)")
        server = TestServer(binary, token).also { it.start() }
    }

    @AfterEach
    fun tearDown() {
        runBlocking { withContext(dispatcher) { connections.forEach { it.stop() } } }
        scope.cancel()
        dispatcher.close()
        if (::server.isInitialized) server.stop()
    }

    private fun connection(sync: CollectionSync, tok: String = token, client: OkHttpClient = http) =
        SyncConnection(sync, client, scope, { SyncEndpoint("http://127.0.0.1:${server.port}", tok) }).also { connections += it }

    private suspend fun <T> onEngine(block: () -> T): T = withContext(dispatcher) { block() }

    private suspend fun waitFor(what: String, timeoutMs: Long = 10_000, check: () -> Boolean) {
        withTimeout(timeoutMs) {
            while (!onEngine(check)) delay(50)
        }
    }

    @Test
    fun putReachesTheOtherConnection() = runBlocking {
        val a = TestSync("notes", "A")
        val b = TestSync("notes", "B")
        val ca = connection(a)
        val cb = connection(b)
        onEngine { ca.start(); cb.start() }
        waitFor("both connected") { ca.status.value.isLive && cb.status.value.isLive }
        onEngine { a.edit("n1", "hello from A"); ca.localChange() }
        waitFor("B received it") { b.body("n1") == "hello from A" }
        waitFor("A acked") { !a.isDirty("n1") && a.lastSeq > 0 }
        assertEquals(0, ca.status.value.pending)
    }

    @Test
    fun collectionsAreSeparate() = runBlocking {
        val notes = TestSync("notes", "A")
        val todos = TestSync("todos", "B")
        val todos2 = TestSync("todos", "C")
        val cn = connection(notes)
        val ct = connection(todos)
        val ct2 = connection(todos2)
        onEngine { cn.start(); ct.start(); ct2.start() }
        waitFor("connected") { cn.status.value.isLive && ct.status.value.isLive && ct2.status.value.isLive }
        onEngine { notes.edit("x-note", "a note"); cn.localChange(); todos.edit("x-task", "a task"); ct.localChange() }
        waitFor("todo arrived") { todos2.body("x-task") == "a task" }
        waitFor("note acked") { !notes.isDirty("x-note") }
        delay(300)
        assertEquals(null, onEngine { todos2.body("x-note") })
        assertEquals(null, onEngine { notes.body("x-task") })
    }

    @Test
    fun stalePutGetsTheWinnerBack() = runBlocking {
        val a = TestSync("notes", "A")
        val b = TestSync("notes", "B")
        val ca = connection(a)
        val cb = connection(b)
        onEngine { ca.start(); cb.start() }
        waitFor("connected") { ca.status.value.isLive && cb.status.value.isLive }
        onEngine { a.edit("n2", "newer", updatedAt = 2_000_000_000_000); ca.localChange() }
        waitFor("B has newer") { b.body("n2") == "newer" }
        // B edits with an older clock: the server refuses it and sends the stored winner
        onEngine { b.edit("n2", "older", updatedAt = 1_000_000_000_000); cb.localChange() }
        waitFor("B adopted the winner") { b.body("n2") == "newer" && !b.isDirty("n2") }
    }

    @Test
    fun wrongTokenIsReported() = runBlocking {
        val a = TestSync("notes", "A")
        val ca = connection(a, tok = "wrong-token-000000000")
        onEngine { ca.start() }
        waitFor("unauthorized") { ca.status.value.state == SyncState.Unauthorized }
    }

    @Test
    fun reconnectsAfterServerRestartAndSendsPending() = runBlocking {
        val a = TestSync("notes", "A")
        val ca = connection(a)
        onEngine { ca.start() }
        waitFor("connected") { ca.status.value.isLive }
        server.stop()
        waitFor("offline") { ca.status.value.state == SyncState.Offline }
        onEngine { a.edit("n3", "written offline"); ca.localChange() }
        assertEquals(1, onEngine { ca.status.value.pending })
        server.start()
        waitFor("reconnected and sent", timeoutMs = 20_000) { ca.status.value.isLive && !a.isDirty("n3") }
        val b = TestSync("notes", "B")
        val cb = connection(b)
        onEngine { cb.start() }
        waitFor("B got it in its snapshot") { b.body("n3") == "written offline" }
    }

    @Test
    fun syncOnceWithoutAConnection() = runBlocking {
        val a = TestSync("todos", "A")
        val b = TestSync("todos", "B")
        val ca = connection(a)
        val cb = connection(b)
        onEngine { a.edit("t1", "via REST") }
        assertTrue(onEngine { runBlocking { ca.syncOnce() } })
        assertFalse(onEngine { a.isDirty("t1") })
        assertTrue(onEngine { runBlocking { cb.syncOnce() } })
        assertEquals("via REST", onEngine { b.body("t1") })
    }

    @Test
    fun fallsBackToPollingWhenOnlyTheUpgradeFails() = runBlocking {
        // a proxy that refuses WebSocket upgrades but lets REST through
        val blocking = http.newBuilder().addInterceptor { chain ->
            val req = chain.request()
            if (req.url.encodedPath.endsWith("/v1/sync")) {
                Response.Builder().request(req).protocol(Protocol.HTTP_1_1).code(403).message("Forbidden")
                    .body("blocked".toResponseBody()).build()
            } else {
                chain.proceed(req)
            }
        }.build()
        val a = TestSync("notes", "A")
        val b = TestSync("notes", "B")
        val ca = connection(a, client = blocking)
        val cb = connection(b)
        onEngine { ca.start(); cb.start() }
        waitFor("polling", timeoutMs = 30_000) { ca.status.value.state == SyncState.Polling }
        onEngine { a.edit("n4", "over REST polling"); ca.localChange() }
        waitFor("B received the polled put", timeoutMs = 30_000) { b.body("n4") == "over REST polling" }
        onEngine { b.edit("n5", "from B"); cb.localChange() }
        waitFor("A polled B's change", timeoutMs = 30_000) { a.body("n5") == "from B" }
    }
}

/** Last-writer-wins stand-in for an engine: enough to exercise the transport. */
private class TestSync(override val collection: String, override var device: String) : CollectionSync {
    private val docs = mutableMapOf<String, JsonObject>()
    private val dirty = mutableSetOf<String>()
    private val inflight = mutableMapOf<String, ArrayDeque<Long>>()
    private val failed = mutableMapOf<String, Long>()
    override var lastSeq = 0L
        private set

    fun body(id: String): String? = docs[id]?.wireString("body")
    fun isDirty(id: String) = id in dirty

    fun edit(id: String, body: String, updatedAt: Long = System.currentTimeMillis()) {
        docs[id] = buildJsonObject {
            put("id", id); put("body", body); put("created_at", updatedAt); put("updated_at", updatedAt)
            put("deleted", false); put("device", device); put("meta", JsonObject(emptyMap())); put("collection", collection)
        }
        dirty += id
    }

    override fun applySnapshot(docs: List<JsonObject>, seq: Long): Boolean {
        if (seq < lastSeq) { dirty += this.docs.keys; lastSeq = 0; return true }
        docs.sortedBy { it.wireLong("seq") ?: 0 }.forEach { applyRemote(it) }
        if (seq > lastSeq) lastSeq = seq
        return false
    }

    override fun applyRemote(doc: JsonObject, ordered: Boolean) {
        val id = doc.wireString("id") ?: return
        val seq = doc.wireLong("seq")
        if (ordered && seq != null && seq > lastSeq) lastSeq = seq
        val local = docs[id]
        val newer = local == null || (doc.wireLong("updated_at") ?: 0) >= (local.wireLong("updated_at") ?: 0)
        if (id !in dirty || newer) { docs[id] = doc; dirty -= id }
    }

    override fun ack(id: String, seq: Long?, accepted: Boolean, version: Long?, ordered: Boolean) {
        val q = inflight[id] ?: return
        val sent = if (version != null && q.remove(version)) version else q.removeFirst()
        if (q.isEmpty()) inflight.remove(id)
        if (!accepted) return
        if (seq != null && (seq == lastSeq + 1 || (ordered && seq > lastSeq))) lastSeq = seq
        if (docs[id]?.wireLong("updated_at") == sent) dirty -= id
    }

    override fun putFailed(id: String, version: Long?) {
        inflight.remove(id)?.lastOrNull()?.let { failed[id] = it }
    }

    override fun outgoing(): List<Outgoing> = dirty.mapNotNull { id ->
        val d = docs[id] ?: return@mapNotNull null
        val v = d.wireLong("updated_at") ?: 0
        if (inflight[id]?.lastOrNull() == v || failed[id] == v) null
        else Outgoing(id, d, v, d.wireString("body").orEmpty().toByteArray().size, id)
    }

    override fun markSent(out: Outgoing) { inflight.getOrPut(out.id) { ArrayDeque() }.addLast(out.updatedAt) }
    override fun markUnsendable(out: Outgoing) { failed[out.id] = out.updatedAt }
    override fun connectionOpened() = failed.clear()
    override fun reset() = inflight.clear()
    override val hasInflight get() = inflight.isNotEmpty()
    override val pendingCount get() = dirty.size
    override val blockedCount get() = failed.count { (id, v) -> id in dirty && docs[id]?.wireLong("updated_at") == v }

    @Suppress("unused")
    fun accepted(o: JsonObject) = o.wireBool("accepted")
}

/** The real server on a free local port with a throwaway database. */
class TestServer(private val binary: File, private val token: String) {
    val port: Int = ServerSocket(0).use { it.localPort }
    private val dir = kotlin.io.path.createTempDirectory("bento-sync-test").toFile()
    private var process: Process? = null

    fun start() {
        process = ProcessBuilder(binary.path)
            .redirectErrorStream(true)
            .redirectOutput(File(dir, "server.log"))
            .apply {
                environment()["BENTO_SYNC_TOKEN"] = token
                environment()["BENTO_SYNC_DB"] = File(dir, "test.db").path
                environment()["BENTO_SYNC_ADDR"] = "127.0.0.1:$port"
            }.start()
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            if (runCatching { java.net.Socket("127.0.0.1", port).close() }.isSuccess) return
            Thread.sleep(50)
        }
        error("bento-sync didn't start: ${File(dir, "server.log").readText()}")
    }

    fun stop() {
        process?.destroy()
        process?.waitFor(5, TimeUnit.SECONDS)
        process = null
    }
}
