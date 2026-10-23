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
        case cancelled

        var description: String {
            switch self {
            case .noAccessibility: "Moving items needs Accessibility permission"
            case .userBusy: "A mouse button or modifier key is held down"
            case .itemGone: "The item is no longer in the menu bar"
            case .targetGone: "The destination is no longer in the menu bar"
            case .notPlaced: "macOS didn’t accept the move"
            case .cancelled: "Cancelled"
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

    private let work = ItemWorkQueue(label: "com.charles.bento.menubar.mover")

    /// All system effects are behind this boundary so worker cancellation can
    /// be exercised without querying or controlling the user's menu bar.
    struct Environment {
        var accessibility: () -> Bool
        var frame: (CGWindowID) -> CGRect?
        var windows: () -> [WindowServer.WindowInfo]
        var inputIsIdle: () -> Bool
        var onScreen: (CGRect) -> Bool
        var cursor: () -> CGPoint?
        var post: (Input) -> Void
        var prepare: () -> Void = {}
        var display: () -> CGDirectDisplayID = { 0 }

        static var live: Environment {
            Environment(accessibility: { Permissions.accessibility }, frame: WindowServer.frame,
                        windows: WindowServer.menuBarItemWindows, inputIsIdle: ItemMover.inputIsIdle,
                        onScreen: ItemMover.onScreen, cursor: { CGEvent(source: nil)?.location },
                        post: ItemMover.post, prepare: WindowServer.allowCursorControlInBackground, display: CGMainDisplayID)
        }
    }

    enum Input {
        case command(Bool)
        case mouse(CGEventType, CGPoint, CGWindowID, CGEventFlags, CGMouseButton, CGWindowID?, Bool)
        case warp(CGPoint)
        case cursorHidden(Bool, display: CGDirectDisplayID)
    }

    private let environment: Environment
    private let log = BentoLog.make("menubar")
    /// Marks our events, so Bento's own event monitors can ignore them.
    static let eventMarker: Int64 = 0x42_656E_744D // "BentM"
    /// True while events are being posted (main thread reads it to ignore them).
    private(set) var isBusy = false
    private var pending = 0
    init(environment: Environment = .live) {
        self.environment = environment
        environment.prepare()
    }

    func cancelAll() { work.cancelAll() }

    func cancelAndDrain() { work.cancelAll(); work.drain() }

    /// Runs the moves one after the other; stops at the first failure.
    func move(_ requests: [Request], completion: @escaping (Result<Void, Failure>) -> Void) {
        guard environment.accessibility() else { completion(.failure(.noAccessibility)); return }
        begin()
        let accepted = work.submit { [self] token in
            let result = move(requests, token: token)
            DispatchQueue.main.async {
                self.end()
                completion(token.isCancelled ? .failure(.cancelled) : result)
            }
        }
        if !accepted { end(); completion(.failure(.cancelled)) }
    }

    private func move(_ requests: [Request], token: ItemWorkQueue.Token, bestEffort: Bool = false) -> Result<Void, Failure> {
        guard !token.isCancelled else { return .failure(.cancelled) }
        var result: Result<Void, Failure> = .success(())
        withCursorHidden(token: token) {
            for r in requests {
                guard !token.isCancelled else { result = .failure(.cancelled); break }
                if case .failure(let f) = perform(r, token: token) {
                    result = .failure(f)
                    if !bestEffort || f == .cancelled { break }
                }
                if !token.wait(0.03) { result = .failure(.cancelled); break }
            }
        }
        return result
    }

    /// Cancels and drains even with no returns. Only release/cleanup events
    /// may follow the deadline; they finish before the separators are removed.
    func stop(restoring requests: [Request] = [], timeout: TimeInterval = 4) {
        work.finish(timeout: timeout) { token in
            guard !requests.isEmpty, environment.accessibility() else { return }
            _ = move(requests, token: token, bestEffort: true)
        }
    }

    /// Clicks an item (it must be on screen): left or right button.
    func click(_ item: CGWindowID, right: Bool = false, completion: @escaping (Result<Void, Failure>) -> Void) {
        guard environment.accessibility() else { completion(.failure(.noAccessibility)); return }
        begin()
        let accepted = work.submit { [self] token in
            var result: Result<Void, Failure> = .success(())
            if !waitForIdleInput(token: token) {
                result = .failure(token.isCancelled ? .cancelled : .userBusy)
            } else if let frame = environment.frame(item), environment.onScreen(frame) {
                // Frame lookup can block; check again immediately before input.
                if token.isCancelled { result = .failure(.cancelled) }
                else { postClick(at: CGPoint(x: frame.midX, y: frame.midY), window: item, right: right, token: token) }
            } else {
                result = .failure(.itemGone)
            }
            DispatchQueue.main.async {
                self.end()
                completion(token.isCancelled ? .failure(.cancelled) : result)
            }
        }
        if !accepted { end(); completion(.failure(.cancelled)) }
    }

    private func begin() { pending += 1; isBusy = true }
    private func end() { pending -= 1; isBusy = pending > 0 }

    // MARK: One move

    private enum Strategy: String { case teleport, drag, edge }

    private func perform(_ r: Request, token: ItemWorkQueue.Token) -> Result<Void, Failure> {
        for attempt in 0..<4 {
            guard !token.isCancelled else {
                MenuBarTrace.log("move \(r.item) cancelled")
                return .failure(.cancelled)
            }
            guard let itemFrame = environment.frame(r.item) else { return .failure(.itemGone) }
            guard !token.isCancelled else { return .failure(.cancelled) }
            guard let targetFrame = environment.frame(r.target) else { return .failure(.targetGone) }
            guard !token.isCancelled else { return .failure(.cancelled) }
            if isPlaced(r) { return .success(()) }
            guard waitForIdleInput(token: token) else {
                MenuBarTrace.log("move \(r.item) \(token.isCancelled ? "cancelled" : "not started: input busy")")
                return .failure(token.isCancelled ? .cancelled : .userBusy)
            }
            // A teleport first (nothing reorders on the way); then, with both
            // items on screen, a drag that releases once the item is in place;
            // the older edge-point teleport last.
            let onScreen = environment.onScreen(itemFrame) && environment.onScreen(targetFrame)
            let first: Strategy = MenuBarLayout.releasesBeforeEdge(itemMidX: itemFrame.midX, targetMidX: targetFrame.midX,
                                                                   destination: r.side == .left ? .leftOf("") : .rightOf("")) ? .edge : .teleport
            let other: Strategy = first == .edge ? .teleport : .edge
            let strategy: Strategy = switch attempt {
            case 0, 2: first
            case 1: onScreen ? .drag : other
            default: other
            }
            guard !token.isCancelled else { return .failure(.cancelled) }
            switch strategy {
            case .teleport: teleport(r, itemFrame: itemFrame, targetFrame: targetFrame, inside: true, token: token)
            case .edge: teleport(r, itemFrame: itemFrame, targetFrame: targetFrame, inside: false, token: token)
            case .drag: drag(r, from: CGPoint(x: itemFrame.midX, y: itemFrame.midY), token: token)
            }
            waitUntilSettled(r.item, from: itemFrame, token: token)
            guard !token.isCancelled else { return .failure(.cancelled) }
            let placed = isPlaced(r)
            MenuBarTrace.log("move \(r.item) \(r.side == .left ? "left of" : "right of") \(r.target) by \(strategy.rawValue): \(placed ? "placed" : "missed") (item was x=\(Int(itemFrame.minX)), target x=\(Int(targetFrame.minX)), now x=\(Int(environment.frame(r.item)?.minX ?? -1)))")
            if placed { return .success(()) }
            log.info("Menu bar move attempt \(attempt + 1) didn't land (window \(r.item, privacy: .public))")
            guard token.wait(0.06 * Double(attempt + 1)) else { return .failure(.cancelled) }
        }
        return .failure(.notPlaced)
    }

    /// Whether the item sits directly on the requested side of the target.
    private func isPlaced(_ r: Request) -> Bool {
        let windows = environment.windows().filter { $0.frame.width > 0 && !r.ignoring.contains($0.id) || $0.id == r.item || $0.id == r.target }
        let order = windows.sorted { $0.frame.midX < $1.frame.midX }.map { String($0.id) }
        return MenuBarLayout.isPlaced(String(r.item), r.side == .left ? .leftOf(String(r.target)) : .rightOf(String(r.target)), in: order)
    }

    /// Waits until the item's frame stops changing (≤ 0.5 s).
    private func waitUntilSettled(_ id: CGWindowID, from start: CGRect, token: ItemWorkQueue.Token) {
        var last = start
        var stable = 0
        for _ in 0..<35 {
            guard token.wait(0.015) else { return }
            guard let f = environment.frame(id) else { return }
            if f == last { stable += 1 } else { stable = 0; last = f }
            if stable >= 3 && f != start { return }
        }
    }

    // MARK: Events

    private static func post(_ input: Input) {
        switch input {
        case .warp(let point): CGWarpMouseCursorPosition(point)
        case let .cursorHidden(hidden, display):
            if hidden { CGDisplayHideCursor(display) } else { CGDisplayShowCursor(display) }
        case .command(let down):
            let src = CGEventSource(stateID: .hidSystemState)
            guard let e = CGEvent(keyboardEventSource: src, virtualKey: 0x37, keyDown: down) else { return }
            e.flags = down ? .maskCommand : []
            e.setIntegerValueField(.eventSourceUserData, value: eventMarker)
            e.post(tap: .cghidEventTap)
        case let .mouse(type, point, window, flags, button, routedWindow, click):
            let src = CGEventSource(stateID: .hidSystemState)
            guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { return }
            e.flags = flags
            e.setIntegerValueField(.eventSourceUserData, value: eventMarker)
            e.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window))
            e.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window))
            if let routedWindow { e.setIntegerValueField(windowField, value: Int64(routedWindow)) }
            if click { e.setIntegerValueField(.mouseEventClickState, value: 1) }
            e.post(tap: .cghidEventTap)
        }
    }

    /// A real ⌘-drag: macOS reorders items live while one is dragged, so
    /// the pointer moves a few points at a time towards the target's near
    /// edge and lets go as soon as the item is on the requested side of it.
    private func drag(_ r: Request, from: CGPoint, token: ItemWorkQueue.Token) {
        guard !token.isCancelled else { return }
        environment.post(.warp(from))
        guard token.wait(0.015) else { return }
        environment.post(.command(true))
        defer { environment.post(.command(false)) }
        guard token.wait(0.015) else { return }
        environment.post(.mouse(.leftMouseDown, from, r.item, .maskCommand, .left, nil, false))
        var p = from
        defer {
            environment.post(.mouse(.leftMouseUp, p, r.item, .maskCommand, .left, nil, false))
            token.wait(0.02)
        }
        guard token.wait(0.05) else { return }
        for _ in 0..<200 {
            if isPlaced(r) || token.isCancelled { break }
            guard let t = environment.frame(r.target), !token.isCancelled else { break }
            let goal = MenuBarLayout.dropPoint(for: r.side == .left ? .leftOf("") : .rightOf(""), targetFrame: t)
            var dx = goal.x - p.x
            if abs(dx) < 1 { dx = r.side == .left ? -2 : 2 }
            p = CGPoint(x: p.x + max(-6, min(6, dx)), y: goal.y)
            environment.post(.mouse(.leftMouseDragged, p, r.item, .maskCommand, .left, nil, false))
            if !token.wait(0.016) { break }
        }
        token.wait(0.03)
    }

    /// Moves an item without dragging it there: a ⌘-press that names the
    /// item's window (the window server routes it to the item wherever it
    /// is, parked off-screen too) and a release on the target. `inside`
    /// presses and releases in the target's near half, where macOS inserts
    /// on that side of it; otherwise at the target's edge, offset by the
    /// item's width when it comes from the left.
    private func teleport(_ r: Request, itemFrame: CGRect, targetFrame: CGRect, inside: Bool, token: ItemWorkQueue.Token) {
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
        guard !token.isCancelled else { return }
        environment.post(.command(true))
        defer { environment.post(.command(false)) }
        guard token.wait(0.015) else { return }
        environment.post(.mouse(.leftMouseDown, start, r.item, .maskCommand, .left, r.item, false))
        token.wait(0.08)
        // A posted press must be released, including on cancellation/deadline.
        environment.post(.mouse(.leftMouseUp, end, r.target, .maskCommand, .left, r.item, false))
        token.wait(0.03)
    }

    /// An undocumented mouse event field holding the window the event is
    /// for; with it the press reaches an item that isn't under the pointer.
    private static let windowField = CGEventField(rawValue: 0x33)!

    private func postClick(at p: CGPoint, window: CGWindowID, right: Bool, token: ItemWorkQueue.Token) {
        guard !token.isCancelled else { return }
        let saved = environment.cursor()
        guard !token.isCancelled else { return }
        environment.post(.warp(p))
        defer { if let saved { environment.post(.warp(saved)) } }
        guard token.wait(0.015) else { return }
        let (downType, upType): (CGEventType, CGEventType) = right ? (.rightMouseDown, .rightMouseUp) : (.leftMouseDown, .leftMouseUp)
        environment.post(.mouse(downType, p, window, [], right ? .right : .left, nil, true))
        token.wait(0.03)
        environment.post(.mouse(upType, p, window, [], right ? .right : .left, nil, true))
        token.wait(0.02)
    }

    private func withCursorHidden(token: ItemWorkQueue.Token, _ body: () -> Void) {
        let saved = environment.cursor()
        let display = environment.display()
        guard !token.isCancelled else { return }
        environment.post(.cursorHidden(true, display: display))
        body()
        if let saved { environment.post(.warp(saved)) }
        environment.post(.cursorHidden(false, display: display))
    }

    /// Waits (≤ 1 s) until no mouse button or modifier is held, so our events
    /// don't mix with the user's. False when the time is up or it's cancelled.
    private func waitForIdleInput(token: ItemWorkQueue.Token) -> Bool {
        for _ in 0..<50 {
            if token.isCancelled { return false }
            if environment.inputIsIdle() { return !token.isCancelled }
            if !token.wait(0.02) { return false }
        }
        return false
    }

    /// Whether no mouse button or modifier key is held right now.
    static func inputIsIdle() -> Bool {
        let buttons = [CGMouseButton.left, .right, .center].contains { CGEventSource.buttonState(.combinedSessionState, button: $0) }
        let mods = CGEventSource.flagsState(.combinedSessionState).intersection([.maskCommand, .maskAlternate, .maskControl, .maskShift])
        return !buttons && mods.isEmpty
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
