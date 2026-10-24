import CoreGraphics
import Foundation
import Testing
@testable import MenuBar

private let revealed = ControlItems.Expansion(hidden: false, alwaysHidden: false)
private let hidden = ControlItems.Expansion(hidden: true, alwaysHidden: true)

/// Replays the enable-on-macOS-26 trace without creating any native items.
private func enableItems(animating: Bool) -> [MenuBarItem] {
    let frames: [CGRect] = animating ? [
        .init(x: 931, y: 2, width: 21, height: 29),
        .init(x: 956, y: 2, width: 21, height: 29),
        .init(x: 980, y: 2, width: 21, height: 29),
    ] : [
        .init(x: 929, y: 0, width: 25, height: 33),
        .init(x: 954, y: 0, width: 25, height: 33),
        .init(x: 979, y: 0, width: 23, height: 33),
    ]
    let roles: [MenuBarItem.Role] = [.control(.alwaysHidden), .control(.hidden), .control(.toggle)]
    return zip(frames, roles).enumerated().map { i, pair in
        MenuBarItem(windowID: UInt32(i + 1), frame: pair.0, windowName: "Control-\(i)",
                    ownerPID: getpid(), appName: "Bento", role: pair.1)
    } + [MenuBarItem(windowID: 4, frame: .init(x: 1078, y: 0, width: 38, height: 33),
                     windowName: "", ownerPID: getpid(), appName: "Bento", role: .bentoIcon)]
}

@MainActor private final class SettlingHarness {
    var items = enableItems(animating: true)
    var displays = [MenuBarLayout.RecoveryDisplay(frame: .init(x: 0, y: 0, width: 1512, height: 982),
                                                   statusArea: 848...1512)]
    var configurations = 0
    var expansions: [ControlItems.Expansion] = []
    var pending: [() -> Void] = []
    var now: TimeInterval = 0
    var ticks = 0
    var holdOwners = false
    var ownerReads: [() -> Void] = []
    lazy var controller = MenuBarController(settings: .init(), scanner: ItemScanner(snapshot: { [unowned self] in items }),
        environment: .init(usesSystemUI: false, reportError: { _ in Issue.record("Unexpected HUD") },
            recoveryDisplays: { [unowned self] in displays },
            applyControls: { [unowned self] _, e in expansions.append(e) },
            configureControls: { [unowned self] _, _, _ in configurations += 1 },
            afterControlRelayout: { [unowned self] in pending.append($0) },
            controlRelayoutNow: { [unowned self] in now },
            resolveControlOwners: { [unowned self] _, done in
                if holdOwners { ownerReads.append(done) } else { done() }
            }))

    func startRelayout() {
        // System UI is disabled; screensChanged enters the same relayout as
        // native startup without creating status items or reading the desktop.
        controller.start()
        expansions = []
        controller.screensChanged()
    }

    func tick() {
        guard !pending.isEmpty else { return }
        now += 0.1
        ticks += 1
        pending.removeFirst()()
    }
}

@Test @MainActor func relayoutReadinessResetsAfterAnimationOrDisplayChanges() {
    let h = SettlingHarness(), c = h.controller
    h.startRelayout()
    defer { c.stop() }
    h.items = enableItems(animating: false)
    h.tick()
    h.items = enableItems(animating: true)
    h.tick()
    h.items = enableItems(animating: false)
    h.tick()
    #expect(h.expansions == [revealed])
    h.displays[0].statusArea = 900...1512
    h.tick() // a different status area cannot confirm the previous sample
    #expect(h.expansions == [revealed])
    c.beginArrangement()
    h.tick()
    #expect(c.isArranging && h.expansions.last == revealed && h.pending.isEmpty)
    c.finishArrangement()
    #expect(h.expansions.last == hidden && c.lastError == nil)
}

@Test @MainActor func relayoutCompactsOnlyAfterCollapsedNotchGeometrySettles() {
    let h = SettlingHarness(), c = h.controller
    for i in 0..<3 { h.items[i].frame.origin.x -= 100 }
    h.startRelayout()
    defer { c.stop() }
    h.tick()
    #expect(!c.compactControls && h.configurations == 1)
    h.items = enableItems(animating: false)
    for i in 0..<3 { h.items[i].frame.origin.x -= 100 }
    h.tick()
    #expect(!c.compactControls && h.configurations == 1)
    h.tick()
    #expect(c.compactControls && h.configurations == 2 && h.expansions == [revealed, revealed])
    h.items.remove(at: 2)
    h.items[0].frame = .init(x: 870, y: 0, width: 8, height: 33)
    h.items[1].frame = .init(x: 878, y: 0, width: 8, height: 33)
    h.tick()
    #expect(h.expansions == [revealed, revealed])
    h.tick()
    #expect(h.expansions.last == hidden && c.lastError == nil && h.pending.isEmpty)
    #expect(h.configurations == 2)
}

@Test @MainActor func relayoutNeverTreatsExpandedWindowsAsCompactEvidence() {
    let h = SettlingHarness(), c = h.controller
    h.startRelayout()
    defer { c.stop() }
    h.items = enableItems(animating: false)
    h.items[1].frame = .init(x: -4021, y: 0, width: 5000, height: 33)
    h.items[0].frame = .init(x: -4046, y: 0, width: 25, height: 33)
    for _ in 0..<40 { h.tick() }
    #expect(!c.compactControls && h.configurations == 1 && h.pending.isEmpty)
    #expect(h.expansions.allSatisfy { $0 == revealed } && c.lastError != nil)
}

@Test @MainActor func relayoutDeadlineDoesNotWaitForOwnerLookupOrAcceptItsLateCompletion() throws {
    let h = SettlingHarness(), c = h.controller
    h.items[3].role = .regular
    h.items[3].ownerPID = nil
    h.holdOwners = true
    h.startRelayout()
    defer { c.stop() }
    for _ in 0..<40 { h.tick() }
    #expect((20...21).contains(h.ticks) && h.pending.isEmpty && h.ownerReads.count == 1)
    #expect(h.expansions == [revealed, revealed] && c.lastError != nil)
    let before = c.items
    h.items = enableItems(animating: false)
    let late = try #require(h.ownerReads.first)
    late()
    #expect(c.items == before && h.pending.isEmpty && h.expansions == [revealed, revealed])
}

@Test @MainActor func supersededOwnerCallbackCannotChangeTheNewRelayoutOrStoppedController() throws {
    let h = SettlingHarness(), c = h.controller
    h.holdOwners = true
    h.startRelayout()
    defer { c.stop() }
    h.tick()
    let stale = try #require(h.ownerReads.first)
    c.screensChanged()
    h.tick() // drop the previous generation's scheduled sample
    h.tick() // start the new generation's owner lookup
    #expect(h.ownerReads.count == 2)
    stale()
    h.tick()
    #expect(h.ownerReads.count == 2) // the current lookup is still pending
    let before = h.expansions
    c.stop()
    h.ownerReads.forEach { $0() }
    h.tick()
    #expect(c.items.isEmpty && h.expansions == before && h.pending.isEmpty)
}

@Test func settlingSampleRequiresFullRowAndIgnoresUnrelatedItemUpdates() {
    let display = MenuBarLayout.RecoveryDisplay(frame: .init(x: 0, y: 0, width: 1512, height: 982),
                                                statusArea: 848...1512)
    func sample(_ items: [MenuBarItem]) -> MenuBarLayout.ControlLayoutSample? {
        MenuBarLayout.controlLayoutSample(items: items, displays: [display],
            showChevron: true, alwaysHiddenSection: true, ownPID: getpid())
    }
    let full = enableItems(animating: false)
    #expect(sample(full) != nil && sample(enableItems(animating: true)) == nil)
    var shortened = full
    shortened[0].frame.size.height = 29 // top aligned, but still inset at the bottom
    #expect(sample(shortened) == nil)
    var notch = full
    notch[0].frame.origin.x = 830
    #expect(sample(notch) != nil) // readiness must permit the compact fallback
    var unrelated = full
    unrelated.append(MenuBarItem(windowID: 9, frame: .zero, windowName: "Changing", ownerPID: 42, appName: "Other"))
    #expect(sample(full) == sample(unrelated.reversed()))
    #expect(sample(full + [full[0]]) == nil)
}

@Test @MainActor func relayoutStopsAtDeadlineWhenFramesNeverBecomeReady() {
    let h = SettlingHarness(), c = h.controller
    h.startRelayout()
    defer { c.stop() }
    for _ in 0..<40 { h.tick() }
    #expect((20...21).contains(h.ticks) && h.pending.isEmpty)
    #expect(h.expansions == [revealed, revealed] && c.lastError != nil)
    #expect(h.configurations == 1 && !c.compactControls)
}

@Test @MainActor func relayoutDeadlineCannotAuthorizeOneGoodOrContinuouslyMovingSample() {
    for moving in [false, true] {
        let h = SettlingHarness(), c = h.controller
        h.startRelayout()
        if !moving { h.now = 2 }
        h.items = enableItems(animating: false)
        for _ in 0..<40 {
            if moving { h.items[0].frame.origin.x += 0.01 }
            h.tick()
        }
        #expect(h.pending.isEmpty && h.expansions.allSatisfy { $0 == revealed })
        #expect(c.lastError != nil && h.configurations == 1)
        c.stop()
    }
}

@Test @MainActor func relayoutDropsSupersededAndStoppedSamplingCallbacks() throws {
    let h = SettlingHarness(), c = h.controller
    h.startRelayout()
    defer { c.stop() }
    let stale = h.pending.removeFirst()
    c.screensChanged()
    let before = h.expansions
    h.items = enableItems(animating: false)
    stale()
    #expect(h.expansions == before && h.pending.count == 1)
    h.tick() // first valid sample in the replacement generation
    let stopped = try #require(h.pending.first)
    c.stop()
    stopped()
    #expect(h.expansions == before && c.items.isEmpty && !c.compactControls)
}

@Test @MainActor func relayoutWaitsForTwoFullRowSnapshotsAfterInsertionAnimation() {
    let h = SettlingHarness(), c = h.controller
    h.startRelayout()
    defer { c.stop() }
    h.tick() // inset animation frames from the failing native trace
    #expect(h.expansions == [revealed] && h.pending.count == 1)
    h.items = enableItems(animating: false)
    h.tick() // one good sample cannot establish stability
    #expect(h.expansions == [revealed] && h.pending.count == 1)
    h.tick()
    #expect(h.expansions == [revealed, hidden] && h.pending.isEmpty)
    #expect(c.lastError == nil && c.items == h.items && h.configurations == 1)
}
