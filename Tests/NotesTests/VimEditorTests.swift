import AppKit
import Testing
@testable import BentoCore
@testable import Notes

/// Vim mode in the real editor: hidden markdown markers, list continuation, collapsed
/// sections, undo, the mode badge and the toggle.
@MainActor
@Suite(.serialized) struct VimEditorTests {
    private func withNote(_ body: String, caret: Int = 0, _ run: @MainActor (NotesController, NotesWindowController) throws -> Void) throws {
        _ = NSApplication.shared
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("bento-vim-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let c = NotesController(store: NoteStore(url: home.appendingPathComponent("notes.sqlite")),
                                config: ConfigStore(url: home.appendingPathComponent("config.json")))
        c.updateSettings { $0 = NotesSettings() }
        let n = Note(body: body)
        c.store.save(n)
        c.open(n.id, selection: NSRange(location: caret, length: 0))
        let w = try #require(c.debugWindow)
        c.updateSettings { $0.vimMode = true }
        try run(c, w)
        c.flushPendingSave()
        w.hide()
    }

    private func caret(_ w: NotesWindowController) -> Int { w.selectedRange.location }

    @Test func turningItOnShowsNormalMode() throws {
        try withNote("abc", caret: 3) { c, w in
            #expect(w.textView.vim != nil)
            #expect(w.debugVimBadge == "NORMAL")
            #expect(caret(w) == 2) // on the last character, not after it
            #expect(w.textView.vimCursorRect() != nil)
            w.textView.vimFeed("i")
            #expect(w.debugVimBadge == "INSERT")
            #expect(w.textView.vimCursorRect() == nil)
            w.textView.vimFeed("<Esc>d")
            #expect(w.debugVimBadge == "NORMAL  d")
            w.textView.vimFeed("<Esc>")
            c.perform(.toggleVim)
            #expect(!c.settings.vimMode)
            #expect(w.textView.vim == nil)
            #expect(w.debugVimBadge == nil)
        }
    }

    @Test func hiddenMarkersStayOutOfTheWay() throws {
        try withNote("# Title\n- item\nplain") { _, w in
            #expect(caret(w) == 2) // after the heading's hidden "# "
            w.textView.vimFeed("0x")
            #expect(w.currentText == "# itle\n- item\nplain")
            w.textView.vimFeed("jccnew<Esc>")
            #expect(w.currentText == "# itle\n- new\nplain") // the bullet stays
            w.textView.vimFeed("onext<Esc>")
            #expect(w.currentText == "# itle\n- new\n- next\nplain") // o continues the list
            w.textView.vimFeed("J")
            #expect(w.currentText == "# itle\n- new\n- next plain")
            w.textView.vimFeed("ggjwb")
            #expect(caret(w) == (w.currentText as NSString).range(of: "new").location)
        }
    }

    /// Keys one event at a time, so the editor's undo groups close between them as when typing.
    private func type(_ w: NotesWindowController, _ keys: [String]) {
        for k in keys {
            w.textView.vimFeed(k)
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
        }
    }

    @Test func aChangeAndWhatWasTypedUndoTogether() throws {
        try withNote("one two") { _, w in
            type(w, ["c", "i", "w", "X", "Y", "<Esc>"])
            #expect(w.currentText == "XY two")
            type(w, ["u"])
            #expect(w.currentText == "one two")
            type(w, ["<C-r>"])
            #expect(w.currentText == "XY two")
            type(w, ["o", "a", "<CR>", "b", "<Esc>", "u"])
            #expect(w.currentText == "XY two")
        }
    }

    @Test func undoingASessionKeepsSectionsCollapsed() throws {
        let body = "top\n# Fold\nhidden\n# End\nbottom"
        try withNote(body) { _, w in
            let fold = (body as NSString).range(of: "# Fold").location
            #expect(w.toggleHeading(at: fold))
            type(w, ["i", "x"])
            w.textView.setSelectedRange(NSRange(location: (w.currentText as NSString).length, length: 0)) // a click at the end
            type(w, ["y", "<Esc>"])
            #expect(w.currentText == "x" + body + "y")
            type(w, ["u"])
            #expect(w.currentText == body)
            #expect(w.styler.folds.isCollapsed(fold))
            type(w, ["<C-r>"])
            #expect(w.currentText == "x" + body + "y")
            #expect(w.styler.folds.isCollapsed(fold + 1))
        }
    }

    @Test func anInsertSessionEndsAtTheNote() throws {
        try withNote("same") { c, w in
            let a = try #require(w.noteID)
            let b = c.createNote(body: "same")
            type(w, ["A", "B", "<Esc>"])
            #expect(w.currentText == "sameB")
            c.open(a)
            type(w, ["i", "X"])
            c.open(b.id)
            type(w, ["Y", "<Esc>"])
            #expect(w.currentText != "sameB")
            type(w, ["u"])
            #expect(w.currentText == "sameB") // only what was typed here
        }
        // the note left in insert mode keeps its change and typing as one step
        try withNote("one two") { c, w in
            let a = try #require(w.noteID)
            type(w, ["c", "i", "w", "X", "Y"])
            let z = c.createNote(body: "zeta")
            #expect(w.currentText == "zeta")
            c.flushPendingSave()
            #expect(c.store.note(z.id)?.body == "zeta") // the session's edit is saved to the note it was in
            #expect(c.store.note(a)?.body == "XY two")
            c.open(a)
            type(w, ["<Esc>"])
            #expect(w.currentText == "XY two")
            type(w, ["u"])
            #expect(w.currentText == "one two")
        }
    }

    @Test func aLongListTypedInOneGoUndoesAsOne() throws {
        try withNote("- a") { _, w in
            var keys = ["A"]
            for i in 0..<25 { keys += ["<CR>", "x", String(i % 10)] }
            type(w, keys + ["<Esc>"])
            #expect(w.currentText.components(separatedBy: "\n").count == 26)
            type(w, ["u"])
            #expect(w.currentText == "- a")
            type(w, ["<C-r>"])
            #expect(w.currentText.components(separatedBy: "\n").count == 26)
        }
    }

    @Test func undoStepsAreTheEditorsOwn() throws {
        // per note: each note's history keeps its own change as one step
        try withNote("one") { c, w in
            let a = try #require(w.noteID)
            type(w, ["c", "i", "w", "A", "A", "<Esc>"])
            let b = c.createNote(body: "two")
            #expect(w.noteID == b.id)
            type(w, ["c", "i", "w", "B", "B", "<Esc>"])
            c.open(a)
            type(w, ["u"])
            #expect(w.currentText == "one")
        }
        // a formatting command in between is one more step
        try withNote("one") { _, w in
            type(w, ["c", "i", "w", "A", "A", "<Esc>"])
            w.runFormatting(.heading1)
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
            #expect(w.currentText == "# AA")
            type(w, ["u", "u"])
            #expect(w.currentText == "one")
        }
        // ⌘Z and u walk the same history
        try withNote("one two") { _, w in
            type(w, ["c", "i", "w", "A", "<Esc>", "w", "c", "i", "w", "B", "<Esc>"])
            #expect(w.currentText == "A B")
            w.textView.undoManager?.undo()
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
            #expect(w.currentText == "A two")
            type(w, ["u"])
            #expect(w.currentText == "one two")
            type(w, ["<C-r>", "<C-r>"])
            #expect(w.currentText == "A B")
        }
    }

    private func event(_ chars: String, _ code: Int, _ mods: NSEvent.ModifierFlags = [], ignoring: String? = nil) -> NSEvent {
        NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: mods, timestamp: 0, windowNumber: 0, context: nil,
                         characters: chars, charactersIgnoringModifiers: ignoring ?? chars, isARepeat: false, keyCode: UInt16(code))!
    }

    @Test func keysFromEvents() {
        #expect(NoteTextView.vimKey(event("\u{1b}", 53)) == VimKey(.escape))
        #expect(NoteTextView.vimKey(event("\u{4}", 2, .control, ignoring: "d")) == VimKey("d", ctrl: true))
        #expect(NoteTextView.vimKey(event("[", 28, .option, ignoring: "8")) == VimKey("[")) // ⌥8 on Nordic layouts
        #expect(NoteTextView.vimKey(event("$", 21, .shift, ignoring: "4")) == VimKey("$"))
        #expect(NoteTextView.vimKey(event("\u{F701}", 125)) == VimKey(.down))
        #expect(NoteTextView.vimKey(event("v", 9, .command)) == nil)
        #expect(NoteTextView.vimKey(event("\u{F72D}", 121)) == nil) // Page Down keeps its own meaning
    }

    @Test func keyDownRouting() throws {
        try withNote("abc") { _, w in
            let tv = w.textView
            let vim = try #require(tv.vim)
            #expect(tv.vimKeyDown(event("x", 7), vim))
            #expect(w.currentText == "bc")
            #expect(!tv.vimKeyDown(event("v", 9, .command), vim))
            #expect(!tv.vimKeyDown(event("\u{F72D}", 121), vim))
            tv.vimFeed("i")
            tv.vimEscapeBlocked = { true } // the inline menu is open: Escape is its
            #expect(!tv.vimKeyDown(event("\u{1b}", 53), vim))
            #expect(vim.mode == .insert)
            #expect(!tv.vimKeyDown(event("q", 12), vim)) // typing goes to the text view
            tv.vimEscapeBlocked = { false }
            #expect(tv.vimKeyDown(event("\u{1b}", 53), vim))
            #expect(vim.mode == .normal)
        }
    }

    @Test func wordObjectsLeaveAnEmptyItemsMarker() throws {
        try withNote("- ") { _, w in
            w.textView.vimFeed("diw")
            #expect(w.currentText == "- ")
            w.textView.vimFeed("ciwX<Esc>")
            #expect(w.currentText == "- ")
        }
    }

    @Test func collapsedSectionsActLikeClosedFolds() throws {
        let body = "# A\na1\na2\n# B\nb1"
        try withNote(body) { _, w in
            w.textView.vimFeed("za")
            #expect(w.styler.folds.isCollapsed(0))
            w.textView.vimFeed("j")
            #expect(caret(w) == (body as NSString).range(of: "B").location)
            w.textView.vimFeed("kdd")
            #expect(w.currentText == "# B\nb1")
            w.textView.vimFeed("u")
            #expect(w.currentText == body)
            w.textView.vimFeed("<C-r>")
            #expect(w.currentText == "# B\nb1")
        }
    }

    @Test func insertModeTypesThroughTheEditor() throws {
        try withNote("") { _, w in
            w.textView.vimFeed("i- one<CR>two<Esc>")
            #expect(w.currentText == "- one\n- two") // markdown input rules and list continuation
            w.textView.vimFeed("uu")
            #expect(w.currentText.isEmpty)
        }
    }

    @Test func mouseSelectionsAreVisualMode() throws {
        try withNote("hello world") { _, w in
            w.textView.setSelectedRange(NSRange(location: 6, length: 5))
            #expect(w.debugVimBadge == "VISUAL")
            w.textView.vimFeed("U")
            #expect(w.currentText == "hello WORLD")
            #expect(w.debugVimBadge == "NORMAL")
        }
    }

    @Test func surroundAndRegistersAcrossNotes() throws {
        try withNote("say hi") { c, w in
            w.textView.vimFeed("wysiw*")
            #expect(w.currentText == "say *hi*")
            w.textView.vimFeed("\"ayy")
            let other = c.createNote(body: "")
            #expect(w.noteID == other.id)
            w.textView.vimFeed("\"aP")
            #expect(w.currentText == "say *hi*\n")
        }
    }
}
