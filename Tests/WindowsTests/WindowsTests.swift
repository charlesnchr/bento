import Testing
import CoreGraphics
import Foundation
@testable import BentoCore
@testable import Windows

// Screens in AX coordinates (top-left origin).
private let screenA = ScreenRect(frame: CGRect(x: 0, y: 0, width: 1600, height: 1000), visible: CGRect(x: 0, y: 25, width: 1600, height: 960))
private let screenB = ScreenRect(frame: CGRect(x: 1600, y: 0, width: 1920, height: 1200), visible: CGRect(x: 1600, y: 0, width: 1920, height: 1200))
private let portrait = ScreenRect(frame: CGRect(x: 0, y: 0, width: 1000, height: 1600), visible: CGRect(x: 0, y: 0, width: 1000, height: 1600))
private let V = screenA.visible
private let someWindow = CGRect(x: 400, y: 300, width: 600, height: 400)

private func calc(_ cmd: WindowCommand, window: CGRect = someWindow, screens: [ScreenRect] = [screenA], index: Int = 0,
                  last: LastAction? = nil, options: GeometryOptions = GeometryOptions()) -> GeometryResult? {
    Geometry.calculate(GeometryInput(command: cmd, window: window, screens: screens, screenIndex: index, last: last, options: options))
}

private func rect(_ cmd: WindowCommand, window: CGRect = someWindow, in screen: ScreenRect = screenA,
                  options: GeometryOptions = GeometryOptions()) -> CGRect? {
    calc(cmd, window: window, screens: [screen], options: options)?.rect
}

private func approx(_ a: [CGFloat], _ b: [CGFloat]) -> Bool {
    a.count == b.count && zip(a, b).allSatisfy { abs($0 - $1) < 1e-9 }
}

private func R(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> CGRect { CGRect(x: x, y: y, width: w, height: h) }

// MARK: - Basic positions

@Test func halves() {
    #expect(rect(.leftHalf) == R(0, 25, 800, 960))
    #expect(rect(.rightHalf) == R(800, 25, 800, 960))
    #expect(rect(.topHalf) == R(0, 25, 1600, 480))
    #expect(rect(.bottomHalf) == R(0, 505, 1600, 480))
    #expect(rect(.centerHalf) == R(400, 25, 800, 960))
    #expect(rect(.centerHalf, in: portrait) == R(0, 400, 1000, 800))
}

@Test func corners() {
    #expect(rect(.topLeft) == R(0, 25, 800, 480))
    #expect(rect(.topRight) == R(800, 25, 800, 480))
    #expect(rect(.bottomLeft) == R(0, 505, 800, 480))
    #expect(rect(.bottomRight) == R(800, 505, 800, 480))
}

@Test func oddSizesTileWithoutGapsOrOverlap() {
    let odd = ScreenRect(frame: R(0, 0, 1511, 981), visible: R(0, 33, 1511, 887))
    let l = rect(.leftHalf, in: odd)!, r = rect(.rightHalf, in: odd)!
    #expect(l.maxX == r.minX)
    #expect(l.width + r.width == 1511)
    let t1 = rect(.firstThird, in: odd)!, t2 = rect(.centerThird, in: odd)!, t3 = rect(.lastThird, in: odd)!
    #expect(t1.maxX == t2.minX && t2.maxX == t3.minX && t3.maxX == 1511)
    let top = rect(.topHalf, in: odd)!, bottom = rect(.bottomHalf, in: odd)!
    #expect(top.maxY == bottom.minY && bottom.maxY == 920)
}

@Test func thirdsLandscape() {
    #expect(rect(.firstThird) == R(0, 25, 533, 960))
    #expect(rect(.centerThird) == R(533, 25, 534, 960))
    #expect(rect(.lastThird) == R(1067, 25, 533, 960))
    #expect(rect(.firstTwoThirds) == R(0, 25, 1067, 960))
    #expect(rect(.lastTwoThirds) == R(533, 25, 1067, 960))
    #expect(rect(.centerTwoThirds) == R(267, 25, 1067, 960))
}

@Test func thirdsPortraitRunTopToBottom() {
    #expect(rect(.firstThird, in: portrait) == R(0, 0, 1000, 533))
    #expect(rect(.centerThird, in: portrait) == R(0, 533, 1000, 534))
    #expect(rect(.lastThird, in: portrait) == R(0, 1067, 1000, 533))
    #expect(rect(.firstTwoThirds, in: portrait) == R(0, 0, 1000, 1067))
}

@Test func fourths() {
    #expect(rect(.firstFourth) == R(0, 25, 400, 960))
    #expect(rect(.secondFourth) == R(400, 25, 400, 960))
    #expect(rect(.thirdFourth) == R(800, 25, 400, 960))
    #expect(rect(.lastFourth) == R(1200, 25, 400, 960))
    #expect(rect(.firstThreeFourths) == R(0, 25, 1200, 960))
    #expect(rect(.lastThreeFourths) == R(400, 25, 1200, 960))
    #expect(rect(.centerThreeFourths) == R(200, 25, 1200, 960))
    #expect(rect(.secondFourth, in: portrait) == R(0, 400, 1000, 400))
}

@Test func sixths() {
    #expect(rect(.topLeftSixth) == R(0, 25, 533, 480))
    #expect(rect(.topCenterSixth) == R(533, 25, 534, 480))
    #expect(rect(.topRightSixth) == R(1067, 25, 533, 480))
    #expect(rect(.bottomLeftSixth) == R(0, 505, 533, 480))
    #expect(rect(.bottomCenterSixth) == R(533, 505, 534, 480))
    #expect(rect(.bottomRightSixth) == R(1067, 505, 533, 480))
    // Portrait: 2 columns x 3 rows; "top center" is the middle-left cell (Rectangle).
    #expect(rect(.topLeftSixth, in: portrait) == R(0, 0, 500, 533))
    #expect(rect(.topRightSixth, in: portrait) == R(500, 0, 500, 533))
    #expect(rect(.topCenterSixth, in: portrait) == R(0, 533, 500, 534))
    #expect(rect(.bottomRightSixth, in: portrait) == R(500, 1067, 500, 533))
}

@Test func moreSizes() {
    #expect(rect(.middleCenterNinth) == R(533, 345, 534, 320))
    #expect(rect(.bottomRightNinth) == R(1067, 665, 533, 320))
    #expect(rect(.topCenterRightEighth) == R(800, 25, 400, 480))
    #expect(rect(.topLeftThird) == R(0, 25, 1067, 480))
    #expect(rect(.bottomRightThird) == R(533, 505, 1067, 480))
    #expect(rect(.middleVerticalThird) == R(0, 345, 1600, 320))
    #expect(rect(.bottomVerticalTwoThirds) == R(0, 345, 1600, 640))
}

@Test func maximizeFamily() {
    #expect(rect(.maximize) == V)
    #expect(rect(.almostMaximize) == R(80, 73, 1440, 864))
    #expect(rect(.maximizeHeight) == R(400, 25, 600, 960))
}

@Test func centerKeepsSizeAndClampsOversizedAxis() {
    #expect(rect(.center) == R(500, 305, 600, 400))
    #expect(rect(.center, window: R(10, 10, 600, 2000)) == R(500, 25, 600, 960))
    #expect(rect(.center, window: R(10, 10, 3000, 2000)) == V)
}

@Test func largerSmaller() {
    #expect(rect(.larger) == R(385, 285, 630, 430))
    #expect(rect(.smaller) == R(415, 315, 570, 370))
    #expect(rect(.largerWidth) == R(385, 300, 630, 400))
    #expect(rect(.smallerHeight) == R(400, 315, 600, 370))
    // Curtain: a window on the left edge keeps it.
    #expect(rect(.larger, window: R(0, 300, 600, 400)) == R(0, 285, 630, 430))
    // On the right edge.
    #expect(rect(.larger, window: R(1000, 300, 600, 400)) == R(970, 285, 630, 430))
    // Stops at a quarter of the screen.
    #expect(rect(.smaller, window: R(400, 300, 400, 400)) == R(400, 300, 400, 400))
    // A maximized window shrinks around its centre.
    #expect(rect(.smaller, window: V) == R(15, 40, 1570, 930))
    // Never grows past the screen.
    let big = rect(.larger, window: R(0, 25, 1590, 950))!
    #expect(big.width <= 1600 && big.maxY <= V.maxY && big.minY >= V.minY)
}

@Test func moveToEdges() {
    #expect(rect(.moveLeft) == R(0, 305, 600, 400))
    #expect(rect(.moveRight) == R(1000, 305, 600, 400))
    #expect(rect(.moveUp) == R(500, 25, 600, 400))
    #expect(rect(.moveDown) == R(500, 585, 600, 400))
    var o = GeometryOptions()
    o.screenMargin = 10
    o.centeredDirectionalMove = false
    #expect(rect(.moveLeft, options: o) == R(10, 300, 600, 400))
}

@Test func halveAndDouble() {
    let wide = R(200, 300, 1000, 600)
    #expect(rect(.halveWidthLeft, window: wide) == R(200, 300, 500, 600))
    #expect(rect(.halveWidthRight, window: wide) == R(700, 300, 500, 600))
    #expect(rect(.halveHeightUp, window: R(400, 300, 600, 800)) == R(400, 300, 600, 400))
    #expect(rect(.halveHeightDown, window: R(400, 300, 600, 800)) == R(400, 700, 600, 400))
    #expect(rect(.doubleWidthLeft) == R(-200, 300, 1200, 400))
    #expect(rect(.doubleHeightDown) == R(400, 300, 600, 800))
    // Too small to halve (quarter-screen minimum).
    #expect(rect(.halveWidthLeft, window: R(0, 0, 500, 500)) == R(0, 0, 500, 500))
}

// MARK: - Gaps

@Test func gapsBetweenWindowsAndAtEdges() {
    var o = GeometryOptions()
    o.windowGap = 10
    o.screenMargin = 20
    let l = rect(.leftHalf, options: o)!, r = rect(.rightHalf, options: o)!
    #expect(l == R(20, 45, 775, 920))
    #expect(r == R(805, 45, 775, 920))
    #expect(r.minX - l.maxX == 10)
    #expect(rect(.topLeft, options: o) == R(20, 45, 775, 455))
    #expect(rect(.bottomRight, options: o) == R(805, 510, 775, 455))
    #expect(rect(.centerThird, options: o) == R(538, 45, 524, 920))
    #expect(rect(.maximize, options: o) == R(20, 45, 1560, 920))
    #expect(rect(.maximizeHeight, options: o) == R(400, 45, 600, 920))
    o.gapsOnMaximize = false
    #expect(rect(.maximize, options: o) == V)
    // Actions that keep the window size ignore gaps.
    #expect(rect(.center, options: o) == R(500, 305, 600, 400))
    #expect(rect(.almostMaximize, options: o) == R(80, 73, 1440, 864))
}

@Test func gapHelperOnlyTouchesRequestedDimensions() {
    let r = Geometry.applyGaps(R(0, 25, 800, 960), in: V, dims: .vertical, gap: 10, margin: 6)
    #expect(r == R(0, 31, 800, 948))
}

// MARK: - Repeated execution

@Test func repeatedHalfCyclesHalfTwoThirdsThird() {
    let first = calc(.leftHalf)!
    #expect(first.rect.width == 800 && first.count == 0)
    let second = calc(.leftHalf, window: first.rect, last: LastAction(command: .leftHalf, rect: first.rect, count: first.count))!
    #expect(second.rect == R(0, 25, 1067, 960) && second.count == 1)
    let third = calc(.leftHalf, window: second.rect, last: LastAction(command: .leftHalf, rect: second.rect, count: second.count))!
    #expect(third.rect == R(0, 25, 533, 960))
    let fourth = calc(.leftHalf, window: third.rect, last: LastAction(command: .leftHalf, rect: third.rect, count: third.count))!
    #expect(fourth.rect == R(0, 25, 800, 960))
}

@Test func rightAndTopHalvesCycleFromTheirEdge() {
    let r1 = calc(.rightHalf)!
    let r2 = calc(.rightHalf, window: r1.rect, last: LastAction(command: .rightHalf, rect: r1.rect, count: 0))!
    #expect(r2.rect == R(533, 25, 1067, 960))
    let t1 = calc(.bottomHalf)!
    let t2 = calc(.bottomHalf, window: t1.rect, last: LastAction(command: .bottomHalf, rect: t1.rect, count: 0))!
    #expect(t2.rect == R(0, 345, 1600, 640))
}

@Test func movedWindowStartsOver() {
    let last = LastAction(command: .leftHalf, rect: R(0, 25, 800, 960), count: 0)
    let r = calc(.leftHalf, window: R(50, 60, 800, 960), last: last)!
    #expect(r.rect.width == 800 && r.count == 0)
}

@Test func cyclingCanBeTurnedOff() {
    var o = GeometryOptions()
    o.cycleOnRepeat = false
    let first = calc(.leftHalf, options: o)!
    let again = calc(.leftHalf, window: first.rect, last: LastAction(command: .leftHalf, rect: first.rect, count: 0), options: o)!
    #expect(again.rect == first.rect)
}

@Test func customCycleSizes() {
    var o = GeometryOptions()
    o.cycleFractions = Geometry.cycleOrder([1.0 / 4, 3.0 / 4, 1.0 / 2])
    #expect(approx(o.cycleFractions, [0.5, 0.75, 0.25]))
    let a = calc(.leftHalf, options: o)!
    let b = calc(.leftHalf, window: a.rect, last: LastAction(command: .leftHalf, rect: a.rect, count: a.count), options: o)!
    #expect(b.rect.width == 1200)
    let c = calc(.leftHalf, window: b.rect, last: LastAction(command: .leftHalf, rect: b.rect, count: b.count), options: o)!
    #expect(c.rect.width == 400)
    // Without ½ in the list, the first press still gives ½.
    o.cycleFractions = Geometry.cycleOrder([2.0 / 3, 1.0 / 3])
    let d = calc(.leftHalf, options: o)!
    #expect(d.rect.width == 800)
    let e = calc(.leftHalf, window: d.rect, last: LastAction(command: .leftHalf, rect: d.rect, count: 0), options: o)!
    #expect(e.rect.width == 1067)
}

@Test func cycleOrderFollowsRectangle() {
    #expect(approx(Geometry.cycleOrder([1.0 / 3, 0.5, 0.75, 0.25, 2.0 / 3]), [0.5, 2.0 / 3, 0.75, 0.25, 1.0 / 3]))
}

@Test func cornersCycleWidth() {
    let a = calc(.topLeft)!
    let b = calc(.topLeft, window: a.rect, last: LastAction(command: .topLeft, rect: a.rect, count: 0))!
    #expect(b.rect == R(0, 25, 1067, 480))
    let c = calc(.bottomRight, window: R(800, 505, 800, 480), last: LastAction(command: .bottomRight, rect: R(800, 505, 800, 480), count: 0))!
    #expect(c.rect == R(533, 505, 1067, 480))
}

@Test func thirdsCyclePositions() {
    var r = calc(.firstThird)!
    var seen: [CGRect] = [r.rect]
    for _ in 0..<3 {
        r = calc(.firstThird, window: r.rect, last: LastAction(command: r.command, rect: r.rect, count: r.count))!
        seen.append(r.rect)
    }
    #expect(seen == [R(0, 25, 533, 960), R(533, 25, 534, 960), R(1067, 25, 533, 960), R(0, 25, 533, 960)])
    let two = calc(.firstTwoThirds, window: R(0, 25, 1067, 960), last: LastAction(command: .firstTwoThirds, rect: R(0, 25, 1067, 960), count: 0))!
    #expect(two.rect == R(533, 25, 1067, 960))
    let last = calc(.lastThird, window: R(1067, 25, 533, 960), last: LastAction(command: .lastThird, rect: R(1067, 25, 533, 960), count: 0))!
    #expect(last.rect == R(533, 25, 534, 960))
}

@Test func sixthsCycleInReadingOrder() {
    let start = rect(.topRightSixth)!
    let next = calc(.topRightSixth, window: start, last: LastAction(command: .topRightSixth, rect: start, count: 0))!
    #expect(next.rect == rect(.bottomLeftSixth))
    #expect(Geometry.positionCycle(.topLeftSixth, landscape: false)?.prefix(3) == [.topLeftSixth, .topRightSixth, .topCenterSixth])
}

@Test func fourthsCycle() {
    let a = rect(.firstFourth)!
    let b = calc(.firstFourth, window: a, last: LastAction(command: .firstFourth, rect: a, count: 0))!
    #expect(b.rect == rect(.secondFourth))
}

@Test func cyclingWithGapsComparesGappedFrames() {
    var o = GeometryOptions()
    o.windowGap = 8
    o.screenMargin = 8
    let a = calc(.leftHalf, options: o)!
    let b = calc(.leftHalf, window: a.rect, last: LastAction(command: .leftHalf, rect: a.rect, count: 0), options: o)!
    #expect(b.rect == R(8, 33, 1055, 944))
}

// MARK: - Displays

@Test func repeatingLeftHalfTraversesToTheDisplayOnTheLeft() {
    var o = GeometryOptions()
    o.traverseDisplays = true
    let screens = [screenA, screenB]
    let onB = R(1600, 0, 960, 1200)
    let r = calc(.leftHalf, window: onB, screens: screens, index: 1, last: LastAction(command: .leftHalf, rect: onB, count: 0), options: o)!
    #expect(r.screenIndex == 0)
    #expect(r.command == .rightHalf)
    #expect(r.rect == R(800, 25, 800, 960))
    // Leftmost display: nowhere to go, so the size cycles instead.
    let onA = R(0, 25, 800, 960)
    let c = calc(.leftHalf, window: onA, screens: screens, index: 0, last: LastAction(command: .leftHalf, rect: onA, count: 0), options: o)!
    #expect(c.screenIndex == 0 && c.rect.width == 1067)
    // Moving right from A's right half lands on B's left half.
    let rr = R(800, 25, 800, 960)
    let m = calc(.rightHalf, window: rr, screens: screens, index: 0, last: LastAction(command: .rightHalf, rect: rr, count: 0), options: o)!
    #expect(m.screenIndex == 1 && m.rect == R(1600, 0, 960, 1200) && m.command == .leftHalf)
}

@Test func nextDisplayKeepsProportionalFrame() {
    let r = calc(.nextDisplay, window: R(100, 125, 400, 240), screens: [screenA, screenB])!
    #expect(r.screenIndex == 1)
    #expect(r.rect == R(1720, 125, 480, 300))
    // From B back to A (wraps around).
    let back = calc(.nextDisplay, window: r.rect, screens: [screenA, screenB], index: 1)!
    #expect(back.screenIndex == 0)
    #expect(back.rect == R(100, 125, 400, 240))
    let prev = calc(.previousDisplay, window: R(100, 125, 400, 240), screens: [screenA, screenB])!
    #expect(prev.screenIndex == 1)
}

@Test func nextDisplayReplaysPositionalActions() {
    let half = R(0, 25, 800, 960)
    let r = calc(.nextDisplay, window: half, screens: [screenA, screenB], last: LastAction(command: .leftHalf, rect: half, count: 0))!
    #expect(r.rect == R(1600, 0, 960, 1200))
    #expect(r.command == .leftHalf)
    // A cycled ⅔ stays ⅔.
    let twoThirds = R(0, 25, 1067, 960)
    let c = calc(.nextDisplay, window: twoThirds, screens: [screenA, screenB], last: LastAction(command: .leftHalf, rect: twoThirds, count: 1))!
    #expect(c.rect == R(1600, 0, 1280, 1200))
}

@Test func nextDisplayClampsOversizedWindows() {
    let small = ScreenRect(frame: R(1600, 0, 800, 600), visible: R(1600, 0, 800, 600))
    let r = calc(.nextDisplay, window: R(-100, 25, 1800, 960), screens: [screenA, small])!
    #expect(r.rect.minX >= 1600 && r.rect.maxX <= 2400 && r.rect.maxY <= 600)
}

@Test func spatialDisplayMoves() {
    let screens = [screenA, screenB]
    #expect(calc(.displayRight, screens: screens)?.screenIndex == 1)
    #expect(calc(.displayLeft, screens: screens) == nil)
    #expect(calc(.displayLeft, window: R(1700, 100, 400, 300), screens: screens, index: 1)?.screenIndex == 0)
    #expect(calc(.nextDisplay, screens: [screenA]) == nil)
    // Displays ordered left to right regardless of array order.
    let left = ScreenRect(frame: R(-1920, 0, 1920, 1080), visible: R(-1920, 0, 1920, 1080))
    #expect(Geometry.displayOrder([screenA, screenB, left]) == [2, 0, 1])
    #expect(Geometry.neighbor(of: 0, in: [screenA, screenB, left], direction: -1) == 2)
}

@Test func restoreAndMultiWindowAreNotSingleCalculations() {
    #expect(calc(.restore) == nil)
    #expect(calc(.tileAll) == nil)
}

// MARK: - Several windows

@Test func tileGrid() {
    let r = Geometry.tileRects(count: 3, in: V, options: GeometryOptions())
    #expect(r == [R(0, 25, 800, 480), R(800, 25, 800, 480), R(0, 505, 1600, 480)])
    #expect(Geometry.tileRects(count: 1, in: V, options: GeometryOptions()) == [V])
    #expect(Geometry.tileRects(count: 5, in: V, options: GeometryOptions()).count == 5)
}

@Test func cascade() {
    let r = Geometry.cascadeRects(sizes: [CGSize(width: 800, height: 600), CGSize(width: 800, height: 600)], in: V, options: GeometryOptions())
    #expect(r == [R(0, 25, 800, 600), R(30, 55, 800, 600)])
}

// MARK: - Snap areas

private let snapOpts = Geometry.SnapOptions()

private func snap(_ x: CGFloat, _ y: CGFloat, screens: [ScreenRect] = [screenA], prior: WindowCommand? = nil,
                  options: Geometry.SnapOptions = snapOpts) -> WindowCommand? {
    Geometry.snapArea(at: CGPoint(x: x, y: y), screens: screens, prior: prior, options: options)?.command
}

@Test func snapAreasLandscape() {
    #expect(snap(800, 1) == .maximize)
    #expect(snap(2, 2) == .topLeft)
    #expect(snap(1598, 3) == .topRight)
    #expect(snap(1, 999) == .bottomLeft)
    #expect(snap(1599, 999) == .bottomRight)
    #expect(snap(2, 500) == .leftHalf)
    #expect(snap(1598, 500) == .rightHalf)
    #expect(snap(2, 100) == .topHalf)
    #expect(snap(2, 900) == .bottomHalf)
    #expect(snap(200, 998) == .firstThird)
    #expect(snap(800, 998) == .centerThird)
    #expect(snap(800, 998, prior: .firstThird) == .firstTwoThirds)
    #expect(snap(800, 998, prior: .lastThird) == .lastTwoThirds)
    #expect(snap(1400, 998) == .lastThird)
    #expect(snap(800, 500) == nil)
    #expect(snap(30, 30) == nil)
}

@Test func snapAreasPortrait() {
    #expect(snap(2, 100, screens: [portrait]) == .topHalf)
    #expect(snap(2, 400, screens: [portrait]) == .firstThird)
    #expect(snap(2, 800, screens: [portrait]) == .centerThird)
    #expect(snap(2, 1300, screens: [portrait]) == .lastThird)
    #expect(snap(200, 1598, screens: [portrait]) == .leftHalf)
    #expect(snap(800, 1598, screens: [portrait]) == .rightHalf)
}

@Test func snapAreasOnSecondDisplayAndOptions() {
    let a = Geometry.snapArea(at: CGPoint(x: 3517, y: 600), screens: [screenA, screenB], prior: nil, options: snapOpts)
    #expect(a?.screenIndex == 1 && a?.command == .rightHalf)
    var o = snapOpts
    o.topMaximizes = false
    o.corners = false
    o.sideCornerHalves = false
    #expect(snap(800, 1, options: o) == nil)
    #expect(snap(2, 2, options: o) == nil)
    #expect(snap(2, 100, options: o) == .leftHalf)
    o.sixths = true
    o.topMaximizes = true
    #expect(snap(200, 1, prior: .topLeft, options: o) == .topLeftSixth)
    #expect(snap(800, 1, prior: .topLeftSixth, options: o) == .topCenterSixth)
    #expect(snap(800, 1, options: o) == .maximize)
    #expect(snap(200, 999, prior: .bottomLeft, options: o) == .bottomLeftSixth)
}

// MARK: - Modifier drag

@Test func resizeHandles() {
    let f = R(100, 100, 300, 300)
    #expect(Geometry.resizeHandle(at: CGPoint(x: 110, y: 110), in: f) == .init(x: -1, y: -1))
    #expect(Geometry.resizeHandle(at: CGPoint(x: 390, y: 250), in: f) == .init(x: 1, y: 0))
    #expect(Geometry.resizeHandle(at: CGPoint(x: 250, y: 390), in: f) == .init(x: 0, y: 1))
    #expect(Geometry.resizeHandle(at: CGPoint(x: 240, y: 260), in: f) == .init(x: -1, y: 1))
}

@Test func resizeMath() {
    let f = R(100, 100, 300, 300)
    #expect(Geometry.resized(f, handle: .init(x: 1, y: 1), delta: CGPoint(x: 50, y: 20)) == R(100, 100, 350, 320))
    #expect(Geometry.resized(f, handle: .init(x: -1, y: 0), delta: CGPoint(x: -40, y: 99)) == R(60, 100, 340, 300))
    #expect(Geometry.resized(f, handle: .init(x: 0, y: -1), delta: CGPoint(x: 0, y: 30)) == R(100, 130, 300, 270))
    // Can't collapse past the minimum size; the opposite edge stays put.
    #expect(Geometry.resized(f, handle: .init(x: -1, y: -1), delta: CGPoint(x: 500, y: 500)) == R(280, 340, 120, 60))
}

@Test func unsnapKeepsGrabPoint() {
    let current = R(0, 25, 800, 960)
    let r = Geometry.unsnapped(current, restoreSize: CGSize(width: 400, height: 300), grab: CGPoint(x: 600, y: 40), keepVertical: true)
    #expect(r == R(300, 25, 400, 300))
    let m = Geometry.unsnapped(current, restoreSize: CGSize(width: 400, height: 480), grab: CGPoint(x: 400, y: 505), keepVertical: false)
    #expect(m == R(200, 265, 400, 480))
}

// MARK: - Stash

@Test func stashFrames() {
    let w = R(300, 200, 600, 400)
    #expect(StashManager.hiddenFrame(w, edge: .left, screen: 0, screens: [screenA], sliver: 12) == R(-588, 200, 600, 400))
    #expect(StashManager.hiddenFrame(w, edge: .right, screen: 0, screens: [screenA], sliver: 12) == R(1588, 200, 600, 400))
    // A display on the right means no free right edge.
    #expect(StashManager.hiddenFrame(w, edge: .right, screen: 0, screens: [screenA, screenB], sliver: 12) == nil)
    #expect(StashManager.sliverRect(R(-588, 200, 600, 400), edge: .left, screen: screenA.frame, sliver: 12) == R(0, 200, 12, 400))
}

// MARK: - Commands and settings

@Test func commandIDsAndDefaults() {
    #expect(WindowCommand.leftHalf.actionID == "windows.left-half")
    #expect(WindowCommand.firstTwoThirds.actionID == "windows.first-two-thirds")
    #expect(WindowCommand.from(actionID: "windows.maximize-height") == .maximizeHeight)
    let ids = WindowCommand.allCases.map(\.actionID)
    #expect(Set(ids).count == ids.count)
    let shortcuts = WindowCommand.allCases.compactMap(\.defaultShortcut)
    #expect(shortcuts.allSatisfy { Shortcut($0) != nil })
    #expect(Set(shortcuts.compactMap(Shortcut.init)).count == shortcuts.count)
    #expect(Shortcut(WindowCommand.nextDisplay.defaultShortcut!)?.displayString == "⌃⌥]")
    #expect(Shortcut(WindowCommand.maximize.defaultShortcut!)?.displayString == "⌃⌥↩")
    #expect(Shortcut(WindowCommand.restore.defaultShortcut!)?.displayString == "⌃⌥⌫")
}

@Test func settingsDefaultsAndDerivedOptions() throws {
    let s = WindowsSettings()
    #expect(WindowsSettings.flags(s.dragMoveModifiers) == [.maskCommand, .maskAlternate])
    #expect(WindowsSettings.flags(s.dragResizeModifiers) == [.maskCommand, .maskAlternate, .maskShift])
    #expect(approx(s.geometry.cycleFractions, [0.5, 2.0 / 3, 1.0 / 3]))
    #expect(WindowsSettings.fraction("3/4") == 0.75)
    #expect(WindowsSettings.fraction("bogus") == nil)
    // A minimal hand-written section decodes with defaults filled in.
    let data = try JSONEncoder().encode(s)
    let back = try JSONDecoder().decode(WindowsSettings.self, from: data)
    #expect(back == s)
}

// MARK: - Layout mapping and screen lookup

@Test func screenSnapshotLookup() {
    let snap = ScreenSnapshot(screens: [], rects: [screenA, screenB])
    #expect(snap.index(containing: R(1500, 100, 400, 300)) == 1)
    #expect(snap.index(containing: R(100, 100, 400, 300)) == 0)
    #expect(snap.index(at: CGPoint(x: 5000, y: 100)) == 1) // nearest
}

@Test func layoutEntriesMapToTodaysDisplays() {
    let snap = ScreenSnapshot(screens: [], rects: [screenA, screenB])
    func entry(_ frame: CGRect, on screen: CGRect) -> SavedLayout.Entry {
        SavedLayout.Entry(bundleID: "x", appName: "X", title: "", index: 0, frame: Rect(frame), screen: Rect(screen), displayUUID: nil)
    }
    // Same display (matched by frame): unchanged.
    let same = LayoutManager.map(entry(R(1700, 100, 500, 400), on: screenB.frame), to: snap)
    #expect(same?.0 == R(1700, 100, 500, 400) && same?.1 == 1)
    // A display that is gone: proportionally onto the first display.
    let gone = LayoutManager.map(entry(R(-1920, 0, 960, 1080), on: R(-1920, 0, 1920, 1080)), to: snap)
    #expect(gone?.1 == 0 && gone?.0 == R(0, 25, 800, 960))
    // No displays at all (mid reconfiguration): nothing to place, no crash.
    #expect(LayoutManager.map(entry(R(0, 0, 10, 10), on: screenA.frame), to: ScreenSnapshot(screens: [], rects: [])) == nil)
}

// MARK: - Rectangle import

private func sc(_ s: String) -> Shortcut { Shortcut(s)! }

private var bentoDefaults: [String: Shortcut] {
    var d: [String: Shortcut] = [:]
    for c in WindowCommand.allCases { if let s = c.defaultShortcut { d[c.actionID] = Shortcut(s) } }
    return d
}

private func mas(_ code: Int, _ flags: Int) -> [String: Any] { ["keyCode": code, "modifierFlags": flags] }

private let ctrlOpt = 0x40000 | 0x80000

/// This Mac's Rectangle Pro preferences.
private let thisMacPro: [String: Any] = [
    "leftHalf": mas(43, 0x80000), "rightHalf": mas(47, 0x80000),
    "topHalf": mas(43, 0xA0000), "bottomHalf": mas(47, 0xA0000),
    "moveLeft": mas(123, ctrlOpt), "moveRight": mas(124, ctrlOpt), "moveUp": mas(126, ctrlOpt), "moveDown": mas(125, ctrlOpt),
    "nextDisplayRatio": mas(30, ctrlOpt), "prevDisplayRatio": mas(33, ctrlOpt),
    "nextSpace": mas(30, 0xE0000), "prevSpace": mas(33, 0xE0000),
    "gestures": "[33,{\"flags\":1703936,\"trail\":0},32,{\"flags\":1572864,\"trail\":0}]",
    "almostMaximize": [String: Any](), "centerThird": [String: Any](), "centerTwoThirds": [String: Any](),
    "topLeftSixth": [String: Any](), "fillLeft": [String: Any](), "tidy": [String: Any](),
    "hideMenubarIcon": true, "lastVersion": "192",
]

private func importPlan(_ prefs: [String: Any], pro: Bool = true, settings: WindowsSettings = WindowsSettings()) -> RectangleImport.Plan {
    RectangleImport.plan(prefs: prefs, sourceName: pro ? "Rectangle Pro" : "Rectangle", isPro: pro, settings: settings,
                         current: bentoDefaults, spaces: true)
}

@Test func importThisMacRectanglePro() {
    let p = importPlan(thisMacPro)
    func bound(_ id: String) -> Shortcut? { p.assignments[id]?.shortcut }
    #expect(bound("windows.left-half") == sc("opt+comma"))
    #expect(bound("windows.right-half") == sc("opt+period"))
    #expect(bound("windows.top-half") == sc("opt+shift+comma"))
    #expect(bound("windows.bottom-half") == sc("opt+shift+period"))
    #expect(bound("windows.move-left") == sc("ctrl+opt+left"))
    #expect(bound("windows.move-down") == sc("ctrl+opt+down"))
    #expect(bound("windows.next-display") == sc("ctrl+opt+rightbracket"))
    #expect(bound("windows.previous-display") == sc("ctrl+opt+leftbracket"))
    #expect(bound("windows.next-space") == sc("ctrl+opt+shift+rightbracket"))
    #expect(bound("windows.prev-space") == sc("ctrl+opt+shift+leftbracket"))
    // {} = explicitly unbound.
    #expect(p.assignments["windows.center-third"] == .init(shortcut: nil, origin: .unbound, key: "centerThird"))
    #expect(p.assignments["windows.almost-maximize"]?.origin == .unbound)
    #expect(p.assignments["windows.top-left-sixth"]?.shortcut == nil)
    // Missing = Rectangle's default.
    #expect(p.assignments["windows.first-third"] == .init(shortcut: sc("ctrl+opt+d"), origin: .rectangleDefault, key: "firstThird"))
    #expect(bound("windows.maximize") == sc("ctrl+opt+return"))
    #expect(bound("windows.display-right") == sc("ctrl+opt+cmd+right")) // Pro's plain nextDisplay
    #expect(p.count(.explicit) == 12)
    #expect(p.unbind.isEmpty)
    #expect(p.skipped.isEmpty)
    #expect(p.notes.isEmpty)
    // Gestures: 32 = move, 33 = resize.
    #expect(p.settings.dragMove && Set(p.settings.dragMoveModifiers) == ["cmd", "opt"])
    #expect(p.settings.dragResize && Set(p.settings.dragResizeModifiers) == ["cmd", "opt", "shift"])
    #expect(p.settings.importedFromRectangle)
    // Untouched settings keep their values.
    #expect(p.settings.snapping && p.settings.windowGap == 0 && p.settings.cycleOnRepeat)
}

@Test func importGskm4StyleRectanglePro() {
    var prefs: [String: Any] = [
        "nextDisplayRatio": mas(30, ctrlOpt), "prevDisplayRatio": mas(33, ctrlOpt),
        "gestures": "[32,{\"flags\":1572864,\"trail\":0}]",
        "fillLeft": mas(123, 0x40000 | 0x100000),
    ]
    for k in ["almostMaximize", "firstThird", "centerThird", "lastThird", "firstTwoThirds", "lastTwoThirds", "centerTwoThirds",
              "topLeftSixth", "nextSpace", "prevSpace"] { prefs[k] = [String: Any]() }
    let p = importPlan(prefs)
    #expect(p.assignments["windows.first-third"]?.origin == .unbound)
    #expect(p.assignments["windows.last-two-thirds"]?.shortcut == nil)
    #expect(p.assignments["windows.next-space"]?.origin == .unbound)
    #expect(p.assignments["windows.left-half"]?.shortcut == sc("ctrl+opt+left"))
    #expect(p.assignments["windows.next-display"]?.shortcut == sc("ctrl+opt+rightbracket"))
    #expect(p.skipped == ["fillLeft ⌃⌘←"])
    #expect(p.settings.dragMove && !p.settings.dragResize)
}

@Test func importPlainRectangleFreesConflictingBentoShortcuts() {
    let prefs: [String: Any] = [
        "alternateDefaultShortcuts": true,
        "gapSize": 8, "screenEdgeGapTop": 10,
        "subsequentExecutionMode": 3,
        "cycleSizesIsChanged": true, "selectedCycleSizes": 0b11010,
        "windowSnapping": 2, "almostMaximizeWidth": 0.8, "sizeOffset": 50,
        "applyGapsToMaximize": 2,
    ]
    let p = importPlan(prefs, pro: false)
    // Plain Rectangle's Next/Previous Display defaults to ⌃⌥⌘→/←, which Bento's spatial actions use.
    #expect(p.assignments["windows.next-display"]?.shortcut == sc("ctrl+opt+cmd+right"))
    #expect(p.unbind == ["windows.display-left", "windows.display-right"])
    #expect(p.assignments["windows.next-space"] == nil) // Pro only
    let s = p.settings
    #expect(s.windowGap == 8 && s.screenMargin == 18 && !s.gapsOnMaximize)
    #expect(s.cycleOnRepeat && s.moveToAdjacentDisplayOnRepeat)
    #expect(s.cycleSizes == ["1/4", "1/2", "3/4"])
    #expect(!s.snapping)
    #expect(s.almostMaximizeWidth == 0.8 && s.sizeStep == 50)
    #expect(s.dragMove && s.dragResize) // no gestures key: unchanged
}

@Test func importSpectacleDefaultsAndDuplicates() {
    let p = importPlan(["alternateDefaultShortcuts": false, "maximize": mas(43, 0x80000), "center": mas(43, 0x80000)], pro: false)
    #expect(p.assignments["windows.left-half"]?.shortcut == sc("cmd+opt+left"))
    #expect(p.assignments["windows.top-left"]?.shortcut == sc("ctrl+cmd+left"))
    #expect(p.assignments["windows.first-third"]?.shortcut == nil) // no Spectacle default
    #expect(p.notes.count == 1)
    #expect(RectangleImport.summary(p).contains("2 shortcuts set"))
}

@Test func importValueParsing() {
    #expect(RectangleImport.optionalBool(NSNumber(value: 1)) == true)
    #expect(RectangleImport.optionalBool(NSNumber(value: 2)) == false)
    #expect(RectangleImport.optionalBool(NSNumber(value: 0)) == nil)
    #expect(RectangleImport.optionalBool(true) == true)
    #expect(RectangleImport.optionalBool(false) == false)
    // Function / keypad bits on arrow keys are dropped.
    #expect(RectangleImport.shortcut(mas(123, ctrlOpt | 0x800000 | 0x200000)) == sc("ctrl+opt+left"))
    #expect(RectangleImport.shortcut([String: Any]()) == nil)
    #expect(RectangleImport.modifierNames(0x1A0000) == ["opt", "shift", "cmd"])
}

@Test func symbolicHotKeyParsing() {
    let on: [String: Any] = ["enabled": true, "value": ["parameters": [65535, 124, 8650752], "type": "standard"]]
    let r = SpaceMover.shortcut(fromSymbolicHotKey: on)
    #expect(r?.0 == 124 && r?.1 == [.maskControl, .maskSecondaryFn])
    var off = on
    off["enabled"] = false
    #expect(SpaceMover.shortcut(fromSymbolicHotKey: off) == nil)
}

// MARK: - QA pass: Rectangle snap geometry on the user's 1512×982 screen

/// MacBook Pro 14" default scaling: notch menu bar 33 pt, Dock 61 pt at the bottom.
private let mbp = ScreenRect(frame: R(0, 0, 1512, 982), visible: R(0, 33, 1512, 888))

@Test func snapAreasUseTheFullScreenFrameLikeRectangle() {
    // Rectangle tests the cursor against NSScreen.frame (menu bar included) with
    // 5 pt edge margins and 20 pt corners beyond them: the top area is the
    // first 5 pt of the menu bar, not the strip below it.
    #expect(snap(756, 0, screens: [mbp]) == .maximize)
    #expect(snap(756, 4.9, screens: [mbp]) == .maximize)
    #expect(snap(756, 5, screens: [mbp]) == nil)
    #expect(snap(756, 34, screens: [mbp]) == nil) // just under the menu bar: no snap (same in Rectangle)
    // Right edge near the top is the "top half" short edge (145 pt); the
    // top-right quarter needs both edges within 25 pt.
    #expect(snap(1510, 36, screens: [mbp]) == .topHalf)
    #expect(snap(1510, 24.9, screens: [mbp]) == .topRight)
    #expect(snap(1488, 2, screens: [mbp]) == .topRight)
    #expect(snap(1486, 2, screens: [mbp]) == .maximize)
    #expect(snap(1510, 149, screens: [mbp]) == .topHalf)
    #expect(snap(1510, 151, screens: [mbp]) == .rightHalf)
    #expect(snap(1510, 832, screens: [mbp]) == .rightHalf)
    #expect(snap(1510, 834, screens: [mbp]) == .bottomHalf)
    #expect(snap(1510, 980, screens: [mbp]) == .bottomRight)
    #expect(snap(2, 980, screens: [mbp]) == .bottomLeft)
    // Bottom edge over the Dock: thirds of the full width (504 pt).
    #expect(snap(504, 980, screens: [mbp]) == .firstThird)
    #expect(snap(505, 980, screens: [mbp]) == .centerThird)
    #expect(snap(1008, 980, screens: [mbp]) == .centerThird)
    #expect(snap(1009, 980, screens: [mbp]) == .lastThird)
    #expect(snap(756, 976, screens: [mbp]) == nil)
}

@Test func snapPreviewsMatchRectangleFrames() {
    let o = GeometryOptions()
    func preview(_ c: WindowCommand) -> CGRect { Geometry.rect(for: c, count: 0, in: mbp.visible, window: someWindow, options: o) }
    #expect(preview(.maximize) == R(0, 33, 1512, 888))
    #expect(preview(.topLeft) == R(0, 33, 756, 444))
    #expect(preview(.bottomRight) == R(756, 477, 756, 444))
    #expect(preview(.topHalf) == R(0, 33, 1512, 444))
    #expect(preview(.firstThird) == R(0, 33, 504, 888))
    #expect(preview(.firstTwoThirds) == R(0, 33, 1008, 888))
    #expect(preview(.centerTwoThirds) == R(252, 33, 1008, 888))
}

@Test func titleBarUnsnapKeepsTheWindowUnderTheGrabPoint() {
    let snapped = R(0, 33, 756, 888), size = CGSize(width: 600, height: 400)
    // Grabbed near the left: the narrower window still contains the grab point, nothing moves.
    #expect(Geometry.titleBarUnsnapShift(current: snapped, size: size, grabX: 110) == 0)
    // Grabbed beyond the new width: shift right just enough (32 pt inside the right edge)…
    #expect(Geometry.titleBarUnsnapShift(current: snapped, size: size, grabX: 700) == 132)
    // …but never past the old right edge.
    #expect(Geometry.titleBarUnsnapShift(current: snapped, size: size, grabX: 755) == 156)
    // Restoring to a larger size never shifts.
    #expect(Geometry.titleBarUnsnapShift(current: R(0, 33, 400, 400), size: size, grabX: 390) == 0)
}

// MARK: - QA pass: modifier-drag gestures

@Test func pressWithoutTravelIsAClick() {
    var g = DragGesture(start: CGPoint(x: 100, y: 100))
    let jitter = g.drag(to: CGPoint(x: 101, y: 101)) // below the threshold
    #expect(!jitter && !g.moving)
    let r = g.release(at: CGPoint(x: 101, y: 102))
    #expect(r == .replayClick && g.ended)
}

@Test func travelTurnsAPressIntoADragOnce() {
    var g = DragGesture(start: CGPoint(x: 100, y: 100))
    let a = g.drag(to: CGPoint(x: 102, y: 100))
    let b = g.drag(to: CGPoint(x: 103, y: 100))   // crosses 3 pt: starts the drag
    let c = g.drag(to: CGPoint(x: 300, y: 250))   // already dragging
    #expect(!a && b && !c)
    #expect(g.latest == CGPoint(x: 300, y: 250))
    // Coming back near the start doesn't make it a click again.
    let r = g.release(at: CGPoint(x: 100, y: 100))
    #expect(r == .finishDrag)
}

@Test func releaseFarAwayWithoutDragEventsStillMoves() {
    var g = DragGesture(start: CGPoint(x: 100, y: 100))
    let r = g.release(at: CGPoint(x: 400, y: 100))
    #expect(r == .finishDrag)
    #expect(g.moving && g.latest == CGPoint(x: 400, y: 100))
}

// MARK: - QA pass: hostile input never traps

@Test func oddConfigNumbersAreSanitized() {
    var s = WindowsSettings()
    s.windowGap = .infinity
    s.screenMargin = .nan
    s.sizeStep = -.infinity
    s.almostMaximizeWidth = .nan
    s.almostMaximizeHeight = 7
    let o = s.geometry
    #expect(o.windowGap == 0 && o.screenMargin == 0 && o.sizeStep == 30)
    #expect(o.almostMaximize == CGSize(width: 0.9, height: 1))
    #expect(WindowsSettings.points(.nan) == 0 && WindowsSettings.points(.infinity) == 0 && WindowsSettings.points(12.4) == 12)
    #expect(WindowsSettings.fraction("1/inf") == nil && WindowsSettings.fraction("nan/2") == nil)
}

@Test func hostileRectanglePrefsDontTrap() {
    let p = importPlan(["gapSize": Double.infinity, "screenEdgeGapTop": Double.nan, "sizeOffset": Double.infinity,
                        "leftHalf": mas(1 << 40, 0x80000), "rightHalf": mas(-5, 0x80000)], pro: false)
    #expect(p.settings.windowGap == 0 && p.settings.screenMargin == 0)
    #expect(p.settings.sizeStep == 30)
    #expect(p.assignments["windows.left-half"]?.origin == .unbound)
    #expect(RectangleImport.summary(p).contains("shortcuts set"))
    #expect(SpaceMover.shortcut(fromSymbolicHotKey: ["enabled": true, "value": ["parameters": [65535, 1 << 20, 0]]]) == nil)
    #expect(StashManager.hiddenFrame(R(0, 0, 10, 10), edge: .left, screen: 3, screens: [screenA], sliver: 12) == nil)
}

@Test func importReadsRectangleExportJSON() throws {
    let json = """
    {"bundleId": "com.knollsoft.Rectangle", "version": "92",
     "shortcuts": {"leftHalf": {"keyCode": 123, "modifierFlags": 786432}, "maximize": {"keyCode": 36, "modifierFlags": 786432}},
     "defaults": {"gapSize": {"float": 6}, "windowSnapping": {"int": 2}, "alternateDefaultShortcuts": {"bool": true},
                  "subsequentExecutionMode": {"int": 2}}}
    """
    let prefs = try #require(RectangleImport.parse(Data(json.utf8)))
    let src = RectangleImport.source(forFile: URL(fileURLWithPath: "/tmp/RectangleConfig.json"), prefs: prefs)
    #expect(src.name == "Rectangle" && !src.isPro)
    let p = RectangleImport.plan(prefs: prefs, sourceName: src.name, isPro: src.isPro, settings: WindowsSettings(),
                                 current: bentoDefaults, spaces: true)
    #expect(p.assignments["windows.left-half"]?.shortcut == sc("ctrl+opt+left"))
    #expect(p.assignments["windows.left-half"]?.origin == .explicit)
    #expect(p.assignments["windows.first-third"]?.origin == .rectangleDefault)
    #expect(p.settings.windowGap == 6 && !p.settings.snapping && !p.settings.cycleOnRepeat)
    #expect(p.skipped.isEmpty)
    // A Pro preferences plist is recognised by its keys even under another name.
    let plist = try PropertyListSerialization.data(fromPropertyList: thisMacPro, format: .binary, options: 0)
    let proPrefs = try #require(RectangleImport.parse(plist))
    #expect(RectangleImport.source(forFile: URL(fileURLWithPath: "/tmp/backup.plist"), prefs: proPrefs).isPro)
    #expect(RectangleImport.parse(Data("not a plist".utf8)) == nil)
}

@Test func dragModeFollowsModifiersExactly() {
    var cfg = DragController.Config()
    cfg.move = [.maskCommand, .maskAlternate]
    cfg.resize = [.maskCommand, .maskAlternate, .maskShift]
    #expect(DragController.mode(for: [.maskCommand, .maskAlternate], cfg) == .move)
    #expect(DragController.mode(for: [.maskCommand, .maskAlternate, .maskShift], cfg) == .resize)
    // Caps Lock / fn / numeric-pad bits don't matter; other combinations don't match.
    #expect(DragController.mode(for: [.maskCommand, .maskAlternate, .maskAlphaShift, .maskSecondaryFn], cfg) == .move)
    #expect(DragController.mode(for: [.maskCommand], cfg) == nil)
    #expect(DragController.mode(for: [.maskCommand, .maskAlternate, .maskControl], cfg) == nil)
    #expect(DragController.mode(for: [], cfg) == nil)
    // Same modifiers for both: resize wins.
    cfg.resize = cfg.move
    #expect(DragController.mode(for: [.maskCommand, .maskAlternate], cfg) == .resize)
    // A disabled mode never matches.
    cfg.resize = []
    #expect(DragController.mode(for: [.maskCommand, .maskAlternate, .maskShift], cfg) == nil)
}
