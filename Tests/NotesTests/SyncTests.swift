import Foundation
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
