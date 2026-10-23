import ApplicationServices
import Foundation
import Testing
@testable import MenuBar

private final class Locked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value
    init(_ value: Value) { self.value = value }
    func withValue<T>(_ body: (inout Value) -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body(&value)
    }
    var get: Value { withValue { $0 } }
}

private final class Gate: @unchecked Sendable {
    let entered = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)
    func block() {
        entered.signal()
        #expect(release.wait(timeout: .now() + 3) == .success)
    }
    func waitForEntry() { #expect(entered.wait(timeout: .now() + 3) == .success) }
    func releaseSoon() { DispatchQueue.global().asyncAfter(deadline: .now() + 0.03) { self.release.signal() } }
}

private func item(_ id: CGWindowID, role: MenuBarItem.Role = .regular) -> MenuBarItem {
    MenuBarItem(windowID: id, frame: .zero, windowName: "Item-\(id)", ownerPID: 42,
                bundleID: "test.app", appName: "Test", role: role)
}

/// Only fake windows and an event log. No system queries, cursor control,
/// status items, AX actions, settings, image capture, or app launches.
private final class FakeMenuBar: @unchecked Sendable {
    let state: Locked<[MenuBarItem]>
    let events = Locked<[ItemMover.Input]>([])
    var acceptMoves = false
    var onPost: ((ItemMover.Input) -> Void)?
    var onFrame: ((CGWindowID) -> Void)?
    var idle = true
    var permission = true

    init(_ items: [MenuBarItem] = [item(1), item(2), item(3)]) { state = Locked(items) }

    func snapshot() -> [MenuBarItem] {
        state.get.enumerated().map { index, item in
            var i = item
            i.frame = CGRect(x: 100 + index * 30, y: 0, width: 30, height: 24)
            return i
        }
    }

    func place(_ id: CGWindowID, before target: CGWindowID) {
        state.withValue { items in
            guard let i = items.firstIndex(where: { $0.windowID == id }) else { return }
            let moved = items.remove(at: i)
            guard let t = items.firstIndex(where: { $0.windowID == target }) else { items.append(moved); return }
            items.insert(moved, at: t)
        }
    }

    var environment: ItemMover.Environment {
        .init(accessibility: { self.permission }, frame: { id in
            self.onFrame?(id)
            return self.snapshot().first { $0.windowID == id }?.frame
        }, windows: {
            self.snapshot().map { .init(id: $0.windowID, frame: $0.frame, name: $0.windowName,
                                      ownerPID: 42, ownerName: "Test", isOnScreen: true) }
        }, inputIsIdle: { self.idle }, onScreen: { _ in true }, cursor: { .zero }, post: { input in
            self.events.withValue { $0.append(input) }
            if self.acceptMoves, case let .mouse(.leftMouseUp, _, target, _, _, moving?, _) = input {
                self.place(moving, before: target)
            }
            self.onPost?(input)
        })
    }

    var downs: Int {
        events.get.filter { if case .mouse(.leftMouseDown, _, _, _, _, _, _) = $0 { return true }; return false }.count
    }

    func expectReleased() {
        var mouse = false, command = false, hidden = false
        for e in events.get {
            switch e {
            case .command(let down): command = down
            case .cursorHidden(let on, _): hidden = on
            case .mouse(.leftMouseDown, _, _, _, _, _, _): mouse = true
            case .mouse(.leftMouseUp, _, _, _, _, _, _): mouse = false
            default: break
            }
        }
        #expect(!mouse && !command && !hidden)
    }
}

private func wait(_ semaphore: DispatchSemaphore) {
    #expect(semaphore.wait(timeout: .now() + 3) == .success)
}

private func mainTurn() async {
    await withCheckedContinuation { continuation in DispatchQueue.main.async { continuation.resume() } }
}

@Test @MainActor func deadlineReleasesHeldInputAndSkipsRestOfBatch() {
    let fake = FakeMenuBar()
    let mover = ItemMover(environment: fake.environment)
    let start = Date()
    mover.stop(restoring: [.init(item: 1, target: 3, side: .left), .init(item: 2, target: 1, side: .left)], timeout: 0.05)
    #expect(Date().timeIntervalSince(start) < 0.5)
    #expect(fake.downs == 1)
    fake.expectReleased()
    let before = fake.events.get.count
    mover.click(2) { result in
        guard case .failure(.cancelled) = result else { Issue.record("Stopped mover accepted a click"); return }
    }
    #expect(fake.events.get.count == before)
}

@Test @MainActor func stopWithoutReturnsDrainsHeldInputAndCancelsQueuedClick() async {
    let fake = FakeMenuBar()
    let gate = Gate()
    fake.onPost = { input in if case .mouse(.leftMouseDown, _, _, _, _, _, _) = input { gate.block() } }
    let mover = ItemMover(environment: fake.environment)
    var cancelled = 0
    let completion: (Result<Void, ItemMover.Failure>) -> Void = { result in
        if case .failure(.cancelled) = result { cancelled += 1 }
    }
    mover.move([.init(item: 1, target: 3, side: .left)], completion: completion)
    mover.click(2, completion: completion)
    gate.waitForEntry()
    gate.releaseSoon()
    mover.stop()
    fake.expectReleased()
    #expect(fake.downs == 1)
    let before = fake.events.get.count
    await mainTurn()
    #expect(cancelled == 2)
    #expect(fake.events.get.count == before)
}

@Test @MainActor func clickFrameLookupCannotPostAfterCancellation() async {
    let fake = FakeMenuBar()
    let gate = Gate()
    fake.onFrame = { _ in gate.block() }
    let mover = ItemMover(environment: fake.environment)
    mover.click(1) { _ in }
    gate.waitForEntry()
    gate.releaseSoon()
    mover.stop()
    await mainTurn()
    #expect(fake.events.get.isEmpty)
}

@Test @MainActor func stopDeadlineInterruptsIdleWait() {
    let fake = FakeMenuBar()
    fake.idle = false
    let mover = ItemMover(environment: fake.environment)
    let start = Date()
    mover.stop(restoring: [.init(item: 1, target: 3, side: .left)], timeout: 0.03)
    #expect(Date().timeIntervalSince(start) < 0.5)
    #expect(fake.downs == 0)
    fake.expectReleased()
}

@Test @MainActor func cancellationDuringDragReleasesInput() {
    let fake = FakeMenuBar()
    let gate = Gate()
    fake.onPost = { input in if case .mouse(.leftMouseDragged, _, _, _, _, _, _) = input { gate.block() } }
    let mover = ItemMover(environment: fake.environment)
    mover.move([.init(item: 1, target: 3, side: .left)]) { _ in }
    gate.waitForEntry()
    gate.releaseSoon()
    let start = Date()
    mover.stop()
    #expect(Date().timeIntervalSince(start) < 0.5)
    fake.expectReleased()
    #expect(fake.downs == 2) // missed teleport, then cancelled drag
}

private func scanner(environment: ItemScanner.PressEnvironment) -> ItemScanner {
    // Creating a reference performs no IPC. Every read/action is a fake below.
    let element = AXUIElementCreateApplication(42)
    return ItemScanner(owners: [1: .init(pid: 42, appName: "Test", element: element)], pressEnvironment: environment)
}

@Test @MainActor func cancelledAXFrameLookupNeverPressesOrFallsBack() async {
    let gate = Gate()
    let calls = Locked(0)
    let s = scanner(environment: .init(axFrame: { _ in gate.block(); return CGRect(x: 100, y: 0, width: 30, height: 24) },
                                      windowFrame: { _ in CGRect(x: 100, y: 0, width: 30, height: 24) },
                                      perform: { _ in calls.withValue { $0 += 1 }; return .success }))
    var completions = 0
    s.press(item(1)) { _ in completions += 1 }
    gate.waitForEntry()
    gate.releaseSoon()
    s.stop()
    await mainTurn()
    #expect(calls.get == 0)
    #expect(completions == 0)
}

@Test @MainActor func stopDrainsActiveAXActionAndDropsQueuedActionsAndCallbacks() async {
    let gate = Gate()
    let calls = Locked(0)
    let finished = Locked(false)
    let frame = CGRect(x: 100, y: 0, width: 30, height: 24)
    let s = scanner(environment: .init(axFrame: { _ in frame }, windowFrame: { _ in frame }, perform: { _ in
        calls.withValue { $0 += 1 }
        gate.block()
        finished.withValue { $0 = true }
        return .cannotComplete
    }))
    var completions = 0
    s.press(item(1)) { _ in completions += 1 }
    s.press(item(1)) { _ in completions += 1 }
    gate.waitForEntry()
    gate.releaseSoon()
    s.stop()
    #expect(finished.get)
    await mainTurn()
    #expect(calls.get == 1)
    #expect(completions == 0)
    s.press(item(1)) { _ in completions += 1 }
    #expect(completions == 0)
}

@Test @MainActor func staleAXMismatchCallbackCannotTriggerFallback() async {
    let read = DispatchSemaphore(value: 0)
    let s = scanner(environment: .init(axFrame: { _ in nil }, windowFrame: { _ in read.signal(); return nil },
                                      perform: { _ in Issue.record("Unexpected AX action"); return .success }))
    var fallback = false
    s.press(item(1)) { _ in fallback = true }
    wait(read)
    s.stop()
    await mainTurn()
    #expect(!fallback)
}

// A X Y H T. X is moved before T, then Y before X: A H Y X T.
private func original() -> [MenuBarItem] {
    [item(10, role: .control(.alwaysHidden)), item(1), item(2), item(20, role: .control(.hidden)), item(30, role: .control(.toggle))]
}

@Test @MainActor func multipleReturnsRestoreOriginalSectionInEitherOrder() async {
    for returnOrder: [CGWindowID] in [[1, 2], [2, 1]] {
        let fake = FakeMenuBar(original())
        fake.acceptMoves = true
        let mover = ItemMover(environment: fake.environment)
        let controller = MenuBarController(settings: .init(), scanner: ItemScanner(snapshot: fake.snapshot), mover: mover)
        controller.beginSession() // exercise input lifecycle without installing GUI controls/observers
        controller.recordReturn(.init(item: 1, order: fake.snapshot()))
        fake.place(1, before: 30)
        controller.recordReturn(.init(item: 2, order: fake.snapshot()))
        fake.place(2, before: 1)
        #expect(fake.snapshot().map(\.windowID) == [10, 20, 2, 1, 30])
        #expect(controller.temporarilyShown[1]?.isBack(in: fake.snapshot(), excluding: [1, 2]) == false)
        #expect(controller.temporarilyShown[1]?.request(in: fake.snapshot(), excluding: [1, 2])?.target == 20)
        // Repeated activation cannot overwrite X's original section.
        controller.recordReturn(.init(item: 1, order: fake.snapshot()))
        #expect(controller.temporarilyShown[1]?.section == .hidden)
        controller.putBack(returnOrder)
        for _ in 0..<150 where !controller.temporarilyShown.isEmpty { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(controller.temporarilyShown.isEmpty)
        #expect(fake.snapshot().map(\.windowID) == [10, 1, 2, 20, 30])
        controller.stop()
        fake.expectReleased()
    }
}

@Test @MainActor func watcherResumesAfterOnlyWatchedItemReturns() async {
    let fake = FakeMenuBar(original().filter { $0.windowID != 2 })
    fake.acceptMoves = true
    let controller = MenuBarController(settings: .init(), scanner: ItemScanner(snapshot: fake.snapshot),
                                       mover: ItemMover(environment: fake.environment))
    controller.beginSession()
    let watcher = ChangeWatcher(controller: controller, canCaptureImages: { false })
    controller.changeWatcher = watcher
    watcher.update(keys: [item(1).key])
    #expect(watcher.isRunning)
    controller.recordReturn(.init(item: 1, order: fake.snapshot()))
    fake.place(1, before: 30)
    controller.syncChangeWatcher()
    #expect(!watcher.isRunning)
    controller.putBackTemporarilyShown()
    for _ in 0..<150 where !controller.temporarilyShown.isEmpty { try? await Task.sleep(for: .milliseconds(10)) }
    #expect(controller.temporarilyShown.isEmpty)
    #expect(watcher.isRunning)
    controller.stop()
    #expect(!watcher.isRunning)
}

@Test func returnRejectsMovedAnchorsAndUsesReplacementSeparator() {
    let trip = MenuBarController.PendingReturn(item: 1, order: original())
    let visible = [item(10, role: .control(.alwaysHidden)), item(20, role: .control(.hidden)), item(1), item(2), item(30, role: .control(.toggle))]
    #expect(!trip.isBack(in: visible, excluding: [])) // adjacent to Y, but both visible
    #expect(trip.request(in: visible, excluding: [])?.target == 20)
    let replacement = [item(21, role: .control(.hidden)), item(1), item(30, role: .control(.toggle))]
    #expect(trip.request(in: replacement, excluding: [1])?.target == 21)
}

@Test @MainActor func returnFailureAndDisappearanceResyncWatcher() async {
    for gone in [false, true] {
        let fake = FakeMenuBar(original().filter { $0.windowID != 2 })
        fake.permission = false
        let controller = MenuBarController(settings: .init(), scanner: ItemScanner(snapshot: fake.snapshot),
                                           mover: ItemMover(environment: fake.environment))
        controller.beginSession()
        let watcher = ChangeWatcher(controller: controller, canCaptureImages: { false })
        controller.changeWatcher = watcher
        watcher.update(keys: [item(1).key])
        #expect(watcher.isRunning)
        controller.recordReturn(.init(item: 1, order: fake.snapshot()))
        fake.place(1, before: 30)
        if gone { fake.state.withValue { $0.removeAll { $0.windowID == 1 } } }
        // Leave the old hidden-item timer running; every return outcome must
        // re-evaluate it, even a failed move or a window that disappeared.
        controller.putBackTemporarilyShown()
        #expect(!watcher.isRunning)
        #expect(controller.temporarilyShown.isEmpty == gone)
        #expect(fake.events.get.isEmpty)
        controller.stop()
    }
}

@Test @MainActor func successfulAdjacencyInWrongSectionKeepsReturnRecord() async {
    let fake = FakeMenuBar(original().filter { $0.windowID != 2 })
    fake.acceptMoves = true
    let controller = MenuBarController(settings: .init(), scanner: ItemScanner(snapshot: fake.snapshot),
                                       mover: ItemMover(environment: fake.environment))
    controller.beginSession()
    controller.recordReturn(.init(item: 1, order: fake.snapshot()))
    fake.place(1, before: 30)
    fake.onPost = { input in
        // The worker has checked placement, but another layout change occurs
        // before the main-thread completion accepts the result.
        if case .cursorHidden(false, _) = input { fake.place(1, before: 30) }
    }
    controller.putBackTemporarilyShown()
    for _ in 0..<100 where controller.temporarilyShown[1]?.attempts == 0 { try? await Task.sleep(for: .milliseconds(10)) }
    #expect(controller.temporarilyShown[1]?.attempts == 1)
    fake.permission = false
    controller.stop()
}
