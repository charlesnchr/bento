import AppKit
import Carbon.HIToolbox
import BentoCore

/// What the frozen-screen overlay is used for.
enum OverlayMode: Equatable { case area, window, color }

enum OverlayOutcome {
    /// A rect in display-local points on a frozen display.
    case area(DisplaySnapshot, CGRect)
    /// A picked window, plus the frozen display it is (mostly) on.
    case window(WindowInfo, DisplaySnapshot?)
    /// The colour picker copied a value (already on the clipboard).
    case color
    case cancelled
}

/// Frozen-screen overlay across all displays: area selection with loupe,
/// size label and ruler; window picking; colour picking.
///
/// Keys (area): drag or arrows+Return to select, Shift square, Option from
/// centre, Space+drag moves the selection, Space alone toggles window mode,
/// arrows nudge 1 pt (Shift 10), Tab copies the colour under the cursor
/// (Shift+Tab the text colour), hold Option for the pixel ruler, Esc cancels.
final class CaptureOverlay {
    struct Options {
        var mode: OverlayMode = .area
        var allowWindowMode = true
        var magnifier = true
        var adjustable = false
        var colorFormat: ColorFormat = .hex
        /// Shown in the hint ("Copy Text", "Scrolling Capture").
        var title: String?
    }

    private(set) static var current: CaptureOverlay?

    let snapshots: [DisplaySnapshot]
    private(set) var windows: [WindowInfo]
    private let options: Options
    private let completion: (OverlayOutcome) -> Void
    private var panels: [OverlayPanel] = []
    private var views: [OverlayView] = []

    // State
    private(set) var mode: OverlayMode
    private(set) var cursor = CGPoint.zero          // global AX
    private(set) var cursorDisplay = 0
    private(set) var selectionDisplay: Int?
    private(set) var selection: CGRect?             // local to selectionDisplay
    private var anchor: CGPoint?                    // local
    private var dragging = false
    private var keyboardSelecting = false
    private(set) var adjusting = false
    private var spaceDown = false
    private var lastDragPoint: CGPoint?
    private var adjustDrag: AdjustDrag?
    private(set) var hoveredWindow: Int?
    private(set) var modifiers: NSEvent.ModifierFlags = []
    private(set) var colorFormat: ColorFormat
    private(set) var showHint = true
    /// Transient confirmation shown inside the overlay (the HUD sits below it).
    private(set) var flash: String?
    private var flashWork: DispatchWorkItem?
    private var finished = false
    private var pixelCache: [Int: PixelFrame] = [:]
    private var screenObserver: NSObjectProtocol?

    enum AdjustDrag { case move(start: CGPoint, original: CGRect), resize(edges: Edges, original: CGRect) }
    struct Edges: OptionSet { let rawValue: Int; static let left = Edges(rawValue: 1), right = Edges(rawValue: 2), top = Edges(rawValue: 4), bottom = Edges(rawValue: 8) }

    /// Starts an overlay unless one is already up. Returns false if busy.
    @discardableResult
    static func present(snapshots: [DisplaySnapshot], options: Options, completion: @escaping (OverlayOutcome) -> Void) -> Bool {
        guard current == nil, !snapshots.isEmpty else { return false }
        let o = CaptureOverlay(snapshots: snapshots, options: options, completion: completion)
        current = o
        o.show()
        return true
    }

    static var isActive: Bool { current != nil }

    private init(snapshots: [DisplaySnapshot], options: Options, completion: @escaping (OverlayOutcome) -> Void) {
        self.snapshots = snapshots
        self.options = options
        self.completion = completion
        self.mode = options.mode
        self.colorFormat = options.colorFormat
        self.windows = (options.mode == .window || options.allowWindowMode) ? ScreenGrabber.windowList() : []
    }

    // MARK: Lifecycle

    private func show() {
        cursor = NSScreen.mouseAX
        cursorDisplay = displayIndex(at: cursor) ?? 0
        for (i, snap) in snapshots.enumerated() {
            let panel = OverlayPanel(frame: snap.screen.frame)
            let view = OverlayView(frame: NSRect(origin: .zero, size: snap.screen.frame.size), overlay: self, index: i)
            panel.contentView = view
            panel.setFrame(snap.screen.frame, display: false)
            panels.append(panel)
            views.append(view)
        }
        updateHover()
        for v in views { v.refresh() }
        for p in panels { p.orderFrontRegardless() }
        let keyPanel = panels[min(cursorDisplay, panels.count - 1)]
        keyPanel.makeKeyAndOrderFront(nil)
        keyPanel.makeFirstResponder(keyPanel.contentView)
        currentCursor.set()
        // A display added, removed or rearranged invalidates the frozen
        // frames and panel positions: cancel rather than capture wrong pixels.
        screenObserver = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                                                object: nil, queue: .main) { [weak self] _ in
            guard let self, !CaptureOverlay.layoutMatches(self.snapshots) else { return }
            ScreenGrabber.log.debug("overlay cancelled: display configuration changed")
            self.finish(.cancelled)
        }
        ScreenGrabber.log.debug("overlay shown on \(self.panels.count) display(s), key=\(keyPanel.isKeyWindow), mode=\(String(describing: self.mode), privacy: .public)")
    }

    /// Whether every frozen display still exists with the same frame (a
    /// resolution or scale change changes the point frame too).
    static func layoutMatches(_ snaps: [DisplaySnapshot]) -> Bool {
        let now = Dictionary(NSScreen.screens.map { ($0.displayID, $0.axFrame) }, uniquingKeysWith: { a, _ in a })
        return snaps.allSatisfy { now[$0.displayID] == $0.axFrame }
    }

    func finish(_ outcome: OverlayOutcome) {
        guard !finished else { return }
        finished = true
        if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
        screenObserver = nil
        ScreenGrabber.log.debug("overlay finished: \(String(describing: outcome).prefix(80), privacy: .public)")
        for p in panels { p.orderOut(nil) }
        for v in views { v.teardown() }
        for p in panels { p.contentView = nil }
        panels = []
        views = []
        pixelCache = [:]
        flashWork?.cancel()
        flashWork = nil
        CaptureOverlay.current = nil
        NSCursor.arrow.set()
        completion(outcome)
    }

    var currentCursor: NSCursor {
        mode == .window ? CaptureOverlay.cameraCursor : NSCursor.crosshair
    }

    static let cameraCursor: NSCursor = {
        let cfg = NSImage.SymbolConfiguration(pointSize: 18, weight: .regular)
        guard let img = NSImage(systemSymbolName: "camera.fill", accessibilityDescription: nil)?.withSymbolConfiguration(cfg) else { return .crosshair }
        let size = img.size
        let out = NSImage(size: NSSize(width: size.width + 4, height: size.height + 4), flipped: false) { r in
            let shadow = NSShadow()
            shadow.shadowColor = NSColor.black.withAlphaComponent(0.6)
            shadow.shadowBlurRadius = 2
            shadow.set()
            let tinted = NSImage(size: size, flipped: false) { rr in
                img.draw(in: rr)
                NSColor.white.set()
                rr.fill(using: .sourceAtop)
                return true
            }
            tinted.draw(in: NSRect(x: 2, y: 2, width: size.width, height: size.height))
            return true
        }
        return NSCursor(image: out, hotSpot: NSPoint(x: out.size.width / 2, y: out.size.height / 2))
    }()

    // MARK: Queries for views

    func snapshot(_ i: Int) -> DisplaySnapshot { snapshots[i] }

    func displayIndex(at p: CGPoint) -> Int? {
        snapshots.firstIndex { $0.axFrame.contains(p) }
            ?? snapshots.enumerated().min { distance(p, $0.element.axFrame) < distance(p, $1.element.axFrame) }?.offset
    }

    private func distance(_ p: CGPoint, _ r: CGRect) -> CGFloat {
        let c = ShotGeometry.clamp(p, to: r)
        return hypot(c.x - p.x, c.y - p.y)
    }

    var isSelecting: Bool { dragging || keyboardSelecting || adjusting }

    var magnifierEnabled: Bool { options.magnifier }

    var hoveredWindowInfo: WindowInfo? { hoveredWindow.map { windows[$0] } }

    private func snapshotFor(_ w: WindowInfo) -> DisplaySnapshot? {
        snapshots.max { a, b in
            let ia = a.axFrame.intersection(w.frame), ib = b.axFrame.intersection(w.frame)
            return (ia.isNull ? 0 : ia.width * ia.height) < (ib.isNull ? 0 : ib.width * ib.height)
        }
    }

    var showsRuler: Bool { mode == .area && !isSelecting && modifiers.contains(.option) }

    var hintText: String {
        var parts: [String] = []
        if let t = options.title { parts.append(t) }
        switch mode {
        case .area where adjusting:
            parts += ["↩ Capture", "Drag to adjust", "Arrows move · ⌘ resize", "⎋ Cancel"]
        case .area:
            parts += ["Drag to select"]
            if options.allowWindowMode { parts.append("Space Window") }
            parts += ["⌥ Ruler", "⇥ Copy colour", "⎋ Cancel"]
        case .window:
            parts += ["Click a window"]
            if options.allowWindowMode { parts.append("Space Area") }
            parts.append("⎋ Cancel")
        case .color:
            parts += ["Click to copy \(colorFormat.shortName)", "⇧ Text colour", "F Format", "⎋ Cancel"]
        }
        return parts.joined(separator: "   ·   ")
    }

    func colorAtCursor() -> RGB8? {
        let snap = snapshots[cursorDisplay]
        let p = ShotGeometry.pixel(at: ShotGeometry.local(cursor, in: snap.axFrame), scale: snap.scale)
        return ScreenGrabber.color(in: snap.image, x: p.x, y: p.y)
    }

    /// Full pixel buffer of a display, created on first use (ruler, text colour).
    func pixels(_ i: Int) -> PixelFrame? {
        if let f = pixelCache[i] { return f }
        let f = PixelFrame(snapshots[i].image)
        pixelCache[i] = f
        return f
    }

    /// Ruler extents around the cursor in pixels of the cursor's display.
    func rulerExtent() -> (left: Int, right: Int, up: Int, down: Int, origin: (x: Int, y: Int))? {
        guard let f = pixels(cursorDisplay) else { return nil }
        let snap = snapshots[cursorDisplay]
        let p = ShotGeometry.pixel(at: ShotGeometry.local(cursor, in: snap.axFrame), scale: snap.scale)
        guard p.x >= 0, p.y >= 0, p.x < f.width, p.y < f.height else { return nil }
        let base = f.pixels[p.y * f.width + p.x]
        let e = f.pixels.withUnsafeBufferPointer { px in
            ShotGeometry.rulerExtent(from: p, width: f.width, height: f.height) { x, y in
                CaptureOverlay.similar(px[y * f.width + x], base)
            }
        }
        return (e.left, e.right, e.up, e.down, p)
    }

    static func similar(_ a: UInt32, _ b: UInt32, tolerance: Int = 8) -> Bool {
        if a == b { return true }
        for shift in [0, 8, 16] as [UInt32] {
            if abs(Int(a >> shift & 0xFF) - Int(b >> shift & 0xFF)) > tolerance { return false }
        }
        return true
    }

    // MARK: Mouse

    func mouseMoved(to p: CGPoint) {
        let oldDisplay = cursorDisplay
        cursor = p
        cursorDisplay = displayIndex(at: p) ?? cursorDisplay
        if mode == .window { updateHover() }
        currentCursor.set()
        refresh(displays: [oldDisplay, cursorDisplay])
    }

    func mouseDown(at p: CGPoint, event: NSEvent) {
        cursor = p
        cursorDisplay = displayIndex(at: p) ?? cursorDisplay
        switch mode {
        case .color:
            pickColor(text: event.modifierFlags.contains(.shift))
        case .window:
            updateHover()
            if let w = hoveredWindowInfo { finish(.window(w, snapshotFor(w))) }
        case .area:
            if adjusting, let sel = selection, let d = selectionDisplay {
                let local = ShotGeometry.local(p, in: snapshots[d].axFrame)
                if event.clickCount >= 2 && sel.contains(local) { confirm(); return }
                let edges = hitEdges(local, sel)
                if !edges.isEmpty {
                    adjustDrag = .resize(edges: edges, original: sel)
                    return
                } else if sel.contains(local) {
                    adjustDrag = .move(start: local, original: sel)
                    return
                }
                // Outside: start over.
                adjusting = false
            }
            keyboardSelecting = false
            beginSelection(at: p)
            dragging = true
        }
        refreshAll()
    }

    func mouseDragged(to p: CGPoint) {
        cursor = p
        let oldDisplay = cursorDisplay
        cursorDisplay = displayIndex(at: p) ?? cursorDisplay
        if mode == .area {
            if let drag = adjustDrag, let d = selectionDisplay {
                applyAdjust(drag, to: ShotGeometry.local(p, in: snapshots[d].axFrame))
            } else if dragging || keyboardSelecting {
                updateSelection(to: p)
            }
        }
        currentCursor.set()
        refresh(displays: [oldDisplay, cursorDisplay, selectionDisplay ?? cursorDisplay])
    }

    func mouseUp(at p: CGPoint) {
        if adjustDrag != nil {
            adjustDrag = nil
            refreshAll()
            return
        }
        guard mode == .area, dragging else { return }
        dragging = false
        lastDragPoint = nil
        completeSelection()
    }

    // MARK: Selection

    private func beginSelection(at p: CGPoint) {
        let d = displayIndex(at: p) ?? cursorDisplay
        selectionDisplay = d
        let local = ShotGeometry.snap(ShotGeometry.clamp(ShotGeometry.local(p, in: snapshots[d].axFrame), to: snapshots[d].localBounds))
        anchor = local
        selection = CGRect(origin: local, size: .zero)
        lastDragPoint = local
        showHint = false
    }

    private func updateSelection(to p: CGPoint) {
        guard let d = selectionDisplay, let a = anchor else { return }
        let bounds = snapshots[d].localBounds
        let local = ShotGeometry.clamp(ShotGeometry.local(p, in: snapshots[d].axFrame), to: bounds)
        if spaceDown, let last = lastDragPoint, let sel = selection {
            // Space held: move the whole selection.
            let moved = ShotGeometry.move(sel, by: CGVector(dx: (local.x - last.x).rounded(), dy: (local.y - last.y).rounded()), within: bounds)
            let delta = CGPoint(x: moved.minX - sel.minX, y: moved.minY - sel.minY)
            anchor = CGPoint(x: a.x + delta.x, y: a.y + delta.y)
            selection = moved
            lastDragPoint = CGPoint(x: last.x + delta.x, y: last.y + delta.y)
            return
        }
        lastDragPoint = ShotGeometry.snap(local)
        // In a keyboard selection Shift means 10-pt arrow steps, not "square".
        selection = ShotGeometry.selection(anchor: a, current: ShotGeometry.snap(local),
                                           square: modifiers.contains(.shift) && !keyboardSelecting,
                                           fromCenter: modifiers.contains(.option), bounds: bounds)
    }

    private func completeSelection() {
        guard let sel = selection, sel.width >= 2, sel.height >= 2 else {
            selection = nil; anchor = nil; selectionDisplay = nil; keyboardSelecting = false
            refreshAll()
            return
        }
        keyboardSelecting = false
        if options.adjustable {
            adjusting = true
            showHint = true
            refreshAll()
        } else {
            confirm()
        }
    }

    private func confirm() {
        guard let sel = selection, let d = selectionDisplay, sel.width >= 1, sel.height >= 1 else { return }
        finish(.area(snapshots[d], sel))
    }

    private func hitEdges(_ p: CGPoint, _ r: CGRect) -> Edges {
        let tol: CGFloat = 6
        guard r.insetBy(dx: -tol, dy: -tol).contains(p) else { return [] }
        var e: Edges = []
        if abs(p.x - r.minX) <= tol { e.insert(.left) }
        if abs(p.x - r.maxX) <= tol { e.insert(.right) }
        if abs(p.y - r.minY) <= tol { e.insert(.top) }
        if abs(p.y - r.maxY) <= tol { e.insert(.bottom) }
        return e
    }

    private func applyAdjust(_ drag: AdjustDrag, to local: CGPoint) {
        guard let d = selectionDisplay else { return }
        let bounds = snapshots[d].localBounds
        let p = ShotGeometry.snap(ShotGeometry.clamp(local, to: bounds))
        switch drag {
        case let .move(start, original):
            selection = ShotGeometry.move(original, by: CGVector(dx: (p.x - start.x).rounded(), dy: (p.y - start.y).rounded()), within: bounds)
        case let .resize(edges, o):
            var minX = o.minX, maxX = o.maxX, minY = o.minY, maxY = o.maxY
            if edges.contains(.left) { minX = p.x }
            if edges.contains(.right) { maxX = p.x }
            if edges.contains(.top) { minY = p.y }
            if edges.contains(.bottom) { maxY = p.y }
            selection = CGRect(x: min(minX, maxX), y: min(minY, maxY), width: max(1, abs(maxX - minX)), height: max(1, abs(maxY - minY)))
        }
    }

    // MARK: Keyboard

    func keyDown(_ e: NSEvent) {
        let code = Int(e.keyCode)
        let shift = e.modifierFlags.contains(.shift)
        let cmd = e.modifierFlags.contains(.command)
        switch code {
        case kVK_Escape:
            finish(.cancelled)
        case kVK_Return, kVK_ANSI_KeypadEnter:
            handleReturn()
        case kVK_Space:
            guard !e.isARepeat else { return }
            if dragging || keyboardSelecting {
                spaceDown = true
            } else if options.allowWindowMode && !adjusting && mode != .color {
                mode = mode == .window ? .area : .window
                showHint = true
                updateHover()
                currentCursor.set()
                refreshAll()
            }
        case kVK_LeftArrow, kVK_RightArrow, kVK_UpArrow, kVK_DownArrow:
            let step: CGFloat = shift ? 10 : 1
            var v = CGVector.zero
            switch code {
            case kVK_LeftArrow: v.dx = -step
            case kVK_RightArrow: v.dx = step
            case kVK_UpArrow: v.dy = -step
            default: v.dy = step
            }
            arrow(v, resize: cmd)
        case kVK_Tab:
            if mode == .color { pickColor(text: shift) } else { copyColor(text: shift, finishAfter: false) }
        case kVK_ANSI_F where mode == .color:
            colorFormat = colorFormat.next
            showHint = true
            refreshAll()
        case kVK_ANSI_LeftBracket, kVK_ANSI_RightBracket:
            guard adjusting, let sel = selection, let d = selectionDisplay else { return }
            let s: CGFloat = (shift ? 10 : 1) * (code == kVK_ANSI_RightBracket ? 1 : -1)
            let grown = sel.insetBy(dx: -s, dy: -s).intersection(snapshots[d].localBounds)
            if !grown.isNull, grown.width >= 1, grown.height >= 1 { selection = grown }
            refreshAll()
        default:
            break
        }
    }

    func keyUp(_ e: NSEvent) {
        if Int(e.keyCode) == kVK_Space { spaceDown = false }
    }

    func flagsChanged(_ e: NSEvent) {
        modifiers = e.modifierFlags.intersection([.shift, .option, .command, .control])
        if dragging || keyboardSelecting { updateSelection(to: cursor) }
        refreshAll()
    }

    private func handleReturn() {
        switch mode {
        case .color:
            pickColor(text: false)
        case .window:
            updateHover()
            if let w = hoveredWindowInfo { finish(.window(w, snapshotFor(w))) }
        case .area:
            if adjusting { confirm(); return }
            if keyboardSelecting {
                completeSelection()
            } else if !dragging {
                // Keyboard selection: Return anchors at the cursor, arrows extend, Return finishes.
                beginSelection(at: cursor)
                keyboardSelecting = true
                refreshAll()
            }
        }
    }

    private func arrow(_ v: CGVector, resize: Bool) {
        if adjusting, let sel = selection, let d = selectionDisplay {
            let bounds = snapshots[d].localBounds
            if resize {
                let r = CGRect(x: sel.minX, y: sel.minY, width: max(1, sel.width + v.dx), height: max(1, sel.height + v.dy))
                selection = r.intersection(bounds).nullToZero
            } else {
                selection = ShotGeometry.move(sel, by: v, within: bounds)
            }
            refreshAll()
            return
        }
        // Move the real pointer so loupe, selection and the cursor agree.
        let target = CGPoint(x: (cursor.x + v.dx).rounded(), y: (cursor.y + v.dy).rounded())
        let union = snapshots.reduce(CGRect.null) { $0.union($1.axFrame) }
        let p = ShotGeometry.clamp(target, to: CGRect(x: union.minX, y: union.minY, width: union.width - 1, height: union.height - 1))
        CGWarpMouseCursorPosition(p)
        CGAssociateMouseAndMouseCursorPosition(1)
        if dragging || keyboardSelecting {
            if spaceDown && keyboardSelecting, let sel = selection, let d = selectionDisplay, let a = anchor {
                let moved = ShotGeometry.move(sel, by: v, within: snapshots[d].localBounds)
                anchor = CGPoint(x: a.x + moved.minX - sel.minX, y: a.y + moved.minY - sel.minY)
                selection = moved
                cursor = p
                cursorDisplay = displayIndex(at: p) ?? cursorDisplay
                refreshAll()
                return
            }
            mouseDragged(to: p)
        } else {
            mouseMoved(to: p)
        }
    }

    // MARK: Colour

    /// Colour under the cursor, or the darkest pixel of the 20×20 px block
    /// around it (Shottr's "text colour").
    private func sampleColor(text: Bool) -> RGB8? {
        guard text else { return colorAtCursor() }
        let snap = snapshots[cursorDisplay]
        let p = ShotGeometry.pixel(at: ShotGeometry.local(cursor, in: snap.axFrame), scale: snap.scale)
        guard let (block, _) = ScreenGrabber.block(in: snap.image, x: p.x - 10, y: p.y - 10, width: 20, height: 20) else { return nil }
        return block.pixels.map(\.rgb8).min { $0.luma < $1.luma }
    }

    private func copyColor(text: Bool, finishAfter: Bool) {
        guard let c = sampleColor(text: text) else { return }
        let s = colorFormat.string(c)
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(s, forType: .string)
        let message = text ? "Text colour \(s) copied" : "\(s) copied"
        if finishAfter {
            finish(.color)
            HUD.show(message, symbol: "eyedropper", on: snapshots[cursorDisplay].screen)
        } else {
            showFlash(message)
        }
    }

    private func pickColor(text: Bool) { copyColor(text: text, finishAfter: true) }

    private func showFlash(_ text: String) {
        flash = text
        flashWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.flash = nil
            self?.refreshAll()
        }
        flashWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2, execute: work)
        refreshAll()
    }

    // MARK: Hover / refresh

    private func updateHover() {
        guard mode == .window else { hoveredWindow = nil; return }
        hoveredWindow = ShotGeometry.frontmost(at: cursor, in: windows.map(\.frame))
    }

    private func refresh(displays: Set<Int>) {
        for i in displays where i < views.count { views[i].refresh() }
    }

    func refreshAll() { for v in views { v.refresh() } }
}

extension ColorFormat {
    var shortName: String {
        switch self {
        case .hex: return "HEX"
        case .hexNoHash: return "HEX"
        case .rgb: return "RGB"
        case .hsl: return "HSL"
        case .oklch: return "OKLCH"
        }
    }
}

// MARK: - View

/// One display's overlay: frozen image as a layer, dimming with a hole for
/// the selection, selection border/handles, window highlight, labels, loupe.
/// Only small layers/views change on mouse moves, so tracking stays cheap.
final class OverlayView: NSView {
    private weak var overlay: CaptureOverlay?
    let index: Int
    private let imageLayer = CALayer()
    private let dimLayer = CAShapeLayer()
    private let outlineDark = CAShapeLayer()
    private let outline = CAShapeLayer()
    private let handles = CAShapeLayer()
    private let highlight = CAShapeLayer()
    private let ruler = CAShapeLayer()
    private let sizeLabel = PillLabel()
    private let rulerLabel = PillLabel()
    private let windowLabel = PillLabel()
    private let hint = PillLabel()
    private let flashLabel = PillLabel()
    private let loupe = LoupeView(frame: NSRect(origin: .zero, size: LoupeView.size))
    private var trackingArea: NSTrackingArea?

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    init(frame: NSRect, overlay: CaptureOverlay, index: Int) {
        self.overlay = overlay
        self.index = index
        super.init(frame: frame)
        wantsLayer = true
        let snap = overlay.snapshot(index)
        let root = layer!
        root.backgroundColor = NSColor.black.cgColor
        imageLayer.contents = snap.image
        imageLayer.contentsGravity = .resize
        imageLayer.contentsScale = snap.scale
        imageLayer.magnificationFilter = .nearest
        imageLayer.frame = bounds
        root.addSublayer(imageLayer)

        dimLayer.fillRule = .evenOdd
        dimLayer.fillColor = NSColor.black.withAlphaComponent(0.32).cgColor
        root.addSublayer(dimLayer)

        highlight.fillColor = NSColor.controlAccentColor.withAlphaComponent(0.22).cgColor
        highlight.strokeColor = NSColor.controlAccentColor.cgColor
        highlight.lineWidth = 2
        root.addSublayer(highlight)

        outlineDark.fillColor = nil
        outlineDark.strokeColor = NSColor.black.withAlphaComponent(0.55).cgColor
        outlineDark.lineWidth = 3
        root.addSublayer(outlineDark)
        outline.fillColor = nil
        outline.strokeColor = NSColor.white.cgColor
        outline.lineWidth = 1
        root.addSublayer(outline)

        handles.fillColor = NSColor.white.cgColor
        handles.strokeColor = NSColor.black.withAlphaComponent(0.5).cgColor
        handles.lineWidth = 1
        root.addSublayer(handles)

        ruler.strokeColor = NSColor.systemPink.cgColor
        ruler.fillColor = nil
        ruler.lineWidth = 1
        root.addSublayer(ruler)

        for v in [windowLabel, rulerLabel, sizeLabel, hint, flashLabel] as [NSView] {
            v.isHidden = true
            addSubview(v)
        }
        hint.font = .systemFont(ofSize: 12, weight: .medium)
        hint.insets = NSSize(width: 14, height: 7)
        windowLabel.font = .systemFont(ofSize: 12, weight: .medium)
        flashLabel.font = .systemFont(ofSize: 14, weight: .semibold)
        flashLabel.insets = NSSize(width: 16, height: 9)
        loupe.isHidden = true
        loupe.image = snap.image
        addSubview(loupe)
    }

    required init?(coder: NSCoder) { fatalError() }

    func teardown() {
        imageLayer.contents = nil
        loupe.image = nil
        if let trackingArea { removeTrackingArea(trackingArea) }
        trackingArea = nil
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let t = NSTrackingArea(rect: bounds, options: [.mouseMoved, .activeAlways, .inVisibleRect, .mouseEnteredAndExited, .cursorUpdate], owner: self)
        addTrackingArea(t)
        trackingArea = t
    }

    override func resetCursorRects() {
        if let c = overlay?.currentCursor { addCursorRect(bounds, cursor: c) }
    }

    override func cursorUpdate(with event: NSEvent) { overlay?.currentCursor.set() }

    // MARK: Events -> overlay (global AX coordinates)

    private func global(_ e: NSEvent) -> CGPoint {
        guard let overlay else { return .zero }
        let local = convert(e.locationInWindow, from: nil)
        return ShotGeometry.global(local, in: overlay.snapshot(index).axFrame)
    }

    override func mouseMoved(with e: NSEvent) { overlay?.mouseMoved(to: global(e)) }
    override func mouseEntered(with e: NSEvent) { overlay?.mouseMoved(to: global(e)) }
    override func mouseDown(with e: NSEvent) { overlay?.mouseDown(at: global(e), event: e) }
    override func mouseDragged(with e: NSEvent) { overlay?.mouseDragged(to: global(e)) }
    override func mouseUp(with e: NSEvent) { overlay?.mouseUp(at: global(e)) }
    override func rightMouseDown(with e: NSEvent) { overlay?.finish(.cancelled) }
    override func keyDown(with e: NSEvent) { overlay?.keyDown(e) }
    override func keyUp(with e: NSEvent) { overlay?.keyUp(e) }
    override func flagsChanged(with e: NSEvent) { overlay?.flagsChanged(e) }
    override func performKeyEquivalent(with e: NSEvent) -> Bool {
        // ⌘-arrows resize an adjustable selection; swallow other ⌘ keys.
        if e.type == .keyDown { overlay?.keyDown(e) }
        return true
    }

    // MARK: Rendering

    func refresh() {
        guard let o = overlay else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }

        let snap = o.snapshot(index)
        let full = CGPath(rect: bounds, transform: nil)

        // Selection, dimming, handles.
        if o.mode == .area, let sel = o.selection, o.isSelecting {
            if o.selectionDisplay == index {
                let p = CGMutablePath()
                p.addRect(bounds)
                p.addRect(sel)
                dimLayer.path = p
                outline.path = CGPath(rect: sel.insetBy(dx: -0.5, dy: -0.5), transform: nil)
                outlineDark.path = CGPath(rect: sel.insetBy(dx: -1, dy: -1), transform: nil)
                if o.adjusting {
                    let hp = CGMutablePath()
                    let pts = [CGPoint(x: sel.minX, y: sel.minY), CGPoint(x: sel.midX, y: sel.minY), CGPoint(x: sel.maxX, y: sel.minY),
                               CGPoint(x: sel.minX, y: sel.midY), CGPoint(x: sel.maxX, y: sel.midY),
                               CGPoint(x: sel.minX, y: sel.maxY), CGPoint(x: sel.midX, y: sel.maxY), CGPoint(x: sel.maxX, y: sel.maxY)]
                    for c in pts { hp.addEllipse(in: CGRect(x: c.x - 4, y: c.y - 4, width: 8, height: 8)) }
                    handles.path = hp
                } else {
                    handles.path = nil
                }
                sizeLabel.text = "\(Int(sel.width)) × \(Int(sel.height))"
                let size = sizeLabel.fittingSizeForText
                sizeLabel.frame = NSRect(origin: ShotGeometry.sizeLabelOrigin(selection: sel, labelSize: size, bounds: bounds), size: size)
                sizeLabel.isHidden = false
            } else {
                dimLayer.path = full
                outline.path = nil; outlineDark.path = nil; handles.path = nil
                sizeLabel.isHidden = true
            }
        } else {
            dimLayer.path = nil
            outline.path = nil; outlineDark.path = nil; handles.path = nil
            sizeLabel.isHidden = true
        }

        // Window highlight.
        if o.mode == .window, let w = o.hoveredWindowInfo, w.frame.intersects(snap.axFrame) {
            let r = ShotGeometry.localRect(w.frame, in: snap.axFrame)
            highlight.path = CGPath(rect: r.insetBy(dx: 1, dy: 1), transform: nil)
            let p = CGMutablePath()
            p.addRect(bounds)
            p.addRect(r)
            dimLayer.path = p
            windowLabel.text = "\(w.appName)   \(Int(w.frame.width)) × \(Int(w.frame.height))"
            let size = windowLabel.fittingSizeForText
            let vis = r.intersection(bounds)
            windowLabel.frame = NSRect(x: vis.midX - size.width / 2, y: max(vis.minY + 8, 8), width: size.width, height: size.height)
            windowLabel.isHidden = false
        } else {
            highlight.path = nil
            windowLabel.isHidden = true
        }

        let cursorHere = o.cursorDisplay == index
        let localCursor = ShotGeometry.local(o.cursor, in: snap.axFrame)

        // Ruler (hold Option).
        if cursorHere, o.showsRuler, let e = o.rulerExtent() {
            let s = snap.scale
            let y = (CGFloat(e.origin.y) + 0.5) / s
            let x = (CGFloat(e.origin.x) + 0.5) / s
            let x0 = CGFloat(e.left) / s, x1 = CGFloat(e.right + 1) / s
            let y0 = CGFloat(e.up) / s, y1 = CGFloat(e.down + 1) / s
            let p = CGMutablePath()
            p.move(to: CGPoint(x: x0, y: y)); p.addLine(to: CGPoint(x: x1, y: y))
            p.move(to: CGPoint(x: x, y: y0)); p.addLine(to: CGPoint(x: x, y: y1))
            for (a, b) in [(CGPoint(x: x0, y: y - 4), CGPoint(x: x0, y: y + 4)), (CGPoint(x: x1, y: y - 4), CGPoint(x: x1, y: y + 4)),
                           (CGPoint(x: x - 4, y: y0), CGPoint(x: x + 4, y: y0)), (CGPoint(x: x - 4, y: y1), CGPoint(x: x + 4, y: y1))] {
                p.move(to: a); p.addLine(to: b)
            }
            ruler.path = p
            let wPt = CGFloat(e.right - e.left + 1) / s, hPt = CGFloat(e.down - e.up + 1) / s
            rulerLabel.text = "\(ShotFormat.points(wPt)) × \(ShotFormat.points(hPt))"
            let size = rulerLabel.fittingSizeForText
            rulerLabel.frame = NSRect(origin: CGPoint(x: x + 8, y: y - size.height - 8), size: size)
            rulerLabel.isHidden = false
        } else {
            ruler.path = nil
            rulerLabel.isHidden = true
        }

        // Loupe.
        let wantLoupe = cursorHere && (o.mode == .color || (o.mode == .area && o.magnifierEnabled))
        if wantLoupe {
            let px = ShotGeometry.pixel(at: localCursor, scale: snap.scale)
            loupe.pixel = px
            loupe.coordinateText = "\(Int(localCursor.x.rounded(.down))), \(Int(localCursor.y.rounded(.down)))"
            let c = o.colorAtCursor()
            loupe.color = c
            loupe.colorText = c.map { o.colorFormat.string($0) } ?? ""
            let origin = ShotGeometry.floatingOrigin(near: localCursor, size: LoupeView.size, offset: 22, bounds: bounds.insetBy(dx: 4, dy: 4))
            loupe.frame = NSRect(origin: origin, size: LoupeView.size)
            loupe.isHidden = false
            loupe.needsDisplay = true
        } else {
            loupe.isHidden = true
        }

        // Confirmation ("#1E90FF copied").
        if let f = o.flash, cursorHere {
            flashLabel.text = f
            let size = flashLabel.fittingSizeForText
            flashLabel.frame = NSRect(x: (bounds.width - size.width) / 2, y: bounds.height * 0.8 - size.height, width: size.width, height: size.height)
            flashLabel.isHidden = false
        } else {
            flashLabel.isHidden = true
        }

        // Hint.
        if o.showHint && cursorHere && (!o.isSelecting || o.adjusting) {
            hint.text = o.hintText
            let size = hint.fittingSizeForText
            hint.frame = NSRect(x: (bounds.width - size.width) / 2, y: bounds.height - size.height - 48, width: size.width, height: size.height)
            hint.isHidden = false
        } else {
            hint.isHidden = true
        }
    }
}

enum ShotFormat {
    /// "12" or "12.5" for point sizes (half points occur on Retina).
    static func points(_ v: CGFloat) -> String {
        let r = (v * 2).rounded() / 2
        return r == r.rounded() ? "\(Int(r))" : String(format: "%.1f", r)
    }
}
