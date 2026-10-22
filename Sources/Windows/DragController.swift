import AppKit
import QuartzCore
import BentoCore

/// Modifier-drag anywhere in a window: move (default ⌘⌥) or resize from the
/// nearest corner / edge (default ⌘⌥⇧), like Rectangle Pro / easy-move-resize.
///
/// Two ways in, as in Rectangle Pro:
/// - **Hover** (no click): hold the modifiers and move the pointer; the window
///   under it follows until the modifiers are released.
/// - **Press**: hold the modifiers, press and drag.
/// Either way the mode follows the modifiers live: adding ⇧ mid-gesture
/// switches to resize, releasing it switches back to move (re-anchored at the
/// current pointer and frame).
///
/// An active CGEventTap (mouse buttons, mouse moves, modifier changes) runs on
/// its own thread so a busy main thread never delays input; it exists only
/// while the feature is enabled, and non-matching events cost one flags check.
/// A modifier press on a window is held back until the pointer travels a few
/// points: then it is a drag and the app never sees the click; released before
/// that, the click is re-posted unchanged so modifier clicks (⌘⌥-click,
/// double-clicks) keep working. Hover never swallows pointer moves. AX writes
/// happen on the main thread, coalesced to the display refresh by a
/// CADisplayLink that runs only during a gesture.
///
/// Bento's own windows (sticky notes, settings, …) work too: the tap thread
/// can't use AX on its own process (that waits on the main thread), so they
/// are recognised from the window list and their AX element is looked up on
/// the main thread when the gesture begins (in-process AX is a direct call).
final class DragController: NSObject {
    struct Config: Equatable {
        var move: CGEventFlags = []
        var resize: CGEventFlags = []
        var focus = true
        var snap = true
        /// Move/resize by just holding the modifiers and moving the pointer.
        var hover = true
        /// Resize from the bottom-right corner (Rectangle Pro classic) or from
        /// the live nearest edges.
        var liveResize = false
    }

    enum Mode: Equatable { case move, resize }

    /// The gesture mode for a set of modifiers (exact match; resize wins a tie).
    static func mode(for flags: CGEventFlags, _ cfg: Config) -> Mode? {
        let f = flags.intersection([.maskCommand, .maskAlternate, .maskControl, .maskShift])
        if !cfg.resize.isEmpty && f == cfg.resize { return .resize }
        if !cfg.move.isEmpty && f == cfg.move { return .move }
        return nil
    }

    private final class Session {
        /// Main thread once begun; nil until then for Bento's own windows.
        var window: AXWindow?
        let hover: Bool
        var wid: CGWindowID // main thread (an AX round trip: not in the tap)
        // Tap thread only.
        let pressEvent: CGEvent?
        // Guarded by `lock`.
        var gesture: DragGesture
        var requested: Mode
        var lastEvent = CFAbsoluteTimeGetCurrent()
        // Main thread only: the current segment (re-anchored when the mode changes).
        var mode: Mode
        var handle: Geometry.ResizeHandle? // nil = move
        var startMouse: CGPoint
        var startFrame: CGRect
        var begun = false
        var applied: CGPoint?
        /// Resize model: the frame as we intend it (unrounded) and the pointer at
        /// the last step. Steps are incremental so the moving edges can change.
        var liveFrame: CGRect?
        var lastPointer: CGPoint?
        /// The window moved or resized at some point in the gesture (any segment).
        var changed = false
        var finished = false

        init(window: AXWindow?, wid: CGWindowID = 0, frame: CGRect, mode: Mode, mouse: CGPoint, press: CGEvent?, hover: Bool) {
            self.window = window
            self.wid = wid
            self.hover = hover
            self.mode = mode
            self.requested = mode
            self.handle = mode == .resize ? Geometry.classicHandle : nil
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
    /// Tap thread: where a hover lookup found nothing to drag (window id +
    /// flags), so holding the modifiers over the desktop doesn't hit-test on
    /// every pointer move.
    private var hoverMiss: (CGWindowID, UInt64)?
    /// Bento's own windows a gesture may take (lock): kept by the main thread,
    /// since the tap thread can't ask AppKit or AX about them.
    private var ownDraggable: Set<CGWindowID> = []
    private var windowObservers: [NSObjectProtocol] = []

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
        observeOwnWindows()
        let thread = Thread { [self] in runTap() }
        thread.name = "Bento window drag tap"
        thread.qualityOfService = .userInteractive
        thread.start()
    }

    func stop() {
        guard running else { return }
        running = false
        windowObservers.forEach { NotificationCenter.default.removeObserver($0) }
        windowObservers = []
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

    /// Keeps `ownDraggable` current: windows ordering in or out, entering or
    /// leaving full screen, closing.
    private func observeOwnWindows() {
        let names: [Notification.Name] = [NSWindow.didChangeOcclusionStateNotification, NSWindow.didBecomeKeyNotification,
                                          NSWindow.didEnterFullScreenNotification, NSWindow.didExitFullScreenNotification,
                                          NSWindow.willCloseNotification]
        windowObservers = names.map {
            NotificationCenter.default.addObserver(forName: $0, object: nil, queue: .main) { [weak self] _ in
                DispatchQueue.main.async { self?.refreshOwnWindows() } // after a close has taken effect
            }
        }
        refreshOwnWindows()
    }

    /// Regular Bento windows (Notes, Settings, the editor…): titled, activating,
    /// movable and not full screen. Not popups, HUDs, pins or the clipboard panel.
    private func refreshOwnWindows() {
        let ids = NSApp.windows.filter {
            $0.isVisible && $0.isMovable && !$0.ignoresMouseEvents && $0.styleMask.contains(.titled)
                && !$0.styleMask.contains(.nonactivatingPanel) && !$0.styleMask.contains(.fullScreen)
        }.map { CGWindowID($0.windowNumber) }
        locked { ownDraggable = Set(ids) }
    }

    private func runTap() {
        let types: [CGEventType] = [.leftMouseDown, .leftMouseUp, .leftMouseDragged, .mouseMoved, .flagsChanged]
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
        case .flagsChanged:
            modifiersChanged(event.flags)
            return pass
        case .mouseMoved:
            hoverMoved(event)
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
            // A new press means the previous gesture ended, whether or not we saw
            // its mouse-up (or, for hover, the modifiers' release): never keep
            // swallowing the user's clicks for it.
            endStale()
            let cfg = locked { tapConfig }
            guard let mode = DragController.mode(for: event.flags, cfg) else { return pass }
            let cgID = CGWindowID(truncatingIfNeeded: event.getIntegerValueField(.mouseEventWindowUnderMousePointer))
            let s: Session
            let t0 = CFAbsoluteTimeGetCurrent()
            let info = WindowList.info(cgID)
            if let own = ownWindow(info) {
                s = Session(window: nil, wid: cgID, frame: own.frame, mode: mode, mouse: p, press: event.copy(), hover: false)
            } else {
                guard DragController.isDraggableLayer(cgID, info) else { DragController.trace("pass: layer of \(cgID)"); return pass }
                guard let w = DragController.window(at: p) else { DragController.trace("pass: no AX window at \(p)"); return pass }
                guard let f = w.frame, f.width > 0, f.height > 0, !w.isFullscreen else { DragController.trace("pass: no frame / full screen"); return pass }
                s = Session(window: w, frame: f, mode: mode, mouse: p, press: event.copy(), hover: false)
            }
            let f = s.startFrame
            locked { session = s }
            DragController.trace("press \(mode == .resize ? "resize" : "move") at \(p) frame \(f) lookup \(Int((CFAbsoluteTimeGetCurrent() - t0) * 1000)) ms")
            return nil

        case .leftMouseDragged:
            let cfg = locked { tapConfig }
            let mode = DragController.mode(for: event.flags, cfg)
            let (s, started): (Session?, Bool) = locked {
                guard let s = session, !s.gesture.ended, !s.hover else { return (nil, false) }
                s.lastEvent = CFAbsoluteTimeGetCurrent()
                // Modifiers released while the button is still down: keep the last mode.
                if let mode { s.requested = mode }
                return (s, s.gesture.drag(to: p))
            }
            guard let s else { return pass }
            if started { DispatchQueue.main.async { self.begin(s) } }
            return nil

        default: // .leftMouseUp
            let (s, release): (Session?, DragGesture.Release?) = locked {
                guard let s = session, !s.gesture.ended, !s.hover else { return (nil, nil) }
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

    /// Modifier changes switch a gesture between move and resize, and end a
    /// hover gesture when the modifiers no longer match.
    private func modifiersChanged(_ flags: CGEventFlags) {
        hoverMiss = nil
        let cfg = locked { tapConfig }
        let mode = DragController.mode(for: flags, cfg)
        let ended: Session? = locked {
            guard let s = session, !s.gesture.ended else { return nil }
            if let mode {
                s.requested = mode
                return nil
            }
            guard s.hover else { return nil } // a press keeps going until the button is released
            s.gesture.ended = true
            return s
        }
        if let ended { DispatchQueue.main.async { self.finish(ended) } }
    }

    /// Pointer moves with no button pressed: hover gestures.
    private func hoverMoved(_ event: CGEvent) {
        let cfg = locked { tapConfig }
        guard cfg.hover, let mode = DragController.mode(for: event.flags, cfg) else {
            // Modifiers no longer match (their release may have been missed).
            let ended: Session? = locked {
                guard let s = session, s.hover, !s.gesture.ended else { return nil }
                s.gesture.ended = true
                return s
            }
            if let ended { DispatchQueue.main.async { self.finish(ended) } }
            return
        }
        let p = event.location
        let (current, started): (Session?, Bool) = locked {
            guard let s = session, !s.gesture.ended else { return (nil, false) }
            guard s.hover else { return (s, false) }
            s.lastEvent = CFAbsoluteTimeGetCurrent()
            s.requested = mode
            return (s, s.gesture.drag(to: p))
        }
        if let current {
            if started { DispatchQueue.main.async { self.begin(current) } }
            return
        }
        // Start a hover gesture on the window under the pointer.
        let cgID = CGWindowID(truncatingIfNeeded: event.getIntegerValueField(.mouseEventWindowUnderMousePointer))
        if let miss = hoverMiss, miss.0 == cgID, miss.1 == event.flags.rawValue { return }
        let s: Session
        let info = WindowList.info(cgID)
        if let own = ownWindow(info) {
            s = Session(window: nil, wid: cgID, frame: own.frame, mode: mode, mouse: p, press: nil, hover: true)
        } else {
            guard DragController.isDraggableLayer(cgID, info), let w = DragController.window(at: p),
                  let f = w.frame, f.width > 0, f.height > 0, !w.isFullscreen else {
                hoverMiss = (cgID, event.flags.rawValue)
                return
            }
            s = Session(window: w, frame: f, mode: mode, mouse: p, press: nil, hover: true)
        }
        let f = s.startFrame
        locked { session = s }
        DragController.trace("hover \(mode == .resize ? "resize" : "move") at \(p) frame \(f)")
    }

    /// Ends the current gesture if its mouse-up never arrived.
    private func endStale() {
        let stale: Session? = locked {
            guard let s = session, !s.gesture.ended else { return nil }
            s.gesture.ended = true
            if !s.gesture.moving { session = nil; return nil } // never became a drag: drop it
            return s
        }
        if let stale { DispatchQueue.main.async { self.finish(stale) } }
    }

    /// Normal app windows and panels only: not the desktop, Dock, menu bar,
    /// notifications or overlays (CG layers below 0 or from the Dock's up).
    /// `info`: the window's list entry, nil if unknown.
    static func isDraggableLayer(_ windowID: CGWindowID, _ info: WindowList.Info?) -> Bool {
        guard windowID != 0, let info else { return true } // unknown: decide by AX
        return info.layer >= 0 && info.layer < Int(CGWindowLevelForKey(.dockWindow)) && info.pid != getpid()
    }

    /// One of Bento's regular windows (see `refreshOwnWindows`), from the
    /// window list alone: no AX to ourselves on the tap thread.
    private func ownWindow(_ info: WindowList.Info?) -> WindowList.Info? {
        guard let info, info.pid == getpid(), info.frame.width > 0, info.frame.height > 0,
              locked({ ownDraggable.contains(info.id) }) else { return nil }
        return info
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
        if s.window == nil {
            // One of our own windows: in-process AX, here on the main thread.
            guard let own = NSApp.windows.first(where: { $0.windowNumber == Int(s.wid) }),
                  let w = AXWindow.windows(of: getpid()).first(where: { $0.windowID == s.wid }) else {
                // Gone or not in the AX tree: drop the gesture so later events pass.
                DragController.trace("pass: no AX element for own window \(s.wid)")
                locked { s.gesture.ended = true }
                finish(s)
                return
            }
            s.window = w
            if config.focus {
                NSApp.activate(ignoringOtherApps: true)
                own.makeKeyAndOrderFront(nil)
            } else {
                own.orderFront(nil)
            }
        }
        guard let window = s.window else { return }
        let appEl = AXWindow.appElement(window.pid)
        if window.pid != getpid() {
            window.raise()
            if config.focus {
                // AXFrontmost works for background callers where activate() may be refused.
                AXUIElementSetAttributeValue(window.element, kAXMainAttribute as CFString, kCFBooleanTrue)
                AXUIElementSetAttributeValue(appEl, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
            }
        }
        if (appEl.ax("AXEnhancedUserInterface") as Bool?) == true {
            // Apps with this on animate every frame change; off for the drag.
            AXUIElementSetAttributeValue(appEl, "AXEnhancedUserInterface" as CFString, kCFBooleanFalse)
            enhancedUIApp = appEl
        }
        if s.wid == 0 { s.wid = window.windowID ?? 0 }
        if s.hover, let f = window.frame {
            // A hover gesture may have waited for the pointer to move: start from now.
            s.startFrame = f
        }
        if s.mode == .resize { s.handle = resizeHandle(at: s.startMouse, in: s.startFrame) }
        let restoreSize = s.mode == .move ? engine.beginDrag(wid: s.wid, initialFrame: s.startFrame) : nil
        if s.mode == .move {
            if let size = restoreSize {
                let r = Geometry.unsnapped(s.startFrame, restoreSize: size, grab: s.startMouse, keepVertical: false)
                window.setSize(r.size)
                window.setPosition(r.origin)
                s.startFrame = window.frame ?? r
                s.changed = true
            }
            if config.snap { snapper.beginExternalMove(window: window, initialFrame: s.startFrame) }
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
        let (s, p, idle, requested): (Session?, CGPoint, Double, Mode) = locked {
            (session, session?.gesture.latest ?? .zero, CFAbsoluteTimeGetCurrent() - (session?.lastEvent ?? 0),
             session?.requested ?? .move)
        }
        guard let s, s.begun, !s.finished else { stopDisplayLink(); return }
        let lost = s.hover
            // The modifiers' release never reached the tap.
            ? idle > 0.3 && DragController.mode(for: CGEventSource.flagsState(.combinedSessionState), config) == nil
            // The mouse-up never reached the tap (e.g. it was briefly disabled).
            : idle > 0.5 && !CGEventSource.buttonState(.combinedSessionState, button: .left)
        if lost {
            locked { s.gesture.ended = true }
            finish(s)
            return
        }
        if requested != s.mode { switchMode(s, to: requested, at: p) }
        apply(s, p)
    }

    /// Where a resize segment starts: always bottom-right (classic) or the
    /// pointer's quarter of the window (live nearest edges).
    private func resizeHandle(at p: CGPoint, in f: CGRect) -> Geometry.ResizeHandle {
        config.liveResize ? Geometry.liveHandle(at: p, in: f) : Geometry.classicHandle
    }

    /// ⇧ pressed or released mid-gesture: continue in the other mode from the
    /// current pointer and frame.
    private func switchMode(_ s: Session, to mode: Mode, at p: CGPoint) {
        guard let window = s.window else { return }
        if s.mode == .move && config.snap { _ = snapper.endExternalMove(commit: false) }
        s.startFrame = window.frame ?? s.startFrame
        s.startMouse = p
        s.applied = p
        s.mode = mode
        s.handle = mode == .resize ? resizeHandle(at: p, in: s.startFrame) : nil
        s.liveFrame = nil
        s.lastPointer = nil
        if mode == .move && config.snap { snapper.beginExternalMove(window: window, initialFrame: s.startFrame) }
        DragController.trace("mode \(mode == .resize ? "resize" : "move") at \(p)")
    }

    private func apply(_ s: Session, _ p: CGPoint) {
        guard let window = s.window, s.applied != p else { return }
        s.applied = p
        s.changed = true
        let d = CGPoint(x: p.x - s.startMouse.x, y: p.y - s.startMouse.y)
        if s.mode == .resize {
            // Incremental: each step decides again which edges follow the pointer.
            let q = s.lastPointer ?? s.startMouse
            let model = s.liveFrame ?? s.startFrame
            let (step, sides) = Geometry.liveResizeStep(model, from: q, to: p, sides: s.handle ?? resizeHandle(at: q, in: model),
                                                        live: config.liveResize)
            var next = step
            s.handle = sides
            s.lastPointer = p
            let target = Geometry.integral(next)
            window.setSize(target.size)
            // The app may clamp the size: keep the fixed edges where they are.
            let actual = window.size ?? target.size
            if abs(actual.width - target.width) > 1 {
                if sides.x < 0 { next.origin.x = next.maxX - actual.width }
                next.size.width = actual.width
            }
            if abs(actual.height - target.height) > 1 {
                if sides.y < 0 { next.origin.y = next.maxY - actual.height }
                next.size.height = actual.height
            }
            if next.origin != model.origin || actual != target.size {
                window.setPosition(CGPoint(x: next.minX.rounded(), y: next.minY.rounded()))
            }
            s.liveFrame = next
        } else {
            window.setPosition(CGPoint(x: (s.startFrame.minX + d.x).rounded(), y: (s.startFrame.minY + d.y).rounded()))
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
        let snapped = s.mode == .move && config.snap && snapper.endExternalMove(commit: true)
        if !snapped, s.changed, let window = s.window { engine.didPlace(window) }
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
