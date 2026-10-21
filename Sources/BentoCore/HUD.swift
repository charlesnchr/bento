import AppKit

/// Small transient overlay ("Copied", "Left Half", "Tiling on") shown near the
/// bottom of the active screen. Non-activating and click-through.
public enum HUD {
    private static var panel: NSPanel?
    private static var hideWork: DispatchWorkItem?

    public static func show(_ text: String, symbol: String? = nil, duration: TimeInterval = 1.1, on screen: NSScreen? = nil) {
        let screen = screen ?? NSScreen.underMouse ?? NSScreen.main
        guard let screen else { return }

        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: 15, weight: .medium)
        label.textColor = .labelColor
        let stack = NSStackView()
        stack.orientation = .horizontal
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 10, left: 16, bottom: 10, right: 18)
        if let symbol, let img = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) {
            let iv = NSImageView(image: img)
            iv.symbolConfiguration = .init(pointSize: 16, weight: .medium)
            iv.contentTintColor = .labelColor
            stack.addArrangedSubview(iv)
        }
        stack.addArrangedSubview(label)

        let effect = NSVisualEffectView()
        effect.material = .hudWindow
        effect.state = .active
        effect.blendingMode = .behindWindow
        effect.addSubview(stack)
        stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: effect.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: effect.trailingAnchor),
            stack.topAnchor.constraint(equalTo: effect.topAnchor),
            stack.bottomAnchor.constraint(equalTo: effect.bottomAnchor),
        ])
        let size = stack.fittingSize
        // A mask image (not a layer corner radius) clips the blur itself, so
        // the corners stay clean on any background.
        effect.maskImage = HUD.roundedMask(radius: 12)

        let p = panel ?? {
            let p = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
            p.isOpaque = false
            p.backgroundColor = .clear
            p.hasShadow = true
            // Above capture overlays (screen-saver level) so confirmations stay visible.
            p.level = NSWindow.Level(rawValue: NSWindow.Level.screenSaver.rawValue + 1)
            p.ignoresMouseEvents = true
            p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
            p.isReleasedWhenClosed = false
            return p
        }()
        panel = p
        p.contentView = effect
        let vf = screen.visibleFrame
        p.setFrame(NSRect(x: vf.midX - size.width / 2, y: vf.minY + vf.height * 0.12, width: size.width, height: size.height), display: true)
        p.alphaValue = 1
        p.orderFrontRegardless()

        hideWork?.cancel()
        let work = DispatchWorkItem {
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = 0.25
                p.animator().alphaValue = 0
            }, completionHandler: { p.orderOut(nil) })
        }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + duration, execute: work)
    }

    static func roundedMask(radius: CGFloat) -> NSImage {
        let edge = radius * 2 + 1
        let img = NSImage(size: NSSize(width: edge, height: edge), flipped: false) { rect in
            NSColor.black.setFill()
            NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
            return true
        }
        img.capInsets = NSEdgeInsets(top: radius, left: radius, bottom: radius, right: radius)
        img.resizingMode = .stretch
        return img
    }
}
