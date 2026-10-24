import AppKit
import ApplicationServices
import BentoCore

/// One status item in the menu bar (any app's, or one of Bento's).
struct MenuBarItem: Identifiable, Equatable {
    enum Role: Equatable {
        case regular
        /// Bento's chevron or a separator.
        case control(ControlItems.Kind)
        /// Bento's own menu bar icon (kept in the visible section).
        case bentoIcon
        /// macOS keeps these at the right and doesn't let them move (clock, Control Centre).
        case fixed
    }

    let windowID: CGWindowID
    /// Global frame, top-left origin. Parked (hidden) items are off-screen to the left.
    var frame: CGRect
    /// The status item's autosave name ("Item-0", "WiFi"); empty until the
    /// item was seen on screen (macOS 26 blanks it while parked).
    var windowName: String
    /// The app that made the item (on macOS 26 the windows belong to Control
    /// Centre; the real owner comes from Accessibility). Nil while unknown.
    var ownerPID: pid_t?
    var bundleID: String?
    var appName: String
    /// What the item calls itself to VoiceOver, if anything useful.
    var detail: String?
    var role: Role = .regular

    var id: CGWindowID { windowID }

    /// Stable across launches: `<bundle id>/<autosave name>`. Items without a
    /// known name or owner get a per-session key (`?<window id>`), which is
    /// never stored.
    var key: String {
        guard hasStableKey, let ns = bundleID ?? (appName.isEmpty ? nil : appName) else { return "?\(windowID)" }
        return "\(ns)/\(windowName)"
    }

    var hasStableKey: Bool { !windowName.isEmpty && (bundleID != nil || !appName.isEmpty) && ownerPID != nil }

    /// Short name for lists and search.
    var name: String {
        if bundleID == "com.apple.controlcenter" || bundleID == "com.apple.systemuiserver",
           let system = MenuBarItem.systemNames[windowName] ?? MenuBarItem.systemNames[windowName.replacingOccurrences(of: "-0", with: "")] {
            return system
        }
        if case .control(let kind) = role {
            switch kind {
            case .toggle: return "Bento Chevron"
            case .hidden: return "Hidden Section Separator"
            case .alwaysHidden: return "Always Hidden Section Separator"
            }
        }
        return appName.isEmpty ? (windowName.isEmpty ? "Unknown Item" : windowName) : appName
    }

    /// Secondary line: the accessibility description when it adds something.
    var subtitle: String? {
        guard let detail, !detail.isEmpty, detail != name, detail != appName else { return nil }
        return detail
    }

    var isMovable: Bool { role == .regular || role == .bentoIcon }

    var isOnScreen: Bool { WindowServer.onScreen(frame) }

    var layoutItem: LayoutItem { LayoutItem(key: key, minX: frame.minX, width: frame.width) }

    static let systemNames: [String: String] = [
        "Clock": "Clock", "BentoBox": "Control Centre", "Battery": "Battery", "WiFi": "Wi‑Fi",
        "Bluetooth": "Bluetooth", "FocusModes": "Focus", "NowPlaying": "Now Playing", "Sound": "Sound",
        "Display": "Display", "ScreenMirroring": "Screen Mirroring", "KeyboardBrightness": "Keyboard Brightness",
        "AirDrop": "AirDrop", "Siri": "Siri", "Spotlight": "Spotlight", "UserSwitcher": "Fast User Switching",
        "Accessibility": "Accessibility Shortcuts", "Hearing": "Hearing", "StageManager": "Stage Manager",
        "VPN": "VPN", "Weather": "Weather", "com.apple.menuextra.TimeMachine": "Time Machine",
        "TextInput": "Input Sources", "com.apple.menuextra.textinput": "Input Sources",
    ]

    /// Control Centre's own items that can't be moved.
    static func isFixed(bundleID: String?, windowName: String) -> Bool {
        guard bundleID == "com.apple.controlcenter" else { return false }
        return windowName == "Clock" || windowName.hasPrefix("BentoBox")
    }
}

/// Builds snapshots of the menu bar: the window server lists the item
/// windows (cheap, main thread); on macOS 26 their owners come from
/// Accessibility, resolved off the main thread and cached per window.
final class ItemScanner {
    /// Owner info learned for a window. Window ids are stable while the app runs.
    struct Owner {
        var pid: pid_t
        var bundleID: String?
        var appName: String
        var detail: String?
        var element: AXUIElement?
    }

    private let log = BentoLog.make("menubar")
    /// Window id → autosave name, learned while the item was on screen.
    private var names: [CGWindowID: String] = [:]
    /// Window id → owner, from Accessibility (macOS 26) or the window list.
    private var owners: [CGWindowID: Owner] = [:]
    /// Apps known to have menu bar extras (looked at first).
    private var appsWithExtras: Set<pid_t> = []
    private let axQueue = DispatchQueue(label: "com.charles.bento.menubar.ax", qos: .userInitiated)
    private var resolving = false
    private var pendingResolves: [() -> Void] = []
    private var stopped = false
    private let actions = ItemWorkQueue(label: "com.charles.bento.menubar.press")

    struct PressEnvironment {
        var axFrame: (AXUIElement) -> CGRect?
        var windowFrame: (CGWindowID) -> CGRect?
        var perform: (AXUIElement) -> AXError

        static var live: PressEnvironment {
            PressEnvironment(axFrame: ItemScanner.axFrame, windowFrame: WindowServer.frame,
                             perform: { AXUIElementPerformAction($0, kAXPressAction as CFString) })
        }
    }

    private let pressEnvironment: PressEnvironment
    private let snapshotOverride: (() -> [MenuBarItem])?

    init(owners: [CGWindowID: Owner] = [:], pressEnvironment: PressEnvironment = .live,
         snapshot: (() -> [MenuBarItem])? = nil) {
        self.owners = owners
        self.pressEnvironment = pressEnvironment
        self.snapshotOverride = snapshot
    }

    func stop() {
        stopped = true
        pendingResolves = []
        actions.finish()
    }

    func cancelPresses() { actions.cancelAll() }

    /// macOS 26 hosts every status item window in Control Centre.
    static let windowsAreHosted: Bool = ProcessInfo.processInfo.isOperatingSystemAtLeast(OperatingSystemVersion(majorVersion: 26, minorVersion: 0, patchVersion: 0))

    /// The current items, left to right. Owners not yet known are filled in by `resolveOwners`.
    func snapshot() -> [MenuBarItem] {
        if let snapshotOverride { return snapshotOverride() }
        let windows = WindowServer.menuBarItemWindows()
        let live = Set(windows.map(\.id))
        names = names.filter { live.contains($0.key) }
        owners = owners.filter { live.contains($0.key) }
        let myPID = getpid()
        let controlNames = Dictionary(ControlItems.autosaveNames.map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
        var items: [MenuBarItem] = []
        for w in windows where w.frame.width > 0 {
            if !w.name.isEmpty { names[w.id] = w.name }
            let name = names[w.id] ?? w.name
            if name == "System Status Item Clone" { continue }
            var owner = owners[w.id]
            if owner == nil, !ItemScanner.windowsAreHosted || w.ownerPID == myPID {
                owner = ItemScanner.owner(pid: w.ownerPID, fallbackName: w.ownerName)
                owners[w.id] = owner
            }
            var item = MenuBarItem(windowID: w.id, frame: w.frame, windowName: name, ownerPID: owner?.pid,
                                   bundleID: owner?.bundleID, appName: owner?.appName ?? "", detail: owner?.detail)
            // On macOS 26 Bento's own icon is told apart through Accessibility
            // like any other app's (its local window doesn't know where it is).
            let isOwn = owner?.pid == myPID
            if let kind = controlNames[name], isOwn || ItemScanner.windowsAreHosted {
                item.role = .control(kind)
            } else if isOwn {
                item.role = .bentoIcon
            } else if MenuBarItem.isFixed(bundleID: owner?.bundleID, windowName: name) {
                item.role = .fixed
            }
            if item.role != .regular && item.role != .fixed {
                let me = Owner(pid: myPID, bundleID: Bundle.main.bundleIdentifier, appName: "Bento")
                owners[w.id] = me
                item.ownerPID = me.pid
                item.bundleID = me.bundleID
                item.appName = me.appName
            }
            items.append(item)
        }
        return items.sorted { $0.frame.midX < $1.frame.midX }
    }

    /// Items whose owner isn't known yet.
    func unresolved(in items: [MenuBarItem]) -> [MenuBarItem] {
        items.filter { $0.ownerPID == nil }
    }

    /// Looks up the owners of `items` through Accessibility, off the main
    /// thread, then calls `completion` on the main thread. Cheap when every
    /// owner is already known. Also refreshes the accessibility descriptions
    /// when `details` is set (used when Settings opens).
    func resolveOwners(_ items: [MenuBarItem], details: Bool = false, completion: @escaping () -> Void) {
        guard !stopped else { return }
        if snapshotOverride != nil { completion(); return }
        let missing = items.filter { $0.ownerPID == nil && $0.role == .regular }
        let wantDetails = details && Permissions.accessibility
        guard (!missing.isEmpty || wantDetails), Permissions.accessibility else { completion(); return }
        pendingResolves.append(completion)
        guard !resolving else { return }
        resolving = true
        scan(items)
    }

    /// One look at every candidate app's menu bar extras, matched to the
    /// windows by position. Items move while it runs (an item changing width
    /// shifts the ones left of it): a window that moved is left unmatched
    /// until the next requested refresh.
    private func scan(_ items: [MenuBarItem]) {
        guard !stopped else { return }
        let tracked = items.filter { $0.role == .regular || $0.role == .fixed || $0.role == .bentoIcon }
        // Where the windows are as the scan starts (`items` may be older).
        let before = ItemScanner.frames(of: tracked.map(\.windowID))
        let hosted = ItemScanner.windowsAreHosted
        // Before macOS 26 the window list knows each item's app for sure:
        // Accessibility only adds the description and the element.
        let windowOwners = hosted ? [:] : Dictionary(tracked.compactMap { i in i.ownerPID.map { (i.windowID, $0) } },
                                                     uniquingKeysWith: { a, _ in a })
        let known = appsWithExtras
        // Apps to ask: on macOS 26 every app that may own an item (known ones
        // first); before that only the window owners, for their descriptions.
        let candidates: [NSRunningApplication]
        if hosted {
            // Bento itself too: that's how its own icon is found.
            var apps = NSWorkspace.shared.runningApplications.filter {
                !$0.isTerminated && $0.isFinishedLaunching && $0.activationPolicy != .prohibited && $0.processIdentifier != getpid()
            }
            apps.append(NSRunningApplication.current)
            candidates = apps.sorted { known.contains($0.processIdentifier) && !known.contains($1.processIdentifier) }
        } else {
            let pids = Set(items.compactMap(\.ownerPID))
            candidates = NSWorkspace.shared.runningApplications.filter { pids.contains($0.processIdentifier) }
        }
        let started = CFAbsoluteTimeGetCurrent()
        axQueue.async { [weak self] in
            let extras = ItemScanner.extras(of: candidates)
            DispatchQueue.main.async {
                guard let self, !self.stopped else { return }
                let after = ItemScanner.frames(of: Array(before.keys))
                let moved = self.apply(extras, before: before, after: after, windowOwners: windowOwners, apps: candidates)
                let ms = (CFAbsoluteTimeGetCurrent() - started) * 1000
                self.log.debug("Resolved menu bar owners in \(ms, format: .fixed(precision: 0), privacy: .public) ms (\(candidates.count) apps, \(moved.count) moved)")
                self.resolving = false
                let done = self.pendingResolves
                self.pendingResolves = []
                done.forEach { $0() }
            }
        }
    }

    /// Records the owners found; returns the windows that moved meanwhile.
    private func apply(_ extras: [AXExtra], before: [CGWindowID: CGRect], after: [CGWindowID: CGRect],
                       windowOwners: [CGWindowID: pid_t], apps: [NSRunningApplication]) -> Set<CGWindowID> {
        let byPID = Dictionary(apps.map { ($0.processIdentifier, $0) }, uniquingKeysWith: { a, _ in a })
        appsWithExtras.formUnion(extras.map(\.pid))
        let (matched, moved) = MenuBarLayout.matchOwners(before: before, after: after, elements: extras.map(\.frame))
        for (wid, i) in matched {
            let match = extras[i]
            if let pid = windowOwners[wid], pid != match.pid { continue }
            guard let app = byPID[match.pid] else { continue }
            owners[wid] = Owner(pid: match.pid, bundleID: app.bundleIdentifier, appName: app.localizedName ?? "",
                                detail: match.detail, element: match.element)
        }
        return moved
    }

    private static func frames(of ids: [CGWindowID]) -> [CGWindowID: CGRect] {
        Dictionary(ids.compactMap { id in WindowServer.frame(of: id).map { (id, $0) } }, uniquingKeysWith: { a, _ in a })
    }

    /// AXPress on an item's element, off the main thread. The element is
    /// checked against the item's window first, as pressing a stale match
    /// would open another item's menu; one that isn't there any more is
    /// forgotten and looked up again later. An app answers only once the menu
    /// it opened closes, so the call times out while the menu is up: that
    /// counts as pressed (a click on top would close the menu again).
    /// `completion(false)` when unavailable; the caller explains manual activation.
    /// Stopped work is drained and its callback discarded.
    func press(_ item: MenuBarItem, completion: @escaping (_ pressed: Bool) -> Void) {
        guard !stopped else { return }
        let id = item.windowID
        guard let element = owners[id]?.element else { completion(false); return }
        let environment = pressEnvironment
        actions.submit { [weak self] token in
            guard !token.isCancelled else { return }
            let ax = environment.axFrame(element)
            guard !token.isCancelled else { return }
            let window = environment.windowFrame(id)
            guard !token.isCancelled else { return }
            guard let ax, let window, MenuBarLayout.sameItem(ax, window) else {
                DispatchQueue.main.async { [weak self] in
                    guard let self, !self.stopped, !token.isCancelled else { return }
                    self.log.info("Menu bar item element no longer matches window \(id, privacy: .public)")
                    MenuBarTrace.log("press \(id): element doesn't match the window, not pressed")
                    if ItemScanner.windowsAreHosted { self.owners[id] = nil } else { self.owners[id]?.element = nil }
                    completion(false)
                    self.resolveOwners(self.snapshot()) {}
                }
                return
            }
            // AX frame reads can time out. Cancellation is checked after them,
            // immediately before the only action; stop drains any action begun.
            guard !token.isCancelled else { return }
            let result = environment.perform(element)
            let pressed = result == .success || result == .cannotComplete
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.stopped, !token.isCancelled else { return }
                completion(pressed)
            }
        }
    }

    static func owner(pid: pid_t, fallbackName: String) -> Owner {
        let app = NSRunningApplication(processIdentifier: pid)
        return Owner(pid: pid, bundleID: app?.bundleIdentifier, appName: app?.localizedName ?? fallbackName)
    }

    // MARK: Accessibility

    struct AXExtra {
        var pid: pid_t
        var frame: CGRect
        var detail: String?
        var element: AXUIElement
    }

    /// Every app's menu bar extras (AXExtrasMenuBar children), asked in parallel
    /// with a short timeout each, so a hung app costs at most that.
    static func extras(of apps: [NSRunningApplication]) -> [AXExtra] {
        let lock = NSLock()
        var out: [AXExtra] = []
        DispatchQueue.concurrentPerform(iterations: apps.count) { i in
            let pid = apps[i].processIdentifier
            let app = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(app, 0.4)
            guard let bar: AXUIElement = app.ax("AXExtrasMenuBar"),
                  let children: [AXUIElement] = bar.ax(kAXChildrenAttribute) else { return }
            var found: [AXExtra] = []
            for child in children {
                AXUIElementSetMessagingTimeout(child, 0.4)
                guard let frame = axFrame(child), frame.width > 0, frame.height > 0 else { continue }
                if let enabled: Bool = child.ax(kAXEnabledAttribute), !enabled { continue }
                let detail = [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute]
                    .lazy.compactMap { (a: String) -> String? in child.ax(a) }
                    .first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
                found.append(AXExtra(pid: pid, frame: frame, detail: detail, element: child))
            }
            lock.lock(); out += found; lock.unlock()
        }
        return out
    }

    static func axFrame(_ element: AXUIElement) -> CGRect? {
        guard let p: AXValue = element.ax(kAXPositionAttribute), let s: AXValue = element.ax(kAXSizeAttribute) else { return nil }
        var point = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(p, .cgPoint, &point), AXValueGetValue(s, .cgSize, &size) else { return nil }
        return CGRect(origin: point, size: size)
    }
}
