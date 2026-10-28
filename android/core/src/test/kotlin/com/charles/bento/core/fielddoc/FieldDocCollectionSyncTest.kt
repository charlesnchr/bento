package com.charles.bento.core.fielddoc

import com.charles.bento.core.todo.newTask
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
        assertEquals(7, sync.lastSeq)
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

    @Test fun orderedDeliveryMovesTheCursorAndRestWinnersDoNot() {
        val repo = InMemoryFieldDocRepository()
        val sync = todoCollectionSync(repo)
        val a = FieldDoc.newTask("a", order = 1.0, now = 5)
        assertFalse(sync.applySnapshot(listOf(wireDoc(sync, a, 10)), 10))
        assertEquals(10, sync.lastSeq)
        val stored = a.copy().apply { setTitle("theirs", 50) }
        sync.applyRemote(wireDoc(sync, stored, 15), ordered = false)
        assertEquals("theirs", repo.doc(a.id)!!.title)
        assertEquals(10, sync.lastSeq)
        sync.applyRemote(wireDoc(sync, stored.copy().apply { setTitle("again", 60) }, 16))
        assertEquals(16, sync.lastSeq)
        assertTrue(sync.applySnapshot(emptyList(), 3)) // server restored from a backup
        assertEquals(0, sync.lastSeq)
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
