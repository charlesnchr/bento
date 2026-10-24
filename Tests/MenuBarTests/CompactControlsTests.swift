import CoreGraphics
import Foundation
import Testing
import BentoCore
@testable import MenuBar

private let gskDisplay = MenuBarLayout.RecoveryDisplay(
    frame: CGRect(x: 0, y: 0, width: 1728, height: 1117),
    statusArea: MenuBarLayout.statusArea(screenMinX: 0, screenMaxX: 1728, notch: 771...956, appMenuMaxX: nil))
private let revealed = ControlItems.Expansion(hidden: false, alwaysHidden: false)
private let hidden = ControlItems.Expansion(hidden: true, alwaysHidden: true)

private func frame(_ x: CGFloat, _ width: CGFloat) -> CGRect {
    CGRect(x: x, y: 0, width: width, height: 32)
}

/// Actual collapsed GSKM4 control frames, including windows absent from the
/// native on-screen list. The scanner reads parked windows too.
private func gskItems(compact: Bool = false) -> [MenuBarItem] {
    var items = [
        MenuBarItem(windowID: 1, frame: frame(901, 25), windowName: "Dashed", ownerPID: getpid(),
                    appName: "Bento", role: .control(.alwaysHidden)),
        MenuBarItem(windowID: 2, frame: frame(926, 25), windowName: "Solid", ownerPID: getpid(),
                    appName: "Bento", role: .control(.hidden)),
        MenuBarItem(windowID: 3, frame: frame(951, 23), windowName: "Chevron", ownerPID: getpid(),
                    appName: "Bento", role: .control(.toggle)),
        MenuBarItem(windowID: 4, frame: frame(1123, 38), windowName: "", ownerPID: getpid(),
                    appName: "Bento", role: .bentoIcon),
        MenuBarItem(windowID: 5, frame: frame(974, 38), windowName: "Item-0", ownerPID: 42,
                    appName: "Other", role: .regular),
    ]
    if compact {
        items[0].frame = frame(958, 8)
        items[1].frame = frame(966, 8)
        items.remove(at: 2)
    }
    return items
}

private func needsCompact(_ items: [MenuBarItem], displays: [MenuBarLayout.RecoveryDisplay] = [gskDisplay],
                          showChevron: Bool = true, alwaysHidden: Bool = true) -> Bool {
    MenuBarLayout.needsCompactControls(items: items, displays: displays, showChevron: showChevron,
                                       alwaysHiddenSection: alwaysHidden, ownPID: getpid())
}

@Test func gskNotchNeedsCompactControlsAndExpectedNativeRelayoutFits() {
    let before = gskItems(), after = gskItems(compact: true)
    #expect(needsCompact(before))
    #expect(MenuBarLayout.safeExpansion(items: before, displays: [gskDisplay], showChevron: true, ownPID: getpid()) == revealed)
    #expect(after[0].frame.minX - before[0].frame.minX == 57)
    #expect(after[0].frame.minX == 958 && after[1].frame.maxX == 974)
    #expect(!needsCompact(after, showChevron: false))
    #expect(MenuBarLayout.safeExpansion(items: after, displays: [gskDisplay], showChevron: false, ownPID: getpid()) == hidden)
    #expect(after.filter { $0.role == .regular } == before.filter { $0.role == .regular })
}

@Test func compactDetectionUsesExactStatusAreaEdges() {
    for (x, expected) in [(CGFloat(955.99), true), (956, false), (956.01, false)] {
        var items = gskItems()
        for i in 0..<3 { items[i].frame.origin.x = x + CGFloat(i) * 25 }
        #expect(needsCompact(items) == expected)
    }
    for shellX: CGFloat in [955.99, 1690.01, -100] {
        var items = gskItems()
        items[3].frame.origin.x = shellX
        #expect(!needsCompact(items))
    }
    for shellX: CGFloat in [956, 1690] {
        var items = gskItems()
        items[3].frame.origin.x = shellX
        #expect(needsCompact(items))
    }
    // A chevron alone crossing the notch also qualifies (native user order).
    var items = gskItems()
    items[0].frame.origin.x = 980
    items[1].frame.origin.x = 1005
    #expect(needsCompact(items))
}

@Test func nativeHiddenCollapsedControlsTriggerCompactModeDespiteClearGeometry() {
    var items = gskItems(compact: true)
    items[0].windowIsOnScreen = false // measured at x958 on macOS 15
    items[1].windowIsOnScreen = false // measured at x966 on macOS 15
    #expect(needsCompact(items, showChevron: false))
    items[0].windowIsOnScreen = true
    #expect(needsCompact(items, showChevron: false))
    items[1].windowIsOnScreen = true
    #expect(!needsCompact(items, showChevron: false))
    // Parked dividers remain an expected part of hiding, not crowding evidence.
    items[0].windowIsOnScreen = false
    items[0].frame = frame(-1000, 1928)
    #expect(!needsCompact(items, showChevron: false))
}

@Test func expandedFramesNeverMasqueradeAsCollapsedOverflow() {
    for expandedIndex in [0, 1] {
        var items = gskItems()
        let right = items[expandedIndex].frame.maxX
        items[expandedIndex].frame = frame(right - 5000, 5000)
        #expect(!needsCompact(items))
    }
    var items = gskItems()
    items[1].frame = frame(1100 - 5000, 5000)
    items[0].frame = frame(items[1].frame.minX - 25, 25) // collapsed, but parked by solid
    items[2].frame = frame(1100, 23)
    #expect(!needsCompact(items))
    items[0].frame = frame(items[1].frame.minX - 5000, 5000)
    #expect(!needsCompact(items))
}

@Test func compactDetectionRequiresCompleteUnambiguousGeometryAndShellOwnership() {
    for index in 0..<4 {
        var items = gskItems()
        items.remove(at: index)
        #expect(!needsCompact(items))
        items = gskItems() + [gskItems()[index]]
        if index < 3 { #expect(!needsCompact(items)) }
        for bad in [CGRect.zero, .infinite, .null, frame(.nan, 25), frame(950, -25),
                    CGRect(x: 950, y: 0, width: 25, height: -32)] {
            items = gskItems()
            items[index].frame = bad
            #expect(!needsCompact(items))
        }
    }
    var items = gskItems()
    items[3].role = .regular
    items[3].ownerPID = nil
    #expect(!needsCompact(items))
    items[3].ownerPID = getpid() // unnamed shell window, learned through AX
    #expect(needsCompact(items))
    items[3].ownerPID = 42
    #expect(!needsCompact(items))
    #expect(!needsCompact(gskItems(), displays: []))
    #expect(!needsCompact(gskItems(), displays: [gskDisplay, gskDisplay]))
    #expect(!needsCompact(gskItems(), displays: [.init(frame: .infinite, statusArea: 956...1728)]))
    items = gskItems()
    items[0].frame.origin.y = 1117
    #expect(!needsCompact(items))
    items = gskItems()
    items[2].frame = frame(1720, 23) // shrinking leftwards cannot repair this right edge
    #expect(!needsCompact(items))
}

@Test func compactDetectionRespectsDisabledSectionsAndSecondaryDisplays() {
    var items = gskItems().filter { $0.role != .control(.toggle) && $0.role != .control(.alwaysHidden) }
    #expect(needsCompact(items, showChevron: false, alwaysHidden: false))
    #expect(!needsCompact(items, showChevron: true, alwaysHidden: false))
    #expect(!needsCompact(items, showChevron: false, alwaysHidden: true))
    items = gskItems().map { item in
        var copy = item
        copy.frame = copy.frame.offsetBy(dx: -1728, dy: -1117)
        return copy
    }
    let secondary = MenuBarLayout.RecoveryDisplay(frame: gskDisplay.frame.offsetBy(dx: -1728, dy: -1117),
                                                  statusArea: -772...0)
    #expect(needsCompact(items, displays: [gskDisplay, secondary]))
    items[3] = gskItems()[3]
    #expect(!needsCompact(items, displays: [gskDisplay, secondary]))
}

/// A deterministic native-relayout substitute: no AppKit items, desktop
/// reads, screenshots, timers, preferences or Accessibility calls.
@MainActor private final class CompactHarness {
    var items = gskItems()
    var displays = [gskDisplay]
    var configurations: [(chevron: Bool, alwaysHidden: Bool, compact: Bool, compactShell: Bool?)] = []
    var expansions: [ControlItems.Expansion] = []
    var pending: [() -> Void] = []
    var now: TimeInterval = 0
    let settings: MenuBarSettings
    let sizing: StatusItemSizing?
    lazy var controller = MenuBarController(settings: settings, scanner: ItemScanner(snapshot: { [unowned self] in items }),
        environment: .init(usesSystemUI: false, reportError: { _ in Issue.record("Unexpected HUD") },
            recoveryDisplays: { [unowned self] in displays },
            applyControls: { [unowned self] _, e in expansions.append(e) },
            configureControls: { [unowned self] in configurations.append(($0, $1, $2, sizing?.compactShellIconRequested)) },
            afterControlRelayout: { [unowned self] in pending.append($0) },
            controlRelayoutNow: { [unowned self] in now }, statusItemSizing: sizing))

    init(settings: MenuBarSettings = .init(), sizing: StatusItemSizing? = nil) {
        self.settings = settings
        self.sizing = sizing
    }
    func sample() { now += 0.1; pending.removeFirst()() }
    func settle() {
        for _ in 0..<25 where !pending.isEmpty { sample() }
        #expect(pending.isEmpty)
    }
}

@Test @MainActor func compactShellRequestPrecedesRelayoutAndStopRestoresIt() {
    let sizing = StatusItemSizing(), h = CompactHarness(sizing: sizing)
    let c = h.controller
    c.start()
    #expect(h.configurations.first?.compactShell == true)
    #expect(sizing.compactShellIconRequested && h.pending.count == 1)
    h.items = gskItems(compact: true)
    // Predicted native response to a 38 -> 16 point shell, anchored at its right edge.
    for i in h.items.indices { h.items[i].frame.origin.x += 22 }
    h.items[h.items.firstIndex { $0.role == .bentoIcon }!].frame.size.width = 16
    h.sample()
    #expect(h.expansions == [revealed])
    h.sample()
    #expect(h.expansions == [revealed, hidden] && h.pending.isEmpty)
    #expect(sizing.compactShellIconRequested)
    c.stop()
    #expect(!sizing.compactShellIconRequested && sizing.shellImageSize == 18)
}

@Test @MainActor func interruptedOrFailedCompactRelayoutReleasesShellRequest() {
    for fail in [false, true] {
        let sizing = StatusItemSizing(), h = CompactHarness(sizing: sizing)
        let c = h.controller
        c.start()
        #expect(sizing.compactShellIconRequested)
        if fail {
            h.settle() // unchanged old controls never form a valid compact sample
            #expect(c.lastError != nil && h.expansions.last == revealed)
            #expect(!sizing.compactShellIconRequested)
        }
        c.stop()
        h.settle() // queued samples cannot reinstate the request
        #expect(!sizing.compactShellIconRequested)
    }
}

@Test @MainActor func desktopFreeCompactControllerDoesNotRequestSharedShellChanges() {
    let before = StatusItemSizing.shared.compactShellIconRequested
    let h = CompactHarness(), c = h.controller
    c.start()
    #expect(c.compactControls && StatusItemSizing.shared.compactShellIconRequested == before)
    c.stop()
    #expect(StatusItemSizing.shared.compactShellIconRequested == before)
}

@Test @MainActor func discardedCompactControllerReleasesShellRequest() {
    let sizing = StatusItemSizing()
    weak var retired: MenuBarController?
    do {
        let h = CompactHarness(sizing: sizing)
        h.controller.start()
        retired = h.controller
        #expect(sizing.compactShellIconRequested)
    }
    #expect(retired == nil && !sizing.compactShellIconRequested)
}

@Test @MainActor func compactRelayoutWaitsForFreshGeometryAndKeepsFirstSetupSectionsEmpty() {
    let h = CompactHarness(), settings = MenuBarSettings()
    let c = h.controller
    c.start()
    defer { c.stop() }
    #expect(c.compactControls && !c.effectiveShowChevron && c.settings == settings)
    #expect(h.configurations.count == 1 && h.pending.count == 1)
    #expect(h.configurations[0].compact && !h.configurations[0].chevron && h.configurations[0].alwaysHidden)
    #expect(h.expansions == [revealed])
    c.show(all: true, reason: .user)
    c.hide()
    c.beginArrangement()
    c.finishArrangement()
    #expect(h.expansions == [revealed] && h.pending.count == 1)
    h.items = gskItems(compact: true)
    h.settle()
    #expect(h.expansions == [revealed, hidden])
    #expect(c.items == h.items && c.settings == settings && c.lastError == nil)
    #expect(c.arrangement()[.hidden]?.isEmpty == true && c.arrangement()[.alwaysHidden]?.isEmpty == true)
    #expect(c.controls.hidden == nil && c.controls.toggle == nil && !c.triggers.isActive)
    for _ in 0..<4 { c.beginArrangement(); c.finishArrangement() }
    #expect(h.configurations.count == 1 && h.pending.isEmpty) // no repeated compact attempts
}

@Test @MainActor func failedCompactRelayoutOrLostOwnershipStaysRevealedWithoutRetrying() {
    for outcome in 0..<3 {
        let h = CompactHarness(), c = h.controller
        c.start()
        if outcome > 0 {
            h.items = gskItems(compact: true)
            let i = h.items.firstIndex { $0.role == .bentoIcon }!
            if outcome == 1 { h.items[i].frame.origin.x = 950 }
            else { h.items[i].ownerPID = nil; h.items[i].role = .regular }
        } // outcome 0 retains the old chevron across the one relayout
        h.settle()
        #expect(h.expansions.last == revealed && c.lastError != nil)
        for _ in 0..<3 { c.beginArrangement(); c.finishArrangement() }
        #expect(h.expansions.allSatisfy { $0 == revealed })
        #expect(h.configurations.count == 1 && h.pending.isEmpty)
        c.stop()
    }
}

@Test @MainActor func compactRelayoutHonoursLatestSettingsArrangementAndDisplay() {
    let h = CompactHarness(), c = h.controller
    c.start()
    var settings = c.settings
    settings.alwaysHiddenSection = false
    settings.showChevron = false
    c.update(settings: settings)
    settings.showChevron = true
    c.update(settings: settings)
    #expect(c.settings == settings && !c.effectiveShowChevron)
    #expect(h.configurations.allSatisfy { !$0.chevron && $0.compact })
    #expect(!h.configurations.last!.alwaysHidden)
    h.items = gskItems(compact: true).filter { $0.role != .control(.alwaysHidden) }
    h.sample() // superseded startup relayout
    h.sample() // superseded Settings relayout
    #expect(h.expansions.allSatisfy { $0 == revealed })
    c.beginArrangement()
    h.settle()
    #expect(c.isArranging && h.expansions.last == revealed)
    c.finishArrangement()
    #expect(h.expansions.last == .init(hidden: true, alwaysHidden: false))
    c.screensChanged()
    h.displays = [] // display vanished during relayout; old coordinates cannot authorize hiding
    h.settle()
    #expect(h.expansions.last == revealed && c.lastError != nil)
    h.displays = [gskDisplay]
    c.screensChanged()
    h.settle()
    #expect(h.expansions.last == .init(hidden: true, alwaysHidden: false))
    #expect(c.compactControls && c.settings == settings && h.pending.isEmpty)
    c.stop()
}

@Test @MainActor func stoppedControllerDropsPendingRelayoutAndSettingsExplanation() {
    let h = CompactHarness(), c = h.controller
    let model = ArrangeModel(capture: { _, done in done([:]) })
    c.start()
    model.attach(c)
    #expect(model.compactControls)
    let before = h.expansions
    c.stop()
    h.settle()
    #expect(h.expansions == before && h.configurations.count == 1)
    #expect(!c.compactControls && !model.compactControls && c.items.isEmpty)
    #expect(c.settings == h.settings)
    model.detach()
}

@Test @MainActor func controllerDoesNotCompactOnExpandedGeometryOrUnknownShell() {
    for expanded in [false, true] {
        let h = CompactHarness(), c = h.controller
        if expanded {
            h.items[1].frame = frame(1100 - 5000, 5000)
            h.items[0].frame = frame(h.items[1].frame.minX - 5000, 5000)
            h.items[2].frame = frame(1100, 23)
        } else {
            h.items[3].ownerPID = nil
            h.items[3].role = .regular
        }
        c.start()
        #expect(!c.compactControls && h.configurations.isEmpty && h.pending.isEmpty)
        #expect(h.expansions == [expanded ? hidden : revealed])
        c.stop()
    }
}
