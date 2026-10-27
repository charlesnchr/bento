import AppKit
import BentoCore
import Combine
import SwiftUI
import UniformTypeIdentifiers
import VoiceCore

/// How the assistant window sits among other apps' windows.
struct AssistantWindowStacking: Equatable {
    var level: NSWindow.Level
    var collectionBehavior: NSWindow.CollectionBehavior
    /// Clicking or typing into the window doesn't activate Bento, so the app
    /// in front (a full-screen one included) stays active and on its Space.
    var nonactivating: Bool

    /// Keep on top (picture in picture): above every app's normal windows, on
    /// every Space and over full-screen apps, and left where it is when you
    /// switch apps. Off, it floats only over the Space it was shown on.
    nonisolated static func keepOnTop(_ on: Bool) -> AssistantWindowStacking {
        on ? AssistantWindowStacking(level: .floating, collectionBehavior: [.canJoinAllSpaces, .fullScreenAuxiliary], nonactivating: true)
           : AssistantWindowStacking(level: .floating, collectionBehavior: [.fullScreenAuxiliary, .moveToActiveSpace], nonactivating: false)
    }
}

@MainActor
final class AssistantWindow: NSObject, NSWindowDelegate {
    /// Created non-activating, because AppKit only honours that style from
    /// creation, not when it is added later. With keep on top off, a click
    /// activates Bento as it would for any other window.
    private final class Panel: NSPanel, ManagedPanel {
        var hide: (() -> Void)?
        var key: ((NSEvent) -> Bool)?
        var activatesOnClick = false
        override var canBecomeKey: Bool { true }
        override var canBecomeMain: Bool { true }
        override func cancelOperation(_ sender: Any?) { hide?() }
        override func sendEvent(_ event: NSEvent) {
            if activatesOnClick, [.leftMouseDown, .rightMouseDown, .otherMouseDown].contains(event.type), !NSApp.isActive {
                AppActivation.activateSelf()
            }
            if event.type == .keyDown, attachedSheet == nil, key?(event) == true { return }
            super.sendEvent(event)
        }
    }
    private let panel = Panel(contentRect: NSRect(x: 0, y: 0, width: 650, height: 650),
        styleMask: [.titled, .closable, .resizable, .fullSizeContentView, .nonactivatingPanel], backing: .buffered, defer: false)
    let model = AssistantChatModel()
    var onHide: (() -> Void)?
    private var origin: NSRunningApplication?
    private lazy var placement = AssistantWindowPlacement(window: panel)
    private var sidebarSub: AnyCancellable?
    private var stacking = AssistantWindowStacking.keepOnTop(false)
    var isKey: Bool { panel.isKeyWindow }
    var frame: NSRect { panel.frame }
    /// Dev harness only: moves the window as a user drag would (saved like one).
    func devSetFrame(_ frame: NSRect) {
        panel.setFrame(frame, display: true)
        placement.save()
    }
    var isVisible: Bool { panel.isVisible && !AppActivation.isOrderingOut(panel) }

    override init() {
        super.init()
        panel.title = "Bento Assistant"
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        applyStacking()
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        NotificationCenter.default.addObserver(self, selector: #selector(screenParametersChanged),
            name: NSApplication.didChangeScreenParametersNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(willTerminate),
            name: NSApplication.willTerminateNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(settingChanged),
            name: .gtSettingDidChange, object: nil)
        for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] { panel.standardWindowButton(button)?.isHidden = true }
        let host = NSHostingView(rootView: AssistantChatView(model: model))
        // The frame is the user's (AssistantWindowPlacement): SwiftUI's ideal
        // size must not resize the window as conversations and panes change.
        host.sizingOptions = []
        panel.contentView = host
        panel.hide = { [weak self] in self?.hide() }
        panel.key = { [weak self] in self?.handle($0) ?? false }
        sidebarSub = model.$historyVisible.removeDuplicates().sink { [weak self] in self?.placement.sidebar = $0 }
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
        if stacking.nonactivating {
            // The panel takes the keyboard without activating Bento, so a
            // full-screen app keeps its Space and stays the active app.
            if NSApp.isHidden { NSApp.unhideWithoutActivation() }
            AppActivation.show(panel, activate: false)
            if activate { panel.makeKey() }
        } else {
            AppActivation.show(panel, activate: activate)
        }
        if activate { model.focus() }
    }
    func hide() {
        guard panel.attachedSheet == nil else { return }
        onHide?()
        placement.save()
        AppActivation.orderOut(panel, activating: panel.isKeyWindow ? (origin ?? AppActivation.previousApp) : nil)
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
    func windowWillResize(_ sender: NSWindow, to frameSize: NSSize) -> NSSize { placement.resizing(to: frameSize) }
    func windowDidBecomeKey(_ notification: Notification) {
        if let id = model.sessionID { model.unread.remove(id) }
    }
    @objc private func willTerminate(_ notification: Notification) {
        if panel.isVisible { placement.save() }
    }
    @objc private func screenParametersChanged(_ notification: Notification) {
        placement.screensChanged()
    }
    @objc private func settingChanged(_ notification: Notification) {
        if notification.object as? String == SettingsStore.assistantKeepOnTopKey { applyStacking() }
    }
    private func applyStacking() {
        stacking = .keepOnTop(SettingsStore().assistantKeepOnTop)
        panel.level = stacking.level
        panel.collectionBehavior = stacking.collectionBehavior
        panel.activatesOnClick = !stacking.nonactivating
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
