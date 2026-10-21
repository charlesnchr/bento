import AppKit
import BentoCore
import Testing
@testable import Notes

/// In-memory repository for engine tests.
final class MemoryRepo: NoteRepository {
    var notes: [String: Note] = [:]
    var lastSeq: Int64 = 0
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

    @Test func isolatedInstancesNeverUseTheLiveServer() {
        #expect(SyncSettings.isBlocked(serverHost: "bento.radian.dk", environment: ["BENTO_HOME": "/tmp/x"]))
        #expect(SyncSettings.isBlocked(serverHost: "BENTO.radian.dk", environment: ["BENTO_HOME": "/tmp/x"]))
        #expect(!SyncSettings.isBlocked(serverHost: "127.0.0.1", environment: ["BENTO_HOME": "/tmp/x"]))
        #expect(!SyncSettings.isBlocked(serverHost: "bento.radian.dk", environment: [:]))
        #expect(!SyncSettings.isBlocked(serverHost: "bento.radian.dk", environment: ["BENTO_HOME": "/tmp/x", "BENTO_ALLOW_LIVE_SYNC": "1"]))
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
        #expect(s2.lastSeq == 42)
        #expect(s2.kvJSON("nav.back", as: [String].self) == ["a", "b"])
        #expect(s2.liveNotes.map(\.id) == ["a"])
        #expect(s2.trashedNotes.map(\.id) == ["t"])
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
