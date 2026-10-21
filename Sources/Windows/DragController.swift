import AppKit
import QuartzCore
import BentoCore

/// Modifier-drag anywhere in a window: move (default ⌘⌥) or resize from the
/// nearest corner / edge (default ⌘⌥⇧), like Rectangle Pro / easy-move-resize.
///
/// An active CGEventTap on left-mouse down/drag/up only, running on its own
/// thread so a busy main thread never delays clicks. The tap exists only while
/// the feature is enabled. A modifier press on a window is held back until the
/// pointer travels a few points: then it is a drag and the app never sees the
/// click; released before that, the click is re-posted unchanged so modifier
/// clicks (⌘⌥-click, double-clicks) keep working in apps. AX writes happen on
/// the main thread, coalesced to the display refresh by a CADisplayLink that
/// runs only during a drag.
final class DragController: NSObject {
    struct Config: Equatable {
        var move: CGEventFlags = []
        var resize: CGEventFlags = []
        var focus = true
        var snap = true
    }

    private final class Session {
        let window: AXWindow
        var wid: CGWindowID = 0 // main thread (an AX round trip: not in the tap)
        let handle: Geometry.ResizeHandle? // nil = move
        let startMouse: CGPoint
        // Tap thread only.
        let pressEvent: CGEvent?
        // Guarded by `lock`.
        var gesture: DragGesture
        var lastEvent = CFAbsoluteTimeGetCurrent()
        // Main thread only.
        var startFrame: CGRect
        var begun = false
        var applied: CGPoint?
        var finished = false

        init(window: AXWindow, frame: CGRect, handle: Geometry.ResizeHandle?, mouse: CGPoint, press: CGEvent?) {
            self.window = window
            self.handle = handle
            self.startMouse = mouse
            self.startFrame = frame
            self.pressEvent = press
            self.gesture = DragGesture(start: mouse)
        }
    }

    /// Marks clicks Bento re-posts so the tap lets them through.
    static let replayMarker: Int64 = 0x42_656E_746F // "Bento"

    private let engine: WindowEngine
    private let snapper: SnapController
    private let lock = NSLock()
    private var tapConfig = Config()      // tap thread copy (lock)
    private(set) var config = Config()    // main thread copy
    private var session: Session?         // lock
    private var tap: CFMachPort?          // lock
    private var tapRunLoop: CFRunLoop?    // lock
    private var stopRequested = false     // lock
    private var running = false
    private var displayLink: CADisplayLink?
    private var enhancedUIApp: AXUIElement?

    init(engine: WindowEngine, snapper: SnapController) {
        self.engine = engine
        self.snapper = snapper
    }

    var isRunning: Bool { running }

    /// True while a modifier press or drag is in progress.
    var isDragging: Bool { locked { session.map { !$0.gesture.ended } ?? false } }

    func update(_ c: Config) {
        config = c
        locked { tapConfig = c }
    }

    // MARK: Tap lifecycle

    func start() {
        guard !running else { return }
        running = true
        locked { stopRequested = false }
        let thread = Thread { [self] in runTap() }
        thread.name = "Bento window drag tap"
        thread.qualityOfService = .userInteractive
        thread.start()
    }

    func stop() {
        guard running else { return }
        running = false
        let (rl, s): (CFRunLoop?, Session?) = locked {
            stopRequested = true
            // Disabled under the lock: the tap thread enables it under the
            // same lock, so a stop racing a start can't leave it enabled.
            if let t = tap { CGEvent.tapEnable(tap: t, enable: false) }
            let out = (tapRunLoop, session)
            tap = nil
            tapRunLoop = nil
            session?.gesture.ended = true
            return out
        }
        if let rl {
            // A queued block runs even if the thread hasn't entered the run loop yet.
            CFRunLoopPerformBlock(rl, CFRunLoopMode.commonModes.rawValue) { CFRunLoopStop(CFRunLoopGetCurrent()) }
            CFRunLoopWakeUp(rl)
        }
        if let s { finish(s) }
    }

    private func runTap() {
        let types: [CGEventType] = [.leftMouseDown, .leftMouseUp, .leftMouseDragged]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        let refcon = Unmanaged.passRetained(self).toOpaque()
        defer { Unmanaged<DragController>.fromOpaque(refcon).release() }
        guard let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
                                           eventsOfInterest: mask, callback: dragTapCallback, userInfo: refcon) else {
            BentoLog.make("windows").error("Could not create the modifier-drag event tap (Accessibility permission?)")
            DispatchQueue.main.async { self.running = false }
            return
        }
        let source = CFMachPortCreateRunLoopSource(nil, port, 0)
        let rl = CFRunLoopGetCurrent()
        CFRunLoopAddSource(rl, source, .commonModes)
        let proceed: Bool = locked {
            if stopRequested { return false }
            tap = port
            tapRunLoop = rl
            CGEvent.tapEnable(tap: port, enable: true)
            return true
        }
        if proceed { CFRunLoopRun() }
        CGEvent.tapEnable(tap: port, enable: false)
        CFRunLoopRemoveSource(rl, source, .commonModes)
        CFMachPortInvalidate(port)
    }

    // MARK: Tap thread

    fileprivate func handle(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        let pass = Unmanaged.passUnretained(event)
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            if let t = locked({ tap }) { CGEvent.tapEnable(tap: t, enable: true) }
            // Events may have been lost while disabled, the mouse-up among them.
            if !CGEventSource.buttonState(.combinedSessionState, button: .left) { endStale() }
            return pass
        case .leftMouseDown, .leftMouseDragged, .leftMouseUp:
            break
        default:
            return pass
        }
        if event.getIntegerValueField(.eventSourceUserData) == DragController.replayMarker { return pass }
        let p = event.location

        switch type {
        case .leftMouseDown:
            // A new press means the previous one ended, whether or not we saw
            // its mouse-up: never keep swallowing the user's clicks for it.
            endStale()
            let flags = event.flags.intersection([.maskCommand, .maskAlternate, .maskControl, .maskShift])
            let cfg = locked { tapConfig }
            let resize = !cfg.resize.isEmpty && flags == cfg.resize
            let move = !resize && !cfg.move.isEmpty && flags == cfg.move
            guard resize || move else { return pass }
            let cgID = CGWindowID(truncatingIfNeeded: event.getIntegerValueField(.mouseEventWindowUnderMousePointer))
            guard DragController.isDraggableLayer(windowID: cgID) else { DragController.trace("pass: layer of \(cgID)"); return pass }
            let t0 = CFAbsoluteTimeGetCurrent()
            guard let w = DragController.window(at: p) else { DragController.trace("pass: no AX window at \(p)"); return pass }
            guard let f = w.frame, f.width > 0, f.height > 0, !w.isFullscreen else { DragController.trace("pass: no frame / full screen"); return pass }
            let s = Session(window: w, frame: f, handle: resize ? Geometry.resizeHandle(at: p, in: f) : nil, mouse: p,
                            press: event.copy())
            locked { session = s }
            DragController.trace("press \(resize ? "resize" : "move") at \(p) frame \(f) lookup \(Int((CFAbsoluteTimeGetCurrent() - t0) * 1000)) ms")
            return nil

        case .leftMouseDragged:
            let (s, started): (Session?, Bool) = locked {
                guard let s = session, !s.gesture.ended else { return (nil, false) }
                s.lastEvent = CFAbsoluteTimeGetCurrent()
                return (s, s.gesture.drag(to: p))
            }
            guard let s else { return pass }
            if started { DispatchQueue.main.async { self.begin(s) } }
            return nil

        default: // .leftMouseUp
            let (s, release): (Session?, DragGesture.Release?) = locked {
                guard let s = session, !s.gesture.ended else { return (nil, nil) }
                let r = s.gesture.release(at: p)
                if r == .replayClick { session = nil }
                return (s, r)
            }
            guard let s, let release else { return pass }
            DragController.trace("release at \(p): \(release == .finishDrag ? "drag" : "click, re-posted")")
            switch release {
            case .finishDrag:
                // A press released far away without drag events still moves.
                DispatchQueue.main.async {
                    if !s.begun { self.begin(s) }
                    self.finish(s)
                }
            case .replayClick:
                // Not a drag after all: hand the app its click, unchanged.
                if let down = s.pressEvent, let up = event.copy() {
                    down.setIntegerValueField(.eventSourceUserData, value: DragController.replayMarker)
                    up.setIntegerValueField(.eventSourceUserData, value: DragController.replayMarker)
                    down.tapPostEvent(proxy)
                    up.tapPostEvent(proxy)
                }
            }
            return nil
        }
    }

    /// Ends the current gesture if its mouse-up never arrived.
    private func endStale() {
        let stale: Session? = locked {
            guard let s = session, !s.gesture.ended else { return nil }
            s.gesture.ended = true
            if !s.gesture.moving { session = nil; return nil } // a press that never became a drag: drop it
            return s
        }
        if let stale { DispatchQueue.main.async { self.finish(stale) } }
    }

    /// Normal app windows and panels only: not the desktop, Dock, menu bar,
    /// notifications or overlays (CG layers below 0 or from the Dock's up).
    static func isDraggableLayer(windowID: CGWindowID) -> Bool {
        guard windowID != 0 else { return true } // unknown: decide by AX
        guard let info = WindowList.info(windowID) else { return true }
        return info.layer >= 0 && info.layer < Int(CGWindowLevelForKey(.dockWindow)) && info.pid != getpid()
    }

    private static let systemWide: AXUIElement = {
        let e = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(e, 0.4)
        return e
    }()

    /// Window under a point, other apps only (AX to ourselves from this thread
    /// would wait on our own main thread). Runs inside the tap callback: a hung
    /// app fails the hit test within its timeout; a busy one gets a little
    /// longer per element (it is still answering), and the common case is one
    /// round trip after the hit test (the element's AXWindow).
    static func window(at p: CGPoint) -> AXWindow? {
        var el: AXUIElement?
        guard AXUIElementCopyElementAtPosition(systemWide, Float(p.x), Float(p.y), &el) == .success, var cur = el else { return nil }
        var pid: pid_t = 0
        AXUIElementGetPid(cur, &pid)
        guard pid != getpid(), pid > 0 else { return nil }
        func found(_ w: AXUIElement) -> AXWindow {
            AXUIElementSetMessagingTimeout(w, 0.6) // the drag's frame writes
            return AXWindow(element: w, pid: pid)
        }
        for _ in 0..<32 {
            AXUIElementSetMessagingTimeout(cur, 0.4)
            if let w: AXUIElement = cur.ax(kAXWindowAttribute) { return found(w) }
            if let role: String = cur.ax(kAXRoleAttribute), role == kAXWindowRole as String { return found(cur) }
            guard let parent: AXUIElement = cur.ax(kAXParentAttribute) else { break }
            cur = parent
        }
        return nil
    }

    /// BENTO_LOG_EVENTS=1: why a modifier press was or wasn't taken (end-to-end diagnostics).
    private static func trace(_ s: @autoclosure () -> String) {
        guard WindowEngine.logEvents else { return }
        FileHandle.standardError.write("drag \(s())\n".data(using: .utf8) ?? Data())
    }

    // MARK: Main thread

    private func isCurrent(_ s: Session) -> Bool { locked { session === s } }

    /// The pointer moved far enough: this press is a drag.
    private func begin(_ s: Session) {
        guard !s.begun, !s.finished else { return }
        s.begun = true
        guard isCurrent(s) else { return }
        let appEl = AXWindow.appElement(s.window.pid)
        s.window.raise()
        if config.focus {
            // AXFrontmost works for background callers where activate() may be refused.
            AXUIElementSetAttributeValue(s.window.element, kAXMainAttribute as CFString, kCFBooleanTrue)
            AXUIElementSetAttributeValue(appEl, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        }
        if (appEl.ax("AXEnhancedUserInterface") as Bool?) == true {
            // Apps with this on animate every frame change; off for the drag.
            AXUIElementSetAttributeValue(appEl, "AXEnhancedUserInterface" as CFString, kCFBooleanFalse)
            enhancedUIApp = appEl
        }
        s.wid = s.window.windowID ?? 0
        let restoreSize = engine.beginDrag(wid: s.wid, initialFrame: s.startFrame)
        if s.handle == nil {
            if let size = restoreSize {
                let r = Geometry.unsnapped(s.startFrame, restoreSize: size, grab: s.startMouse, keepVertical: false)
                s.window.setSize(r.size)
                s.window.setPosition(r.origin)
                s.startFrame = s.window.frame ?? r
            }
            if config.snap { snapper.beginExternalMove(window: s.window, initialFrame: s.startFrame) }
        }
        startDisplayLink()
    }

    private func startDisplayLink() {
        guard displayLink == nil, let screen = NSScreen.main ?? NSScreen.screens.first else { return }
        let link = screen.displayLink(target: self, selector: #selector(tick))
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    private func stopDisplayLink() {
        displayLink?.invalidate()
        displayLink = nil
    }

    @objc private func tick() {
        let (s, p, idle): (Session?, CGPoint, Double) = locked {
            (session, session?.gesture.latest ?? .zero, CFAbsoluteTimeGetCurrent() - (session?.lastEvent ?? 0))
        }
        guard let s, s.begun, !s.finished else { stopDisplayLink(); return }
        if idle > 0.5, !CGEventSource.buttonState(.combinedSessionState, button: .left) {
            // The mouse-up never reached the tap (e.g. it was briefly disabled).
            locked { s.gesture.ended = true }
            finish(s)
            return
        }
        apply(s, p)
    }

    private func apply(_ s: Session, _ p: CGPoint) {
        guard s.applied != p else { return }
        s.applied = p
        let d = CGPoint(x: p.x - s.startMouse.x, y: p.y - s.startMouse.y)
        if let h = s.handle {
            let r = Geometry.resized(s.startFrame, handle: h, delta: d)
            s.window.setSize(r.size)
            if h.x < 0 || h.y < 0 {
                // Keep the opposite edge fixed even if the app clamps the size.
                let size = s.window.size ?? r.size
                s.window.setPosition(CGPoint(x: h.x < 0 ? s.startFrame.maxX - size.width : s.startFrame.minX,
                                             y: h.y < 0 ? s.startFrame.maxY - size.height : s.startFrame.minY))
            }
        } else {
            s.window.setPosition(CGPoint(x: (s.startFrame.minX + d.x).rounded(), y: (s.startFrame.minY + d.y).rounded()))
            if config.snap { snapper.update(cursor: p) }
        }
    }

    private func finish(_ s: Session) {
        guard !s.finished else { return }
        s.finished = true
        defer { locked { if session === s { session = nil } } }
        guard s.begun else { return } // never became a drag (or superseded before it did)
        apply(s, locked { s.gesture.latest })
        if !isDragging { stopDisplayLink() }
        if let app = enhancedUIApp {
            AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
            enhancedUIApp = nil
        }
        let snapped = s.handle == nil && config.snap && snapper.endExternalMove(commit: true)
        if !snapped, let a = s.applied, a != s.startMouse { engine.didPlace(s.window) }
    }

    @discardableResult
    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}

/// One modifier press, from mouse-down to mouse-up (pure; tested).
struct DragGesture: Equatable {
    /// Pointer travel that turns a press into a drag.
    static let threshold: CGFloat = 3

    let start: CGPoint
    var latest: CGPoint
    /// Crossed the threshold: the window follows the pointer.
    private(set) var moving = false
    var ended = false

    init(start: CGPoint) {
        self.start = start
        latest = start
    }

    private func far(_ p: CGPoint) -> Bool { hypot(p.x - start.x, p.y - start.y) >= DragGesture.threshold }

    /// Records a drag event; true when this one turns the press into a drag.
    mutating func drag(to p: CGPoint) -> Bool {
        latest = p
        guard !moving, far(p) else { return false }
        moving = true
        return true
    }

    enum Release: Equatable { case finishDrag, replayClick }

    /// The press ended: a drag finishes, a press that never moved is a click.
    mutating func release(at p: CGPoint) -> Release {
        ended = true
        latest = p
        if !moving && far(p) { moving = true } // released far away without drag events
        return moving ? .finishDrag : .replayClick
    }
}

private func dragTapCallback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    guard let refcon else { return Unmanaged.passUnretained(event) }
    return Unmanaged<DragController>.fromOpaque(refcon).takeUnretainedValue().handle(proxy: proxy, type: type, event: event)
}
