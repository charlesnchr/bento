import AppKit
import Testing
@testable import BentoCore
@testable import Notes

/// The open note receiving edits from another Mac: the editor keeps the caret, the
/// scroll position and anything typed but not yet synced.
@MainActor
@Suite(.serialized) struct LiveSyncEditorTests {
    private func withNote(_ body: String, _ run: @MainActor (NotesController, NotesWindowController, String) throws -> Void) throws {
        _ = NSApplication.shared
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("bento-livesync-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let c = NotesController(store: NoteStore(url: home.appendingPathComponent("notes.sqlite")),
                                config: ConfigStore(url: home.appendingPathComponent("config.json")))
        c.updateSettings { $0 = NotesSettings() }
        var n = Note(body: body, createdAt: 1, updatedAt: 100)
        n.seq = 1
        n.baseHash = NoteText.hash(body)
        c.store.save(n)
        c.open(n.id)
        let w = try #require(c.debugWindow)
        try run(c, w, n.id)
        c.flushPendingSave()
        w.hide()
    }

    /// Another Mac's version made from `base`.
    private func theirs(_ id: String, _ body: String, from base: String, seq: Int64 = 2) -> Note {
        var r = remote(id, body, updated: Note.now() + 1000, seq: seq)
        r.device = "Other Mac"
        r.remoteBases = [NoteText.hash(base)]
        return r
    }

    private func caret(_ w: NotesWindowController) -> Int { w.selectedRange.location }

    @Test func typingDuringARemoteEditKeepsBothAndTheCaret() throws {
        let base = "# Note\nfirst\n\nlast"
        try withNote(base) { c, w, id in
            w.textView.setSelectedRange(NSRange(location: (base as NSString).length, length: 0))
            w.textView.insertText(" mine", replacementRange: NSRange(location: NSNotFound, length: 0)) // not saved yet
            c.engine.applyRemote(theirs(id, "# Note\nNEW first\n\nlast", from: base))
            #expect(w.currentText == "# Note\nNEW first\n\nlast mine")
            #expect(caret(w) == (w.currentText as NSString).length) // still right after what was typed
            let stored = try #require(c.store.note(id))
            #expect(stored.body == w.currentText)
            #expect(stored.dirty) // the merge goes back to the server
            #expect(c.store.liveNotes.count == 1) // no conflicted copy
        }
    }

    @Test func caretAndSelectionMoveWithTheirText() throws {
        let base = "alpha\nbeta\ngamma"
        try withNote(base) { c, w, id in
            w.textView.setSelectedRange(NSRange(location: 6, length: 4)) // "beta"
            c.engine.applyRemote(theirs(id, "zero\nalpha\nbeta\ngamma delta", from: base))
            #expect((w.currentText as NSString).substring(with: w.selectedRange) == "beta")
            w.textView.setSelectedRange(NSRange(location: 7, length: 0)) // "zero\nal|pha"
            c.engine.applyRemote(theirs(id, "alpha\nbeta\ngamma", from: "zero\nalpha\nbeta\ngamma delta", seq: 3))
            #expect(caret(w) == 2) // the line above it went, the text after it doesn't matter
            #expect(w.currentText == "alpha\nbeta\ngamma")
        }
    }

    @Test func textAddedAboveTheViewDoesntScrollIt() throws {
        let lines = (0..<200).map { "line \($0)" }
        let base = lines.joined(separator: "\n")
        try withNote(base) { c, w, id in
            w.show(focus: false)
            let tv = w.textView
            let clip = try #require(tv.enclosingScrollView?.contentView)
            tv.layoutManager?.ensureLayout(for: tv.textContainer!)
            let target = tv.layoutManager!.boundingRect(forGlyphRange: NSRange(location: (base as NSString).range(of: "line 150").location, length: 1),
                                                        in: tv.textContainer!)
            tv.scroll(NSPoint(x: 0, y: target.minY + tv.textContainerOrigin.y))
            func topLine() -> String {
                let y = clip.bounds.minY - tv.textContainerOrigin.y + 1
                let i = tv.layoutManager!.characterIndex(for: NSPoint(x: 1, y: y), in: tv.textContainer!, fractionOfDistanceBetweenInsertionPoints: nil)
                let s = tv.string as NSString
                return s.substring(with: s.lineRange(for: NSRange(location: i, length: 0))).trimmingCharacters(in: .newlines)
            }
            let before = topLine()
            #expect(before.hasPrefix("line 1"))
            let added = (0..<30).map { "new \($0)" }.joined(separator: "\n") + "\n"
            c.engine.applyRemote(theirs(id, added + base, from: base))
            #expect(tv.string == added + base)
            #expect(topLine() == before)
        }
    }
}
