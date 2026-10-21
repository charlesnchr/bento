import AppKit
import SwiftUI
import Carbon.HIToolbox

/// SwiftUI shortcut recorder. Click to record, press a combination; Esc
/// cancels, ⌫ clears. Global hotkeys are suspended while recording.
///
///     ShortcutRecorder(shortcut: $entry.shortcut)
///     ShortcutRecorder(actionID: "shot.area")   // binds straight to the registry
public struct ShortcutRecorder: View {
    @Binding var shortcut: Shortcut?
    var placeholder: String

    public init(shortcut: Binding<Shortcut?>, placeholder: String = "Record Shortcut") {
        _shortcut = shortcut
        self.placeholder = placeholder
    }

    /// Recorder that reads/writes the registry binding for an action. A
    /// combination already used by another action moves to this one.
    public init(actionID: String, placeholder: String = "Record Shortcut") {
        _shortcut = Binding(
            get: { ActionRegistry.shared.shortcut(for: actionID) },
            set: { ActionRegistry.shared.assign($0, to: actionID) }
        )
        self.placeholder = placeholder
    }

    public var body: some View {
        RecorderRepresentable(shortcut: $shortcut, placeholder: placeholder)
            .frame(width: 150, height: 24)
    }
}

private struct RecorderRepresentable: NSViewRepresentable {
    @Binding var shortcut: Shortcut?
    var placeholder: String

    func makeNSView(context: Context) -> RecorderView {
        let v = RecorderView()
        v.placeholder = placeholder
        v.onChange = { shortcut = $0 }
        v.shortcut = shortcut
        return v
    }

    func updateNSView(_ v: RecorderView, context: Context) {
        v.onChange = { shortcut = $0 }
        if !v.isRecording { v.shortcut = shortcut }
    }
}

final class RecorderView: NSView {
    var shortcut: Shortcut? { didSet { needsDisplay = true } }
    var placeholder = "Record Shortcut"
    var onChange: ((Shortcut?) -> Void)?
    private(set) var isRecording = false { didSet { needsDisplay = true } }
    private var monitor: Any?
    private var liveModifiers: NSEvent.ModifierFlags = []
    private var tracking: NSTrackingArea?
    private var hoveringClear = false

    override var acceptsFirstResponder: Bool { true }
    override var intrinsicContentSize: NSSize { NSSize(width: 150, height: 24) }

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
        let p = convert(event.locationInWindow, from: nil)
        if shortcut != nil, !isRecording, clearRect.contains(p) {
            shortcut = nil
            onChange?(nil)
            return
        }
        isRecording ? stop() : start()
    }

    private func start() {
        window?.makeFirstResponder(self)
        isRecording = true
        liveModifiers = []
        HotkeyCenter.shared.suspend()
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .flagsChanged, .leftMouseDown]) { [weak self] e in
            guard let self else { return e }
            switch e.type {
            case .flagsChanged:
                self.liveModifiers = e.modifierFlags.intersection(Shortcut.relevantModifiers)
                self.needsDisplay = true
                return nil
            case .keyDown:
                self.handleKey(e)
                return nil
            case .leftMouseDown:
                if e.window != self.window || !self.bounds.contains(self.convert(e.locationInWindow, from: nil)) { self.stop() }
                return e
            default:
                return e
            }
        }
    }

    private func handleKey(_ e: NSEvent) {
        let mods = e.modifierFlags.intersection([.command, .option, .control, .shift])
        let code = Int(e.keyCode)
        if mods.isEmpty && code == kVK_Escape { stop(); return }
        if mods.isEmpty && (code == kVK_Delete || code == kVK_ForwardDelete) {
            stop()
            shortcut = nil
            onChange?(nil)
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

    /// Validates a recorded combination. Plain or Shift-only keys would hijack
    /// typing, so they need ⌘, ⌥ or ⌃ — except function keys.
    static func shortcut(keyCode: UInt32, modifiers: NSEvent.ModifierFlags) -> Shortcut? {
        let mods = modifiers.intersection([.command, .option, .control, .shift])
        let hasCommandish = !mods.intersection([.command, .option, .control]).isEmpty
        guard hasCommandish || functionKeys.contains(Int(keyCode)) else { return nil }
        if [kVK_Command, kVK_Shift, kVK_Option, kVK_Control, kVK_RightCommand, kVK_RightShift,
            kVK_RightOption, kVK_RightControl, kVK_CapsLock, kVK_Function].contains(Int(keyCode)) { return nil }
        return Shortcut(keyCode: keyCode, modifiers: mods)
    }

    private func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        isRecording = false
        HotkeyCenter.shared.resume()
    }

    override func viewWillMove(toWindow newWindow: NSWindow?) {
        if newWindow == nil, isRecording { stop() }
    }

    override func draw(_ dirtyRect: NSRect) {
        let r = bounds.insetBy(dx: 0.5, dy: 0.5)
        let path = NSBezierPath(roundedRect: r, xRadius: 6, yRadius: 6)
        (isRecording ? NSColor.controlAccentColor.withAlphaComponent(0.12) : NSColor.controlBackgroundColor).setFill()
        path.fill()
        (isRecording ? NSColor.controlAccentColor : NSColor.separatorColor).setStroke()
        path.lineWidth = 1
        path.stroke()

        let text: String
        let color: NSColor
        if isRecording {
            let live = Shortcut(keyCode: UInt32.max, modifiers: liveModifiers).displayString.replacingOccurrences(of: "#\(UInt32.max)", with: "")
            text = live.isEmpty ? "Type shortcut…" : live
            color = .controlAccentColor
        } else if let shortcut {
            text = shortcut.displayString
            color = .labelColor
        } else {
            text = placeholder
            color = .placeholderTextColor
        }
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12, weight: shortcut == nil || isRecording ? .regular : .medium),
            .foregroundColor: color,
        ]
        let size = (text as NSString).size(withAttributes: attrs)
        (text as NSString).draw(at: NSPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2), withAttributes: attrs)

        if shortcut != nil, !isRecording, let x = NSImage(systemSymbolName: "xmark.circle.fill", accessibilityDescription: "Clear") {
            let tinted = x.withSymbolConfiguration(.init(paletteColors: [hoveringClear ? .secondaryLabelColor : .tertiaryLabelColor]))
            tinted?.draw(in: clearRect)
        }
    }
}
