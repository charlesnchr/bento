import AppKit
import QuartzCore
import BentoCore

/// Modifier-drag anywhere in a window: move (default ⌘⌥) or resize from the
/// nearest corner / edge (default ⌘⌥⇧), like Rectangle Pro / easy-move-resize.
///
/// An active CGEventTap on left-mouse down/drag/up only, running on its own
/// thread so a busy main thread never delays clicks. The tap exists only while
/// the feature is enabled. Clicks that start a drag are swallowed so the app
/// underneath never sees them. AX writes happen on the main thread, coalesced
/// to the display refresh by a CADisplayLink that runs only during a drag.
final class DragController: NSObject {
    struct Config: Equatable {
        var move: CGEventFlags = []
        var resize: CGEventFlags = []
        var focus = true
        var snap = true
    }

    private final class Session {
        let window: AXWindow
        let wid: CGWindowID
        let handle: Geometry.ResizeHandle? // nil = move
        let startMouse: CGPoint
        var startFrame: CGRect
        // Written by the tap thread, guarded by `lock`.
        var latest: CGPoint
        var lastEvent = CFAbsoluteTimeGetCurrent()
        var ended = false
        // Main thread only.
        var applied: CGPoint?
        var finished = false

        init(window: AXWindow, frame: CGRect, handle: Geometry.ResizeHandle?, mouse: CGPoint) {
            self.window = window
            self.wid = window.windowID ?? 0
            self.handle = handle
            self.startMouse = mouse
            self.startFrame = frame
            self.latest = mouse
        }
    }

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

    /// True while a modifier drag is in progress.
    var isDragging: Bool { locked { session.map { !$0.ended } ?? false } }

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
        let (t, rl): (CFMachPort?, CFRunLoop?) = locked {
            stopRequested = true
            let pair = (tap, tapRunLoop)
            tap = nil
            tapRunLoop = nil
            return pair
        }
        if let t { CGEvent.tapEnable(tap: t, enable: false) }
        if let rl { CFRunLoopStop(rl) }
        if let s = locked({ session }) {
            locked { s.ended = true }
            finish(s)
        }
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
            return true
        }
        if proceed {
            CGEvent.tapEnable(tap: port, enable: true)
            CFRunLoopRun()
        }
        CGEvent.tapEnable(tap: port, enable: false)
        CFRunLoopRemoveSource(rl, source, .commonModes)
        CFMachPortInvalidate(port)
    }

    // MARK: Tap thread

    fileprivate func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        let pass = Unmanaged.passUnretained(event)
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            if let t = locked({ tap }) { CGEvent.tapEnable(tap: t, enable: true) }
            return pass
        case .leftMouseDown:
            let flags = event.flags.intersection([.maskCommand, .maskAlternate, .maskControl, .maskShift])
            let cfg = locked { tapConfig }
            let resize = !cfg.resize.isEmpty && flags == cfg.resize
            let move = !resize && !cfg.move.isEmpty && flags == cfg.move
            guard resize || move else { return pass }
            let p = event.location
            guard let w = DragController.window(at: p), let f = w.frame, !w.isFullscreen else { return pass }
            let s = Session(window: w, frame: f, handle: resize ? Geometry.resizeHandle(at: p, in: f) : nil, mouse: p)
            let stale: Session? = locked {
                // A previous drag whose mouse-up never arrived ends here.
                let old = session.flatMap { $0.ended ? nil : $0 }
                old?.ended = true
                session = s
                return old
            }
            DispatchQueue.main.async {
                if let stale { self.finish(stale) }
                self.begin(s)
            }
            return nil
        case .leftMouseDragged:
            let swallowed: Bool = locked {
                guard let s = session, !s.ended else { return false }
                s.latest = event.location
                s.lastEvent = CFAbsoluteTimeGetCurrent()
                return true
            }
            return swallowed ? nil : pass
        case .leftMouseUp:
            let s: Session? = locked {
                guard let s = session, !s.ended else { return nil }
                s.latest = event.location
                s.ended = true
                return s
            }
            guard let s else { return pass }
            DispatchQueue.main.async { self.finish(s) }
            return nil
        default:
            return pass
        }
    }

    private static let systemWide: AXUIElement = {
        let e = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(e, 0.25)
        return e
    }()

    /// Window under a point, other apps only (AX to ourselves from this thread
    /// would wait on our own main thread).
    static func window(at p: CGPoint) -> AXWindow? {
        var el: AXUIElement?
        guard AXUIElementCopyElementAtPosition(systemWide, Float(p.x), Float(p.y), &el) == .success, var cur = el else { return nil }
        var pid: pid_t = 0
        AXUIElementGetPid(cur, &pid)
        guard pid != getpid(), pid > 0 else { return nil }
        for _ in 0..<32 {
            if let role: String = cur.ax(kAXRoleAttribute), role == kAXWindowRole as String { return AXWindow(element: cur, pid: pid) }
            if let w: AXUIElement = cur.ax(kAXWindowAttribute) { return AXWindow(element: w, pid: pid) }
            guard let parent: AXUIElement = cur.ax(kAXParentAttribute) else { break }
            cur = parent
        }
        return nil
    }

    // MARK: Main thread

    private func isCurrent(_ s: Session) -> Bool { locked { session === s } }

    private func begin(_ s: Session) {
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
            (session, session?.latest ?? .zero, CFAbsoluteTimeGetCurrent() - (session?.lastEvent ?? 0))
        }
        guard let s, !s.finished else { stopDisplayLink(); return }
        if idle > 0.5, !CGEventSource.buttonState(.hidSystemState, button: .left) {
            // The mouse-up never reached the tap (e.g. it was briefly disabled).
            locked { s.ended = true }
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
        apply(s, locked { s.latest })
        if !isDragging { stopDisplayLink() }
        if let app = enhancedUIApp {
            AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
            enhancedUIApp = nil
        }
        let snapped = s.handle == nil && config.snap && snapper.endExternalMove(commit: true)
        if !snapped, let a = s.applied, a != s.startMouse { engine.didPlace(s.window) }
        locked { if session === s { session = nil } }
    }

    @discardableResult
    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}

private func dragTapCallback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    guard let refcon else { return Unmanaged.passUnretained(event) }
    return Unmanaged<DragController>.fromOpaque(refcon).takeUnretainedValue().handle(type: type, event: event)
}
