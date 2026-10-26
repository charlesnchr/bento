import AppKit
import BentoCore

/// The displays at one moment, in AX coordinates.
struct ScreenSnapshot {
    let screens: [NSScreen]
    let rects: [ScreenRect]

    static func current() -> ScreenSnapshot {
        let s = NSScreen.screens
        return ScreenSnapshot(screens: s, rects: s.map { ScreenRect(frame: $0.axFrame, visible: $0.axVisibleFrame) })
    }

    /// The screen with the largest overlap with `r` (nearest centre if none).
    func index(containing r: CGRect) -> Int {
        var best = (0, CGFloat(-1))
        for (i, s) in rects.enumerated() {
            let inter = s.frame.intersection(r)
            let area = inter.isNull ? 0 : inter.width * inter.height
            if area > best.1 { best = (i, area) }
        }
        if best.1 > 0 { return best.0 }
        return index(at: CGPoint(x: r.midX, y: r.midY))
    }

    func index(at p: CGPoint) -> Int {
        if let i = rects.firstIndex(where: { $0.frame.contains(p) }) { return i }
        let dist = rects.map { hypot($0.frame.midX - p.x, $0.frame.midY - p.y) }
        return dist.indices.min { dist[$0] < dist[$1] } ?? 0
    }
}

/// Executes window commands on AX windows and keeps the per-window history
/// that powers Restore, repeated-execution cycling and unsnap-restore.
final class WindowEngine {
    var settings = WindowsSettings() { didSet { options = settings.geometry } }
    private(set) var options = GeometryOptions()

    /// The frame a window had before Bento started moving it.
    private var restoreRects: [CGWindowID: CGRect] = [:]
    /// What Bento last did to a window (cleared when the window moves otherwise).
    private var lastActions: [CGWindowID: LastAction] = [:]

    enum Source { case keyboard, snap, launch }

    // MARK: Single window

    @discardableResult
    func perform(_ cmd: WindowCommand, on given: AXWindow? = nil, screenIndex: Int? = nil, source: Source = .keyboard) -> Bool {
        guard Permissions.accessibility else {
            Permissions.requestAccessibility()
            return false
        }
        if cmd.isMultiWindow { return performMulti(cmd) }
        // Bento's own windows: only regular ones (not popups or panels), resolved in-process.
        let own = given == nil && NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid()
        guard let window = given ?? (own ? OwnWindows.focused() : AXWindow.focused()), let frame = window.frame, frame.width > 0, frame.height > 0,
              !window.isFullscreen else {
            NSSound.beep()
            return false
        }
        let wid = window.windowID ?? 0
        var last = lastActions[wid]
        let moved = last.map { !Geometry.near($0.rect, frame) } ?? true
        if moved {
            last = nil
            lastActions[wid] = nil
        }

        if cmd == .restore {
            guard let r = restoreRects[wid] else { NSSound.beep(); return false }
            window.setFrame(r)
            lastActions[wid] = nil
            hud(cmd)
            didPlace(window)
            return true
        }
        // Drag-to-snap records the frame from before the drag itself.
        if source != .snap, restoreRects[wid] == nil || moved {
            restoreRects[wid] = frame
        }

        let snap = ScreenSnapshot.current()
        guard !snap.rects.isEmpty else { return false }
        let current = snap.index(containing: frame)
        let input = GeometryInput(command: cmd, window: frame, screens: snap.rects,
                                  screenIndex: screenIndex ?? current, last: last, options: options)
        guard let result = Geometry.calculate(input) else {
            NSSound.beep()
            return false
        }
        let actual = apply(result.rect, to: window, from: frame, visible: snap.rects[result.screenIndex].visible,
                           crossDisplay: result.screenIndex != current)
        if wid != 0 {
            lastActions[wid] = LastAction(command: result.command, rect: actual, count: result.count)
        }
        prune()
        if source == .keyboard { hud(cmd) }
        didPlace(window)
        return true
    }

    /// Tells other modules (Tiling) that the user explicitly placed a window.
    func didPlace(_ w: AXWindow) {
        if WindowEngine.logEvents {
            // BENTO_LOG_EVENTS=1: one line per placement on stderr (end-to-end tests count them).
            let f = w.frame.map { r in [r.minX, r.minY, r.width, r.height].map { "\(WindowsSettings.points(Double($0)))" }.joined(separator: " ") } ?? "?"
            FileHandle.standardError.write("windowPlaced \(w.title) \(f)\n".data(using: .utf8) ?? Data())
        }
        NotificationCenter.default.post(name: BentoEvents.windowPlaced, object: nil, userInfo: ["window": w])
    }

    static let logEvents = ProcessInfo.processInfo.environment["BENTO_LOG_EVENTS"] != nil

    /// Sets a frame and, when the app keeps a different size (minimum size,
    /// character grid, fixed-size window), aligns it to the edges the target
    /// touched. Returns the frame the window ended up with.
    @discardableResult
    func apply(_ target: CGRect, to w: AXWindow, from current: CGRect, visible v: CGRect, crossDisplay: Bool) -> CGRect {
        if Geometry.near(target, current, tolerance: 0.5) { return current }
        w.setFrame(target)
        guard var actual = w.frame else { return target }
        if crossDisplay, !sizeMatches(actual, target) {
            // The source display can clamp the size during the move; try once more.
            w.setFrame(target)
            actual = w.frame ?? actual
        }
        guard !sizeMatches(actual, target) else { return actual }

        let tol = options.screenMargin + 1
        var p = actual.origin
        if abs(actual.width - target.width) > 1 {
            let atMin = abs(target.minX - v.minX) <= tol, atMax = abs(target.maxX - v.maxX) <= tol
            if atMax && !atMin { p.x = target.maxX - actual.width } else if !atMin && !atMax { p.x = (target.midX - actual.width / 2).rounded() } else { p.x = target.minX }
        }
        if abs(actual.height - target.height) > 1 {
            let atMin = abs(target.minY - v.minY) <= tol, atMax = abs(target.maxY - v.maxY) <= tol
            if atMax && !atMin { p.y = target.maxY - actual.height } else if !atMin && !atMax { p.y = (target.midY - actual.height / 2).rounded() } else { p.y = target.minY }
        }
        // Keep it on screen where possible.
        if actual.width <= v.width { p.x = min(max(p.x, v.minX), v.maxX - actual.width) }
        if actual.height <= v.height { p.y = min(max(p.y, v.minY), v.maxY - actual.height) }
        if abs(p.x - actual.minX) > 0.5 || abs(p.y - actual.minY) > 0.5 {
            w.setPosition(p)
            actual = w.frame ?? CGRect(origin: p, size: actual.size)
        }
        return actual
    }

    private func sizeMatches(_ a: CGRect, _ b: CGRect) -> Bool {
        abs(a.width - b.width) <= 1 && abs(a.height - b.height) <= 1
    }

    private func hud(_ cmd: WindowCommand) {
        if settings.showHUD { HUD.show(cmd.title, symbol: cmd.symbol) }
    }

    private func prune() {
        if lastActions.count > 300 { lastActions.removeAll() }
        if restoreRects.count > 300 {
            let keep = Set(lastActions.keys)
            restoreRects = restoreRects.filter { keep.contains($0.key) }
        }
    }

    // MARK: Snapping support

    /// The frame a snap target would give the window (for the preview).
    func previewRect(_ cmd: WindowCommand, screen: ScreenRect, window: CGRect) -> CGRect {
        Geometry.rect(for: cmd, count: 0, in: screen.visible, window: window, options: options)
    }

    /// A window started being dragged. If Bento had placed it, returns the size
    /// it had before (to restore while dragging it out of its slot).
    func beginDrag(wid: CGWindowID, initialFrame: CGRect) -> CGSize? {
        guard wid != 0 else { return nil }
        if let last = lastActions[wid], Geometry.near(last.rect, initialFrame), let r = restoreRects[wid] {
            lastActions[wid] = nil
            guard settings.restoreSizeOnUnsnap,
                  abs(r.width - initialFrame.width) > 1 || abs(r.height - initialFrame.height) > 1 else { return nil }
            return r.size
        }
        restoreRects[wid] = initialFrame
        return nil
    }

    // MARK: Several windows

    private func performMulti(_ cmd: WindowCommand) -> Bool {
        let ownFront = NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid()
        let focused = ownFront ? OwnWindows.focused() : AXWindow.focused()
        let snap = ScreenSnapshot.current()
        guard !snap.rects.isEmpty else { return false }
        let idx = focused?.frame.map { snap.index(containing: $0) } ?? snap.index(at: NSScreen.mouseAX)
        let z = WindowList.zOrder()
        var windows: [AXWindow]
        if cmd == .tileActiveApp || cmd == .cascadeActiveApp {
            guard let f = focused else { NSSound.beep(); return false }
            windows = f.pid == getpid() ? OwnWindows.all() : AXWindow.windows(of: f.pid).filter { $0.isStandard && !$0.isMinimized }
        } else {
            windows = AXWindow.allStandardWindows() + OwnWindows.all()
        }
        var items: [(AXWindow, CGRect, Int)] = []
        for w in windows {
            guard let id = w.windowID, let order = z[id], let fr = w.frame, !w.isFullscreen,
                  snap.index(containing: fr) == idx else { continue }
            items.append((w, fr, order))
        }
        guard !items.isEmpty else { NSSound.beep(); return false }
        let v = snap.rects[idx].visible
        switch cmd {
        case .tileAll, .tileActiveApp:
            items.sort { $0.2 < $1.2 } // front-most first
            let rects = Geometry.tileRects(count: items.count, in: v, options: options)
            for (item, r) in zip(items, rects) { place(item.0, from: item.1, to: r, visible: v) }
        default:
            // App windows share the front window's size (Rectangle); all windows keep theirs.
            let front = items.min { $0.2 < $1.2 }!.1.size
            items.sort { $0.2 > $1.2 } // back-most first, so the front window lands on top
            let sizes = items.map { cmd == .cascadeActiveApp ? front : $0.1.size }
            let rects = Geometry.cascadeRects(sizes: sizes, in: v, options: options)
            for (item, r) in zip(items, rects) { place(item.0, from: item.1, to: r, visible: v) }
        }
        hud(cmd)
        return true
    }

    /// Moves a window that isn't necessarily focused, keeping Restore working.
    func place(_ w: AXWindow, from current: CGRect, to r: CGRect, visible v: CGRect) {
        if let id = w.windowID {
            if restoreRects[id] == nil || lastActions[id].map({ !Geometry.near($0.rect, current) }) ?? true {
                restoreRects[id] = current
            }
            lastActions[id] = nil
        }
        apply(r, to: w, from: current, visible: v, crossDisplay: false)
        didPlace(w)
    }
}

/// CGWindowList helpers (cheap, no AX round trips).
enum WindowList {
    /// On-screen normal windows → front-to-back index.
    static func zOrder() -> [CGWindowID: Int] {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [:] }
        var out: [CGWindowID: Int] = [:]
        var i = 0
        for info in list {
            guard (info[kCGWindowLayer as String] as? Int) == 0, let n = info[kCGWindowNumber as String] as? Int else { continue }
            out[CGWindowID(truncatingIfNeeded: n)] = i
            i += 1
        }
        return out
    }

    struct Info {
        var id: CGWindowID
        var pid: pid_t
        var frame: CGRect
        var layer: Int
    }

    /// The front-most visible app window or panel containing a point. Layers
    /// from the Dock's up are skipped: the Dock keeps a transparent,
    /// click-through window over the whole screen there.
    static func topmost(at p: CGPoint) -> Info? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return nil }
        let dock = Int(CGWindowLevelForKey(.dockWindow))
        for d in list {
            let layer = d[kCGWindowLayer as String] as? Int ?? 0
            guard layer >= 0, layer < dock, (d[kCGWindowAlpha as String] as? Double ?? 1) > 0,
                  let b = d[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: b), rect.contains(p),
                  let n = d[kCGWindowNumber as String] as? Int else { continue }
            return Info(id: CGWindowID(truncatingIfNeeded: n), pid: pid_t(truncatingIfNeeded: d[kCGWindowOwnerPID as String] as? Int ?? 0),
                        frame: rect, layer: layer)
        }
        return nil
    }

    /// One window's bounds (CG bounds use the same top-left origin as AX).
    static func info(_ id: CGWindowID) -> Info? {
        guard id != 0, let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]],
              let d = list.first,
              let b = d[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: b) else { return nil }
        return Info(id: id, pid: pid_t(truncatingIfNeeded: d[kCGWindowOwnerPID as String] as? Int ?? 0), frame: rect,
                    layer: d[kCGWindowLayer as String] as? Int ?? 0)
    }
}
