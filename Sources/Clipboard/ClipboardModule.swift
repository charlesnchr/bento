import AppKit
import SwiftUI
import BentoCore

/// Observable runtime state shared by the panel, menu and settings.
final class ClipboardState: ObservableObject {
    @Published var paused = false
}

/// Clipboard history: records text, rich text, images, files, links and
/// colours; a Raycast-style panel (⌘⇧V) searches and pastes them back.
public final class ClipboardModule: BentoModule {
    public let id = "clipboard"
    public let title = "Clipboard"
    public let symbol = "doc.on.clipboard"

    /// Source "app" recorded for copies made by Bento itself (e.g. screenshots).
    static let selfBundleID = "com.charles.bento"

    private(set) var settings = ClipboardSettings()
    private(set) var store: ClipStore?
    let state = ClipboardState()
    private var monitor: PasteboardMonitor?
    private var ocr: OCRWorker?
    private lazy var panel = ClipboardPanel(module: self)
    private var pruneTimer: Timer?
    private var lastPrune = Date.distantPast
    private var configObserver: NSObjectProtocol?
    private let imageQueue = DispatchQueue(label: "com.charles.bento.clipboard.images", qos: .utility)
    /// Read lazily: dev harnesses set BENTO_DEV after modules are created.
    private var devMode: Bool { ProcessInfo.processInfo.environment["BENTO_DEV"] != nil }
    /// Dev only: `BENTO_CLIPBOARD_PASTEBOARD=<name>` records a private named
    /// pasteboard instead of the general one, so capture stress tests never
    /// touch the user's clipboard (scripts/e2e/clipboard.sh stress).
    private var monitoredPasteboard: NSPasteboard {
        guard devMode, let name = ProcessInfo.processInfo.environment["BENTO_CLIPBOARD_PASTEBOARD"], !name.isEmpty else { return .general }
        return NSPasteboard(name: NSPasteboard.Name(name))
    }
    private let log = BentoLog.make("clipboard")
    /// True while a modal alert is up (the panel must not auto-close then).
    private(set) var presentingAlert = false

    public init() {}

    public var actions: [BentoAction] {
        [
            BentoAction("clipboard.show", "Clipboard History", shortcut: "cmd+shift+v") { [weak self] in self?.togglePanel() },
            BentoAction("clipboard.paste-previous", "Paste Previous Item") { [weak self] in self?.pastePrevious() },
            BentoAction("clipboard.paste-plain", "Paste as Plain Text") { [weak self] in self?.pasteCurrentAsPlainText() },
            BentoAction("clipboard.toggle-pause", "Pause / Resume Monitoring") { [weak self] in self?.togglePause() },
            BentoAction("clipboard.clear", "Clear History…") { [weak self] in self?.confirmClear() },
        ]
    }

    // MARK: Lifecycle

    public func start() {
        ConfigStore.shared.materialize(id, default: ClipboardSettings())
        settings = ConfigStore.shared.section(id, default: ClipboardSettings())
        do {
            store = try ClipStore(directory: AppPaths.support("Clipboard"))
        } catch {
            log.error("cannot open clipboard history: \(String(describing: error), privacy: .public)")
            return
        }
        store?.removeOrphanFiles()
        prune()

        let m = PasteboardMonitor(pasteboard: monitoredPasteboard)
        m.onChange = { [weak self] pb in self?.capture(pb) }
        monitor = m
        if !state.paused { m.start() }

        if let store {
            let worker = OCRWorker(store: store)
            worker.enabled = settings.recognizeTextInImages
            ocr = worker
            // Let launch settle before recognising any backlog.
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in self?.ocr?.kick() }
        }

        // Daily retention pass (a timer that fires once a day, not a poll).
        let t = Timer(timeInterval: 86_400, repeats: true) { [weak self] _ in self?.prune() }
        t.tolerance = 3_600
        RunLoop.main.add(t, forMode: .common)
        pruneTimer = t

        configObserver = ConfigStore.shared.observe(id) { [weak self] in self?.settingsChanged() }
    }

    public func stop() {
        panel.close()
        monitor?.stop()
        monitor = nil
        pruneTimer?.invalidate()
        pruneTimer = nil
        ocr = nil
        store = nil
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        configObserver = nil
    }

    private func settingsChanged() {
        let old = settings
        settings = ConfigStore.shared.section(id, default: ClipboardSettings())
        ocr?.enabled = settings.recognizeTextInImages
        if settings.recognizeTextInImages && !old.recognizeTextInImages { ocr?.kick() }
        if settings.retentionDays != old.retentionDays || settings.maxItems != old.maxItems || settings.maxStorageMB != old.maxStorageMB {
            prune()
        }
    }

    func prune() {
        lastPrune = Date()
        store?.prune(retentionDays: settings.retentionDays, maxItems: settings.maxItems,
                     maxBytes: settings.maxStorageMB * 1024 * 1024)
    }

    // MARK: Capture

    private func capture(_ pb: NSPasteboard) {
        guard let store, !state.paused else { return }
        let front = NSWorkspace.shared.frontmostApplication
        let isSelf = front?.processIdentifier == getpid()
        if !isSelf, let bid = front?.bundleIdentifier, settings.ignoredApps.contains(bid) { return }
        guard let snap = PasteboardReader.read(pb, settings: settings, devMode: devMode),
              let pending = ClipClassifier.classify(snap, settings: settings) else { return }
        let sourceApp = isSelf ? "Bento" : front?.localizedName
        let sourceBundle = isSelf ? Self.selfBundleID : front?.bundleIdentifier

        switch pending {
        case .ready(var d):
            d.sourceApp = sourceApp
            d.sourceBundleID = sourceBundle
            insert(d)
        case .image(let data, let type, let hash):
            if store.id(forHash: hash) != nil {
                insert(ClipDraft(kind: .image, sourceApp: sourceApp, sourceBundleID: sourceBundle, hash: hash))
                return
            }
            let imagesDir = store.imagesDir, thumbsDir = store.thumbsDir
            imageQueue.async { [weak self] in
                let stored = autoreleasepool { ImageProcessor.store(data: data, type: type, imagesDir: imagesDir, thumbsDir: thumbsDir) }
                DispatchQueue.main.async {
                    guard let self, let stored else { return }
                    var d = ClipDraft(kind: .image, hash: hash)
                    d.imageFile = stored.imageFile
                    d.thumbFile = stored.thumbFile
                    d.imageType = stored.imageType
                    d.width = stored.width
                    d.height = stored.height
                    d.byteSize = stored.bytes
                    d.sourceApp = sourceApp
                    d.sourceBundleID = sourceBundle
                    self.insert(d)
                    self.ocr?.kick()
                }
            }
        }
    }

    private func insert(_ d: ClipDraft) {
        guard let store else { return }
        do {
            let r = try store.upsert(d)
            if r.inserted { enforceLimits() }
        } catch {
            log.error("insert failed: \(String(describing: error), privacy: .public)")
            store.recoverIfCorrupt(error)
        }
    }

    private func enforceLimits() {
        store?.prune(retentionDays: 0, maxItems: settings.maxItems, maxBytes: settings.maxStorageMB * 1024 * 1024)
    }

    // MARK: Panel

    func togglePanel() {
        guard store != nil else { return }
        if panel.isVisible {
            panel.close()
        } else {
            if Date().timeIntervalSince(lastPrune) > 3_600 { prune() }
            panel.show()
        }
    }

    // MARK: Paste / copy

    /// Writes an entry to the pasteboard; then (unless `copyOnly`) closes the
    /// panel, re-activates the previous app and sends ⌘V.
    func paste(_ id: Int64, plain: Bool, copyOnly: Bool, target: NSRunningApplication? = nil) {
        guard let store, let d = store.detail(id) else { return }
        guard PasteboardWriter.write(d, plain: plain, store: store) else {
            HUD.show("Item is no longer available", symbol: "exclamationmark.triangle")
            return
        }
        monitor?.skipCurrentChange()
        store.touch(id)
        let target = target ?? panel.targetApp ?? AppActivation.previousApp
        panel.close()
        if copyOnly {
            HUD.show("Copied to Clipboard", symbol: "doc.on.doc")
            return
        }
        guard Permissions.accessibility else {
            HUD.show("Copied – allow Accessibility to paste", symbol: "exclamationmark.triangle")
            return
        }
        sendPaste(to: target)
    }

    /// ⌘V once `target` is frontmost (it normally already is: the panel never
    /// activates Bento). Gives up quietly after ~0.6 s.
    private func sendPaste(to target: NSRunningApplication?, attempt: Int = 0) {
        let front = NSWorkspace.shared.frontmostApplication
        if let target, target.processIdentifier != getpid(), front?.processIdentifier != target.processIdentifier {
            if attempt == 0 { target.activate() }
            if attempt < 12 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in self?.sendPaste(to: target, attempt: attempt + 1) }
                return
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + (attempt == 0 ? 0.08 : 0.12)) { Keyboard.paste() }
    }

    func pastePrevious() {
        guard let store, let row = store.latest(offset: 1) else {
            HUD.show("No previous item", symbol: "doc.on.clipboard")
            return
        }
        paste(row.id, plain: isTextual(row.kind) && settings.pastePlainTextByDefault, copyOnly: false,
              target: Self.pasteTarget())
    }

    /// The app ⌘V should go to: the frontmost app, or Bento itself when one
    /// of its own windows (notes, screenshot editor, settings) has focus.
    static func pasteTarget() -> NSRunningApplication? {
        let front = NSWorkspace.shared.frontmostApplication
        guard front?.processIdentifier == getpid() else { return front }
        return NSApp.keyWindow != nil ? NSRunningApplication.current : AppActivation.previousApp
    }

    func pasteCurrentAsPlainText() {
        guard PasteboardWriter.stripFormatting() else {
            HUD.show("No text on the clipboard", symbol: "doc.on.clipboard")
            return
        }
        monitor?.skipCurrentChange()
        guard Permissions.accessibility else { return }
        sendPaste(to: NSWorkspace.shared.frontmostApplication)
    }

    /// Copies a string Bento produced (e.g. recognised text) and records it.
    func copyGeneratedText(_ text: String) {
        let pb = NSPasteboard.general
        let item = NSPasteboardItem()
        item.setString(text, forType: .string)
        PasteboardWriter.mark(item)
        pb.clearContents()
        pb.writeObjects([item])
        monitor?.skipCurrentChange()
        insert(ClipDraft(kind: ContentDetection.kind(forText: text), text: text, byteSize: text.utf8.count,
                         sourceApp: "Bento", sourceBundleID: Self.selfBundleID, hash: ClipClassifier.hash("text", text)))
    }

    func copyTextFromImage(_ id: Int64) {
        guard let store, let d = store.detail(id), d.kind == .image else { return }
        let finish: (String?) -> Void = { [weak self] text in
            guard let text, !text.isEmpty else {
                HUD.show("No text found in image", symbol: "text.viewfinder")
                return
            }
            self?.copyGeneratedText(text)
            HUD.show("Copied Text from Image", symbol: "text.viewfinder")
        }
        if d.ocrDone {
            finish(d.ocrText)
        } else if let url = store.imageURL(d.imageFile) {
            if let ocr { ocr.recognizeNow(id: id, url: url, completion: finish) }
            else { finish(TextRecognition.recognize(url: url)) }
        }
    }

    func isTextual(_ kind: ClipKind) -> Bool { kind == .text || kind == .link || kind == .color }

    // MARK: Other actions

    func togglePause() {
        state.paused.toggle()
        if state.paused {
            monitor?.stop()
            HUD.show("Clipboard History Paused", symbol: "pause.circle")
        } else {
            monitor?.start()
            HUD.show("Clipboard History Resumed", symbol: "play.circle")
        }
    }

    func setPinned(_ id: Int64, _ pinned: Bool) { store?.setPinned(id, pinned) }

    func delete(_ id: Int64) { store?.delete(id) }

    func confirmClear() {
        guard let store else { return }
        let stats = store.stats()
        panel.close()
        // From Bento's own settings window, focus stays there afterwards.
        let previous = NSApp.isActive ? nil : AppActivation.previousApp
        presentingAlert = true
        defer { presentingAlert = false }
        AppActivation.activateSelf()
        let alert = NSAlert()
        alert.messageText = "Clear clipboard history?"
        let unpinned = stats.count - stats.pinned
        alert.informativeText = stats.pinned > 0
            ? "This deletes \(unpinned) item\(unpinned == 1 ? "" : "s"). \(stats.pinned) pinned item\(stats.pinned == 1 ? " is" : "s are") kept unless you tick the box below."
            : "This deletes \(stats.count) item\(stats.count == 1 ? "" : "s") and cannot be undone."
        alert.alertStyle = .warning
        let clear = alert.addButton(withTitle: "Clear History")
        clear.hasDestructiveAction = true
        let cancel = alert.addButton(withTitle: "Cancel")
        // Irreversible: Return cancels; clearing needs a deliberate click.
        clear.keyEquivalent = ""
        cancel.keyEquivalent = "\r"
        if stats.pinned > 0 {
            alert.showsSuppressionButton = true
            alert.suppressionButton?.title = "Also delete pinned items"
        }
        let response = alert.runModal()
        if response == .alertFirstButtonReturn {
            store.clear(includePinned: alert.suppressionButton?.state == .on)
            HUD.show("Clipboard History Cleared", symbol: "trash")
        }
        if let previous, previous.processIdentifier != getpid() { previous.activate() }
    }

    // MARK: Menu & settings

    public func menuItems() -> [NSMenuItem] {
        let parent = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        parent.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        let sub = NSMenu()
        let reg = ActionRegistry.shared
        for a in actions {
            if a.id == "clipboard.toggle-pause" {
                let item = reg.menuItem(for: a)
                item.title = state.paused ? "Resume Monitoring" : "Pause Monitoring"
                sub.addItem(.separator())
                sub.addItem(item)
            } else {
                sub.addItem(reg.menuItem(for: a))
            }
        }
        parent.submenu = sub
        return [parent]
    }

    public func makeSettingsView() -> AnyView? {
        AnyView(ClipboardSettingsView(module: self))
    }
}
