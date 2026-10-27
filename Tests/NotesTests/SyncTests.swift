import AppKit
import BentoCore
import Testing
@testable import Notes

/// In-memory repository for engine tests.
final class MemoryRepo: NoteRepository {
    var notes: [String: Note] = [:]
    var lastSeq: Int64 = 0
    var installID = UUID().uuidString
    var retiredInstallIDs: Set<String> = []
    func renewInstallID() {
        retiredInstallIDs.insert(installID)
        installID = UUID().uuidString
    }
    func note(_ id: String) -> Note? { notes[id] }
    func save(_ note: Note) { notes[note.id] = note }
    func allNotes(includeTombstones: Bool) -> [Note] { Array(notes.values).filter { includeTombstones || !$0.deleted } }
}

func remote(_ id: String, _ body: String, updated: Int64, seq: Int64, deleted: Bool = false) -> Note {
    var n = Note(id: id, body: body, createdAt: 1, updatedAt: updated)
    n.seq = seq
    n.deleted = deleted
    if deleted { n.body = "" }
    return n
}

func local(_ id: String, _ body: String, updated: Int64, dirty: Bool, seq: Int64? = nil) -> Note {
    var n = Note(id: id, body: body, createdAt: 1, updatedAt: updated)
    n.dirty = dirty
    n.seq = seq
    return n
}

@Suite struct SyncEngineTests {
    @Test func insertsUnknownNotes() {
        let repo = MemoryRepo()
        let e = SyncEngine(repo: repo)
        #expect(e.applyRemote(remote("a", "hello", updated: 10, seq: 1)) == .inserted)
        #expect(repo.notes["a"]?.body == "hello")
        #expect(repo.notes["a"]?.dirty == false)
        #expect(repo.lastSeq == 1)
    }

    @Test func overwritesCleanNotes() {
        let repo = MemoryRepo()
        repo.save(local("a", "old", updated: 10, dirty: false, seq: 1))
        let e = SyncEngine(repo: repo)
        #expect(e.applyRemote(remote("a", "new", updated: 5, seq: 2)) == .overwritten) // clean: always overwrite
        #expect(repo.notes["a"]?.body == "new")
    }

    @Test func conflictRuleForDirtyNotes() {
        let repo = MemoryRepo()
        repo.save(local("a", "mine", updated: 100, dirty: true))
        let e = SyncEngine(repo: repo)
        // older remote: keep local and resend
        #expect(e.applyRemote(remote("a", "theirs-old", updated: 50, seq: 3)) == .keptLocal)
        #expect(repo.notes["a"]?.body == "mine")
        #expect(repo.notes["a"]?.dirty == true)
        #expect(e.notesToSend().map(\.id) == ["a"])
        // equal timestamps: local wins too (server accepts ties)
        #expect(e.applyRemote(remote("a", "theirs-same", updated: 100, seq: 4)) == .keptLocal)
        // newer remote: adopt (LWW)
        #expect(e.applyRemote(remote("a", "theirs-new", updated: 150, seq: 5)) == .adopted)
        #expect(repo.notes["a"]?.body == "theirs-new")
        #expect(repo.notes["a"]?.dirty == false)
        #expect(repo.lastSeq == 5)
    }

    @Test func ackClearsDirtyOnlyForTheSentVersion() {
        let repo = MemoryRepo()
        repo.save(local("a", "v1", updated: 10, dirty: true))
        let e = SyncEngine(repo: repo)
        let out = e.notesToSend()
        #expect(out.count == 1)
        e.markSent(out[0])
        #expect(e.notesToSend().isEmpty) // in flight
        // edited again before the ack arrives
        var n = repo.notes["a"]!
        n.body = "v2"; n.updatedAt = 20
        repo.save(n)
        #expect(e.notesToSend().count == 1)
        e.ack(id: "a", seq: 1, accepted: true)
        #expect(repo.notes["a"]?.dirty == true) // v2 not acknowledged yet
        #expect(repo.notes["a"]?.seq == 1)
        let again = e.notesToSend()
        e.markSent(again[0])
        e.ack(id: "a", seq: 2, accepted: true)
        #expect(repo.notes["a"]?.dirty == false)
        #expect(repo.lastSeq == 2) // contiguous acks advance last_seq
    }

    @Test func rejectedPutAdoptsTheStoredWinner() {
        let repo = MemoryRepo()
        repo.save(local("a", "mine", updated: 10, dirty: true))
        let e = SyncEngine(repo: repo)
        e.markSent(e.notesToSend()[0])
        e.ack(id: "a", seq: 7, accepted: false) // seq of the stored note: must not be taken as ours
        #expect(repo.notes["a"]?.dirty == true)
        #expect(repo.lastSeq == 0)
        #expect(e.applyRemote(remote("a", "winner", updated: 20, seq: 7)) == .adopted)
        #expect(repo.notes["a"]?.body == "winner")
        #expect(e.notesToSend().isEmpty)
    }

    @Test func ackDoesNotSkipUnseenSeqs() {
        let repo = MemoryRepo()
        repo.lastSeq = 5
        repo.save(local("a", "x", updated: 10, dirty: true))
        let e = SyncEngine(repo: repo)
        e.markSent(e.notesToSend()[0])
        e.ack(id: "a", seq: 9, accepted: true) // 6...8 not seen yet
        #expect(repo.lastSeq == 5)
    }

    @Test func snapshotThenResendDirty() {
        let repo = MemoryRepo()
        repo.save(local("mine", "offline edit", updated: 50, dirty: true))
        let e = SyncEngine(repo: repo)
        let restored = e.applySnapshot([remote("b", "from server", updated: 10, seq: 3), remote("c", "", updated: 11, seq: 4, deleted: true)], seq: 4)
        #expect(!restored)
        #expect(repo.lastSeq == 4)
        #expect(repo.notes["b"]?.body == "from server")
        #expect(repo.notes["c"]?.deleted == true)
        #expect(e.notesToSend().map(\.id) == ["mine"])
    }

    @Test func serverRestoreTriggersFullResync() {
        let repo = MemoryRepo()
        repo.lastSeq = 40
        repo.save(local("old", "kept", updated: 10, dirty: false, seq: 5))
        repo.save(local("lost", "server lost this", updated: 30, dirty: false, seq: 35))
        let e = SyncEngine(repo: repo)
        #expect(e.applySnapshot([], seq: 20))
        #expect(repo.lastSeq == 0)
        #expect(repo.notes["lost"]?.dirty == true)
        #expect(repo.notes["old"]?.dirty == false)
    }

    @Test func putErrorsStopResendingUntilEdited() {
        let repo = MemoryRepo()
        repo.save(local("big", "x", updated: 10, dirty: true))
        let e = SyncEngine(repo: repo)
        e.markSent(e.notesToSend()[0])
        e.putFailed(id: "big")
        #expect(e.notesToSend().isEmpty)
        var n = repo.notes["big"]!
        n.updatedAt = 11
        repo.save(n)
        #expect(e.notesToSend().count == 1)
    }

    @Test func reconnectResendsInflight() {
        let repo = MemoryRepo()
        repo.save(local("a", "x", updated: 10, dirty: true))
        let e = SyncEngine(repo: repo)
        e.markSent(e.notesToSend()[0])
        #expect(e.notesToSend().isEmpty)
        e.reset()
        #expect(e.notesToSend().count == 1)
    }

    @Test func remoteChangeCallback() {
        let repo = MemoryRepo()
        let e = SyncEngine(repo: repo)
        var seen: [String] = []
        var flushed: [String] = []
        e.onRemoteChange = { n, _ in seen.append(n.id) }
        e.beforeApply = { flushed.append($0) }
        e.applyRemote(remote("a", "x", updated: 1, seq: 1))
        e.applyRemote(remote("a", "x", updated: 1, seq: 1)) // unchanged: no callback
        #expect(seen == ["a"])
        #expect(flushed == ["a", "a"])
    }

    @Test func wireRoundTrip() {
        var n = Note(id: "id-1", body: "# T", createdAt: 5, updatedAt: 9)
        n.pinned = true
        n.pinOrder = 2
        let obj = NoteWire.encode(n, device: "Mac")
        #expect(obj["seq"] == nil)
        #expect(obj["device"] as? String == "Mac")
        var withSeq = obj
        withSeq["seq"] = 12
        let data = try! JSONSerialization.data(withJSONObject: withSeq)
        let back = NoteWire.decode(try! JSONSerialization.jsonObject(with: data))!
        #expect(back.id == "id-1")
        #expect(back.body == "# T")
        #expect(back.createdAt == 5 && back.updatedAt == 9)
        #expect(back.seq == 12)
        #expect(back.pinned)
        #expect(back.pinOrder == 2)
        let tomb = NoteWire.decode(["id": "x", "updated_at": 3, "deleted": true, "body": "ignored"])!
        #expect(tomb.deleted && tomb.body.isEmpty && tomb.createdAt == 3)
        #expect(NoteWire.decode(["body": "no id"]) == nil)
    }
}

/// Data-safety cases: nothing a user typed may disappear because of sync timing.
@Suite struct SyncSafetyTests {
    func engine(_ repo: MemoryRepo) -> SyncEngine {
        let e = SyncEngine(repo: repo)
        e.device = "me"
        return e
    }

    /// A note synced at seq 10 with body `base`, then edited locally.
    func edited(_ repo: MemoryRepo, base: String, now body: String, updated: Int64 = 200) {
        var n = local("a", body, updated: updated, dirty: true, seq: 10)
        n.baseHash = NoteText.hash(base)
        repo.save(n)
        repo.lastSeq = 10
    }

    func theirs(_ body: String, updated: Int64, seq: Int64 = 11, device: String = "other", meta: [String: JSONValue] = [:]) -> Note {
        var r = remote("a", body, updated: updated, seq: seq)
        r.device = device
        r.meta = meta
        return r
    }

    func copies(_ repo: MemoryRepo) -> [Note] { repo.notes.values.filter { $0.meta["conflictOf"] != nil } }

    @Test func ackForAnOlderVersionKeepsTheNewerOneQueued() {
        // Typing while a put is in flight, then the connection drops after the first ack.
        let repo = MemoryRepo()
        repo.save(local("a", "v1", updated: 10, dirty: true))
        let e = engine(repo)
        e.markSent(e.notesToSend()[0])
        var n = repo.notes["a"]!
        n.body = "v2"; n.updatedAt = 20
        repo.save(n)
        e.markSent(e.notesToSend()[0])          // v2 in flight too
        e.ack(id: "a", seq: 1, accepted: true)  // ack for v1
        #expect(repo.notes["a"]?.dirty == true)
        #expect(repo.notes["a"]?.baseHash == NoteText.hash("v1"))
        e.reset()                                // socket died before v2's ack
        #expect(e.notesToSend().map(\.body) == ["v2"])
        e.markSent(e.notesToSend()[0])
        e.ack(id: "a", seq: 2, accepted: true)
        #expect(repo.notes["a"]?.dirty == false)
        #expect(repo.notes["a"]?.baseHash == NoteText.hash("v2"))
    }

    @Test func restAcksMatchTheirVersionEvenOutOfOrder() {
        let repo = MemoryRepo()
        repo.save(local("a", "v1", updated: 10, dirty: true))
        let e = engine(repo)
        e.markSent(repo.notes["a"]!)
        var n = repo.notes["a"]!
        n.body = "v2"; n.updatedAt = 20
        repo.save(n)
        e.markSent(n)
        e.ack(id: "a", seq: 2, accepted: true, version: 20) // v2's response first
        e.ack(id: "a", seq: 1, accepted: true, version: 10)
        #expect(repo.notes["a"]?.dirty == false)
        #expect(repo.notes["a"]?.seq == 2)
        #expect(repo.notes["a"]?.baseHash == NoteText.hash("v2"))
    }

    @Test func concurrentEditThatLosesBecomesAConflictedCopy() {
        let repo = MemoryRepo()
        edited(repo, base: "# Plan\nbase", now: "# Plan\nbase + mine", updated: 200)
        let e = engine(repo)
        var conflicted: [String] = []
        e.onConflictCopy = { _, original in conflicted.append(original) }
        #expect(e.applyRemote(theirs("# Plan\nbase + theirs", updated: 300)) == .adopted)
        #expect(repo.notes["a"]?.body == "# Plan\nbase + theirs")
        let c = copies(repo)
        #expect(c.count == 1)
        #expect(c.first?.body == "# Plan (conflicted copy, me)\nbase + mine")
        #expect(c.first?.dirty == true)        // synced to the other Macs
        #expect(conflicted == ["a"])
        #expect(e.notesToSend().map(\.id) == [c.first!.id])
    }

    @Test func concurrentEditThatWinsKeepsTheirTextAsACopy() {
        let repo = MemoryRepo()
        edited(repo, base: "base", now: "base + mine", updated: 300)
        let e = engine(repo)
        #expect(e.applyRemote(theirs("base + theirs", updated: 200)) == .keptLocal)
        #expect(repo.notes["a"]?.body == "base + mine")
        #expect(repo.notes["a"]?.seq == 11)
        #expect(copies(repo).map(\.body) == ["base + theirs (conflicted copy, other)"])
        // the same version arriving again (reconnect snapshot) doesn't copy twice
        #expect(e.applyRemote(theirs("base + theirs", updated: 200)) == .keptLocal)
        #expect(copies(repo).count == 1)
    }

    @Test func burstOfConflictsUpdatesOneCopy() {
        let repo = MemoryRepo()
        edited(repo, base: "base", now: "base + mine", updated: 300)
        let e = engine(repo)
        e.applyRemote(theirs("base + t1", updated: 200, seq: 11))
        var n = repo.notes["a"]!
        n.body = "base + mine 2"; n.updatedAt = 400
        repo.save(n)
        e.applyRemote(theirs("base + t1 t2", updated: 350, seq: 12))
        #expect(copies(repo).map(\.body) == ["base + t1 t2 (conflicted copy, other)"])
    }

    @Test func metaOnlyRemoteChangeMergesWithLocalText() {
        let repo = MemoryRepo()
        edited(repo, base: "base", now: "base + mine", updated: 200)
        let e = engine(repo)
        #expect(e.applyRemote(theirs("base", updated: 300, meta: ["pinned": .bool(true)])) == .merged)
        let n = repo.notes["a"]!
        #expect(n.body == "base + mine")
        #expect(n.pinned)
        #expect(n.dirty)
        #expect(n.updatedAt > 300)
        #expect(copies(repo).isEmpty)
    }

    @Test func localMetaOnlyChangeTakesTheirText() {
        let repo = MemoryRepo()
        edited(repo, base: "base", now: "base", updated: 300) // e.g. pinned here
        var n = repo.notes["a"]!
        n.pinned = true
        repo.save(n)
        let e = engine(repo)
        #expect(e.applyRemote(theirs("base + theirs", updated: 200)) == .merged)
        let m = repo.notes["a"]!
        #expect(m.body == "base + theirs")
        #expect(m.pinned)
        #expect(m.dirty && m.updatedAt > 300)
        #expect(copies(repo).isEmpty)
    }

    @Test func ourOwnEchoIsNotAConflict() {
        // Our put was accepted but its ack was lost; the snapshot brings it back.
        let repo = MemoryRepo()
        edited(repo, base: "base", now: "base + typed more", updated: 300)
        let e = engine(repo)
        #expect(e.applyRemote(theirs("base + typed", updated: 250, device: "me")) == .keptLocal)
        #expect(copies(repo).isEmpty)
    }

    @Test func remoteDeleteOfAnEditedNoteKeepsTheEdit() {
        let repo = MemoryRepo()
        edited(repo, base: "base", now: "base + mine", updated: 200)
        let e = engine(repo)
        var tomb = theirs("", updated: 300)
        tomb.deleted = true
        #expect(e.applyRemote(tomb) == .adopted)
        #expect(repo.notes["a"]?.deleted == true)
        #expect(copies(repo).map(\.body) == ["base + mine (conflicted copy, me)"])
    }

    @Test func remoteDeleteOfAnUnchangedNoteIsJustADelete() {
        let repo = MemoryRepo()
        edited(repo, base: "base", now: "base", updated: 200)
        let e = engine(repo)
        var tomb = theirs("", updated: 300)
        tomb.deleted = true
        #expect(e.applyRemote(tomb) == .adopted)
        #expect(copies(repo).isEmpty)
    }

    @Test func restoredServerDoesNotProduceSpuriousCopies() {
        let repo = MemoryRepo()
        var n = local("a", "v3 (server lost this)", updated: 300, dirty: false, seq: 30)
        n.baseHash = NoteText.hash(n.body)
        repo.save(n)
        repo.lastSeq = 30
        let e = engine(repo)
        #expect(e.applySnapshot([], seq: 12))  // restored backup: seq went back
        #expect(repo.notes["a"]?.dirty == true)
        #expect(repo.notes["a"]?.seq == nil)
        // the full resync brings the older version from the backup
        #expect(e.applySnapshot([theirs("v1 (backup)", updated: 100, seq: 9)], seq: 12) == false)
        #expect(repo.notes["a"]?.body == "v3 (server lost this)")
        #expect(e.notesToSend().map(\.id) == ["a"])
        #expect(copies(repo).isEmpty)
    }

    @Test func restoredServerWithANewerEditKeepsOursAsACopy() {
        let repo = MemoryRepo()
        var n = local("a", "mine (server lost this)", updated: 300, dirty: false, seq: 30)
        n.baseHash = NoteText.hash(n.body)
        repo.save(n)
        repo.lastSeq = 30
        let e = engine(repo)
        #expect(e.applySnapshot([], seq: 12))
        e.applySnapshot([theirs("edited after the restore", updated: 400, seq: 13)], seq: 13)
        #expect(repo.notes["a"]?.body == "edited after the restore")
        #expect(copies(repo).map(\.body) == ["mine (server lost this) (conflicted copy, me)"])
    }

    @Test func tooLargeNotesAreParkedUntilEdited() {
        let repo = MemoryRepo()
        repo.save(local("big", "x", updated: 10, dirty: true))
        let e = engine(repo)
        e.markUnsendable(repo.notes["big"]!)
        #expect(e.notesToSend().isEmpty)
        #expect(e.blockedNotes.map(\.id) == ["big"])
        var n = repo.notes["big"]!
        n.updatedAt = 11
        repo.save(n)
        #expect(e.blockedNotes.isEmpty)
        #expect(e.notesToSend().count == 1)
    }

    @Test func conflictCopyTitle() {
        #expect(NoteText.conflictCopyBody("\n```\ncode\n```\n# Title  \nbody", device: "Air")
                == "\n```\ncode (conflicted copy, Air)\n```\n# Title  \nbody")
        #expect(NoteText.conflictCopyBody("# Title  \nbody", device: "Air") == "# Title (conflicted copy, Air)\nbody")
        #expect(NoteText.conflictCopyBody("  \n\n", device: "Air") == nil)
        #expect(NoteText.title(of: NoteText.conflictCopyBody("- [ ] milk", device: "")!) == "milk (conflicted copy)")
    }

    @Test func stableHash() {
        #expect(NoteText.hash("") == 0xcbf2_9ce4_8422_2325)
        #expect(NoteText.hash("a") == 0xaf63_dc4c_8601_ec8c)
        #expect(NoteText.hash("abc") != NoteText.hash("acb"))
    }

    @Test func hostileTimestampsDontTrap() {
        // other clients' clocks/values are untrusted: never overflow
        #expect(Note.nextUpdate(after: .max) == .max)
        #expect(Note.nextUpdate(after: 5) >= Note.now())
        #expect(Note.nextUpdate(after: Note.now() + 10_000) > Note.now() + 9_000)
        #expect(Note.int64(.infinity) == nil && Note.int64(.nan) == nil)
        #expect(Note.int64(1e300) == .max && Note.int64(-1e300) == .min && Note.int64(12.7) == 12)
        var n = Note(id: "x", body: "", createdAt: .min, updatedAt: .max)
        n.meta["trashedAt"] = .number(1e300)
        #expect(n.trashedAt == .max)
        #expect(RelativeDate.short(.min) == "292471208y ago" || RelativeDate.short(.min).hasSuffix("y ago"))
        #expect(RelativeDate.short(.max) == "just now")
        let repo = MemoryRepo()
        repo.save(local("a", "base + mine", updated: .max, dirty: true, seq: 1))
        let e = SyncEngine(repo: repo)
        e.device = "me"
        var r = remote("a", "base", updated: 1, seq: 2)
        r.device = "other"
        r.meta = ["pinned": .bool(true)]
        _ = e.applyRemote(r) // must not trap on updatedAt + 1
    }

    @Test func isolatedInstancesOnlySyncLocally() {
        let isolated = ["BENTO_HOME": "/tmp/x"]
        #expect(SyncSettings.isBlocked(serverHost: "sync.example.com", environment: isolated))
        #expect(SyncSettings.isBlocked(serverHost: nil, environment: isolated))
        for local in ["127.0.0.1", "LOCALHOST", "::1", "[::1]"] {
            #expect(!SyncSettings.isBlocked(serverHost: local, environment: isolated))
        }
        #expect(!SyncSettings.isBlocked(serverHost: "sync.example.com", environment: [:]))
        #expect(!SyncSettings.isBlocked(serverHost: "sync.example.com", environment: ["BENTO_HOME": "/tmp/x", "BENTO_ALLOW_LIVE_SYNC": "1"]))
    }

    @Test func syncIsOffWithoutAServer() {
        let s = SyncSettings()
        #expect(!s.enabled && s.server.isEmpty && !s.hasServer)
        #expect(!SyncSettings(enabled: true, server: "  ").hasServer)
        #expect(SyncSettings(enabled: true, server: "https://sync.example.com").hasServer)
    }
}

@Suite struct StoreTests {
    func tempURL() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("notes-test-\(UUID().uuidString).sqlite")
    }

    @Test func persistsNotesMetaAndKV() {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        do {
            let s = NoteStore(url: url)
            var n = Note(id: "a", body: "# Hello\nworld", createdAt: 1, updatedAt: 2)
            n.pinned = true
            n.meta["custom"] = .string("kept")
            n.dirty = true
            n.seq = 4
            n.syncHeads = ["install-1": SyncHead(at: 1_761_000_000_123, hash: 0xfeed_beef_0000_0001)]
            s.save(n)
            s.markOpened("a", at: 99)
            s.lastSeq = 42
            s.setKVJSON("nav.back", ["a", "b"])
            s.save(Note(id: "t", body: "gone", createdAt: 1, updatedAt: 1))
            var t = s.note("t")!
            t.trashedAt = 5
            s.save(t)
        }
        let s2 = NoteStore(url: url)
        let a = s2.note("a")!
        #expect(a.body == "# Hello\nworld")
        #expect(a.pinned)
        #expect(a.meta["custom"] == .string("kept"))
        #expect(a.dirty)
        #expect(a.seq == 4)
        #expect(a.openedAt == 99)
        #expect(a.syncHeads == ["install-1": SyncHead(at: 1_761_000_000_123, hash: 0xfeed_beef_0000_0001)])
        #expect(s2.lastSeq == 42)
        #expect(s2.installID == NoteStore(url: url).installID) // stable across launches
        #expect(s2.kvJSON("nav.back", as: [String].self) == ["a", "b"])
        #expect(s2.liveNotes.map(\.id) == ["a"])
        #expect(s2.trashedNotes.map(\.id) == ["t"])
    }

    @Test func installIDBelongsToThisMac() {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        let first = NoteStore(url: url, hostID: "host-1").installID
        #expect(NoteStore(url: url, hostID: "host-1").installID == first)
        // the database restored onto another Mac: a new id there, kept from then on
        let moved = NoteStore(url: url, hostID: "host-2").installID
        #expect(moved != first && !moved.isEmpty)
        #expect(NoteStore(url: url, hostID: "host-2").installID == moved)
    }

    @Test func headsLeftBehindByAnOlderBuildAreDropped() throws {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        do {
            let s = NoteStore(url: url)
            var n = Note(id: "a", body: "synced text", createdAt: 1, updatedAt: 2)
            n.syncHeads = ["install-1": SyncHead(at: 2, hash: NoteText.hash("synced text"))]
            s.save(n)
            s.save(Note(id: "b", body: "other", createdAt: 1, updatedAt: 2))
            var b = s.note("b")!
            b.syncHeads = ["install-1": SyncHead(at: 2, hash: 9)]
            s.save(b)
        }
        // an older build (no heads column) edits note a: the stored heads stay behind
        try SQLiteDB(path: url.path).exec("UPDATE notes SET body = 'edited by an older build' WHERE id = 'a'")
        let s = NoteStore(url: url)
        #expect(s.note("a")?.syncHeads == nil)
        #expect(s.note("b")?.syncHeads == ["install-1": SyncHead(at: 2, hash: 9)]) // still its text
    }

    @Test func migratesOldDatabasesAndKeepsBaseHash() throws {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        do {
            // a DB written by the first release (no base_hash column)
            let db = try SQLiteDB(path: url.path)
            try db.exec("""
            CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, seq INTEGER, device TEXT NOT NULL DEFAULT '',
              meta TEXT NOT NULL DEFAULT '{}', dirty INTEGER NOT NULL DEFAULT 0, opened_at INTEGER NOT NULL DEFAULT 0);
            INSERT INTO notes (id, body, created_at, updated_at, dirty) VALUES ('old', 'kept', 1, 2, 1);
            """)
        }
        do {
            let s = NoteStore(url: url)
            #expect(s.note("old")?.body == "kept")
            #expect(s.note("old")?.dirty == true)
            #expect(s.note("old")?.baseHash == nil)
            var n = s.note("old")!
            n.baseHash = NoteText.hash("kept") // > Int64.max: stored as its bit pattern
            s.save(n)
        }
        #expect(NoteStore(url: url).note("old")?.baseHash == NoteText.hash("kept"))
    }

    @Test func nulCharactersDontTruncateBodies() {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url) }
        NoteStore(url: url).save(Note(id: "n", body: "before\u{0}after", createdAt: 1, updatedAt: 1))
        #expect(NoteStore(url: url).note("n")?.body == "beforeafter")
    }

    @Test func listOrder() {
        let s = NoteStore(url: nil)
        var p1 = Note(id: "p1", body: "p1", createdAt: 1); p1.pinned = true; p1.pinOrder = 2
        var p2 = Note(id: "p2", body: "p2", createdAt: 1); p2.pinned = true; p2.pinOrder = 1
        var old = Note(id: "old", body: "o", createdAt: 1); old.openedAt = 10
        var recent = Note(id: "recent", body: "r", createdAt: 1); recent.openedAt = 20
        var tomb = Note(id: "tomb", body: "", createdAt: 1); tomb.deleted = true
        for n in [p1, p2, old, recent, tomb] { s.save(n) }
        #expect(s.liveNotes.map(\.id) == ["p2", "p1", "recent", "old"])
    }
}

@Suite struct ExportTests {
    @Test func html() {
        let md = "# Title\nSome **bold** & <stuff>\n- a\n    - nested\n- b\n1. one\n- [x] done\n> q\n---\n```swift\nlet a = 1 < 2\n```"
        let h = MarkdownExport.html(md, standalone: false)
        #expect(h.contains("<h1>Title</h1>"))
        #expect(h.contains("<p>Some <strong>bold</strong> &amp; &lt;stuff&gt;</p>"))
        #expect(h.contains("<ul><li>a<ul><li>nested</li></ul>\n</li>\n<li>b</li></ul>"))
        #expect(h.contains("<ol><li>one</li></ol>"))
        #expect(h.contains("<input type=\"checkbox\" disabled checked> done"))
        #expect(h.contains("<blockquote>\n<p>q</p>\n</blockquote>"))
        #expect(h.contains("<hr>"))
        #expect(h.contains("<pre><code class=\"language-swift\">let a = 1 &lt; 2</code></pre>"))
    }

    @Test func plain() {
        #expect(MarkdownExport.plainText("# T\n- [ ] a\n- b\n**x** [l](u)") == "T\n☐ a\n• b\nx l")
    }

    @Test func fuzzy() {
        #expect(FuzzyMatch.score("dt", "Daily Todos") != nil)
        #expect(FuzzyMatch.score("xyz", "Daily Todos") == nil)
        #expect((FuzzyMatch.score("daily", "Daily Todos") ?? 0) > (FuzzyMatch.score("dt", "Daily Todos") ?? 0))
        #expect(FuzzyMatch.noteScore("milk", title: "Shopping", body: "- [ ] milk") != nil)
        #expect(FuzzyMatch.noteScore("", title: "x", body: "") == 0)
    }

    @Test func relativeDates() {
        let now: Int64 = 10_000_000_000
        #expect(RelativeDate.short(now - 30_000, now: now) == "just now")
        #expect(RelativeDate.short(now - 40 * 60_000, now: now) == "40m ago")
        #expect(RelativeDate.short(now - 3 * 3_600_000, now: now) == "3h ago")
        #expect(RelativeDate.short(now - 21 * 86_400_000, now: now) == "3w ago")
    }
}

@Suite struct PasteTests {
    func pasteboard(_ type: NSPasteboard.PasteboardType, _ data: Data) -> NSPasteboard {
        let pb = NSPasteboard(name: NSPasteboard.Name("bento-notes-test-\(UUID().uuidString)"))
        pb.clearContents()
        pb.setData(data, forType: type)
        return pb
    }

    @Test func plainTextAndLineEndings() {
        let pb = pasteboard(.string, Data("a\r\nb\rc\u{2028}d\u{0}e".utf8))
        #expect(NoteTextView.plainText(from: pb) == "a\nb\nc\nde")
        pb.releaseGlobally()
    }

    @Test func richTextLosesStylingAndListsBecomeMarkdown() {
        let rtf = Data(#"{\rtf1\ansi{\fonttbl\f0 Helvetica;}\f0 Rich {\b bold} text\par second line}"#.utf8)
        let pb = pasteboard(.rtf, rtf)
        #expect(NoteTextView.plainText(from: pb) == "Rich bold text\nsecond line")
        pb.releaseGlobally()
        #expect(NoteTextView.markdownLists("\t•\tone\n\t\t◦\tnested\n\t1.\tfirst\nplain\ttab") == "- one\n    - nested\n1. first\nplain\ttab")
    }

    @Test func urlDetectionForLinkOnPaste() {
        #expect(NoteTextView.singleURL(" https://raycast.com/notes \n") == "https://raycast.com/notes")
        #expect(NoteTextView.singleURL("mailto:a@b.c") == "mailto:a@b.c")
        #expect(NoteTextView.singleURL("https://a.b two") == nil)
        #expect(NoteTextView.singleURL("file:///etc/hosts") == nil)
        #expect(NoteTextView.singleURL("just text") == nil)
        #expect(NoteTextView.singleURL("https://") == nil)
    }

    @Test func imagesHaveNoText() {
        let pb = pasteboard(.png, Data([0x89, 0x50, 0x4e, 0x47]))
        #expect(NoteTextView.plainText(from: pb) == nil)
        pb.releaseGlobally()
    }
}

@Suite struct FrameTests {
    @Test func reachableFrames() {
        let screens = [NSRect(x: 0, y: 0, width: 1440, height: 875)]
        #expect(NotesWindowController.isReachable(NSRect(x: 100, y: 100, width: 400, height: 450), screens: screens))
        // saved on a display that's gone
        #expect(!NotesWindowController.isReachable(NSRect(x: 3000, y: 100, width: 400, height: 450), screens: screens))
        // title bar above the top of the screen (only the bottom sliver visible)
        #expect(!NotesWindowController.isReachable(NSRect(x: 100, y: 860, width: 400, height: 450), screens: screens))
        // only 20 pt of the title bar on screen horizontally
        #expect(!NotesWindowController.isReachable(NSRect(x: 1420, y: 100, width: 400, height: 450), screens: screens))
        #expect(NotesWindowController.isReachable(NSRect(x: -300, y: 100, width: 400, height: 450), screens: screens))
    }
}

@Suite struct EmojiTests {
    @Test func search() {
        #expect(EmojiIndex.search("smil").first?.emoji == "😄")
        #expect(EmojiIndex.search("thumbs").first?.emoji == "👍")
        #expect(EmojiIndex.search("heart").first?.emoji == "❤️")
        #expect(EmojiIndex.search("rocket").first?.emoji == "🚀")
        #expect(EmojiIndex.search("face with tears").contains { $0.emoji == "😂" })
        #expect(EmojiIndex.search("zzzzqq").isEmpty)
        #expect(EmojiIndex.all.count > 800)
    }
}

/// Live editing on two Macs: concurrent text edits merge like Google Docs instead of one
/// side's typing vanishing into a conflicted copy.
@Suite struct LiveMergeTests {
    /// One Mac: its engine and repository, with note "a" synced at seq 1.
    final class Mac {
        let repo = MemoryRepo()
        private(set) var e: SyncEngine
        let name: String
        var changes: [SyncEngine.RemoteResult] = []

        init(_ name: String, body: String) {
            self.name = name
            e = SyncEngine(repo: repo)
            e.device = name
            var start = remote("a", body, updated: 100, seq: 1) // the note as it came from the server
            start.device = "x"
            e.applyRemote(start)
            caret = (body as NSString).length
            shown = body
            e.onRemoteChange = { [unowned self] _, r in changes.append(r) }
        }

        /// Quit or crash and start again: only what's in the repository survives.
        func relaunch() {
            e = SyncEngine(repo: repo)
            e.device = name
            e.onRemoteChange = { [unowned self] _, r in changes.append(r) }
        }

        /// A meta-only change (pin, trash, delete), as NotesController.mutate makes it.
        func mutate(_ change: (inout Note) -> Void) {
            var n = note
            change(&n)
            n.updatedAt = Note.nextUpdate(after: n.updatedAt)
            n.dirty = true
            repo.save(n)
        }

        /// The server refused this version for good (e.g. too large): edit it again.
        func touchBlocked() {
            if e.blockedNotes.contains(where: { $0.id == "a" }) { mutate { _ in } }
        }

        var note: Note { repo.notes["a"]! }
        var copies: [Note] { repo.notes.values.filter { $0.meta["conflictOf"] != nil } }

        /// What NotesController.editorChanged + flushPendingSave do.
        func type(_ edit: (String) -> String) {
            var n = note
            e.willEdit(n)
            n.body = edit(n.body)
            n.updatedAt = Note.nextUpdate(after: n.updatedAt)
            n.dirty = true
            repo.save(n)
        }

        var caret: Int
        private var shown: String

        /// Types at the caret (or at `elsewhere`, clamped), optionally deleting the
        /// character before it first; the caret ends after the typing.
        func typeAtCaret(_ text: String, elsewhere: Int?, backspace: Bool) {
            followCaret()
            type { body in
                let s = NSMutableString(string: body)
                var at = min(elsewhere ?? caret, s.length)
                if backspace, at > 0 { s.deleteCharacters(in: NSRange(location: at - 1, length: 1)); at -= 1 }
                s.insert(text, at: at)
                caret = at + (text as NSString).length
                return s as String
            }
            shown = note.body
        }

        /// What the editor does when the note changes underneath (TextMerge.map).
        func followCaret() {
            let body = note.body
            guard body != shown else { return }
            caret = TextMerge.map(NSRange(location: min(caret, (shown as NSString).length), length: 0),
                                  through: TextMerge.edits(from: shown, to: body)).location
            shown = body
        }

        func put() -> [String: Any]? {
            guard let n = e.notesToSend().first(where: { $0.id == "a" }) else { return nil } // copies are other notes
            e.markSent(n)
            return wire(e.encode(n))
        }

        func receive(_ obj: [String: Any]) { e.applyRemote(NoteWire.decode(obj)!) }
    }

    /// bento-sync's rule: accept iff updated_at >= stored; broadcast to the others first.
    final class Server {
        var stored: [String: Any]
        var seq: Int64 = 1
        init(_ body: String) { stored = ["id": "a", "body": body, "created_at": 1, "updated_at": 100, "seq": 1, "device": "x", "meta": [:]] }

        func sync(_ macs: [Mac], rounds: Int = 8) {
            for _ in 0..<rounds {
                // every Mac sends what it has before hearing from the others (concurrent puts)
                let puts = macs.compactMap { m in m.put().map { (m, $0) } }
                if puts.isEmpty { return }
                for (m, p) in puts {
                    let accepted = (p["updated_at"] as! NSNumber).int64Value >= (stored["updated_at"] as! NSNumber).int64Value
                    if accepted {
                        seq += 1
                        stored = p
                        stored["seq"] = seq
                        for o in macs where o !== m { o.receive(stored) }
                    }
                    m.e.ack(id: "a", seq: (stored["seq"] as! NSNumber).int64Value, accepted: accepted)
                    if !accepted { m.receive(stored) }
                }
            }
        }
    }

    static func wire(_ obj: [String: Any]) -> [String: Any] {
        try! JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: obj)) as! [String: Any]
    }
    func wire(_ obj: [String: Any]) -> [String: Any] { Self.wire(obj) }

    let base = "# Plan\nintro\n\nend\n"

    @Test func typingOnBothMacsAtOnceKeepsBoth() {
        let a = Mac("A", body: base), b = Mac("B", body: base), server = Server(base)
        a.type { $0.replacingOccurrences(of: "intro\n", with: "intro\nA line\n") }
        b.type { $0.replacingOccurrences(of: "\nend", with: "\nB line\nend") }
        server.sync([a, b], rounds: 1)
        // each kept typing right after its own line before the merged text went out
        a.type { $0.replacingOccurrences(of: "A line", with: "A line more") }
        b.type { $0.replacingOccurrences(of: "B line", with: "B line too") }
        server.sync([a, b])
        #expect(a.note.body == "# Plan\nintro\nA line more\n\nB line too\nend\n")
        #expect(b.note.body == a.note.body)
        #expect(a.copies.isEmpty && b.copies.isEmpty)
        #expect(!a.note.dirty && !b.note.dirty)
        #expect(a.e.notesToSend().isEmpty && b.e.notesToSend().isEmpty)
        #expect(a.changes.contains(.merged) && b.changes.contains(.merged))
    }

    /// Deterministic generator so failures reproduce.
    struct SeededRNG: RandomNumberGenerator {
        var state: UInt64
        mutating func next() -> UInt64 {
            state = state &* 6364136223846793005 &+ 1442695040888963407
            return state >> 11 | state << 53
        }
    }

    /// bento-sync over WebSockets, step by step: puts wait at the server and are handled
    /// one at a time; every connection is a FIFO (so a broadcast with a lower seq always
    /// arrives before an ack); a reconnect drops the old connection's queue, and a put it
    /// left at the server comes back to the new connection as a broadcast.
    final class Network {
        enum Message { case note([String: Any]), ack(Int64, Bool), error }
        let macs: [Mac]
        var stored: [String: Any]
        var seq: Int64 = 1
        var inbox: [(mac: Int, conn: Int, put: [String: Any])] = []
        var queues: [[Message]]
        var conns: [Int]

        init(_ macs: [Mac], body: String) {
            self.macs = macs
            stored = ["id": "a", "body": body, "created_at": 1, "updated_at": 100, "seq": 1, "device": "x", "meta": [:]]
            queues = macs.map { _ in [] }
            conns = macs.map { _ in 0 }
        }

        func send(_ i: Int) { if let p = macs[i].put() { inbox.append((i, conns[i], p)) } }

        /// Handles the next put. `refuse`: as if it lost last-writer-wins; `fail`: an
        /// error reply (validation, size); `lose`: it never arrives.
        func serve(refuse: Bool = false, fail: Bool = false, lose: Bool = false) {
            guard !inbox.isEmpty else { return }
            let (i, conn, p) = inbox.removeFirst()
            if lose { return }
            if fail {
                if conns[i] == conn { queues[i].append(.error) }
                return
            }
            let accepted = !refuse && (p["updated_at"] as! NSNumber).int64Value >= (stored["updated_at"] as! NSNumber).int64Value
            if accepted {
                seq += 1
                stored = p
                stored["seq"] = seq
                for j in macs.indices where !(j == i && conns[j] == conn) { queues[j].append(.note(stored)) }
            }
            guard conns[i] == conn else { return } // that connection is gone: no ack
            queues[i].append(.ack(seq, accepted))
            if !accepted { queues[i].append(.note(stored)) }
        }

        func deliver(_ i: Int) {
            guard !queues[i].isEmpty else { return }
            switch queues[i].removeFirst() {
            case .note(let n): macs[i].receive(n)
            case .ack(let s, let ok): macs[i].e.ack(id: "a", seq: ok ? s : nil, accepted: ok)
            case .error: macs[i].e.putFailed(id: "a")
            }
            macs[i].followCaret()
        }

        /// A quit or crash and a fresh start, then a new connection.
        func relaunch(_ i: Int) {
            macs[i].relaunch()
            reconnect(i)
        }

        func reconnect(_ i: Int) {
            conns[i] += 1
            queues[i] = []
            macs[i].e.reset()
            let s = (stored["seq"] as! NSNumber).int64Value
            macs[i].e.applySnapshot(s > macs[i].repo.lastSeq ? [NoteWire.decode(stored)!] : [], seq: seq)
            macs[i].followCaret()
        }

        var quiet: Bool { inbox.isEmpty && queues.allSatisfy(\.isEmpty) && macs.allSatisfy { $0.e.notesToSend().allSatisfy { $0.id != "a" } } }

        /// Lets everything settle without typing; false if it never goes quiet.
        func settle(steps: Int = 300) -> Bool {
            for _ in 0..<steps {
                macs.forEach { $0.touchBlocked() }
                if quiet { return true }
                for i in macs.indices { send(i) }
                while !inbox.isEmpty { serve() }
                for i in macs.indices { while !queues[i].isEmpty { deliver(i) } }
            }
            return quiet
        }
    }

    enum Fuzz { case insertOnly, withDeletes, threeMacs, sameName, metaAndRelaunch, sharedInstallID }

    /// Two Macs (or three) typing, mostly at their caret, also after sending a put and
    /// before the other's arrives; random delivery delays and reconnects; then quiet.
    func fuzz(seed: Int, _ kind: Fuzz) {
        var rng = SeededRNG(state: UInt64(seed) &* 0x9E37_79B9_7F4A_7C15 &+ 1)
        let start = "# Notes\nfirst line\n\nsecond line\n"
        let names = kind == .threeMacs ? ["A", "B", "C"] : kind == .sameName ? ["MacBook Pro", "MacBook Pro"] : ["A", "B"]
        let macs = names.map { Mac($0, body: start) }
        if kind == .sharedInstallID { macs[1].repo.installID = macs[0].repo.installID } // a copied database
        let net = Network(macs, body: start)
        var next: UInt32 = 0x4E00 // every typed character is unique (CJK block)
        var typed = Set<Character>()
        var deleted = false
        for _ in 0..<120 {
            let i = Int.random(in: 0..<macs.count, using: &rng)
            let extra = kind == .metaAndRelaunch
            switch Int.random(in: 0..<1000, using: &rng) {
            case 0..<350:
                let m = macs[i]
                guard !m.note.deleted else { break }
                let run = (0..<Int.random(in: 1...3, using: &rng)).map { _ -> Character in
                    next += 1
                    return Character(Unicode.Scalar(next)!)
                }
                typed.formUnion(run)
                let elsewhere = Int.random(in: 0..<10, using: &rng) == 0
                let backspace = kind == .withDeletes && Int.random(in: 0..<4, using: &rng) == 0
                m.typeAtCaret(String(run), elsewhere: elsewhere ? Int.random(in: 0...1000, using: &rng) : nil, backspace: backspace)
            case 350..<550: net.send(i)
            case 550..<680: net.serve()
            case 680..<690: net.serve(refuse: true)
            case 690..<700: net.serve(fail: true)
            case 700..<960: net.deliver(i)
            case 960..<975 where extra: macs[i].mutate { $0.pinned.toggle() }
            case 975..<985 where extra:
                macs[i].mutate { n in n.meta["trashedAt"] = n.meta["trashedAt"] == nil ? .number(Double(Note.now())) : nil }
            case 985..<990 where extra: net.relaunch(i)
            case 990..<991 where extra:
                deleted = true
                macs[i].mutate { $0.deleted = true; $0.body = "" }
            default: net.reconnect(i)
            }
        }
        #expect(net.settle(), "seed \(seed): never went quiet")
        let a = macs[0].note.body
        let server = NoteWire.decode(net.stored)!
        #expect(macs.allSatisfy { $0.note.body == a }, "seed \(seed): diverged")
        #expect(a == server.body, "seed \(seed): server differs")
        #expect(macs.allSatisfy { $0.note.meta == server.meta && $0.note.deleted == server.deleted }, "seed \(seed): meta differs")
        #expect(macs.allSatisfy { !$0.note.dirty })
        // quiet rounds: nothing is sent and nothing grows
        for _ in 0..<30 {
            for i in macs.indices { net.send(i) }
            #expect(net.inbox.isEmpty, "seed \(seed): put while quiet")
            net.serve()
        }
        #expect(macs[0].note.body == a)
        let marks = a.filter { typed.contains($0) }
        #expect(marks.count == Set(marks).count, "seed \(seed): duplicated typing in \(a)")
        switch kind {
        case .insertOnly, .sameName:
            #expect(String(a.filter { !typed.contains($0) }) == start, "seed \(seed): base text changed: \(a)")
            #expect(Set(marks) == typed, "seed \(seed): lost typing")
            #expect(macs.allSatisfy { $0.copies.isEmpty }, "seed \(seed): conflicted copy")
        case .threeMacs, .metaAndRelaunch, .sharedInstallID:
            // Three at once may not merge (no text holds exactly what all share), nor can a
            // Mac that just relaunched (its history is gone): whatever doesn't merge is in a
            // conflicted copy, never lost (unless the note was deleted).
            guard !deleted else { break }
            #expect(String(a.filter { !typed.contains($0) }) == start, "seed \(seed): base text changed: \(a)")
            let kept = Set(macs.flatMap { m in m.repo.notes.values.map(\.body) }.joined())
            #expect(typed.isSubset(of: kept), "seed \(seed): lost typing")
        case .withDeletes:
            break
        }
    }

    @Test(arguments: 0..<150) func concurrentTypingNeverLosesOrDuplicates(seed: Int) { fuzz(seed: seed, .insertOnly) }
    @Test(arguments: 0..<150) func concurrentTypingAndDeletingConverges(seed: Int) { fuzz(seed: seed, .withDeletes) }
    @Test(arguments: 0..<150) func threeMacsTypingAtOnceNeverLoseOrDuplicate(seed: Int) { fuzz(seed: seed, .threeMacs) }
    @Test(arguments: 0..<150) func macsWithTheSameNameStillMerge(seed: Int) { fuzz(seed: seed, .sameName) }
    @Test(arguments: 0..<150) func pinsTrashDeletesAndRelaunchesNeverLoseTyping(seed: Int) { fuzz(seed: seed, .metaAndRelaunch) }
    @Test(arguments: 0..<150) func macsSharingAnInstallIDNeverLoseTyping(seed: Int) { fuzz(seed: seed, .sharedInstallID) }

    @Test func aDeferredVersionSurvivesACrash() {
        // B's put is stored; A's concurrent put never reaches the server; B's version
        // reaches A while A's put is in flight (so it waits) and A then crashes.
        let a = Mac("A", body: base), b = Mac("B", body: base)
        let net = Network([a, b], body: base)
        a.typeAtCaret(" from A", elsewhere: nil, backspace: false)
        net.send(0)
        b.typeAtCaret("B: ", elsewhere: 0, backspace: false)
        net.send(1)
        net.serve(lose: true) // A's
        net.serve()           // B's, seq 2
        net.deliver(0)
        #expect(a.repo.lastSeq == 1) // held below the version that waits
        net.relaunch(0)       // hello since 1 fetches B's version again
        #expect(net.settle())
        let everything = [a, b].flatMap { m in m.repo.notes.values.map(\.body) }.joined()
        #expect(everything.contains("B: "), "B's text is somewhere")
        #expect(everything.contains(" from A"), "A's text is somewhere")
        #expect(a.note.body == b.note.body)
    }

    @Test func aFailedPutLetsTheWaitingVersionIn() {
        let a = Mac("A", body: base), b = Mac("B", body: base)
        let net = Network([a, b], body: base)
        a.typeAtCaret(" from A", elsewhere: nil, backspace: false)
        net.send(0)
        b.typeAtCaret("B: ", elsewhere: 0, backspace: false)
        net.send(1)
        net.serve(fail: true) // A's put: an error reply
        net.serve()           // B's
        net.deliver(0)        // the error: B's version may come in now
        #expect(!a.note.body.contains("B: "))
        net.deliver(0)        // B's version
        #expect(a.note.body == "B: " + base + " from A")
        #expect(net.settle())
        #expect(b.note.body == a.note.body)
    }

    @Test func macsWithTheSameNameKeepBothEdits() {
        let a = Mac("MacBook Pro", body: base), b = Mac("MacBook Pro", body: base)
        let net = Network([a, b], body: base)
        a.typeAtCaret(" mine", elsewhere: nil, backspace: false)
        b.typeAtCaret("theirs ", elsewhere: 0, backspace: false)
        net.send(0); net.send(1)
        #expect(net.settle())
        #expect(a.note.body == "theirs " + base + " mine")
        #expect(b.note.body == a.note.body)
        #expect(a.copies.isEmpty && b.copies.isEmpty)
    }

    @Test func aRelaunchedMacStillKeepsItsSyncedText() {
        // A's edit is acked; A quits; B's version made without it overwrites it on the
        // server. A's heads were stored with the note, so A knows its text isn't in B's.
        let a = Mac("A", body: base), b = Mac("B", body: base)
        let net = Network([a, b], body: base)
        a.typeAtCaret(" from A", elsewhere: nil, backspace: false)
        b.typeAtCaret("B: ", elsewhere: 0, backspace: false)
        net.send(0); net.serve(); net.deliver(0) // A acked
        net.send(1)
        a.relaunch()
        net.serve()                              // B's overwrites A's on the server
        #expect(net.settle())
        let everything = [a, b].flatMap { m in m.repo.notes.values.map(\.body) }.joined()
        #expect(everything.contains(" from A") && everything.contains("B: "))
        #expect(a.note.body == b.note.body)
    }

    @Test func headsInAPutAreCapped() {
        let a = Mac("A", body: base)
        var n = a.note
        n.syncHeads = Dictionary(uniqueKeysWithValues: (0..<40).map { ("install-\($0)", SyncHead(at: Int64($0), hash: UInt64($0))) })
        n.dirty = true
        a.repo.save(n)
        let h = a.e.sentHeads(a.note)!
        #expect(h.count == SyncEngine.headsSent)
        #expect(h[a.repo.installID] != nil) // our own always
        #expect(h["install-39"] != nil && h["install-0"] == nil) // the newest others
        let meta = try! JSONSerialization.data(withJSONObject: a.e.encode(a.note)["meta"]!)
        #expect(meta.count < SyncSettings.maxMetaBytes)
    }

    @Test func ourPinSurvivesWhenTheyChangedTheText() {
        // We edited the text and pinned; their newer version only has more text.
        let a = Mac("A", body: base), b = Mac("B", body: base)
        a.typeAtCaret(" mine", elsewhere: nil, backspace: false)
        a.mutate { $0.pinned = true }
        b.typeAtCaret("theirs ", elsewhere: 0, backspace: false)
        var bn = b.note
        bn.updatedAt = a.note.updatedAt + 50 // theirs is newer
        b.repo.save(bn)
        var pb = b.put()!
        pb["seq"] = 2
        a.e.applyRemote(NoteWire.decode(pb)!)
        #expect(a.note.body == "theirs " + base + " mine")
        #expect(a.note.pinned)
        #expect(a.note.dirty)
    }

    @Test func ourPinSurvivesAFastForward() {
        // Our text edit reached them, our pin didn't: their version is all of our text.
        let a = Mac("A", body: base), b = Mac("B", body: base)
        let net = Network([a, b], body: base)
        a.typeAtCaret(" mine", elsewhere: nil, backspace: false)
        net.send(0); net.serve(); net.deliver(0); net.deliver(1) // A acked, B has it
        a.mutate { $0.pinned = true }
        b.typeAtCaret(" and theirs", elsewhere: 1000, backspace: false)
        net.send(1); net.serve(); net.deliver(1); net.deliver(0)
        #expect(a.note.body == base + " mine and theirs")
        #expect(a.note.pinned)
        #expect(net.settle())
        #expect(b.note.pinned)
    }

    @Test func overlappingEditsMakeOneConflictedCopyNotTwo() {
        // Both rewrite the same line offline; B's is newer and not sent yet when A's
        // arrives: B keeps its text and A's as a copy, and A then just takes B's.
        let start = "# Shared\nbase"
        let a = Mac("A", body: start), b = Mac("B", body: start)
        let net = Network([a, b], body: start)
        a.type { _ in "# Shared\nedited on A" }
        b.type { _ in "# Shared\nedited on B" }
        net.send(0); net.serve()
        while !net.queues[1].isEmpty { net.deliver(1) } // A's version reaches B before B sends
        #expect(net.settle())
        #expect(a.note.body == "# Shared\nedited on B" && b.note.body == a.note.body)
        let copies = a.copies + b.copies
        #expect(copies.map(\.body) == ["# Shared (conflicted copy, A)\nedited on A"])
    }

    @Test func ourNewerDeleteKeepsTheirTextAsACopy() {
        // We deleted the note (again unsent) after a synced delete; an older edit of
        // theirs arrives: the note stays deleted, their text is kept as a copy.
        let repo = MemoryRepo()
        let e = SyncEngine(repo: repo)
        var n = Note(id: "a", body: "", createdAt: 1, updatedAt: 1000)
        n.deleted = true
        n.dirty = true
        n.seq = 7
        n.baseHash = NoteText.hash("")
        repo.save(n)
        var r = remote("a", "# Their text", updated: 500, seq: 9)
        r.device = "B"
        e.applyRemote(r)
        #expect(repo.notes["a"]!.deleted && repo.notes["a"]!.body.isEmpty)
        #expect(repo.notes.values.contains { $0.body == "# Their text (conflicted copy, B)" })
    }

    @Test func aCopiedDatabaseOnASecondMacIsDetected() {
        // B runs from a copy of A's database: same install id, another computer name.
        let a = Mac("A", body: base), b = Mac("B", body: base)
        b.repo.installID = a.repo.installID
        let net = Network([a, b], body: base)
        a.typeAtCaret(" from A", elsewhere: nil, backspace: false)
        b.typeAtCaret("B: ", elsewhere: 0, backspace: false)
        net.send(0); net.send(1)
        #expect(net.settle())
        #expect(a.repo.installID != b.repo.installID) // one of them took a new id
        let everything = [a, b].flatMap { m in m.repo.notes.values.map(\.body) }.joined()
        #expect(everything.contains(" from A") && everything.contains("B: "))
        #expect(a.note.body == b.note.body)
    }

    @Test func anUnsendableNoteLetsTheWaitingVersionIn() {
        let a = Mac("A", body: base), b = Mac("B", body: base)
        let net = Network([a, b], body: base)
        a.typeAtCaret(" from A", elsewhere: nil, backspace: false)
        net.send(0)
        b.typeAtCaret("B: ", elsewhere: 0, backspace: false)
        net.send(1)
        net.serve(lose: true)
        net.serve()
        net.deliver(0)            // waits for A's put
        net.reconnect(0)          // that put may still land: keeps waiting
        #expect(a.repo.lastSeq == 1)
        a.e.markUnsendable(a.note) // never resent: nothing else would resolve it
        #expect(a.note.body == "B: " + base + " from A")
        #expect(a.repo.lastSeq == 2)
    }

    @Test func noOrphanPinOrder() {
        // we reordered pins while they unpinned
        let m = SyncEngine.mergeMeta(base: ["pinned": .bool(true), "pinOrder": .number(1)],
                                     local: ["pinned": .bool(true), "pinOrder": .number(2)],
                                     remote: [:], remoteNewer: true)
        #expect(m.isEmpty)
    }

    @Test func anOlderClientsMetaChangeMergesKeyByKey() {
        // We edited the text and pinned; an older client (no heads) trashed the note.
        let a = Mac("A", body: base)
        a.typeAtCaret(" mine", elsewhere: nil, backspace: false)
        a.mutate { $0.pinned = true }
        var n = a.note
        n.baseHash = NoteText.hash(base)
        a.repo.save(n)
        var r = remote("a", base, updated: a.note.updatedAt + 50, seq: 2)
        r.device = "Old Mac"
        r.meta = ["trashedAt": .number(5)]
        #expect(a.e.applyRemote(r) == .merged)
        #expect(a.note.body == base + " mine")
        #expect(a.note.pinned && a.note.meta["trashedAt"] == .number(5))
    }

    @Test func crissCrossMergesDontDuplicate() {
        // The reviewer's case: A sends "abc" and keeps typing "def"; B's concurrent "xyz"
        // was made without "abc". Only one side may merge the pair.
        let a = Mac("A", body: base), b = Mac("B", body: base)
        let net = Network([a, b], body: base)
        a.typeAtCaret("abc", elsewhere: nil, backspace: false)
        net.send(0)
        a.typeAtCaret("def", elsewhere: nil, backspace: false)
        b.typeAtCaret("xyz", elsewhere: 0, backspace: false)
        net.send(1)
        net.serve(); net.serve()
        for _ in 0..<4 { net.deliver(0); net.deliver(1) }
        #expect(net.settle())
        #expect(a.note.body == "xyz" + base + "abcdef")
        #expect(b.note.body == a.note.body)
        #expect(a.copies.isEmpty && b.copies.isEmpty)
    }

    @Test func anAckedEditIsntLostToAConcurrentOne() {
        // A's edit is acked (clean) when B's version, made without it, overwrites it on
        // the server: A merges instead of dropping its own text.
        let a = Mac("A", body: base), b = Mac("B", body: base)
        a.type { $0 + "from A\n" }
        let pa = a.put()!
        a.e.ack(id: "a", seq: 2, accepted: true)
        #expect(!a.note.dirty)
        b.type { "intro first\n" + $0 }
        var pb = b.put()!
        pb["seq"] = 3
        #expect(a.e.applyRemote(NoteWire.decode(pb)!) == .merged)
        #expect(a.note.body == "intro first\n" + base + "from A\n")
        #expect(a.note.dirty) // goes back to the server, which only has B's text
        #expect(a.note.updatedAt > (pb["updated_at"] as! NSNumber).int64Value)
        _ = pa
    }

    @Test func versionMadeFromOurTextIsAFastForward() {
        let a = Mac("A", body: base), b = Mac("B", body: base)
        a.type { $0 + "mine\n" }
        var pa = a.put()!
        pa["seq"] = 2
        b.receive(pa)
        b.type { $0.replacingOccurrences(of: "mine", with: "mine, edited by B") }
        var pb = b.put()!
        pb["seq"] = 3
        // A's ack hasn't arrived yet (still dirty): no conflicted copy, just B's text
        #expect(a.note.dirty)
        #expect(a.e.applyRemote(NoteWire.decode(pb)!) == .adopted)
        #expect(a.note.body == base + "mine, edited by B\n")
        #expect(a.copies.isEmpty)
    }

    @Test func ourOwnVersionComingBackIsNotMergedAgain() {
        let a = Mac("A", body: base)
        a.type { $0 + "typed" }
        var echo = a.put()!
        echo["seq"] = 2
        a.type { $0 + " more" } // typing continued right after it
        #expect(a.e.applyRemote(NoteWire.decode(echo)!) == .keptLocal)
        #expect(a.note.body == base + "typed more")
        #expect(a.copies.isEmpty)
    }

    @Test func overlappingEditsStillKeepAConflictedCopy() {
        let a = Mac("A", body: "the quick brown fox"), b = Mac("B", body: "the quick brown fox")
        a.type { _ in "the fox" }
        b.type { _ in "the quick red fox" }
        // B's edit is the later one (the base marker is tied to updated_at, so re-encode)
        var bn = b.note
        bn.updatedAt = a.note.updatedAt + 10
        var pb = wire(b.e.encode(bn))
        pb["seq"] = 2
        #expect(a.e.applyRemote(NoteWire.decode(pb)!) == .adopted)
        #expect(a.note.body == "the quick red fox")
        #expect(a.copies.map(\.body) == ["the fox (conflicted copy, A)"])
    }

    @Test func unknownBaseFallsBackToLastWriterWins() {
        // e.g. the base was edited before a relaunch: nothing to merge against
        let a = Mac("A", body: base)
        var n = a.note
        n.body = base + "mine"
        n.dirty = true
        n.updatedAt = 200
        a.repo.save(n) // no willEdit: base text unknown
        var r = remote("a", base + "theirs", updated: 300, seq: 2)
        r.device = "B"
        r.remoteHeads = ["B": SyncHead(at: 300, hash: NoteText.hash(base + "theirs"))] // shares nothing known with ours
        #expect(a.e.applyRemote(r) == .adopted)
        #expect(a.copies.count == 1)
    }

    @Test func wireCarriesTheHeadsTiedToTheVersion() {
        var n = Note(id: "a", body: "text", createdAt: 1, updatedAt: 500)
        n.pinned = true
        let heads: SyncHeads = ["A": SyncHead(at: 500, hash: NoteText.hash("text")), "B Mac": SyncHead(at: 420, hash: 7)]
        let obj = wire(NoteWire.encode(n, device: "A", origin: "install-A", heads: heads))
        let back = NoteWire.decode(obj)!
        #expect(back.remoteHeads == heads)
        #expect(back.remoteOrigin == "install-A")
        #expect(NoteWire.decode(wire(NoteWire.encode(n, device: "A", origin: "install-A")))!.remoteOrigin == "install-A") // heads unknown
        #expect(back.meta["base"] == nil) // never stored as meta
        #expect(back.pinned)
        // an older client edits the note and keeps the key: the stale heads are ignored
        var stale = obj
        stale["updated_at"] = 600
        #expect(NoteWire.decode(stale)!.remoteHeads == nil)
        // tombstones and notes whose history is unknown carry none
        n.deleted = true
        #expect((NoteWire.encode(n, device: "A", origin: "install-A", heads: heads)["meta"] as! [String: Any])["base"] == nil)
        #expect(SyncEngine(repo: MemoryRepo()).sentHeads(local("b", "x", updated: 5, dirty: true)) == nil)
    }

    @Test func localPinOrTrashSurvivesTheirTextEdit() {
        // Trashed here (meta only, not yet synced) while the other Mac edited the text
        // from the same version: their text, our trash, and it goes back to the server.
        let a = Mac("A", body: base), b = Mac("B", body: base)
        var n = a.note
        n.meta["trashedAt"] = .number(1234)
        n.updatedAt = Note.nextUpdate(after: n.updatedAt)
        n.dirty = true
        a.repo.save(n)
        b.typeAtCaret(" edited", elsewhere: nil, backspace: false)
        var pb = b.put()!
        pb["seq"] = 2
        #expect(a.e.applyRemote(NoteWire.decode(pb)!) == .merged)
        #expect(a.note.body == base + " edited")
        #expect(a.note.meta["trashedAt"] == .number(1234))
        #expect(a.note.dirty)
    }
}
