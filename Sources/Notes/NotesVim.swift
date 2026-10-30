import AppKit
import Carbon.HIToolbox

/// The editor's side of Vim mode (`VimEngine`): keys, the block cursor, scrolling.
extension NoteTextView: VimHost {
    var vimText: NSString { (textStorage?.string ?? "") as NSString }
    var vimSelection: NSRange { selectedRange() }
    var vimFolds: HeadingFolds { vimFoldsProvider?() ?? HeadingFolds() }

    func vimSetSelection(_ range: NSRange, show: Int) {
        setSelectedRange(range)
        scrollRangeToVisible(NSRange(location: min(show, (string as NSString).length), length: 0))
    }

    func vimApply(_ result: EditResult) -> Bool { apply(result) }

    func vimUndo() -> Bool {
        guard let um = undoManager, um.canUndo else { return false }
        um.undo()
        return true
    }

    func vimRedo() -> Bool {
        guard let um = undoManager, um.canRedo else { return false }
        um.redo()
        return true
    }

    func vimContentStart(_ lineStart: Int) -> Int {
        guard let ts = textStorage, lineStart < ts.length,
              let n = ts.attribute(.notesPrefixLen, at: lineStart, effectiveRange: nil) as? Int else { return lineStart }
        return lineStart + n
    }

    func vimScroll(_ scroll: VimScroll, count: Int, caret: Int) -> Int? {
        guard let sv = enclosingScrollView, let ts = textStorage, ts.length > 0 else { return nil }
        let clip = sv.contentView
        let visible = clip.bounds
        let lineHeight = vimLineHeight
        let caretLine = vimLineRect(at: caret)
        let maxY = max(0, bounds.height - visible.height)
        func scrollTo(_ y: CGFloat) {
            clip.scroll(to: NSPoint(x: visible.minX, y: min(max(0, y), maxY)))
            sv.reflectScrolledClipView(clip)
        }
        switch scroll {
        case .halfDown, .halfUp, .pageDown, .pageUp:
            // the view and the caret move by the same distance (the caret stays within the view)
            let half = scroll == .halfDown || scroll == .halfUp
            let page = half ? visible.height / 2 : max(lineHeight, visible.height - 2 * lineHeight)
            let dist = page * CGFloat(count) * (scroll == .halfDown || scroll == .pageDown ? 1 : -1)
            scrollTo(visible.minY + dist)
            let now = clip.bounds
            let y = min(max(caretLine.midY + dist, now.minY + lineHeight / 2), now.maxY - lineHeight / 2)
            return vimCharacter(atY: y)
        case .lineDown, .lineUp:
            scrollTo(visible.minY + lineHeight * CGFloat(count) * (scroll == .lineDown ? 1 : -1))
            let now = clip.bounds
            if caretLine.minY < now.minY { return vimCharacter(atY: now.minY + lineHeight / 2) }
            if caretLine.maxY > now.maxY { return vimCharacter(atY: now.maxY - lineHeight / 2) }
            return nil
        case .center:
            scrollTo(caretLine.midY - visible.height / 2)
            return nil
        case .top:
            scrollTo(caretLine.minY)
            return nil
        case .bottom:
            scrollTo(caretLine.maxY - visible.height)
            return nil
        }
    }

    func vimScreenLine(_ line: VimScreenLine) -> Int? {
        guard let ts = textStorage, ts.length > 0, let lm = layoutManager, let tc = textContainer else { return nil }
        let visible = enclosingScrollView?.contentView.bounds ?? visibleRect
        let h = vimLineHeight
        let bottom = min(visible.maxY, lm.usedRect(for: tc).maxY + textContainerOrigin.y)
        switch line {
        case .top: return vimCharacter(atY: visible.minY + h / 2)
        case .middle: return vimCharacter(atY: (visible.minY + bottom) / 2)
        case .bottom: return vimCharacter(atY: bottom - h / 2)
        }
    }

    func vimToggleHeading(_ lineStart: Int) -> Bool { onVimToggleHeading?(lineStart) ?? false }

    func vimReveal(_ location: Int) { onVimReveal?(location) }

    var vimClipboard: String? {
        get { NoteTextView.plainText(from: .general) }
        set {
            let pb = NSPasteboard.general
            pb.clearContents()
            if let newValue { pb.setString(newValue, forType: .string) }
        }
    }

    func vimEscape() { onVimEscape?() }

    func vimBeep() { NSSound.beep() }

    // MARK: Keys

    /// Normal and visual mode take the keys (insert mode only Escape). ⌘ shortcuts, Page Up/Down,
    /// Home and End keep their usual meaning.
    func vimKeyDown(_ e: NSEvent, _ vim: VimEngine) -> Bool {
        let key = NoteTextView.vimKey(e)
        if vim.mode == .insert {
            // the IME, and the inline "/" and ":" menus, keep their own Escape
            guard let key, key.isEscape, !hasMarkedText(), !(vimEscapeBlocked?() ?? false) else { return false }
            vim.leaveInsert()
            return true
        }
        guard let key else {
            if e.modifierFlags.contains(.command) || [kVK_PageUp, kVK_PageDown, kVK_Home, kVK_End].contains(Int(e.keyCode)) { return false }
            NSSound.beep()
            return true
        }
        vim.handle(key)
        return true
    }

    /// Keys as if pressed, for the dev harness and tests: typed text in insert mode, commands
    /// otherwise (`VimKey.parse` notation).
    func vimFeed(_ keys: String) {
        guard let vim else { return }
        for k in VimKey.parse(keys) {
            guard vim.mode == .insert else {
                vim.handle(k)
                continue
            }
            if k.isEscape {
                vim.leaveInsert()
                continue
            }
            switch k.special {
            case .enter: doCommand(by: #selector(NSResponder.insertNewline(_:)))
            case .backspace: doCommand(by: #selector(NSResponder.deleteBackward(_:)))
            case .tab: doCommand(by: #selector(NSResponder.insertTab(_:)))
            default:
                if let c = k.char, !k.ctrl { insertText(String(c), replacementRange: NSRange(location: NSNotFound, length: 0)) }
            }
        }
    }

    static func vimKey(_ e: NSEvent) -> VimKey? {
        let mods = e.modifierFlags.intersection([.command, .control, .option])
        if mods.contains(.command) { return nil }
        switch Int(e.keyCode) {
        case kVK_Escape: return VimKey(.escape)
        case kVK_Return, kVK_ANSI_KeypadEnter: return VimKey(.enter)
        case kVK_Delete: return VimKey(.backspace)
        case kVK_ForwardDelete: return VimKey(.delete)
        case kVK_Tab: return VimKey(.tab)
        case kVK_LeftArrow: return VimKey(.left)
        case kVK_RightArrow: return VimKey(.right)
        case kVK_UpArrow: return VimKey(.up)
        case kVK_DownArrow: return VimKey(.down)
        default: break
        }
        if mods.contains(.control) {
            guard let c = (e.charactersIgnoringModifiers ?? "").lowercased().first ?? translated(e) else { return nil }
            return VimKey(c, ctrl: true)
        }
        // what the key types on the current layout (⌥ included: "[" and "{" on Nordic layouts);
        // a dead key types nothing yet, so its own character
        let s = e.characters ?? ""
        guard let c = s.isEmpty ? translated(e) : (s.count == 1 ? s.first : nil) else { return nil }
        let printable = c.unicodeScalars.allSatisfy { $0.value >= 32 && $0.value != 127 && !(0xF700...0xF8FF).contains($0.value) }
        return printable ? VimKey(c) : nil
    }

    /// The key's character without dead-key composition (^, ` and ´ on many layouts).
    private static func translated(_ e: NSEvent) -> Character? {
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
        let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
        var mods: UInt32 = 0
        if e.modifierFlags.contains(.shift) { mods |= UInt32((shiftKey >> 8) & 0xFF) }
        if e.modifierFlags.contains(.option) { mods |= UInt32((optionKey >> 8) & 0xFF) }
        if e.modifierFlags.contains(.capsLock) { mods |= UInt32((alphaLock >> 8) & 0xFF) }
        var deadKeys: UInt32 = 0
        var chars = [UniChar](repeating: 0, count: 4)
        var length = 0
        let status = data.withUnsafeBytes { buf -> OSStatus in
            guard let layout = buf.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return OSStatus(paramErr) }
            return UCKeyTranslate(layout, e.keyCode, UInt16(kUCKeyActionDown), mods, UInt32(LMGetKbdType()),
                                  OptionBits(kUCKeyTranslateNoDeadKeysMask), &deadKeys, chars.count, &length, &chars)
        }
        guard status == noErr, length > 0 else { return nil }
        return String(utf16CodeUnits: chars, count: length).first
    }

    // MARK: Block cursor

    /// Normal and visual mode show a block on the character under the cursor instead of the caret.
    var vimCapturesKeys: Bool { vim.map { $0.mode != .insert } ?? false }

    /// Mode changed: the block cursor or the caret.
    func vimModeChanged() {
        let theme = notesLayoutManager?.theme
        insertionPointColor = vimCapturesKeys ? .clear : (theme?.accent ?? .controlAccentColor)
        updateInsertionPointStateAndRestartTimer(true)
        needsDisplay = true
    }

    func vimSelectionDidChange() {
        guard let vim, !vim.isExecuting else { return }
        if let um = undoManager, um.isUndoing || um.isRedoing {
            // ⌘Z selects what it put back: a caret again once it's done
            DispatchQueue.main.async { [weak self] in self?.vim?.normalize() }
            return
        }
        vim.selectionDidChange()
    }

    private var vimLineHeight: CGFloat {
        let font = notesLayoutManager?.theme.bodyFont ?? self.font ?? .systemFont(ofSize: 14)
        return max(8, layoutManager?.defaultLineHeight(for: font) ?? 18)
    }

    private var vimCellWidth: CGFloat {
        let font = notesLayoutManager?.theme.bodyFont ?? self.font ?? .systemFont(ofSize: 14)
        return max(4, ("0" as NSString).size(withAttributes: [.font: font]).width)
    }

    /// The line fragment of the character at `i` (view coordinates).
    private func vimLineRect(at i: Int) -> NSRect {
        guard let lm = layoutManager, let ts = textStorage, ts.length > 0 else { return .zero }
        var r: NSRect
        if i >= ts.length, !lm.extraLineFragmentRect.isEmpty {
            r = lm.extraLineFragmentRect
        } else {
            r = lm.lineFragmentRect(forGlyphAt: lm.glyphIndexForCharacter(at: min(i, ts.length - 1)), effectiveRange: nil)
        }
        return r.offsetBy(dx: textContainerOrigin.x, dy: textContainerOrigin.y)
    }

    private func vimCharacter(atY y: CGFloat) -> Int? {
        guard let lm = layoutManager, let tc = textContainer, let ts = textStorage, ts.length > 0 else { return nil }
        let g = lm.glyphIndex(for: NSPoint(x: 0, y: y - textContainerOrigin.y), in: tc)
        return min(lm.characterIndexForGlyph(at: g), ts.length)
    }

    /// The block cursor (view coordinates), nil in insert mode.
    func vimCursorRect() -> NSRect? {
        guard let vim, vim.mode != .insert, let lm = layoutManager, let tc = textContainer, let ts = textStorage else { return nil }
        let origin = textContainerOrigin
        let w = vimCellWidth
        let loc = min(vim.mode.isVisual ? vim.visualCursor : selectedRange().location, ts.length)
        let text = ts.string as NSString
        if ts.length == 0 {
            return NSRect(x: origin.x, y: origin.y, width: w, height: vimLineHeight)
        }
        if loc < ts.length {
            let chars = text.rangeOfComposedCharacterSequence(at: loc)
            let glyphs = lm.glyphRange(forCharacterRange: chars, actualCharacterRange: nil)
            let line = lm.lineFragmentRect(forGlyphAt: glyphs.location, effectiveRange: nil)
            let u = text.character(at: loc)
            if u == 10 || u == 13 {
                // a line break: a cell where the line ends
                let x = line.minX + lm.location(forGlyphAt: glyphs.location).x
                return NSRect(x: x + origin.x, y: line.minY + origin.y, width: w, height: line.height)
            }
            var r = lm.boundingRect(forGlyphRange: glyphs, in: tc)
            if r.width < 1 { r.size.width = w }
            return r.offsetBy(dx: origin.x, dy: origin.y)
        }
        // the end of the text
        if !lm.extraLineFragmentRect.isEmpty {
            let r = lm.extraLineFragmentRect
            return NSRect(x: r.minX + origin.x, y: r.minY + origin.y, width: w, height: r.height)
        }
        let last = lm.glyphRange(forCharacterRange: text.rangeOfComposedCharacterSequence(at: ts.length - 1), actualCharacterRange: nil)
        let r = lm.boundingRect(forGlyphRange: last, in: tc)
        return NSRect(x: r.maxX + origin.x, y: r.minY + origin.y, width: w, height: r.height)
    }

    func drawVimCursor(in rect: NSRect) {
        guard let vim, let r = vimCursorRect(), r.intersects(rect) else { return }
        let accent = notesLayoutManager?.theme.accent ?? .controlAccentColor
        if window?.isKeyWindow == true, window?.firstResponder === self {
            accent.withAlphaComponent(vim.mode.isVisual ? 0.55 : 0.4).setFill()
            NSBezierPath(rect: r).fill()
        } else {
            accent.withAlphaComponent(0.6).setStroke()
            let path = NSBezierPath(rect: r.insetBy(dx: 0.5, dy: 0.5))
            path.lineWidth = 1
            path.stroke()
        }
    }
}

// MARK: - Mode badge

/// The Vim mode in the editor's corner ("NORMAL", "INSERT", "VISUAL  2d", "NORMAL  /find").
final class VimModeBadge: NSView {
    private let label = NSTextField(labelWithString: "")
    var accent: NSColor = .controlAccentColor
    private(set) var text = ""

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = 4
        label.font = .monospacedSystemFont(ofSize: 10, weight: .semibold)
        label.textColor = .secondaryLabelColor
        label.lineBreakMode = .byTruncatingHead
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            label.topAnchor.constraint(equalTo: topAnchor, constant: 2),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -2),
            widthAnchor.constraint(lessThanOrEqualToConstant: 220),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        layer?.backgroundColor = NSColor.labelColor.withAlphaComponent(0.07).cgColor
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    /// Clicks go to the text under it.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    func show(_ mode: VimMode, pending: String) {
        text = pending.isEmpty ? mode.title : mode.title + "  " + pending
        label.stringValue = text
        label.textColor = mode == .normal ? .secondaryLabelColor : accent
    }
}
