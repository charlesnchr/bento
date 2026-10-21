import AppKit
import SwiftUI
import BentoCore

/// The floating history panel. It is a non-activating panel, so the app the
/// user was working in stays active and pasting only needs ⌘V. Created on
/// show and torn down on close (nothing is kept while hidden).
final class ClipboardPanel: NSObject, NSWindowDelegate {
    private unowned let module: ClipboardModule
    private var window: KeyablePanel?
    private var model: PanelModel?
    private var keyMonitor: Any?
    private var storeObserver: NSObjectProtocol?
    private var menuOpen = false
    private(set) var targetApp: NSRunningApplication?
    /// Bento's own window that had focus when the panel opened.
    private weak var returnWindow: NSWindow?
    private let log = BentoLog.make("clipboard")

    static let size = NSSize(width: 820, height: 500)

    init(module: ClipboardModule) {
        self.module = module
    }

    var isVisible: Bool { window?.isVisible == true }

    // MARK: Show / close

    func show() {
        guard let store = module.store else { return }
        if let window, window.isVisible {
            window.makeKeyAndOrderFront(nil)
            return
        }
        let started = DispatchTime.now()
        defer {
            let ms = Double(DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1e6
            log.debug("panel shown in \(ms, format: .fixed(precision: 1), privacy: .public) ms")
        }
        // Opened over one of Bento's own windows (notes, editor): paste there
        // and give it focus back on close.
        let ownKey = NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid() ? NSApp.keyWindow : nil
        returnWindow = ownKey
        targetApp = ClipboardModule.pasteTarget()

        ImageCache.storeRef = store
        let model = PanelModel(store: store, settings: module.settings, targetApp: targetApp, state: module.state)
        model.perform = { [weak self] in self?.perform($0) }
        self.model = model

        let w = KeyablePanel(contentRect: NSRect(origin: .zero, size: Self.size),
                             styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel],
                             backing: .buffered, defer: true)
        w.title = "Clipboard History" // not shown; for VoiceOver and window lists
        w.titleVisibility = .hidden
        w.titlebarAppearsTransparent = true
        for b in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] { w.standardWindowButton(b)?.isHidden = true }
        w.isMovableByWindowBackground = true
        w.isFloatingPanel = true
        w.level = .floating
        w.hidesOnDeactivate = false
        w.becomesKeyOnlyIfNeeded = false
        w.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary, .transient, .ignoresCycle]
        w.isReleasedWhenClosed = false
        w.animationBehavior = .utilityWindow
        w.isOpaque = false
        w.backgroundColor = .clear
        w.delegate = self
        if ProcessInfo.processInfo.environment["BENTO_DEV"] != nil,
           let a = ProcessInfo.processInfo.environment["BENTO_APPEARANCE"] {
            w.appearance = NSAppearance(named: a == "dark" ? .darkAqua : .aqua)
        }

        let effect = NSVisualEffectView()
        effect.material = .popover
        effect.blendingMode = .behindWindow
        effect.state = .active
        let host = NSHostingView(rootView: ClipboardPanelView(model: model))
        host.sizingOptions = []
        host.translatesAutoresizingMaskIntoConstraints = false
        effect.addSubview(host)
        NSLayoutConstraint.activate([
            host.leadingAnchor.constraint(equalTo: effect.leadingAnchor),
            host.trailingAnchor.constraint(equalTo: effect.trailingAnchor),
            host.topAnchor.constraint(equalTo: effect.topAnchor),
            host.bottomAnchor.constraint(equalTo: effect.bottomAnchor),
        ])
        w.contentView = effect

        let screen = NSScreen.underMouse ?? NSScreen.main
        if let vf = screen?.visibleFrame {
            let x = vf.midX - Self.size.width / 2
            let y = vf.minY + (vf.height - Self.size.height) * 0.62
            w.setFrame(NSRect(x: x.rounded(), y: y.rounded(), width: Self.size.width, height: Self.size.height), display: false)
        }
        window = w
        w.makeKeyAndOrderFront(nil)
        w.orderFrontRegardless()
        focusSearch()

        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            guard let self, let w = self.window, e.window === w else { return e }
            return self.handleKey(e) ? nil : e
        }
        storeObserver = NotificationCenter.default.addObserver(forName: ClipStore.didChange, object: store, queue: .main) { [weak self] _ in
            self?.model?.reload()
        }
    }

    /// `restoreFocus`: give keyboard focus back to the Bento window the panel
    /// was opened over (not when the user clicked somewhere else).
    func close(restoreFocus: Bool = true) {
        guard let w = window else { return }
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        keyMonitor = nil
        if let storeObserver { NotificationCenter.default.removeObserver(storeObserver) }
        storeObserver = nil
        window = nil
        model = nil
        w.delegate = nil
        w.orderOut(nil)
        w.contentView = nil
        ImageCache.shared.purge()
        if restoreFocus, let r = returnWindow, r.isVisible, !r.isKeyWindow { r.makeKey() }
        returnWindow = nil
    }

    private func focusSearch() {
        guard let w = window else { return }
        // The SwiftUI hierarchy creates the field during the first layout.
        w.contentView?.layoutSubtreeIfNeeded()
        if let f = model?.searchField { w.makeFirstResponder(f) }
        DispatchQueue.main.async { [weak self] in
            guard let self, let w = self.window, let f = self.model?.searchField, w.firstResponder !== f.currentEditor() else { return }
            w.makeFirstResponder(f)
        }
    }

    func windowDidResignKey(_ notification: Notification) {
        // Clicking elsewhere dismisses the panel, like Spotlight/Raycast.
        guard !menuOpen, !module.presentingAlert else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, let w = self.window, !w.isKeyWindow, !self.menuOpen else { return }
            self.close(restoreFocus: false)
        }
    }

    // MARK: Keyboard

    private static let digitKeys: [UInt16: Int] = [18: 0, 19: 1, 20: 2, 21: 3, 23: 4, 22: 5, 26: 6, 28: 7, 25: 8]

    /// Returns true when the key was handled (otherwise it goes to the search field).
    private func handleKey(_ e: NSEvent) -> Bool {
        guard let model else { return false }
        // While an input method composes (dead keys, CJK), ↵ and the arrows are its keys.
        if let editor = model.searchField?.currentEditor() as? NSTextView, editor.hasMarkedText() { return false }
        let mods = e.modifierFlags.intersection([.command, .option, .control, .shift])
        switch (e.keyCode, mods) {
        case (51, [.command]) where !model.query.isEmpty: return false                 // ⌘⌫ edits the search text
        case (125, []), (45, [.control]), (38, [.control]): model.move(1)              // ↓ ⌃N ⌃J
        case (126, []), (35, [.control]), (40, [.control]): model.move(-1)             // ↑ ⌃P ⌃K
        case (121, []): model.move(8)                                                  // page down
        case (116, []): model.move(-8)                                                 // page up
        case (125, [.command]), (119, []): model.moveToEnd(true)
        case (126, [.command]), (115, []): model.moveToEnd(false)
        case (36, _), (76, _): handleReturn(mods)
        case (53, []): if model.query.isEmpty { close() } else { model.query = "" }   // Esc clears, then closes (Spotlight)
        case (51, [.command]), (7, [.control]): perform(.delete)                       // ⌘⌫, ⌃X (Raycast)
        case (51, [.command, .shift]), (7, [.control, .shift]): perform(.clearAll)     // ⇧⌘⌫, ⌃⇧X
        case (35, [.command, .shift]): perform(.togglePin)
        case (35, [.command]): model.cycleFilter()
        case (40, [.command]): perform(.actionsMenu)
        case (31, [.command]): perform(.open)
        case (3, [.command, .shift]): perform(.reveal)
        case (17, [.command, .shift]): perform(.ocrCopy)
        case (13, [.command]), (12, [.command]): close()                               // ⌘W, ⌘Q
        case let (code, m) where m == [.command] && Self.digitKeys[code] != nil:
            perform(.pasteIndex(Self.digitKeys[code]!))
        default:
            return false
        }
        return true
    }

    private func handleReturn(_ mods: NSEvent.ModifierFlags) {
        guard let model else { return }
        switch mods {
        case [.command]: model.primaryIsPaste ? perform(.copy) : perform(.paste(plain: defaultPlain))
        case [.shift], [.option]: perform(.paste(plain: !defaultPlain || !isTextual))
        default: model.primaryIsPaste ? perform(.paste(plain: defaultPlain)) : perform(.copy)
        }
    }

    private var isTextual: Bool { model?.selectedRow.map { module.isTextual($0.kind) } ?? true }

    /// Plain text by default applies to text only; files and images paste as themselves.
    private var defaultPlain: Bool { isTextual && module.settings.pastePlainTextByDefault }

    // MARK: Actions

    func perform(_ action: PanelModel.Action) {
        guard let model else { return }
        let row = model.selectedRow
        switch action {
        case .primary:
            handleReturn([])
        case .paste(let plain):
            if let row { module.paste(row.id, plain: plain, copyOnly: false) }
        case .copy:
            if let row { module.paste(row.id, plain: defaultPlain, copyOnly: true) }
        case .pasteIndex(let i):
            guard model.rows.indices.contains(i) else { NSSound.beep(); return }
            let r = model.rows[i]
            let plain = module.isTextual(r.kind) && module.settings.pastePlainTextByDefault
            module.paste(r.id, plain: plain, copyOnly: !model.primaryIsPaste)
        case .delete:
            guard let row, let i = model.selectedIndex else { return }
            module.delete(row.id)
            model.reload(preferIndex: i)
        case .togglePin:
            if let row { module.setPinned(row.id, !row.pinned) }
        case .open:
            guard let d = model.detail else { return }
            if let url = openURL(d) { close(); NSWorkspace.shared.open(url) } else { NSSound.beep() }
        case .reveal:
            guard let d = model.detail else { return }
            let urls = revealURLs(d)
            if urls.isEmpty { NSSound.beep(); return }
            close()
            NSWorkspace.shared.activateFileViewerSelecting(urls)
        case .ocrCopy:
            guard let row, row.kind == .image else { NSSound.beep(); return }
            close()
            module.copyTextFromImage(row.id)
        case .actionsMenu:
            showActionsMenu()
        case .clearAll:
            module.confirmClear()
        case .close:
            close()
        }
    }

    private func openURL(_ d: ClipDetail) -> URL? {
        switch d.kind {
        case .link: return d.text.flatMap(ContentDetection.linkURL)
        case .file: return d.fileURLs.first
        case .image: return module.store?.imageURL(d.imageFile)
        case .text, .color: return nil
        }
    }

    private func revealURLs(_ d: ClipDetail) -> [URL] {
        switch d.kind {
        case .file: return d.fileURLs.filter { FileManager.default.fileExists(atPath: $0.path) }
        case .image: return [module.store?.imageURL(d.imageFile)].compactMap { $0 }
        default: return []
        }
    }

    /// ⌘K: native menu of everything you can do with the selected item.
    private func showActionsMenu() {
        guard let model, let content = window?.contentView else { return }
        let menu = NSMenu()
        menu.autoenablesItems = false
        func add(_ title: String, _ symbol: String, key: String = "", mods: NSEvent.ModifierFlags = [], enabled: Bool = true,
                 _ action: @escaping () -> Void) {
            let item = ClosureMenuItem(title: title, keyEquivalent: key) { action() }
            item.keyEquivalentModifierMask = mods
            item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
            item.isEnabled = enabled
            menu.addItem(item)
        }
        if let row = model.selectedRow, let d = model.detail {
            let textual = module.isTextual(row.kind)
            let paste = { [weak self] (plain: Bool) in self?.perform(.paste(plain: plain)) }
            if model.primaryIsPaste {
                add("Paste to \(model.targetName)", "doc.on.clipboard", key: "\r") { paste(self.defaultPlain) }
                add("Copy to Clipboard", "doc.on.doc", key: "\r", mods: .command) { [weak self] in self?.perform(.copy) }
            } else {
                add("Copy to Clipboard", "doc.on.doc", key: "\r") { [weak self] in self?.perform(.copy) }
                add("Paste to \(model.targetName)", "doc.on.clipboard", key: "\r", mods: .command) { paste(self.defaultPlain) }
            }
            if textual {
                let plainDefault = module.settings.pastePlainTextByDefault
                add(plainDefault ? "Paste with Formatting" : "Paste as Plain Text", "textformat", key: "\r", mods: .shift) {
                    paste(!plainDefault)
                }
            } else if row.kind == .file {
                add("Paste File Path", "text.cursor", key: "\r", mods: .shift) { paste(true) }
            }
            menu.addItem(.separator())
            add(row.pinned ? "Unpin" : "Pin", row.pinned ? "pin.slash" : "pin", key: "p", mods: [.command, .shift]) { [weak self] in
                self?.perform(.togglePin)
            }
            switch row.kind {
            case .link:
                add("Open in Browser", "safari", key: "o", mods: .command) { [weak self] in self?.perform(.open) }
            case .file:
                add("Open", "arrow.up.forward.app", key: "o", mods: .command) { [weak self] in self?.perform(.open) }
                add("Show in Finder", "folder", key: "f", mods: [.command, .shift], enabled: !revealURLs(d).isEmpty) { [weak self] in
                    self?.perform(.reveal)
                }
            case .image:
                add("Open in Preview", "arrow.up.forward.app", key: "o", mods: .command) { [weak self] in self?.perform(.open) }
                add("Show in Finder", "folder", key: "f", mods: [.command, .shift]) { [weak self] in self?.perform(.reveal) }
                add("Copy Text from Image", "text.viewfinder", key: "t", mods: [.command, .shift]) { [weak self] in self?.perform(.ocrCopy) }
            case .text, .color:
                break
            }
            menu.addItem(.separator())
            add("Delete", "trash", key: "\u{8}", mods: .command) { [weak self] in self?.perform(.delete) }
        }
        add("Clear History…", "trash.slash", key: "\u{8}", mods: [.command, .shift]) { [weak self] in self?.perform(.clearAll) }
        menu.addItem(.separator())
        add(module.state.paused ? "Resume Monitoring" : "Pause Monitoring",
            module.state.paused ? "play.circle" : "pause.circle") { [weak self] in self?.module.togglePause() }

        menuOpen = true
        let size = menu.size
        let origin = NSPoint(x: content.bounds.maxX - size.width - 10, y: 44 + size.height)
        menu.popUp(positioning: nil, at: origin, in: content)
        menuOpen = false
        // Menu items run after tracking ends; re-focus the search field if still open.
        DispatchQueue.main.async { [weak self] in
            guard let self, let w = self.window else { return }
            if !w.isKeyWindow { w.makeKey() }
            self.focusSearch()
        }
    }
}
