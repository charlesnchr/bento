import AppKit
import BentoCore

/// Optional ways to show the hidden items with the mouse: resting the pointer
/// on an empty part of the menu bar, clicking there, or scrolling on it.
///
/// Each uses a global event monitor that exists only while its option is on.
/// Pointer moves outside the menu bar cost one comparison.
final class RevealTriggers {
    struct Options: Equatable {
        var hover = false
        var hoverDelay: TimeInterval = 0.3
        var emptyClick = false
        var scroll = false
    }

    var onReveal: (_ all: Bool) -> Void = { _ in }
    var onHide: () -> Void = {}
    var onToggle: () -> Void = {}
    /// Pointer left the menu bar for a while after a hover reveal.
    var onHoverExit: () -> Void = {}
    /// The x range (global coordinates) of empty menu bar space on a screen,
    /// between the app menus and the status items. Nil when unknown.
    var emptySpace: (_ screen: NSScreen) -> ClosedRange<CGFloat>? = { _ in nil }
    var isPostingEvents: () -> Bool = { false }

    private var options = Options()
    private var moveMonitor: Any?
    private var clickMonitor: Any?
    private var scrollMonitor: Any?
    private var hoverWork: DispatchWorkItem?
    private var exitWork: DispatchWorkItem?
    private var lastScroll: Date = .distantPast
    /// Set after a hover reveal until the pointer leaves the menu bar.
    var hoverRevealed = false

    func update(_ new: Options) {
        guard new != options || (moveMonitor == nil && new.hover) else { return }
        options = new
        stop()
        if options.hover {
            moveMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved]) { [weak self] e in self?.moved(e) }
        }
        if options.emptyClick {
            clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown]) { [weak self] e in self?.clicked(e) }
        }
        if options.scroll {
            scrollMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.scrollWheel]) { [weak self] e in self?.scrolled(e) }
        }
    }

    func stop() {
        for m in [moveMonitor, clickMonitor, scrollMonitor].compactMap({ $0 }) { NSEvent.removeMonitor(m) }
        moveMonitor = nil
        clickMonitor = nil
        scrollMonitor = nil
        hoverWork?.cancel()
        exitWork?.cancel()
    }

    var isActive: Bool { moveMonitor != nil || clickMonitor != nil || scrollMonitor != nil }

    /// The screen whose menu bar the pointer is on, if any.
    static func menuBarScreen(at p: NSPoint) -> NSScreen? {
        NSScreen.screens.first { s in
            let height = max(NSStatusBar.system.thickness, s.frame.maxY - s.visibleFrame.maxY)
            return p.x >= s.frame.minX && p.x < s.frame.maxX && p.y <= s.frame.maxY && p.y >= s.frame.maxY - max(height, 22)
        }
    }

    /// Empty space per screen, read once per visit of the pointer to the
    /// menu bar (it reads the window list) and dropped when it leaves.
    private var emptySpaceCache: (screen: CGDirectDisplayID, range: ClosedRange<CGFloat>?, at: Date)?

    private func inEmptySpace(_ p: NSPoint) -> Bool {
        guard let screen = RevealTriggers.menuBarScreen(at: p) else { emptySpaceCache = nil; return false }
        let range: ClosedRange<CGFloat>?
        if let c = emptySpaceCache, c.screen == screen.displayID, Date().timeIntervalSince(c.at) < 2 {
            range = c.range
        } else {
            range = emptySpace(screen)
            emptySpaceCache = (screen.displayID, range, Date())
        }
        return range?.contains(p.x) ?? false
    }

    /// The items moved (shown, hidden, arranged): read the empty space again.
    func invalidateEmptySpace() { emptySpaceCache = nil }

    private func moved(_ e: NSEvent) {
        guard !isPostingEvents() else { return }
        let p = NSEvent.mouseLocation
        let onBar = RevealTriggers.menuBarScreen(at: p) != nil
        if hoverRevealed {
            if onBar { exitWork?.cancel(); exitWork = nil } else if exitWork == nil {
                let work = DispatchWorkItem { [weak self] in
                    guard let self else { return }
                    self.exitWork = nil
                    self.hoverRevealed = false
                    self.onHoverExit()
                }
                exitWork = work
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0, execute: work)
            }
        }
        guard onBar, inEmptySpace(p) else {
            hoverWork?.cancel()
            hoverWork = nil
            return
        }
        guard hoverWork == nil else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.hoverWork = nil
            guard self.inEmptySpace(NSEvent.mouseLocation) else { return }
            self.hoverRevealed = true
            self.onReveal(false)
        }
        hoverWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + options.hoverDelay, execute: work)
    }

    private func clicked(_ e: NSEvent) {
        guard !isPostingEvents(), e.cgEvent?.getIntegerValueField(.eventSourceUserData) != ItemMover.eventMarker else { return }
        if inEmptySpace(NSEvent.mouseLocation) { onToggle() }
    }

    private func scrolled(_ e: NSEvent) {
        guard !isPostingEvents(), RevealTriggers.menuBarScreen(at: NSEvent.mouseLocation) != nil else { return }
        // One gesture fires many events: act once per 0.6 s.
        guard Date().timeIntervalSince(lastScroll) > 0.6 else { return }
        var dy = e.scrollingDeltaY
        var dx = e.scrollingDeltaX
        if e.isDirectionInvertedFromDevice { dy = -dy; dx = -dx }
        let threshold: CGFloat = e.hasPreciseScrollingDeltas ? 6 : 1
        if dy < -threshold || dx < -threshold {
            lastScroll = Date()
            onReveal(false)
        } else if dy > threshold || dx > threshold {
            lastScroll = Date()
            onHide()
        }
    }
}

/// The right edge of the frontmost app's menus, read through Accessibility
/// when an app becomes active (only while something needs it).
final class AppMenuTracker {
    private(set) var appMenuMaxX: CGFloat?
    private var observer: NSObjectProtocol?
    private let queue = DispatchQueue(label: "com.charles.bento.menubar.appmenu", qos: .utility)
    private var generation = 0

    var isRunning: Bool { observer != nil }

    func start() {
        guard observer == nil else { return }
        observer = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
            self?.refresh()
        }
        refresh()
    }

    func stop() {
        if let observer { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        observer = nil
        appMenuMaxX = nil
    }

    func refresh() {
        guard Permissions.accessibility, let app = NSWorkspace.shared.frontmostApplication else { return }
        generation += 1
        let gen = generation
        let pid = app.processIdentifier
        queue.async { [weak self] in
            let maxX = AppMenuTracker.menuMaxX(pid: pid)
            DispatchQueue.main.async {
                guard let self, gen == self.generation else { return }
                self.appMenuMaxX = maxX
            }
        }
    }

    static func menuMaxX(pid: pid_t) -> CGFloat? {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.5)
        guard let bar: AXUIElement = app.ax(kAXMenuBarAttribute),
              let items: [AXUIElement] = bar.ax(kAXChildrenAttribute) else { return nil }
        var maxX: CGFloat?
        for item in items {
            if let enabled: Bool = item.ax(kAXEnabledAttribute), !enabled { continue }
            guard let f = ItemScanner.axFrame(item), f.width > 0 else { continue }
            maxX = max(maxX ?? f.maxX, f.maxX)
        }
        return maxX
    }
}
