import AppKit
import UniformTypeIdentifiers

/// The editor: plain-markdown NSTextView (TextKit 1) with markdown input rules,
/// clickable checkboxes, ⌘-click links and markdown/HTML copy.
final class NoteTextView: NSTextView {
    /// Toggle the task on the line starting at the given index (cascade = ⌘-click).
    var onToggleTask: ((Int, Bool) -> Void)?
    /// Collapse or open the section of the heading whose line starts at the given index.
    var onToggleHeading: ((Int) -> Void)?
    /// Images pasted or dropped at the selection.
    var onImages: (([ImageSource]) -> Void)?
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
        // the fold chevron toggles its section without touching the selection
        if let lineStart = foldChevron(at: p) {
            onToggleHeading?(lineStart)
            setHoveredHeading(headingLine(at: p))
            return
        }
        if event.modifierFlags.contains(.command), let url = link(at: p) {
            NSWorkspace.shared.open(url)
            return
        }
        super.mouseDown(with: event)
    }

    /// Chevrons and checkboxes work on the first click into the window when it isn't key.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        if let event {
            let p = convert(event.locationInWindow, from: nil)
            if foldChevron(at: p) != nil || checkbox(at: p) != nil { return true }
        }
        return super.acceptsFirstMouse(for: event)
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

    /// Line start of the (visible) heading whose first line is at the point's height, nil
    /// when there is none. Works anywhere across the view, margins included.
    func headingLine(at viewPoint: NSPoint) -> Int? {
        nearestHeading(at: viewPoint)?.start
    }

    /// Line start of the heading whose fold chevron is under the point: the margin left of
    /// the text, level with the heading's first line.
    func foldChevron(at viewPoint: NSPoint) -> Int? {
        guard viewPoint.x < textContainerOrigin.x + 2, let h = nearestHeading(at: viewPoint), h.target.contains(viewPoint) else { return nil }
        return h.start
    }

    /// The heading line nearest to the point's height among those whose chevron target
    /// (view coordinates) spans it.
    private func nearestHeading(at viewPoint: NSPoint) -> (start: Int, target: NSRect)? {
        guard let lm = notesLayoutManager, let ts = textStorage, ts.length > 0, let tc = textContainer else { return nil }
        let origin = textContainerOrigin
        let y = viewPoint.y - origin.y
        // the lines near that height (a chevron target reaches a little above and below its line)
        let probe = NSRect(x: 0, y: y - 12, width: max(1, tc.size.width), height: 24)
        lm.ensureLayout(forBoundingRect: probe, in: tc)
        let glyphs = lm.glyphRange(forBoundingRect: probe, in: tc)
        let text = ts.string as NSString
        let chars = lm.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
        var best: (start: Int, target: NSRect, distance: CGFloat)?
        var loc = text.paragraphRange(for: NSRange(location: min(chars.location, text.length), length: 0)).location
        while loc < text.length, loc <= NSMaxRange(chars) {
            let para = text.paragraphRange(for: NSRange(location: loc, length: 0))
            if let d = ts.attribute(.notesBlock, at: loc, effectiveRange: nil) as? BlockDecoration, d.collapsed != nil,
               let r = lm.chevronTarget(paragraphStart: loc, margin: origin.x) {
                let target = r.offsetBy(dx: origin.x, dy: origin.y)
                if target.minY <= viewPoint.y, viewPoint.y <= target.maxY {
                    let distance = abs(target.midY - viewPoint.y)
                    if best.map({ distance < $0.distance }) ?? true { best = (loc, target, distance) }
                }
            }
            if para.length == 0 { break }
            loc = NSMaxRange(para)
        }
        return best.map { ($0.start, $0.target) }
    }

    func link(at viewPoint: NSPoint) -> URL? {
        guard let i = charIndex(at: viewPoint), let s = textStorage?.attribute(.notesLink, at: i, effectiveRange: nil) as? String else { return nil }
        return URL(string: s.contains("://") || s.hasPrefix("mailto:") ? s : "https://" + s)
    }

    override func mouseMoved(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        setHoveredHeading(headingLine(at: p))
        if checkbox(at: p) != nil || foldChevron(at: p) != nil || (event.modifierFlags.contains(.command) && link(at: p) != nil) {
            NSCursor.pointingHand.set()
            return
        }
        super.mouseMoved(with: event)
    }

    override func cursorUpdate(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        if foldChevron(at: p) != nil || checkbox(at: p) != nil {
            NSCursor.pointingHand.set()
            return
        }
        super.cursorUpdate(with: event)
    }

    override func mouseExited(with event: NSEvent) {
        setHoveredHeading(nil)
        super.mouseExited(with: event)
    }

    /// Hover (open headings show their chevron) and the hand cursor over chevrons also while
    /// the window isn't key, which the text view's own tracking doesn't cover.
    private var hoverArea: NSTrackingArea?
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let hoverArea { removeTrackingArea(hoverArea) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        hoverArea = area
    }

    private func setHoveredHeading(_ start: Int?) {
        guard let lm = notesLayoutManager, lm.hoveredHeading != start else { return }
        lm.hoveredHeading = start
        setNeedsDisplay(NSRect(x: visibleRect.minX, y: visibleRect.minY, width: textContainerOrigin.x, height: visibleRect.height))
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

    // images and image files can be dropped too (their bytes go to `onImages`)
    override var readablePasteboardTypes: [NSPasteboard.PasteboardType] { [.string, .fileURL] + NoteTextView.imageTypes }

    /// Drops (the selection is at the drop point by now).
    override func readSelection(from pboard: NSPasteboard, type: NSPasteboard.PasteboardType) -> Bool {
        if let onImages, let images = NoteTextView.images(from: pboard) {
            onImages(images)
            return true
        }
        guard type == .string else { return false }
        return super.readSelection(from: pboard, type: type)
    }

    override func paste(_ sender: Any?) {
        if let onImages, let images = NoteTextView.images(from: .general) { onImages(images); return }
        pastePlain(from: .general)
    }
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

    /// Image types in the order their bytes are preferred (TIFF, macOS's own, gets converted).
    static let imageTypes: [NSPasteboard.PasteboardType] = [.png, NSPasteboard.PasteboardType(UTType.jpeg.identifier),
        NSPasteboard.PasteboardType(UTType.gif.identifier), NSPasteboard.PasteboardType(UTType.webP.identifier),
        NSPasteboard.PasteboardType(UTType.heic.identifier), .tiff]

    /// The images on a pasteboard: image files (Finder), or image data that is what was
    /// copied (not a picture of copied text, which comes with the text first). nil: none.
    static func images(from pb: NSPasteboard) -> [ImageSource]? {
        let fileOpts: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true, .urlReadingContentsConformToTypes: [UTType.image.identifier]]
        if let urls = pb.readObjects(forClasses: [NSURL.self], options: fileOpts) as? [URL], !urls.isEmpty {
            return urls.map(ImageSource.file)
        }
        var out: [ImageSource] = []
        for item in pb.pasteboardItems ?? [] {
            guard let first = item.types.first, item.string(forType: .string) == nil || imageTypes.contains(first),
                  let type = imageTypes.first(where: item.types.contains), let d = item.data(forType: type) else { continue }
            out.append(.bytes(d))
        }
        return out.isEmpty ? nil : out
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
