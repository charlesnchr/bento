import AppKit
import Combine
import BentoCore

/// The floating notes window: header (title + ⌘ / browse / + buttons), the editor,
/// and a footer with the word/character count or the format bar.
/// Created lazily on first use; one note visible at a time.
final class NotesWindowController: NSObject, NSWindowDelegate, NSTextViewDelegate, NSTextStorageDelegate {
    unowned let controller: NotesController

    let panel: NotesPanel
    let textView: NoteTextView
    let layoutManager = NotesLayoutManager()
    let styler = MarkdownStyler()
    private let storage = NSTextStorage()
    private let scroll = NSScrollView()
    private let header = NotesHeaderView()
    private let footer = NotesFooterView()
    private let formatBar = NotesFormatBar()
    private let background = ThemedBackgroundView(material: .hudWindow)
    private let tint = TintView()
    private var footerHeight: NSLayoutConstraint!
    let palette = PalettePanel()
    private let inlineMenu = InlineMenu()
    private enum InlineTrigger { case slash, emoji }
    private var inline: (kind: InlineTrigger, start: Int)?

    private var keyMonitor: Any?
    private var flagsMonitor: Any?
    private var cancellables: Set<AnyCancellable> = []
    private var frameSaveWork: DispatchWorkItem?
    private var countsWork: DispatchWorkItem?
    private var loadingNote = false
    private var undoManagers: [String: UndoManager] = [:]
    private var undoOrder: [String] = []
    private(set) var noteID: String?
    private var settings: NotesSettings

    static let defaultSize = NSSize(width: 396, height: 448)
    private let minSize = NSSize(width: 300, height: 140)

    init(controller: NotesController, settings: NotesSettings) {
        self.controller = controller
        self.settings = settings
        panel = NotesPanel(contentRect: NSRect(origin: .zero, size: NotesWindowController.defaultSize),
                           styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
                           backing: .buffered, defer: true)
        let container = NSTextContainer(size: NSSize(width: 300, height: CGFloat.greatestFiniteMagnitude))
        container.widthTracksTextView = true
        container.lineFragmentPadding = 0
        storage.addLayoutManager(layoutManager)
        layoutManager.addTextContainer(container)
        textView = NoteTextView(frame: NSRect(x: 0, y: 0, width: 300, height: 300), textContainer: container)
        super.init()
        setUpWindow()
        setUpTextView()
        applySettings(settings, initial: true)
        controller.sync.status.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] in DispatchQueue.main.async { self?.updateSyncIndicator() } }
            .store(in: &cancellables)
        updateSyncIndicator()
    }

    // MARK: Setup

    private func setUpWindow() {
        panel.title = "Notes"
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.becomesKeyOnlyIfNeeded = false
        panel.animationBehavior = .utilityWindow
        panel.minSize = minSize
        panel.delegate = self
        panel.standardWindowButton(.zoomButton)?.isEnabled = false
        panel.standardWindowButton(.miniaturizeButton)?.isEnabled = false
        panel.tabbingMode = .disallowed

        background.onChange = { [weak self] _ in self?.tint.needsDisplay = true }
        panel.contentView = background

        for v in [tint, header, scroll, footer, formatBar] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            background.effect.addSubview(v)
        }
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.borderType = .noBorder
        scroll.documentView = textView
        scroll.contentView.postsBoundsChangedNotifications = false

        let titlebar = max(28, panel.frame.height - panel.contentLayoutRect.height)
        footerHeight = footer.heightAnchor.constraint(equalToConstant: 30)
        NSLayoutConstraint.activate([
            tint.topAnchor.constraint(equalTo: background.topAnchor),
            tint.bottomAnchor.constraint(equalTo: background.bottomAnchor),
            tint.leadingAnchor.constraint(equalTo: background.leadingAnchor),
            tint.trailingAnchor.constraint(equalTo: background.trailingAnchor),
            header.topAnchor.constraint(equalTo: background.topAnchor),
            header.leadingAnchor.constraint(equalTo: background.leadingAnchor),
            header.trailingAnchor.constraint(equalTo: background.trailingAnchor),
            header.heightAnchor.constraint(equalToConstant: titlebar + 4),
            scroll.topAnchor.constraint(equalTo: header.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: background.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: background.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: footer.topAnchor),
            footer.leadingAnchor.constraint(equalTo: background.leadingAnchor),
            footer.trailingAnchor.constraint(equalTo: background.trailingAnchor),
            footer.bottomAnchor.constraint(equalTo: background.bottomAnchor),
            footerHeight,
            formatBar.leadingAnchor.constraint(equalTo: footer.leadingAnchor),
            formatBar.trailingAnchor.constraint(equalTo: footer.trailingAnchor),
            formatBar.topAnchor.constraint(equalTo: footer.topAnchor),
            formatBar.bottomAnchor.constraint(equalTo: footer.bottomAnchor),
        ])

        header.onAction = { [weak self] cmd in self?.controller.perform(cmd) }
        header.onDoubleClick = { [weak self] in self?.moveToOriginalPosition(animated: true) }
        footer.onToggleStatus = { [weak self] in self?.controller.toggleStatusText() }
        footer.onShowFormatBar = { [weak self] in self?.controller.perform(.toggleFormatBar) }
        footer.onSyncClick = { [weak self] in self?.controller.sync.syncNow() }
        formatBar.onCommand = { [weak self] cmd in self?.controller.perform(cmd) }
        formatBar.onClose = { [weak self] in self?.controller.perform(.toggleFormatBar) }
        palette.onClose = { [weak self] in
            guard let self, self.panel.isVisible else { return }
            self.panel.makeKey()
            self.panel.makeFirstResponder(self.textView)
        }
        restoreFrame()
    }

    private func setUpTextView() {
        let tv = textView
        tv.isRichText = false
        tv.importsGraphics = false
        tv.allowsUndo = true
        tv.isAutomaticQuoteSubstitutionEnabled = false
        tv.isAutomaticDashSubstitutionEnabled = false
        tv.isAutomaticTextReplacementEnabled = false
        tv.isAutomaticSpellingCorrectionEnabled = false
        tv.isAutomaticLinkDetectionEnabled = false
        tv.isAutomaticDataDetectionEnabled = false
        tv.isAutomaticTextCompletionEnabled = false
        tv.smartInsertDeleteEnabled = false
        tv.isContinuousSpellCheckingEnabled = true
        tv.isGrammarCheckingEnabled = false
        tv.usesFindBar = true
        tv.isIncrementalSearchingEnabled = true
        tv.drawsBackground = false
        tv.textContainerInset = NSSize(width: 24, height: 6)
        tv.isVerticallyResizable = true
        tv.isHorizontallyResizable = false
        tv.autoresizingMask = [.width]
        tv.minSize = NSSize(width: 0, height: 0)
        tv.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        tv.placeholder = "Write something …"
        tv.delegate = self
        storage.delegate = self
        tv.onToggleTask = { [weak self] lineStart, cascade in
            guard let self else { return }
            if let r = MarkdownCommands.toggleTasks(self.textView.string as NSString, selection: NSRange(location: lineStart, length: 0), cascade: cascade) {
                let sel = self.textView.selectedRange()
                self.textView.apply(EditResult(edits: r.edits, selection: sel))
            }
        }
        tv.onToggleHeading = { [weak self] lineStart in self?.toggleHeading(at: lineStart) }
    }

    /// Collapses or opens a heading's section. A selection in a section that collapses
    /// moves to the end of the heading.
    @discardableResult
    func toggleHeading(at lineStart: Int) -> Bool {
        let text = storage.string as NSString
        guard lineStart >= 0, lineStart < text.length,
              let d = storage.attribute(.notesBlock, at: lineStart, effectiveRange: nil) as? BlockDecoration, let collapsed = d.collapsed else { return false }
        let line = text.lineRange(for: NSRange(location: lineStart, length: 0))
        let content = MarkdownParser.contentRange(line, in: text)
        if !collapsed, case .heading(let level) = MarkdownParser.parseLine(MarkdownParser.utf16(text, content), inCode: false).kind {
            let end = MarkdownParser.sectionEnd(after: line, level: level, in: text)
            let body = NSRange(location: NSMaxRange(line), length: max(0, end - NSMaxRange(line)))
            let sel = textView.selectedRange()
            if NSLocationInRange(sel.location, body) || (sel.location == end && body.length > 0 && end == text.length) || NSIntersectionRange(sel, body).length > 0 {
                textView.setSelectedRange(NSRange(location: NSMaxRange(content), length: 0))
            }
        }
        guard styler.toggleHeading(storage, at: lineStart) else { return false }
        textView.needsDisplay = true
        if settings.autoResize { autoResize() }
        return true
    }

    // MARK: Settings

    func applySettings(_ s: NotesSettings, initial: Bool = false) {
        let old = settings
        settings = s
        let theme = s.theme
        let themeChanged = initial || old.textSize != s.textSize || old.fontFamily != s.fontFamily || old.accentColor != s.accentColor
        if themeChanged {
            styler.theme = theme
            layoutManager.theme = theme
            textView.insertionPointColor = theme.accent
            textView.selectedTextAttributes = [.backgroundColor: theme.accent.withAlphaComponent(0.28)]
            textView.typingAttributes = [.font: theme.bodyFont, .foregroundColor: theme.paragraph]
            if !initial { restyleAll() }
        }
        panel.level = s.floatOnTop ? .floating : .normal
        panel.collectionBehavior = s.floatOnTop ? [.canJoinAllSpaces, .fullScreenAuxiliary] : [.moveToActiveSpace, .fullScreenAuxiliary]
        panel.sharingType = s.hideWhileScreenSharing ? .none : .readOnly
        let showBar = s.showFormatBar
        formatBar.isHidden = !showBar
        footer.contentHidden = showBar
        footerHeight.constant = showBar ? 36 : 30
        footer.statusIsWords = s.statusText != "characters"
        if old.statusText != s.statusText || initial { updateCounts() }
        if s.autoResize && (!old.autoResize || themeChanged) { autoResize() }
    }

    private func restyleAll() {
        styler.styleAll(storage)
        textView.needsDisplay = true
    }

    // MARK: Showing

    var isVisible: Bool { panel.isVisible && !AppActivation.isOrderingOut(panel) }
    var isKey: Bool { panel.isKeyWindow || palette.isOpen && NSApp.keyWindow != nil && NSApp.keyWindow?.parent === panel }

    func show(focus: Bool = true) {
        ensureOnScreen()
        AppActivation.show(panel, activate: focus)
        if focus, !palette.isOpen { panel.makeFirstResponder(textView) }
    }

    /// `app`: hand focus to it (see `AppActivation.orderOut`).
    func hide(activating app: NSRunningApplication? = nil) {
        closeInline()
        palette.close()
        controller.flushPendingSave()
        AppActivation.orderOut(panel, activating: app)
        removeKeyMonitor()
    }

    /// Gives focus back to the app that was active before, keeping the window visible.
    func unfocus() {
        if let prev = AppActivation.previousApp, prev.processIdentifier != getpid() {
            prev.activate()
        } else {
            NSApp.hide(nil)
        }
    }

    // MARK: Notes

    /// Loads a note into the editor.
    func load(_ note: Note, selection: NSRange?) {
        closeInline()
        if textView.hasMarkedText() { textView.unmarkText() } // the IME's range would point into the old text
        textView.breakUndoCoalescing() // typing in the previous note must not continue into this one
        loadingNote = true
        noteID = note.id
        let attrs: [NSAttributedString.Key: Any] = [.font: styler.theme.bodyFont, .foregroundColor: styler.theme.paragraph]
        storage.beginEditing()
        storage.setAttributedString(NSAttributedString(string: note.body, attributes: attrs))
        storage.endEditing()
        let len = storage.length
        let sel = selection.map { NSRange(location: min($0.location, len), length: min($0.length, max(0, len - min($0.location, len)))) }
            ?? NSRange(location: len, length: 0)
        styler.selectionChanged(storage, to: sel)
        restyleAll()
        loadingNote = false
        textView.setSelectedRange(sel)
        textView.scrollRangeToVisible(sel)
        header.title = NoteText.title(of: note.body)
        updateCounts()
        if settings.autoResize { autoResize() }
    }

    /// Applies a body that changed elsewhere (sync) like Google Docs: only the changed
    /// stretches are replaced, the selection moves with the text around it and the text at
    /// the top of the view stays where it is.
    func applyExternalBody(_ body: String) {
        guard !storage.string.utf16.elementsEqual(body.utf16) else { return }
        if textView.hasMarkedText() { textView.unmarkText() } // can change the text: diff after it
        closeInline()
        let edits = TextMerge.edits(from: storage.string, to: body)
        guard !edits.isEmpty else { return }
        let sel = TextMerge.map(textView.selectedRange(), through: edits)
        let anchor = scrollAnchor()
        loadingNote = true
        storage.beginEditing()
        for e in edits.reversed() { storage.replaceCharacters(in: e.range, with: e.replacement) }
        storage.endEditing()
        loadingNote = false
        undoManager(for: noteID)?.removeAllActions()
        textView.setSelectedRange(sel)
        if let anchor {
            // text inserted right at the top line goes above it (out of view), like typing above
            restoreScroll(TextMerge.map(anchor.index, through: edits, pastInsertions: true, insideToEnd: false), offset: anchor.offset)
        }
        header.title = NoteText.title(of: body)
        scheduleCounts()
        if settings.autoResize { autoResize() }
    }

    /// The first character at the top of the scrolled view and how far above the view's
    /// top its line starts; nil when not scrolled.
    private func scrollAnchor() -> (index: Int, offset: CGFloat)? {
        let visible = scroll.contentView.bounds
        guard visible.minY > 0.5, storage.length > 0, let tc = textView.textContainer else { return nil }
        let origin = textView.textContainerOrigin
        let glyph = layoutManager.glyphIndex(for: NSPoint(x: 0, y: visible.minY - origin.y), in: tc)
        let line = layoutManager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
        return (layoutManager.characterIndexForGlyph(at: glyph), visible.minY - (line.minY + origin.y))
    }

    private func restoreScroll(_ index: Int, offset: CGFloat) {
        guard storage.length > 0 else { return }
        let i = min(index, storage.length - 1)
        layoutManager.ensureLayout(forCharacterRange: NSRange(location: 0, length: i + 1))
        let line = layoutManager.lineFragmentRect(forGlyphAt: layoutManager.glyphIndexForCharacter(at: i), effectiveRange: nil)
        let clip = scroll.contentView
        let target = NSRect(origin: NSPoint(x: clip.bounds.minX, y: line.minY + textView.textContainerOrigin.y + offset), size: clip.bounds.size)
        clip.scroll(to: clip.constrainBoundsRect(target).origin)
        scroll.reflectScrolledClipView(clip)
    }

    var currentText: String { storage.string }

    // dev harness state dump
    var debugFooter: String { footer.status }
    var debugHeader: String { header.title }

    var selectedRange: NSRange { textView.selectedRange() }

    // MARK: Text delegate

    func textStorage(_ textStorage: NSTextStorage, didProcessEditing editedMask: NSTextStorageEditActions, range editedRange: NSRange, changeInLength delta: Int) {
        guard editedMask.contains(.editedCharacters) else { return }
        styler.didEdit(textStorage, editedRange: editedRange)
    }

    func textDidChange(_ notification: Notification) {
        guard !loadingNote else { return }
        header.title = NoteText.title(of: storage.string)
        controller.editorChanged(storage.string)
        scheduleCounts()
        if settings.autoResize { autoResize() }
        detectInlineTrigger()
        updateInlineMenu()
    }

    // MARK: Inline "/" and ":" menus

    private func detectInlineTrigger() {
        guard inline == nil else { return }
        let sel = textView.selectedRange()
        let text = storage.string as NSString
        guard sel.length == 0, sel.location > 0, sel.location <= text.length else { return }
        let i = sel.location - 1
        let c = text.character(at: i)
        guard c == 47 || c == 58 else { return } // "/" or ":"
        let prevOK = i == 0 || [32, 9, 10].contains(text.character(at: i - 1))
        guard prevOK, storage.attribute(.notesCodeBlock, at: i, effectiveRange: nil) == nil,
              storage.attribute(.notesInlineCode, at: i, effectiveRange: nil) == nil else { return }
        inline = (c == 47 ? .slash : .emoji, i)
    }

    private func closeInline() {
        inline = nil
        inlineMenu.close()
    }

    private func updateInlineMenu() {
        guard let inl = inline else { inlineMenu.close(); return }
        let text = storage.string as NSString
        let sel = textView.selectedRange()
        let trigger: UInt16 = inl.kind == .slash ? 47 : 58
        guard sel.length == 0, sel.location > inl.start, inl.start < text.length, text.character(at: inl.start) == trigger else { closeInline(); return }
        let query = text.substring(with: NSRange(location: inl.start + 1, length: sel.location - inl.start - 1))
        if query.contains("\n") || query.count > 24 { closeInline(); return }
        var items: [InlineMenu.Item] = []
        switch inl.kind {
        case .slash:
            if query.hasPrefix(" ") || query.contains("  ") { closeInline(); return }
            items = slashItems(query)
        case .emoji:
            if query.contains(" ") { closeInline(); return }
            guard query.count >= 2 else { inlineMenu.close(); return }
            items = EmojiIndex.search(query).map { e in
                InlineMenu.Item(title: e.name.capitalized, emoji: e.emoji) { [weak self] in self?.applyInline(replacement: e.emoji) }
            }
        }
        guard !items.isEmpty else {
            if inl.kind == .slash { closeInline() } else { inlineMenu.close() }
            return
        }
        let rect = textView.firstRect(forCharacterRange: NSRange(location: inl.start, length: 1), actualRange: nil)
        inlineMenu.show(items, below: rect, parent: panel)
    }

    private func slashItems(_ query: String) -> [InlineMenu.Item] {
        let cmds: [NotesCommand] = [.paragraph, .heading1, .heading2, .heading3, .bulletList, .orderedList, .taskList, .quote, .codeBlock]
        var items = cmds.map { cmd in
            InlineMenu.Item(title: cmd.title, symbol: cmd.symbol, shortcut: cmd.shortcut) { [weak self] in
                self?.applyInline(replacement: "")
                self?.runFormatting(cmd)
            }
        }
        items.append(InlineMenu.Item(title: "Divider", symbol: "minus", shortcut: nil) { [weak self] in
            guard let self else { return }
            self.applyInline(replacement: "")
            let tv = self.textView
            let text = tv.string as NSString
            let line = MarkdownCommands.line(at: tv.selectedRange().location, in: text)
            let empty = line.range.length == 0
            let rep = empty ? "---\n" : "\n---\n"
            let loc = empty ? line.range.location : line.end
            tv.apply(EditResult(edits: [TextEdit(range: NSRange(location: loc, length: 0), replacement: rep)],
                                selection: NSRange(location: loc + (rep as NSString).length, length: 0)))
        })
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return items }
        return items.compactMap { i in FuzzyMatch.score(q, i.title).map { (i, $0) } }.sorted { $0.1 > $1.1 }.map(\.0)
    }

    /// Replaces the trigger and query ("/head", ":smi") with `replacement`.
    private func applyInline(replacement: String) {
        guard let inl = inline else { return }
        inline = nil
        let caret = textView.selectedRange().location
        guard caret >= inl.start else { return }
        let r = NSRange(location: inl.start, length: caret - inl.start)
        textView.apply(EditResult(edits: [TextEdit(range: r, replacement: replacement)],
                                  selection: NSRange(location: inl.start + (replacement as NSString).length, length: 0)))
    }

    func textViewDidChangeSelection(_ notification: Notification) {
        guard !loadingNote else { return }
        styler.selectionChanged(storage, to: textView.selectedRange())
        controller.selectionChanged(textView.selectedRange())
        if inline != nil { updateInlineMenu() }
    }

    func textView(_ textView: NSTextView, willChangeSelectionFromCharacterRange old: NSRange, toCharacterRange new: NSRange) -> NSRange {
        guard new.length == 0, !loadingNote else { return new }
        let loc = new.location
        if let e = MarkdownStyler.collapsedSection(at: loc, in: storage) {
            // the caret skips a collapsed section: past it going forward, else to the heading's end
            let text = storage.string as NSString
            let headingEnd = NSMaxRange(MarkdownParser.contentRange(e.heading, in: text))
            let end = NSMaxRange(e.hidden)
            let after = NSMaxRange(text.lineRange(for: NSRange(location: end, length: 0)))
            let target = loc > old.location && end < storage.length ? after : headingEnd
            return NSRange(location: snap(target, previous: old.location) ?? target, length: 0)
        }
        return NSRange(location: snap(loc, previous: old.location) ?? loc, length: 0)
    }

    /// Keeps the caret out of hidden block prefixes using the styler's attributes.
    private func snap(_ loc: Int, previous: Int) -> Int? {
        let text = storage.string as NSString
        guard loc < storage.length || (loc == storage.length && loc > 0) else { return nil }
        let line = text.lineRange(for: NSRange(location: loc, length: 0))
        guard line.location < storage.length, let len = storage.attribute(.notesPrefixLen, at: line.location, effectiveRange: nil) as? Int else { return nil }
        // never past the line's end, even if the attribute is stale
        var lineEnd = NSMaxRange(line)
        if lineEnd > line.location, text.character(at: lineEnd - 1) == 10 { lineEnd -= 1 }
        let contentStart = min(line.location + len, lineEnd)
        guard loc < contentStart else { return nil }
        if previous == contentStart, loc < previous, line.location > 0 { return line.location - 1 }
        return contentStart
    }

    func textView(_ textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        let tv = self.textView
        let text = tv.string as NSString
        let range = tv.selectedRange()
        if inlineMenu.isOpen {
            switch sel {
            case #selector(NSResponder.moveUp(_:)): inlineMenu.move(-1); return true
            case #selector(NSResponder.moveDown(_:)): inlineMenu.move(1); return true
            case #selector(NSResponder.insertNewline(_:)), #selector(NSResponder.insertTab(_:)): inlineMenu.applySelected(); return true
            case #selector(NSResponder.cancelOperation(_:)): closeInline(); return true
            default: break
            }
        }
        switch sel {
        case #selector(NSResponder.insertNewline(_:)):
            if NSApp.currentEvent?.modifierFlags.contains(.shift) == true { return false }
            if let r = MarkdownCommands.newline(text, selection: range) { tv.apply(r); return true }
            return false
        case #selector(NSResponder.insertTab(_:)):
            if let r = MarkdownCommands.indent(text, selection: range, outdent: false) { tv.apply(r); return true }
            return false
        case #selector(NSResponder.insertBacktab(_:)):
            if let r = MarkdownCommands.indent(text, selection: range, outdent: true) { tv.apply(r) }
            return true
        case #selector(NSResponder.deleteBackward(_:)):
            if let r = MarkdownCommands.backspace(text, selection: range) { tv.apply(r); return true }
            return false
        case #selector(NSResponder.deleteForward(_:)):
            if let r = MarkdownCommands.deleteForward(text, selection: range) { tv.apply(r); return true }
            return false
        case #selector(NSResponder.cancelOperation(_:)):
            controller.escapePressed()
            return true
        default:
            return false
        }
    }

    func undoManager(for view: NSTextView) -> UndoManager? { undoManager(for: noteID) }

    private func undoManager(for id: String?) -> UndoManager? {
        guard let id else { return nil }
        if let u = undoManagers[id] { return u }
        let u = UndoManager()
        u.levelsOfUndo = 200
        undoManagers[id] = u
        undoOrder.append(id)
        if undoOrder.count > 12 { undoManagers.removeValue(forKey: undoOrder.removeFirst()) }
        return u
    }

    func forgetUndo(_ id: String) {
        undoManagers.removeValue(forKey: id)?.removeAllActions()
        undoOrder.removeAll { $0 == id }
    }

    // MARK: Commands on the editor

    func runFormatting(_ cmd: NotesCommand) {
        let tv = textView
        let text = tv.string as NSString
        let sel = tv.selectedRange()
        var result: EditResult?
        switch cmd {
        case .bold: result = MarkdownCommands.toggleInline(text, selection: sel, format: .bold)
        case .italic: result = MarkdownCommands.toggleInline(text, selection: sel, format: .italic)
        case .underline: result = MarkdownCommands.toggleInline(text, selection: sel, format: .underline)
        case .strike: result = MarkdownCommands.toggleInline(text, selection: sel, format: .strike)
        case .inlineCode: result = MarkdownCommands.toggleInline(text, selection: sel, format: .code)
        case .heading1: result = MarkdownCommands.setBlock(text, selection: sel, format: .heading(1))
        case .heading2: result = MarkdownCommands.setBlock(text, selection: sel, format: .heading(2))
        case .heading3: result = MarkdownCommands.setBlock(text, selection: sel, format: .heading(3))
        case .paragraph: result = MarkdownCommands.setBlock(text, selection: sel, format: .paragraph)
        case .codeBlock: result = MarkdownCommands.setBlock(text, selection: sel, format: .codeBlock)
        case .quote: result = MarkdownCommands.setBlock(text, selection: sel, format: .quote)
        case .orderedList: result = MarkdownCommands.setBlock(text, selection: sel, format: .ordered)
        case .bulletList: result = MarkdownCommands.setBlock(text, selection: sel, format: .bullet)
        case .taskList: result = MarkdownCommands.setBlock(text, selection: sel, format: .task)
        case .toggleTask:
            // on a heading ⌘↩ collapses or opens its section
            if sel.length == 0, toggleHeading(at: text.lineRange(for: NSRange(location: sel.location, length: 0)).location) { return }
            result = MarkdownCommands.toggleTasks(text, selection: sel)
        case .moveUp: result = MarkdownCommands.moveLines(text, selection: sel, up: true)
        case .moveDown: result = MarkdownCommands.moveLines(text, selection: sel, up: false)
        case .link:
            let pb = NSPasteboard.general.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let url = pb.flatMap { s -> String? in
                guard !s.contains(" "), !s.contains("\n"), let u = URL(string: s), u.scheme == "http" || u.scheme == "https" else { return nil }
                return s
            }
            result = MarkdownCommands.insertLink(text, selection: sel, url: sel.length > 0 ? url : nil)
        default: break
        }
        if let result {
            panel.makeFirstResponder(tv)
            tv.apply(result)
        } else {
            NSSound.beep()
        }
    }

    func showFind() {
        panel.makeFirstResponder(textView)
        let item = NSMenuItem()
        item.tag = Int(NSTextFinder.Action.showFindInterface.rawValue)
        textView.performTextFinderAction(item)
    }

    // MARK: Footer

    private func scheduleCounts() {
        countsWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.updateCounts() }
        countsWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + (storage.length > 20_000 ? 0.6 : 0.15), execute: w)
    }

    func updateCounts() {
        let body = storage.string
        if settings.statusText == "characters" {
            let n = NoteText.characterCount(of: body)
            footer.status = "\(n) Character\(n == 1 ? "" : "s")"
        } else {
            let n = NoteText.wordCount(of: body)
            footer.status = "\(n) Word\(n == 1 ? "" : "s")"
        }
    }

    private func updateSyncIndicator() {
        let st = controller.sync.status
        footer.setSync(symbol: st.state == .disabled ? nil : st.symbol, tooltip: st.summary + (st.lastError.map { "\n\($0)" } ?? ""),
                       warning: !(st.isHealthy || st.state == .connecting))
    }

    // MARK: Key handling (only while the window is key)

    func windowDidBecomeKey(_ notification: Notification) {
        installKeyMonitor()
    }

    func windowDidResignKey(_ notification: Notification) {
        controller.flushPendingSave()
        if NSApp.keyWindow?.parent !== panel { removeKeyMonitor() }
    }

    private func installKeyMonitor() {
        guard keyMonitor == nil else { return }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            guard let self, e.window === self.panel, self.panel.attachedSheet == nil else { return e }
            let mods = e.modifierFlags.intersection([.command, .control, .option, .shift])
            if mods == .command, let c = e.charactersIgnoringModifiers, let d = Int(c), (1...9).contains(d) {
                self.controller.openPinned(d)
                return nil
            }
            if let cmd = NotesCommand.matching(e) {
                // let the find bar keep its own ⌘F/⌘E/⌘G behaviour while it has focus
                if self.panel.firstResponder !== self.textView, cmd.isFormatting { return e }
                self.controller.perform(cmd)
                return nil
            }
            return e
        }
        flagsMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] e in
            if e.window === self?.panel { self?.textView.window?.invalidateCursorRects(for: self!.textView) }
            return e
        }
    }

    private func removeKeyMonitor() {
        if let m = keyMonitor { NSEvent.removeMonitor(m) }
        if let m = flagsMonitor { NSEvent.removeMonitor(m) }
        keyMonitor = nil
        flagsMonitor = nil
    }

    // MARK: Palette

    func showPalette(_ content: PaletteContent) {
        closeInline()
        palette.accent = styler.theme.accent
        palette.show(content, attachedTo: panel, topInset: header.frame.height + 2)
    }

    // MARK: Frame

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        controller.hideWindow()
        return false
    }

    func windowDidMove(_ notification: Notification) { scheduleFrameSave() }
    func windowDidResize(_ notification: Notification) {
        scheduleFrameSave()
        if settings.autoResize, panel.inLiveResize, !autoResizing {
            controller.setAutoResize(false)
        }
    }

    private func scheduleFrameSave() {
        frameSaveWork?.cancel()
        let w = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.controller.store.setKV("window.frame", NSStringFromRect(self.panel.frame))
        }
        frameSaveWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: w)
    }

    private func restoreFrame() {
        if let s = controller.store.kv("window.frame") {
            let r = NSRectFromString(s)
            if r.width.isFinite, r.height.isFinite, r.width >= minSize.width, r.height >= minSize.height, NotesWindowController.isReachable(r) {
                panel.setFrame(r, display: false)
                return
            }
        }
        panel.setFrame(originalFrame(size: NotesWindowController.defaultSize), display: false)
    }

    /// A saved frame from a display that's gone (or dragged almost off-screen) comes back
    /// at the original position; a frame taller/wider than the screen is shrunk to fit.
    private func ensureOnScreen() {
        let f = panel.frame
        if !NotesWindowController.isReachable(f) {
            panel.setFrame(originalFrame(size: f.size), display: false)
        } else if let vf = (panel.screen ?? NSScreen.main)?.visibleFrame, f.height > vf.height || f.width > vf.width {
            var r = f
            r.size.width = max(minSize.width, min(f.width, vf.width))
            r.size.height = max(minSize.height, min(f.height, vf.height))
            r.origin.y = min(max(f.maxY - r.height, vf.minY), vf.maxY - r.height)
            r.origin.x = min(max(r.minX, vf.minX), vf.maxX - r.width)
            panel.setFrame(r, display: false)
        }
    }

    /// Whether enough of the title bar is on a screen to see and drag the window.
    static func isReachable(_ r: NSRect, screens: [NSRect] = NSScreen.screens.map(\.visibleFrame)) -> Bool {
        let titleBar = NSRect(x: r.minX, y: r.maxY - 28, width: r.width, height: 28)
        return screens.contains { vf in
            let i = titleBar.intersection(vf)
            return !i.isNull && i.width >= 80 && i.height >= 12
        }
    }

    /// Raycast's "original position": top right of the screen with the mouse.
    private func originalFrame(size: NSSize) -> NSRect {
        let screen = NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens.first
        let vf = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let w = min(max(minSize.width, size.width), vf.width - 48)
        let h = min(max(minSize.height, size.height), vf.height - 48)
        return NSRect(x: vf.maxX - w - 24, y: vf.maxY - h - 24, width: w, height: h)
    }

    func moveToOriginalPosition(animated: Bool) {
        panel.setFrame(originalFrame(size: panel.frame.size), display: true, animate: animated)
    }

    // MARK: Auto-size

    private var autoResizing = false

    func autoResize() {
        guard settings.autoResize, let container = textView.textContainer else { return }
        layoutManager.ensureLayout(for: container)
        let used = layoutManager.usedRect(for: container).height + textView.textContainerInset.height * 2
        let chrome = header.frame.height + footerHeight.constant
        let screen = panel.screen ?? NSScreen.main
        let maxH = (screen?.visibleFrame.height ?? 900) * 0.85
        let target = min(max(minSize.height, (used + chrome + 8).rounded()), maxH)
        var f = panel.frame
        guard abs(f.height - target) > 1 else { return }
        f.origin.y += f.height - target
        f.size.height = target
        autoResizing = true
        panel.setFrame(f, display: true, animate: false)
        autoResizing = false
    }
}

// MARK: - Window

/// 1-pt separator that follows the appearance.
final class HairlineView: NSView {
    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = NSColor.separatorColor.cgColor
        }
    }
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }
}

/// Darkens/lightens the vibrancy so the window reads like Raycast's (near-black in
/// dark mode, light grey in light mode) while keeping a hint of translucency.
/// Under the other themes it steps aside and lets the theme's surface show.
final class TintView: NSView {
    static let color = NotesTheme.dynamic(dark: NSColor(srgbRed: 0.05, green: 0.05, blue: 0.055, alpha: 0.88),
                                          light: NSColor(srgbRed: 0.965, green: 0.965, blue: 0.97, alpha: 0.82))
    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {
        let themed = ThemeCenter.shared.style.replacesBackground
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = themed ? nil : TintView.color.cgColor
        }
    }
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }
}

final class NotesPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

// MARK: - Header

final class NotesHeaderView: NSView {
    var onAction: ((NotesCommand) -> Void)?
    var onDoubleClick: (() -> Void)?
    private let label = NSTextField(labelWithString: "")
    private let buttons = NSStackView()

    var title: String = "" {
        didSet {
            guard title != oldValue else { return }
            label.stringValue = title
            window?.title = title.isEmpty ? "Notes" : title
        }
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        label.font = .systemFont(ofSize: 13, weight: .regular)
        label.textColor = .secondaryLabelColor
        label.alignment = .center
        label.lineBreakMode = .byTruncatingTail
        label.cell?.truncatesLastVisibleLine = true
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        buttons.orientation = .horizontal
        buttons.spacing = 10
        for cmd in [NotesCommand.actions, .browse, .newNote] {
            let b = ClosureButton(symbol: cmd.symbol, help: cmd.tooltip, pointSize: 14, weight: .regular) { [weak self] in self?.onAction?(cmd) }
            if cmd == .browse { b.image = NotesHeaderView.browseIcon() }
            b.widthAnchor.constraint(equalToConstant: 22).isActive = true
            b.heightAnchor.constraint(equalToConstant: 22).isActive = true
            buttons.addArrangedSubview(b)
        }
        for v in [label, buttons] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            addSubview(v)
        }
        NSLayoutConstraint.activate([
            buttons.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            buttons.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -1),
            label.centerXAnchor.constraint(equalTo: centerXAnchor),
            label.centerYAnchor.constraint(equalTo: buttons.centerYAnchor),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 78),
            label.trailingAnchor.constraint(lessThanOrEqualTo: buttons.leadingAnchor, constant: -8),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    /// Rounded rect with lines, like Raycast's Browse Notes button.
    static func browseIcon() -> NSImage {
        let img = NSImage(size: NSSize(width: 16, height: 16), flipped: true) { r in
            NSColor.black.setStroke()
            let box = NSBezierPath(roundedRect: r.insetBy(dx: 1.5, dy: 1.75), xRadius: 3.5, yRadius: 3.5)
            box.lineWidth = 1.4
            box.stroke()
            for (i, y) in [5.6, 8.2, 10.8].enumerated() {
                let line = NSBezierPath()
                line.move(to: NSPoint(x: 4.6, y: y))
                line.line(to: NSPoint(x: i == 2 ? 9.0 : 11.4, y: y))
                line.lineWidth = 1.3
                line.lineCapStyle = .round
                line.stroke()
            }
            return true
        }
        img.isTemplate = true
        return img
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let v = super.hitTest(point)
        if let v, v is NSButton || v.superview is NSButton { return v }
        return v == nil ? nil : self
    }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            onDoubleClick?()
            return
        }
        window?.performDrag(with: event)
    }

    override var mouseDownCanMoveWindow: Bool { false }
}

// MARK: - Footer

final class NotesFooterView: NSView {
    var onToggleStatus: (() -> Void)?
    var onShowFormatBar: (() -> Void)?
    var onSyncClick: (() -> Void)?
    var statusIsWords = true
    private let label = NSTextField(labelWithString: "")
    private let formatButton = NSButton()
    private let syncButton = ClosureButton(symbol: "checkmark.icloud", help: "", pointSize: 11) {}
    private let line = HairlineView()

    var status: String = "" { didSet { label.stringValue = status } }

    var contentHidden = false {
        didSet {
            label.isHidden = contentHidden
            formatButton.isHidden = contentHidden
            syncButton.isHidden = contentHidden || syncHidden
        }
    }
    private var syncHidden = true

    override init(frame: NSRect) {
        super.init(frame: frame)
        label.font = .systemFont(ofSize: 12)
        label.textColor = .tertiaryLabelColor
        label.alignment = .center
        let click = NSClickGestureRecognizer(target: self, action: #selector(statusClicked))
        label.addGestureRecognizer(click)
        label.toolTip = "Toggle between character count and word count"

        formatButton.isBordered = false
        formatButton.bezelStyle = .regularSquare
        formatButton.attributedTitle = NSAttributedString(string: "T", attributes: [
            .font: NSFont(descriptor: NSFont.systemFont(ofSize: 16).fontDescriptor.withDesign(.serif) ?? NSFont.systemFont(ofSize: 16).fontDescriptor, size: 16) ?? NSFont.systemFont(ofSize: 16),
            .foregroundColor: NSColor.secondaryLabelColor,
        ])
        formatButton.toolTip = NotesCommand.toggleFormatBar.tooltip
        formatButton.target = self
        formatButton.action = #selector(formatClicked)
        syncButton.setHandler { [weak self] in self?.onSyncClick?() }
        syncButton.contentTintColor = .tertiaryLabelColor
        syncButton.isHidden = true

        for v in [line, label, formatButton, syncButton] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            addSubview(v)
        }
        NSLayoutConstraint.activate([
            line.topAnchor.constraint(equalTo: topAnchor),
            line.leadingAnchor.constraint(equalTo: leadingAnchor),
            line.trailingAnchor.constraint(equalTo: trailingAnchor),
            line.heightAnchor.constraint(equalToConstant: 1),
            label.centerXAnchor.constraint(equalTo: centerXAnchor),
            label.centerYAnchor.constraint(equalTo: centerYAnchor, constant: 0.5),
            formatButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            formatButton.centerYAnchor.constraint(equalTo: centerYAnchor, constant: 0.5),
            formatButton.widthAnchor.constraint(equalToConstant: 22),
            syncButton.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 13),
            syncButton.centerYAnchor.constraint(equalTo: centerYAnchor, constant: 0.5),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }


    func setSync(symbol: String?, tooltip: String, warning: Bool) {
        syncHidden = symbol == nil
        if let symbol { syncButton.image = NSImage(systemSymbolName: symbol, accessibilityDescription: tooltip) }
        syncButton.toolTip = tooltip + "\nClick to sync now"
        syncButton.contentTintColor = warning ? .systemOrange.withAlphaComponent(0.8) : .tertiaryLabelColor
        syncButton.isHidden = contentHidden || syncHidden
    }

    @objc private func statusClicked() { onToggleStatus?() }
    @objc private func formatClicked() { onShowFormatBar?() }
}

// MARK: - Format bar

final class NotesFormatBar: NSView {
    var onCommand: ((NotesCommand) -> Void)?
    var onClose: (() -> Void)?
    private let stack = NSStackView()
    private let line = HairlineView()

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        stack.orientation = .horizontal
        stack.spacing = 2
        stack.distribution = .fill

        let heading = ClosureButton(symbol: "h.square", help: "Heading", pointSize: 13) {}
        heading.image = NotesFormatBar.headingImage()
        heading.setHandler { [weak self, weak heading] in
            guard let self, let heading else { return }
            let menu = NSMenu()
            for cmd in [NotesCommand.heading1, .heading2, .heading3, .paragraph] {
                let item = ClosureMenuItem(title: cmd.title) { [weak self] in self?.onCommand?(cmd) }
                if let sc = cmd.shortcut, let (k, m) = sc.menuKeyEquivalent { item.keyEquivalent = k; item.keyEquivalentModifierMask = m }
                menu.addItem(item)
            }
            menu.popUp(positioning: nil, at: NSPoint(x: 0, y: heading.bounds.maxY + 4), in: heading)
        }
        stack.addArrangedSubview(sized(heading, width: 34))
        for cmd in [NotesCommand.bold, .italic, .strike, .inlineCode, .link, .codeBlock, .quote, .orderedList, .bulletList, .taskList] {
            let b = ClosureButton(symbol: cmd.symbol, help: cmd.tooltip, pointSize: 13) { [weak self] in self?.onCommand?(cmd) }
            stack.addArrangedSubview(sized(b, width: 26))
        }
        let divider = HairlineView()
        let close = ClosureButton(symbol: "xmark.circle.fill", help: "Hide Format Bar  ⌥⌘,", pointSize: 14) { [weak self] in self?.onClose?() }
        close.contentTintColor = .tertiaryLabelColor
        for v in [line, stack, divider, close] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            addSubview(v)
        }
        NSLayoutConstraint.activate([
            line.topAnchor.constraint(equalTo: topAnchor),
            line.leadingAnchor.constraint(equalTo: leadingAnchor),
            line.trailingAnchor.constraint(equalTo: trailingAnchor),
            line.heightAnchor.constraint(equalToConstant: 1),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor, constant: 0.5),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: divider.leadingAnchor, constant: -6),
            close.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            close.centerYAnchor.constraint(equalTo: centerYAnchor, constant: 0.5),
            divider.trailingAnchor.constraint(equalTo: close.leadingAnchor, constant: -10),
            divider.centerYAnchor.constraint(equalTo: centerYAnchor, constant: 0.5),
            divider.widthAnchor.constraint(equalToConstant: 1),
            divider.heightAnchor.constraint(equalToConstant: 18),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    private func sized(_ v: NSView, width: CGFloat) -> NSView {
        v.widthAnchor.constraint(equalToConstant: width).isActive = true
        v.heightAnchor.constraint(equalToConstant: 26).isActive = true
        return v
    }


    /// "H⌄" like Raycast's heading dropdown.
    static func headingImage() -> NSImage {
        let img = NSImage(size: NSSize(width: 26, height: 16), flipped: false) { _ in
            let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 15, weight: .semibold), .foregroundColor: NSColor.black]
            ("H" as NSString).draw(at: NSPoint(x: 1, y: -1), withAttributes: attrs)
            if let chev = NSImage(systemSymbolName: "chevron.down", accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: 8, weight: .bold)) {
                chev.draw(in: NSRect(x: 15, y: 4, width: 8, height: 6))
            }
            return true
        }
        img.isTemplate = true
        return img
    }
}
