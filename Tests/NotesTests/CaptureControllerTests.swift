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

    private static let thoughts = "# Thoughts\n\n### 2026-10-26 14:05 · A\none\n\n### 2026-10-26 14:06 · B\ntwo\n"

    private func deco(_ w: NotesWindowController, _ loc: Int) -> BlockDecoration? {
        w.textView.textStorage?.attribute(.notesBlock, at: loc, effectiveRange: nil) as? BlockDecoration
    }

    @Test func returnOnACollapsedThoughtAddsALineAfterItAndUndoes() throws {
        try withController { c, _ in
            let body = Self.thoughts
            let note = Note(body: body)
            c.store.save(note)
            c.open(note.id)
            let w = try #require(c.debugWindow)
            let ns = body as NSString
            let a = ns.range(of: "### 2026-10-26 14:05").location, b = ns.range(of: "### 2026-10-26 14:06").location
            let aEnd = NSMaxRange(ns.range(of: "### 2026-10-26 14:05 · A"))
            #expect(deco(w, a)?.collapsed == true && deco(w, b)?.collapsed == true)
            w.textView.setSelectedRange(NSRange(location: aEnd, length: 0))
            #expect(w.textView(w.textView, doCommandBy: #selector(NSResponder.insertNewline(_:))))
            #expect(w.selectedRange == NSRange(location: b, length: 0))
            w.textView.insertText("hello", replacementRange: NSRange(location: NSNotFound, length: 0))
            #expect(w.currentText == body.replacingOccurrences(of: "one\n\n", with: "one\n\nhello\n"))
            #expect(deco(w, a)?.collapsed == true)
            #expect(deco(w, ns.range(of: "one").location)?.kind == .folded)
            #expect(deco(w, b)?.kind == .paragraph(empty: false))
            // backspace at the start of the new line joins it onto the heading
            w.textView.setSelectedRange(NSRange(location: b, length: 0))
            #expect(w.textView(w.textView, doCommandBy: #selector(NSResponder.deleteBackward(_:))))
            #expect(w.currentText == body.replacingOccurrences(of: "· A\n", with: "· Ahello\n"))
            #expect(deco(w, a)?.collapsed == true)
            // undo goes back step by step; the section stays collapsed throughout
            let um = try #require(w.textView.undoManager)
            um.undo()
            #expect(deco(w, a)?.collapsed == true && deco(w, ns.range(of: "one").location)?.kind == .folded)
            while um.canUndo { um.undo() }
            #expect(w.currentText == body)
            #expect(deco(w, a)?.collapsed == true && deco(w, b)?.collapsed == true)
            um.redo()
            #expect(deco(w, a)?.collapsed == true)
        }
    }

    @Test func backspaceAndDeleteNeverMergeStackedThoughtHeadings() throws {
        try withController { c, _ in
            let body = Self.thoughts
            let note = Note(body: body)
            c.store.save(note)
            c.open(note.id)
            let w = try #require(c.debugWindow)
            let ns = body as NSString
            let a = ns.range(of: "### 2026-10-26 14:05").location, b = ns.range(of: "### 2026-10-26 14:06").location
            let aEnd = NSMaxRange(ns.range(of: "### 2026-10-26 14:05 · A"))
            // backspace at the start of B's text (the caret sits after the hidden "### ")
            w.textView.setSelectedRange(NSRange(location: b + 4, length: 0))
            #expect(w.textView(w.textView, doCommandBy: #selector(NSResponder.deleteBackward(_:))))
            #expect(w.currentText == body)
            #expect(w.selectedRange == NSRange(location: b + 4, length: 0))
            // forward delete at the end of A
            w.textView.setSelectedRange(NSRange(location: aEnd, length: 0))
            #expect(w.textView(w.textView, doCommandBy: #selector(NSResponder.deleteForward(_:))))
            #expect(w.currentText == body)
            #expect(deco(w, a)?.collapsed == true && deco(w, b)?.collapsed == true)
        }
    }

    @Test func hiddenTextCantBeEditedPiecemeal() throws {
        try withController { c, _ in
            let body = Self.thoughts
            let note = Note(body: body)
            c.store.save(note)
            c.open(note.id)
            let w = try #require(c.debugWindow)
            let ns = body as NSString
            let one = ns.range(of: "one").location, a = ns.range(of: "### 2026-10-26 14:05").location
            let b = ns.range(of: "### 2026-10-26 14:06").location
            #expect(!w.textView(w.textView, shouldChangeTextInRanges: [NSValue(range: NSRange(location: one, length: 0))], replacementStrings: ["x"]))
            #expect(!w.textView(w.textView, shouldChangeTextInRanges: [NSValue(range: NSRange(location: one - 3, length: 4))], replacementStrings: [""]))
            #expect(w.textView(w.textView, shouldChangeTextInRanges: [NSValue(range: NSRange(location: a, length: b - a))], replacementStrings: [""]))
            #expect(w.textView(w.textView, shouldChangeTextInRanges: [NSValue(range: NSRange(location: a + 5, length: 2))], replacementStrings: ["x"]))
            // ⌥⌫ at the start of the line after a collapsed section would eat hidden text
            w.textView.setSelectedRange(NSRange(location: ns.length, length: 0))
            w.textView.deleteWordBackward(nil)
            #expect(w.currentText == body)
        }
    }

    @Test func chevronClickTogglesWithoutMovingTheSelection() throws {
        try withController { c, _ in
            let body = "# Title\nintro\n## Section\nbody line\n## Last\nend"
            let note = Note(body: body)
            c.store.save(note)
            c.open(note.id)
            let w = try #require(c.debugWindow)
            let tv = w.textView
            let ns = body as NSString
            let section = ns.range(of: "## Section").location, last = ns.range(of: "## Last").location
            tv.setSelectedRange(NSRange(location: 3, length: 2))
            func click(_ lineStart: Int) throws -> NSEvent {
                let lm = try #require(tv.notesLayoutManager)
                lm.ensureLayout(for: try #require(tv.textContainer))
                let r = try #require(lm.chevronRect(paragraphStart: lineStart))
                let p = tv.convert(NSPoint(x: r.midX + tv.textContainerOrigin.x, y: r.midY + tv.textContainerOrigin.y), to: nil)
                return try #require(NSEvent.mouseEvent(with: .leftMouseDown, location: p, modifierFlags: [], timestamp: 0,
                                                       windowNumber: tv.window?.windowNumber ?? 0, context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
            }
            for start in [0, section, last] {
                let e = try click(start)
                #expect(tv.acceptsFirstMouse(for: e))  // works on the first click into a window that isn't key
                tv.mouseDown(with: e)
                #expect(deco(w, start)?.collapsed == true, "\(start)")
                #expect(tv.selectedRange() == NSRange(location: 3, length: 2) || start == 0)
                tv.mouseDown(with: try click(start))
                #expect(deco(w, start)?.collapsed == false)
            }
            // the text itself isn't a chevron
            let lm = try #require(tv.notesLayoutManager)
            let r = try #require(lm.chevronRect(paragraphStart: section))
            #expect(tv.foldChevron(at: NSPoint(x: r.midX + tv.textContainerOrigin.x, y: r.midY + tv.textContainerOrigin.y)) == section)
            #expect(tv.foldChevron(at: NSPoint(x: tv.textContainerOrigin.x + 30, y: r.midY + tv.textContainerOrigin.y)) == nil)
            #expect(tv.headingLine(at: NSPoint(x: tv.textContainerOrigin.x + 30, y: r.midY + tv.textContainerOrigin.y)) == section)
            #expect(w.currentText == body)
        }
    }

    @Test func shiftRightAtTheEndOfACollapsedHeadingThenTypingKeepsTheSection() throws {
        try withController { c, _ in
            let body = Self.thoughts
            let note = Note(body: body)
            c.store.save(note)
            c.open(note.id)
            let w = try #require(c.debugWindow)
            let ns = body as NSString
            let a = ns.range(of: "### 2026-10-26 14:05").location
            let aEnd = NSMaxRange(ns.range(of: "### 2026-10-26 14:05 · A"))
            w.textView.setSelectedRange(NSRange(location: aEnd, length: 0))
            w.textView.moveRightAndModifySelection(nil)
            #expect(w.selectedRange == NSRange(location: aEnd, length: 0))
            w.textView.insertText("x", replacementRange: NSRange(location: NSNotFound, length: 0))
            #expect(w.currentText == body.replacingOccurrences(of: "· A\n", with: "· Ax\n"))
            #expect(deco(w, a)?.collapsed == true)
        }
    }

    @Test func replaceAllOpensSectionsWithMatchesAndUndoKeepsTheOthers() throws {
        try withController { c, _ in
            let body = Self.thoughts
            let note = Note(body: body)
            c.store.save(note)
            c.open(note.id)
            let w = try #require(c.debugWindow)
            let tv = w.textView
            let ns = body as NSString
            let one = ns.range(of: "one"), title = ns.range(of: "Thoughts")
            // what the find bar's Replace All does: one change of several ranges
            #expect(tv.shouldChangeText(inRanges: [NSValue(range: title), NSValue(range: one)], replacementStrings: ["Notes", "1"]))
            let ts = try #require(tv.textStorage)
            ts.beginEditing()
            ts.replaceCharacters(in: one, with: "1")
            ts.replaceCharacters(in: title, with: "Notes")
            ts.endEditing()
            tv.didChangeText()
            let changed = body.replacingOccurrences(of: "one", with: "1").replacingOccurrences(of: "Thoughts", with: "Notes")
            #expect(w.currentText == changed)
            let t = changed as NSString
            #expect(deco(w, t.range(of: "### 2026-10-26 14:05").location)?.collapsed == false)  // opened for its match
            #expect(deco(w, t.range(of: "### 2026-10-26 14:06").location)?.collapsed == true)
            #expect(deco(w, t.range(of: "two").location)?.kind == .folded)
            let um = try #require(tv.undoManager)
            um.undo()
            #expect(w.currentText == body)
            let b = ns.range(of: "### 2026-10-26 14:06").location
            #expect(deco(w, b)?.collapsed == true && deco(w, ns.range(of: "two").location)?.kind == .folded)
            #expect(!w.styler.folds.isOpened(b))
        }
    }

    @Test func undoingACommandAroundACollapsedSectionKeepsItCollapsed() throws {
        try withController { c, _ in
            let body = "- [ ] t1\n## S\nhidden\n# End\n- [ ] t2"
            let note = Note(body: body)
            c.store.save(note)
            c.open(note.id)
            let w = try #require(c.debugWindow)
            let ns = body as NSString
            let s = ns.range(of: "## S").location, hidden = ns.range(of: "hidden").location
            #expect(w.toggleHeading(at: s))
            w.textView.setSelectedRange(NSRange(location: 0, length: ns.length))
            w.runFormatting(.toggleTask)
            #expect(w.currentText == body.replacingOccurrences(of: "[ ]", with: "[x]"))
            #expect(deco(w, s)?.collapsed == true && deco(w, hidden)?.kind == .folded)
            let um = try #require(w.textView.undoManager)
            um.undo()
            #expect(w.currentText == body)
            #expect(deco(w, s)?.collapsed == true && deco(w, hidden)?.kind == .folded)
            #expect(!w.styler.folds.isOpened(s))
            um.redo()
            #expect(w.currentText == body.replacingOccurrences(of: "[ ]", with: "[x]"))
            #expect(deco(w, s)?.collapsed == true && deco(w, hidden)?.kind == .folded)
        }
    }

    @Test func moveLineDownPastACollapsedHeading() throws {
        try withController { c, _ in
            let body = "above\n## S\nhidden\n# E"
            let note = Note(body: body)
            c.store.save(note)
            c.open(note.id)
            let w = try #require(c.debugWindow)
            #expect(w.toggleHeading(at: 6))
            w.textView.setSelectedRange(NSRange(location: 2, length: 0))
            w.runFormatting(.moveDown)
            #expect(w.currentText == "## S\nabove\nhidden\n# E")
            #expect(deco(w, 0)?.collapsed == true && deco(w, 11)?.kind == .folded)
            #expect(w.selectedRange == NSRange(location: 7, length: 0))
        }
    }

    @Test func foldsSurviveSyncCapturesAndSwitchingNotes() throws {
        try withController { c, _ in
            let body = Self.thoughts
            let note = Note(body: body)
            let other = Note(body: "# Other")
            c.store.save(note)
            c.store.save(other)
            c.updateSettings { $0.captureNoteID = note.id }
            c.open(note.id)
            let w = try #require(c.debugWindow)
            let ns = body as NSString
            let a = ns.range(of: "### 2026-10-26 14:05").location, b = ns.range(of: "### 2026-10-26 14:06").location
            #expect(w.toggleHeading(at: b))  // open B
            w.textView.setSelectedRange(NSRange(location: 2, length: 0))
            // a capture and a remote edit above
            #expect(c.capture("Captured while open") == "Thoughts")
            w.applyExternalBody("Remote line\n" + w.currentText)
            let t = w.currentText as NSString
            #expect(deco(w, a + 12)?.collapsed == true)
            #expect(deco(w, b + 12)?.collapsed == false)
            let captured = t.range(of: "\nCaptured while open").location + 1
            #expect(deco(w, captured)?.kind == .folded)
            #expect(w.selectedRange == NSRange(location: 14, length: 0))
            // another note and back
            c.open(other.id)
            c.open(note.id)
            #expect(deco(w, a + 12)?.collapsed == true)
            #expect(deco(w, b + 12)?.collapsed == false)
            #expect(deco(w, captured)?.kind == .folded)
        }
    }
}
