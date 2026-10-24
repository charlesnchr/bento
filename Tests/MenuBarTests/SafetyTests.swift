import CoreGraphics
import Foundation
import Testing
@testable import MenuBar

// The rules that keep the user's items where they put them.

// MARK: - Separators

@Test func separatorsForEveryStateWhenInPlace() {
    typealias E = ControlItems.Expansion
    #expect(ControlItems.expansion(.hidden, allowed: E(hidden: true, alwaysHidden: true)) == E(hidden: true, alwaysHidden: true))
    #expect(ControlItems.expansion(.shown, allowed: E(hidden: true, alwaysHidden: true)) == E(hidden: false, alwaysHidden: true))
    #expect(ControlItems.expansion(.shownAll, allowed: E(hidden: true, alwaysHidden: true)) == E(hidden: false, alwaysHidden: false))
}

@Test func misplacedAlwaysHiddenSeparatorNeverExpands() {
    // Right of the hidden separator, between visible items: expanded, it
    // would hide them (and the chevron or Bento's icon left of it).
    typealias E = ControlItems.Expansion
    #expect(ControlItems.expansion(.hidden, allowed: E(hidden: true, alwaysHidden: false)) == E(hidden: true, alwaysHidden: false))
    #expect(ControlItems.expansion(.shown, allowed: E(hidden: true, alwaysHidden: false)) == E(hidden: false, alwaysHidden: false))
    #expect(ControlItems.expansion(.shownAll, allowed: E(hidden: true, alwaysHidden: false)) == E(hidden: false, alwaysHidden: false))
}

// MARK: - Recovery controls (injected geometry, no desktop access)

private let recoveryDisplay = MenuBarLayout.RecoveryDisplay(
    frame: CGRect(x: 0, y: 0, width: 1512, height: 982), statusArea: 848...1512)

private func recoveryItems() -> [MenuBarItem] {
    [(ControlItems.Kind.alwaysHidden, CGFloat(900)), (.hidden, 1050), (.toggle, 1200)]
        .enumerated().map { index, entry in
            MenuBarItem(windowID: UInt32(index + 1), frame: frame(entry.1), windowName: entry.0.rawValue,
                        ownerPID: 42, bundleID: "bento", appName: "Bento", role: .control(entry.0))
        } + [MenuBarItem(windowID: 4, frame: frame(1250), windowName: "", ownerPID: 42,
                         bundleID: "bento", appName: "Bento", role: .bentoIcon)]
}

private func safe(_ items: [MenuBarItem], displays: [MenuBarLayout.RecoveryDisplay] = [recoveryDisplay],
                  showChevron: Bool = true) -> ControlItems.Expansion {
    MenuBarLayout.safeExpansion(items: items, displays: displays, showChevron: showChevron, ownPID: 42)
}

@Test func savedPositionsOnEitherSideOfEachRecoveryControl() {
    for recoveryIndex in [2, 3] { // chevron and shell, independently
        for (x, expected) in [(CGFloat(850), ControlItems.Expansion(hidden: false, alwaysHidden: false)),
                              (970, .init(hidden: false, alwaysHidden: true)),
                              (1150, .init(hidden: true, alwaysHidden: true))] {
            var items = recoveryItems()
            items[recoveryIndex].frame = frame(x)
            #expect(safe(items) == expected)
            #expect(ControlItems.expansion(.hidden, allowed: safe(items)) == expected)
            #expect(ControlItems.expansion(.shown, allowed: safe(items)) == .init(hidden: false, alwaysHidden: expected.alwaysHidden))
            #expect(ControlItems.expansion(.shownAll, allowed: safe(items)) == .init(hidden: false, alwaysHidden: false))
        }
    }
}

@Test func recoveryGuardRetainsDashedSeparatorOrderingRule() {
    var items = recoveryItems()
    items[0].frame = frame(1100)
    #expect(safe(items) == .init(hidden: true, alwaysHidden: false))
    items[0].frame = frame(1300) // also to the right of both recovery controls
    #expect(safe(items) == .init(hidden: true, alwaysHidden: false))
}

@Test func expandedEdgesAndParkedRecoveryControlsAreHandledConservatively() {
    var items = recoveryItems()
    items[1].frame = frame(1080 - 5000, 5000)
    items[0].frame = frame(items[1].frame.minX - 100 - 5000, 5000)
    #expect(safe(items) == .init(hidden: true, alwaysHidden: true))
    items[3].frame = frame(-4000) // a shell icon already hidden by restored boundaries
    #expect(safe(items) == .init(hidden: false, alwaysHidden: false))

    items = recoveryItems()
    items[3].frame = frame(1070) // centre is right of the separator, but frames overlap
    #expect(!safe(items).hidden)
    items[3].frame = frame(1080) // exact adjacent edge is safe
    #expect(safe(items).hidden)
}

@Test func missingUnresolvedAndMalformedRecoveryGeometryNeverExpands() {
    let collapsed = ControlItems.Expansion(hidden: false, alwaysHidden: false)
    for index in [1, 2, 3] {
        var items = recoveryItems()
        items.remove(at: index)
        #expect(safe(items) == collapsed)
    }
    for bad in [CGRect.zero, .null, .infinite, frame(.nan), frame(.infinity), frame(1200, -30),
                CGRect(x: 1200, y: 0, width: 30, height: -24),
                CGRect(x: 1200, y: CGFloat.nan, width: 30, height: 24)] {
        for index in [1, 2, 3] {
            var items = recoveryItems()
            items[index].frame = bad
            #expect(safe(items) == collapsed, "Invalid frame \(bad) at index \(index)")
        }
    }
    #expect(safe(recoveryItems(), displays: []) == collapsed)
    #expect(safe(recoveryItems(), displays: [recoveryDisplay, recoveryDisplay]) == collapsed)
    #expect(safe(recoveryItems(), displays: [.init(frame: .infinite, statusArea: 0...1512)]) == collapsed)
    #expect(safe(recoveryItems() + [recoveryItems()[1]]) == collapsed)
    var unknown = recoveryItems()
    unknown[3].role = .regular
    unknown[3].ownerPID = nil
    #expect(safe(unknown) == collapsed)
    unknown[3].ownerPID = 42 // a shell-owned item with no autosave name or special role
    #expect(safe(unknown) == .init(hidden: true, alwaysHidden: true))
    unknown[3].ownerPID = 99 // another Bento process does not prove our shell is safe
    #expect(safe(unknown) == collapsed)
}

@Test func notchDisplayEdgesAndSecondaryDisplayCoordinates() {
    let collapsed = ControlItems.Expansion(hidden: false, alwaysHidden: false)
    for x: CGFloat in [830, 1490, -20] { // notch, partly past right edge, off-screen
        var items = recoveryItems()
        items[3].frame = frame(x)
        #expect(safe(items) == collapsed)
    }
    // A display left of and above the primary uses negative AX coordinates.
    let shifted = recoveryItems().map { item in
        var copy = item
        copy.frame = copy.frame.offsetBy(dx: -1512, dy: -982)
        return copy
    }
    let secondary = MenuBarLayout.RecoveryDisplay(frame: recoveryDisplay.frame.offsetBy(dx: -1512, dy: -982),
                                                  statusArea: -664...0)
    #expect(safe(shifted, displays: [recoveryDisplay, secondary]) == .init(hidden: true, alwaysHidden: true))
    var mixed = shifted
    mixed[3] = recoveryItems()[3]
    #expect(safe(mixed, displays: [recoveryDisplay, secondary]) == collapsed)
    mixed = shifted
    mixed[1] = recoveryItems()[1] // same numeric ordering cannot establish the menu row
    #expect(safe(mixed, displays: [recoveryDisplay, secondary]) == collapsed)
}

@Test func optionalChevronAndAdditionalShellItems() {
    var items = recoveryItems()
    items.remove(at: 2)
    #expect(safe(items, showChevron: false) == .init(hidden: true, alwaysHidden: true))
    // Even with the chevron disabled the shell must be identifiable and visible.
    items.removeLast()
    #expect(safe(items, showChevron: false) == .init(hidden: false, alwaysHidden: false))
    items = recoveryItems()
    var extra = barItem(5, "ShellExtra", x: 970, owner: 42)
    items.append(extra)
    #expect(safe(items) == .init(hidden: false, alwaysHidden: true))
    extra.frame = frame(-4000)
    items[4] = extra
    #expect(safe(items) == .init(hidden: false, alwaysHidden: false))
}

@Test @MainActor func startupAppliesGuardToRestoredPositionsBeforeAnyExpansion() {
    for index in [2, 3] {
        for (dashedX, solidX, expected) in [
            (CGFloat(850), CGFloat(950), ControlItems.Expansion(hidden: true, alwaysHidden: true)),
            (850, 1100, .init(hidden: false, alwaysHidden: true)),
            (1100, 1150, .init(hidden: false, alwaysHidden: false)),
        ] {
            var items = recoveryItems()
            items[index].frame = frame(1000)
            // The saved native separator positions are restored during creation.
            items[0].frame = frame(dashedX)
            items[1].frame = frame(solidX)
            var applied: [ControlItems.Expansion] = []
            let c = MenuBarController(settings: .init(), scanner: ItemScanner(snapshot: { items }),
                environment: .init(usesSystemUI: false, reportError: { _ in Issue.record("Unexpected HUD") },
                    recoveryDisplays: { [recoveryDisplay] }, applyControls: { _, e in applied.append(e) }))
            c.start()
            #expect(applied == [expected])
            #expect(c.visibility == .hidden)
            #expect((c.lastError != nil) == !expected.hidden)
            if !expected.hidden { #expect(c.lastError?.contains("Arrange in Menu Bar") == true) }
            #expect(c.controls.hidden == nil && c.controls.toggle == nil)
            c.stop()
        }
    }
}

@Test @MainActor func hideAndDoneUseFreshGeometryAndClearRecoveryExplanationAfterManualRepair() {
    var items = recoveryItems()
    var applied: [ControlItems.Expansion] = []
    let c = MenuBarController(settings: .init(), scanner: ItemScanner(snapshot: { items }),
        environment: .init(usesSystemUI: false, reportError: { _ in }, recoveryDisplays: { [recoveryDisplay] },
                           applyControls: { _, e in applied.append(e) }))
    c.start()
    #expect(applied.last == .init(hidden: true, alwaysHidden: true))
    c.show(all: true, reason: .user)
    items[3].frame = frame(850)
    c.hide()
    #expect(applied.last == .init(hidden: false, alwaysHidden: false))
    #expect(c.lastError?.contains("Arrange in Menu Bar") == true)
    c.beginArrangement()
    c.finishArrangement() // Done without fixing the positions must remain safe
    #expect(applied.last == .init(hidden: false, alwaysHidden: false))
    c.beginArrangement()
    items[3].frame = frame(1250) // injected result of the user's manual Command-drag
    c.finishArrangement()
    #expect(applied.last == .init(hidden: true, alwaysHidden: true))
    #expect(c.lastError == nil && c.items == items)
    c.stop()
}

@Test @MainActor func startupWithNoGeometryStaysCollapsedAndSectionSettingsAreRespected() {
    var items: [MenuBarItem] = []
    var applied: [ControlItems.Expansion] = []
    var settings = MenuBarSettings()
    settings.showChevron = false
    settings.alwaysHiddenSection = false
    let c = MenuBarController(settings: settings, scanner: ItemScanner(snapshot: { items }),
        environment: .init(usesSystemUI: false, reportError: { _ in }, recoveryDisplays: { [recoveryDisplay] },
                           applyControls: { _, e in applied.append(e) }))
    c.start()
    #expect(applied == [.init(hidden: false, alwaysHidden: false)])
    items = recoveryItems().filter { $0.role != .control(.toggle) }
    c.beginArrangement()
    c.finishArrangement()
    #expect(applied.last == .init(hidden: true, alwaysHidden: false))
    settings.showChevron = true // a newly created chevron has not appeared in the snapshot yet
    c.update(settings: settings)
    #expect(applied.last == .init(hidden: false, alwaysHidden: false))
    c.stop()
}

// MARK: - Show when the icon changes

private func barItem(_ id: CGWindowID, _ name: String, x: CGFloat, owner: pid_t? = 42) -> MenuBarItem {
    MenuBarItem(windowID: id, frame: CGRect(x: x, y: 0, width: 30, height: 24), windowName: name,
                ownerPID: owner, bundleID: owner == nil ? nil : "app.\(name.lowercased())", appName: name, detail: nil)
}

@Test func watcherLooksOnlyAtPickedHiddenItems() {
    let x = barItem(1, "X", x: -400), z = barItem(2, "Z", x: -900), v = barItem(3, "V", x: 700)
    let sections: [CGWindowID: MenuBarSection] = [1: .hidden, 2: .alwaysHidden, 3: .visible]
    let all = [x, z, v]
    #expect(ChangeWatcher.watched(all, sections: sections, keys: [x.key, z.key, v.key]).map(\.windowID) == [1, 2])
    // Only a visible item picked, or a picked app that isn't running: nothing to poll.
    #expect(ChangeWatcher.watched(all, sections: sections, keys: [v.key]).isEmpty)
    #expect(ChangeWatcher.watched(all, sections: sections, keys: ["app.gone/Gone"]).isEmpty)
    #expect(ChangeWatcher.watched(all, sections: sections, keys: []).isEmpty)
    // The picked item's app quit: its window is gone from the list.
    #expect(ChangeWatcher.watched([z, v], sections: sections, keys: [x.key]).isEmpty)
}

@Test func watcherIgnoresItemsWithoutAnOwnerOrSection() {
    // No owner yet: no stable key, so it can't be a picked item.
    let unresolved = barItem(1, "X", x: -400, owner: nil)
    #expect(ChangeWatcher.watched([unresolved], sections: [1: .hidden], keys: ["app.x/X"]).isEmpty)
    // No section known counts as visible (in view).
    let x = barItem(2, "X", x: 400)
    #expect(ChangeWatcher.watched([x], sections: [:], keys: [x.key]).isEmpty)
}

// MARK: - Owners from Accessibility

private func frame(_ x: CGFloat, _ w: CGFloat = 30) -> CGRect { CGRect(x: x, y: 0, width: w, height: 24) }

@Test func ownersMatchWindowsThatStayedPut() {
    let before: [UInt32: CGRect] = [1: frame(100), 2: frame(130)]
    let r = MenuBarLayout.matchOwners(before: before, after: before, elements: [frame(130.5), frame(100)])
    #expect(r.matched == [1: 1, 2: 0])
    #expect(r.moved.isEmpty)
}

@Test func swappedItemsAreNotMatchedToEachOthersElements() {
    // X at 100 and Y at 130 swap while the elements are read: by their old
    // places, X would get Y's element (and pressing X would open Y's menu).
    let before: [UInt32: CGRect] = [1: frame(100), 2: frame(130)]
    let after: [UInt32: CGRect] = [1: frame(130), 2: frame(100)]
    let r = MenuBarLayout.matchOwners(before: before, after: after, elements: [frame(130), frame(100)])
    #expect(r.matched.isEmpty)
    #expect(r.moved == [1, 2])
}

@Test func onlyTheItemsThatMovedAreLeftOut() {
    // An item left of one that grew shifts; the others still match.
    let before: [UInt32: CGRect] = [1: frame(100), 2: frame(130), 3: frame(200)]
    let after: [UInt32: CGRect] = [1: frame(92), 2: frame(130), 3: frame(200)]
    let r = MenuBarLayout.matchOwners(before: before, after: after, elements: [frame(92), frame(130), frame(200)])
    #expect(r.matched == [2: 1, 3: 2])
    #expect(r.moved == [1])
    // A window that's gone counts as moved; an element nowhere near matches nothing.
    let gone = MenuBarLayout.matchOwners(before: [1: frame(100), 2: frame(300)], after: [2: frame(300)], elements: [frame(100), frame(250)])
    #expect(gone.matched.isEmpty)
    #expect(gone.moved == [1])
}

@Test func sameItemTolerance() {
    #expect(MenuBarLayout.sameItem(frame(100), frame(101.5)))
    #expect(!MenuBarLayout.sameItem(frame(100), frame(103)))
    #expect(!MenuBarLayout.sameItem(frame(100), frame(100).offsetBy(dx: 0, dy: 4)))
}

// MARK: - Structural boundary: MenuBar has no cursor or synthetic input API

private func menuBarSources() throws -> [(URL, String)] {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent("Sources/MenuBar")
    return try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
        .filter { $0.pathExtension == "swift" }
        .map { ($0, try String(contentsOf: $0)) }
}

@Test func menuBarHasNoCursorOrSyntheticInputPath() throws {
    let sources = try menuBarSources()
    #expect(!sources.isEmpty)
    let forbidden = ["ItemMover", "CGEvent", "CGPost", "CGWarp", "CGDisplayHideCursor", "CGDisplayShowCursor",
                     "CGAssociateMouse", "NSCursor", "SetsCursorInBackground", "CGSSetConnectionProperty",
                     "CGSPost", "IOHIDPostEvent", "Keyboard.", "NSEvent.mouseEvent", "NSEvent.keyEvent",
                     "AXUIElementSetAttributeValue", "osascript", "Process("]
    for (file, source) in sources {
        for api in forbidden { #expect(!source.contains(api), "\(file.lastPathComponent) contains \(api)") }
    }
}

@Test func legacyLayoutsHaveNoRuntimeConsumerOrMovementUI() throws {
    for (file, source) in try menuBarSources() where file.lastPathComponent != "MenuBarSettings.swift" {
        for removed in ["keepItemsInPlace", ".profiles", "settings.layout", "applyProfile", "applyDisplayProfile",
                        "planMoves", "PendingReturn", "temporarilyShow", "restorePlaces", "learnLayout",
                        ".draggable(", ".dropDestination(", "Move to ", "Right-Click", "menubar.profile-"] {
            #expect(!source.contains(removed), "\(file.lastPathComponent) still contains \(removed)")
        }
    }
}
