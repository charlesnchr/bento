import AppKit
import ApplicationServices
import BentoCore

/// Runs the sections: shows and hides them, hides them again, reads the
/// items, moves them between sections and clicks them on request.
///
/// Idle cost: nothing runs while the items are hidden except the optional
/// reveal triggers' event monitors. Timers and monitors exist only while items
/// are shown or a menu opened from a shown item is open.
final class MenuBarController {
    static let didChange = Notification.Name("BentoMenuBarDidChange")

    enum Visibility: String { case hidden, shown, shownAll }

    enum Reason { case user, hover, activation, arranging, update }

    private(set) var visibility: Visibility = .hidden
    private(set) var items: [MenuBarItem] = []
    private(set) var settings: MenuBarSettings
    /// Set while items are being arranged (moves in flight).
    private(set) var isArranging = false
    private(set) var lastError: String?

    let controls = ControlItems()
    let scanner = ItemScanner()
    let mover = ItemMover()
    let triggers = RevealTriggers()
    let appMenus = AppMenuTracker()
    private(set) lazy var bar = BentoBar(controller: self)

    private let log = BentoLog.make("menubar")
    private var started = false
    private var rehideTimer: Timer?
    private var clickMonitor: Any?
    /// After a click on a shown item: its app, and a check for its menu.
    private var menuOwner: pid_t?
    private var menuWatch: Timer?
    private var menuWasOpen = false
    private var menuWatchStart = Date.distantPast
    /// Items moved into view for a click, to put back afterwards: window → where it was.
    private var temporarilyShown: [CGWindowID: ItemMover.Request] = [:]
    private var workspaceObservers: [NSObjectProtocol] = []
    private var screenObserver: NSObjectProtocol?
    private var launchWork: [pid_t: DispatchWorkItem] = [:]
    private(set) var changeWatcher: ChangeWatcher?
    var onSettingsChange: (MenuBarSettings) -> Void = { _ in }

    init(settings: MenuBarSettings) {
        self.settings = settings
        controls.onClick = { [weak self] kind, right, option in self?.controlClicked(kind, right: right, option: option) }
        triggers.onReveal = { [weak self] all in self?.show(all: all, reason: .hover) }
        triggers.onHide = { [weak self] in self?.hide() }
        triggers.onToggle = { [weak self] in self?.toggle(all: false) }
        triggers.onHoverExit = { [weak self] in
            guard let self, self.visibility != .hidden, self.menuOwner == nil else { return }
            self.hide()
        }
        triggers.emptySpace = { [weak self] screen in self?.emptySpace(on: screen) }
        triggers.isPostingEvents = { [weak self] in self?.mover.isBusy ?? false }
    }

    // MARK: Lifecycle

    func start() {
        guard !started else { return }
        started = true
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
        })
    }

    func stop() {
        guard started else { return }
        started = false
        putBackTemporarilyShown()
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
    }

    private func createControls() {
        guard started else { return }
        controls.expandedLength = MenuBarController.expandedLength()
        controls.create(showToggle: settings.showChevron, alwaysHiddenSection: settings.alwaysHiddenSection)
        controls.apply(showHidden: true, showAlwaysHidden: true)
        MenuBarLook.button = (controls.toggle ?? controls.hidden)?.button
        visibility = .shownAll
        // Everything is on screen right now: learn item names and owners
        // (macOS 26 blanks names while parked), then hide.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            guard let self, self.started else { return }
            self.items = self.scanner.snapshot()
            var hid = false
            let hideOnce = { [weak self] in
                guard let self, !hid, self.started else { return }
                hid = true
                self.items = self.scanner.snapshot()
                self.hide()
            }
            self.scanner.resolveOwners(self.items) { hideOnce() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: hideOnce)
        }
        applyOptions()
    }

    func update(settings new: MenuBarSettings) {
        let old = settings
        settings = new
        guard started else { return }
        if new.showChevron != old.showChevron || new.alwaysHiddenSection != old.alwaysHiddenSection {
            controls.create(showToggle: new.showChevron, alwaysHiddenSection: new.alwaysHiddenSection)
            applyVisibility()
        }
        applyOptions()
        if visibility != .hidden { scheduleRehide() }
    }

    /// Starts or stops the optional monitors to match the settings.
    private func applyOptions() {
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
        }
    }

    private func screensChanged() {
        let length = MenuBarController.expandedLength()
        if length != controls.expandedLength {
            controls.expandedLength = length
            applyVisibility()
        }
    }

    /// Long enough to push everything off the widest display (macOS 26 caps
    /// a status item near 5000 pt; a bigger window would only cost memory).
    static func expandedLength() -> CGFloat {
        let widest = NSScreen.screens.map(\.frame.width).max() ?? 2000
        return min(max(widest + 200, 1000), 5000)
    }

    // MARK: Showing and hiding

    func show(all: Bool, reason: Reason) {
        guard started, controls.hidden != nil else { return }
        if reason != .arranging, reason != .activation, shouldUseBar(all: all) {
            bar.show(all: all)
            return
        }
        bar.close()
        let target: Visibility = all && controls.alwaysHidden != nil ? .shownAll : .shown
        if visibility == .shownAll && target == .shown && reason == .hover { scheduleRehide(); return }
        visibility = target
        applyVisibility()
        if reason == .arranging {
            stopShownState()
        } else {
            startShownState()
        }
        // Names and owners of items that appeared while parked.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard let self, self.visibility != .hidden else { return }
            self.items = self.scanner.snapshot()
            self.scanner.resolveOwners(self.items) { [weak self] in
                guard let self, self.visibility != .hidden else { return }
                self.items = self.scanner.snapshot()
                self.notify()
            }
        }
        notify()
    }

    func hide() {
        guard started else { return }
        bar.close()
        putBackTemporarilyShown()
        stopShownState()
        triggers.hoverRevealed = false
        guard visibility != .hidden else { return }
        if !isArranging { learnLayout() }
        visibility = .hidden
        applyVisibility()
        notify()
    }

    func toggle(all: Bool) {
        if bar.isOpen {
            bar.close()
        } else if visibility == .hidden || (all && visibility == .shown) {
            show(all: all, reason: .user)
        } else {
            hide()
        }
    }

    private func applyVisibility() {
        controls.apply(showHidden: visibility != .hidden, showAlwaysHidden: visibility == .shownAll)
    }

    private func controlClicked(_ kind: ControlItems.Kind, right: Bool, option: Bool) {
        if right {
            showControlMenu()
            return
        }
        switch kind {
        case .toggle:
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
        guard settings.autoRehide || force, visibility != .hidden || !temporarilyShown.isEmpty else { return }
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
        guard !mover.isBusy, e.cgEvent?.getIntegerValueField(.eventSourceUserData) != ItemMover.eventMarker else { return }
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
        if menuWasOpen && (settings.rehideOnClickOutside || !temporarilyShown.isEmpty) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                guard let self, self.menuOwner == nil, RevealTriggers.menuBarScreen(at: NSEvent.mouseLocation) == nil else { return }
                self.hide()
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
        items = scanner.snapshot()
        scanner.resolveOwners(items, details: details) { [weak self] in
            guard let self else { return }
            self.items = self.scanner.snapshot()
            self.notify()
            completion?()
        }
    }

    var hiddenSeparator: MenuBarItem? { items.first { $0.role == .control(.hidden) } }
    var alwaysHiddenSeparator: MenuBarItem? { items.first { $0.role == .control(.alwaysHidden) } }

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
    func overflowItems() -> [MenuBarItem] {
        guard let screen = menuBarScreen() else { return [] }
        let area = statusArea(on: screen)
        let s = sections()
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
                if case .control = item.role, l.width > 200 { l.width = 26 }
                return l
            }
            let need = MenuBarLayout.shortfall(widths, shown: Set(widths.map(\.key)), available: area.upperBound - area.lowerBound)
            return need > 0
        }
    }

    // MARK: Arranging

    /// Moves items so the sections match `target` (window ids per section,
    /// left to right; every item listed once). Shows everything while
    /// moving, then goes back to the previous state.
    func arrange(_ target: [MenuBarSection: [CGWindowID]], completion: @escaping (Result<Void, ItemMover.Failure>) -> Void) {
        guard !isArranging else { completion(.failure(.userBusy)); return }
        isArranging = true
        let previous = visibility
        bar.close()
        show(all: true, reason: .arranging)
        notify()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
            guard let self else { return }
            let current = self.scanner.snapshot()
            self.items = current
            let requests = self.plan(current: current, target: target)
            self.log.info("Arranging menu bar: \(requests.count) move(s)")
            self.mover.move(requests) { [weak self] result in
                guard let self else { return }
                self.items = self.scanner.snapshot()
                self.isArranging = false
                if case .failure(let f) = result { self.lastError = f.description } else { self.lastError = nil }
                self.learnLayout()
                if previous == .hidden { self.hide() } else { self.visibility = previous; self.applyVisibility(); self.startShownState() }
                self.notify()
                completion(result)
            }
        }
    }

    /// Mover requests turning the current order into the target.
    func plan(current: [MenuBarItem], target: [MenuBarSection: [CGWindowID]]) -> [ItemMover.Request] {
        let byID = Dictionary(current.map { ($0.windowID, $0) }, uniquingKeysWith: { a, _ in a })
        guard let h = current.first(where: { $0.role == .control(.hidden) }) else { return [] }
        let a = current.first { $0.role == .control(.alwaysHidden) }
        // Items in the target that still exist; everything else stays put.
        var arrangement: [MenuBarSection: [String]] = [:]
        for (section, ids) in target { arrangement[section] = ids.filter { byID[$0] != nil }.map { String($0) } }
        if a == nil {
            arrangement[.hidden] = (arrangement[.alwaysHidden] ?? []) + (arrangement[.hidden] ?? [])
            arrangement[.alwaysHidden] = []
        }
        let targetOrder = MenuBarLayout.targetOrder(arrangement, hiddenSeparator: String(h.windowID),
                                                    alwaysHiddenSeparator: a.map { String($0.windowID) })
        let currentOrder = current.map { String($0.windowID) }
        let anchors = Set(current.filter { !$0.isMovable }.map { String($0.windowID) })
        let moves = MenuBarLayout.planMoves(current: currentOrder, target: targetOrder, anchors: anchors)
        let zeroWidth = Set(current.filter { $0.frame.width < 1 }.map(\.windowID))
        return moves.compactMap { m in
            guard let item = CGWindowID(m.key), let t = CGWindowID(m.destination.target) else { return nil }
            switch m.destination {
            case .leftOf: return ItemMover.Request(item: item, target: t, side: .left, ignoring: zeroWidth)
            case .rightOf: return ItemMover.Request(item: item, target: t, side: .right, ignoring: zeroWidth)
            }
        }
    }

    /// Moves one item into a section, before `beforeID` (nil: at the right end).
    func move(_ item: MenuBarItem, to section: MenuBarSection, before beforeID: CGWindowID? = nil,
              completion: @escaping (Result<Void, ItemMover.Failure>) -> Void) {
        var target = arrangement().mapValues { $0.map(\.windowID) }
        for s in MenuBarSection.allCases { target[s]?.removeAll { $0 == item.windowID } }
        var list = target[section] ?? []
        if let beforeID, let i = list.firstIndex(of: beforeID) { list.insert(item.windowID, at: i) } else { list.append(item.windowID) }
        target[section] = list
        arrange(target, completion: completion)
    }

    /// Arranges the items to match a saved layout (a profile, or the
    /// remembered places). Items it doesn't mention stay in their section.
    func apply(_ layout: SavedLayout, completion: @escaping (Result<Void, ItemMover.Failure>) -> Void) {
        let current = arrangement()
        let all = MenuBarSection.allCases.flatMap { current[$0] ?? [] }
        let byKey = Dictionary(all.filter(\.hasStableKey).map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
        var target: [MenuBarSection: [CGWindowID]] = [:]
        var placed = Set<CGWindowID>()
        for s in MenuBarSection.allCases {
            let wanted = layout[s].compactMap { byKey[$0] }.filter { $0.isMovable && $0.role != .bentoIcon }
            target[s] = wanted.map(\.windowID)
            placed.formUnion(target[s] ?? [])
        }
        // Unmentioned items keep their section, interleaved by current order.
        for s in MenuBarSection.allCases {
            let others = (current[s] ?? []).filter { !placed.contains($0.windowID) }
            target[s] = MenuBarController.interleave(keep: others.map(\.windowID), into: target[s] ?? [],
                                                     order: (current[s] ?? []).map(\.windowID))
        }
        arrange(target, completion: completion)
    }

    /// Puts `keep` back among `placed` near where they were in `order`.
    static func interleave(keep: [CGWindowID], into placed: [CGWindowID], order: [CGWindowID]) -> [CGWindowID] {
        var out = placed
        for id in keep {
            guard let i = order.firstIndex(of: id) else { out.append(id); continue }
            // After the nearest item before it (in the old order) that is in `out`.
            let before = order[..<i].reversed().first { out.contains($0) }
            if let before, let j = out.firstIndex(of: before) { out.insert(id, at: j + 1) } else { out.insert(id, at: 0) }
        }
        return out
    }

    /// Remembers where items are now (for putting them back after a relaunch).
    func learnLayout() {
        let current = scanner.snapshot()
        let now = Date()
        // Items of apps that just started may not be in their place yet.
        let settled = current.filter { item in
            guard item.hasStableKey, item.isMovable, item.role != .bentoIcon, let pid = item.ownerPID else { return false }
            let launched = NSRunningApplication(processIdentifier: pid)?.launchDate ?? .distantPast
            return now.timeIntervalSince(launched) > 15
        }
        let s = sections(current)
        var groups: [MenuBarSection: [String]] = [:]
        for item in settled { groups[s[item.windowID] ?? .visible, default: []].append(item.key) }
        let layout = settings.layout.updated(with: groups)
        guard layout != settings.layout else { return }
        var new = settings
        new.layout = layout
        settings = new
        onSettingsChange(new)
    }

    /// An app started: once its items appear, put them back where they were.
    private func appLaunched(_ app: NSRunningApplication) {
        guard settings.keepItemsInPlace, app.activationPolicy != .prohibited else { return }
        let pid = app.processIdentifier
        launchWork[pid]?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.started else { return }
            self.launchWork.removeValue(forKey: pid)
            self.restorePlaces(of: pid, attempt: 0)
        }
        launchWork[pid] = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: work)
    }

    private func restorePlaces(of pid: pid_t, attempt: Int) {
        guard !isArranging, !mover.isBusy else {
            if attempt < 5 { DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.restorePlaces(of: pid, attempt: attempt + 1) } }
            return
        }
        refresh { [weak self] in
            guard let self else { return }
            let current = self.arrangement()
            var target = current.mapValues { $0.map { String($0.windowID) } }
            var misplaced = 0
            for (section, list) in current {
                for item in list where item.ownerPID == pid && item.hasStableKey && item.isMovable && item.role != .bentoIcon {
                    // Items never seen before go to the visible section: macOS
                    // puts a new item at the far left, which would hide it.
                    let want = self.settings.layout.section(of: item.key) ?? .visible
                    guard want != section, want != .alwaysHidden || self.controls.alwaysHidden != nil else { continue }
                    misplaced += 1
                    let id = String(item.windowID)
                    target[section]?.removeAll { $0 == id }
                    // Remembered order, in window ids of the items present now.
                    let ids = Dictionary(self.items.map { ($0.key, String($0.windowID)) }, uniquingKeysWith: { a, _ in a })
                    let remembered = self.settings.layout[want].compactMap { ids[$0] }
                    target[want] = MenuBarLayout.inserting(id, into: target[want] ?? [], remembered: remembered)
                }
            }
            guard misplaced > 0 else { return }
            self.log.info("Putting \(misplaced) item(s) of pid \(pid) back in their sections")
            self.arrange(target.mapValues { $0.compactMap { CGWindowID($0) } }) { _ in }
        }
    }

    // MARK: Clicking items

    /// Opens an item's menu: shows it in place if needed, clicks it, and
    /// hides it again once the menu closes.
    func activate(_ item: MenuBarItem, right: Bool = false) {
        guard started else { return }
        items = scanner.snapshot()
        guard let live = items.first(where: { $0.windowID == item.windowID }) ?? items.first(where: { $0.key == item.key && item.hasStableKey }) else {
            HUD.show("“\(item.name)” isn’t in the menu bar", symbol: "menubar.rectangle")
            return
        }
        let section = sections()[live.windowID] ?? .visible
        let overflow = overflowItems().contains { $0.windowID == live.windowID }
        if live.isOnScreen && !overflow {
            click(live, right: right)
            return
        }
        bar.close()
        // Shown in place when everything fits, else moved into view for the click.
        if section != .visible, !shouldUseBar(all: section == .alwaysHidden) {
            show(all: section == .alwaysHidden, reason: .activation)
            waitUntilOnScreen(live.windowID, tries: 25) { [weak self] onScreen in
                guard let self else { return }
                if onScreen { self.click(live, right: right) } else { self.temporarilyShow(live, right: right) }
            }
        } else {
            temporarilyShow(live, right: right)
        }
    }

    func activate(key: String) {
        refresh { [weak self] in
            guard let self else { return }
            guard let item = self.item(forKey: key) else {
                HUD.show("Menu bar item not found", symbol: "menubar.rectangle")
                return
            }
            self.activate(item)
        }
    }

    private func waitUntilOnScreen(_ id: CGWindowID, tries: Int, _ done: @escaping (Bool) -> Void) {
        if let f = WindowServer.frame(of: id), ItemMover.onScreen(f), f.minX >= (menuBarScreen().map { statusArea(on: $0).lowerBound } ?? 0) - 1 {
            // Let it settle one more frame.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { done(true) }
            return
        }
        guard tries > 0 else { done(false); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.02) { [weak self] in self?.waitUntilOnScreen(id, tries: tries - 1, done) }
    }

    private func click(_ item: MenuBarItem, right: Bool) {
        if visibility != .hidden || !temporarilyShown.isEmpty { watchMenu(of: item) }
        // AXPress opens the menu without moving the pointer.
        if !right, let element = scanner.element(for: item), AXUIElementPerformAction(element, kAXPressAction as CFString) == .success {
            return
        }
        mover.click(item.windowID, right: right) { [weak self] result in
            if case .failure(let f) = result {
                self?.log.error("Clicking \(item.key, privacy: .public) failed: \(f.description, privacy: .public)")
                HUD.show(f.description, symbol: "exclamationmark.triangle")
            }
        }
    }

    /// Moves a parked item into the visible part of the menu bar, clicks it,
    /// and puts it back once its menu closes.
    private func temporarilyShow(_ item: MenuBarItem, right: Bool) {
        items = scanner.snapshot()
        guard let screen = menuBarScreen() else { return }
        let area = statusArea(on: screen)
        let order = items
        guard let index = order.firstIndex(where: { $0.windowID == item.windowID }) else { return }
        // Where it goes back to: left of its right neighbour, or right of its left one.
        let back: ItemMover.Request
        if index + 1 < order.count {
            back = ItemMover.Request(item: item.windowID, target: order[index + 1].windowID, side: .left)
        } else if index > 0 {
            back = ItemMover.Request(item: item.windowID, target: order[index - 1].windowID, side: .right)
        } else { return }
        // Into view: left of the leftmost visible item that leaves room for it.
        guard let target = order.first(where: { $0.isOnScreen && $0.frame.minX - item.frame.width >= area.lowerBound + 2 && $0.frame.width < 1000 }) else {
            pressInPlace(item)
            return
        }
        mover.move([ItemMover.Request(item: item.windowID, target: target.windowID, side: .left)]) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                self.temporarilyShown[item.windowID] = back
                self.waitUntilOnScreen(item.windowID, tries: 15) { _ in
                    self.click(item, right: right)
                    self.scheduleRehide()
                }
            case .failure:
                self.pressInPlace(item)
            }
        }
    }

    /// Last resort: press it where it is (its menu may open at the screen edge).
    private func pressInPlace(_ item: MenuBarItem) {
        if let element = scanner.element(for: item), AXUIElementPerformAction(element, kAXPressAction as CFString) == .success { return }
        HUD.show("Can’t reach “\(item.name)”: the menu bar is full", symbol: "menubar.rectangle")
    }

    private func putBackTemporarilyShown() {
        guard !temporarilyShown.isEmpty else { return }
        let requests = Array(temporarilyShown.values)
        temporarilyShown = [:]
        mover.move(requests) { [weak self] result in
            if case .failure(let f) = result { self?.log.error("Putting an item back failed: \(f.description, privacy: .public)") }
            self?.items = self?.scanner.snapshot() ?? []
            self?.notify()
        }
    }

    /// A watched hidden item changed its icon: show it for a few seconds.
    func showForChange(_ item: MenuBarItem) {
        guard started, visibility == .hidden, !bar.isOpen, !isArranging, !mover.isBusy else { return }
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
        let s = sections()
        return [
            "started": started,
            "visibility": visibility.rawValue,
            "controls": ["toggle": controls.toggle != nil, "hidden": controls.hidden != nil, "alwaysHidden": controls.alwaysHidden != nil,
                         "hiddenExpanded": controls.hiddenExpanded, "alwaysHiddenExpanded": controls.alwaysHiddenExpanded,
                         "expandedLength": Double(controls.expandedLength)],
            "items": items.map { ["key": $0.key, "name": $0.name, "section": (s[$0.windowID] ?? .visible).rawValue,
                                  "x": Double($0.frame.minX), "width": Double($0.frame.width), "window": Int($0.windowID),
                                  "role": "\($0.role)"] },
            "arranging": isArranging,
            "barOpen": bar.isOpen,
            "triggers": triggers.isActive,
            "appMenuTracker": appMenus.isRunning,
            "rehideTimer": rehideTimer != nil,
            "clickMonitor": clickMonitor != nil,
            "menuWatch": menuWatch != nil,
            "temporarilyShown": temporarilyShown.count,
            "changeWatcher": changeWatcher?.isRunning ?? false,
            "privateWindowList": WindowServer.usesPrivateList,
            "hostedWindows": ItemScanner.windowsAreHosted,
            "lastError": lastError ?? "",
        ]
    }
}
