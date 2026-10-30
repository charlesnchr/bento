package com.charles.bento.core.fielddoc

import com.charles.bento.core.json.JSONValue
import com.charles.bento.core.todo.DueDate
import com.charles.bento.core.todo.due
import com.charles.bento.core.todo.newTask
import com.charles.bento.core.todo.priority
import com.charles.bento.core.todo.setCompleted
import com.charles.bento.core.todo.setDue
import com.charles.bento.core.todo.setLabels
import com.charles.bento.core.todo.setOrder
import com.charles.bento.core.todo.setPriority
import com.charles.bento.core.todo.setTitle
import com.charles.bento.core.todo.title
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The server's last-writer-wins rule (server/src/store.rs) in memory. */
class FakeServer(collection: String = "todos") {
    val docs = LinkedHashMap<String, FieldDoc>()
    var seq = 0L
    private val wire = FieldDocWire(collection)

    /** Returns the stored version and whether the put was accepted. */
    fun put(d: FieldDoc): Pair<FieldDoc, Boolean> {
        docs[d.id]?.let { s -> if (d.updatedAt < s.updatedAt) return s to false }
        var n = d.copy(dirty = false)
        seq++
        n.seq = seq
        docs[d.id]?.let { n.createdAt = it.createdAt }
        // what travels is the wire form
        n = wire.decode(JsonObject(wire.encode(n, d.device) + ("seq" to JsonPrimitive(seq))))!!
        docs[d.id] = n
        return n to true
    }
}

private fun task(id: String = "t1", title: String = "Task", at: Long = 1000): FieldDoc =
    FieldDoc.newTask(title, order = 1.0, now = at).also { it.id = id }

/** Port of Tests/TodoTests/SyncEngineTests.swift (the SQLite store and Mac settings suites stay on the Mac). */
class FieldDocSyncEngineTest {
    // TodoMerge
    @Test fun differentFieldsBothSurvive() {
        val base = task()
        val a = base.copy().apply { setTitle("Renamed", 2000) }
        val b = base.copy().apply { setDue(DueDate("2026-10-23"), 3000) }
        val m1 = a.merged(b)
        val m2 = b.merged(a)
        assertTrue(m1.title == "Renamed" && m1.due?.date == "2026-10-23")
        assertTrue(m1.fields == m2.fields && m1.clocks == m2.clocks)
    }

    @Test fun sameFieldNewerWinsAndTiesAreDeterministic() {
        val base = task()
        val a = base.copy().apply { setTitle("A", 2000) }
        val b = base.copy().apply { setTitle("B", 2500) }
        assertEquals("B", a.merged(b).title)
        assertEquals("B", b.merged(a).title)
        b.setTitle("C", 2000)
        assertEquals(a.merged(b).title, b.merged(a).title)
    }

    @Test fun wireRoundTripKeepsUnknownFields() {
        val wire = FieldDocWire("todos")
        val d = task()
        d.fields = d.fields + ("future" to JSONValue.Obj(mapOf("x" to JSONValue.Number(1.0))))
        d.extra = mapOf("v" to JSONValue.Number(2.0))
        d.meta = mapOf("k" to JSONValue.Str("v"))
        val back = wire.decode(wire.encode(d, "mac"))!!
        assertTrue(back.fields == d.fields && back.clocks == d.clocks && back.extra == d.extra && back.meta == d.meta)
        assertNull(wire.decode(obj("id" to "x", "updated_at" to 1, "body" to "# a note", "collection" to "notes")))
        // an old server sends no collection: not ours
        assertNull(wire.decode(obj("id" to "x", "updated_at" to 1, "deleted" to true)))
    }

    // TodoSyncEngine
    @Test fun insertsAndOverwritesWhenClean() {
        val repo = InMemoryFieldDocRepository()
        val e = FieldDocSyncEngine(repo)
        val r = task().apply { seq = 1 }
        assertEquals(FieldDocSyncEngine.RemoteResult.INSERTED, e.applyRemote(r))
        val r2 = r.copy().apply { setTitle("New", 2000); seq = 2 }
        assertEquals(FieldDocSyncEngine.RemoteResult.OVERWRITTEN, e.applyRemote(r2))
        assertTrue(repo.doc("t1")?.title == "New" && repo.doc("t1")?.dirty == false)
        assertEquals(FieldDocSyncEngine.RemoteResult.UNCHANGED, e.applyRemote(r2))
    }

    @Test fun dirtyLocalMergesAndOutranksServer() {
        val repo = InMemoryFieldDocRepository()
        val e = FieldDocSyncEngine(repo)
        val base = task().apply { seq = 1 }
        e.applyRemote(base)
        val local = repo.doc("t1")!!.apply { setTitle("Local title", 5000); dirty = true }
        repo.save(local, remote = false)
        val r = base.copy().apply { setPriority(1, 6000); seq = 2 }
        assertEquals(FieldDocSyncEngine.RemoteResult.MERGED, e.applyRemote(r))
        val m = repo.doc("t1")!!
        assertTrue(m.title == "Local title" && m.priority == 1 && m.dirty)
        assertTrue(m.updatedAt > r.updatedAt)
    }

    @Test fun staleServerVersionIsHealed() {
        val repo = InMemoryFieldDocRepository()
        val e = FieldDocSyncEngine(repo)
        val newer = task().apply { setTitle("Newest", 9000); seq = 5 }
        e.applyRemote(newer)
        val stale = task().apply { updatedAt = 9500; seq = 6 } // older title, newer doc stamp
        assertEquals(FieldDocSyncEngine.RemoteResult.KEPT_LOCAL, e.applyRemote(stale))
        val d = repo.doc("t1")!!
        assertTrue(d.title == "Newest" && d.dirty && d.updatedAt > 9500)
    }

    @Test fun tombstonesWinOverOlderEditsAndLoseToNewer() {
        val repo = InMemoryFieldDocRepository()
        val e = FieldDocSyncEngine(repo)
        val base = task().apply { seq = 1 }
        e.applyRemote(base)
        repo.save(repo.doc("t1")!!.apply { setTitle("edit", 2000); dirty = true }, remote = false)
        val tomb = FieldDoc(id = "t1", type = "", createdAt = 1000, updatedAt = 3000, deleted = true, seq = 2)
        e.applyRemote(tomb)
        repo.doc("t1")!!.let { assertTrue(it.deleted && !it.dirty && it.type == "task") }

        val repo2 = InMemoryFieldDocRepository()
        val e2 = FieldDocSyncEngine(repo2)
        e2.applyRemote(base)
        repo2.save(repo2.doc("t1")!!.apply { setTitle("later edit", 4000); dirty = true }, remote = false)
        e2.applyRemote(tomb)
        val d = repo2.doc("t1")!!
        assertTrue(!d.deleted && d.dirty && d.updatedAt > 3000)
    }

    @Test fun ackClearsDirtyOnlyForCurrentVersion() {
        val repo = InMemoryFieldDocRepository()
        val e = FieldDocSyncEngine(repo)
        val d = task().apply { dirty = true }
        repo.save(d, remote = false)
        e.markSent(d)
        d.setTitle("again", 2000)
        repo.save(d, remote = false)
        e.ack("t1", 1, accepted = true)
        assertTrue(repo.doc("t1")!!.dirty)
        assertEquals(listOf("t1"), e.docsToSend().map { it.id })
        e.markSent(repo.doc("t1")!!)
        e.ack("t1", 2, accepted = true)
        assertTrue(!repo.doc("t1")!!.dirty && !e.hasInflight)
    }

    @Test fun adoptingWhileAPutIsInFlightStaysDirty() {
        val repo = InMemoryFieldDocRepository()
        val e = FieldDocSyncEngine(repo)
        val d = task().apply { dirty = true }
        repo.save(d, remote = false)
        e.markSent(d)
        val r = d.copy().apply { setTitle("theirs", 5000); seq = 3; dirty = false }
        e.applyRemote(r)
        val s = repo.doc("t1")!!
        assertTrue(s.title == "theirs" && s.dirty && s.updatedAt > r.updatedAt)
    }

    @Test fun documentsTheServerLacksAreSentAgain() {
        val repo = InMemoryFieldDocRepository()
        val e = FieldDocSyncEngine(repo)
        val c = FieldDoc(id = "c", type = "", createdAt = 1000, updatedAt = 2000, deleted = true, seq = 12)
        e.applySnapshot(listOf(task("a").apply { seq = 10 }, task("b").apply { seq = 11 }, c), setOf("a", "b", "c"))
        // restored from a backup: a is gone; b is there but its body can't be read here;
        // the tombstone c was purged and stays gone
        e.applySnapshot(emptyList(), setOf("b"))
        assertTrue(repo.doc("a")!!.dirty && repo.doc("a")!!.seq == null)
        assertFalse(repo.doc("b")!!.dirty || repo.doc("c")!!.dirty)
        assertEquals(listOf("a"), e.docsToSend().map { it.id })
    }

    @Test fun newerLocalDeletionOutlivesAnOlderRemoteOne() {
        val repo = InMemoryFieldDocRepository()
        val e = FieldDocSyncEngine(repo)
        val base = task().apply { seq = 1 }
        e.applyRemote(base)
        repo.save(repo.doc("t1")!!.apply { markDeleted(3000); dirty = true }, remote = false)
        val tomb = FieldDoc(id = "t1", type = "", createdAt = 1000, updatedAt = 2000, deleted = true, seq = 2)
        e.applyRemote(tomb)
        val d = repo.doc("t1")!!
        assertTrue(d.deleted && d.dirty && d.updatedAt == 3000L)
        // an edit stamped between the two deletions doesn't resurrect it
        e.applyRemote(base.copy().apply { setTitle("between", 2500); seq = 3 })
        assertTrue(repo.doc("t1")!!.deleted)
    }

    @Test fun deletingAtTheLargestTimestampDoesNotTrap() {
        val d = task()
        d.updatedAt = Long.MAX_VALUE
        d.markDeleted()
        assertTrue(d.deleted && d.updatedAt == Long.MAX_VALUE)
        assertEquals(Long.MAX_VALUE, FieldDoc.nextClock(Long.MAX_VALUE))
    }

    @Test fun refusedPutsWaitForAnEditOrANewConnection() {
        val repo = InMemoryFieldDocRepository()
        val e = FieldDocSyncEngine(repo)
        val d = task().apply { dirty = true }
        repo.save(d, remote = false)
        e.markSent(d)
        e.putFailed("t1")
        assertEquals(emptyList(), e.docsToSend())
        assertEquals(1, e.blockedCount)
        e.clearFailed()
        assertEquals(listOf("t1"), e.docsToSend().map { it.id })
        e.markUnsendable(d)
        assertEquals(emptyList(), e.docsToSend())
        repo.save(repo.doc("t1")!!.apply { setTitle("edited", 3000) }, remote = false)
        assertEquals(listOf("t1"), e.docsToSend().map { it.id })
        assertEquals(0, e.blockedCount)
    }

    /**
     * Two devices edit random fields of the same tasks while syncing through a fake
     * last-writer-wins server, with puts delivered late: they must end up identical.
     */
    @Test fun devicesConverge() {
        for (seed in 0 until 40) converge(seed)
    }

    private class Rng(seed: Long) {
        private var state = seed
        fun next(): Long {
            state += -0x61c8864680b583ebL
            var z = state
            z = (z xor (z ushr 30)) * -0x40a7b892e31b1a47L
            z = (z xor (z ushr 27)) * -0x6b2fb644ecceee15L
            return z xor (z ushr 31)
        }
        fun int(n: Int) = java.lang.Long.remainderUnsigned(next(), n.toLong()).toInt()
        fun bool() = next() and 1L == 0L
    }

    private fun converge(seed: Int) {
        val rng = Rng(seed + 1L)
        val server = FakeServer()
        val devices = List(2) { InMemoryFieldDocRepository() }
        val engines = devices.map { FieldDocSyncEngine(it) }
        engines.forEachIndexed { i, e -> e.device = "d$i" }
        var clock = 1000L
        val ids = listOf("a", "b", "c")
        val queued = ArrayList<Pair<Int, FieldDoc>>()

        fun deliver(q: Pair<Int, FieldDoc>) {
            val (dev, doc) = q
            val (stored, accepted) = server.put(doc)
            engines[dev].ack(doc.id, if (accepted) stored.seq else null, accepted, version = doc.updatedAt)
            if (!accepted) engines[dev].applyRemote(stored)
            if (accepted) engines.forEachIndexed { j, e -> if (j != dev) e.applyRemote(stored) }
        }

        repeat(60) {
            clock += rng.int(4)
            val dev = rng.int(2)
            val repo = devices[dev]
            val id = ids[rng.int(3)]
            val d = repo.doc(id) ?: FieldDoc.newTask("", order = 0.0, now = 1).also { it.id = id }
            val op = rng.int(6)
            clock = maxOf(clock, d.updatedAt + 1) // a device's own clock never repeats a stamp
            if (d.deleted && op != 4) { d.deleted = false; d.updatedAt = clock } // an edit after a delete resurrects
            when (op) {
                0 -> d.setTitle("t${rng.int(5)}", clock)
                1 -> d.setPriority(1 + rng.int(4), clock)
                2 -> d.setCompleted(if (rng.bool()) clock else null, clock)
                3 -> d.setLabels(if (rng.bool()) listOf("x") else emptyList(), clock)
                4 -> d.markDeleted(clock)
                else -> d.setOrder(rng.int(9).toDouble(), clock)
            }
            d.dirty = true
            repo.save(d, remote = false)
            for (s in engines[dev].docsToSend()) { engines[dev].markSent(s); queued += dev to s }
            // deliver some queued puts, possibly out of device order
            while (queued.isNotEmpty() && rng.bool()) deliver(queued.removeAt(0))
        }
        // quiesce
        for (round in 0 until 20) {
            while (queued.isNotEmpty()) deliver(queued.removeAt(0))
            engines.forEachIndexed { i, e -> for (s in e.docsToSend()) { e.markSent(s); queued += i to s } }
            if (queued.isEmpty()) break
        }
        assertTrue(queued.isEmpty(), "seed $seed")
        for (id in ids) {
            val a = devices[0].doc(id)
            val b = devices[1].doc(id)
            val s = server.docs[id]
            assertEquals(a?.deleted, b?.deleted, "seed $seed $id")
            if (a != null && b != null && !a.deleted) {
                assertEquals(a.fields, b.fields, "seed $seed $id")
                assertEquals(a.fields, s?.fields, "seed $seed $id")
            }
            assertFalse(a?.dirty == true || b?.dirty == true, "seed $seed $id")
        }
    }

    companion object {
        fun obj(vararg pairs: Pair<String, Any>): JsonObject = JsonObject(pairs.associate { (k, v) ->
            k to when (v) {
                is String -> JsonPrimitive(v)
                is Number -> JsonPrimitive(v)
                is Boolean -> JsonPrimitive(v)
                is JsonObject -> v
                else -> error("unsupported")
            }
        })
    }
}
