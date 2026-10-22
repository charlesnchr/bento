import AppKit
import ApplicationServices
import BentoCore

private let log = BentoLog.make("tiling")

/// What AX callbacks point at: kept alive by every `AppObserver`, cleared on
/// `stop()`, so a callback delivered after the manager stopped (or was freed)
/// finds nil instead of a dangling pointer.
final class TilingCallbackTarget {
    weak var manager: TilingManager?
    init(_ manager: TilingManager) { self.manager = manager }
}

private func tilingAXCallback(_ observer: AXObserver, _ element: AXUIElement, _ notification: CFString,
                              _ refcon: UnsafeMutableRawPointer?) {
    guard let refcon else { return }
    Unmanaged<TilingCallbackTarget>.fromOpaque(refcon).takeUnretainedValue().manager?.handle(notification as String, element)
}

/// The running tiling manager. Exists only while tiling is on; `stop()` removes
/// every observer. Thin AX layer around `LayoutState` (the pure engine):
/// it discovers windows, decides which are tiled, feeds them into the per-display
/// trees and applies the computed frames.
final class TilingManager {
    struct TrackedWindow {
        let ax: AXWindow
        let bundleID: String?
        var autoFloat: Bool
        /// Per-window float toggle, remembered while the window lives.
        var userFloat: Bool?
        var floating: Bool { userFloat ?? autoFloat }
        /// Frame before Bento first tiled it (used when it is floated again).
        var originalFrame: CGRect?
        let detected: Date
    }

    private(set) var settings: TilingSettings
    private var displays: [CGDirectDisplayID: LayoutState] = [:]
    /// Visible frame of each display in AX coordinates (before outer gaps).
    private var screenAreas: [CGDirectDisplayID: CGRect] = [:]
    private var windows: [WindowID: TrackedWindow] = [:]
    private var idByElement: [AXWindow: WindowID] = [:]
    private var observers: [pid_t: AppObserver] = [:]
    private var observerFailures: [pid_t: Int] = [:]
    /// Apps observed although not eligible by default (user tiled a window of a floating app).
    private var forcedPIDs: Set<pid_t> = []
    /// Windows the Windows module placed before Tiling tracked them (newest last).
    private var placedUntracked: [WindowID] = []
    /// Tiled windows currently on screen (current Space, not minimized/hidden/fullscreen).
    private(set) var visible: Set<WindowID> = []
    /// Last frame we set (as read back), to tell our own moves from the user's.
    private var expected: [WindowID: CGRect] = [:]
    private var lastSet: [WindowID: Date] = [:]
    /// Last frame sent per window and the frame the app actually took.
    private var lastApplied: [WindowID: (target: CGRect, result: CGRect)] = [:]
    private var corrections: [WindowID: (count: Int, since: Date)] = [:]
    private var mru: [WindowID] = []
    private var tokens: [(NotificationCenter, NSObjectProtocol)] = []
    private var refreshWork: DispatchWorkItem?
    private var refreshDeadline: DispatchTime?
    private var externalWork: DispatchWorkItem?
    private var externallyMoved: Set<WindowID> = []
    private var dragging: Set<WindowID> = []
    /// Frame each dragged window had when the drag started.
    private var dragOrigin: [WindowID: CGRect] = [:]
    private var lastDragMove = Date.distantPast
    private var mouseMonitor: Any?
    private var running = false
    private var generation = 0

    private static let layoutDefaultsKey = "BentoTilingDisplayLayouts"
    /// AX messaging timeout for tracked windows (seconds).
    static let axTimeout: Float = 0.5

    /// Dev/e2e only (`BENTO_DEV` + `BENTO_TILING_TITLE_FILTER`): tile only windows whose
    /// title contains this, so tests never touch other windows of the same app.
    private static let titleFilter: String? = {
        let env = ProcessInfo.processInfo.environment
        guard env["BENTO_DEV"] != nil, let f = env["BENTO_TILING_TITLE_FILTER"], !f.isEmpty else { return nil }
        return f
    }()

    /// Apps whose windows have no (enabled) fullscreen button but should still tile.
    private static let fullscreenButtonExempt: Set<String> = [
        "com.google.Chrome", "com.apple.ActivityMonitor", "org.alacritty", "io.alacritty",
        "net.kovidgoyal.kitty", "com.github.wez.wezterm", "org.qutebrowser.qutebrowser",
        "com.googlecode.iterm2", "org.gnu.Emacs", "com.microsoft.VSCode", "com.valvesoftware.steam",
        "org.gimp.gimp-2.10", "com.mitchellh.ghostty",
    ]

    init(settings: TilingSettings) {
        self.settings = settings
    }

    private var callbackTarget: TilingCallbackTarget?
    private var innerGap: CGFloat { settings.clampedInnerGap }

    // MARK: - Lifecycle

    deinit { stop() }

    func start() {
        guard !running else { return }
        running = true
        callbackTarget = TilingCallbackTarget(self)
        let ws = NSWorkspace.shared.notificationCenter
        func on(_ center: NotificationCenter, _ name: Notification.Name, _ body: @escaping (Notification) -> Void) {
            tokens.append((center, center.addObserver(forName: name, object: nil, queue: .main) { body($0) }))
        }
        on(ws, NSWorkspace.didLaunchApplicationNotification) { [weak self] _ in
            guard let self else { return }
            // AX of a fresh app needs a moment; try again a bit later too.
            self.scheduleRefresh(after: 0.5)
            self.later(1.5) { $0.scheduleRefresh(after: 0) }
        }
        on(ws, NSWorkspace.didTerminateApplicationNotification) { [weak self] note in
            guard let self, let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self.dropApp(app.processIdentifier)
            self.scheduleRefresh(after: 0.05)
        }
        for name in [NSWorkspace.didHideApplicationNotification, NSWorkspace.didUnhideApplicationNotification] {
            on(ws, name) { [weak self] _ in self?.scheduleRefresh(after: 0.1) }
        }
        on(ws, NSWorkspace.activeSpaceDidChangeNotification) { [weak self] _ in
            // The window list can lag the Space switch animation: look again once it is over.
            self?.scheduleRefresh(after: 0.1)
            self?.later(0.8) { $0.scheduleRefresh(after: 0) }
        }
        on(ws, NSWorkspace.didActivateApplicationNotification) { [weak self] note in
            guard let self, let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            if let obs = self.observers[app.processIdentifier],
               let win: AXUIElement = obs.appElement.ax(kAXFocusedWindowAttribute) {
                self.noteFocused(AXWindow(element: win, pid: app.processIdentifier))
            } else if self.isEligible(app) {
                self.scheduleRefresh(after: 0.2) // not observed yet (e.g. AX was not ready at launch)
            }
        }
        on(NotificationCenter.default, NSApplication.didChangeScreenParametersNotification) { [weak self] _ in
            self?.scheduleRefresh(after: 0.3)
        }
        on(NotificationCenter.default, BentoEvents.windowPlaced) { [weak self] note in
            guard let w = note.userInfo?["window"] as? AXWindow else { return }
            self?.floatPlaced(w)
        }
        refresh(initial: true)
    }

    func stop() {
        guard running else { return }
        running = false
        generation += 1
        for (center, token) in tokens { center.removeObserver(token) }
        tokens = []
        callbackTarget?.manager = nil
        callbackTarget = nil
        observers.values.forEach { $0.invalidate() }
        observers = [:]
        refreshWork?.cancel(); refreshWork = nil; refreshDeadline = nil
        externalWork?.cancel(); externalWork = nil
        removeMouseMonitor()
        displays = [:]; screenAreas = [:]; windows = [:]; idByElement = [:]; visible = []
        expected = [:]; lastSet = [:]; lastApplied = [:]; corrections = [:]; mru = []; dragging = []; dragOrigin = [:]
        externallyMoved = []
        forcedPIDs = []; observerFailures = [:]; placedUntracked = []
    }

    /// Applies changed settings without rebuilding the trees when possible.
    func update(settings new: TilingSettings) {
        let old = settings
        settings = new
        guard running else { return }
        if old.floatingApps != new.floatingApps || old.onlyApps != new.onlyApps {
            stop()
            start()
            return
        }
        if old.defaultLayout != new.defaultLayout {
            UserDefaults.standard.removeObject(forKey: TilingManager.layoutDefaultsKey)
            for did in displays.keys { displays[did]?.kind = new.defaultLayout }
        }
        if old.clampedMasterRatio != new.clampedMasterRatio {
            for did in displays.keys { displays[did]?.masterRatio = new.clampedMasterRatio }
        }
        applyLayout()
    }

    /// Runs `body` after `delay` unless the manager was stopped meanwhile.
    private func later(_ delay: TimeInterval, _ body: @escaping (TilingManager) -> Void) {
        let gen = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, self.running, self.generation == gen else { return }
            body(self)
        }
    }

    // MARK: - AX notifications

    fileprivate func handle(_ notification: String, _ element: AXUIElement) {
        guard running else { return }
        var pid: pid_t = 0
        AXUIElementGetPid(element, &pid)
        let w = AXWindow(element: element, pid: pid)
        switch notification {
        case kAXWindowCreatedNotification:
            scheduleRefresh(after: 0.15)
        case kAXUIElementDestroyedNotification:
            if let wid = idByElement[w] {
                forget(wid)
                scheduleRefresh(after: 0.05)
            }
        case kAXWindowMiniaturizedNotification, kAXWindowDeminiaturizedNotification:
            scheduleRefresh(after: 0.05)
        case kAXFocusedWindowChangedNotification:
            if w.role == (kAXWindowRole as String) {
                noteFocused(w)
            } else if let win: AXUIElement = AXWindow.appElement(pid).ax(kAXFocusedWindowAttribute) {
                noteFocused(AXWindow(element: win, pid: pid))
            }
        case kAXWindowMovedNotification, kAXWindowResizedNotification:
            if let wid = idByElement[w] { windowMoved(wid) }
        default:
            break
        }
    }

    private func noteFocused(_ w: AXWindow) {
        guard let wid = idByElement[w] ?? w.windowID else { return }
        if windows[wid] == nil || (windows[wid]?.floating == false && !visible.contains(wid)) {
            scheduleRefresh(after: 0.1) // e.g. switched to another native tab
        }
        mru.removeAll { $0 == wid }
        mru.insert(wid, at: 0)
        if mru.count > 64 { mru.removeLast() }
    }

    // MARK: - Moves and drags

    private func windowMoved(_ wid: WindowID) {
        if dragging.contains(wid) {
            lastDragMove = Date()
            return
        }
        guard let t = windows[wid], !t.floating else { return }
        guard visible.contains(wid) else {
            // Not laid out right now (full screen, another Space…): its state may have changed.
            scheduleRefresh(after: 0.3)
            return
        }
        guard let cur = t.ax.frame else { return }
        if let e = expected[wid], cur.approxEqual(e) { return }
        if TilingManager.leftButtonDown {
            beginDrag(wid)
            return
        }
        if let set = lastSet[wid], Date().timeIntervalSince(set) < 0.5 {
            // The app is still settling after our resize (async apps, size clamping).
            expected[wid] = cur
            lastApplied[wid]?.result = cur
            return
        }
        externallyMoved.insert(wid)
        externalWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.handleExternalMoves() }
        externalWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: work)
    }

    /// A tiled window was moved by something else (another tool, the app itself,
    /// keyboard): follow it to another display, otherwise put it back — but give
    /// up after a few attempts so we never fight an app in a loop.
    private func handleExternalMoves() {
        externalWork = nil
        let ids = externallyMoved
        externallyMoved = []
        var needsApply = false
        for wid in ids {
            guard let t = windows[wid], let cur = t.ax.frame, let did = display(of: wid) else { continue }
            if t.ax.isFullscreen {
                // Entering native fullscreen: never resize it; the Space change refreshes.
                visible.remove(wid)
                needsApply = true
                continue
            }
            expected[wid] = cur
            needsApply = true
            if let target = NSScreen.containing(axRect: cur)?.displayID, target != did, displays[target] != nil {
                displays[did]?.remove(wid)
                insert(wid, into: target, placement: .end)
                continue
            }
            let now = Date()
            var c = corrections[wid] ?? (0, now)
            if now.timeIntervalSince(c.since) > 3 { c = (0, now) }
            c.count += 1
            corrections[wid] = c
            if c.count > 3 { needsApply = false } // accept the app's frame for now
        }
        if needsApply { applyLayout() }
    }

    private func beginDrag(_ wid: WindowID) {
        if !dragging.contains(wid) { log.info("drag started \(wid, privacy: .public)") }
        if dragOrigin[wid] == nil, let e = expected[wid] { dragOrigin[wid] = e }
        let first = dragging.isEmpty
        dragging.insert(wid)
        lastDragMove = Date()
        if mouseMonitor == nil {
            mouseMonitor = NSEvent.addGlobalMonitorForEvents(matching: .leftMouseUp) { [weak self] event in
                // CG event location is already in AX (top-left) coordinates.
                let location = event.cgEvent?.location
                // A moment later, so a snap by the Windows module (dispatched on the
                // same mouse-up) floats the window before we would snap it back.
                self?.later(0.08) { $0.endDrag(at: location) }
            }
        }
        if first { watchDrag() }
    }

    /// The mouse-up can be missed (swallowed by an event tap, or released over
    /// our own window where global monitors are blind): while a drag lasts,
    /// check the button a few times a second.
    private func watchDrag() {
        later(0.25) { m in
            guard !m.dragging.isEmpty else { return }
            if !TilingManager.leftButtonDown {
                m.later(0.1) { $0.endDrag() }
            } else if Date().timeIntervalSince(m.lastDragMove) > 30 {
                // A button that reads as held with nothing moving for this long is a
                // lost mouse-up (synthetic input), not a drag: don't freeze the layout.
                log.info("drag abandoned after 30 s without movement")
                m.endDrag()
            } else {
                m.watchDrag()
            }
        }
    }

    /// Hardware button state. `NSEvent.pressedMouseButtons` follows the session's
    /// event stream, which misses a mouse-down swallowed by an event tap (the
    /// Windows module's modifier-drag), so such drags looked like external moves.
    static var leftButtonDown: Bool { CGEventSource.buttonState(.hidSystemState, button: .left) }

    private func removeMouseMonitor() {
        if let m = mouseMonitor { NSEvent.removeMonitor(m) }
        mouseMonitor = nil
    }

    private func endDrag(at location: CGPoint? = nil) {
        removeMouseMonitor()
        guard running, !dragging.isEmpty else { return }
        let ids = dragging
        dragging = []
        let origins = dragOrigin
        dragOrigin = [:]
        let point = location ?? NSScreen.mouseAX
        log.info("drag ended at \(point.x, privacy: .public),\(point.y, privacy: .public) windows \(ids, privacy: .public)")
        // The Space may have changed during the drag (window dragged to another Space).
        let onScreen = Set(WindowList.onScreen().map(\.id))
        for wid in ids { finishDrag(wid, from: origins[wid], at: point, onScreen: onScreen) }
        refresh()
    }

    private func finishDrag(_ wid: WindowID, from origin: CGRect?, at point: CGPoint, onScreen: Set<WindowID>) {
        guard onScreen.contains(wid), let t = windows[wid], let cur = t.ax.frame, let old = origin,
              let did = display(of: wid) else { return }
        expected[wid] = cur // so the next layout pass really moves it
        guard settings.mouseSupport else { return } // just snap back
        if TilingManager.isResize(from: old, to: cur) {
            // Resized with the mouse: move the matching split(s).
            if let area = layoutArea(did) {
                _ = displays[did]?.applyUserResize(wid, from: old, to: cur, area: area, gap: innerGap, visible: visible)
            }
            return
        }
        if let (target, targetDisplay) = tiledWindow(at: point, excluding: wid), onScreen.contains(target) {
            log.info("drop \(wid, privacy: .public) onto \(target, privacy: .public)")
            if targetDisplay == did {
                displays[did]?.swap(wid, target)
            } else {
                displays[did]?.remove(wid)
                insert(wid, into: targetDisplay, placement: .afterFocused, near: target)
            }
        } else if let pd = NSScreen.screens.first(where: { $0.axFrame.contains(point) })?.displayID,
                  pd != did, displays[pd] != nil {
            displays[did]?.remove(wid)
            insert(wid, into: pd, placement: .end)
        }
        // Otherwise: dropped on empty space or itself; the refresh snaps it back.
    }

    /// A mouse resize keeps an edge of each axis in place; a move shifts them
    /// all, even when the size changes too (the Windows module restores a
    /// window's pre-snap size when its title-bar drag starts).
    static func isResize(from old: CGRect, to new: CGRect) -> Bool {
        let t: CGFloat = 2
        guard abs(new.width - old.width) > t || abs(new.height - old.height) > t else { return false }
        let anchoredX = abs(new.minX - old.minX) <= t || abs(new.maxX - old.maxX) <= t
        let anchoredY = abs(new.minY - old.minY) <= t || abs(new.maxY - old.maxY) <= t
        return anchoredX && anchoredY
    }

    // MARK: - Refresh (discover windows, update trees, apply)

    /// Debounced refresh. A pending earlier refresh is kept so bursts of
    /// events can't postpone it indefinitely.
    func scheduleRefresh(after delay: TimeInterval = 0.08) {
        guard running else { return }
        let deadline = DispatchTime.now() + delay
        if refreshWork != nil, let current = refreshDeadline, current <= deadline { return }
        refreshWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.refresh() }
        refreshWork = work
        refreshDeadline = deadline
        DispatchQueue.main.asyncAfter(deadline: deadline, execute: work)
    }

    /// Runs a pending refresh now (before a command acts on the state).
    private func flushPendingRefresh() {
        if refreshWork != nil { refresh() }
    }

    func refresh(initial: Bool = false, force: Bool = false) {
        refreshWork?.cancel()
        refreshWork = nil
        refreshDeadline = nil
        guard running else { return }
        if !dragging.isEmpty {
            // endDrag refreshes. If the mouse-up was missed (released over our own
            // window, where the global monitor is blind), finish the drag now.
            if !TilingManager.leftButtonDown { endDrag() }
            return
        }
        if force { expected = [:]; lastApplied = [:] }

        syncDisplays()
        syncObservers()
        let onScreen = Set(WindowList.onScreen().map(\.id))

        var listed = Set<WindowID>()
        var recheckSoon = false
        for (pid, obs) in observers {
            guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated, !app.isHidden else { continue }
            guard let list: [AXUIElement] = obs.appElement.ax(kAXWindowsAttribute) else { continue }
            for el in list {
                let w = AXWindow(element: el, pid: pid)
                if idByElement[w] == nil {
                    // Window elements don't inherit the app element's timeout: without
                    // this, a hung app could block the main thread for 6 s per call.
                    AXUIElementSetMessagingTimeout(el, TilingManager.axTimeout)
                }
                guard let wid = idByElement[w] ?? w.windowID else { continue }
                listed.insert(wid)
                if var t = windows[wid] {
                    // Windows can look like dialogs for a moment after creation; look again.
                    if t.autoFloat, t.userFloat == nil, Date().timeIntervalSince(t.detected) < 3, onScreen.contains(wid) {
                        t.autoFloat = shouldFloat(t.ax, bundleID: t.bundleID)
                        windows[wid] = t
                    }
                    continue
                }
                // Classify only on-screen windows (minimized/hidden ones report odd subroles).
                guard onScreen.contains(wid) else { continue }
                if let f = TilingManager.titleFilter, !w.title.contains(f) { continue }
                let bid = app.bundleIdentifier
                let auto = shouldFloat(w, bundleID: bid)
                let placed = placedUntracked.contains(wid)
                if placed { placedUntracked.removeAll { $0 == wid } }
                windows[wid] = TrackedWindow(ax: w, bundleID: bid, autoFloat: auto, userFloat: placed ? true : nil,
                                             originalFrame: w.frame, detected: Date())
                idByElement[w] = wid
                obs.observe(w)
                if auto { recheckSoon = true }
            }
        }

        // Forget windows that no longer exist anywhere.
        let unlisted = windows.keys.filter { !listed.contains($0) }
        if !unlisted.isEmpty {
            let alive = WindowList.existing(unlisted)
            for wid in unlisted where !alive.contains(wid) { forget(wid) }
        }

        var newVisible = Set<WindowID>()
        for (wid, t) in windows where !t.floating && onScreen.contains(wid) && !t.ax.isFullscreen {
            newVisible.insert(wid)
        }
        // Windows that were tiled on screen a moment ago but no longer are.
        var vanished = visible.subtracting(newVisible).filter { windows[$0] != nil }
        visible = newVisible

        // Floated windows leave the trees; new tiled windows join one.
        for did in displays.keys {
            for wid in displays[did]!.windows where windows[wid]?.floating ?? true {
                displays[did]?.remove(wid)
            }
        }
        var newcomers = newVisible.filter { display(of: $0) == nil }.compactMap { wid in
            windows[wid].map { (wid, $0.ax.frame ?? .zero) }
        }
        if initial {
            // Keep the existing spatial arrangement roughly: left to right, top to bottom.
            newcomers.sort { ($0.1.minX, $0.1.minY) < ($1.1.minX, $1.1.minY) }
        } else {
            newcomers.sort { $0.0 < $1.0 }
        }
        for (wid, frame) in newcomers {
            // A native tab replacing another one shows up at the same frame: take its place.
            if let pid = windows[wid]?.ax.pid,
               let old = vanished.first(where: { windows[$0]?.ax.pid == pid && (expected[$0]?.approxEqual(frame, tolerance: 4) ?? false) }),
               let oldDisplay = display(of: old) {
                displays[oldDisplay]?.replace(old, with: wid)
                vanished.remove(old)
                continue
            }
            let did = NSScreen.containing(axRect: frame)?.displayID ?? NSScreen.main?.displayID ?? 0
            insert(wid, into: did, placement: initial ? .end : settings.newWindowPlacement)
        }

        applyLayout()
        if recheckSoon { later(1.0) { $0.scheduleRefresh(after: 0) } }
    }

    private func syncDisplays() {
        var areas: [CGDirectDisplayID: CGRect] = [:]
        for s in NSScreen.screens { areas[s.displayID] = s.axVisibleFrame }
        screenAreas = areas
        let saved = UserDefaults.standard.dictionary(forKey: TilingManager.layoutDefaultsKey) as? [String: String] ?? [:]
        for did in areas.keys where displays[did] == nil {
            let kind = TilingManager.uuid(of: did).flatMap { saved[$0] }.flatMap(LayoutKind.init(rawValue:)) ?? settings.defaultLayout
            displays[did] = LayoutState(kind: kind, masterRatio: settings.clampedMasterRatio)
        }
        // Windows of disconnected displays re-join a tree on the next pass.
        for did in displays.keys where areas[did] == nil { displays[did] = nil }
    }

    private func isEligible(_ app: NSRunningApplication) -> Bool {
        guard app.activationPolicy == .regular, app.processIdentifier != getpid(), !app.isTerminated else { return false }
        let bid = app.bundleIdentifier ?? ""
        if !settings.onlyApps.isEmpty && !settings.onlyApps.contains(bid) { return false }
        return !settings.floatingApps.contains(bid)
    }

    private func syncObservers() {
        let apps = NSWorkspace.shared.runningApplications.filter(isEligible)
        let pids = Set(apps.map(\.processIdentifier))
        for pid in observers.keys where !pids.contains(pid) && !forcedPIDs.contains(pid) { dropApp(pid) }
        for app in apps where observers[app.processIdentifier] == nil {
            ensureObserver(app.processIdentifier)
        }
    }

    @discardableResult
    private func ensureObserver(_ pid: pid_t) -> AppObserver? {
        if let obs = observers[pid] { return obs }
        // Apps that never answer AX are not retried forever (each try can block briefly).
        guard observerFailures[pid, default: 0] < 3 else { return nil }
        guard let target = callbackTarget, let obs = AppObserver(pid: pid, target: target, callback: tilingAXCallback) else {
            observerFailures[pid, default: 0] += 1
            return nil
        }
        observers[pid] = obs
        return obs
    }

    private func dropApp(_ pid: pid_t) {
        observers[pid]?.invalidate()
        observers[pid] = nil
        observerFailures[pid] = nil
        forcedPIDs.remove(pid)
        for (wid, t) in windows where t.ax.pid == pid { forget(wid) }
    }

    private func forget(_ wid: WindowID) {
        if let t = windows.removeValue(forKey: wid) {
            idByElement[t.ax] = nil
            observers[t.ax.pid]?.forget(t.ax)
        }
        for did in displays.keys where displays[did]!.contains(wid) { displays[did]?.remove(wid) }
        visible.remove(wid)
        expected[wid] = nil
        lastSet[wid] = nil
        lastApplied[wid] = nil
        corrections[wid] = nil
        dragging.remove(wid)
        dragOrigin[wid] = nil
        mru.removeAll { $0 == wid }
    }

    /// AeroSpace-style heuristic: dialogs, sheets, fixed-size windows and windows
    /// without an enabled fullscreen button float.
    private func shouldFloat(_ w: AXWindow, bundleID: String?) -> Bool {
        if let bid = bundleID, settings.floatingApps.contains(bid) { return true }
        guard w.isStandard, w.isResizable else { return true }
        if let bid = bundleID, TilingManager.fullscreenButtonExempt.contains(bid) { return false }
        guard let button: AXUIElement = w.element.ax(kAXFullScreenButtonAttribute) else { return true }
        let enabled: Bool = button.ax(kAXEnabledAttribute) ?? false
        return !enabled
    }

    // MARK: - Layout

    private func layoutArea(_ did: CGDirectDisplayID) -> CGRect? {
        guard let r = screenAreas[did] else { return nil }
        let g = settings.clampedOuterGap
        return r.insetBy(dx: min(g, r.width / 4), dy: min(g, r.height / 4))
    }

    private func display(of wid: WindowID) -> CGDirectDisplayID? {
        displays.first { $0.value.contains(wid) }?.key
    }

    private func insert(_ wid: WindowID, into did: CGDirectDisplayID, placement: Placement, near: WindowID? = nil) {
        guard var state = displays[did], let area = layoutArea(did) else { return }
        let focused = near ?? mru.first { $0 != wid && state.contains($0) && visible.contains($0) }
        state.insert(wid, focused: focused, placement: placement, area: area, gap: innerGap, visible: visible)
        displays[did] = state
    }

    /// Current target frames of every tiled window, by display.
    private func allFrames() -> [(CGDirectDisplayID, [WindowID: CGRect])] {
        displays.compactMap { did, state in
            layoutArea(did).map { (did, state.frames(area: $0, gap: innerGap, visible: visible)) }
        }
    }

    func applyLayout() {
        guard running, dragging.isEmpty else { return }
        for (did, frames) in allFrames() {
            guard let area = layoutArea(did) else { continue }
            for (wid, r) in frames { setFrame(wid, r, area: area) }
        }
    }

    private func setFrame(_ wid: WindowID, _ r: CGRect, area: CGRect) {
        guard let t = windows[wid] else { return }
        if let e = expected[wid] {
            if e.approxEqual(r, tolerance: 1) { return }
            // The app keeps this window at another size (minimum size) and nothing
            // moved it since: sending the same frame again changes nothing.
            if let last = lastApplied[wid], last.target.approxEqual(r, tolerance: 1), last.result.approxEqual(e, tolerance: 1) { return }
        } else if let cur = t.ax.frame, cur.approxEqual(r, tolerance: 1) {
            expected[wid] = cur
            return
        }
        t.ax.setFrame(r)
        var actual = t.ax.frame ?? r
        if actual.maxX > area.maxX + 1 || actual.maxY > area.maxY + 1 {
            // Bigger than its tile (minimum size): overlap the neighbour rather
            // than hang off the screen edge.
            let p = CGPoint(x: actual.maxX > area.maxX + 1 ? max(area.minX, area.maxX - actual.width) : actual.minX,
                            y: actual.maxY > area.maxY + 1 ? max(area.minY, area.maxY - actual.height) : actual.minY)
            t.ax.setPosition(p)
            actual = t.ax.frame ?? CGRect(origin: p, size: actual.size)
        }
        expected[wid] = actual
        lastApplied[wid] = (r, actual)
        lastSet[wid] = Date()
    }

    private func tiledWindow(at point: CGPoint, excluding: WindowID) -> (WindowID, CGDirectDisplayID)? {
        for (did, frames) in allFrames() {
            if let hit = frames.first(where: { $0.key != excluding && $0.value.contains(point) }) { return (hit.key, did) }
        }
        return nil
    }

    // MARK: - Commands

    private func focusedID() -> WindowID? {
        guard let w = AXWindow.focused() else { return nil }
        return idByElement[w] ?? w.windowID
    }

    /// The focused window if it is tiled; shows a hint otherwise.
    private func focusedTiled() -> (WindowID, CGDirectDisplayID)? {
        flushPendingRefresh()
        guard let wid = focusedID(), visible.contains(wid), let did = display(of: wid) else {
            HUD.show("No tiled window focused", symbol: "macwindow")
            return nil
        }
        return (wid, did)
    }

    private var mruRank: [WindowID: Int] {
        Dictionary(mru.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
    }

    /// Display for layout commands: the focused tiled window's, else the one under the mouse.
    private func commandDisplay() -> CGDirectDisplayID? {
        flushPendingRefresh()
        if let wid = focusedID(), let did = display(of: wid) { return did }
        return NSScreen.underMouse?.displayID
    }

    var currentLayout: LayoutKind? {
        commandDisplay().flatMap { displays[$0]?.kind }
    }

    /// Frames to navigate between: every tiled window, but only the most recent
    /// window of a monocle display (plus `keeping`, the source window).
    private func candidateFrames(rank: [WindowID: Int], keeping: WindowID?) -> [(WindowID, CGRect)] {
        var out: [(WindowID, CGRect)] = []
        for (did, frames) in allFrames() {
            if displays[did]?.kind == .monocle {
                let best = frames.keys.contains(keeping ?? 0) ? keeping
                    : frames.keys.min { (rank[$0] ?? .max, $0) < (rank[$1] ?? .max, $1) }
                if let best, let r = frames[best] { out.append((best, r)) }
            } else {
                out += frames.map { ($0.key, $0.value) }
            }
        }
        return out
    }

    func focus(_ dir: Direction) {
        flushPendingRefresh()
        let fid = focusedID()
        if let fid, visible.contains(fid), let did = display(of: fid), let state = displays[did], state.kind == .monocle,
           let target = Neighbor.cycle(state.order(visible), from: fid, forward: dir.isForward) {
            focusWindow(target)
            return
        }
        let rank = mruRank
        var candidates = candidateFrames(rank: rank, keeping: fid)
        let source: CGRect
        if let fid, let r = candidates.first(where: { $0.0 == fid })?.1 ?? windows[fid]?.ax.frame ?? AXWindow.focused()?.frame {
            source = r
        } else {
            let m = NSScreen.mouseAX
            source = CGRect(x: m.x, y: m.y, width: 1, height: 1)
        }
        candidates.removeAll { $0.0 == fid }
        if let target = Neighbor.find(from: source, direction: dir, candidates: candidates, rank: rank) {
            focusWindow(target)
        }
    }

    func move(_ dir: Direction) {
        guard let (wid, did) = focusedTiled(), let state = displays[did] else { return }
        if state.kind == .monocle {
            guard let other = Neighbor.cycle(state.order(visible), from: wid, forward: dir.isForward) else { return }
            displays[did]?.swap(wid, other)
            applyLayout()
            return
        }
        let rank = mruRank
        var candidates = candidateFrames(rank: rank, keeping: wid)
        guard let source = candidates.first(where: { $0.0 == wid })?.1 else { return }
        candidates.removeAll { $0.0 == wid }
        if let target = Neighbor.find(from: source, direction: dir, candidates: candidates, rank: rank),
           let targetDisplay = display(of: target) {
            if targetDisplay == did {
                displays[did]?.swap(wid, target)
            } else {
                displays[did]?.remove(wid)
                insert(wid, into: targetDisplay, placement: .afterFocused, near: target)
            }
        } else if let screen = NSScreen.screens.first(where: { $0.displayID == did }),
                  let next = Neighbor.find(from: screen.axFrame, direction: dir,
                                           candidates: NSScreen.screens.filter { $0 != screen }.map { ($0.displayID, $0.axFrame) }),
                  displays[next] != nil {
            displays[did]?.remove(wid)
            insert(wid, into: next, placement: .end)
        } else {
            return
        }
        applyLayout()
        windows[wid]?.ax.raise()
    }

    func resize(grow: Bool) {
        guard let (wid, did) = focusedTiled() else { return }
        let delta = settings.clampedResizeStep * (grow ? 1 : -1)
        if displays[did]?.grow(wid, by: delta, visible: visible) == true {
            applyLayout()
        } else {
            HUD.show(displays[did]?.kind == .monocle ? "Can't resize in Monocle" : "Nothing to resize", symbol: "arrow.left.and.right")
        }
    }

    func balance() {
        guard let did = commandDisplay() else { return }
        displays[did]?.balance(masterRatio: settings.clampedMasterRatio, visible: visible)
        applyLayout()
        HUD.show("Balanced", symbol: "equal.square")
    }

    func promote() {
        guard let (wid, did) = focusedTiled() else { return }
        if displays[did]?.promote(wid, visible: visible) == true {
            applyLayout()
        }
    }

    func toggleSplit() {
        guard let (wid, did) = focusedTiled() else { return }
        guard displays[did]?.kind == .tiles else {
            HUD.show("Split direction only applies to Tiles", symbol: "rectangle.split.2x1")
            return
        }
        if displays[did]?.toggleSplitAxis(wid, visible: visible) == true { applyLayout() }
    }

    func cycleLayout() {
        guard let did = commandDisplay(), let kind = displays[did]?.kind else { return }
        setLayout(kind.next, display: did)
    }

    func setLayout(_ kind: LayoutKind, display: CGDirectDisplayID? = nil) {
        guard let did = display ?? commandDisplay(), displays[did] != nil else { return }
        displays[did]?.kind = kind
        if let uuid = TilingManager.uuid(of: did) {
            var saved = UserDefaults.standard.dictionary(forKey: TilingManager.layoutDefaultsKey) as? [String: String] ?? [:]
            saved[uuid] = kind.rawValue
            UserDefaults.standard.set(saved, forKey: TilingManager.layoutDefaultsKey)
        }
        applyLayout()
        if kind == .monocle, let wid = focusedID(), visible.contains(wid) { windows[wid]?.ax.raise() }
        HUD.show(kind.title, symbol: kind.symbol, on: NSScreen.screens.first { $0.displayID == did })
    }

    func toggleFloat() {
        flushPendingRefresh()
        guard let w = AXWindow.focused(), let wid = idByElement[w] ?? w.windowID else {
            HUD.show("No window focused", symbol: "macwindow")
            return
        }
        if windows[wid] == nil {
            // Window of an app that is not observed (floating app list) or not tracked yet.
            guard let app = w.app, app.activationPolicy == .regular, app.processIdentifier != getpid() else { return }
            let bid = app.bundleIdentifier ?? ""
            if !settings.onlyApps.isEmpty && !settings.onlyApps.contains(bid) {
                HUD.show("\(app.localizedName ?? "App") is not tiled", symbol: "macwindow")
                return
            }
            if let f = TilingManager.titleFilter, !w.title.contains(f) { return }
            forcedPIDs.insert(w.pid)
            guard let obs = ensureObserver(w.pid) else { return }
            AXUIElementSetMessagingTimeout(w.element, TilingManager.axTimeout)
            windows[wid] = TrackedWindow(ax: w, bundleID: app.bundleIdentifier, autoFloat: true, userFloat: false,
                                         originalFrame: w.frame, detected: Date())
            idByElement[w] = wid
            obs.observe(w)
            refresh()
            HUD.show("Tiled", symbol: "rectangle.split.2x2")
            return
        }
        guard var t = windows[wid] else { return }
        t.userFloat = !t.floating
        windows[wid] = t
        if t.floating {
            let did = display(of: wid)
            if let did { displays[did]?.remove(wid) }
            visible.remove(wid)
            expected[wid] = nil
            // Give it back a comfortable size, centred on its display.
            if let did, let area = layoutArea(did) {
                var size = t.originalFrame?.size ?? CGSize(width: area.width * 0.6, height: area.height * 0.7)
                if size.width >= area.width - 40 || size.height >= area.height - 40 {
                    size = CGSize(width: area.width * 0.6, height: area.height * 0.7)
                }
                size.width = min(size.width, area.width)
                size.height = min(size.height, area.height)
                t.ax.setFrame(CGRect(x: (area.midX - size.width / 2).rounded(), y: (area.midY - size.height / 2).rounded(),
                                     width: size.width, height: size.height))
            }
            t.ax.raise()
            applyLayout()
            HUD.show("Floating", symbol: "macwindow.on.rectangle")
        } else {
            if let frame = t.ax.frame {
                let centre = CGPoint(x: frame.midX, y: frame.midY)
                let near = tiledWindow(at: centre, excluding: wid)
                let did = near?.1 ?? NSScreen.containing(axRect: frame)?.displayID ?? NSScreen.main?.displayID ?? 0
                visible.insert(wid)
                insert(wid, into: did, placement: .afterFocused, near: near?.0)
            }
            refresh()
            HUD.show("Tiled", symbol: "rectangle.split.2x2")
        }
    }

    /// A window the user placed with a Windows-module command or snap stops
    /// being tiled and keeps the frame they chose (posted before the AX move
    /// notifications arrive, so it is never snapped back).
    private func floatPlaced(_ w: AXWindow) {
        guard w.pid != getpid() else { return } // Bento's own windows are never tiled
        guard let wid = idByElement[w] ?? w.windowID else { return }
        guard var t = windows[wid] else {
            // Placed before we saw it (a Windows launch rule on a new window): it starts floating.
            placedUntracked.removeAll { $0 == wid }
            placedUntracked.append(wid)
            if placedUntracked.count > 16 { placedUntracked.removeFirst() }
            return
        }
        guard !t.floating else { return }
        t.userFloat = true
        windows[wid] = t
        if let did = display(of: wid) { displays[did]?.remove(wid) }
        visible.remove(wid)
        expected[wid] = nil
        // A modifier-drag swallows the mouse-up our drag tracking waits for:
        // the drag of this window is over now.
        if dragging.remove(wid) != nil {
            dragOrigin[wid] = nil
            if dragging.isEmpty { removeMouseMonitor() }
        }
        applyLayout()
    }

    func moveToNextDisplay() {
        guard let (wid, did) = focusedTiled() else { return }
        let screens = NSScreen.screens
        guard screens.count > 1, let i = screens.firstIndex(where: { $0.displayID == did }) else {
            HUD.show("No other display", symbol: "display")
            return
        }
        let next = screens[(i + 1) % screens.count].displayID
        guard displays[next] != nil else { return }
        displays[did]?.remove(wid)
        insert(wid, into: next, placement: .end)
        applyLayout()
        windows[wid]?.ax.raise()
    }

    func retile() {
        refresh(force: true)
        HUD.show("Retiled", symbol: "arrow.triangle.2.circlepath")
    }

    // MARK: - Focus

    private func focusWindow(_ wid: WindowID) {
        guard let t = windows[wid] else { return }
        TilingManager.focus(t.ax)
    }

    /// Raises the window and activates its app. AX frontmost works for
    /// background (accessory) callers where cooperative activation may not.
    static func focus(_ w: AXWindow) {
        AXUIElementSetAttributeValue(w.element, kAXMainAttribute as CFString, kCFBooleanTrue)
        w.raise()
        AXUIElementSetAttributeValue(AXWindow.appElement(w.pid), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        if NSWorkspace.shared.frontmostApplication?.processIdentifier != w.pid {
            w.app?.activate(options: [])
        }
    }

    /// Directional focus without the manager: among all on-screen windows, by geometry.
    static func focusUnmanaged(_ dir: Direction) {
        let focused = AXWindow.focused()
        let fid = focused?.windowID
        let regular = Set(NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.map(\.processIdentifier))
        let infos = WindowList.onScreen().filter {
            regular.contains($0.pid) && $0.pid != getpid() && $0.bounds.width > 60 && $0.bounds.height > 60
        }
        let rank = Dictionary(infos.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { a, _ in a })
        let source: CGRect
        if let r = focused?.frame {
            source = r
        } else {
            let m = NSScreen.mouseAX
            source = CGRect(x: m.x, y: m.y, width: 1, height: 1)
        }
        let candidates = infos.filter { $0.id != fid }.map { ($0.id, $0.bounds) }
        guard let target = Neighbor.find(from: source, direction: dir, candidates: candidates, rank: rank),
              let info = infos.first(where: { $0.id == target }),
              let w = AXWindow.windows(of: info.pid).first(where: { $0.windowID == target }) else { return }
        focus(w)
    }

    // MARK: - Debug

    /// Human-readable state (dev harness: `scripts/perform tiling.debug-dump`).
    func debugDescription() -> String {
        var lines: [String] = []
        for (did, state) in displays.sorted(by: { $0.key < $1.key }) {
            lines.append("display \(did) layout=\(state.kind.rawValue) master=\(String(format: "%.2f", state.masterRatio)) area=\(layoutArea(did).map { "\($0)" } ?? "-")")
            lines.append("  tree: \(state.tree.map(TilingManager.describe) ?? "empty")")
            let frames = layoutArea(did).map { state.frames(area: $0, gap: innerGap, visible: visible) } ?? [:]
            for wid in state.order(visible) {
                let t = windows[wid]
                lines.append("  \(wid) \(t?.ax.title ?? "?") target=\(frames[wid].map { "\($0)" } ?? "-") actual=\(t?.ax.frame.map { "\($0)" } ?? "-")")
            }
        }
        let floating = windows.filter { $0.value.floating }.map { "\($0.key) \($0.value.ax.title)" }
        lines.append("floating: \(floating)")
        lines.append("observers: \(observers.count) apps, tracked windows: \(windows.count), visible: \(visible.count)")
        lines.append("dragging: \(dragging.count), mouse monitor: \(mouseMonitor != nil), pending refresh: \(refreshWork != nil), "
                     + "pending external: \(externalWork != nil), live app observers: \(AppObserver.live)")
        return lines.joined(separator: "\n")
    }

    /// Runtime state for `bento://debug/state`.
    var diagnostics: [String: Any] {
        [
            "running": running,
            "observedApps": observers.count,
            "trackedWindows": windows.count,
            "tiled": visible.count,
            "floating": windows.values.filter(\.floating).count,
            "dragging": dragging.count,
            "mouseMonitor": mouseMonitor != nil,
            "pendingRefresh": refreshWork != nil,
            "layouts": Dictionary(uniqueKeysWithValues: displays.map { ("\($0.key)", $0.value.kind.rawValue) }),
        ]
    }

    private static func describe(_ n: TileNode) -> String {
        switch n {
        case .leaf(let id): "\(id)"
        case .split(let axis, let ratio, let a, let b):
            "\(axis == .horizontal ? "H" : "V")\(String(format: "%.2f", ratio))(\(describe(a)), \(describe(b)))"
        }
    }

    static func uuid(of did: CGDirectDisplayID) -> String? {
        guard let u = CGDisplayCreateUUIDFromDisplayID(did)?.takeRetainedValue() else { return nil }
        return CFUUIDCreateString(nil, u) as String?
    }
}
