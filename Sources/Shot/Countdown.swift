import AppKit
import BentoCore

/// Countdown HUD for delayed capture. Esc (temporary global hotkey) or a
/// click on the HUD cancels. The 1 s timer only exists while counting.
final class Countdown {
    private(set) static var current: Countdown?

    private var remaining: Int
    private let completion: (Bool) -> Void
    private var panel: NSPanel?
    private var label: NSTextField?
    private var timer: Timer?
    private var escToken: HotkeyCenter.Token?

    static var isActive: Bool { current != nil }

    /// Calls `completion(true)` when the countdown ends, `false` if cancelled.
    static func start(seconds: Int, completion: @escaping (Bool) -> Void) {
        guard current == nil else { return }
        let c = Countdown(seconds: max(1, seconds), completion: completion)
        current = c
        c.show()
    }

    static func cancel() { current?.end(fire: false) }

    private init(seconds: Int, completion: @escaping (Bool) -> Void) {
        remaining = seconds
        self.completion = completion
    }

    private func show() {
        guard let screen = NSScreen.underMouse ?? NSScreen.main else { end(fire: true); return }
        let size = NSSize(width: 132, height: 112)
        let p = KeyablePanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.level = .statusBar
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        p.isReleasedWhenClosed = false

        let effect = ClickView(frame: NSRect(origin: .zero, size: size))
        effect.material = .hudWindow
        effect.state = .active
        effect.blendingMode = .behindWindow
        effect.roundCorners(16)
        effect.onClick = { [weak self] in self?.end(fire: false) }

        let number = NSTextField(labelWithString: "\(remaining)")
        number.font = .monospacedDigitSystemFont(ofSize: 54, weight: .semibold)
        number.textColor = .labelColor
        number.alignment = .center
        let hint = NSTextField(labelWithString: "Esc or click to cancel")
        hint.font = .systemFont(ofSize: 11)
        hint.textColor = .secondaryLabelColor
        hint.alignment = .center
        let stack = NSStackView(views: [number, hint])
        stack.orientation = .vertical
        stack.spacing = 2
        stack.translatesAutoresizingMaskIntoConstraints = false
        effect.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: effect.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: effect.centerYAnchor),
        ])
        p.contentView = effect
        let vf = screen.visibleFrame
        p.setFrameOrigin(NSPoint(x: vf.midX - size.width / 2, y: vf.minY + vf.height * 0.12))
        p.orderFrontRegardless()
        panel = p
        label = number

        if let esc = Shortcut("escape") {
            escToken = HotkeyCenter.shared.register(esc) { [weak self] in self?.end(fire: false) }
            ScreenGrabber.log.debug("countdown started, esc hotkey \(self.escToken == nil ? "unavailable" : "registered", privacy: .public)")
        }
        let t = Timer(timeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
        t.tolerance = 0.05
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func tick() {
        remaining -= 1
        if remaining <= 0 {
            end(fire: true)
        } else {
            label?.stringValue = "\(remaining)"
        }
    }

    private func end(fire: Bool) {
        guard Countdown.current === self else { return }
        ScreenGrabber.log.debug("countdown \(fire ? "fired" : "cancelled", privacy: .public)")
        timer?.invalidate()
        timer = nil
        HotkeyCenter.shared.unregister(escToken)
        escToken = nil
        panel?.orderOut(nil)
        panel?.contentView = nil
        panel = nil
        Countdown.current = nil
        // Let the window server remove the HUD before capturing.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { self.completion(fire) }
    }
}

private final class ClickView: NSVisualEffectView {
    var onClick: (() -> Void)?
    override func mouseDown(with event: NSEvent) { onClick?() }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}
