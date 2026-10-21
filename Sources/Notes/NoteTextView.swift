import AppKit

/// The editor: plain-markdown NSTextView (TextKit 1) with markdown input rules,
/// clickable checkboxes, ⌘-click links and markdown/HTML copy.
final class NoteTextView: NSTextView {
    /// Toggle the task on the line starting at the given index (cascade = ⌘-click).
    var onToggleTask: ((Int, Bool) -> Void)?
    var placeholder = "Start writing…"
    var notesLayoutManager: NotesLayoutManager? { layoutManager as? NotesLayoutManager }

    // MARK: Editing helpers

    /// Applies an EditResult as one undoable change.
    func apply(_ r: EditResult) {
        guard let ts = textStorage else { return }
        guard !r.edits.isEmpty else {
            setSelectedRange(r.selection)
            return
        }
        let sorted = r.edits.sorted { $0.range.location < $1.range.location }
        breakUndoCoalescing()
        guard shouldChangeText(inRanges: sorted.map { NSValue(range: $0.range) }, replacementStrings: sorted.map(\.replacement)) else { return }
        ts.beginEditing()
        for e in sorted.reversed() { ts.replaceCharacters(in: e.range, with: e.replacement) }
        ts.endEditing()
        didChangeText()
        breakUndoCoalescing()
        setSelectedRange(NSRange(location: min(r.selection.location, ts.length), length: min(r.selection.length, max(0, ts.length - r.selection.location))))
        scrollRangeToVisible(selectedRange())
    }

    override func insertText(_ string: Any, replacementRange: NSRange) {
        if !hasMarkedText(), replacementRange.location == NSNotFound, let s = string as? String, s == " " || s == "-",
           let r = MarkdownCommands.inputRule(self.string as NSString, selection: selectedRange(), typed: s) {
            apply(r)
            return
        }
        super.insertText(string, replacementRange: replacementRange)
    }

    // MARK: Mouse

    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        if let lineStart = checkbox(at: p) {
            onToggleTask?(lineStart, event.modifierFlags.contains(.command))
            return
        }
        if event.modifierFlags.contains(.command), let url = link(at: p) {
            NSWorkspace.shared.open(url)
            return
        }
        super.mouseDown(with: event)
    }

    private func charIndex(at viewPoint: NSPoint) -> Int? {
        guard let lm = layoutManager, let tc = textContainer, let ts = textStorage, ts.length > 0 else { return nil }
        let pt = NSPoint(x: viewPoint.x - textContainerOrigin.x, y: viewPoint.y - textContainerOrigin.y)
        let i = lm.characterIndex(for: pt, in: tc, fractionOfDistanceBetweenInsertionPoints: nil)
        return i < ts.length ? i : nil
    }

    /// Line start of the task whose checkbox is under the point.
    func checkbox(at viewPoint: NSPoint) -> Int? {
        guard let i = charIndex(at: viewPoint), let ts = textStorage, let lm = notesLayoutManager else { return nil }
        let para = (ts.string as NSString).paragraphRange(for: NSRange(location: i, length: 0))
        guard let d = ts.attribute(.notesBlock, at: para.location, effectiveRange: nil) as? BlockDecoration,
              case .task(let level, _) = d.kind,
              let box = lm.checkboxRect(paragraphStart: para.location, level: level) else { return nil }
        let pt = NSPoint(x: viewPoint.x - textContainerOrigin.x, y: viewPoint.y - textContainerOrigin.y)
        return box.insetBy(dx: -5, dy: -4).contains(pt) ? para.location : nil
    }

    func link(at viewPoint: NSPoint) -> URL? {
        guard let i = charIndex(at: viewPoint), let s = textStorage?.attribute(.notesLink, at: i, effectiveRange: nil) as? String else { return nil }
        return URL(string: s.contains("://") || s.hasPrefix("mailto:") ? s : "https://" + s)
    }

    override func mouseMoved(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        if checkbox(at: p) != nil || (event.modifierFlags.contains(.command) && link(at: p) != nil) {
            NSCursor.pointingHand.set()
            return
        }
        super.mouseMoved(with: event)
    }

    // MARK: Pasteboard: copy markdown (+ HTML for rich-text targets), paste plain text

    override var writablePasteboardTypes: [NSPasteboard.PasteboardType] { [.string, .html] }

    override func writeSelection(to pboard: NSPasteboard, types: [NSPasteboard.PasteboardType]) -> Bool {
        let md = (string as NSString).substring(with: selectedRange())
        guard !md.isEmpty else { return false }
        pboard.declareTypes([.string, .html], owner: nil)
        pboard.setString(md, forType: .string)
        pboard.setString(MarkdownExport.html(md, standalone: false), forType: .html)
        return true
    }

    override var readablePasteboardTypes: [NSPasteboard.PasteboardType] { [.string] }

    override func paste(_ sender: Any?) { pasteAsPlainText(sender) }

    // MARK: Drawing

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        if string.isEmpty, !placeholder.isEmpty, let lm = notesLayoutManager {
            let attrs: [NSAttributedString.Key: Any] = [.font: lm.theme.bodyFont, .foregroundColor: NSColor.placeholderTextColor]
            (placeholder as NSString).draw(at: NSPoint(x: textContainerOrigin.x, y: textContainerOrigin.y), withAttributes: attrs)
        }
    }
}
