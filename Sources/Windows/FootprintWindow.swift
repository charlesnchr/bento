import AppKit
import BentoCore

/// Translucent rounded preview of where a dragged window will snap.
/// Created on first use, ordered out (not destroyed) between drags.
final class FootprintWindow {
    private var panel: NSPanel?
    private var shownAX: CGRect?

    private func makePanel() -> NSPanel {
        let p = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.level = .modalPanel
        p.ignoresMouseEvents = true
        p.isReleasedWhenClosed = false
        p.animationBehavior = .none
        p.collectionBehavior = [.canJoinAllSpaces, .transient, .ignoresCycle, .fullScreenAuxiliary]

        let radius: CGFloat
        if #available(macOS 26.0, *) { radius = 16 } else { radius = 10 }
        let effect = NSVisualEffectView()
        effect.material = .hudWindow
        effect.blendingMode = .behindWindow
        effect.state = .active
        effect.wantsLayer = true
        effect.layer?.cornerRadius = radius
        effect.layer?.masksToBounds = true

        let tint = TintView()
        tint.cornerRadius = radius
        tint.autoresizingMask = [.width, .height]
        effect.addSubview(tint)
        p.contentView = effect
        return p
    }

    /// Shows (or moves) the preview to an AX rect.
    func show(_ axRect: CGRect) {
        let p = panel ?? makePanel()
        panel = p
        let frame = NSScreen.cocoaRect(fromAX: axRect)
        if !p.isVisible {
            p.setFrame(frame, display: true)
            p.alphaValue = 0
            p.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0 : 0.12
                p.animator().alphaValue = 1
            }
        } else if shownAX != axRect {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0 : 0.12
                ctx.allowsImplicitAnimation = true
                p.animator().setFrame(frame, display: true)
            }
        }
        shownAX = axRect
    }

    func hide() {
        guard let p = panel, p.isVisible else { return }
        shownAX = nil
        p.orderOut(nil)
    }

    /// Frees the window entirely (snapping turned off).
    func close() {
        panel?.close()
        panel = nil
        shownAX = nil
    }
}

/// Accent-tinted fill and border on top of the material.
private final class TintView: NSView {
    var cornerRadius: CGFloat = 10

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let accent = NSColor.controlAccentColor
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: cornerRadius - 1, yRadius: cornerRadius - 1)
        accent.withAlphaComponent(0.16).setFill()
        path.fill()
        accent.withAlphaComponent(0.75).setStroke()
        path.lineWidth = 2
        path.stroke()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }
}
