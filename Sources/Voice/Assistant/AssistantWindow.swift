import AppKit
import SwiftUI
import UniformTypeIdentifiers

@MainActor
final class AssistantWindow: NSObject, NSWindowDelegate {
    private final class Panel: NSPanel {
        var hide: (() -> Void)?
        var key: ((NSEvent) -> Bool)?
        override var canBecomeKey: Bool { true }
        override var canBecomeMain: Bool { true }
        override func cancelOperation(_ sender: Any?) { hide?() }
        override func sendEvent(_ event: NSEvent) {
            if event.type == .keyDown, attachedSheet == nil, key?(event) == true { return }
            super.sendEvent(event)
        }
    }
    private let panel = Panel(contentRect: NSRect(x: 0, y: 0, width: 650, height: 650),
        styleMask: [.titled, .closable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
    let model = AssistantChatModel()
    var onHide: (() -> Void)?
    private var origin: NSRunningApplication?
    private lazy var placement = AssistantWindowPlacement(window: panel)
    var isKey: Bool { panel.isKeyWindow }
    var frame: NSRect { panel.frame }
    /// Dev harness only: moves the window as a user drag would (saved like one).
    func devSetFrame(_ frame: NSRect) {
        panel.setFrame(frame, display: true)
        placement.save()
    }
    var isVisible: Bool { panel.isVisible }

    override init() {
        super.init()
        panel.title = "Bento Assistant"
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.collectionBehavior = [.fullScreenAuxiliary, .moveToActiveSpace]
        panel.isReleasedWhenClosed = false
        panel.minSize = NSSize(width: 610, height: 420)
        panel.delegate = self
        NotificationCenter.default.addObserver(self, selector: #selector(screenParametersChanged),
            name: NSApplication.didChangeScreenParametersNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(willTerminate),
            name: NSApplication.willTerminateNotification, object: nil)
        for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] { panel.standardWindowButton(button)?.isHidden = true }
        let host = NSHostingView(rootView: AssistantChatView(model: model))
        // The frame is the user's (AssistantWindowPlacement): SwiftUI's ideal
        // size must not resize the window as conversations and panes change.
        host.sizingOptions = []
        panel.contentView = host
        panel.hide = { [weak self] in self?.hide() }
        panel.key = { [weak self] in self?.handle($0) ?? false }
    }

    /// Window-scoped shortcuts. Escape closes the innermost transient UI, then hides the window.
    private func handle(_ event: NSEvent) -> Bool {
        if let editor = panel.firstResponder as? NSTextView, editor.hasMarkedText() { return false }
        if event.keyCode == 53, AssistantShortcuts.flags(event).isEmpty {
            if !model.escape() { hide() }
            return true
        }
        if model.paletteVisible, AssistantShortcuts.flags(event).isEmpty {
            switch event.keyCode {
            case 126: model.movePalette(-1); return true
            case 125: model.movePalette(1); return true
            case 36, 76: model.runPalette(); return true
            default: break
            }
        }
        guard let action = AssistantShortcuts.action(for: event) else { return false }
        return model.perform(action)
    }

    func clear() { model.select(nil); model.messages = []; model.plan = []; model.status = "New conversation" }
    func begin(_ message: AssistantMessage, activate: Bool, reveal: Bool = true) {
        model.messages.append(message)
        model.messages.append(AssistantMessage(role: "assistant", text: ""))
        setStatus("Connecting to Hermes...", busy: true)
        if reveal { show(activate: activate) }
    }
    func bindSession(_ id: String?) {
        if model.sessionID != id {
            if !model.liveVoice { model.messages = Array(model.messages.suffix(2)) }
            // The visible conversation continues, so whatever the user is typing stays.
            model.select(id, keepDraft: true)
        }
    }
    func updateTool(_ update: [String: Any]) { AssistantTranscript.updateTool(update, in: &model.messages) }
    func setStatus(_ message: String, busy: Bool) { model.status = message; model.busy = busy }
    func show(activate: Bool = true) {
        if let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier != ProcessInfo.processInfo.processIdentifier { origin = app }
        placement.prepareToShow()
        if activate {
            NSApp.activate(ignoringOtherApps: true)
            panel.makeKeyAndOrderFront(nil)
            model.focus()
        } else {
            panel.orderFrontRegardless()
        }
    }
    func hide() {
        guard panel.attachedSheet == nil else { return }
        onHide?()
        let wasKey = panel.isKeyWindow
        placement.save()
        panel.orderOut(nil)
        if wasKey { origin?.activate(options: []) }
    }
    func export(_ markdown: String, title: String) {
        let save = NSSavePanel()
        save.allowedContentTypes = [UTType(filenameExtension: "md") ?? .plainText]
        save.nameFieldStringValue = String(title.components(separatedBy: CharacterSet(charactersIn: "/:\\")).joined(separator: "-").prefix(80)) + ".md"
        save.beginSheetModal(for: panel) { [weak self] response in
            guard response == .OK, let url = save.url else { return }
            do { try markdown.write(to: url, atomically: true, encoding: .utf8); self?.model.status = "Exported " + url.lastPathComponent }
            catch { self?.model.status = "Export failed: " + error.localizedDescription }
        }
    }
    func chooseFiles() async -> [URL] {
        let open = NSOpenPanel()
        open.allowsMultipleSelection = true
        open.canChooseDirectories = false
        open.prompt = "Attach"
        return await withCheckedContinuation { continuation in
            open.beginSheetModal(for: panel) { response in continuation.resume(returning: response == .OK ? open.urls : []) }
        }
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { hide(); return false }
    // AssistantWindowPlacement ignores the moves macOS makes when displays
    // change; saving those is what used to lose the frame set on the big screen.
    func windowDidMove(_ notification: Notification) { if panel.isVisible { placement.save() } }
    func windowDidResize(_ notification: Notification) { if panel.isVisible { placement.save() } }
    func windowDidBecomeKey(_ notification: Notification) {
        if let id = model.sessionID { model.unread.remove(id) }
    }
    @objc private func willTerminate(_ notification: Notification) {
        if panel.isVisible { placement.save() }
    }
    @objc private func screenParametersChanged(_ notification: Notification) {
        placement.screensChanged()
    }
    func approve(_ params: [String: Any], title: String = "Hermes requests permission") async -> [String: Any] {
        // User-selected permissive Bento policy. Never mutate Hermes' global allowlist.
        let options = params["options"] as? [[String: Any]] ?? []
        let allowed = options.first { $0["kind"] as? String == "allow_once" } ??
            options.first { $0["kind"] as? String == "allow_always" }
        if let id = allowed?["optionId"] as? String, !id.isEmpty {
            return ["outcome": ["outcome": "selected", "optionId": id]]
        }
        return ["outcome": ["outcome": "cancelled"]]
    }
}
