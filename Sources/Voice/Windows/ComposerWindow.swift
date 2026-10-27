import AppKit
import ApplicationServices
import VoiceCore

@MainActor
final class ComposerWindow: NSObject, TextInserting, NSTextViewDelegate, NSWindowDelegate {
    private final class Panel: NSPanel {
        override var canBecomeKey: Bool { true }
        override var canBecomeMain: Bool { true }
    }
    private final class Editor: NSTextView {
        var commit: (() -> Void)?
        var dismiss: (() -> Void)?
        var userInteracted: (() -> Void)?
        override func keyDown(with event: NSEvent) {
            userInteracted?()
            if !hasMarkedText(), event.keyCode == 36 || event.keyCode == 76 {
                if event.modifierFlags.contains(.shift) { insertNewlineIgnoringFieldEditor(nil) }
                else { commit?() }
                return
            }
            if event.keyCode == 53 { dismiss?(); return }
            super.keyDown(with: event)
        }
        override func mouseDown(with event: NSEvent) {
            userInteracted?()
            super.mouseDown(with: event)
        }
    }
    private struct Destination {
        let app: NSRunningApplication
        let window: AXUIElement?
        let element: AXUIElement?
        var context: DictationContext {
            DictationContext(targetAppBundleID: app.bundleIdentifier, targetAppName: app.localizedName, targetPID: app.processIdentifier)
        }
    }

    private let panel = Panel(contentRect: NSRect(x: 0, y: 0, width: 640, height: 260),
                              styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
    private let editor = Editor()
    private let status = NSTextField(labelWithString: "")
    private let send = NSButton()
    private let paster = PasteInserter()
    private var destination: Destination?
    private weak var localWindow: NSWindow?
    private weak var localEditor: NSTextView?
    private var positioning = false
    private var draft = ComposerDraft()
    private var busy = false
    private var sending = false
    private var dismissed = false
    private var pendingRange = NSRange(location: 0, length: 0)
    private var pendingSelection: NSRange?
    var onCancel: (() -> Void)?
    var onNotice: ((String) -> Void)?
    var hasDraft: Bool { !editor.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    override init() {
        super.init()
        panel.title = "Bento Composer"
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 1)
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.fullScreenAuxiliary, .moveToActiveSpace]
        panel.minSize = NSSize(width: 340, height: 170)
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        let content = NSView()
        panel.contentView = content
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.borderType = .noBorder
        editor.isRichText = false
        editor.allowsUndo = true
        editor.font = .systemFont(ofSize: 16)
        editor.textContainerInset = NSSize(width: 14, height: 14)
        editor.isVerticallyResizable = true
        editor.isHorizontallyResizable = false
        editor.autoresizingMask = [.width]
        editor.textContainer?.widthTracksTextView = true
        editor.textContainer?.containerSize = NSSize(width: 500, height: CGFloat.greatestFiniteMagnitude)
        editor.setAccessibilityLabel("Draft")
        editor.delegate = self
        editor.commit = { [weak self] in self?.commit() }
        editor.dismiss = { [weak self] in self?.dismiss() }
        editor.userInteracted = { [weak self] in self?.pendingSelection = nil }
        scroll.documentView = editor
        status.font = .systemFont(ofSize: 12)
        status.textColor = .secondaryLabelColor
        status.lineBreakMode = .byTruncatingTail
        send.image = NSImage(systemSymbolName: "arrow.up.right", accessibilityDescription: "Insert draft")
        send.bezelStyle = .texturedRounded
        send.toolTip = "Insert draft"
        send.target = self
        send.action = #selector(sendClicked)
        for view in [scroll, status, send] {
            view.translatesAutoresizingMaskIntoConstraints = false
            content.addSubview(view)
        }
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: content.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: status.topAnchor, constant: -8),
            status.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 14),
            status.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -12),
            status.trailingAnchor.constraint(equalTo: send.leadingAnchor, constant: -12),
            send.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -12),
            send.centerYAnchor.constraint(equalTo: status.centerYAnchor),
            send.widthAnchor.constraint(equalToConstant: 34),
            send.heightAnchor.constraint(equalToConstant: 28)
        ])
    }

    func prepare(editing: Bool, recording: Bool = true) -> DictationContext? {
        guard !busy, !sending, !SecureInput.isActive else { return nil }
        syncDraft()
        pendingSelection = nil
        // Recording has no dependency on another app's accessibility tree.
        // A new destination is resolved when speech ends, before cleanup.
        if !recording { captureDestination() }
        pendingRange = editing && draft.selection.length == 0 ? NSRange(location: 0, length: (draft.text as NSString).length) : draft.selection
        let history = recording ? draft.begin(editing: editing) : nil
        if editing && history == nil { onNotice?("The draft is empty"); return nil }
        var context = destination?.context ?? DictationContext()
        context.useComposer = true
        context.editingSession = history
        busy = true
        dismissed = false
        loadDraft()
        if !recording { show() }
        editor.isEditable = false
        editor.isSelectable = false
        send.isEnabled = false
        status.stringValue = editing ? "Revising..." : "Dictating..."
        return context
    }

    func finalizeContext(_ context: DictationContext) -> DictationContext {
        guard busy, !dismissed else { return context }
        captureDestination()
        var updated = destination?.context ?? DictationContext()
        updated.editingSession = context.editingSession
        updated.useComposer = true
        return updated
    }

    private func captureDestination() {
        guard let app = NSWorkspace.shared.frontmostApplication else { return }
        if app.processIdentifier == ProcessInfo.processInfo.processIdentifier {
            if let window = NSApp.keyWindow, window !== panel, let input = window.firstResponder as? NSTextView {
                localWindow = window
                localEditor = input
                destination = nil
            }
            return
        }
        localWindow = nil
        localEditor = nil
        destination = Destination(app: app, window: Self.attribute(app, kAXFocusedWindowAttribute),
            element: Self.attribute(app, kAXFocusedUIElementAttribute))
    }

    func insert(_ text: String, context: DictationContext) async -> InsertionOutcome {
        guard busy, !dismissed, draft.apply(text) else {
            return .fellBackToClipboard
        }
        editor.isEditable = true
        editor.isSelectable = true
        editor.insertText(text, replacementRange: pendingRange)
        finish()
        pendingSelection = draft.selection
        show()
        return .inserted
    }

    func recordInstruction(_ text: String, revision: String) { draft.recordInstruction(text, revision: revision) }

    func finish() {
        busy = false
        draft.cancel()
        editor.isEditable = true
        editor.isSelectable = true
        send.isEnabled = !editor.string.isEmpty
        status.stringValue = localWindow?.title ?? destination?.app.localizedName ?? "Draft"
    }

    private func syncDraft() {
        draft.text = editor.string
        draft.selection = editor.selectedRange()
    }

    func textDidChange(_ notification: Notification) {
        if !busy { syncDraft() }
        send.isEnabled = !busy && !sending && !editor.string.isEmpty
        if panel.isVisible { fitDraft(center: false) }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool { dismiss(); return false }

    func dismiss() {
        guard !sending else { return }
        pendingSelection = nil
        dismissed = true
        if busy { onCancel?() }
        syncDraft()
        finish()
        panel.orderOut(nil)
        destination?.app.activate(options: [])
    }

    private func show() {
        loadDraft()
        fitDraft(center: true)
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(editor)
        restorePendingSelection()
        // Activation can finish on the next runloop even after makeKey returns.
        DispatchQueue.main.async { [weak self] in self?.restorePendingSelection() }
    }

    func windowDidBecomeKey(_ notification: Notification) {
        DispatchQueue.main.async { [weak self] in self?.restorePendingSelection() }
    }

    func windowDidResignKey(_ notification: Notification) { pendingSelection = nil }

    func windowDidEndLiveResize(_ notification: Notification) { fitDraft(center: false) }

    private func targetFrame() -> CGRect? {
        if let localWindow { return localWindow.frame }
        guard let window = destination?.window else { return nil }
        var position: CFTypeRef?, size: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &position) == .success,
              AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &size) == .success,
              let position, let size, CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero, dimensions = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
              AXValueGetValue(size as! AXValue, .cgSize, &dimensions), dimensions.width > 0, dimensions.height > 0 else { return nil }
        // AX coordinates start at the primary display's top-left; AppKit uses bottom-left.
        let top = NSScreen.screens.first?.frame.maxY ?? 0
        return CGRect(x: point.x, y: top - point.y - dimensions.height, width: dimensions.width, height: dimensions.height)
    }

    private func fitDraft(center: Bool) {
        guard !positioning, let container = editor.textContainer, let layout = editor.layoutManager else { return }
        positioning = true
        defer { positioning = false }
        let target = targetFrame()
        let screen = NSScreen.screens.max { a, b in
            let anchor = target ?? panel.frame
            let ai = a.frame.intersection(anchor), bi = b.frame.intersection(anchor)
            return (ai.isNull ? 0 : ai.width * ai.height) < (bi.isNull ? 0 : bi.width * bi.height)
        } ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { return }
        panel.contentView?.layoutSubtreeIfNeeded()
        layout.ensureLayout(for: container)
        let textHeight = layout.usedRect(for: container).height + editor.textContainerInset.height * 2
        let chrome = panel.frame.height - (editor.enclosingScrollView?.contentSize.height ?? panel.frame.height - 70)
        let frame = ComposerGeometry.frame(current: panel.frame, target: target, visible: visible,
            desiredHeight: textHeight + chrome, center: center)
        panel.setFrame(frame, display: true)
        editor.scrollRangeToVisible(editor.selectedRange())
    }

    private func restorePendingSelection() {
        guard let range = pendingSelection, panel.isKeyWindow, panel.firstResponder === editor,
              !busy, !sending, NSMaxRange(range) <= (editor.string as NSString).length else { return }
        editor.setSelectedRange(range)
        editor.scrollRangeToVisible(range)
    }

    private func loadDraft() {
        if editor.string != draft.text {
            editor.string = draft.text
            editor.undoManager?.removeAllActions()
        }
        editor.setSelectedRange(draft.selection)
    }

    @objc private func sendClicked() { commit() }

    func open() {
        guard !busy, !sending else { return }
        captureDestination()
        if destination != nil || localWindow != nil { dismissed = false; show(); finish(); return }
        if prepare(editing: false, recording: false) != nil { finish() }
    }

    private func commit() {
        guard !busy, !sending, !editor.hasMarkedText(), !editor.string.isEmpty else { NSSound.beep(); return }
        if let window = localWindow, let input = localEditor, input.window === window, input.isEditable {
            pendingSelection = nil
            let text = editor.string
            panel.orderOut(nil)
            window.makeKeyAndOrderFront(nil)
            window.makeFirstResponder(input)
            input.insertText(text, replacementRange: input.selectedRange())
            draft = ComposerDraft()
            editor.string = ""
            editor.undoManager?.removeAllActions()
            localWindow = nil
            localEditor = nil
            dismissed = true
            finish()
            return
        }
        guard let destination else { status.stringValue = "Choose a destination app; draft retained"; return }
        pendingSelection = nil
        syncDraft()
        let text = draft.text
        sending = true
        editor.isEditable = false
        send.isEnabled = false
        status.stringValue = "Inserting..."
        Task { @MainActor in
            guard !destination.app.isTerminated, destination.app.activate(options: []) else {
                self.sendFailed(); return
            }
            var requestedFocus = false
            let ready = await ComposerFocus.wait(read: {
                guard !SecureInput.isActive, !destination.app.isTerminated else { return .unsafe }
                let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier
                if pid == ProcessInfo.processInfo.processIdentifier { return .activating }
                guard pid == destination.app.processIdentifier else { return .unsafe }
                if let expected = destination.window {
                    guard let window = Self.attribute(destination.app, kAXFocusedWindowAttribute),
                          CFEqual(window, expected) else { return .restoringInput }
                }
                if let element = Self.attribute(destination.app, kAXFocusedUIElementAttribute),
                   let expected = destination.element, Self.isTextInput(expected),
                   CFEqual(element, expected) { return .ready }
                if let element = Self.attribute(destination.app, kAXFocusedUIElementAttribute), Self.isTextInput(element) {
                    if destination.element == nil || destination.element.map({ !Self.isTextInput($0) }) == true { return .ready }
                    return .restoringInput
                }
                // Restore only the captured input, and only in its original window.
                // Application activation completes before editor focus in web apps.
                if !requestedFocus, let element = destination.element, Self.isTextInput(element) {
                    requestedFocus = true
                    AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
                }
                return .restoringInput
            }, pause: { try? await Task.sleep(nanoseconds: 25_000_000) })
            guard ready else { self.sendFailed(); return }
            self.panel.orderOut(nil)
            // One paste only. Never send Return to the destination or select its text.
            guard await self.paster.paste(text) else { self.sendFailed(); return }
            self.draft = ComposerDraft()
            self.editor.string = ""
            self.editor.undoManager?.removeAllActions()
            self.destination = nil
            self.sending = false
            self.dismissed = true
            self.finish()
        }
    }

    private func sendFailed() {
        sending = false
        finish()
        status.stringValue = "Destination changed; draft retained"
        if !panel.isVisible { panel.orderFrontRegardless() }
    }

    private static func attribute(_ app: NSRunningApplication, _ name: String) -> AXUIElement? {
        let root = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(root, 0.3)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(root, name as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return unsafeDowncast(value as AnyObject, to: AXUIElement.self)
    }

    private static func isTextInput(_ element: AXUIElement) -> Bool {
        var role: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role)
        if let role = role as? String, ["AXTextArea", "AXTextField", "AXComboBox"].contains(role) { return true }
        var settable = DarwinBoolean(false)
        return AXUIElementIsAttributeSettable(element, kAXSelectedTextAttribute as CFString, &settable) == .success && settable.boolValue
    }
}
