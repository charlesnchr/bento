import AppKit
import BentoCore

/// A pinned screenshot: borderless, always on top, on every Space. Drag to
/// move, scroll / pinch to scale, 1–9 / 0 for opacity, double-click to edit,
/// Esc or ⌘W to close.
final class PinController: NSObject, NSWindowDelegate {
    let panel: PinPanel
    private let view: PinView
    private(set) var image: CGImage?
    let scale: CGFloat
    let entryID: String?
    private var zoom: CGFloat = 1
    var onClose: ((PinController) -> Void)?

    private var pointSize: CGSize { CGSize(width: CGFloat(image?.width ?? 1) / scale, height: CGFloat(image?.height ?? 1) / scale) }

    init(image: CGImage, scale: CGFloat, entryID: String?, rect: CGRect) {
        self.image = image
        self.scale = scale
        self.entryID = entryID
        let size = CGSize(width: CGFloat(image.width) / scale, height: CGFloat(image.height) / scale)
        var frame: CGRect
        if rect != .zero {
            frame = NSScreen.cocoaRect(fromAX: CGRect(origin: rect.origin, size: size))
        } else {
            let vf = (NSScreen.underMouse ?? NSScreen.main)?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1200, height: 800)
            frame = CGRect(x: vf.midX - size.width / 2, y: vf.midY - size.height / 2, width: size.width, height: size.height)
        }
        // Keep it on a screen and not larger than it.
        if let screen = NSScreen.screens.first(where: { $0.frame.intersects(frame) }) ?? NSScreen.main {
            let vf = screen.visibleFrame
            let s = min(1, vf.width / frame.width, vf.height / frame.height)
            frame.size = CGSize(width: frame.width * s, height: frame.height * s)
            frame.origin.x = frame.origin.x.clamped(vf.minX...max(vf.minX, vf.maxX - frame.width))
            frame.origin.y = frame.origin.y.clamped(vf.minY...max(vf.minY, vf.maxY - frame.height))
            zoom = s
        }
        panel = PinPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel, .resizable], backing: .buffered, defer: false)
        view = PinView(frame: CGRect(origin: .zero, size: frame.size))
        super.init()
        panel.isReleasedWhenClosed = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hasShadow = true
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hidesOnDeactivate = false
        panel.isMovable = true
        panel.delegate = self
        panel.contentAspectRatio = size
        view.controller = self
        view.setImage(image)
        panel.contentView = view
        panel.pin = self
    }

    func show() {
        panel.orderFrontRegardless()
        panel.makeKey()
    }

    func close() { panel.close() }

    func windowWillClose(_ notification: Notification) {
        view.setImage(nil)
        image = nil
        onClose?(self)
    }

    // MARK: Actions

    func scale(by factor: CGFloat, around screenPoint: NSPoint? = nil) {
        zoom = panel.frame.width / max(1, pointSize.width) // the user may have resized by the edges
        let newZoom = (zoom * factor).clamped(0.1...5)
        guard newZoom != zoom else { return }
        zoom = newZoom
        let f = panel.frame
        let anchor = screenPoint ?? NSPoint(x: f.midX, y: f.midY)
        let rx = (anchor.x - f.minX) / f.width, ry = (anchor.y - f.minY) / f.height
        let size = CGSize(width: max(24, pointSize.width * zoom), height: max(24, pointSize.height * zoom))
        panel.setFrame(CGRect(x: anchor.x - rx * size.width, y: anchor.y - ry * size.height, width: size.width, height: size.height), display: true)
    }

    func resetSize() { scale(by: 1 / zoom) }

    func setOpacity(_ a: CGFloat) {
        panel.alphaValue = a.clamped(0.1...1)
        panel.hasShadow = a >= 1 // Shottr: translucent pins drop the shadow for overlay comparison.
        panel.invalidateShadow()
    }

    func openInEditor() {
        if let id = entryID, ShotEditor.shared.reopen(entryID: id) {
            close()
        } else if let image {
            ShotEditor.shared.open(CapturedImage(image: image, scale: scale, kind: .pasted))
            close()
        }
    }

    func copy() {
        guard let image else { return }
        Clipboard.copy(image, scale: scale)
        HUD.show("Copied", symbol: "doc.on.doc")
    }

    func menu() -> NSMenu {
        let m = NSMenu()
        func add(_ title: String, _ key: String = "", _ handler: @escaping () -> Void) {
            m.addItem(ClosureMenuItem(title: title, keyEquivalent: key, handler: handler))
        }
        add("Open in Editor") { [weak self] in self?.openInEditor() }
        add("Copy", "c") { [weak self] in self?.copy() }
        m.addItem(.separator())
        let opacity = NSMenuItem(title: "Opacity", action: nil, keyEquivalent: "")
        let sub = NSMenu()
        for pct in [100, 80, 60, 40, 20] {
            let item = ClosureMenuItem(title: "\(pct)%") { [weak self] in self?.setOpacity(CGFloat(pct) / 100) }
            if Int((panel.alphaValue * 100).rounded()) == pct { item.state = .on }
            sub.addItem(item)
        }
        opacity.submenu = sub
        m.addItem(opacity)
        add("Actual Size", "0") { [weak self] in self?.resetSize() }
        m.addItem(.separator())
        add("Close", "w") { [weak self] in self?.close() }
        return m
    }
}

final class PinPanel: KeyablePanel {
    weak var pin: PinController?

    override var canBecomeMain: Bool { false }

    override func performKeyEquivalent(with e: NSEvent) -> Bool {
        let mods = e.modifierFlags.intersection([.command, .shift, .option, .control])
        guard mods == .command, let key = e.charactersIgnoringModifiers?.lowercased() else { return super.performKeyEquivalent(with: e) }
        switch key {
        case "w": pin?.close()
        case "c": pin?.copy()
        case "0": pin?.resetSize()
        case "=", "+": pin?.scale(by: 1.25)
        case "-": pin?.scale(by: 0.8)
        default: return super.performKeyEquivalent(with: e)
        }
        return true
    }

    override func cancelOperation(_ sender: Any?) { pin?.close() }
}

final class PinView: NSView {
    weak var controller: PinController?
    private let closeButton = NSButton()
    private var tracking: NSTrackingArea?

    override var wantsUpdateLayer: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var acceptsFirstResponder: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        autoresizingMask = [.width, .height]
        let cfg = NSImage.SymbolConfiguration(pointSize: 15, weight: .semibold)
        closeButton.image = NSImage(systemSymbolName: "xmark.circle.fill", accessibilityDescription: "Close")?.withSymbolConfiguration(cfg)
        closeButton.isBordered = false
        closeButton.contentTintColor = NSColor(white: 0.15, alpha: 0.9)
        closeButton.target = self
        closeButton.action = #selector(closeClicked)
        closeButton.frame = NSRect(x: 4, y: frame.height - 24, width: 20, height: 20)
        closeButton.autoresizingMask = [.maxXMargin, .minYMargin]
        closeButton.isHidden = true
        closeButton.toolTip = "Close (Esc)"
        addSubview(closeButton)
    }

    required init?(coder: NSCoder) { fatalError() }

    func setImage(_ image: CGImage?) {
        layer?.contents = image
        layer?.contentsGravity = .resize
        layer?.minificationFilter = .trilinear
        layer?.magnificationFilter = .linear
    }

    override func updateLayer() {}

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let t = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(t)
        tracking = t
    }

    override func mouseEntered(with event: NSEvent) { closeButton.isHidden = false }
    override func mouseExited(with event: NSEvent) { closeButton.isHidden = true }

    @objc private func closeClicked() { controller?.close() }

    override func mouseDown(with e: NSEvent) {
        window?.makeKey()
        if e.clickCount == 2 {
            controller?.openInEditor()
            return
        }
        window?.performDrag(with: e)
    }

    override func rightMouseDown(with e: NSEvent) {
        guard let menu = controller?.menu() else { return }
        NSMenu.popUpContextMenu(menu, with: e, for: self)
    }

    override func scrollWheel(with e: NSEvent) {
        let dy = e.hasPreciseScrollingDeltas ? e.scrollingDeltaY * 0.01 : e.scrollingDeltaY * 0.08
        guard dy != 0 else { return }
        controller?.scale(by: 1 + dy, around: NSEvent.mouseLocation)
    }

    override func magnify(with e: NSEvent) {
        controller?.scale(by: 1 + e.magnification, around: NSEvent.mouseLocation)
    }

    override func keyDown(with e: NSEvent) {
        if e.keyCode == 53 { controller?.close(); return }
        if let c = e.charactersIgnoringModifiers?.first, let d = c.wholeNumberValue,
           e.modifierFlags.intersection([.command, .control, .option]).isEmpty {
            controller?.setOpacity(d == 0 ? 1 : CGFloat(d) / 10)
            return
        }
        super.keyDown(with: e)
    }
}
