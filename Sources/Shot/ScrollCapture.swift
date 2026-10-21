import AppKit
import Carbon.HIToolbox
import ScreenCaptureKit
import ShotEditor
import BentoCore

/// Scrolling capture of a screen region: scrolls the content under the region
/// (or lets the user scroll), grabs frames and stitches them by vertical
/// overlap. Finishes on Esc / Return / click, at the end of the content, or
/// at the max height. Frames are only grabbed while a session runs.
final class ScrollCaptureSession {
    private(set) static var current: ScrollCaptureSession?
    static var isActive: Bool { current != nil }

    let region: CGRect // AX, whole points
    let up: Bool
    let settings: ShotSettings
    private let sourceApp: NSRunningApplication?
    private let completion: (CapturedImage?) -> Void
    private var content: SCShareableContent?
    private var chrome: Set<CGWindowID> = []
    private var stitcher: ScrollStitcher?
    private var scale: CGFloat = 2
    private var task: Task<Void, Never>?
    private var stopRequested = false
    private var cancelled = false
    private var border: NSWindow?
    private var panel: ScrollProgressPanel?
    private var monitors: [Any] = []
    private var message: String?

    static func start(region: CGRect, up: Bool, settings: ShotSettings, sourceApp: NSRunningApplication?,
                      completion: @escaping (CapturedImage?) -> Void) {
        guard current == nil else { return }
        let s = ScrollCaptureSession(region: region, up: up, settings: settings, sourceApp: sourceApp, completion: completion)
        current = s
        s.begin()
    }

    /// Stops the running session, keeping what was captured.
    static func stop() { current?.requestStop() }

    /// Stops the running session and discards it.
    static func cancel() { current?.cancel() }

    private init(region: CGRect, up: Bool, settings: ShotSettings, sourceApp: NSRunningApplication?, completion: @escaping (CapturedImage?) -> Void) {
        self.region = region.integral
        self.up = up
        self.settings = settings
        self.sourceApp = sourceApp
        self.completion = completion
    }

    // MARK: UI

    private func begin() {
        showChrome()
        installMonitors()
        task = Task { @MainActor [weak self] in await self?.run() }
    }

    private func showChrome() {
        let cocoa = NSScreen.cocoaRect(fromAX: region)
        let b = NSWindow(contentRect: cocoa.insetBy(dx: -3, dy: -3), styleMask: .borderless, backing: .buffered, defer: false)
        b.isOpaque = false
        b.backgroundColor = .clear
        b.ignoresMouseEvents = true
        b.level = .statusBar
        b.hasShadow = false
        b.isReleasedWhenClosed = false
        b.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        b.contentView = RegionBorderView()
        b.orderFrontRegardless()
        border = b

        let p = ScrollProgressPanel(manual: settings.scrollMode == .manual)
        p.onDone = { [weak self] in self?.requestStop() }
        p.onCancel = { [weak self] in self?.cancel() }
        p.onKey = { [weak self] code in
            guard let self else { return }
            if code == kVK_Escape || code == kVK_Return || code == kVK_ANSI_KeypadEnter { self.requestStop() }
        }
        let size = p.frame.size
        let visible = (NSScreen.containing(axRect: region) ?? NSScreen.main)?.visibleFrame ?? cocoa
        var origin = NSPoint(x: cocoa.midX - size.width / 2, y: cocoa.minY - size.height - 12)
        if origin.y < visible.minY + 4 {
            origin.y = cocoa.maxY + 12
            if origin.y + size.height > visible.maxY { origin.y = cocoa.minY + 12 }
        }
        origin.x = min(max(origin.x, visible.minX + 4), visible.maxX - size.width - 4)
        p.setFrameOrigin(origin)
        p.orderFrontRegardless()
        p.makeKey()
        panel = p
        updateStatus()
    }

    private func installMonitors() {
        // Clicking anywhere (outside our panel) or pressing Esc/Return in
        // another app finishes. Global monitors only see other apps' events.
        if let m = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown], handler: { [weak self] _ in
            self?.requestStop()
        }) { monitors.append(m) }
        if let m = NSEvent.addGlobalMonitorForEvents(matching: .keyDown, handler: { [weak self] e in
            let code = Int(e.keyCode)
            if code == kVK_Escape || code == kVK_Return || code == kVK_ANSI_KeypadEnter { self?.requestStop() }
        }) { monitors.append(m) }
    }

    private func updateStatus() {
        let px = stitcher?.height ?? 0
        let heightText = px > 0 ? "\(NumberFormatter.localizedString(from: NSNumber(value: px), number: .decimal)) px" : "Starting…"
        let action = settings.scrollMode == .manual ? (up ? "Scroll up slowly" : "Scroll down slowly") : "Scrolling"
        panel?.update(title: "\(action) · \(heightText)", detail: message ?? "Esc, Return or click to finish")
    }

    // MARK: Control

    private func requestStop() { stopRequested = true }

    private func cancel() {
        cancelled = true
        stopRequested = true
    }

    // MARK: Capture loop

    @MainActor
    private func run() async {
        do {
            chrome = ScreenGrabber.chromeWindowIDs()
            content = try await ScreenGrabber.content()
        } catch {
            message = error.localizedDescription
            finish()
            return
        }
        let manual = settings.scrollMode == .manual
        let center = CGPoint(x: region.midX, y: region.midY)
        if !manual {
            CGWarpMouseCursorPosition(center)
            CGAssociateMouseAndMouseCursorPosition(1)
            try? await Task.sleep(nanoseconds: 80_000_000)
        }
        guard let first = await grab() else { finish(); return }
        let st = ScrollStitcher(first: first, maxHeight: ScrollStitcher.cappedMaxHeight(settings.scrollMaxHeight, width: first.width),
                                ignoreRight: Int(16 * scale))
        stitcher = st
        updateStatus()

        let stepPoints = max(20, (region.height * settings.scrollSpeed.stepFraction).rounded())
        var unchanged = 0
        var misses = 0
        var backward = 0
        var skipScroll = false
        var lastChange = Date()

        while !stopRequested {
            var expected: Int?
            if manual {
                try? await Task.sleep(nanoseconds: 120_000_000)
            } else {
                if !skipScroll { scroll(by: stepPoints, at: center) }
                expected = Int(stepPoints * scale)
                try? await Task.sleep(nanoseconds: UInt64(settings.scrollSpeed.settle * 1_000_000_000))
            }
            skipScroll = false
            if stopRequested { break }
            guard let frame = await grab() else { break }
            switch st.add(frame, expectedShift: expected) {
            case .appended:
                unchanged = 0
                misses = 0
                backward = 0
                lastChange = Date()
                message = nil
            case .unchanged:
                unchanged += 1
                if manual {
                    let idle = Date().timeIntervalSince(lastChange)
                    if idle > (st.frameCount > 1 ? 3 : 15) { stopRequested = true }
                } else if unchanged == 1 {
                    // Maybe just slow to render: look again before scrolling
                    // further (two steps at once could lose the overlap).
                    skipScroll = true
                } else if unchanged >= 3 {
                    // Reached the end (or the content doesn't scroll at all).
                    if st.frameCount == 1 { message = "Nothing scrolled — captured the visible area" }
                    stopRequested = true
                }
            case .noMatch:
                misses += 1
                if manual {
                    message = "Too fast — scroll back a little"
                } else if misses >= 3 {
                    message = "Lost track of the content"
                    stopRequested = true
                } else {
                    skipScroll = true // an animation or late repaint: look again
                }
            case .backward:
                if manual {
                    message = up ? "Scroll up to continue" : "Scroll down to continue"
                } else {
                    backward += 1
                    if backward >= 2 {
                        // A scroll utility inverts synthetic events.
                        message = "Scrolled the wrong way — turn on Reverse scroll direction"
                        stopRequested = true
                    }
                }
            case .reachedMax:
                message = "Reached the maximum height"
                stopRequested = true
            }
            updateStatus()
        }
        finish()
    }

    /// Posts pixel-unit scroll-wheel events in small chunks (like a trackpad).
    private func scroll(by points: CGFloat, at p: CGPoint) {
        var sign: Int32 = up ? 1 : -1
        if settings.scrollReverse { sign = -sign }
        var left = Int32(points)
        while left > 0 {
            let chunk = min(left, 40)
            left -= chunk
            guard let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: chunk * sign, wheel2: 0, wheel3: 0) else { continue }
            e.location = p
            e.post(tap: .cghidEventTap)
        }
    }

    @MainActor
    private func grab() async -> PixelFrame? {
        do {
            let (image, s) = try await ScreenGrabber.capture(axRect: region, content: content, excluding: chrome)
            scale = s
            guard let f = PixelFrame(image) else { return nil }
            return up ? f.flippedVertically() : f
        } catch {
            ScreenGrabber.log.error("scroll frame failed: \(error.localizedDescription, privacy: .public)")
            message = error.localizedDescription
            return nil
        }
    }

    @MainActor
    private func finish() {
        for m in monitors { NSEvent.removeMonitor(m) }
        monitors = []
        border?.orderOut(nil)
        border = nil
        panel?.orderOut(nil)
        panel = nil
        let image = cancelled ? nil : stitcher?.makeImage(flipped: up, consume: true)
        ScreenGrabber.log.debug("scroll finished: frames=\(self.stitcher?.frameCount ?? 0) height=\(image?.height ?? 0) message=\(self.message ?? "-", privacy: .public)")
        stitcher = nil
        content = nil
        ScrollCaptureSession.current = nil
        if let message, !cancelled { HUD.show(message, symbol: "arrow.up.and.down.text.horizontal") }
        guard let image else { completion(nil); return }
        let rect = CGRect(x: region.minX, y: region.minY, width: region.width, height: CGFloat(image.height) / scale)
        completion(CapturedImage(image: image, scale: scale, rect: rect, kind: .scrolling,
                                 sourceAppName: sourceApp?.localizedName, sourceBundleID: sourceApp?.bundleIdentifier))
    }
}

/// Dashed accent frame drawn just outside the captured region.
private final class RegionBorderView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        let path = NSBezierPath(rect: bounds.insetBy(dx: 1.5, dy: 1.5))
        path.lineWidth = 2
        path.setLineDash([6, 4], count: 2, phase: 0)
        NSColor.controlAccentColor.setStroke()
        path.stroke()
    }
}

/// Progress HUD under the region: live height, Done / Cancel.
final class ScrollProgressPanel: KeyablePanel {
    var onDone: (() -> Void)?
    var onCancel: (() -> Void)?
    var onKey: ((Int) -> Void)?
    private let titleLabel = NSTextField(labelWithString: "")
    private let detailLabel = NSTextField(labelWithString: "")

    init(manual: Bool) {
        let size = NSSize(width: 360, height: 64)
        super.init(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        level = .statusBar
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        isReleasedWhenClosed = false
        becomesKeyOnlyIfNeeded = false

        let effect = NSVisualEffectView(frame: NSRect(origin: .zero, size: size))
        effect.material = .hudWindow
        effect.state = .active
        effect.blendingMode = .behindWindow
        effect.roundCorners(12)

        let icon = NSImageView(image: NSImage(systemSymbolName: "arrow.up.and.down.text.horizontal", accessibilityDescription: nil) ?? NSImage())
        icon.symbolConfiguration = .init(pointSize: 18, weight: .medium)
        icon.contentTintColor = .controlAccentColor
        titleLabel.font = .monospacedDigitSystemFont(ofSize: 13, weight: .semibold)
        titleLabel.lineBreakMode = .byTruncatingTail
        detailLabel.font = .systemFont(ofSize: 11)
        detailLabel.textColor = .secondaryLabelColor
        detailLabel.lineBreakMode = .byTruncatingTail
        let texts = NSStackView(views: [titleLabel, detailLabel])
        texts.orientation = .vertical
        texts.alignment = .leading
        texts.spacing = 2
        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancelPressed))
        cancel.bezelStyle = .rounded
        cancel.controlSize = .small
        let done = NSButton(title: "Done", target: self, action: #selector(donePressed))
        done.bezelStyle = .rounded
        done.controlSize = .small
        done.keyEquivalent = "\r"
        // Keys go to the panel (Esc/Return finish), not to a focused button.
        cancel.refusesFirstResponder = true
        done.refusesFirstResponder = true
        let row = NSStackView(views: [icon, texts, NSView(), cancel, done])
        row.orientation = .horizontal
        row.spacing = 8
        row.edgeInsets = NSEdgeInsets(top: 8, left: 14, bottom: 8, right: 12)
        row.translatesAutoresizingMaskIntoConstraints = false
        effect.addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: effect.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: effect.trailingAnchor),
            row.topAnchor.constraint(equalTo: effect.topAnchor),
            row.bottomAnchor.constraint(equalTo: effect.bottomAnchor),
            texts.widthAnchor.constraint(lessThanOrEqualToConstant: 200),
        ])
        contentView = effect
    }

    func update(title: String, detail: String) {
        titleLabel.stringValue = title
        detailLabel.stringValue = detail
    }

    @objc private func donePressed() { onDone?() }
    @objc private func cancelPressed() { onCancel?() }

    override func keyDown(with event: NSEvent) { onKey?(Int(event.keyCode)) }
    override func cancelOperation(_ sender: Any?) { onKey?(kVK_Escape) }
}
