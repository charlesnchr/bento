package com.charles.bento.core.notes

import com.charles.bento.core.json.JSONValue
import com.charles.bento.core.json.wireLong
import com.charles.bento.core.sync.SyncLimits
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

// Tests/NotesTests/SyncTests.swift: SyncEngineTests, SyncSafetyTests, the pure parts of
// StoreTests and ExportTests, and LiveMergeTests (harness in LiveMergeHarness.kt).

private typealias RR = SyncEngine.RemoteResult

class SyncEngineTest {
    @Test fun insertsUnknownNotes() {
        val repo = InMemoryNoteRepository()
        val e = SyncEngine(repo)
        assertEquals(RR.Inserted, e.applyRemote(remote("a", "hello", updated = 10, seq = 1)))
        assertEquals("hello", repo.notes["a"]?.body)
        assertEquals(false, repo.notes["a"]?.dirty)
        assertEquals(1, repo.lastSeq)
    }

    @Test fun overwritesCleanNotes() {
        val repo = InMemoryNoteRepository()
        repo.save(local("a", "old", updated = 10, dirty = false, seq = 1))
        val e = SyncEngine(repo)
        assertEquals(RR.Overwritten, e.applyRemote(remote("a", "new", updated = 5, seq = 2))) // clean: always overwrite
        assertEquals("new", repo.notes["a"]?.body)
    }

    @Test fun conflictRuleForDirtyNotes() {
        val repo = InMemoryNoteRepository()
        repo.save(local("a", "mine", updated = 100, dirty = true))
        val e = SyncEngine(repo)
        // older remote: keep local and resend
        assertEquals(RR.KeptLocal, e.applyRemote(remote("a", "theirs-old", updated = 50, seq = 3)))
        assertEquals("mine", repo.notes["a"]?.body)
        assertEquals(true, repo.notes["a"]?.dirty)
        assertEquals(listOf("a"), e.notesToSend().map { it.id })
        // equal timestamps: local wins too (server accepts ties)
        assertEquals(RR.KeptLocal, e.applyRemote(remote("a", "theirs-same", updated = 100, seq = 4)))
        // newer remote: adopt (LWW)
        assertEquals(RR.Adopted, e.applyRemote(remote("a", "theirs-new", updated = 150, seq = 5)))
        assertEquals("theirs-new", repo.notes["a"]?.body)
        assertEquals(false, repo.notes["a"]?.dirty)
        assertEquals(5, repo.lastSeq)
    }

    @Test fun ackClearsDirtyOnlyForTheSentVersion() {
        val repo = InMemoryNoteRepository()
        repo.save(local("a", "v1", updated = 10, dirty = true))
        val e = SyncEngine(repo)
        val out = e.notesToSend()
        assertEquals(1, out.size)
        e.markSent(out[0])
        assertTrue(e.notesToSend().isEmpty()) // in flight
        // edited again before the ack arrives
        repo.save(repo.notes.getValue("a").copy(body = "v2", updatedAt = 20))
        assertEquals(1, e.notesToSend().size)
        e.ack("a", 1, accepted = true)
        assertEquals(true, repo.notes["a"]?.dirty) // v2 not acknowledged yet
        assertEquals(1, repo.notes["a"]?.seq)
        e.markSent(e.notesToSend()[0])
        e.ack("a", 2, accepted = true)
        assertEquals(false, repo.notes["a"]?.dirty)
        assertEquals(2, repo.lastSeq) // contiguous acks advance last_seq
    }

    @Test fun rejectedPutAdoptsTheStoredWinner() {
        val repo = InMemoryNoteRepository()
        repo.save(local("a", "mine", updated = 10, dirty = true))
        val e = SyncEngine(repo)
        e.markSent(e.notesToSend()[0])
        e.ack("a", 7, accepted = false) // seq of the stored note: must not be taken as ours
        assertEquals(true, repo.notes["a"]?.dirty)
        assertEquals(0, repo.lastSeq)
        assertEquals(RR.Adopted, e.applyRemote(remote("a", "winner", updated = 20, seq = 7)))
        assertEquals("winner", repo.notes["a"]?.body)
        assertTrue(e.notesToSend().isEmpty())
    }

    @Test fun ackDoesNotSkipUnseenSeqs() {
        val repo = InMemoryNoteRepository()
        repo.lastSeq = 5
        repo.save(local("a", "x", updated = 10, dirty = true))
        val e = SyncEngine(repo)
        e.markSent(e.notesToSend()[0])
        e.ack("a", 9, accepted = true) // 6...8 not seen yet
        assertEquals(5, repo.lastSeq)
    }

    @Test fun snapshotThenResendDirty() {
        val repo = InMemoryNoteRepository()
        repo.save(local("mine", "offline edit", updated = 50, dirty = true))
        val e = SyncEngine(repo)
        val restored = e.applySnapshot(listOf(remote("b", "from server", updated = 10, seq = 3), remote("c", "", updated = 11, seq = 4, deleted = true)), 4)
        assertFalse(restored)
        assertEquals(4, repo.lastSeq)
        assertEquals("from server", repo.notes["b"]?.body)
        assertEquals(true, repo.notes["c"]?.deleted)
        assertEquals(listOf("mine"), e.notesToSend().map { it.id })
    }

    @Test fun serverRestoreTriggersFullResync() {
        val repo = InMemoryNoteRepository()
        repo.lastSeq = 40
        repo.save(local("old", "kept", updated = 10, dirty = false, seq = 5))
        repo.save(local("lost", "server lost this", updated = 30, dirty = false, seq = 35))
        val e = SyncEngine(repo)
        assertTrue(e.applySnapshot(emptyList(), 20))
        assertEquals(0, repo.lastSeq)
        assertEquals(true, repo.notes["lost"]?.dirty)
        assertEquals(false, repo.notes["old"]?.dirty)
    }

    @Test fun putErrorsStopResendingUntilEdited() {
        val repo = InMemoryNoteRepository()
        repo.save(local("big", "x", updated = 10, dirty = true))
        val e = SyncEngine(repo)
        e.markSent(e.notesToSend()[0])
        e.putFailed("big")
        assertTrue(e.notesToSend().isEmpty())
        repo.save(repo.notes.getValue("big").copy(updatedAt = 11))
        assertEquals(1, e.notesToSend().size)
    }

    @Test fun reconnectResendsInflight() {
        val repo = InMemoryNoteRepository()
        repo.save(local("a", "x", updated = 10, dirty = true))
        val e = SyncEngine(repo)
        e.markSent(e.notesToSend()[0])
        assertTrue(e.notesToSend().isEmpty())
        e.reset()
        assertEquals(1, e.notesToSend().size)
    }

    @Test fun remoteChangeCallback() {
        val repo = InMemoryNoteRepository()
        val e = SyncEngine(repo)
        val seen = mutableListOf<String>()
        val flushed = mutableListOf<String>()
        e.onRemoteChange = { n, _ -> seen.add(n.id) }
        e.beforeApply = { flushed.add(it) }
        e.applyRemote(remote("a", "x", updated = 1, seq = 1))
        e.applyRemote(remote("a", "x", updated = 1, seq = 1)) // unchanged: no callback
        assertEquals(listOf("a"), seen)
        assertEquals(listOf("a", "a"), flushed)
    }

    @Test fun wireRoundTrip() {
        val n = Note(id = "id-1", body = "# T", createdAt = 5, updatedAt = 9).withPinned(true).withPinOrder(2.0)
        val obj = NoteWire.encode(n, "Mac")
        assertNull(obj["seq"])
        assertEquals("Mac", (obj["device"] as JsonPrimitive).content)
        val text = Json.encodeToString(JsonElement.serializer(), withSeq(obj, 12))
        val back = NoteWire.decode(Json.parseToJsonElement(text))!!
        assertEquals("id-1", back.id)
        assertEquals("# T", back.body)
        assertTrue(back.createdAt == 5L && back.updatedAt == 9L)
        assertEquals(12, back.seq)
        assertTrue(back.pinned)
        assertEquals(2.0, back.pinOrder)
        val tomb = NoteWire.decode(buildJsonObject { put("id", "x"); put("updated_at", 3); put("deleted", true); put("body", "ignored") })!!
        assertTrue(tomb.deleted && tomb.body.isEmpty() && tomb.createdAt == 3L)
        assertNull(NoteWire.decode(buildJsonObject { put("body", "no id") }))
    }
}

/** Data-safety cases: nothing a user typed may disappear because of sync timing. */
class SyncSafetyTest {
    private fun engine(repo: InMemoryNoteRepository) = SyncEngine(repo).also { it.device = "me" }

    /** A note synced at seq 10 with body `base`, then edited locally. */
    private fun edited(repo: InMemoryNoteRepository, base: String, body: String, updated: Long = 200) {
        repo.save(local("a", body, updated = updated, dirty = true, seq = 10).copy(baseHash = NoteText.hash(base)))
        repo.lastSeq = 10
    }

    private fun theirs(body: String, updated: Long, seq: Long = 11, device: String = "other", meta: Map<String, JSONValue> = emptyMap()) =
        remote("a", body, updated = updated, seq = seq).copy(device = device, meta = meta)

    private fun copies(repo: InMemoryNoteRepository) = repo.notes.values.filter { it.meta["conflictOf"] != null }

    @Test fun ackForAnOlderVersionKeepsTheNewerOneQueued() {
        // Typing while a put is in flight, then the connection drops after the first ack.
        val repo = InMemoryNoteRepository()
        repo.save(local("a", "v1", updated = 10, dirty = true))
        val e = engine(repo)
        e.markSent(e.notesToSend()[0])
        repo.save(repo.notes.getValue("a").copy(body = "v2", updatedAt = 20))
        e.markSent(e.notesToSend()[0]) // v2 in flight too
        e.ack("a", 1, accepted = true) // ack for v1
        assertEquals(true, repo.notes["a"]?.dirty)
        assertEquals(NoteText.hash("v1"), repo.notes["a"]?.baseHash)
        e.reset() // socket died before v2's ack
        assertEquals(listOf("v2"), e.notesToSend().map { it.body })
        e.markSent(e.notesToSend()[0])
        e.ack("a", 2, accepted = true)
        assertEquals(false, repo.notes["a"]?.dirty)
        assertEquals(NoteText.hash("v2"), repo.notes["a"]?.baseHash)
    }

    @Test fun restAcksMatchTheirVersionEvenOutOfOrder() {
        val repo = InMemoryNoteRepository()
        repo.save(local("a", "v1", updated = 10, dirty = true))
        val e = engine(repo)
        e.markSent(repo.notes.getValue("a"))
        val n = repo.notes.getValue("a").copy(body = "v2", updatedAt = 20)
        repo.save(n)
        e.markSent(n)
        e.ack("a", 2, accepted = true, version = 20) // v2's response first
        e.ack("a", 1, accepted = true, version = 10)
        assertEquals(false, repo.notes["a"]?.dirty)
        assertEquals(2, repo.notes["a"]?.seq)
        assertEquals(NoteText.hash("v2"), repo.notes["a"]?.baseHash)
    }

    @Test fun concurrentEditThatLosesBecomesAConflictedCopy() {
        val repo = InMemoryNoteRepository()
        edited(repo, "# Plan\nbase", "# Plan\nbase + mine", updated = 200)
        val e = engine(repo)
        val conflicted = mutableListOf<String>()
        e.onConflictCopy = { _, original -> conflicted.add(original) }
        assertEquals(RR.Adopted, e.applyRemote(theirs("# Plan\nbase + theirs", updated = 300)))
        assertEquals("# Plan\nbase + theirs", repo.notes["a"]?.body)
        val c = copies(repo)
        assertEquals(1, c.size)
        assertEquals("# Plan (conflicted copy, me)\nbase + mine", c.first().body)
        assertTrue(c.first().dirty) // synced to the other devices
        assertEquals(listOf("a"), conflicted)
        assertEquals(listOf(c.first().id), e.notesToSend().map { it.id })
    }

    @Test fun concurrentEditThatWinsKeepsTheirTextAsACopy() {
        val repo = InMemoryNoteRepository()
        edited(repo, "base", "base + mine", updated = 300)
        val e = engine(repo)
        assertEquals(RR.KeptLocal, e.applyRemote(theirs("base + theirs", updated = 200)))
        assertEquals("base + mine", repo.notes["a"]?.body)
        assertEquals(11, repo.notes["a"]?.seq)
        assertEquals(listOf("base + theirs (conflicted copy, other)"), copies(repo).map { it.body })
        // the same version arriving again (reconnect snapshot) doesn't copy twice
        assertEquals(RR.KeptLocal, e.applyRemote(theirs("base + theirs", updated = 200)))
        assertEquals(1, copies(repo).size)
    }

    @Test fun burstOfConflictsUpdatesOneCopy() {
        val repo = InMemoryNoteRepository()
        edited(repo, "base", "base + mine", updated = 300)
        val e = engine(repo)
        e.applyRemote(theirs("base + t1", updated = 200, seq = 11))
        repo.save(repo.notes.getValue("a").copy(body = "base + mine 2", updatedAt = 400))
        e.applyRemote(theirs("base + t1 t2", updated = 350, seq = 12))
        assertEquals(listOf("base + t1 t2 (conflicted copy, other)"), copies(repo).map { it.body })
    }

    @Test fun metaOnlyRemoteChangeMergesWithLocalText() {
        val repo = InMemoryNoteRepository()
        edited(repo, "base", "base + mine", updated = 200)
        val e = engine(repo)
        assertEquals(RR.Merged, e.applyRemote(theirs("base", updated = 300, meta = mapOf("pinned" to JSONValue.Bool(true)))))
        val n = repo.notes.getValue("a")
        assertEquals("base + mine", n.body)
        assertTrue(n.pinned)
        assertTrue(n.dirty)
        assertTrue(n.updatedAt > 300)
        assertTrue(copies(repo).isEmpty())
    }

    @Test fun localMetaOnlyChangeTakesTheirText() {
        val repo = InMemoryNoteRepository()
        edited(repo, "base", "base", updated = 300) // e.g. pinned here
        repo.save(repo.notes.getValue("a").withPinned(true))
        val e = engine(repo)
        assertEquals(RR.Merged, e.applyRemote(theirs("base + theirs", updated = 200)))
        val m = repo.notes.getValue("a")
        assertEquals("base + theirs", m.body)
        assertTrue(m.pinned)
        assertTrue(m.dirty && m.updatedAt > 300)
        assertTrue(copies(repo).isEmpty())
    }

    @Test fun ourOwnEchoIsNotAConflict() {
        // Our put was accepted but its ack was lost; the snapshot brings it back.
        val repo = InMemoryNoteRepository()
        edited(repo, "base", "base + typed more", updated = 300)
        val e = engine(repo)
        assertEquals(RR.KeptLocal, e.applyRemote(theirs("base + typed", updated = 250, device = "me")))
        assertTrue(copies(repo).isEmpty())
    }

    @Test fun remoteDeleteOfAnEditedNoteKeepsTheEdit() {
        val repo = InMemoryNoteRepository()
        edited(repo, "base", "base + mine", updated = 200)
        val e = engine(repo)
        assertEquals(RR.Adopted, e.applyRemote(theirs("", updated = 300).copy(deleted = true)))
        assertEquals(true, repo.notes["a"]?.deleted)
        assertEquals(listOf("base + mine (conflicted copy, me)"), copies(repo).map { it.body })
    }

    @Test fun remoteDeleteOfAnUnchangedNoteIsJustADelete() {
        val repo = InMemoryNoteRepository()
        edited(repo, "base", "base", updated = 200)
        val e = engine(repo)
        assertEquals(RR.Adopted, e.applyRemote(theirs("", updated = 300).copy(deleted = true)))
        assertTrue(copies(repo).isEmpty())
    }

    @Test fun restoredServerDoesNotProduceSpuriousCopies() {
        val repo = InMemoryNoteRepository()
        val n = local("a", "v3 (server lost this)", updated = 300, dirty = false, seq = 30)
        repo.save(n.copy(baseHash = NoteText.hash(n.body)))
        repo.lastSeq = 30
        val e = engine(repo)
        assertTrue(e.applySnapshot(emptyList(), 12)) // restored backup: seq went back
        assertEquals(true, repo.notes["a"]?.dirty)
        assertNull(repo.notes["a"]?.seq)
        // the full resync brings the older version from the backup
        assertFalse(e.applySnapshot(listOf(theirs("v1 (backup)", updated = 100, seq = 9)), 12))
        assertEquals("v3 (server lost this)", repo.notes["a"]?.body)
        assertEquals(listOf("a"), e.notesToSend().map { it.id })
        assertTrue(copies(repo).isEmpty())
    }

    @Test fun restoredServerWithANewerEditKeepsOursAsACopy() {
        val repo = InMemoryNoteRepository()
        val n = local("a", "mine (server lost this)", updated = 300, dirty = false, seq = 30)
        repo.save(n.copy(baseHash = NoteText.hash(n.body)))
        repo.lastSeq = 30
        val e = engine(repo)
        assertTrue(e.applySnapshot(emptyList(), 12))
        e.applySnapshot(listOf(theirs("edited after the restore", updated = 400, seq = 13)), 13)
        assertEquals("edited after the restore", repo.notes["a"]?.body)
        assertEquals(listOf("mine (server lost this) (conflicted copy, me)"), copies(repo).map { it.body })
    }

    @Test fun tooLargeNotesAreParkedUntilEdited() {
        val repo = InMemoryNoteRepository()
        repo.save(local("big", "x", updated = 10, dirty = true))
        val e = engine(repo)
        e.markUnsendable(repo.notes.getValue("big"))
        assertTrue(e.notesToSend().isEmpty())
        assertEquals(listOf("big"), e.blockedNotes.map { it.id })
        repo.save(repo.notes.getValue("big").copy(updatedAt = 11))
        assertTrue(e.blockedNotes.isEmpty())
        assertEquals(1, e.notesToSend().size)
    }

    @Test fun conflictCopyTitle() {
        assertEquals("\n```\ncode (conflicted copy, Air)\n```\n# Title  \nbody", NoteText.conflictCopyBody("\n```\ncode\n```\n# Title  \nbody", "Air"))
        assertEquals("# Title (conflicted copy, Air)\nbody", NoteText.conflictCopyBody("# Title  \nbody", "Air"))
        assertNull(NoteText.conflictCopyBody("  \n\n", "Air"))
        assertEquals("milk (conflicted copy)", NoteText.title(NoteText.conflictCopyBody("- [ ] milk", "")!!))
    }

    @Test fun stableHash() {
        assertEquals(0xcbf29ce484222325UL, NoteText.hash(""))
        assertEquals(0xaf63dc4c8601ec8cUL, NoteText.hash("a"))
        assertNotEquals(NoteText.hash("abc"), NoteText.hash("acb"))
    }

    @Test fun hostileTimestampsDontTrap() {
        // other clients' clocks/values are untrusted: never overflow
        assertEquals(Long.MAX_VALUE, Note.nextUpdate(Long.MAX_VALUE))
        assertTrue(Note.nextUpdate(5) >= Note.now())
        assertTrue(Note.nextUpdate(Note.now() + 10_000) > Note.now() + 9_000)
        assertTrue(Note.int64(Double.POSITIVE_INFINITY) == null && Note.int64(Double.NaN) == null)
        assertTrue(Note.int64(1e300) == Long.MAX_VALUE && Note.int64(-1e300) == Long.MIN_VALUE && Note.int64(12.7) == 12L)
        val n = Note(id = "x", body = "", createdAt = Long.MIN_VALUE, updatedAt = Long.MAX_VALUE).let { it.copy(meta = it.meta + ("trashedAt" to JSONValue.Number(1e300))) }
        assertEquals(Long.MAX_VALUE, n.trashedAt)
        assertTrue(RelativeDate.short(Long.MIN_VALUE).endsWith("y ago"))
        assertEquals("just now", RelativeDate.short(Long.MAX_VALUE))
        val repo = InMemoryNoteRepository()
        repo.save(local("a", "base + mine", updated = Long.MAX_VALUE, dirty = true, seq = 1))
        val e = SyncEngine(repo)
        e.device = "me"
        e.applyRemote(remote("a", "base", updated = 1, seq = 2).copy(device = "other", meta = mapOf("pinned" to JSONValue.Bool(true)))) // must not overflow updatedAt + 1
    }
}

/** StoreTests' list order and the codec the SQLite store keeps heads with. */
class NoteQueriesTest {
    @Test fun listOrder() {
        val p1 = Note(id = "p1", body = "p1", createdAt = 1).withPinned(true).withPinOrder(2.0)
        val p2 = Note(id = "p2", body = "p2", createdAt = 1).withPinned(true).withPinOrder(1.0)
        val old = Note(id = "old", body = "o", createdAt = 1, openedAt = 10)
        val recent = Note(id = "recent", body = "r", createdAt = 1, openedAt = 20)
        val tomb = Note(id = "tomb", body = "", createdAt = 1, deleted = true)
        val trashed = Note(id = "t", body = "gone", createdAt = 1).withTrashedAt(5)
        val all = listOf(p1, p2, old, recent, tomb, trashed)
        assertEquals(listOf("p2", "p1", "recent", "old"), NoteQueries.liveNotes(all).map { it.id })
        assertEquals(listOf("t"), NoteQueries.trashedNotes(all).map { it.id })
    }

    @Test fun headsAreStoredWithTheirBody() {
        val heads: SyncHeads = mapOf("install-1" to SyncHead(1_761_000_000_123, 0xfeedbeef00000001UL), "b/2" to SyncHead(2, 9UL))
        val s = SyncHeadsCodec.encode(heads, "synced text")
        assertEquals(heads, SyncHeadsCodec.decode(s, "synced text"))
        // an older build edited the note: the heads describe another text
        assertNull(SyncHeadsCodec.decode(s, "edited by an older build"))
        assertNull(SyncHeadsCodec.decode("{}", "synced text"))
    }
}

/** ExportTests' search and relative dates (MarkdownExport isn't ported). */
class SearchAndDatesTest {
    @Test fun fuzzy() {
        assertNotNull(FuzzyMatch.score("dt", "Daily Todos"))
        assertNull(FuzzyMatch.score("xyz", "Daily Todos"))
        assertTrue((FuzzyMatch.score("daily", "Daily Todos") ?: 0) > (FuzzyMatch.score("dt", "Daily Todos") ?: 0))
        assertNotNull(FuzzyMatch.noteScore("milk", "Shopping", "- [ ] milk"))
        assertEquals(0, FuzzyMatch.noteScore("", "x", ""))
    }

    @Test fun relativeDates() {
        val now = 10_000_000_000L
        assertEquals("just now", RelativeDate.short(now - 30_000, now))
        assertEquals("40m ago", RelativeDate.short(now - 40 * 60_000, now))
        assertEquals("3h ago", RelativeDate.short(now - 3 * 3_600_000, now))
        assertEquals("3w ago", RelativeDate.short(now - 21 * 86_400_000L, now))
    }
}

/**
 * Live editing on two devices: concurrent text edits merge like Google Docs instead of
 * one side's typing vanishing into a conflicted copy.
 */
class LiveMergeTest {
    private val base = "# Plan\nintro\n\nend\n"

    @Test fun typingOnBothMacsAtOnceKeepsBoth() {
        val a = Mac("A", base)
        val b = Mac("B", base)
        val server = Server(base)
        a.type { it.replace("intro\n", "intro\nA line\n") }
        b.type { it.replace("\nend", "\nB line\nend") }
        server.sync(listOf(a, b), rounds = 1)
        // each kept typing right after its own line before the merged text went out
        a.type { it.replace("A line", "A line more") }
        b.type { it.replace("B line", "B line too") }
        server.sync(listOf(a, b))
        assertEquals("# Plan\nintro\nA line more\n\nB line too\nend\n", a.note.body)
        assertEquals(a.note.body, b.note.body)
        assertTrue(a.copies.isEmpty() && b.copies.isEmpty())
        assertTrue(!a.note.dirty && !b.note.dirty)
        assertTrue(a.e.notesToSend().isEmpty() && b.e.notesToSend().isEmpty())
        assertTrue(a.changes.contains(RR.Merged) && b.changes.contains(RR.Merged))
    }

    /**
     * The fuzz's checks (seeds 0..<150 of each kind, with the deterministic clock the
     * Mac's runs used; NotesCrossCheckTest compares the same runs with the Mac's).
     */
    private fun fuzz(seed: Int, kind: Fuzz): List<String> {
        val problems = mutableListOf<String>()
        fun check(ok: Boolean, what: String) {
            if (!ok) problems.add("seed $seed $kind: $what")
        }
        val run = runFuzz(seed, kind)
        val macs = run.macs
        val net = run.net
        check(run.quiet, "never went quiet")
        val a = macs[0].note.body
        val server = NoteWire.decode(net.stored)!!
        check(macs.all { it.note.body == a }, "diverged")
        check(a == server.body, "server differs")
        check(macs.all { it.note.meta == server.meta && it.note.deleted == server.deleted }, "meta differs")
        check(macs.all { !it.note.dirty }, "dirty")
        check(!run.putWhileQuiet, "put while quiet")
        check(macs[0].note.body == a, "changed while quiet")
        val marks = a.filter { it in run.typed }
        check(marks.length == marks.toSet().size, "duplicated typing in $a")
        when (kind) {
            Fuzz.insertOnly, Fuzz.sameName -> {
                check(a.filter { it !in run.typed } == run.start, "base text changed: $a")
                check(marks.toSet() == run.typed, "lost typing")
                check(macs.all { it.copies.isEmpty() }, "conflicted copy")
            }
            Fuzz.threeMacs, Fuzz.metaAndRelaunch, Fuzz.sharedInstallID -> {
                // Three at once may not merge (no text holds exactly what all share), nor can a
                // device that just relaunched (its history is gone): whatever doesn't merge is in
                // a conflicted copy, never lost (unless the note was deleted).
                if (!run.deleted) {
                    check(a.filter { it !in run.typed } == run.start, "base text changed: $a")
                    val kept = macs.flatMap { m -> m.repo.notes.values.map { it.body } }.joinToString("").toSet()
                    check(kept.containsAll(run.typed), "lost typing")
                }
            }
            Fuzz.withDeletes -> {}
        }
        return problems
    }

    private fun fuzzAll(kind: Fuzz) {
        val problems = (0 until 150).flatMap { fuzz(it, kind) }
        assertTrue(problems.isEmpty(), problems.take(20).joinToString("\n"))
    }

    @Test fun concurrentTypingNeverLosesOrDuplicates() = fuzzAll(Fuzz.insertOnly)
    @Test fun concurrentTypingAndDeletingConverges() = fuzzAll(Fuzz.withDeletes)
    @Test fun threeMacsTypingAtOnceNeverLoseOrDuplicate() = fuzzAll(Fuzz.threeMacs)
    @Test fun macsWithTheSameNameStillMerge() = fuzzAll(Fuzz.sameName)
    @Test fun pinsTrashDeletesAndRelaunchesNeverLoseTyping() = fuzzAll(Fuzz.metaAndRelaunch)
    @Test fun macsSharingAnInstallIDNeverLoseTyping() = fuzzAll(Fuzz.sharedInstallID)

    private fun everything(vararg macs: Mac) = macs.flatMap { m -> m.repo.notes.values.map { it.body } }.joinToString("")

    @Test fun aDeferredVersionSurvivesACrash() {
        // B's put is stored; A's concurrent put never reaches the server; B's version
        // reaches A while A's put is in flight (so it waits) and A then crashes.
        val a = Mac("A", base)
        val b = Mac("B", base)
        val net = Network(listOf(a, b), base)
        a.typeAtCaret(" from A", elsewhere = null, backspace = false)
        net.send(0)
        b.typeAtCaret("B: ", elsewhere = 0, backspace = false)
        net.send(1)
        net.serve(lose = true) // A's
        net.serve() // B's, seq 2
        net.deliver(0)
        assertEquals(1, a.repo.lastSeq) // held below the version that waits
        net.relaunch(0) // hello since 1 fetches B's version again
        assertTrue(net.settle())
        assertTrue(everything(a, b).contains("B: "), "B's text is somewhere")
        assertTrue(everything(a, b).contains(" from A"), "A's text is somewhere")
        assertEquals(a.note.body, b.note.body)
    }

    @Test fun aFailedPutLetsTheWaitingVersionIn() {
        val a = Mac("A", base)
        val b = Mac("B", base)
        val net = Network(listOf(a, b), base)
        a.typeAtCaret(" from A", elsewhere = null, backspace = false)
        net.send(0)
        b.typeAtCaret("B: ", elsewhere = 0, backspace = false)
        net.send(1)
        net.serve(fail = true) // A's put: an error reply
        net.serve() // B's
        net.deliver(0) // the error: B's version may come in now
        assertFalse(a.note.body.contains("B: "))
        net.deliver(0) // B's version
        assertEquals("B: $base from A", a.note.body)
        assertTrue(net.settle())
        assertEquals(a.note.body, b.note.body)
    }

    @Test fun macsWithTheSameNameKeepBothEdits() {
        val a = Mac("MacBook Pro", base)
        val b = Mac("MacBook Pro", base)
        val net = Network(listOf(a, b), base)
        a.typeAtCaret(" mine", elsewhere = null, backspace = false)
        b.typeAtCaret("theirs ", elsewhere = 0, backspace = false)
        net.send(0)
        net.send(1)
        assertTrue(net.settle())
        assertEquals("theirs $base mine", a.note.body)
        assertEquals(a.note.body, b.note.body)
        assertTrue(a.copies.isEmpty() && b.copies.isEmpty())
    }

    @Test fun aRelaunchedMacStillKeepsItsSyncedText() {
        // A's edit is acked; A quits; B's version made without it overwrites it on the
        // server. A's heads were stored with the note, so A knows its text isn't in B's.
        val a = Mac("A", base)
        val b = Mac("B", base)
        val net = Network(listOf(a, b), base)
        a.typeAtCaret(" from A", elsewhere = null, backspace = false)
        b.typeAtCaret("B: ", elsewhere = 0, backspace = false)
        net.send(0); net.serve(); net.deliver(0) // A acked
        net.send(1)
        a.relaunch()
        net.serve() // B's overwrites A's on the server
        assertTrue(net.settle())
        assertTrue(everything(a, b).contains(" from A") && everything(a, b).contains("B: "))
        assertEquals(a.note.body, b.note.body)
    }

    @Test fun headsInAPutAreCapped() {
        val a = Mac("A", base)
        val n = a.note.copy(syncHeads = (0 until 40).associate { "install-$it" to SyncHead(it.toLong(), it.toULong()) }, dirty = true)
        a.repo.save(n)
        val h = a.e.sentHeads(a.note)!!
        assertEquals(SyncEngine.HEADS_SENT, h.size)
        assertNotNull(h[a.repo.installID]) // our own always
        assertTrue(h["install-39"] != null && h["install-0"] == null) // the newest others
        val meta = Json.encodeToString(JsonElement.serializer(), a.e.encode(a.note).getValue("meta"))
        assertTrue(meta.toByteArray().size < SyncLimits.MAX_META_BYTES)
    }

    @Test fun ourPinSurvivesWhenTheyChangedTheText() {
        // We edited the text and pinned; their newer version only has more text.
        val a = Mac("A", base)
        val b = Mac("B", base)
        a.typeAtCaret(" mine", elsewhere = null, backspace = false)
        a.mutate { it.withPinned(true) }
        b.typeAtCaret("theirs ", elsewhere = 0, backspace = false)
        b.repo.save(b.note.copy(updatedAt = a.note.updatedAt + 50)) // theirs is newer
        val pb = withSeq(b.put()!!, 2)
        a.e.applyRemote(NoteWire.decode(pb)!!)
        assertEquals("theirs $base mine", a.note.body)
        assertTrue(a.note.pinned)
        assertTrue(a.note.dirty)
    }

    @Test fun ourPinSurvivesAFastForward() {
        // Our text edit reached them, our pin didn't: their version is all of our text.
        val a = Mac("A", base)
        val b = Mac("B", base)
        val net = Network(listOf(a, b), base)
        a.typeAtCaret(" mine", elsewhere = null, backspace = false)
        net.send(0); net.serve(); net.deliver(0); net.deliver(1) // A acked, B has it
        a.mutate { it.withPinned(true) }
        b.typeAtCaret(" and theirs", elsewhere = 1000, backspace = false)
        net.send(1); net.serve(); net.deliver(1); net.deliver(0)
        assertEquals("$base mine and theirs", a.note.body)
        assertTrue(a.note.pinned)
        assertTrue(net.settle())
        assertTrue(b.note.pinned)
    }

    @Test fun overlappingEditsMakeOneConflictedCopyNotTwo() {
        // Both rewrite the same line offline; B's is newer and not sent yet when A's
        // arrives: B keeps its text and A's as a copy, and A then just takes B's.
        val start = "# Shared\nbase"
        val a = Mac("A", start)
        val b = Mac("B", start)
        val net = Network(listOf(a, b), start)
        a.type { "# Shared\nedited on A" }
        b.type { "# Shared\nedited on B" }
        net.send(0); net.serve()
        while (net.queues[1].isNotEmpty()) net.deliver(1) // A's version reaches B before B sends
        assertTrue(net.settle())
        assertTrue(a.note.body == "# Shared\nedited on B" && b.note.body == a.note.body)
        assertEquals(listOf("# Shared (conflicted copy, A)\nedited on A"), (a.copies + b.copies).map { it.body })
    }

    @Test fun ourNewerDeleteKeepsTheirTextAsACopy() {
        // We deleted the note (again unsent) after a synced delete; an older edit of
        // theirs arrives: the note stays deleted, their text is kept as a copy.
        val repo = InMemoryNoteRepository()
        val e = SyncEngine(repo)
        repo.save(Note(id = "a", body = "", createdAt = 1, updatedAt = 1000, deleted = true, dirty = true, seq = 7, baseHash = NoteText.hash("")))
        e.applyRemote(remote("a", "# Their text", updated = 500, seq = 9).copy(device = "B"))
        assertTrue(repo.notes.getValue("a").deleted && repo.notes.getValue("a").body.isEmpty())
        assertTrue(repo.notes.values.any { it.body == "# Their text (conflicted copy, B)" })
    }

    @Test fun aCopiedDatabaseOnASecondMacIsDetected() {
        // B runs from a copy of A's database: same install id, another computer name.
        val a = Mac("A", base)
        val b = Mac("B", base)
        b.repo.installID = a.repo.installID
        val net = Network(listOf(a, b), base)
        a.typeAtCaret(" from A", elsewhere = null, backspace = false)
        b.typeAtCaret("B: ", elsewhere = 0, backspace = false)
        net.send(0); net.send(1)
        assertTrue(net.settle())
        assertNotEquals(a.repo.installID, b.repo.installID) // one of them took a new id
        assertTrue(everything(a, b).contains(" from A") && everything(a, b).contains("B: "))
        assertEquals(a.note.body, b.note.body)
    }

    @Test fun anUnsendableNoteLetsTheWaitingVersionIn() {
        val a = Mac("A", base)
        val b = Mac("B", base)
        val net = Network(listOf(a, b), base)
        a.typeAtCaret(" from A", elsewhere = null, backspace = false)
        net.send(0)
        b.typeAtCaret("B: ", elsewhere = 0, backspace = false)
        net.send(1)
        net.serve(lose = true)
        net.serve()
        net.deliver(0) // waits for A's put
        net.reconnect(0) // that put may still land: keeps waiting
        assertEquals(1, a.repo.lastSeq)
        a.e.markUnsendable(a.note) // never resent: nothing else would resolve it
        assertEquals("B: $base from A", a.note.body)
        assertEquals(2, a.repo.lastSeq)
    }

    @Test fun noOrphanPinOrder() {
        // we reordered pins while they unpinned
        val m = SyncEngine.mergeMeta(
            base = mapOf("pinned" to JSONValue.Bool(true), "pinOrder" to JSONValue.Number(1.0)),
            local = mapOf("pinned" to JSONValue.Bool(true), "pinOrder" to JSONValue.Number(2.0)),
            remote = emptyMap(), remoteNewer = true,
        )
        assertTrue(m.isEmpty())
    }

    @Test fun anOlderClientsMetaChangeMergesKeyByKey() {
        // We edited the text and pinned; an older client (no heads) trashed the note.
        val a = Mac("A", base)
        a.typeAtCaret(" mine", elsewhere = null, backspace = false)
        a.mutate { it.withPinned(true) }
        a.repo.save(a.note.copy(baseHash = NoteText.hash(base)))
        val r = remote("a", base, updated = a.note.updatedAt + 50, seq = 2).copy(device = "Old Mac", meta = mapOf("trashedAt" to JSONValue.Number(5.0)))
        assertEquals(RR.Merged, a.e.applyRemote(r))
        assertEquals("$base mine", a.note.body)
        assertTrue(a.note.pinned && a.note.meta["trashedAt"] == JSONValue.Number(5.0))
    }

    @Test fun firstEditsAfterUpgradingMakeNoCopies() {
        // Both databases come from a build without heads: every note's first put has none.
        val a = Mac("A", base)
        val b = Mac("B", base)
        for (m in listOf(a, b)) {
            m.repo.save(m.note.copy(syncHeads = null))
            m.relaunch()
        }
        val net = Network(listOf(a, b), base)
        a.type { it.dropLast(1) } // deletes a character
        net.send(0)
        assertTrue(net.settle())
        assertEquals(base.dropLast(1), b.note.body)
        assertTrue(a.copies.isEmpty() && b.copies.isEmpty())
        // later edits merge with history
        b.typeAtCaret(" B", elsewhere = 1000, backspace = false)
        a.typeAtCaret("A ", elsewhere = 0, backspace = false)
        net.send(0); net.send(1)
        assertTrue(net.settle())
        assertTrue(a.note.body == b.note.body && a.copies.isEmpty() && b.copies.isEmpty())
    }

    @Test fun identicalConflictedCopiesFromTwoMacsBecomeOne() {
        // Each device kept the same losing text as a copy: one survives, on both.
        val a = Mac("A", base)
        val b = Mac("B", base)
        val copy = Note(id = "copy-b", body = "# Plan (conflicted copy, A)\nlost", createdAt = 1, updatedAt = 10, meta = mapOf("conflictOf" to JSONValue.Str("a")))
        val mine = copy.copy(id = "copy-a")
        a.repo.save(mine)
        a.e.applyRemote(copy.copy(seq = 5, device = "B"))
        assertEquals(listOf("copy-a"), a.repo.notes.values.filter { it.isLive && it.meta["conflictOf"] != null }.map { it.id })
        assertTrue(a.repo.notes["copy-b"]?.deleted == true && a.repo.notes["copy-b"]?.dirty == true)
        // B, the other way round, deletes the same one
        b.repo.save(copy)
        b.e.applyRemote(mine.copy(seq = 6, device = "A"))
        assertTrue(b.repo.notes["copy-b"]?.deleted == true && b.repo.notes["copy-a"]?.isLive == true)
    }

    @Test fun crissCrossMergesDontDuplicate() {
        // A sends "abc" and keeps typing "def"; B's concurrent "xyz" was made without "abc".
        // Only one side may merge the pair.
        val a = Mac("A", base)
        val b = Mac("B", base)
        val net = Network(listOf(a, b), base)
        a.typeAtCaret("abc", elsewhere = null, backspace = false)
        net.send(0)
        a.typeAtCaret("def", elsewhere = null, backspace = false)
        b.typeAtCaret("xyz", elsewhere = 0, backspace = false)
        net.send(1)
        net.serve(); net.serve()
        repeat(4) { net.deliver(0); net.deliver(1) }
        assertTrue(net.settle())
        assertEquals("xyz${base}abcdef", a.note.body)
        assertEquals(a.note.body, b.note.body)
        assertTrue(a.copies.isEmpty() && b.copies.isEmpty())
    }

    @Test fun anAckedEditIsntLostToAConcurrentOne() {
        // A's edit is acked (clean) when B's version, made without it, overwrites it on the
        // server: A merges instead of dropping its own text.
        val a = Mac("A", base)
        val b = Mac("B", base)
        a.type { it + "from A\n" }
        a.put()!!
        a.e.ack("a", 2, accepted = true)
        assertFalse(a.note.dirty)
        b.type { "intro first\n$it" }
        val pb = withSeq(b.put()!!, 3)
        assertEquals(RR.Merged, a.e.applyRemote(NoteWire.decode(pb)!!))
        assertEquals("intro first\n${base}from A\n", a.note.body)
        assertTrue(a.note.dirty) // goes back to the server, which only has B's text
        assertTrue(a.note.updatedAt > pb.wireLong("updated_at")!!)
    }

    @Test fun versionMadeFromOurTextIsAFastForward() {
        val a = Mac("A", base)
        val b = Mac("B", base)
        a.type { it + "mine\n" }
        val pa = withSeq(a.put()!!, 2)
        b.receive(pa)
        b.type { it.replace("mine", "mine, edited by B") }
        val pb = withSeq(b.put()!!, 3)
        // A's ack hasn't arrived yet (still dirty): no conflicted copy, just B's text
        assertTrue(a.note.dirty)
        assertEquals(RR.Adopted, a.e.applyRemote(NoteWire.decode(pb)!!))
        assertEquals(base + "mine, edited by B\n", a.note.body)
        assertTrue(a.copies.isEmpty())
    }

    @Test fun ourOwnVersionComingBackIsNotMergedAgain() {
        val a = Mac("A", base)
        a.type { it + "typed" }
        val echo = withSeq(a.put()!!, 2)
        a.type { "$it more" } // typing continued right after it
        assertEquals(RR.KeptLocal, a.e.applyRemote(NoteWire.decode(echo)!!))
        assertEquals(base + "typed more", a.note.body)
        assertTrue(a.copies.isEmpty())
    }

    @Test fun overlappingEditsStillKeepAConflictedCopy() {
        val a = Mac("A", "the quick brown fox")
        val b = Mac("B", "the quick brown fox")
        a.type { "the fox" }
        b.type { "the quick red fox" }
        // B's edit is the later one (the base marker is tied to updated_at, so re-encode)
        val bn = b.note.copy(updatedAt = a.note.updatedAt + 10)
        val pb = withSeq(b.e.encode(bn), 2)
        assertEquals(RR.Adopted, a.e.applyRemote(NoteWire.decode(pb)!!))
        assertEquals("the quick red fox", a.note.body)
        assertEquals(listOf("the fox (conflicted copy, A)"), a.copies.map { it.body })
    }

    @Test fun unknownBaseFallsBackToLastWriterWins() {
        // e.g. the base was edited before a relaunch: nothing to merge against
        val a = Mac("A", base)
        a.repo.save(a.note.copy(body = base + "mine", dirty = true, updatedAt = 200)) // no willEdit: base text unknown
        val r = remote("a", base + "theirs", updated = 300, seq = 2).copy(
            device = "B",
            remoteHeads = mapOf("B" to SyncHead(300, NoteText.hash(base + "theirs"))), // shares nothing known with ours
        )
        assertEquals(RR.Adopted, a.e.applyRemote(r))
        assertEquals(1, a.copies.size)
    }

    @Test fun wireCarriesTheHeadsTiedToTheVersion() {
        val n = Note(id = "a", body = "text", createdAt = 1, updatedAt = 500).withPinned(true)
        val heads: SyncHeads = mapOf("A" to SyncHead(500, NoteText.hash("text")), "B Mac" to SyncHead(420, 7UL))
        val obj = NoteWire.encode(n, "A", "install-A", heads)
        val back = NoteWire.decode(obj)!!
        assertEquals(heads, back.remoteHeads)
        assertEquals("install-A", back.remoteOrigin)
        assertEquals("install-A", NoteWire.decode(NoteWire.encode(n, "A", "install-A"))!!.remoteOrigin) // heads unknown
        assertNull(back.meta["base"]) // never stored as meta
        assertTrue(back.pinned)
        // an older client edits the note and keeps the key: the stale heads are ignored
        val stale = JsonObject(obj + ("updated_at" to JsonPrimitive(600)))
        assertNull(NoteWire.decode(stale)!!.remoteHeads)
        // tombstones and notes whose history is unknown carry none
        assertNull(NoteWire.encode(n.copy(deleted = true), "A", "install-A", heads).getValue("meta").jsonObject["base"])
        assertNull(SyncEngine(InMemoryNoteRepository()).sentHeads(local("b", "x", updated = 5, dirty = true)))
    }

    @Test fun localPinOrTrashSurvivesTheirTextEdit() {
        // Trashed here (meta only, not yet synced) while the other device edited the text
        // from the same version: their text, our trash, and it goes back to the server.
        val a = Mac("A", base)
        val b = Mac("B", base)
        val n = a.note
        a.repo.save(n.copy(meta = n.meta + ("trashedAt" to JSONValue.Number(1234.0)), updatedAt = Note.nextUpdate(n.updatedAt), dirty = true))
        b.typeAtCaret(" edited", elsewhere = null, backspace = false)
        val pb = withSeq(b.put()!!, 2)
        assertEquals(RR.Merged, a.e.applyRemote(NoteWire.decode(pb)!!))
        assertEquals("$base edited", a.note.body)
        assertEquals(JSONValue.Number(1234.0), a.note.meta["trashedAt"])
        assertTrue(a.note.dirty)
    }
}
