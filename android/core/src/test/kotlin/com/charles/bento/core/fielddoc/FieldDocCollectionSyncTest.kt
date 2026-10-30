package com.charles.bento.core.fielddoc

import com.charles.bento.core.todo.newTask
import com.charles.bento.core.todo.notes
import com.charles.bento.core.todo.project
import com.charles.bento.core.todo.setNotes
import com.charles.bento.core.todo.setProject
import com.charles.bento.core.todo.setTitle
import com.charles.bento.core.todo.title
import com.charles.bento.core.todo.todoCollectionSync
import com.charles.bento.core.voicesync.newEntry
import com.charles.bento.core.voicesync.voiceCollectionSync
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The CollectionSync adapter the transport drives, as the Mac's TodoSyncClient drives its engine. */
class FieldDocCollectionSyncTest {
    private fun wireDoc(sync: FieldDocCollectionSync, d: FieldDoc, seq: Long): JsonObject =
        JsonObject(sync.wire.encode(d, "mac") + ("seq" to JsonPrimitive(seq)))

    @Test fun outgoingCarriesTheEncodedDocument() {
        val repo = InMemoryFieldDocRepository()
        val sync = todoCollectionSync(repo)
        sync.device = "pixel"
        val t = FieldDoc.newTask("Ünïcode title that is rather long, longer than forty characters", order = 1.0, now = 5).apply { dirty = true }
        repo.save(t, remote = false)
        val out = sync.outgoing().single()
        assertEquals(t.id, out.id)
        assertEquals(5, out.updatedAt)
        assertEquals(t.body.toByteArray(Charsets.UTF_8).size, out.bodyBytes)
        assertEquals("Ünïcode title that is rather long, longe", out.label)
        assertEquals("todos", out.doc["collection"]!!.jsonPrimitive.content)
        assertEquals("pixel", out.doc["device"]!!.jsonPrimitive.content)
        assertEquals(t.body, out.doc["body"]!!.jsonPrimitive.content)
        sync.markSent(out)
        assertTrue(sync.hasInflight)
        assertEquals(emptyList(), sync.outgoing())
        sync.ack(t.id, 7, accepted = true, ordered = true)
        assertEquals(7, repo.doc(t.id)!!.seq)
        assertEquals(0, sync.pendingCount)
    }

    @Test fun refusedAndOversizedPutsRetryOnTheNextConnection() {
        val repo = InMemoryFieldDocRepository()
        val sync = todoCollectionSync(repo)
        repo.save(FieldDoc.newTask("", order = 1.0, now = 5).apply { dirty = true }, remote = false)
        val out = sync.outgoing().single()
        assertEquals("Untitled", out.label)
        sync.markUnsendable(out)
        assertEquals(emptyList(), sync.outgoing())
        assertEquals(1, sync.blockedCount)
        sync.connectionOpened()
        assertEquals(1, sync.outgoing().size)
        sync.markSent(out)
        sync.putFailed(out.id)
        assertEquals(emptyList(), sync.outgoing())
        sync.reset()
        sync.connectionOpened()
        assertEquals(1, sync.outgoing().size)
    }

    @Test fun everyPassFetchesTheFullSet() {
        val repo = InMemoryFieldDocRepository()
        val sync = todoCollectionSync(repo)
        val a = FieldDoc.newTask("a", order = 1.0, now = 5)
        assertFalse(sync.applySnapshot(listOf(wireDoc(sync, a, 10)), 10))
        val stored = a.copy().apply { setTitle("theirs", 50) }
        sync.applyRemote(wireDoc(sync, stored, 15), ordered = false)
        assertEquals("theirs", repo.doc(a.id)!!.title)
        assertEquals(0, sync.lastSeq) // hello and polls always ask for everything
        assertFalse(sync.applySnapshot(emptyList(), 3)) // server restored from a backup: a goes out again
        assertEquals(listOf(a.id), sync.outgoing().map { it.id })
    }

    /**
     * The Mac showed a subset of a project's tasks: tasks written with raw newlines in their
     * JSON body couldn't be read there, and the cursor moved past them for good. One pass
     * brings every task, however many and whatever their seqs.
     */
    @Test fun onePassBringsEveryTaskTheServerHas() {
        val repo = InMemoryFieldDocRepository()
        val sync = todoCollectionSync(repo)
        sync.applySnapshot(listOf(wireDoc(sync, FieldDoc.newTask("seen", order = 1.0, now = 5).apply { id = "seen" }, 5000)), 5000)
        val list = (0 until 1200).map { i ->
            val d = FieldDoc.newTask("Task $i", order = i.toDouble(), now = 1000L + i).apply { id = "t$i"; setProject("P1", 1000L + i) }
            if (i % 3 == 0) d.setNotes("line one\nline two", 1000L + i)
            val o = wireDoc(sync, d, 2000L - i) // newest first, seqs well below any cursor the Mac had
            // what syncctl wrote: a description whose newline isn't escaped
            if (i % 3 == 0) JsonObject(o + ("body" to JsonPrimitive(d.body.replace("\\n", "\n")))) else o
        }
        assertTrue(list[0]["body"]!!.jsonPrimitive.content.contains('\n'))
        sync.applySnapshot(list + wireDoc(sync, repo.doc("seen")!!, 5000), 5000)
        assertEquals(1200, repo.allDocs.count { it.project == "P1" })
        assertEquals(1201, repo.allDocs.size)
        assertEquals("line one\nline two", repo.doc("t0")!!.notes)
        assertEquals(0, sync.pendingCount)
    }

    @Test fun collectionsDontAcceptEachOthersDocuments() {
        val todos = todoCollectionSync(InMemoryFieldDocRepository())
        val voice = voiceCollectionSync(InMemoryFieldDocRepository())
        val task = FieldDoc.newTask("t", order = 1.0, now = 5)
        val entry = FieldDoc.newEntry("Kubernetes", now = 5)
        // a todo document sent to the voice engine (and vice versa) is ignored
        voice.applyRemote(wireDoc(todos, task, 1))
        todos.applyRemote(wireDoc(voice, entry, 2))
        assertEquals(emptyList(), voice.engine.repo.allDocs)
        assertEquals(emptyList(), todos.engine.repo.allDocs)
        assertEquals(0, voice.lastSeq)
        voice.applyRemote(wireDoc(voice, entry, 3))
        assertEquals(1, voice.engine.repo.allDocs.size)
        assertTrue(voice.needsCollections && todos.needsCollections)
    }
}
