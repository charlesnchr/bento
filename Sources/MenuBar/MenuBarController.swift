import AppKit
import ApplicationServices
import BentoCore

/// Shows and hides sections. Arrangement is native, manual Command-drag;
/// opening an item uses only a validated Accessibility press in place.
///
/// Idle cost: nothing runs while the items are hidden except the optional
/// reveal triggers' event monitors. Timers and monitors exist only while items
/// are shown or a menu opened from a shown item is open.
final class MenuBarController {
    static let didChange = Notification.Name("BentoMenuBarDidChange")

    enum Visibility: String { case hidden, shown, shownAll }

    enum Reason { case user, hover, activation, update }

    private(set) var visibility: Visibility = .hidden
    private(set) var items: [MenuBarItem] = []
    private(set) var settings: MenuBarSettings
    /// Holds both sections open for native Command-drag until Done.
    private(set) var isArranging = false
    private(set) var lastError: String?
    /// Latched until the module stops. Never changes the saved section options
    /// or alternates widths when the notch/display/foreground app changes.
    private(set) var compactControls = false
    var effectiveShowChevron: Bool { settings.showChevron && !compactControls }

    let controls = ControlItems()
    let scanner: ItemScanner
    let triggers = RevealTriggers()
    let appMenus = AppMenuTracker()
    private(set) lazy var bar = BentoBar(controller: self)

    /// Tests inject a scanner and disable desktop integration (controls, monitors,
    /// screen queries and HUDs). Production always uses the live environment.
    struct Environment {
        var usesSystemUI = true
        var canActivate: ((MenuBarItem) -> Bool)?
        var reportError: (String) -> Void = { HUD.show($0, symbol: "exclamationmark.triangle") }
        var recoveryDisplays: (() -> [MenuBarLayout.RecoveryDisplay])?
        var applyControls: ((Visibility, ControlItems.Expansion) -> Void)?
        var configureControls: ((_ showToggle: Bool, _ alwaysHiddenSection: Bool, _ compact: Bool) -> Void)?
        /// Schedules each settling sample. Tests advance the monotonic clock
        /// before running it; they use the same readiness/deadline checks.
        var afterControlRelayout: ((@escaping () -> Void) -> Void)?
        var controlRelayoutNow: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
        var resolveControlOwners: (([MenuBarItem], @escaping () -> Void) -> Void)?
    }
    private let environment: Environment
    private var arrangementVisibility: Visibility?
    private var activationGeneration = 0
    private var started = false
    private var controlLayoutGeneration = 0
    private var controlRelayoutPending = false
    private var controlRelayoutWork: DispatchWorkItem?
    private var controlRelayoutDeadline: TimeInterval = 0
    private var controlLayoutSample: MenuBarLayout.ControlLayoutSample?
    private var controlOwnerReadPending = false
    private var rehideTimer: Timer?
    private var clickMonitor: Any?
    /// After a click on a shown item: its app, and a check for its menu.
    private var menuOwner: pid_t?
    private var menuWatch: Timer?
    private var menuWasOpen = false
    private var menuWatchStart = Date.distantPast
    private var workspaceObservers: [NSObjectProtocol] = []
    private var screenObserver: NSObjectProtocol?
    private var launchWork: [pid_t: DispatchWorkItem] = [:]
    var changeWatcher: ChangeWatcher?

    init(settings: MenuBarSettings, scanner: ItemScanner = ItemScanner(), environment: Environment = Environment()) {
        self.settings = settings
        self.scanner = scanner
        self.environment = environment
        controls.onClick = { [weak self] kind, right, option in self?.controlClicked(kind, right: right, option: option) }
        triggers.onReveal = { [weak self] all in self?.show(all: all, reason: .hover) }
        triggers.onHide = { [weak self] in self?.hide() }
        triggers.onToggle = { [weak self] in self?.toggle(all: false) }
        triggers.onHoverExit = { [weak self] in
            guard let self, self.visibility != .hidden, self.menuOwner == nil else { return }
            self.hide()
        }
        triggers.emptySpace = { [weak self] screen in self?.emptySpace(on: screen) }
    }

    // MARK: Lifecycle

    func start() {
        guard !started else { return }
        started = true
        guard environment.usesSystemUI else { readInitialLayout(); return }
        // Bento's own icon is made after the modules start; create ours after
        // it, so it keeps its place (and on a first run ends up right of ours).
        DispatchQueue.main.async { [weak self] in self?.createControls() }
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            self?.screensChanged()
        }
        let ws = NSWorkspace.shared.notificationCenter
        workspaceObservers.append(ws.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self?.appLaunched(app)
        })
        workspaceObservers.append(ws.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self?.launchWork.removeValue(forKey: app.processIdentifier)?.cancel()
            // A watched item may have gone with it (its window lingers a moment).
            guard self?.changeWatcher?.isRunning == true else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self?.syncChangeWatcher() }
        })
    }

    func stop() {
        guard started else { return }
        started = false
        controlLayoutGeneration += 1
        controlRelayoutWork?.cancel()
        controlRelayoutWork = nil
        controlRelayoutPending = false
        controlLayoutSample = nil
        controlOwnerReadPending = false
        compactControls = false
        cancelActivation()
        // Drain any AX action already begun before removing the separators.
        scanner.stop()
        isArranging = false
        arrangementVisibility = nil
        bar.close()
        stopShownState()
        triggers.stop()
        appMenus.stop()
        changeWatcher?.stop()
        changeWatcher = nil
        controls.removeAll()
        for o in workspaceObservers { NSWorkspace.shared.notificationCenter.removeObserver(o) }
        workspaceObservers = []
        if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
        screenObserver = nil
        launchWork.values.forEach { $0.cancel() }
        launchWork = [:]
        visibility = .hidden
        items = []
        notify()
    }

    private func createControls() {
        guard started else { return }
        controls.expandedLength = MenuBarController.expandedLength()
        relayoutControls()
        applyOptions()
    }

    /// One native relayout, then bounded reads until two full-row snapshots
    /// agree. Settings/display changes supersede it; show/hide only changes the
    /// target state. Never recreate items just because their animation is slow.
    private func relayoutControls() {
        controlLayoutGeneration += 1
        let generation = controlLayoutGeneration
        controlRelayoutWork?.cancel()
        controlRelayoutPending = true
        controlRelayoutDeadline = environment.controlRelayoutNow() + 2
        controlLayoutSample = nil
        controlOwnerReadPending = false
        if let configureControls = environment.configureControls {
            configureControls(effectiveShowChevron, settings.alwaysHiddenSection, compactControls)
        } else if environment.usesSystemUI {
            controls.create(showToggle: effectiveShowChevron, alwaysHiddenSection: settings.alwaysHiddenSection,
                            compact: compactControls)
            MenuBarLook.button = (controls.toggle ?? controls.hidden)?.button
        }
        // macOS 26 blanks parked item names, including separator names. Read
        // them once with sections revealed so later section checks are safe.
        // Keep the requested visibility unchanged: any manual request made
        // during this read (including Arrange) is what we apply afterwards.
        applyControlExpansion(.init(hidden: false, alwaysHidden: false))
        scheduleControlLayoutSample(generation: generation)
    }

    private func scheduleControlLayoutSample(generation: Int) {
        let sample: () -> Void = { [weak self] in self?.readControlLayoutSample(generation: generation) }
        if let afterControlRelayout = environment.afterControlRelayout { afterControlRelayout(sample) }
        else {
            let work = DispatchWorkItem { sample() }
            controlRelayoutWork = work
            let remaining = max(0, controlRelayoutDeadline - environment.controlRelayoutNow())
            DispatchQueue.main.asyncAfter(deadline: .now() + min(0.1, remaining), execute: work)
        }
    }

    private func readControlLayoutSample(generation: Int) {
        guard started, controlRelayoutPending, generation == controlLayoutGeneration else { return }
        controlRelayoutWork = nil
        items = scanner.snapshot()
        let displays = recoveryDisplays()
        let sample = MenuBarLayout.controlLayoutSample(items: items, displays: displays,
            showChevron: effectiveShowChevron, alwaysHiddenSection: settings.alwaysHiddenSection, ownPID: getpid())
        let expired = environment.controlRelayoutNow() >= controlRelayoutDeadline
        let settled = !expired && sample != nil && sample == controlLayoutSample
        controlLayoutSample = sample
        if settled || expired {
            controlRelayoutPending = false
            controlLayoutSample = nil
            controlOwnerReadPending = false
            applyVisibility(current: items, displays: displays, settled: settled)
            notify()
            return
        }
        scheduleControlLayoutSample(generation: generation)
        // Owner lookup must not hold the deadline hostage or accumulate one
        // completion per sample while an app is slow to answer Accessibility.
        guard !controlOwnerReadPending else { return }
        controlOwnerReadPending = true
        let resolved = { [weak self] in
            guard let self, self.started, self.controlRelayoutPending,
                  generation == self.controlLayoutGeneration else { return }
            self.controlOwnerReadPending = false
        }
        if let resolve = environment.resolveControlOwners { resolve(items, resolved) }
        else { scanner.resolveOwners(items, completion: resolved) }
    }

    private func readInitialLayout() {
        refresh { [weak self] in
            guard let self, self.started else { return }
            self.applyVisibility()
            self.notify()
        }
    }

    func update(settings new: MenuBarSettings) {
        let old = settings
        settings = new
        guard started else { return }
        if new.showChevron != old.showChevron || new.alwaysHiddenSection != old.alwaysHiddenSection {
            relayoutControls()
        }
        applyOptions()
        if visibility != .hidden { scheduleRehide() }
        notify()
    }

    /// Starts or stops the optional monitors to match the settings.
    private func applyOptions() {
        guard environment.usesSystemUI else { return }
        triggers.update(.init(hover: settings.revealOnHover, hoverDelay: settings.clampedHoverDelay,
                              emptyClick: settings.revealOnEmptyClick, scroll: settings.revealOnScroll))
        let needsMenus = settings.revealOnHover || settings.revealOnEmptyClick || settings.bar == .whenCrowded
        if needsMenus { appMenus.start() } else { appMenus.stop() }
        if settings.showOnChange.isEmpty {
            changeWatcher?.stop()
            changeWatcher = nil
        } else {
            if changeWatcher == nil { changeWatcher = ChangeWatcher(controller: self) }
            changeWatcher?.update(keys: Set(settings.showOnChange))
            syncChangeWatcher()
        }
    }

    func screensChanged() {
        guard started else { return }
        if environment.usesSystemUI { controls.expandedLength = MenuBarController.expandedLength() }
        relayoutControls()
        notify()
    }

    /// Long enough to push everything off the widest display (macOS 26 caps
    /// a status item near 5000 pt; a bigger window would only cost memory).
    static func expandedLength() -> CGFloat {
        let widest = NSScreen.screens.map(\.frame.width).max() ?? 2000
        return min(max(widest + 200, 1000), 5000)
    }

    // MARK: Showing and hiding

    func show(all: Bool, reason: Reason) {
        guard started, !isArranging else { return }
        if reason != .activation { cancelActivation() }
        if reason != .activation, shouldUseBar(all: all) {
            bar.show(all: all)
            return
        }
        bar.close()
        let target: Visibility = all && settings.alwaysHiddenSection ? .shownAll : .shown
        if visibility == .shownAll && target == .shown && reason == .hover { scheduleRehide(); return }
        visibility = target
        applyVisibility()
        startShownState()
        // Names and owners of items that appeared while parked.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard let self, self.started, self.visibility != .hidden else { return }
            self.items = self.scanner.snapshot()
            self.scanner.resolveOwners(self.items) { [weak self] in
                guard let self, self.started, self.visibility != .hidden else { return }
                self.items = self.scanner.snapshot()
                // Now that expanded dividers have collapsed, crowding can be
                // assessed from their actual widths without projecting positions.
                self.applyVisibility()
                self.notify()
            }
        }
        notify()
    }

    func hide() {
        guard started, !isArranging else { return }
        cancelActivation()
        bar.close()
        stopShownState()
        triggers.hoverRevealed = false
        guard visibility != .hidden else { return }
        visibility = .hidden
        applyVisibility()
        notify()
    }

    func toggle(all: Bool) {
        guard started, !isArranging else { return }
        if bar.isOpen {
            bar.close()
        } else if visibility == .hidden || (all && visibility == .shown) {
            show(all: all, reason: .user)
        } else {
            hide()
        }
    }

    private func recoveryDisplays() -> [MenuBarLayout.RecoveryDisplay] {
        environment.recoveryDisplays?() ?? (environment.usesSystemUI
            ? NSScreen.screens.map { MenuBarLayout.RecoveryDisplay(frame: $0.axFrame, statusArea: statusArea(on: $0)) } : [])
    }

    private func applyVisibility(current: [MenuBarItem]? = nil,
                                 displays: [MenuBarLayout.RecoveryDisplay]? = nil, settled: Bool = true) {
        MenuBarTrace.log("visibility \(visibility.rawValue)")
        guard !controlRelayoutPending else { return }
        let displays = displays ?? recoveryDisplays()
        let current = current ?? scanner.snapshot()
        if settled, !compactControls, MenuBarLayout.needsCompactControls(items: current, displays: displays,
                showChevron: effectiveShowChevron, alwaysHiddenSection: settings.alwaysHiddenSection, ownPID: getpid()) {
            compactControls = true
            relayoutControls()
            return
        }
        var allowed = settled ? MenuBarLayout.safeExpansion(items: current, displays: displays,
                                                  showChevron: effectiveShowChevron, ownPID: getpid())
            : .init(hidden: false, alwaysHidden: false)
        MenuBarTrace.log("[DEBUG-layout] areas=\(displays.map { "\($0.frame):\($0.statusArea)" }) allowed=\(allowed) items=\(current.map { "\($0.windowID):\($0.role):\($0.ownerPID ?? -1):\($0.frame)" })")
        allowed.alwaysHidden = allowed.alwaysHidden && settings.alwaysHiddenSection
        let expansion = ControlItems.expansion(visibility, allowed: allowed)
        let blocked = (visibility == .hidden && !allowed.hidden)
            || (visibility != .shownAll && settings.alwaysHiddenSection && !allowed.alwaysHidden)
        if blocked {
            lastError = Self.recoveryMessage
        } else if lastError == Self.recoveryMessage {
            lastError = nil
        }
        applyControlExpansion(expansion)
    }

    private func applyControlExpansion(_ expansion: ControlItems.Expansion) {
        if let applyControls = environment.applyControls { applyControls(visibility, expansion) }
        else if environment.usesSystemUI { controls.apply(visibility, expansion: expansion) }
        triggers.invalidateEmptySpace()
        syncChangeWatcher()
    }

    private static let recoveryMessage = "Some sections stay revealed because Bento cannot verify safe access to its menu. Choose Arrange in Menu Bar, then hold ⌘ and drag Bento’s icon and any chevron to the right of both separators. Keep the dashed separator left of the solid one, make room beside the notch, then click Done."

    /// Icon changes only matter while the items are hidden. Called on every
    /// layout change, so the watcher also looks again at what's hidden.
    func syncChangeWatcher() {
        changeWatcher?.setActive(started && !controlRelayoutPending && visibility == .hidden && !bar.isOpen && !isArranging)
    }

    private func controlClicked(_ kind: ControlItems.Kind, right: Bool, option: Bool) {
        if right {
            showControlMenu()
            return
        }
        switch kind {
        case .toggle:
            // Pressing the chevron took the open bar's key status and closed it.
            if !bar.isOpen, bar.closedJustNow { return }
            if option { show(all: visibility != .shownAll, reason: .user) } else { toggle(all: false) }
        case .hidden, .alwaysHidden:
            hide()
        }
    }

    private func showControlMenu() {
        let menu = NSMenu()
        let toggleTitle = visibility == .hidden ? "Show Hidden Items" : "Hide Items"
        menu.addItem(ClosureMenuItem(title: toggleTitle) { [weak self] in self?.toggle(all: false) })
        if controls.alwaysHidden != nil {
            menu.addItem(ClosureMenuItem(title: "Show All Items") { [weak self] in self?.show(all: true, reason: .user) })
        }
        menu.addItem(ClosureMenuItem(title: "Bento Bar") { [weak self] in self?.bar.show(all: false) })
        menu.addItem(ClosureMenuItem(title: "Search Menu Bar Items…") { ActionRegistry.shared.perform("menubar.search") })
        menu.addItem(.separator())
        menu.addItem(ClosureMenuItem(title: "Menu Bar Settings…") { SettingsRouter.open("menubar") })
        guard let button = (controls.toggle ?? controls.hidden)?.button else { return }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: button.bounds.maxY + 6), in: button)
    }

    // MARK: Hiding again

    private func startShownState() {
        guard environment.usesSystemUI, !isArranging else { return }
        scheduleRehide()
        if settings.rehideOnClickOutside, clickMonitor == nil {
            clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] e in
                self?.clickWhileShown(e)
            }
        }
    }

    private func stopShownState() {
        rehideTimer?.invalidate()
        rehideTimer = nil
        if let clickMonitor { NSEvent.removeMonitor(clickMonitor) }
        clickMonitor = nil
        menuWatch?.invalidate()
        menuWatch = nil
        menuOwner = nil
        menuWasOpen = false
    }

    private func scheduleRehide(after delay: TimeInterval? = nil, force: Bool = false) {
        rehideTimer?.invalidate()
        rehideTimer = nil
        guard environment.usesSystemUI, !isArranging, settings.autoRehide || force, visibility != .hidden else { return }
        let t = Timer(timeInterval: delay ?? settings.clampedRehideDelay, repeats: false) { [weak self] _ in self?.rehideTimerFired() }
        t.tolerance = 0.5
        RunLoop.main.add(t, forMode: .common)
        rehideTimer = t
    }

    private func rehideTimerFired() {
        rehideTimer = nil
        // Not while the pointer is on the menu bar, or a menu is open.
        if RevealTriggers.menuBarScreen(at: NSEvent.mouseLocation) != nil || MenuBarController.isMenuOpen(owner: menuOwner) || isArranging {
            scheduleRehide(after: 2, force: true)
            return
        }
        hide()
    }

    private func clickWhileShown(_ e: NSEvent) {
        guard started, !isArranging else { return }
        let p = NSEvent.mouseLocation
        if RevealTriggers.menuBarScreen(at: p) != nil {
            // A click on a status item: hide once its menu closes.
            let ax = NSScreen.axPoint(fromCocoa: p)
            if let item = scanner.snapshot().first(where: { $0.frame.contains(ax) }), item.role == .regular || item.role == .fixed {
                watchMenu(of: item)
            }
            return
        }
        // Inside the menu or popover of a shown item: that's using it, not leaving.
        if let pid = MenuBarController.windowOwner(at: NSScreen.axPoint(fromCocoa: p)) {
            if pid == menuOwner || pid == getpid() { return }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in self?.hide() }
    }

    /// Hides once the menu opened from a shown item closes (checked twice a
    /// second, only while that menu may be open).
    private func watchMenu(of item: MenuBarItem) {
        menuOwner = item.ownerPID ?? -1
        menuWasOpen = false
        menuWatchStart = Date()
        menuWatch?.invalidate()
        let t = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in self?.checkMenu() }
        t.tolerance = 0.2
        RunLoop.main.add(t, forMode: .common)
        menuWatch = t
    }

    private func checkMenu() {
        let open = MenuBarController.isMenuOpen(owner: menuOwner)
        if open { menuWasOpen = true; return }
        let gaveUp = !menuWasOpen && Date().timeIntervalSince(menuWatchStart) > 3
        guard menuWasOpen || gaveUp else { return }
        menuWatch?.invalidate()
        menuWatch = nil
        menuOwner = nil
        // No menu ever showed: leave it to the rehide timer.
        if menuWasOpen && settings.rehideOnClickOutside {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                guard let self, self.menuOwner == nil, self.visibility != .hidden else { return }
                // The pointer is still on the menu bar (maybe heading for
                // another item): hide once it leaves.
                if RevealTriggers.menuBarScreen(at: NSEvent.mouseLocation) != nil {
                    self.scheduleRehide(after: 2, force: true)
                } else {
                    self.hide()
                }
            }
        }
    }

    /// Whether a menu (or a status item's popover window) is on screen.
    static func isMenuOpen(owner: pid_t?) -> Bool {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return false }
        let menuLevel = Int(CGWindowLevelForKey(.popUpMenuWindow))
        let status = Int(CGWindowLevelForKey(.statusWindow))
        for w in list {
            let layer = w[kCGWindowLayer as String] as? Int ?? 0
            let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0
            if layer == menuLevel && pid != getpid() { return true }
            if let owner, owner > 0, pid == owner, layer > 0, layer != status { return true }
        }
        return false
    }

    /// The app owning the frontmost window at a point (AX coordinates).
    static func windowOwner(at p: CGPoint) -> pid_t? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        for w in list {
            var r = CGRect.zero
            if let b = w[kCGWindowBounds as String] as? NSDictionary as CFDictionary? { CGRectMakeWithDictionaryRepresentation(b, &r) }
            let alpha = (w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
            if r.contains(p), alpha > 0 { return (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value }
        }
        return nil
    }

    // MARK: Items and sections

    /// Re-reads the items (and their owners when unknown), then notifies.
    func refresh(details: Bool = false, completion: (() -> Void)? = nil) {
        guard started else { return }
        items = scanner.snapshot()
        scanner.resolveOwners(items, details: details) { [weak self] in
            guard let self, self.started else { return }
            self.items = self.scanner.snapshot()
            self.notify()
            completion?()
        }
    }

    /// The always-hidden separator is right of the hidden one. macOS puts a
    /// new item at the leftmost place that still fits, so in a full menu bar
    /// it can be created there; the user can also ⌘-drag it there. The
    /// section is then empty (`sections` ignores it) until the user
    /// Command-drags the dashed separator left of the solid separator.
    func alwaysHiddenMisplaced(_ list: [MenuBarItem]) -> Bool {
        guard let h = list.first(where: { $0.role == .control(.hidden) }),
              let a = list.first(where: { $0.role == .control(.alwaysHidden) }) else { return false }
        return a.frame.midX > h.frame.midX
    }

    /// Each item's section, by window id.
    func sections(_ list: [MenuBarItem]? = nil) -> [CGWindowID: MenuBarSection] {
        let list = list ?? items
        let h = list.first { $0.role == .control(.hidden) }?.layoutItem
        let a = list.first { $0.role == .control(.alwaysHidden) }?.layoutItem
        var out: [CGWindowID: MenuBarSection] = [:]
        for item in list {
            out[item.windowID] = MenuBarLayout.section(ofMidX: item.frame.midX, hiddenSeparator: h, alwaysHiddenSeparator: a)
        }
        return out
    }

    /// The items in each section, left to right (control items left out).
    func arrangement(_ list: [MenuBarItem]? = nil) -> [MenuBarSection: [MenuBarItem]] {
        let list = list ?? items
        let s = sections(list)
        var out: [MenuBarSection: [MenuBarItem]] = [.visible: [], .hidden: [], .alwaysHidden: []]
        for item in list {
            if case .control = item.role { continue }
            out[s[item.windowID] ?? .visible, default: []].append(item)
        }
        return out
    }

    func item(forKey key: String) -> MenuBarItem? { items.first { $0.key == key } }

    /// Items that should be visible but don't fit (behind the notch or off-screen).
    func overflowItems(_ list: [MenuBarItem]? = nil) -> [MenuBarItem] {
        let items = list ?? self.items
        guard environment.usesSystemUI, let screen = menuBarScreen() else { return [] }
        let area = statusArea(on: screen)
        let s = sections(items)
        let shown: Set<String> = Set(items.filter {
            guard $0.isMovable || $0.role == .fixed else { return false }
            switch s[$0.windowID] ?? .visible {
            case .visible: return true
            case .hidden: return visibility != .hidden
            case .alwaysHidden: return visibility == .shownAll
            }
        }.map(\.key))
        let lost = Set(MenuBarLayout.overflow(items.map(\.layoutItem), shown: shown, area: area))
        return items.filter { lost.contains($0.key) }
    }

    /// The display whose menu bar shows the items.
    func menuBarScreen() -> NSScreen? {
        if let frame = (controls.toggle ?? controls.hidden)?.button?.window?.frame, frame.width > 0, frame.width < 1000 {
            return NSScreen.screens.first { $0.frame.intersects(frame) } ?? NSScreen.screens.first
        }
        return NSScreen.screens.first
    }

    func statusArea(on screen: NSScreen) -> ClosedRange<CGFloat> {
        let f = screen.frame
        var notch: ClosedRange<CGFloat>?
        if screen.safeAreaInsets.top > 0, let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea, left.maxX < right.minX {
            notch = left.maxX...right.minX
        }
        let menuMaxX = appMenus.appMenuMaxX.flatMap { $0 > f.minX && $0 < f.maxX ? $0 : nil }
        return MenuBarLayout.statusArea(screenMinX: f.minX, screenMaxX: f.maxX, notch: notch, appMenuMaxX: menuMaxX)
    }

    /// Empty menu bar space on a screen: from the app menus to the leftmost status item.
    private func emptySpace(on screen: NSScreen) -> ClosedRange<CGFloat>? {
        let area = statusArea(on: screen)
        let f = screen.axFrame
        let onScreen = scanner.snapshot().filter { f.contains(CGPoint(x: $0.frame.midX, y: $0.frame.midY)) && $0.frame.width < 1000 }
        guard let leftmost = onScreen.map(\.frame.minX).min() else { return nil }
        let lower = area.lowerBound + 4
        return lower < leftmost - 4 ? lower...(leftmost - 4) : nil
    }

    /// Whether shown items would go into the Bento Bar rather than the menu bar.
    func shouldUseBar(all: Bool) -> Bool {
        guard environment.usesSystemUI, !isArranging else { return false }
        switch settings.bar {
        case .never: return false
        case .always: return true
        case .whenCrowded:
            guard let screen = menuBarScreen() else { return false }
            let current = scanner.snapshot()
            let s = sections(current)
            let area = statusArea(on: screen)
            let shown = current.filter { item in
                switch item.role {
                case .control: return true
                default:
                    switch s[item.windowID] ?? .visible {
                    case .visible: return true
                    case .hidden: return true
                    case .alwaysHidden: return all
                    }
                }
            }
            // Expanded separators count at their collapsed width.
            let widths = shown.map { item -> LayoutItem in
                var l = item.layoutItem
                if case .control = item.role, l.width > 200 {
                    l.width = compactControls ? ControlItems.compactDividerLength : 26
                }
                return l
            }
            let need = MenuBarLayout.shortfall(widths, shown: Set(widths.map(\.key)), available: area.upperBound - area.lowerBound)
            return need > 0
        }
    }

    // MARK: Manual arrangement

    func beginArrangement() {
        guard started, !isArranging else { return }
        cancelActivation()
        arrangementVisibility = visibility
        isArranging = true
        lastError = nil
        bar.close()
        stopShownState()
        visibility = .shownAll
        applyVisibility()
        refresh()
        notify()
    }

    func finishArrangement() {
        guard started, isArranging else { return }
        isArranging = false
        visibility = arrangementVisibility ?? .hidden
        arrangementVisibility = nil
        applyVisibility()
        if visibility != .hidden { startShownState() }
        refresh(details: true)
        notify()
    }

    /// Refresh watched items when an app launches; macOS owns their positions.
    private func appLaunched(_ app: NSRunningApplication) {
        guard changeWatcher != nil, app.activationPolicy != .prohibited else { return }
        let pid = app.processIdentifier
        launchWork[pid]?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.started else { return }
            self.launchWork.removeValue(forKey: pid)
            // Its items need owners before they can be matched to the picked keys.
            if self.changeWatcher != nil { self.refresh { [weak self] in self?.syncChangeWatcher() } }
        }
        launchWork[pid] = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: work)
    }

    // MARK: Opening items in place

    private func cancelActivation() {
        activationGeneration += 1
        scanner.cancelPresses()
    }

    /// Reveal the section, allow its geometry to settle once, then validate
    /// and AXPress. An unavailable item stays where macOS put it.
    func activate(_ item: MenuBarItem) {
        guard started, !isArranging else { return }
        cancelActivation()
        let generation = activationGeneration
        lastError = nil
        items = scanner.snapshot()
        guard let live = currentItem(matching: item) else { unavailable(item); return }
        bar.close()
        let section = sections()[live.windowID] ?? .visible
        if section != .visible { show(all: section == .alwaysHidden, reason: .activation) }
        let open = { [weak self] in
            guard let self, self.started, generation == self.activationGeneration else { return }
            self.refresh(details: true) { [weak self] in
                guard let self, self.started, generation == self.activationGeneration else { return }
                guard let current = self.currentItem(matching: live), self.canActivateInPlace(current) else {
                    self.unavailable(live)
                    return
                }
                self.scanner.press(current) { [weak self] pressed in
                    guard let self, self.started, generation == self.activationGeneration else { return }
                    if pressed {
                        if self.environment.usesSystemUI, self.visibility != .hidden { self.watchMenu(of: current) }
                    } else {
                        self.unavailable(current)
                    }
                }
            }
        }
        if environment.usesSystemUI {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: open)
        } else {
            open()
        }
    }

    private func currentItem(matching item: MenuBarItem) -> MenuBarItem? {
        items.first {
            $0.windowID == item.windowID && (!item.hasStableKey || $0.key == item.key)
                && (item.ownerPID == nil || $0.ownerPID == item.ownerPID)
        }
    }

    private func canActivateInPlace(_ item: MenuBarItem) -> Bool {
        if let canActivate = environment.canActivate { return canActivate(item) }
        guard environment.usesSystemUI else { return false }
        return item.isOnScreen && !overflowItems().contains { $0.windowID == item.windowID }
    }

    private func unavailable(_ item: MenuBarItem) {
        let message = "Couldn’t open “\(item.name)”. Click it in the menu bar, or use Arrange in Menu Bar to reposition it manually. Items behind the notch may need more space."
        lastError = message
        environment.reportError(message)
        notify()
    }

    func activate(key: String) {
        guard started, !isArranging else { return }
        cancelActivation()
        let generation = activationGeneration
        refresh { [weak self] in
            guard let self, self.started, generation == self.activationGeneration else { return }
            guard let item = self.item(forKey: key) else {
                let message = "Menu bar item not found. Open its app and arrange its item manually."
                self.lastError = message
                self.environment.reportError(message)
                self.notify()
                return
            }
            self.activate(item)
        }
    }

    /// A watched hidden item changed its icon: show it for a few seconds.
    func showForChange(_ item: MenuBarItem) {
        guard started, visibility == .hidden, !bar.isOpen, !isArranging else { return }
        let section = sections()[item.windowID] ?? .hidden
        let duration = settings.clampedShowOnChangeDuration
        if shouldUseBar(all: section == .alwaysHidden) {
            bar.show(all: section == .alwaysHidden, closingAfter: duration)
            return
        }
        show(all: section == .alwaysHidden, reason: .update)
        scheduleRehide(after: duration, force: true)
    }

    // MARK: Misc

    func notify() {
        NotificationCenter.default.post(name: MenuBarController.didChange, object: self)
    }

    func diagnostics() -> [String: Any] {
        let items = scanner.snapshot()
        let s = sections(items)
        return [
            "started": started,
            "visibility": visibility.rawValue,
            "compactControls": compactControls,
            "controlRelayoutPending": controlRelayoutPending,
            "controls": ["toggle": controls.toggle != nil, "hidden": controls.hidden != nil, "alwaysHidden": controls.alwaysHidden != nil,
                         "hiddenExpanded": controls.hiddenExpanded, "alwaysHiddenExpanded": controls.alwaysHiddenExpanded,
                         "expandedLength": Double(controls.expandedLength)],
            "items": items.map { ["key": $0.key, "name": $0.name, "section": (s[$0.windowID] ?? .visible).rawValue,
                                  "x": Double($0.frame.minX), "width": Double($0.frame.width), "window": Int($0.windowID),
                                  "windowOnScreen": $0.windowIsOnScreen.map { $0 as Any } ?? NSNull(),
                                  "role": "\($0.role)"] },
            "arranging": isArranging,
            "overflow": overflowItems(items).map(\.key),
            "wouldUseBar": shouldUseBar(all: false),
            "barOpen": bar.isOpen,
            "bar": bar.diagnostics,
            "triggers": triggers.isActive,
            "appMenuTracker": appMenus.isRunning,
            "rehideTimer": rehideTimer != nil,
            "pointerOnMenuBar": RevealTriggers.menuBarScreen(at: NSEvent.mouseLocation) != nil,
            "menuOpen": MenuBarController.isMenuOpen(owner: menuOwner),
            "clickMonitor": clickMonitor != nil,
            "menuWatch": menuWatch != nil,
            "changeWatcher": changeWatcher?.isRunning ?? false,
            "privateWindowList": WindowServer.usesPrivateList,
            "hostedWindows": ItemScanner.windowsAreHosted,
            "alwaysHiddenMisplaced": alwaysHiddenMisplaced(items),
            "lastError": lastError ?? "",
        ]
    }
}
