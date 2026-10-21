import AppKit
import SwiftUI
import Carbon.HIToolbox

/// SwiftUI shortcut recorder. Click to record, press a combination; Esc
/// cancels, ⌫ clears. Global hotkeys are suspended while recording.
///
///     ShortcutRecorder(shortcut: $entry.shortcut)
///     ShortcutRecorder(actionID: "shot.area")   // binds straight to the registry
///
/// The `actionID:` form refreshes itself when the registry reloads and shows
/// when the shortcut couldn't be registered (taken by another app).
public struct ShortcutRecorder: View {
    @Binding var shortcut: Shortcut?
    var placeholder: String
    private let actionID: String?
    @State private var registryRevision = 0
    @Environment(\.isEnabled) private var isEnabled

    public init(shortcut: Binding<Shortcut?>, placeholder: String = "Record Shortcut") {
        _shortcut = shortcut
        self.placeholder = placeholder
        actionID = nil
    }

    /// Recorder that reads/writes the registry binding for an action. A
    /// combination already used by another action moves to this one.
    public init(actionID: String, placeholder: String = "Record Shortcut") {
        _shortcut = Binding(
            get: { ActionRegistry.shared.shortcut(for: actionID) },
            set: { ActionRegistry.shared.assign($0, to: actionID) }
        )
        self.placeholder = placeholder
        self.actionID = actionID
    }

    public var body: some View {
        let _ = registryRevision // re-read the registry after every reload
        RecorderRepresentable(shortcut: $shortcut, current: shortcut, placeholder: placeholder, isEnabled: isEnabled,
                              problem: actionID.flatMap { ActionRegistry.shared.failureReason(for: $0) },
                              identifier: actionID.map { "recorder:\($0)" })
            .frame(width: 150, height: 24)
            .onReceive(NotificationCenter.default.publisher(for: ActionRegistry.didReload)) { _ in
                if actionID != nil { registryRevision &+= 1 }
            }
    }
}

private struct RecorderRepresentable: NSViewRepresentable {
    @Binding var shortcut: Shortcut?
    var current: Shortcut?
    var placeholder: String
    var isEnabled: Bool
    var problem: String?
    var identifier: String?

    func makeNSView(context: Context) -> RecorderView {
        let v = RecorderView()
        configure(v)
        return v
    }

    func updateNSView(_ v: RecorderView, context: Context) { configure(v) }

    private func configure(_ v: RecorderView) {
        let binding = $shortcut
        v.onChange = { binding.wrappedValue = $0 }
        v.placeholder = placeholder
        v.isEnabled = isEnabled
        v.problem = problem
        if let identifier { v.setAccessibilityIdentifier(identifier) }
        if !v.isRecording { v.shortcut = current }
    }

    static func dismantleNSView(_ v: RecorderView, coordinator: ()) { v.cancelRecording() }
}

final class RecorderView: NSView {
    var shortcut: Shortcut? { didSet { if shortcut != oldValue { needsDisplay = true } } }
    var placeholder = "Record Shortcut" { didSet { if placeholder != oldValue { needsDisplay = true } } }
    var onChange: ((Shortcut?) -> Void)?
    /// Why the current shortcut isn't active (drawn as a warning, shown as tooltip).
    var problem: String? {
        didSet {
            guard problem != oldValue else { return }
            toolTip = problem
            needsDisplay = true
        }
    }
    var isEnabled = true {
        didSet {
            guard isEnabled != oldValue else { return }
            if !isEnabled { cancelRecording() }
            needsDisplay = true
        }
    }
    private(set) var isRecording = false { didSet { needsDisplay = true } }
    private var monitor: Any?
    private var observers: [NSObjectProtocol] = []
    /// This view holds one `HotkeyCenter.suspend()` that it must balance.
    private var holdsSuspension = false
    private var liveModifiers: NSEvent.ModifierFlags = []
    private var tracking: NSTrackingArea?
    private var hoveringClear = false

    override var acceptsFirstResponder: Bool { isEnabled }
    override var canBecomeKeyView: Bool { isEnabled }
    override var intrinsicContentSize: NSSize { NSSize(width: 150, height: 24) }

    deinit {
        // Safety net: never leave global hotkeys suspended.
        if let monitor { NSEvent.removeMonitor(monitor) }
        observers.forEach(NotificationCenter.default.removeObserver)
        if holdsSuspension {
            if Thread.isMainThread { HotkeyCenter.shared.resume() } else { DispatchQueue.main.async { HotkeyCenter.shared.resume() } }
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let t = NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow], owner: self)
        addTrackingArea(t)
        tracking = t
    }

    private var clearRect: NSRect { NSRect(x: bounds.maxX - 22, y: bounds.midY - 8, width: 16, height: 16) }

    override func mouseMoved(with event: NSEvent) {
        let inside = clearRect.contains(convert(event.locationInWindow, from: nil))
        if inside != hoveringClear { hoveringClear = inside; needsDisplay = true }
    }

    override func mouseExited(with event: NSEvent) { hoveringClear = false; needsDisplay = true }

    override func mouseDown(with event: NSEvent) {
        guard isEnabled else { return }
        let p = convert(event.locationInWindow, from: nil)
        if shortcut != nil, !isRecording, clearRect.contains(p) {
            clear()
            return
        }
        isRecording ? stop() : start()
    }

    /// Space/Return start recording when the recorder has keyboard focus.
    override func keyDown(with event: NSEvent) {
        guard isEnabled, !isRecording else { return super.keyDown(with: event) }
        let code = Int(event.keyCode)
        if [kVK_Space, kVK_Return, kVK_ANSI_KeypadEnter].contains(code) {
            start()
        } else if [kVK_Delete, kVK_ForwardDelete].contains(code), shortcut != nil {
            clear()
        } else {
            super.keyDown(with: event)
        }
    }

    private func clear() {
        shortcut = nil
        onChange?(nil)
    }

    private func start() {
        guard isEnabled, !isRecording, let window else { return }
        if !window.isKeyWindow, NSApplication.shared.activationPolicy() != .prohibited {
            // Keys only reach the local monitor while our window is key.
            AppActivation.activateSelf()
            window.makeKeyAndOrderFront(nil)
        }
        window.makeFirstResponder(self)
        isRecording = true
        liveModifiers = []
        if !holdsSuspension {
            holdsSuspension = true
            HotkeyCenter.shared.suspend()
        }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] e in
            guard let self, self.isRecording else { return e }
            switch e.type {
            case .flagsChanged:
                self.liveModifiers = e.modifierFlags.intersection(Shortcut.relevantModifiers)
                self.needsDisplay = true
                return nil
            case .keyDown:
                self.handleKey(e)
                return nil
            default:
                // A click anywhere but on the recorder ends recording (the click
                // on the recorder itself toggles it in mouseDown).
                if e.window !== self.window || !self.bounds.contains(self.convert(e.locationInWindow, from: nil)) {
                    self.stop()
                }
                return e
            }
        }
        // Leaving the window or the app (clicking another app, closing the
        // window, ⌘-Tab) ends recording so hotkeys never stay suspended.
        let nc = NotificationCenter.default
        let end: (Notification) -> Void = { [weak self] _ in self?.stop() }
        observers = [
            nc.addObserver(forName: NSWindow.didResignKeyNotification, object: window, queue: .main, using: end),
            nc.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main, using: end),
            nc.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main, using: end),
        ]
        NSAccessibility.post(element: self, notification: .valueChanged)
    }

    private func handleKey(_ e: NSEvent) {
        let mods = e.modifierFlags.intersection([.command, .option, .control, .shift])
        let code = Int(e.keyCode)
        if mods.isEmpty && code == kVK_Escape { stop(); return }
        if mods.isEmpty && (code == kVK_Delete || code == kVK_ForwardDelete) {
            stop()
            clear()
            return
        }
        guard let sc = RecorderView.shortcut(keyCode: UInt32(e.keyCode), modifiers: mods) else {
            NSSound.beep()
            return
        }
        // Stop first: onChange can rebuild the SwiftUI row (and this view).
        stop()
        shortcut = sc
        onChange?(sc)
    }

    static let functionKeys: Set<Int> = [
        kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6, kVK_F7, kVK_F8, kVK_F9, kVK_F10,
        kVK_F11, kVK_F12, kVK_F13, kVK_F14, kVK_F15, kVK_F16, kVK_F17, kVK_F18, kVK_F19, kVK_F20,
    ]

    static let modifierKeys: Set<Int> = [
        kVK_Command, kVK_Shift, kVK_Option, kVK_Control, kVK_RightCommand, kVK_RightShift,
        kVK_RightOption, kVK_RightControl, kVK_CapsLock, kVK_Function,
    ]

    /// Validates a recorded combination. Plain or Shift-only keys would hijack
    /// typing, so they need ⌘, ⌥ or ⌃ — except function keys.
    static func shortcut(keyCode: UInt32, modifiers: NSEvent.ModifierFlags) -> Shortcut? {
        let mods = modifiers.intersection([.command, .option, .control, .shift])
        let hasCommandish = !mods.intersection([.command, .option, .control]).isEmpty
        guard keyCode <= 0xFF, !modifierKeys.contains(Int(keyCode)) else { return nil }
        guard hasCommandish || functionKeys.contains(Int(keyCode)) else { return nil }
        return Shortcut(keyCode: keyCode, modifiers: mods)
    }

    /// Ends recording without changing the shortcut.
    func cancelRecording() {
        if isRecording || holdsSuspension { stop() }
    }

    private func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        liveModifiers = []
        if isRecording { isRecording = false }
        if holdsSuspension {
            holdsSuspension = false
            HotkeyCenter.shared.resume()
        }
    }

    override func viewWillMove(toWindow newWindow: NSWindow?) {
        super.viewWillMove(toWindow: newWindow)
        if newWindow !== window { cancelRecording() }
    }

    // MARK: Drawing

    override func draw(_ dirtyRect: NSRect) {
        let r = bounds.insetBy(dx: 0.5, dy: 0.5)
        let path = NSBezierPath(roundedRect: r, xRadius: 6, yRadius: 6)
        (isRecording ? NSColor.controlAccentColor.withAlphaComponent(0.12) : NSColor.controlBackgroundColor).setFill()
        path.fill()
        let stroke: NSColor = isRecording ? .controlAccentColor : (problem != nil && shortcut != nil ? .systemOrange : .separatorColor)
        stroke.setStroke()
        path.lineWidth = 1
        path.stroke()

        let text: String
        var color: NSColor
        if isRecording {
            text = liveModifiers.isEmpty ? "Type shortcut…" : RecorderView.modifierSymbols(liveModifiers)
            color = .controlAccentColor
        } else if let shortcut {
            text = shortcut.displayString
            color = problem != nil ? .systemOrange : .labelColor
        } else {
            text = placeholder
            color = .placeholderTextColor
        }
        if !isEnabled { color = color.withAlphaComponent(0.5) }
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12, weight: shortcut == nil || isRecording ? .regular : .medium),
            .foregroundColor: color,
        ]
        let size = (text as NSString).size(withAttributes: attrs)
        (text as NSString).draw(at: NSPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2), withAttributes: attrs)

        if shortcut != nil, !isRecording, isEnabled, let x = NSImage(systemSymbolName: "xmark.circle.fill", accessibilityDescription: "Clear") {
            let tinted = x.withSymbolConfiguration(.init(paletteColors: [hoveringClear ? .secondaryLabelColor : .tertiaryLabelColor]))
            tinted?.draw(in: clearRect)
        }
    }

    static func modifierSymbols(_ m: NSEvent.ModifierFlags) -> String {
        var s = ""
        if m.contains(.control) { s += "⌃" }
        if m.contains(.option) { s += "⌥" }
        if m.contains(.shift) { s += "⇧" }
        if m.contains(.command) { s += "⌘" }
        return s
    }

    override var focusRingMaskBounds: NSRect { bounds }

    override func drawFocusRingMask() {
        NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 6, yRadius: 6).fill()
    }

    // MARK: Accessibility

    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .button }
    override func accessibilityLabel() -> String? { "Shortcut" }
    override func accessibilityValue() -> Any? {
        if isRecording { return "Recording" }
        return shortcut?.displayString ?? placeholder
    }
    override func accessibilityHelp() -> String? { problem }
    override func isAccessibilityEnabled() -> Bool { isEnabled }

    override func accessibilityPerformPress() -> Bool {
        guard isEnabled else { return false }
        isRecording ? stop() : start()
        return true
    }
}
