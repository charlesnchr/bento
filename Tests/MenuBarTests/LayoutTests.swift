import CoreGraphics
import Foundation
import Testing
@testable import MenuBar

private func item(_ key: String, _ minX: CGFloat, _ width: CGFloat = 30) -> LayoutItem {
    LayoutItem(key: key, minX: minX, width: width)
}

/// Applies planned moves to an order the way macOS would (pure simulation).
private func apply(_ moves: [PlannedMove], to order: [String]) -> [String] {
    var out = order
    for m in moves {
        out.removeAll { $0 == m.key }
        guard let t = out.firstIndex(of: m.destination.target) else { continue }
        switch m.destination {
        case .leftOf: out.insert(m.key, at: t)
        case .rightOf: out.insert(m.key, at: t + 1)
        }
    }
    return out
}

// MARK: - Sections

@Test func sectionsFromCollapsedSeparators() {
    let hiddenSep = item("H", 500, 12)
    let alwaysSep = item("A", 400, 12)
    let items = [item("clock", 900), item("wifi", 700), item("x", 450), item("y", 300), item("z", 520)]
    let s = MenuBarLayout.sections(of: items, hiddenSeparator: hiddenSep, alwaysHiddenSeparator: alwaysSep)
    #expect(s["clock"] == .visible)
    #expect(s["wifi"] == .visible)
    #expect(s["z"] == .visible)
    #expect(s["x"] == .hidden)
    #expect(s["y"] == .alwaysHidden)
}

@Test func sectionsWithExpandedSeparators() {
    // Hidden: the separator spans 10 000 pt to the left of its right edge and
    // everything left of it is pushed off-screen, in order.
    let hiddenSep = item("H", 600 - 10_000, 10_000)
    let alwaysSep = item("A", 600 - 10_000 - 60 - 10_000, 10_000)
    let items = [item("v", 620), item("h1", 600 - 10_000 - 30), item("h2", 600 - 10_000 - 60),
                 item("a1", 600 - 20_000 - 90)]
    let s = MenuBarLayout.sections(of: items, hiddenSeparator: hiddenSep, alwaysHiddenSeparator: alwaysSep)
    #expect(s["v"] == .visible)
    #expect(s["h1"] == .hidden)
    #expect(s["h2"] == .hidden)
    #expect(s["a1"] == .alwaysHidden)
}

@Test func noAlwaysHiddenSeparatorMeansHidden() {
    let s = MenuBarLayout.sections(of: [item("x", 10)], hiddenSeparator: item("H", 500), alwaysHiddenSeparator: nil)
    #expect(s["x"] == .hidden)
    // No separator at all (module just started): everything is visible.
    #expect(MenuBarLayout.sections(of: [item("x", 10)], hiddenSeparator: nil, alwaysHiddenSeparator: nil)["x"] == .visible)
}

@Test func misplacedAlwaysHiddenSeparatorIsIgnored() {
    // The always-hidden separator right of the hidden one (dragged there by
    // hand) can't define a section.
    let s = MenuBarLayout.sections(of: [item("x", 100)], hiddenSeparator: item("H", 300), alwaysHiddenSeparator: item("A", 500))
    #expect(s["x"] == .hidden)
}

@Test func arrangementKeepsOrderPerSection() {
    let order = ["a1", "A", "h1", "h2", "H", "v1", "v2"]
    let sections: [String: MenuBarSection] = ["a1": .alwaysHidden, "h1": .hidden, "h2": .hidden, "v1": .visible, "v2": .visible]
    let arr = MenuBarLayout.arrangement(order: order, sections: sections)
    #expect(arr[.alwaysHidden] == ["a1"])
    #expect(arr[.hidden] == ["h1", "h2"])
    #expect(arr[.visible] == ["v1", "v2"])
    #expect(MenuBarLayout.targetOrder(arr, hiddenSeparator: "H", alwaysHiddenSeparator: "A") == order)
    #expect(MenuBarLayout.targetOrder(arr, hiddenSeparator: "H", alwaysHiddenSeparator: nil) == ["a1", "h1", "h2", "H", "v1", "v2"])
}

@Test func leftToRightUsesCentres() {
    let sorted = MenuBarLayout.leftToRight([item("v", 620), item("H", -9400, 10_000), item("h", -9430)])
    #expect(sorted.map(\.key) == ["h", "H", "v"])
}

// MARK: - Move planning

@Test func longestIncreasingRun() {
    #expect(MenuBarLayout.longestIncreasingRun([]) == [])
    #expect(MenuBarLayout.longestIncreasingRun([3, 1, 2]) == [1, 2])
    let run = MenuBarLayout.longestIncreasingRun([0, 8, 4, 12, 2, 10, 6, 14, 1, 9])
    #expect(run.count == 4)
    let values = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9]
    #expect(zip(run, run.dropFirst()).allSatisfy { values[$0] < values[$1] && $0 < $1 })
}

@Test func noMovesWhenAlreadyInOrder() {
    let order = ["a", "H", "b", "c"]
    #expect(MenuBarLayout.planMoves(current: order, target: order, anchors: ["H"]).isEmpty)
}

@Test func hidingOneItemIsOneMove() {
    // b moves from Visible into Hidden (left of the separator).
    let current = ["a", "H", "b", "c", "clock"]
    let target = ["a", "b", "H", "c", "clock"]
    let moves = MenuBarLayout.planMoves(current: current, target: target, anchors: ["H", "clock"])
    #expect(moves == [PlannedMove(key: "b", destination: .leftOf("H"))])
    #expect(apply(moves, to: current) == target)
}

@Test func swappingTwoItemsIsOneMove() {
    let current = ["H", "x", "y", "clock"]
    let target = ["H", "y", "x", "clock"]
    let moves = MenuBarLayout.planMoves(current: current, target: target, anchors: ["H", "clock"])
    #expect(moves.count == 1)
    #expect(apply(moves, to: current) == target)
}

@Test func itemsCrossingAnAnchorAlwaysMove() {
    // a and b swap sides of the separator: an increasing run that ignored the
    // anchor would keep one of them on the wrong side.
    let current = ["a", "H", "b"]
    let target = ["b", "H", "a"]
    let moves = MenuBarLayout.planMoves(current: current, target: target, anchors: ["H"])
    #expect(Set(moves.map(\.key)) == ["a", "b"])
    #expect(apply(moves, to: current) == target)
}

@Test func planReachesRandomTargets() {
    var rng = SystemRandomNumberGenerator()
    for _ in 0..<300 {
        let movable = (0..<Int.random(in: 1...9, using: &rng)).map { "i\($0)" }
        let anchors = ["A", "H", "clock"]
        // Current: anchors in fixed relative order, movables anywhere.
        var current = anchors
        for m in movable { current.insert(m, at: Int.random(in: 0...current.count, using: &rng)) }
        var target = anchors
        for m in movable.shuffled(using: &rng) { target.insert(m, at: Int.random(in: 0...target.count, using: &rng)) }
        let moves = MenuBarLayout.planMoves(current: current, target: target, anchors: Set(anchors))
        #expect(apply(moves, to: current) == target, "current \(current) target \(target) moves \(moves)")
        #expect(moves.allSatisfy { !anchors.contains($0.key) })
        // Never more moves than items out of place.
        #expect(moves.count <= movable.count)
    }
}

@Test func planIgnoresKeysMissingFromEitherSide() {
    // An item that quit meanwhile, and one that appeared, are left alone.
    let moves = MenuBarLayout.planMoves(current: ["new", "b", "H", "a"], target: ["a", "H", "b", "gone"], anchors: ["H"])
    #expect(!moves.contains { $0.key == "new" || $0.key == "gone" })
    #expect(apply(moves, to: ["b", "H", "a"]) == ["a", "H", "b"])
}

@Test func placementCheckIgnoresTransparentItems() {
    let order = ["x", "ghost", "H", "y"]
    #expect(!MenuBarLayout.isPlaced("x", .leftOf("H"), in: order))
    #expect(MenuBarLayout.isPlaced("x", .leftOf("H"), in: order, ignoring: ["ghost"]))
    #expect(MenuBarLayout.isPlaced("y", .rightOf("H"), in: order))
    #expect(!MenuBarLayout.isPlaced("missing", .rightOf("H"), in: order))
}

@Test func dropPointsLandOnTheRightSide() {
    let frame = CGRect(x: 100, y: 0, width: 30, height: 24)
    let left = MenuBarLayout.dropPoint(for: .leftOf("t"), targetFrame: frame)
    let right = MenuBarLayout.dropPoint(for: .rightOf("t"), targetFrame: frame)
    #expect(left.x > frame.minX && left.x < frame.midX)
    #expect(right.x < frame.maxX && right.x > frame.midX)
    #expect(left.y == 12)
}

// MARK: - Notch

@Test func statusAreaRespectsNotchAndMenus() {
    // 1512 pt wide MacBook display, notch from 663 to 848.
    let area = MenuBarLayout.statusArea(screenMinX: 0, screenMaxX: 1512, notch: 663...848, appMenuMaxX: 400)
    #expect(area == 848...1512)
    // Long app menus past the notch push the start further right.
    #expect(MenuBarLayout.statusArea(screenMinX: 0, screenMaxX: 1512, notch: 663...848, appMenuMaxX: 900) == 900...1512)
    // No notch: right of the app menus. Second display at x 1512.
    #expect(MenuBarLayout.statusArea(screenMinX: 1512, screenMaxX: 3432, notch: nil, appMenuMaxX: 1900) == 1900...3432)
    #expect(MenuBarLayout.statusArea(screenMinX: 1512, screenMaxX: 3432, notch: nil, appMenuMaxX: nil) == 1512...3432)
}

@Test func overflowFindsItemsBehindTheNotch() {
    let area: ClosedRange<CGFloat> = 848...1512
    let items = [item("clock", 1383, 131), item("fits", 860), item("notch", 830), item("off", -40), item("hidden", -9000)]
    let lost = MenuBarLayout.overflow(items, shown: ["clock", "fits", "notch", "off"], area: area)
    #expect(lost == ["notch", "off"])
    // Zero-width items (an app's empty item) never count.
    #expect(MenuBarLayout.overflow([item("empty", 10, 0)], shown: ["empty"], area: area).isEmpty)
}

@Test func shortfallSumsShownWidths() {
    let items = [item("a", 0, 300), item("b", 0, 300), item("c", 0, 200)]
    #expect(MenuBarLayout.shortfall(items, shown: ["a", "b"], available: 664) == 0)
    #expect(MenuBarLayout.shortfall(items, shown: ["a", "b", "c"], available: 664) == 136)
}

@Test func insertingFollowsRememberedOrder() {
    // b was remembered between a and c: it goes back after a.
    #expect(MenuBarLayout.inserting("b", into: ["a", "c"], remembered: ["a", "b", "c"]) == ["a", "b", "c"])
    // a isn't there now: after the nearest remembered predecessor that is.
    #expect(MenuBarLayout.inserting("c", into: ["x", "b"], remembered: ["a", "b", "c"]) == ["x", "b", "c"])
    // Nothing before it is present, or it was never seen: first.
    #expect(MenuBarLayout.inserting("a", into: ["b", "c"], remembered: ["a", "b", "c"]) == ["a", "b", "c"])
    #expect(MenuBarLayout.inserting("new", into: ["b", "c"], remembered: ["b", "c"]) == ["new", "b", "c"])
    // Already in the list: moved, not duplicated.
    #expect(MenuBarLayout.inserting("b", into: ["b", "a"], remembered: ["a", "b"]) == ["a", "b"])
}

@Test func profileItemsGoAfterTheirRememberedNeighbour() {
    // Profile order 7, 8 in a section that holds 1, 2 (unmentioned) now:
    // with no remembered neighbour present they go to the left end, in order.
    #expect(MenuBarController.inserting(8, into: MenuBarController.inserting(7, into: [1, 2], remembered: [7, 8]), remembered: [7, 8]) == [7, 8, 1, 2])
    // Remembered after 2: right after it.
    #expect(MenuBarController.inserting(9, into: [1, 2, 3], remembered: [2, 9]) == [1, 2, 9, 3])
}

@Test func teleportReleaseDependsOnDirection() {
    // Measured on macOS 26: only "move right, to just left of the target" needs
    // the release a width before the target's edge.
    #expect(MenuBarLayout.releasesBeforeEdge(itemMidX: -900, targetMidX: 950, destination: .leftOf("t")))
    #expect(!MenuBarLayout.releasesBeforeEdge(itemMidX: 990, targetMidX: 950, destination: .leftOf("t")))
    #expect(!MenuBarLayout.releasesBeforeEdge(itemMidX: 880, targetMidX: 950, destination: .rightOf("t")))
    #expect(!MenuBarLayout.releasesBeforeEdge(itemMidX: 990, targetMidX: 950, destination: .rightOf("t")))
}

@Test func onDisplayToleratesTheClockPokingPastTheEdge() {
    let display = [CGRect(x: 0, y: 0, width: 1512, height: 982)]
    #expect(MenuBarLayout.isOnDisplay(CGRect(x: 1383, y: 0, width: 131, height: 33), displays: display))
    #expect(MenuBarLayout.isOnDisplay(CGRect(x: 900, y: 0, width: 30, height: 33), displays: display))
    // Parked off the left edge, or a zero-width item.
    #expect(!MenuBarLayout.isOnDisplay(CGRect(x: -900, y: 0, width: 30, height: 33), displays: display))
    #expect(!MenuBarLayout.isOnDisplay(CGRect(x: 900, y: 0, width: 0, height: 33), displays: display))
    // A second display to the right.
    #expect(MenuBarLayout.isOnDisplay(CGRect(x: 1600, y: 0, width: 30, height: 24),
                                      displays: display + [CGRect(x: 1512, y: 0, width: 1920, height: 1080)]))
}
