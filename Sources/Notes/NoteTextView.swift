import AppKit

/// The editor: plain-markdown NSTextView (TextKit 1) with markdown input rules,
/// clickable checkboxes, ⌘-click links and markdown/HTML copy.
final class NoteTextView: NSTextView {
    /// Toggle the task on the line starting at the given index (cascade = ⌘-click).
    var onToggleTask: ((Int, Bool) -> Void)?
    /// Collapse or open the section of the heading whose line starts at the given index.
    var onToggleHeading: ((Int) -> Void)?
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
        // An out-of-bounds or overlapping edit would raise inside NSTextStorage: refuse it.
        var prevEnd = 0
        for e in sorted {
            guard e.range.location != NSNotFound, e.range.location >= prevEnd, NSMaxRange(e.range) <= ts.length else {
                NSSound.beep()
                return
            }
            prevEnd = NSMaxRange(e.range)
        }
        if hasMarkedText() { unmarkText() }
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

    override func drawBackground(in rect: NSRect) {
        super.drawBackground(in: rect)
        notesLayoutManager?.drawHeadingChevrons(in: rect, origin: textContainerOrigin)
    }

    // MARK: Mouse

    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        if let lineStart = checkbox(at: p) {
            onToggleTask?(lineStart, event.modifierFlags.contains(.command))
            return
        }
        if let lineStart = headingChevron(at: p) {
            onToggleHeading?(lineStart)
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

    /// Line start of the heading under the point (nil: not on a heading line).
    func heading(at viewPoint: NSPoint) -> Int? {
        guard let i = charIndex(at: viewPoint), let ts = textStorage, let lm = layoutManager, let tc = textContainer else { return nil }
        let para = (ts.string as NSString).paragraphRange(for: NSRange(location: i, length: 0))
        guard let d = ts.attribute(.notesBlock, at: para.location, effectiveRange: nil) as? BlockDecoration, d.collapsed != nil else { return nil }
        // only within the line's height (characterIndex picks the nearest line)
        let glyphs = lm.glyphRange(forCharacterRange: para, actualCharacterRange: nil)
        let rect = lm.boundingRect(forGlyphRange: glyphs, in: tc)
        let y = viewPoint.y - textContainerOrigin.y
        return y >= rect.minY && y <= rect.maxY ? para.location : nil
    }

    /// Line start of the heading whose fold chevron (or the margin left of its text) is
    /// under the point.
    func headingChevron(at viewPoint: NSPoint) -> Int? {
        guard let start = heading(at: viewPoint), let lm = notesLayoutManager, let box = lm.chevronRect(paragraphStart: start) else { return nil }
        let pt = NSPoint(x: viewPoint.x - textContainerOrigin.x, y: viewPoint.y - textContainerOrigin.y)
        let target = NSRect(x: -textContainerOrigin.x, y: box.minY - 4, width: textContainerOrigin.x + box.maxX + 2, height: box.height + 8)
        return target.contains(pt) ? start : nil
    }

    func link(at viewPoint: NSPoint) -> URL? {
        guard let i = charIndex(at: viewPoint), let s = textStorage?.attribute(.notesLink, at: i, effectiveRange: nil) as? String else { return nil }
        return URL(string: s.contains("://") || s.hasPrefix("mailto:") ? s : "https://" + s)
    }

    override func mouseMoved(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        setHoveredHeading(heading(at: p))
        if checkbox(at: p) != nil || headingChevron(at: p) != nil || (event.modifierFlags.contains(.command) && link(at: p) != nil) {
            NSCursor.pointingHand.set()
            return
        }
        super.mouseMoved(with: event)
    }

    override func mouseExited(with event: NSEvent) {
        setHoveredHeading(nil)
        super.mouseExited(with: event)
    }

    private func setHoveredHeading(_ start: Int?) {
        guard let lm = notesLayoutManager, lm.hoveredHeading != start else { return }
        lm.hoveredHeading = start
        needsDisplay = true
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

    override func paste(_ sender: Any?) { pastePlain(from: .general) }
    override func pasteAsPlainText(_ sender: Any?) { pastePlain(from: .general) }
    override func pasteAsRichText(_ sender: Any?) { pastePlain(from: .general) }

    /// Pastes the text of whatever is on the pasteboard (rich text loses its styling,
    /// line endings become "\n"); beeps for content without text (e.g. an image).
    func pastePlain(from pb: NSPasteboard) {
        guard let s = NoteTextView.plainText(from: pb), !s.isEmpty else { NSSound.beep(); return }
        // Pasting a URL over selected text links it, like Raycast's editor.
        let sel = selectedRange()
        if sel.length > 0, let url = NoteTextView.singleURL(s),
           !(string as NSString).substring(with: sel).contains("\n") {
            apply(MarkdownCommands.insertLink(string as NSString, selection: sel, url: url))
            return
        }
        breakUndoCoalescing()
        insertText(s, replacementRange: selectedRange())
        breakUndoCoalescing()
        scrollRangeToVisible(selectedRange())
    }

    static func plainText(from pb: NSPasteboard) -> String? {
        var s = pb.string(forType: .string)
        if s == nil, let data = pb.data(forType: .rtf) ?? pb.data(forType: .rtfd) {
            s = NSAttributedString(rtf: data, documentAttributes: nil)?.string ?? NSAttributedString(rtfd: data, documentAttributes: nil)?.string
        }
        if s == nil, let data = pb.data(forType: .html) {
            s = NSAttributedString(html: data, documentAttributes: nil)?.string
        }
        if s == nil, let urls = pb.readObjects(forClasses: [NSURL.self], options: nil) as? [URL], !urls.isEmpty {
            s = urls.map { $0.isFileURL ? $0.path : $0.absoluteString }.joined(separator: "\n")
        }
        guard var text = s else { return nil }
        // one line terminator everywhere: the parser and the sync format work on "\n"
        if text.utf16.contains(13) { text = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n") }
        if text.utf16.contains(where: { $0 == 0x2028 || $0 == 0x2029 || $0 == 0x85 }) {
            text = text.replacingOccurrences(of: "\u{2028}", with: "\n").replacingOccurrences(of: "\u{2029}", with: "\n")
                .replacingOccurrences(of: "\u{85}", with: "\n")
        }
        if text.utf8.contains(0) { text = text.replacingOccurrences(of: "\u{0}", with: "") }
        if text.utf16.contains(9) { text = markdownLists(text) }
        return text
    }

    /// The text when it is exactly one http(s)/mailto URL.
    static func singleURL(_ s: String) -> String? {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, !t.contains(where: { $0.isWhitespace }), let u = URL(string: t), let scheme = u.scheme?.lowercased(),
              ["http", "https", "mailto"].contains(scheme), scheme == "mailto" || u.host != nil else { return nil }
        return t
    }

    private static let richListRE = try? NSRegularExpression(pattern: #"^(\t*)([•◦▪▫‣⁃∙●○■□-]|\d{1,3}[.)])\t"#)

    /// Lists copied as rich text (Notes, TextEdit, web pages) arrive as "\t•\titem" /
    /// "\t1.\titem" lines: turn them into markdown list items.
    static func markdownLists(_ text: String) -> String {
        guard let re = richListRE else { return text }
        var changed = false
        let lines = text.components(separatedBy: "\n").map { line -> String in
            let ns = line as NSString
            guard let m = re.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) else { return line }
            changed = true
            let marker = ns.substring(with: m.range(at: 2))
            let indent = String(repeating: MarkdownParser.indentUnit, count: max(0, m.range(at: 1).length - 1))
            let prefix = marker.first?.isNumber == true ? marker.dropLast() + ". " : "- "
            return indent + prefix + ns.substring(from: NSMaxRange(m.range))
        }
        return changed ? lines.joined(separator: "\n") : text
    }

    // MARK: Drawing

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        if string.isEmpty, !placeholder.isEmpty, let lm = notesLayoutManager {
            let attrs: [NSAttributedString.Key: Any] = [.font: lm.theme.bodyFont, .foregroundColor: NSColor.placeholderTextColor]
            (placeholder as NSString).draw(at: NSPoint(x: textContainerOrigin.x, y: textContainerOrigin.y), withAttributes: attrs)
        }
    }
}
