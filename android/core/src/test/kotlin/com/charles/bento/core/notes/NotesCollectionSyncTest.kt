package com.charles.bento.core.notes

import com.charles.bento.core.json.wireLong
import com.charles.bento.core.json.wireString
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class NotesCollectionSyncTest {
    @Test fun putsAckAndRemoteVersionsGoThroughTheEngine() {
        val repo = InMemoryNoteRepository()
        val sync = NotesCollectionSync(repo, "Pixel")
        assertEquals("notes", sync.collection)
        assertFalse(sync.needsCollections)
        assertEquals("Pixel", sync.engine.device)
        repo.save(local("a", "# Shopping\n- milk", updated = 10, dirty = true))
        repo.save(local("t", "", updated = 11, dirty = true).copy(deleted = true))
        val out = sync.outgoing()
        assertEquals(listOf("a", "t"), out.map { it.id })
        val a = out[0]
        assertEquals("Shopping", a.label)
        assertEquals("# Shopping\n- milk".toByteArray().size, a.bodyBytes)
        assertEquals(0, out[1].bodyBytes)
        assertEquals(10, a.updatedAt)
        assertEquals("Pixel", a.doc.wireString("device"))
        assertEquals(10, a.doc.wireLong("updated_at"))
        assertNotNull(a.doc.getValue("meta").jsonObject["base"]) // says which install sent it
        sync.markSent(a)
        assertTrue(sync.hasInflight)
        assertEquals(2, sync.pendingCount)
        sync.ack("a", 1, accepted = true)
        assertFalse(repo.notes.getValue("a").dirty)
        assertEquals(1, sync.lastSeq)
        assertEquals(listOf("t"), sync.outgoing().map { it.id })

        // another device's version
        val theirs = NoteWire.encode(Note(id = "b", body = "From the Mac", createdAt = 5, updatedAt = 20), "Mac", "install-mac")
        sync.applyRemote(withSeq(theirs, 2))
        assertEquals("From the Mac", repo.notes["b"]?.body)
        assertEquals(2, sync.lastSeq)

        // a snapshot whose seq went backwards: full resync
        assertTrue(sync.applySnapshot(emptyList(), 0))
    }

    @Test fun unsendableNotesAreBlockedUntilEdited() {
        val repo = InMemoryNoteRepository()
        val sync = NotesCollectionSync(repo, "Pixel")
        repo.save(local("big", "x", updated = 10, dirty = true))
        val out = sync.outgoing().single()
        sync.markUnsendable(out)
        assertEquals(1, sync.blockedCount)
        assertTrue(sync.outgoing().isEmpty())
        repo.save(repo.notes.getValue("big").copy(updatedAt = 11))
        assertEquals(0, sync.blockedCount)
        assertEquals(1, sync.outgoing().size)
    }

    @Test fun aPutFailureAndAReconnect() {
        val repo = InMemoryNoteRepository()
        val sync = NotesCollectionSync(repo, "Pixel")
        repo.save(local("a", "x", updated = 10, dirty = true))
        sync.markSent(sync.outgoing().single())
        sync.reset()
        assertFalse(sync.hasInflight)
        sync.markSent(sync.outgoing().single())
        sync.putFailed("a")
        assertTrue(sync.outgoing().isEmpty()) // refused in this version
        assertEquals(1, sync.blockedCount)
    }
}
