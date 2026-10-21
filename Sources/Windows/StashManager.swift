import AppKit
import BentoCore

/// Stash: slides a window off a free left/right screen edge, leaving a sliver.
/// (Not the bottom edge: AppKit keeps title bars above the Dock, so a window
/// can't be pushed down far enough.) Hovering
/// the sliver (or the Reveal shortcut) slides it back; moving the pointer away
/// stashes it again. A tiny transparent panel over each sliver detects hover
/// via a tracking area, so there is no polling; a mouse-moved monitor exists
/// only while a stashed window is revealed.
final class StashManager {
    enum Edge: String { case left, right }

    private final class Item {
        let window: AXWindow
        let edge: Edge
        var shown: CGRect
        var hidden: CGRect
        var tracker: NSPanel?
        var revealed = false

        init(window: AXWindow, edge: Edge, shown: CGRect, hidden: CGRect) {
            self.window = window
            self.edge = edge
            self.shown = shown
            self.hidden = hidden
        }
    }

    var sliver: CGFloat = 12
    var revealOnHover = true
    private var items: [CGWindowID: Item] = [:]
    private var order: [CGWindowID] = []
    private var mouseMonitor: Any?
    private var screenObserver: NSObjectProtocol?

    var isEmpty: Bool { items.isEmpty }

    // MARK: Actions

    /// Stashes the focused window to an edge, or unstashes it if it is stashed.
    func toggle(_ edge: Edge) {
        guard let w = AXWindow.focused(), let id = w.windowID, let frame = w.frame, !w.isFullscreen else { NSSound.beep(); return }
        if items[id] != nil { unstash(id, focus: true); return }
        let snap = ScreenSnapshot.current()
        let si = snap.index(containing: frame)
        guard let hidden = StashManager.hiddenFrame(frame, edge: edge, screen: si, screens: snap.rects, sliver: sliver) else {
            NSSound.beep()
            HUD.show("No free screen edge there", symbol: "rectangle.slash")
            return
        }
        let item = Item(window: w, edge: edge, shown: Geometry.clamp(frame, into: snap.rects[si].visible), hidden: hidden)
        items[id] = item
        order.removeAll { $0 == id }
        order.append(id)
        hide(item, id: id)
        observeScreens()
    }

    /// Reveals the most recently stashed window, or stashes it back.
    func toggleReveal() {
        guard let id = order.last, let item = items[id] else { NSSound.beep(); return }
        if item.revealed { hide(item, id: id) } else { reveal(item, id: id, focus: true) }
    }

    func unstashAll() {
        for id in Array(items.keys) { unstash(id, focus: false) }
    }

    private func unstash(_ id: CGWindowID, focus: Bool) {
        guard let item = items.removeValue(forKey: id) else { return }
        order.removeAll { $0 == id }
        item.tracker?.close()
        item.tracker = nil
        if !item.revealed { item.window.setFrame(item.shown) }
        if focus { item.window.focus() }
        updateMouseMonitor()
        if items.isEmpty, let o = screenObserver {
            NotificationCenter.default.removeObserver(o)
            screenObserver = nil
        }
    }

    // MARK: Geometry

    /// Off-screen frame leaving `sliver` points visible, or nil if another
    /// display touches that edge (the window would just land on it).
    static func hiddenFrame(_ f: CGRect, edge: Edge, screen i: Int, screens: [ScreenRect], sliver: CGFloat) -> CGRect? {
        let s = screens[i].frame
        let others = screens.enumerated().filter { $0.offset != i }.map(\.element.frame)
        var r = f
        switch edge {
        case .left:
            if others.contains(where: { abs($0.maxX - s.minX) <= 1 && $0.minY < f.maxY && $0.maxY > f.minY }) { return nil }
            r.origin.x = s.minX - f.width + sliver
        case .right:
            if others.contains(where: { abs($0.minX - s.maxX) <= 1 && $0.minY < f.maxY && $0.maxY > f.minY }) { return nil }
            r.origin.x = s.maxX - sliver
        }
        return r
    }

    /// The visible strip of a stashed window (AX coordinates).
    static func sliverRect(_ hidden: CGRect, edge: Edge, screen s: CGRect, sliver: CGFloat) -> CGRect {
        switch edge {
        case .left: return CGRect(x: s.minX, y: hidden.minY, width: sliver, height: hidden.height).intersection(s)
        case .right: return CGRect(x: s.maxX - sliver, y: hidden.minY, width: sliver, height: hidden.height).intersection(s)
        }
    }

    // MARK: Hide / reveal

    private func hide(_ item: Item, id: CGWindowID) {
        item.window.setFrame(item.hidden)
        item.revealed = false
        // Where the window really ended up (apps may clamp off-screen frames).
        let actual = item.window.frame ?? item.hidden
        let snap = ScreenSnapshot.current()
        let screen = snap.rects[snap.index(containing: item.shown)].frame
        let strip = StashManager.sliverRect(actual, edge: item.edge, screen: screen, sliver: sliver)
        if revealOnHover, !strip.isNull, strip.width > 0, strip.height > 0 {
            let panel = item.tracker ?? makeTracker { [weak self] in
                guard let self, let item = self.items[id], !item.revealed else { return }
                self.reveal(item, id: id, focus: false)
            }
            panel.setFrame(NSScreen.cocoaRect(fromAX: strip), display: false)
            panel.orderFrontRegardless()
            item.tracker = panel
        }
        updateMouseMonitor()
    }

    private func reveal(_ item: Item, id: CGWindowID, focus: Bool) {
        item.tracker?.orderOut(nil)
        item.window.setFrame(item.shown)
        item.revealed = true
        if focus { item.window.focus() } else { item.window.raise() }
        updateMouseMonitor()
    }

    private func makeTracker(onHover: @escaping () -> Void) -> NSPanel {
        let p = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        p.isOpaque = false
        p.backgroundColor = NSColor.black.withAlphaComponent(0.001) // must not be fully clear to receive the mouse
        p.hasShadow = false
        p.level = .floating
        p.isReleasedWhenClosed = false
        p.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        let view = HoverView()
        view.onHover = onHover
        p.contentView = view
        return p
    }

    /// While a stashed window is out, stash it again once the pointer leaves it.
    private func updateMouseMonitor() {
        let anyRevealed = items.values.contains { $0.revealed }
        if anyRevealed, mouseMonitor == nil {
            mouseMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseUp]) { [weak self] _ in
                self?.pointerMoved()
            }
        } else if !anyRevealed, let m = mouseMonitor {
            NSEvent.removeMonitor(m)
            mouseMonitor = nil
        }
    }

    private func pointerMoved() {
        let p = NSScreen.mouseAX
        for (id, item) in items where item.revealed {
            guard let now = item.window.frame else { unstash(id, focus: false); continue } // closed
            if !Geometry.near(now, item.shown, tolerance: 4) {
                // The user moved or resized it: it is no longer stashed.
                item.shown = now
                unstash(id, focus: false)
                continue
            }
            if !now.insetBy(dx: -24, dy: -24).contains(p) { hide(item, id: id) }
        }
    }

    private func observeScreens() {
        guard screenObserver == nil else { return }
        screenObserver = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                                                object: nil, queue: .main) { [weak self] _ in
            self?.unstashAll()
        }
    }
}

private final class HoverView: NSView {
    var onHover: (() -> Void)?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }

    override func mouseEntered(with event: NSEvent) { onHover?() }
    override func mouseDown(with event: NSEvent) { onHover?() }
}
