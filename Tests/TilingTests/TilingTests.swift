import CoreGraphics
import Foundation
import Testing
@testable import Tiling

private let area = CGRect(x: 0, y: 0, width: 1000, height: 600)

/// Runs a mutating call outside the `#expect` macro (which can't capture inout state).
private func mut(_ body: () -> Bool) -> Bool { body() }

private func state(_ kind: LayoutKind, _ ids: [WindowID], placement: Placement = .end, gap: CGFloat = 0) -> LayoutState {
    var s = LayoutState(kind: kind, masterRatio: 0.5)
    for id in ids {
        s.insert(id, focused: nil, placement: placement, area: area, gap: gap, visible: Set(ids))
    }
    return s
}

// MARK: - Math

@Test func splitLeavesGapAndRounds() {
    let (a, b) = LayoutMath.split(area, .horizontal, ratio: 0.5, gap: 10)
    #expect(a == CGRect(x: 0, y: 0, width: 495, height: 600))
    #expect(b == CGRect(x: 505, y: 0, width: 495, height: 600))
    let (c, d) = LayoutMath.split(area, .vertical, ratio: 0.25, gap: 0)
    #expect(c.height == 150 && d.minY == 150 && d.height == 450)
}

@Test func distributeFillsExactly() {
    let rects = LayoutMath.distribute(area, .horizontal, weights: [1, 1, 1], gap: 8)
    #expect(rects.count == 3)
    #expect(rects[0].minX == 0)
    #expect(rects[2].maxX == 1000)
    #expect(rects[1].minX == rects[0].maxX + 8)
    #expect(abs(rects[0].width - rects[2].width) <= 1)
    let weighted = LayoutMath.distribute(area, .vertical, weights: [2, 1], gap: 0)
    #expect(weighted[0].height == 400 && weighted[1].height == 200)
}

// MARK: - Tree

@Test func bspInsertionDwindles() {
    let s = state(.tiles, [1, 2, 3])
    // 1 | (2 / 3): the second split is vertical because the right half is tall.
    #expect(s.tree == .split(.horizontal, 0.5, .leaf(1), .split(.vertical, 0.5, .leaf(2), .leaf(3))))
    let f = s.frames(area: area, gap: 0, visible: [1, 2, 3])
    #expect(f[1] == CGRect(x: 0, y: 0, width: 500, height: 600))
    #expect(f[2] == CGRect(x: 500, y: 0, width: 500, height: 300))
    #expect(f[3] == CGRect(x: 500, y: 300, width: 500, height: 300))
}

@Test func insertAfterFocusedAndFirst() {
    var s = state(.tiles, [1, 2])
    s.insert(3, focused: 1, placement: .afterFocused, area: area, gap: 0, visible: [1, 2, 3])
    #expect(s.windows == [1, 3, 2])
    s.insert(4, focused: nil, placement: .first, area: area, gap: 0, visible: [1, 2, 3, 4])
    #expect(s.windows.first == 4)
    // Inserting a known window is a no-op.
    let before = s
    s.insert(2, focused: nil, placement: .end, area: area, gap: 0, visible: [1, 2, 3, 4])
    #expect(s == before)
}

@Test func removeCollapsesParent() {
    var s = state(.tiles, [1, 2, 3])
    s.remove(2)
    #expect(s.tree == .split(.horizontal, 0.5, .leaf(1), .leaf(3)))
    s.remove(1)
    s.remove(3)
    #expect(s.tree == nil)
    #expect(s.frames(area: area, gap: 0, visible: []).isEmpty)
}

@Test func hiddenWindowsTakeNoSpaceAndKeepTheirPlace() {
    let s = state(.tiles, [1, 2, 3])
    let f = s.frames(area: area, gap: 0, visible: [1, 3])
    #expect(f.count == 2)
    #expect(f[1] == CGRect(x: 0, y: 0, width: 500, height: 600))
    #expect(f[3] == CGRect(x: 500, y: 0, width: 500, height: 600))
    // When 2 reappears, the original arrangement is back.
    #expect(s.frames(area: area, gap: 0, visible: [1, 2, 3])[2] == CGRect(x: 500, y: 0, width: 500, height: 300))
}

@Test func newWindowWithNothingVisibleGetsWholeArea() {
    var s = state(.tiles, [1, 2])
    s.insert(3, focused: nil, placement: .afterFocused, area: area, gap: 0, visible: [3])
    #expect(s.frames(area: area, gap: 0, visible: [3])[3] == area)
    #expect(s.windows.contains(1) && s.windows.contains(2))
}

@Test func swapAndReplace() {
    var s = state(.tiles, [1, 2, 3])
    s.weights[1] = 2
    s.swap(1, 3)
    #expect(s.windows == [3, 2, 1])
    #expect(s.weights[3] == 2 && s.weights[1] == nil)
    s.replace(2, with: 9)
    #expect(s.windows == [3, 9, 1])
}

@Test func promoteSwapsWithMaster() {
    var s = state(.masterStack, [1, 2, 3])
    #expect(mut { s.promote(3, visible: [1, 2, 3]) })
    #expect(s.windows == [3, 2, 1])
    // Promoting the master swaps it with the next window.
    #expect(mut { s.promote(3, visible: [1, 2, 3]) })
    #expect(s.windows == [2, 3, 1])
    #expect(!mut { s.promote(2, visible: [2]) })
}

@Test func toggleSplitAxisFlipsParent() {
    var s = state(.tiles, [1, 2])
    #expect(mut { s.toggleSplitAxis(2, visible: [1, 2]) })
    #expect(s.tree == .split(.vertical, 0.5, .leaf(1), .leaf(2)))
    var cols = state(.columns, [1, 2])
    #expect(!mut { cols.toggleSplitAxis(2, visible: [1, 2]) })
}

@Test func balanceEqualisesChains() {
    // Three windows in a horizontal chain: 1 | (2 | 3) should get a third each.
    var s = LayoutState(kind: .tiles, masterRatio: 0.5,
                        tree: .split(.horizontal, 0.8, .leaf(1), .split(.horizontal, 0.3, .leaf(2), .leaf(3))))
    s.weights[1] = 3
    s.balance(masterRatio: 0.6, visible: [1, 2, 3])
    let f = s.frames(area: CGRect(x: 0, y: 0, width: 900, height: 600), gap: 0, visible: [1, 2, 3])
    #expect(f[1]!.width == 300 && f[2]!.width == 300 && f[3]!.width == 300)
    #expect(s.weights.isEmpty && s.masterRatio == 0.6)
}

// MARK: - Layouts

@Test func masterStackFrames() {
    let s = state(.masterStack, [1, 2, 3])
    let f = s.frames(area: area, gap: 10, visible: [1, 2, 3])
    #expect(f[1] == CGRect(x: 0, y: 0, width: 495, height: 600))
    #expect(f[2] == CGRect(x: 505, y: 0, width: 495, height: 295))
    #expect(f[3] == CGRect(x: 505, y: 305, width: 495, height: 295))
    #expect(state(.masterStack, [7]).frames(area: area, gap: 10, visible: [7])[7] == area)
}

@Test func columnsRowsMonocleFrames() {
    let ids: [WindowID] = [1, 2, 3, 4]
    let cols = state(.columns, ids).frames(area: area, gap: 0, visible: Set(ids))
    #expect(cols[1] == CGRect(x: 0, y: 0, width: 250, height: 600))
    #expect(cols[4] == CGRect(x: 750, y: 0, width: 250, height: 600))
    let rows = state(.rows, [1, 2]).frames(area: area, gap: 0, visible: [1, 2])
    #expect(rows[2] == CGRect(x: 0, y: 300, width: 1000, height: 300))
    let mono = state(.monocle, ids).frames(area: area, gap: 0, visible: Set(ids))
    #expect(mono.values.allSatisfy { $0 == area })
}

@Test func layoutSwitchKeepsOrder() {
    var s = state(.tiles, [1, 2, 3])
    s.kind = .columns
    let f = s.frames(area: area, gap: 0, visible: [1, 2, 3])
    #expect(f[1]!.minX < f[2]!.minX && f[2]!.minX < f[3]!.minX)
    #expect(LayoutKind.monocle.next == .tiles)
}

// MARK: - Resizing

@Test func growInTilesMovesNearestSplit() {
    var s = state(.tiles, [1, 2])
    #expect(mut { s.grow(1, by: 0.1, visible: [1, 2]) })
    #expect(s.frames(area: area, gap: 0, visible: [1, 2])[1]!.width == 600)
    #expect(mut { s.grow(2, by: 0.2, visible: [1, 2]) })
    #expect(s.frames(area: area, gap: 0, visible: [1, 2])[2]!.width == 600)
    // Ratios are clamped.
    for _ in 0..<20 { _ = s.grow(1, by: 0.1, visible: [1, 2]) }
    #expect(s.frames(area: area, gap: 0, visible: [1, 2])[1]!.width == 900)
    // A lone window cannot grow.
    #expect(!mut { s.grow(1, by: 0.1, visible: [1]) })
}

@Test func growSkipsSplitsWithHiddenSide() {
    // 1 | (2 / 3) with 3 hidden: growing 2 must move the outer split.
    var s = state(.tiles, [1, 2, 3])
    #expect(mut { s.grow(2, by: 0.1, visible: [1, 2]) })
    #expect(s.frames(area: area, gap: 0, visible: [1, 2])[2]!.width == 600)
}

@Test func growInMasterStackAndColumns() {
    var m = state(.masterStack, [1, 2, 3])
    #expect(mut { m.grow(1, by: 0.1, visible: [1, 2, 3]) })
    #expect(abs(m.masterRatio - 0.6) < 1e-9)
    #expect(mut { m.grow(2, by: 0.1, visible: [1, 2, 3]) })
    #expect(abs(m.masterRatio - 0.5) < 1e-9)

    var c = state(.columns, [1, 2])
    #expect(mut { c.grow(1, by: 0.1, visible: [1, 2]) })
    let f = c.frames(area: area, gap: 0, visible: [1, 2])
    #expect(f[1]!.width == 600 && f[2]!.width == 400)
    var mono = state(.monocle, [1, 2])
    #expect(!mut { mono.grow(1, by: 0.1, visible: [1, 2]) })
}

@Test func mouseResizeInTiles() {
    var s = state(.tiles, [1, 2, 3])
    let vis: Set<WindowID> = [1, 2, 3]
    let old = s.frames(area: area, gap: 10, visible: vis)
    // Drag the right edge of 1 to x = 700.
    var new1 = old[1]!
    new1.size.width = 700
    #expect(mut { s.applyUserResize(1, from: old[1]!, to: new1, area: area, gap: 10, visible: vis) })
    var f = s.frames(area: area, gap: 10, visible: vis)
    #expect(f[1]!.maxX == 700)
    #expect(f[2]!.minX == 710)
    // Drag the top edge of 3 up to y = 200.
    let old3 = f[3]!
    let new3 = CGRect(x: old3.minX, y: 200, width: old3.width, height: old3.maxY - 200)
    #expect(mut { s.applyUserResize(3, from: old3, to: new3, area: area, gap: 10, visible: vis) })
    f = s.frames(area: area, gap: 10, visible: vis)
    #expect(f[3]!.minY == 200)
    #expect(f[2]!.maxY == 190)
    // Edges on the screen border have no split to move.
    var outer = f[1]!
    outer.origin.x -= 50
    outer.size.width += 50
    #expect(!mut { s.applyUserResize(1, from: f[1]!, to: outer, area: area, gap: 10, visible: vis) })
}

@Test func mouseResizeInColumnsAndMasterStack() {
    var c = state(.columns, [1, 2, 3])
    let vis: Set<WindowID> = [1, 2, 3]
    let old = c.frames(area: area, gap: 0, visible: vis)
    // Left edge of the middle column moves left to x = 200.
    let new2 = CGRect(x: 200, y: 0, width: old[2]!.maxX - 200, height: 600)
    #expect(mut { c.applyUserResize(2, from: old[2]!, to: new2, area: area, gap: 0, visible: vis) })
    let f = c.frames(area: area, gap: 0, visible: vis)
    #expect(abs(f[1]!.width - 200) <= 1)
    #expect(abs(f[2]!.minX - 200) <= 1)
    #expect(abs(f[3]!.width - old[3]!.width) <= 1)

    var m = state(.masterStack, [1, 2, 3])
    let mo = m.frames(area: area, gap: 0, visible: vis)
    var master = mo[1]!
    master.size.width = 300
    #expect(mut { m.applyUserResize(1, from: mo[1]!, to: master, area: area, gap: 0, visible: vis) })
    #expect(abs(m.masterRatio - 0.3) < 1e-9)
    // Stack window: bottom edge of 2 moves down to 400.
    let so = m.frames(area: area, gap: 0, visible: vis)
    var s2 = so[2]!
    s2.size.height = 400
    #expect(mut { m.applyUserResize(2, from: so[2]!, to: s2, area: area, gap: 0, visible: vis) })
    let sf = m.frames(area: area, gap: 0, visible: vis)
    #expect(abs(sf[2]!.height - 400) <= 1 && abs(sf[3]!.minY - 400) <= 1)
}

// MARK: - Neighbours

@Test func neighborInGrid() {
    // 1 | 2
    // 3 | 4
    let frames: [(WindowID, CGRect)] = [
        (1, CGRect(x: 0, y: 0, width: 500, height: 300)),
        (2, CGRect(x: 510, y: 0, width: 490, height: 300)),
        (3, CGRect(x: 0, y: 310, width: 500, height: 290)),
        (4, CGRect(x: 510, y: 310, width: 490, height: 290)),
    ]
    func n(_ id: WindowID, _ d: Direction) -> WindowID? {
        Neighbor.find(from: frames.first { $0.0 == id }!.1, direction: d, candidates: frames.filter { $0.0 != id })
    }
    #expect(n(1, .right) == 2)
    #expect(n(1, .down) == 3)
    #expect(n(4, .left) == 3)
    #expect(n(4, .up) == 2)
    #expect(n(1, .left) == nil)
    #expect(n(1, .up) == nil)
}

@Test func neighborPrefersOverlapThenRank() {
    // Big window on the left, two stacked on the right.
    let left = CGRect(x: 0, y: 0, width: 500, height: 600)
    let candidates: [(WindowID, CGRect)] = [
        (2, CGRect(x: 500, y: 0, width: 500, height: 300)),
        (3, CGRect(x: 500, y: 300, width: 500, height: 300)),
        (4, CGRect(x: 1000, y: 0, width: 300, height: 600)),
    ]
    // Same distance: without rank the top-aligned one wins, with rank the most recent.
    #expect(Neighbor.find(from: left, direction: .right, candidates: candidates) == 2)
    #expect(Neighbor.find(from: left, direction: .right, candidates: candidates, rank: [3: 0, 2: 1]) == 3)
}

@Test func neighborAcrossDisplaysAndOverlaps() {
    // Displays side by side: the window on the second display is found to the right.
    let source = CGRect(x: 1200, y: 100, width: 600, height: 800)
    let candidates: [(WindowID, CGRect)] = [(9, CGRect(x: 1920, y: 0, width: 1280, height: 1000))]
    #expect(Neighbor.find(from: source, direction: .right, candidates: candidates) == 9)
    // Overlapping floating window whose centre is to the right still counts.
    let overlapping: [(WindowID, CGRect)] = [(5, CGRect(x: 1500, y: 100, width: 600, height: 800))]
    #expect(Neighbor.find(from: source, direction: .right, candidates: overlapping) == 5)
    #expect(Neighbor.find(from: source, direction: .left, candidates: overlapping) == nil)
}

@Test func cycleWraps() {
    #expect(Neighbor.cycle([1, 2, 3], from: 3, forward: true) == 1)
    #expect(Neighbor.cycle([1, 2, 3], from: 1, forward: false) == 3)
    #expect(Neighbor.cycle([1], from: 1, forward: true) == nil)
}

// MARK: - Settings

@Test func settingsDecodeTolerantly() throws {
    let json = #"{"managerOn": true, "defaultLayout": "spiral", "innerGap": 12}"#
    let s = try JSONDecoder().decode(TilingSettings.self, from: Data(json.utf8))
    #expect(s.managerOn)
    #expect(s.defaultLayout == .tiles)
    #expect(s.innerGap == 12)
    #expect(s.floatingApps == TilingSettings.defaultFloatingApps)
    let roundTrip = try JSONDecoder().decode(TilingSettings.self, from: JSONEncoder().encode(s))
    #expect(roundTrip == s)
}

@Test func settingsClamp() {
    var s = TilingSettings()
    s.innerGap = -5
    s.masterRatio = 2
    s.resizeStep = 0
    #expect(s.clampedInnerGap == 0)
    #expect(s.clampedMasterRatio == LayoutMath.maxRatio)
    #expect(s.clampedResizeStep == 0.01)
}

@Test func mouseResizeVersusMove() {
    let old = CGRect(x: 0, y: 0, width: 500, height: 600)
    #expect(TilingManager.isResize(from: old, to: CGRect(x: 0, y: 0, width: 620, height: 600)))       // right edge
    #expect(TilingManager.isResize(from: old, to: CGRect(x: -50, y: -40, width: 550, height: 640)))   // top-left corner
    #expect(!TilingManager.isResize(from: old, to: CGRect(x: 100, y: 50, width: 500, height: 600)))   // plain move
    // A move whose size changed too (Windows restores the pre-snap size on drag) is still a move.
    #expect(!TilingManager.isResize(from: old, to: CGRect(x: 300, y: 200, width: 400, height: 300)))
}
