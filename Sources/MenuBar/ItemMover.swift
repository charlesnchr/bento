import AppKit
import ApplicationServices
import BentoCore

/// Moves and clicks other apps' status items with synthesized events, the
/// way a user would: ⌘-drag to move, click to open.
///
/// Two ways to move:
/// - **Drag** (item on screen): press on the item with ⌘ held, drag to the
///   drop point and release, exactly like a user.
/// - **Teleport** (item parked off-screen): press with ⌘ at the drop point,
///   with the item's window named in the event, and release on the target.
///   The window server routes the press to the parked item.
///
/// Each move is checked by re-reading the window positions and retried. The
/// pointer is hidden during a move and put back where it was. Everything runs
/// on a serial background queue (it waits between events); completions are
/// called on the main thread.
final class ItemMover {
    enum Failure: Error, CustomStringConvertible {
        case noAccessibility
        case userBusy
        case itemGone
        case targetGone
        case notPlaced

        var description: String {
            switch self {
            case .noAccessibility: "Moving items needs Accessibility permission"
            case .userBusy: "A mouse button or modifier key is held down"
            case .itemGone: "The item is no longer in the menu bar"
            case .targetGone: "The destination is no longer in the menu bar"
            case .notPlaced: "macOS didn’t accept the move"
            }
        }
    }

    struct Request {
        var item: CGWindowID
        var target: CGWindowID
        var side: Side
        /// Window ids that don't count when checking adjacency (zero-width items).
        var ignoring: Set<CGWindowID> = []
    }

    enum Side { case left, right }

    private let queue = DispatchQueue(label: "com.charles.bento.menubar.mover", qos: .userInitiated)
    private let log = BentoLog.make("menubar")
    /// Marks our events, so Bento's own event monitors can ignore them.
    static let eventMarker: Int64 = 0x42_656E_744D // "BentM"
    /// True while events are being posted (main thread reads it to ignore them).
    private(set) var isBusy = false
    private var pending = 0

    init() {
        WindowServer.allowCursorControlInBackground()
    }

    /// Runs the moves one after the other; stops at the first failure.
    func move(_ requests: [Request], completion: @escaping (Result<Void, Failure>) -> Void) {
        guard Permissions.accessibility else { completion(.failure(.noAccessibility)); return }
        begin()
        queue.async { [self] in
            var result: Result<Void, Failure> = .success(())
            withCursorHidden {
                for r in requests {
                    if case .failure(let f) = perform(r) { result = .failure(f); break }
                    usleep(30_000)
                }
            }
            DispatchQueue.main.async {
                self.end()
                completion(result)
            }
        }
    }

    /// Runs the moves before returning, waiting at most `timeout` (for
    /// quitting, when a completion would never run).
    func moveBlocking(_ requests: [Request], timeout: TimeInterval) {
        guard Permissions.accessibility, !requests.isEmpty else { return }
        let done = DispatchSemaphore(value: 0)
        queue.async { [self] in
            withCursorHidden {
                for r in requests { _ = perform(r) }
            }
            done.signal()
        }
        _ = done.wait(timeout: .now() + timeout)
    }

    /// Clicks an item (it must be on screen): left or right button.
    func click(_ item: CGWindowID, right: Bool = false, completion: @escaping (Result<Void, Failure>) -> Void) {
        guard Permissions.accessibility else { completion(.failure(.noAccessibility)); return }
        begin()
        queue.async { [self] in
            var result: Result<Void, Failure> = .success(())
            if !waitForIdleInput() {
                result = .failure(.userBusy)
            } else if let frame = WindowServer.frame(of: item), ItemMover.onScreen(frame) {
                postClick(at: CGPoint(x: frame.midX, y: frame.midY), window: item, right: right)
            } else {
                result = .failure(.itemGone)
            }
            DispatchQueue.main.async {
                self.end()
                completion(result)
            }
        }
    }

    private func begin() { pending += 1; isBusy = true }
    private func end() { pending -= 1; isBusy = pending > 0 }

    // MARK: One move

    private enum Strategy: String { case teleport, drag, edge }

    private func perform(_ r: Request) -> Result<Void, Failure> {
        for attempt in 0..<4 {
            guard let itemFrame = WindowServer.frame(of: r.item) else { return .failure(.itemGone) }
            guard let targetFrame = WindowServer.frame(of: r.target) else { return .failure(.targetGone) }
            if isPlaced(r) { return .success(()) }
            guard waitForIdleInput() else { return .failure(.userBusy) }
            // A teleport first (nothing reorders on the way); then, with both
            // items on screen, a drag that releases once the item is in place;
            // the older edge-point teleport last.
            let onScreen = ItemMover.onScreen(itemFrame) && ItemMover.onScreen(targetFrame)
            let first: Strategy = MenuBarLayout.releasesBeforeEdge(itemMidX: itemFrame.midX, targetMidX: targetFrame.midX,
                                                                   destination: r.side == .left ? .leftOf("") : .rightOf("")) ? .edge : .teleport
            let other: Strategy = first == .edge ? .teleport : .edge
            let strategy: Strategy = switch attempt {
            case 0, 2: first
            case 1: onScreen ? .drag : other
            default: other
            }
            switch strategy {
            case .teleport: teleport(r, itemFrame: itemFrame, targetFrame: targetFrame, inside: true)
            case .edge: teleport(r, itemFrame: itemFrame, targetFrame: targetFrame, inside: false)
            case .drag: drag(r, from: CGPoint(x: itemFrame.midX, y: itemFrame.midY))
            }
            waitUntilSettled(r.item, from: itemFrame)
            let placed = isPlaced(r)
            MenuBarTrace.log("move \(r.item) \(r.side == .left ? "left of" : "right of") \(r.target) by \(strategy.rawValue): \(placed ? "placed" : "missed") (item was x=\(Int(itemFrame.minX)), target x=\(Int(targetFrame.minX)), now x=\(Int(WindowServer.frame(of: r.item)?.minX ?? -1)))")
            if placed { return .success(()) }
            log.info("Menu bar move attempt \(attempt + 1) didn't land (window \(r.item, privacy: .public))")
            usleep(UInt32(60_000 * (attempt + 1)))
        }
        return .failure(.notPlaced)
    }

    /// Whether the item sits directly on the requested side of the target.
    private func isPlaced(_ r: Request) -> Bool {
        let windows = WindowServer.menuBarItemWindows().filter { $0.frame.width > 0 && !r.ignoring.contains($0.id) || $0.id == r.item || $0.id == r.target }
        let order = windows.sorted { $0.frame.midX < $1.frame.midX }.map { String($0.id) }
        return MenuBarLayout.isPlaced(String(r.item), r.side == .left ? .leftOf(String(r.target)) : .rightOf(String(r.target)), in: order)
    }

    /// Waits until the item's frame stops changing (≤ 0.5 s).
    private func waitUntilSettled(_ id: CGWindowID, from start: CGRect) {
        var last = start
        var stable = 0
        for _ in 0..<35 {
            usleep(15_000)
            guard let f = WindowServer.frame(of: id) else { return }
            if f == last { stable += 1 } else { stable = 0; last = f }
            if stable >= 3 && f != start { return }
        }
    }

    // MARK: Events

    private func event(_ type: CGEventType, at p: CGPoint, window: CGWindowID?, flags: CGEventFlags, button: CGMouseButton = .left) -> CGEvent? {
        let src = CGEventSource(stateID: .hidSystemState)
        guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: button) else { return nil }
        e.flags = flags
        e.setIntegerValueField(.eventSourceUserData, value: ItemMover.eventMarker)
        if let window {
            e.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window))
            e.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window))
        }
        return e
    }

    private func commandKey(down: Bool) {
        let src = CGEventSource(stateID: .hidSystemState)
        guard let e = CGEvent(keyboardEventSource: src, virtualKey: 0x37, keyDown: down) else { return }
        e.flags = down ? .maskCommand : []
        e.setIntegerValueField(.eventSourceUserData, value: ItemMover.eventMarker)
        e.post(tap: .cghidEventTap)
    }

    /// A real ⌘-drag: macOS reorders items live while one is dragged, so
    /// the pointer moves a few points at a time towards the target's near
    /// edge and lets go as soon as the item is on the requested side of it.
    private func drag(_ r: Request, from: CGPoint) {
        CGWarpMouseCursorPosition(from)
        usleep(15_000)
        commandKey(down: true)
        usleep(15_000)
        event(.leftMouseDown, at: from, window: r.item, flags: .maskCommand)?.post(tap: .cghidEventTap)
        usleep(50_000)
        var p = from
        for _ in 0..<200 {
            if isPlaced(r) { break }
            guard let t = WindowServer.frame(of: r.target) else { break }
            let goal = MenuBarLayout.dropPoint(for: r.side == .left ? .leftOf("") : .rightOf(""), targetFrame: t)
            var dx = goal.x - p.x
            // At the goal but not placed yet: nudge on past it.
            if abs(dx) < 1 { dx = r.side == .left ? -2 : 2 }
            p = CGPoint(x: p.x + max(-6, min(6, dx)), y: goal.y)
            event(.leftMouseDragged, at: p, window: r.item, flags: .maskCommand)?.post(tap: .cghidEventTap)
            usleep(16_000)
        }
        usleep(30_000)
        event(.leftMouseUp, at: p, window: r.item, flags: .maskCommand)?.post(tap: .cghidEventTap)
        usleep(20_000)
        commandKey(down: false)
    }

    /// Moves an item without dragging it there: a ⌘-press that names the
    /// item's window (the window server routes it to the item wherever it
    /// is, parked off-screen too) and a release on the target. `inside`
    /// presses and releases in the target's near half, where macOS inserts
    /// on that side of it; otherwise at the target's edge, offset by the
    /// item's width when it comes from the left.
    private func teleport(_ r: Request, itemFrame: CGRect, targetFrame: CGRect, inside: Bool) {
        var start: CGPoint, end: CGPoint
        if inside {
            start = MenuBarLayout.dropPoint(for: r.side == .left ? .leftOf("") : .rightOf(""), targetFrame: targetFrame)
            end = start
        } else {
            start = CGPoint(x: r.side == .left ? targetFrame.minX : targetFrame.maxX, y: targetFrame.minY + 1)
            end = start
            if itemFrame.midX < targetFrame.midX {
                end.x = start.x - itemFrame.width
            } else {
                start.x += r.side == .left ? -1 : 1
                end = start
            }
        }
        commandKey(down: true)
        usleep(15_000)
        let down = event(.leftMouseDown, at: start, window: r.item, flags: .maskCommand)
        down?.setIntegerValueField(ItemMover.windowField, value: Int64(r.item))
        down?.post(tap: .cghidEventTap)
        usleep(80_000)
        let up = event(.leftMouseUp, at: end, window: r.target, flags: .maskCommand)
        up?.setIntegerValueField(ItemMover.windowField, value: Int64(r.item))
        up?.post(tap: .cghidEventTap)
        usleep(30_000)
        commandKey(down: false)
    }

    /// An undocumented mouse event field holding the window the event is
    /// for; with it the press reaches an item that isn't under the pointer.
    private static let windowField = CGEventField(rawValue: 0x33)!

    private func postClick(at p: CGPoint, window: CGWindowID, right: Bool) {
        let saved = CGEvent(source: nil)?.location
        let (downType, upType): (CGEventType, CGEventType) = right ? (.rightMouseDown, .rightMouseUp) : (.leftMouseDown, .leftMouseUp)
        // Route by position: warp first so the click can't land on whatever
        // was under the old pointer position.
        CGWarpMouseCursorPosition(p)
        usleep(15_000)
        let down = event(downType, at: p, window: window, flags: [], button: right ? .right : .left)
        down?.setIntegerValueField(.mouseEventClickState, value: 1)
        down?.post(tap: .cghidEventTap)
        usleep(30_000)
        let up = event(upType, at: p, window: window, flags: [], button: right ? .right : .left)
        up?.setIntegerValueField(.mouseEventClickState, value: 1)
        up?.post(tap: .cghidEventTap)
        usleep(20_000)
        if let saved { CGWarpMouseCursorPosition(saved) }
    }

    /// Hides the pointer for the duration and puts it back where it was.
    private func withCursorHidden(_ body: () -> Void) {
        let saved = CGEvent(source: nil)?.location
        let display = CGMainDisplayID()
        CGDisplayHideCursor(display)
        body()
        if let saved { CGWarpMouseCursorPosition(saved) }
        CGDisplayShowCursor(display)
    }

    /// Waits (≤ 1 s) until no mouse button or modifier is held, so our events
    /// don't mix with the user's.
    private func waitForIdleInput() -> Bool {
        for _ in 0..<50 {
            let buttons = [CGMouseButton.left, .right, .center].contains { CGEventSource.buttonState(.combinedSessionState, button: $0) }
            let mods = CGEventSource.flagsState(.combinedSessionState).intersection([.maskCommand, .maskAlternate, .maskControl, .maskShift])
            if !buttons && mods.isEmpty { return true }
            usleep(20_000)
        }
        return false
    }

    /// Whether an item's window is on a display (see `MenuBarLayout.isOnDisplay`).
    /// Thread-safe: CGDisplay bounds, not NSScreen.
    static func onScreen(_ frame: CGRect) -> Bool {
        var count: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &count)
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        CGGetActiveDisplayList(count, &ids, &count)
        return MenuBarLayout.isOnDisplay(frame, displays: ids.map { CGDisplayBounds($0) })
    }
}
