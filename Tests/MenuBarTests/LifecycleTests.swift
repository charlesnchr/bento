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

private func wait(_ semaphore: DispatchSemaphore) {
    #expect(semaphore.wait(timeout: .now() + 3) == .success)
}

private func mainTurn() async {
    await withCheckedContinuation { continuation in DispatchQueue.main.async { continuation.resume() } }
}

private func scanner(environment: ItemScanner.PressEnvironment) -> ItemScanner {
    // Creating a reference performs no IPC. Every read/action is a fake below.
    let element = AXUIElementCreateApplication(42)
    return ItemScanner(owners: [1: .init(pid: 42, appName: "Test", element: element)], pressEnvironment: environment, snapshot: { [] })
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


/// The controller sees only this in-memory snapshot. No controls, desktop
/// observers, permission checks, image capture or real Accessibility calls.
private func controller(_ state: Locked<[MenuBarItem]>, settings: MenuBarSettings = .init()) -> MenuBarController {
    MenuBarController(settings: settings, scanner: ItemScanner(snapshot: { state.get }),
                      environment: .init(usesSystemUI: false, reportError: { _ in }))
}

private func sectionItems() -> [MenuBarItem] {
    [item(1), item(10, role: .control(.alwaysHidden)), item(2), item(20, role: .control(.hidden)), item(3)]
        .enumerated().map { i, item in
            var copy = item
            copy.frame = CGRect(x: 100 + i * 30, y: 0, width: 30, height: 24)
            return copy
        }
}

@Test @MainActor func manualArrangementHoldsSectionsOpenAndRestoresPreviousVisibility() {
    for previous: MenuBarController.Visibility in [.hidden, .shown, .shownAll] {
        let state = Locked(sectionItems())
        let c = controller(state)
        c.start()
        if previous != .hidden { c.show(all: previous == .shownAll, reason: .user) }
        c.beginArrangement()
        c.beginArrangement() // repeated entry must not overwrite the saved visibility
        #expect(c.isArranging && c.visibility == .shownAll)
        c.hide()
        c.toggle(all: false)
        c.triggers.onHoverExit()
        c.triggers.onHide()
        c.show(all: false, reason: .hover)
        c.showForChange(state.get[0])
        c.update(settings: MenuBarSettings())
        #expect(c.isArranging && c.visibility == .shownAll)
        #expect(c.controls.hidden == nil && !c.triggers.isActive)
        c.finishArrangement()
        #expect(!c.isArranging && c.visibility == previous)
        c.finishArrangement()
        #expect(c.visibility == previous)
        c.stop()
    }
}

@Test @MainActor func doneRefreshesSectionsFromNativePositions() {
    let state = Locked(sectionItems())
    let c = controller(state)
    c.start()
    #expect(c.sections()[2] == .hidden)
    c.beginArrangement()
    // Represents a user's native Command-drag; Bento only reads the result.
    state.withValue { items in
        let i = items.firstIndex { $0.windowID == 2 }!
        items[i].frame.origin.x = 300
        items.sort { $0.frame.midX < $1.frame.midX }
    }
    c.finishArrangement()
    #expect(c.sections()[2] == .visible)
    #expect(c.items == state.get)
    #expect(c.settings.layout == SavedLayout())
    c.stop()
}

@Test @MainActor func settingsCanAttachAfterEnableAndReplaceStoppedController() {
    let model = ArrangeModel(capture: { _, done in done([:]) })
    model.attach(nil) // Settings was already open with the module disabled.
    let first = controller(Locked(sectionItems()))
    first.start()
    model.attach(first)
    #expect(model.allItems.count == 3)
    model.begin()
    #expect(model.arranging)
    first.stop()
    #expect(!model.arranging && model.allItems.isEmpty)
    model.attach(nil)
    let second = controller(Locked([item(9)]))
    second.start()
    model.attach(second)
    model.begin()
    first.notify() // a retired controller must not overwrite the current view
    #expect(model.arranging && model.allItems.map(\.windowID) == [9])
    model.detach()
    #expect(!second.isArranging && second.visibility == .hidden)
    #expect(model.allItems.isEmpty && model.images.isEmpty)
    second.stop()
}

@Test @MainActor func replacingSettingsControllerFinishesOldArrangement() {
    let first = controller(Locked(sectionItems()))
    let second = controller(Locked([]))
    first.start(); second.start()
    let model = ArrangeModel(capture: { _, done in done([:]) })
    model.attach(first)
    model.begin()
    model.attach(second)
    #expect(!first.isArranging && first.visibility == .hidden)
    #expect(!model.arranging && model.allItems.isEmpty)
    model.detach()
    first.stop(); second.stop()
}

@Test @MainActor func stopDuringManualArrangementClearsStateWithoutRestorationWork() {
    let state = Locked(sectionItems())
    let c = controller(state)
    c.start()
    c.beginArrangement()
    c.stop()
    c.finishArrangement()
    c.beginArrangement()
    c.activate(state.get[0])
    #expect(!c.isArranging && c.visibility == .hidden && c.items.isEmpty)
    #expect(state.get == sectionItems())
}

@Test @MainActor func legacyMovementSettingsCannotChangeNativeOrder() throws {
    let legacy = try JSONDecoder().decode(MenuBarSettings.self, from: Data(#"""
    {"keepItemsInPlace":true,"layout":{"hidden":["test.app/Item-3"]},
     "profiles":[{"name":"Work","displays":["Built-in Retina Display"],"layout":{"alwaysHidden":["test.app/Item-3"]}}]}
    """#.utf8))
    #expect(legacy.keepItemsInPlace && legacy.profiles.count == 1)
    let original = sectionItems()
    let state = Locked(original)
    let c = controller(state, settings: legacy)
    c.start()
    c.update(settings: legacy)
    c.refresh(details: true)
    c.beginArrangement()
    c.finishArrangement()
    c.show(all: true, reason: .user)
    c.hide()
    #expect(c.sections()[3] == .visible) // both saved layouts request a different section
    #expect(c.items == original && state.get == original)
    #expect(c.settings.layout == legacy.layout && c.settings.profiles == legacy.profiles)
    c.stop()
    #expect(state.get == original)
}

@Test @MainActor func mismatchedAXElementReportsUnavailableWithoutPerformingAction() async {
    let calls = Locked(0)
    let s = scanner(environment: .init(axFrame: { _ in CGRect(x: 1, y: 0, width: 30, height: 24) },
                                      windowFrame: { _ in CGRect(x: 100, y: 0, width: 30, height: 24) },
                                      perform: { _ in calls.withValue { $0 += 1 }; return .success }))
    let pressed = await withCheckedContinuation { continuation in
        s.press(item(1)) { continuation.resume(returning: $0) }
    }
    #expect(!pressed && calls.get == 0)
    s.stop()
}

@Test @MainActor func cancellingAXWorkStillAllowsNextExplicitPress() async {
    let gate = Gate()
    let reads = Locked(0), calls = Locked(0)
    let frame = CGRect(x: 100, y: 0, width: 30, height: 24)
    let s = scanner(environment: .init(axFrame: { _ in
        let first = reads.withValue { n in n += 1; return n == 1 }
        if first { gate.block() }
        return frame
    }, windowFrame: { _ in frame }, perform: { _ in calls.withValue { $0 += 1 }; return .success }))
    var staleCallback = false
    s.press(item(1)) { _ in staleCallback = true }
    gate.waitForEntry()
    s.cancelPresses()
    gate.release.signal()
    let pressed = await withCheckedContinuation { continuation in
        s.press(item(1)) { continuation.resume(returning: $0) }
    }
    #expect(pressed && calls.get == 1 && !staleCallback)
    s.stop()
}

@Test @MainActor func activationRevealsInPlaceAndReportsAXFailureOnce() async {
    let all = sectionItems(), frame = sectionItems()[0].frame
    let calls = Locked(0)
    let element = AXUIElementCreateApplication(42)
    let s = ItemScanner(owners: [1: .init(pid: 42, appName: "Test", element: element)],
                        pressEnvironment: .init(axFrame: { _ in frame }, windowFrame: { _ in frame },
                                                perform: { _ in calls.withValue { $0 += 1 }; return .actionUnsupported }),
                        snapshot: { all })
    var checked = false
    let c = MenuBarController(settings: .init(), scanner: s, environment: .init(usesSystemUI: false,
        canActivate: { _ in checked = true; return true }, reportError: { _ in }))
    c.start()
    c.activate(all[0])
    #expect(c.visibility == .shownAll && checked)
    // Wait only on injected state; no desktop queries or input.
    for _ in 0..<100 where c.lastError == nil { try? await Task.sleep(for: .milliseconds(5)) }
    #expect(c.lastError?.contains("manually") == true)
    #expect(calls.get == 1 && c.items == all)
    c.stop()
}

@Test @MainActor func overflowActivationNeverPressesOrChangesOrder() {
    let all = sectionItems()
    let c = MenuBarController(settings: .init(), scanner: ItemScanner(snapshot: { all }),
                             environment: .init(usesSystemUI: false, canActivate: { _ in false }, reportError: { _ in }))
    c.start()
    c.activate(all[0])
    #expect(c.visibility == .shownAll)
    #expect(c.items == all && c.lastError?.contains("notch") == true)
    c.stop()
}

@Test @MainActor func beginningArrangementCancelsPendingAXActivation() async {
    let all = sectionItems(), frame = sectionItems()[0].frame
    let calls = Locked(0), gate = Gate()
    let s = ItemScanner(owners: [1: .init(pid: 42, appName: "Test", element: AXUIElementCreateApplication(42))],
                        pressEnvironment: .init(axFrame: { _ in gate.block(); return frame }, windowFrame: { _ in frame },
                                                perform: { _ in calls.withValue { $0 += 1 }; return .success }), snapshot: { all })
    let c = MenuBarController(settings: .init(), scanner: s,
                             environment: .init(usesSystemUI: false, canActivate: { _ in true }, reportError: { _ in }))
    c.start()
    c.activate(all[0])
    gate.waitForEntry()
    c.beginArrangement()
    gate.release.signal()
    c.stop() // drains the cancelled frame lookup
    await mainTurn()
    #expect(calls.get == 0 && c.lastError == nil)
}

@Test @MainActor func validatedAXPressSucceedsWithoutAdditionalActions() async {
    for result: AXError in [.success, .cannotComplete] {
        let frame = CGRect(x: 100, y: 0, width: 30, height: 24)
        let calls = Locked(0)
        let s = scanner(environment: .init(axFrame: { _ in frame }, windowFrame: { _ in frame },
                                          perform: { _ in calls.withValue { $0 += 1 }; return result }))
        let pressed = await withCheckedContinuation { continuation in
            s.press(item(1)) { continuation.resume(returning: $0) }
        }
        #expect(pressed && calls.get == 1)
        s.stop()
    }
}

@Test @MainActor func staleItemCannotActivateAReusedWindowID() {
    var replacement = item(1)
    replacement.ownerPID = 100
    replacement.bundleID = "another.app"
    let c = MenuBarController(settings: .init(), scanner: ItemScanner(snapshot: { [replacement] }),
                             environment: .init(usesSystemUI: false, canActivate: { _ in
        Issue.record("Reused window should be rejected before activation")
        return true
    }, reportError: { _ in }))
    c.start()
    c.activate(item(1))
    #expect(c.lastError != nil)
    #expect(c.items == [replacement])
    c.stop()
}

@Test @MainActor func manualArrangementSuspendsAndResumesIconWatcher() {
    let all = sectionItems()
    let c = controller(Locked(all))
    c.start()
    let watcher = ChangeWatcher(controller: c, canCaptureImages: { false })
    c.changeWatcher = watcher
    watcher.update(keys: [all[0].key])
    #expect(watcher.isRunning)
    c.beginArrangement()
    #expect(!watcher.isRunning)
    c.finishArrangement()
    #expect(watcher.isRunning)
    c.stop()
    #expect(!watcher.isRunning)
}
