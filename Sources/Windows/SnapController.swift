import AppKit
import BentoCore

/// Drag-to-snap: watches left-mouse drags (passive global monitor, only while
/// snapping is on). When a window moves with the cursor (a title-bar drag) and
/// the cursor reaches a snap area, a preview appears; releasing snaps.
///
/// Per click the cost is one CGWindowList lookup; drags that don't move a
/// window stop being examined after a few points of cursor travel.
final class SnapController {
    private let engine: WindowEngine
    private var monitor: Any?
    private let footprint = FootprintWindow()
    var options = Geometry.SnapOptions()
    /// True while Bento's own modifier-drag owns the mouse.
    var isSuspended: () -> Bool = { false }

    // Per-drag state
    private var windowID: CGWindowID = 0
    private var pid: pid_t = 0
    private var initialFrame: CGRect = .null
    private var downPoint: CGPoint = .zero
    private var dragEvents = 0
    private var moving = false
    private var axWindow: AXWindow?
    private var screens: ScreenSnapshot?
    private var area: Geometry.SnapArea?

    init(engine: WindowEngine) {
        self.engine = engine
    }

    var isRunning: Bool { monitor != nil }

    func start() {
        guard monitor == nil else { return }
        monitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp]) { [weak self] e in
            self?.handle(e)
        }
    }

    func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        reset()
        footprint.close()
    }

    private func reset() {
        windowID = 0
        moving = false
        axWindow = nil
        screens = nil
        area = nil
        footprint.hide()
    }

    private func handle(_ e: NSEvent) {
        guard let cg = e.cgEvent else { return }
        let p = cg.location // global display coordinates == AX coordinates
        switch e.type {
        case .leftMouseDown:
            reset()
            guard !isSuspended() else { return }
            var id = CGWindowID(truncatingIfNeeded: cg.getIntegerValueField(.mouseEventWindowUnderMousePointer))
            if id == 0 { id = CGWindowID(truncatingIfNeeded: cg.getIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent)) }
            guard let info = WindowList.info(id), info.layer == 0, info.pid != getpid() else { return }
            windowID = id
            pid = info.pid
            initialFrame = info.frame
            downPoint = p
            dragEvents = 0
        case .leftMouseDragged:
            guard windowID != 0, !isSuspended() else { return }
            if !moving {
                guard let now = WindowList.info(windowID)?.frame else { windowID = 0; return }
                if now.size != initialFrame.size {
                    windowID = 0 // a resize, not a move
                    return
                }
                if now.origin == initialFrame.origin {
                    // A window drag moves the window right away (the window server
                    // may lag an event or two); give up on drags that don't.
                    dragEvents += 1
                    if dragEvents > 4, hypot(p.x - downPoint.x, p.y - downPoint.y) > 40 { windowID = 0 }
                    return
                }
                beginMove(current: now, cursor: p)
            }
            update(cursor: p)
        case .leftMouseUp:
            guard windowID != 0 else { return }
            if !moving, !isSuspended(), let now = WindowList.info(windowID)?.frame,
               now.size == initialFrame.size, now.origin != initialFrame.origin {
                // A quick throw: the window moved but no drag event saw it yet.
                beginMove(current: now, cursor: p)
            }
            if moving, !isSuspended() {
                update(cursor: p)
                commit()
            }
            reset()
        default:
            break
        }
    }

    private func beginMove(current: CGRect, cursor: CGPoint) {
        moving = true
        screens = ScreenSnapshot.current()
        axWindow = SnapController.axWindow(id: windowID, pid: pid, near: cursor)
        guard let w = axWindow else { return }
        if let size = engine.beginDrag(wid: windowID, initialFrame: initialFrame) {
            // Dragged out of a snapped slot: back to the old size. The system is
            // moving the window, so (like Rectangle) leave its position alone and
            // only shift it as far as the grab point needs to stay on it; a
            // position computed from the lagging window list would make the
            // window jump away from the cursor.
            let grabX = downPoint.x + current.minX - initialFrame.minX
            let shift = Geometry.titleBarUnsnapShift(current: current, size: size, grabX: grabX)
            if shift > 0, let p = w.position { w.setPosition(CGPoint(x: p.x + shift, y: p.y)) }
            w.setSize(size)
        }
    }

    // MARK: Shared with modifier-drag

    /// Updates the preview for a cursor position during a window move.
    func update(cursor p: CGPoint) {
        let snap = screens ?? ScreenSnapshot.current()
        screens = snap
        let next = Geometry.snapArea(at: p, screens: snap.rects, prior: area?.command, options: options)
        guard next != area else { return }
        area = next
        if let next, let frame = axWindow?.frame ?? (initialFrame.isNull ? nil : initialFrame) {
            footprint.show(engine.previewRect(next.command, screen: snap.rects[next.screenIndex], window: frame))
        } else {
            footprint.hide()
        }
    }

    /// Snaps the window if the cursor is in a snap area. Returns true if it will.
    /// `placedByBento`: Bento moved the window itself (modifier drag), so it
    /// counts as placed even if the snap then fails.
    @discardableResult
    private func commit(placedByBento: Bool = false) -> Bool {
        footprint.hide()
        guard let area, let w = axWindow else { return false }
        // Let the app finish its own drag handling before moving the window.
        DispatchQueue.main.async { [engine] in
            if !engine.perform(area.command, on: w, screenIndex: area.screenIndex, source: .snap), placedByBento {
                engine.didPlace(w)
            }
        }
        return true
    }

    /// Modifier-drag entry points: the drag controller moves the window itself
    /// and reports cursor positions here.
    func beginExternalMove(window: AXWindow, initialFrame: CGRect) {
        reset()
        axWindow = window
        self.initialFrame = initialFrame
        moving = true
        screens = ScreenSnapshot.current()
    }

    /// Returns true if the window is being snapped (the engine then reports the placement).
    @discardableResult
    func endExternalMove(commit doCommit: Bool) -> Bool {
        let snapped = doCommit && commit(placedByBento: true)
        reset()
        return snapped
    }

    // MARK: AX lookup

    /// The AX window with a CG window id (hit test first, then the app's list).
    static func axWindow(id: CGWindowID, pid: pid_t, near p: CGPoint) -> AXWindow? {
        if let w = AXWindow.at(p), w.windowID == id { return w }
        return AXWindow.windows(of: pid).first { $0.windowID == id }
    }
}
