import AppKit
import BentoCore

/// Saved layouts (capture / restore window positions of visible apps) and
/// per-app positions applied when an app launches.
///
/// Idle cost: one NSWorkspace launch observer while launch rules exist or a
/// layout restore is waiting for an app; short retry timers only after a launch.
final class LayoutManager {
    private let engine: WindowEngine
    private var launchObserver: NSObjectProtocol?
    /// Placements waiting for an app to show its first windows.
    private var pending: [String: [() -> Bool]] = [:]
    var rules: [LaunchRule] = [] { didSet { updateObserver() } }

    init(engine: WindowEngine) {
        self.engine = engine
    }

    func stop() {
        rules = []
        pending = [:]
        updateObserver()
    }

    // MARK: Capture

    /// Captures the standard windows of all visible apps on the current Space.
    func capture(name: String) -> SavedLayout {
        let z = WindowList.zOrder()
        let snap = ScreenSnapshot.current()
        var entries: [SavedLayout.Entry] = []
        guard !snap.rects.isEmpty else { return SavedLayout(name: name, windows: entries) }
        let apps = NSWorkspace.shared.runningApplications.filter {
            $0.activationPolicy == .regular && !$0.isHidden && $0.processIdentifier != getpid() && $0.bundleIdentifier != nil
        }
        for app in apps {
            let windows = AXWindow.windows(of: app.processIdentifier)
                .filter { $0.isStandard && !$0.isMinimized }
                .compactMap { w -> (AXWindow, CGRect, Int)? in
                    guard let id = w.windowID, let order = z[id], let f = w.frame else { return nil }
                    return (w, f, order)
                }
                .sorted { $0.2 < $1.2 }
            for (i, item) in windows.enumerated() {
                let si = snap.index(containing: item.1)
                let screen = snap.screens[si]
                entries.append(SavedLayout.Entry(bundleID: app.bundleIdentifier ?? "", appName: app.localizedName ?? "",
                                                 title: item.0.title, index: i, frame: Rect(item.1),
                                                 screen: Rect(snap.rects[si].frame), displayUUID: LayoutManager.uuid(of: screen)))
            }
        }
        return SavedLayout(name: name, windows: entries)
    }

    static func uuid(of screen: NSScreen) -> String? {
        guard let ref = CGDisplayCreateUUIDFromDisplayID(screen.displayID)?.takeRetainedValue() else { return nil }
        return CFUUIDCreateString(nil, ref) as String?
    }

    // MARK: Restore

    func restore(_ layout: SavedLayout) {
        guard Permissions.accessibility else { Permissions.requestAccessibility(); return }
        let byApp = Dictionary(grouping: layout.windows, by: \.bundleID)
        for (bundleID, entries) in byApp {
            let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first
            if let app = running {
                if app.isHidden { app.unhide() }
                if !place(entries, pid: app.processIdentifier) {
                    waitForWindows(bundleID) { [weak self] in self?.place(entries, pid: app.processIdentifier) ?? true }
                }
            } else if layout.launchApps, let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) {
                waitForWindows(bundleID) { [weak self] in
                    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first else { return false }
                    return self?.place(entries, pid: app.processIdentifier) ?? true
                }
                let cfg = NSWorkspace.OpenConfiguration()
                cfg.activates = false
                NSWorkspace.shared.openApplication(at: url, configuration: cfg)
            }
        }
    }

    /// Matches saved entries to the app's windows (same title first, then by
    /// order) and moves them. Returns false if the app has no windows yet.
    @discardableResult
    private func place(_ entries: [SavedLayout.Entry], pid: pid_t) -> Bool {
        let z = WindowList.zOrder()
        var windows = AXWindow.windows(of: pid).filter { $0.isStandard && !$0.isMinimized }
        guard !windows.isEmpty else { return false }
        windows.sort { (z[$0.windowID ?? 0] ?? Int.max) < (z[$1.windowID ?? 0] ?? Int.max) }
        var remaining = entries.sorted { $0.index < $1.index }
        var pairs: [(AXWindow, SavedLayout.Entry)] = []
        var unmatched: [AXWindow] = []
        for w in windows {
            let t = w.title
            if !t.isEmpty, let i = remaining.firstIndex(where: { $0.title == t }) {
                pairs.append((w, remaining.remove(at: i)))
            } else {
                unmatched.append(w)
            }
        }
        for (w, e) in zip(unmatched, remaining) { pairs.append((w, e)) }

        let snap = ScreenSnapshot.current()
        guard !snap.rects.isEmpty else { return false }
        for (w, e) in pairs {
            guard let current = w.frame, let mapped = LayoutManager.map(e, to: snap) else { continue }
            let (target, si) = mapped
            engine.place(w, from: current, to: target, visible: snap.rects[si].visible)
        }
        return true
    }

    /// Where a saved frame goes on today's displays: same display if present
    /// (by UUID, then by frame), otherwise proportionally onto the main display.
    static func map(_ e: SavedLayout.Entry, to snap: ScreenSnapshot) -> (CGRect, Int)? {
        guard !snap.rects.isEmpty else { return nil }
        if let uuid = e.displayUUID, let i = snap.screens.firstIndex(where: { uuid == LayoutManager.uuid(of: $0) }) {
            return (translate(e, to: snap.rects[i]), i)
        }
        if let i = snap.rects.firstIndex(where: { Geometry.near($0.frame, e.screen.cg) }) {
            return (e.frame.cg, i)
        }
        return (Geometry.proportional(e.frame.cg, from: e.screen.cg, to: snap.rects[0].visible), 0)
    }

    /// Same display, possibly moved in the arrangement: keep the offset within it.
    private static func translate(_ e: SavedLayout.Entry, to s: ScreenRect) -> CGRect {
        let old = e.screen.cg
        if Geometry.near(old, s.frame) { return e.frame.cg }
        if abs(old.width - s.frame.width) > 1 || abs(old.height - s.frame.height) > 1 {
            return Geometry.proportional(e.frame.cg, from: old, to: s.frame)
        }
        return e.frame.cg.offsetBy(dx: s.frame.minX - old.minX, dy: s.frame.minY - old.minY)
    }

    // MARK: Launch rules

    private func updateObserver() {
        let needed = !rules.isEmpty || !pending.isEmpty
        if needed, launchObserver == nil {
            launchObserver = NSWorkspace.shared.notificationCenter.addObserver(
                forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { [weak self] note in
                guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
                self?.launched(app)
            }
        } else if !needed, let o = launchObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(o)
            launchObserver = nil
        }
    }

    private func launched(_ app: NSRunningApplication) {
        guard let bid = app.bundleIdentifier else { return }
        if let rule = rules.first(where: { $0.bundleID == bid }), let cmd = WindowCommand(rawValue: rule.command) {
            let pid = app.processIdentifier
            waitForWindows(bid) { [weak self] in
                guard let w = AXWindow.windows(of: pid).first(where: { $0.isStandard && !$0.isMinimized }) else { return false }
                self?.engine.perform(cmd, on: w, source: .launch)
                return true
            }
        }
        if let jobs = pending[bid] { run(bid, jobs: jobs, attempt: 0) }
    }

    /// Runs `job` now if possible, otherwise after the app's launch with retries.
    private func waitForWindows(_ bundleID: String, job: @escaping () -> Bool) {
        if !NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).isEmpty {
            run(bundleID, jobs: [job], attempt: 0)
        } else {
            pending[bundleID, default: []].append(job)
            updateObserver()
        }
    }

    private static let retryDelays: [Double] = [0.0, 0.3, 0.6, 1.0, 1.5, 2.5, 4.0, 6.0]

    private func run(_ bundleID: String, jobs: [() -> Bool], attempt: Int) {
        pending[bundleID] = nil
        let left = jobs.filter { !$0() }
        guard !left.isEmpty else { updateObserver(); return }
        let next = attempt + 1
        guard next < LayoutManager.retryDelays.count else { updateObserver(); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + LayoutManager.retryDelays[next]) { [weak self] in
            self?.run(bundleID, jobs: left, attempt: next)
        }
    }
}
