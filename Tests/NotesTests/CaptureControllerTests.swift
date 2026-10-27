import AppKit
import Testing
@testable import BentoCore
@testable import Notes

@MainActor
@Suite(.serialized) struct CaptureControllerTests {
    private func withController(_ run: (NotesController, URL) throws -> Void) throws {
        _ = NSApplication.shared
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("bento-capture-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let url = home.appendingPathComponent("notes.sqlite")
        let config = ConfigStore(url: home.appendingPathComponent("config.json"))
        let controller = NotesController(store: NoteStore(url: url), config: config)
        controller.updateSettings { $0 = NotesSettings() }
        try run(controller, url)
        controller.flushPendingSave()
    }

    @Test func captureSavesWithoutCreatingAWindow() throws {
        try withController { c, url in
            #expect(c.capture("First thought") == "Thoughts")
            #expect(c.debugWindow == nil)
            let id = c.settings.captureNoteID
            #expect(!id.isEmpty)
            let note = try #require(NoteStore(url: url).note(id))
            #expect(note.body.hasPrefix("# Thoughts\n\n### "))
            #expect(note.body.hasSuffix("\nFirst thought\n"))
            #expect(note.dirty)
            #expect(c.capture("Second thought") == "Thoughts")
            #expect(c.store.liveNotes.count == 1)
        }
    }

    @Test func captureKeepsPendingEditorTextAndLaterEdits() throws {
        try withController { c, url in
            let note = Note(body: "# Note\nold")
            c.store.save(note)
            c.updateSettings { $0.captureNoteID = note.id }
            c.open(note.id)
            let w = try #require(c.debugWindow)
            w.textView.insertText(" unsaved", replacementRange: NSRange(location: NSNotFound, length: 0))
            #expect(c.store.note(note.id)?.body == note.body)
            let typed = w.currentText
            #expect(typed == "# Note\nold unsaved")
            #expect(c.capture("Captured thought") == "Note")
            let captured = w.currentText
            #expect(captured.hasPrefix(typed + "\n\n### "))
            #expect(captured.hasSuffix("\nCaptured thought\n"))
            w.textView.insertText(" later", replacementRange: NSRange(location: NSNotFound, length: 0))
            c.flushPendingSave()
            let saved = try #require(NoteStore(url: url).note(note.id))
            #expect(saved.body.contains("old unsaved later"))
            #expect(saved.body.hasSuffix("\nCaptured thought\n"))
            w.hide()
            #expect(c.capture("With the window closed") == "Note")
            c.open(note.id)
            #expect(w.currentText == NoteStore(url: url).note(note.id)?.body)
            #expect(w.currentText.contains("\nCaptured thought\n"))
            #expect(w.currentText.hasSuffix("\nWith the window closed\n"))
        }
    }

    @Test func deletedAndTrashedTargetsAreNotResurrected() throws {
        try withController { c, _ in
            for deleted in [false, true] {
                var note = Note(body: "# Deleted")
                if deleted { note.deleted = true; note.body = "" } else { note.trashedAt = Note.now() }
                c.store.save(note)
                c.updateSettings { $0.captureNoteID = note.id }
                #expect(c.capture("Keep this") == "Thoughts")
                #expect(c.settings.captureNoteID != note.id)
                #expect(c.store.note(note.id) == note)
            }
        }
    }

    @Test func syncKeepsCapturesAndPendingTextWhenTheRemoteBodyWins() throws {
        try withController { c, _ in
            var note = Note(body: "# Note\nbase")
            note.seq = 1
            note.baseHash = NoteText.hash(note.body)
            c.store.save(note)
            c.updateSettings { $0.captureNoteID = note.id }
            c.open(note.id)
            let w = try #require(c.debugWindow)
            w.textView.insertText(" pending", replacementRange: NSRange(location: NSNotFound, length: 0))
            #expect(c.capture("A captured thought") == "Note")
            var remote = note
            remote.body = "# Note\nremote"
            remote.device = "other"
            remote.seq = 2
            remote.updatedAt = Note.nextUpdate(after: c.store.note(note.id)!.updatedAt)
            #expect(c.engine.applyRemote(remote) == .adopted)
            let copy = try #require(c.store.liveNotes.first { $0.id != note.id })
            #expect(copy.body.contains("base pending"))
            #expect(copy.body.hasSuffix("\nA captured thought\n"))
            #expect(w.currentText == remote.body)
            #expect(c.capture("After sync") == "Note")
            #expect(c.store.note(note.id)?.body.hasPrefix(remote.body + "\n\n") == true)
        }
    }

    @Test func captureUsesTheBodyAndMetadataFromASyncMerge() throws {
        try withController { c, _ in
            var note = Note(body: "# Note\nbase")
            note.seq = 1
            note.baseHash = NoteText.hash(note.body)
            c.store.save(note)
            c.updateSettings { $0.captureNoteID = note.id }
            c.open(note.id)
            let w = try #require(c.debugWindow)
            w.textView.insertText(" pending", replacementRange: NSRange(location: NSNotFound, length: 0))
            var remote = note
            remote.pinned = true
            remote.device = "other"
            remote.seq = 2
            remote.updatedAt = Note.now() + 60_000
            #expect(c.engine.applyRemote(remote) == .merged)
            #expect(c.capture("After the merge") == "Note")
            let saved = try #require(c.store.note(note.id))
            #expect(saved.pinned && saved.seq == 2 && saved.dirty)
            #expect(saved.body.hasPrefix("# Note\nbase pending\n\n"))
            #expect(saved.body.hasSuffix("\nAfter the merge\n"))
            #expect(w.currentText == saved.body)
        }
    }

    @Test func failedCaptureDoesNotClaimSuccessOrChangeTheTarget() throws {
        try withController { c, url in
            let note = Note(body: "# Note\nkeep")
            c.store.save(note)
            c.updateSettings { $0.captureNoteID = note.id }
            let db = try SQLiteDB(path: url.path)
            try db.exec("DROP TABLE notes")
            #expect(c.capture("Cannot save") == nil)
            #expect(c.store.note(note.id) == note)
            #expect(c.settings.captureNoteID == note.id)
            #expect(c.store.liveNotes.count == 1)
            let memory = NotesController(store: NoteStore(url: nil), config: ConfigStore(url: url.appendingPathExtension("json")))
            #expect(memory.capture("Cannot persist") == nil)
            #expect(memory.store.liveNotes.isEmpty)
        }
    }

    @Test func caretSkipsFoldedTextAndTheNextHeadingPrefix() throws {
        try withController { c, _ in
            for newline in ["\n", "\r\n"] {
                let body = ["### 2026-10-26 14:05 · A", "one", "### 2026-10-26 14:06 · B", "two", "# After"].joined(separator: newline)
                let note = Note(body: body)
                c.store.save(note)
                c.open(note.id)
                let w = try #require(c.debugWindow)
                let text = body as NSString
                let headingEnd = NSMaxRange(text.range(of: "### 2026-10-26 14:05 · A"))
                let hidden = text.range(of: "one").location
                let second = text.range(of: "### 2026-10-26 14:06").location
                let forward = w.textView(w.textView, willChangeSelectionFromCharacterRange: NSRange(location: headingEnd, length: 0),
                                         toCharacterRange: NSRange(location: hidden, length: 0))
                #expect(forward == NSRange(location: second + 4, length: 0))
                let backward = w.textView(w.textView, willChangeSelectionFromCharacterRange: NSRange(location: second + 4, length: 0),
                                          toCharacterRange: NSRange(location: hidden, length: 0))
                #expect(backward == NSRange(location: headingEnd, length: 0))
                #expect(w.currentText == body)
                #expect(!w.toggleHeading(at: NSNotFound))
                #expect(!w.toggleHeading(at: -1))
            }
        }
    }

    @Test func commandReturnTogglesHeadingsAndTasks() throws {
        try withController { c, _ in
            let body = "- [ ] outside\n## Section\n- [ ] inside\n# After"
            let note = Note(body: body)
            c.store.save(note)
            c.open(note.id)
            let w = try #require(c.debugWindow)
            w.textView.setSelectedRange(NSRange(location: 6, length: 0))
            w.runFormatting(.toggleTask)
            #expect(w.currentText.hasPrefix("- [x] outside"))
            let heading = (w.currentText as NSString).range(of: "## Section").location
            w.textView.setSelectedRange(NSRange(location: heading + 5, length: 0))
            let before = w.currentText
            // collapses the section, then opens it again; the text doesn't change
            w.runFormatting(.toggleTask)
            #expect(w.currentText == before)
            let inside = (w.currentText as NSString).range(of: "inside").location
            #expect((w.textView.textStorage!.attribute(.notesBlock, at: inside, effectiveRange: nil) as? BlockDecoration)?.kind == .folded)
            w.runFormatting(.toggleTask)
            #expect((w.textView.textStorage!.attribute(.notesBlock, at: inside, effectiveRange: nil) as? BlockDecoration)?.kind == .task(level: 0, checked: false))
            w.textView.setSelectedRange(NSRange(location: inside, length: 0))
            w.runFormatting(.toggleTask)
            #expect(w.currentText.contains("- [x] inside"))
        }
    }
}
