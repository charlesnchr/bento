import AppKit
import Testing
@testable import BentoCore
@testable import Notes

/// The editor keeps the scroll view's width, so long lines wrap inside the window with the
/// inset on both sides instead of running past the right edge.
@MainActor
@Suite(.serialized) struct EditorLayoutTests {
    private func withWindow(_ body: String, _ run: @MainActor (NotesWindowController) throws -> Void) throws {
        _ = NSApplication.shared
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("bento-layout-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let c = NotesController(store: NoteStore(url: home.appendingPathComponent("notes.sqlite")),
                                config: ConfigStore(url: home.appendingPathComponent("config.json")))
        c.updateSettings { $0 = NotesSettings() }
        c.createNote(body: body)
        let w = try #require(c.debugWindow)
        w.show(focus: false)
        try run(w)
        c.flushPendingSave()
        w.hide()
    }

    private func resize(_ w: NotesWindowController, width: CGFloat) {
        var f = w.panel.frame
        f.size.width = width
        w.panel.setFrame(f, display: true)
        w.panel.contentView?.layoutSubtreeIfNeeded()
    }

    /// Same width as the visible area, the configured insets, and the long line wrapped
    /// within it.
    private func expectFits(_ w: NotesWindowController, lines: Int = 2) throws {
        let tv = w.textView
        let clip = try #require(tv.enclosingScrollView?.contentView)
        let tc = try #require(tv.textContainer)
        let lm = try #require(tv.layoutManager)
        #expect(tv.frame.width == clip.bounds.width)
        #expect(tv.textContainerInset == NSSize(width: 24, height: 6))
        #expect(tc.widthTracksTextView && tc.lineFragmentPadding == 0)
        #expect(tc.size.width == clip.bounds.width - 48)
        lm.ensureLayout(for: tc)
        var fragments = 0
        var maxX: CGFloat = 0
        lm.enumerateLineFragments(forGlyphRange: NSRange(location: 0, length: lm.numberOfGlyphs)) { _, used, _, _, _ in
            fragments += 1
            maxX = max(maxX, used.maxX)
        }
        #expect(fragments > lines) // the bullet wrapped
        #expect(maxX <= clip.bounds.width - 48 + 0.5) // nothing past the right inset
    }

    @Test func longLinesWrapInsideTheWindow() throws {
        let body = "chat with max\n- 3 qs: is research interesting, what do you want for career profile, is there value "
            + String(repeating: "in a longer line ", count: 12)
        try withWindow(body) { w in
            for width: CGFloat in [492, 700, 400, 492] {
                resize(w, width: width)
                try expectFits(w)
            }
        }
    }

    /// Whatever resizes the text view (autoresizing that kept a difference from before the
    /// window was laid out, as on macOS 15), it stays as wide as the visible area.
    @Test func theTextViewKeepsTheVisibleWidth() throws {
        let body = "title\n- " + String(repeating: "word ", count: 60)
        try withWindow(body) { w in
            resize(w, width: 492)
            let tv = w.textView
            tv.setFrameSize(NSSize(width: tv.frame.width + 300, height: tv.frame.height))
            try expectFits(w)
            resize(w, width: 600)
            try expectFits(w)
        }
    }
}
