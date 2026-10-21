import CoreGraphics

// Pure window geometry. Everything here works in AX coordinates (origin at the
// top-left of the primary display, y grows downwards), so "top" is `minY`.
// No AppKit, no AX: the whole file is unit-tested.

/// One display: full frame and the part not covered by the menu bar / Dock.
struct ScreenRect: Equatable {
    var frame: CGRect
    var visible: CGRect

    init(frame: CGRect, visible: CGRect) {
        self.frame = frame
        self.visible = visible
    }

    /// Convenience for tests: a screen with a menu bar and no Dock.
    init(frame: CGRect, menuBar: CGFloat = 0) {
        self.frame = frame
        self.visible = CGRect(x: frame.minX, y: frame.minY + menuBar, width: frame.width, height: frame.height - menuBar)
    }
}

struct GapDims: OptionSet {
    let rawValue: Int
    static let horizontal = GapDims(rawValue: 1)
    static let vertical = GapDims(rawValue: 2)
    static let both: GapDims = [.horizontal, .vertical]
}

struct GeometryOptions: Equatable {
    /// Space between two windows placed side by side.
    var windowGap: CGFloat = 0
    /// Space between windows and the screen edges.
    var screenMargin: CGFloat = 0
    var gapsOnMaximize = true
    /// Repeating an action cycles sizes (½ → ⅔ → ⅓) or positions (thirds, sixths…).
    var cycleOnRepeat = true
    /// Sizes to cycle through, in cycling order (see `Geometry.cycleOrder`).
    var cycleFractions: [CGFloat] = [1.0 / 2, 2.0 / 3, 1.0 / 3]
    /// Repeating Left/Right Half (or Move Left/Right) moves to the adjacent display.
    var traverseDisplays = false
    var almostMaximize = CGSize(width: 0.9, height: 0.9)
    /// Step for Make Larger / Make Smaller, in points.
    var sizeStep: CGFloat = 30
    /// Move Left/Right also centres vertically (and Up/Down horizontally).
    var centeredDirectionalMove = true
    /// Make Smaller stops at this fraction of the screen.
    var minimumFraction: CGFloat = 0.25
}

/// What Bento last did to a window, used to detect repeated executions.
struct LastAction: Equatable {
    var command: WindowCommand
    /// The window frame right after the action (as the app actually applied it).
    var rect: CGRect
    /// 0 for the first execution, +1 for every repeat.
    var count: Int
}

struct GeometryInput {
    var command: WindowCommand
    var window: CGRect
    var screens: [ScreenRect]
    var screenIndex: Int
    var last: LastAction?
    var options = GeometryOptions()
}

struct GeometryResult: Equatable {
    var rect: CGRect
    var screenIndex: Int
    /// Recorded as the window's last action (may differ from the input command,
    /// e.g. Left Half traversing to the previous display becomes Right Half).
    var command: WindowCommand
    var count: Int
}

enum Geometry {
    /// Frames from AX are rounded by apps; this is how close counts as "same".
    static let tolerance: CGFloat = 2

    static func near(_ a: CGRect, _ b: CGRect, tolerance t: CGFloat = tolerance) -> Bool {
        abs(a.minX - b.minX) <= t && abs(a.minY - b.minY) <= t
            && abs(a.width - b.width) <= t && abs(a.height - b.height) <= t
    }

    static func isLandscape(_ r: CGRect) -> Bool { r.width >= r.height }

    // MARK: Entry point

    static func calculate(_ input: GeometryInput) -> GeometryResult? {
        guard input.screens.indices.contains(input.screenIndex) else { return nil }
        let cmd = input.command
        let o = input.options
        let visible = input.screens[input.screenIndex].visible
        if cmd == .restore || cmd.isMultiWindow { return nil }
        if cmd.isDisplayMove { return displayMove(input) }

        let isRepeat = input.last.map { $0.command == cmd && near($0.rect, input.window) } ?? false
        let count = isRepeat ? (input.last?.count ?? 0) + 1 : 0

        if isRepeat, o.traverseDisplays, let opposite = traverseOpposite(cmd),
           let n = neighbor(of: input.screenIndex, in: input.screens, direction: (cmd == .leftHalf || cmd == .moveLeft) ? -1 : 1) {
            let r = rect(for: opposite, count: 0, in: input.screens[n].visible, window: input.window, options: o)
            return GeometryResult(rect: r, screenIndex: n, command: opposite, count: 0)
        }
        let r = rect(for: cmd, count: count, in: visible, window: input.window, options: o)
        return GeometryResult(rect: r, screenIndex: input.screenIndex, command: cmd, count: count)
    }

    private static func traverseOpposite(_ cmd: WindowCommand) -> WindowCommand? {
        switch cmd {
        case .leftHalf: return .rightHalf
        case .rightHalf: return .leftHalf
        case .moveLeft: return .moveRight
        case .moveRight: return .moveLeft
        default: return nil
        }
    }

    /// Final frame for a command on one screen: base rect or cycled variant,
    /// with gaps applied and rounded to whole points.
    static func rect(for cmd: WindowCommand, count: Int, in v: CGRect, window: CGRect, options o: GeometryOptions) -> CGRect {
        if count > 0, o.cycleOnRepeat {
            if let seq = positionCycle(cmd, landscape: isLandscape(v)) {
                let target = seq[count % seq.count]
                return finalize(baseRect(target, in: v, window: window, options: o), command: target, in: v, options: o)
            }
            if cyclesSize(cmd) {
                let fractions = o.cycleFractions.isEmpty ? [0.5] : o.cycleFractions
                let n = fractions.count
                let hasHalf = fractions.contains { abs($0 - 0.5) < 0.001 }
                // Without ½ in the list the first press still gives ½ and the
                // cycle starts on the second press (Rectangle's behaviour).
                var idx = hasHalf ? count % n : max(0, count - 1) % n
                for _ in 0..<n {
                    let r = finalize(fractionalRect(cmd, fraction: fractions[idx], in: v), command: cmd, in: v, options: o)
                    if !near(r, window) { return r }
                    idx = (idx + 1) % n
                }
            }
        }
        return finalize(baseRect(cmd, in: v, window: window, options: o), command: cmd, in: v, options: o)
    }

    // MARK: Cycling

    /// Rectangle's cycle order: ½ first, then larger sizes ascending, then the smaller ones.
    static func cycleOrder(_ selected: [CGFloat]) -> [CGFloat] {
        let uniq = selected.reduce(into: [CGFloat]()) { acc, f in if !acc.contains(where: { abs($0 - f) < 0.001 }) { acc.append(f) } }
        let larger = uniq.filter { $0 >= 0.5 - 0.0001 }.sorted()
        let smaller = uniq.filter { $0 < 0.5 - 0.0001 }.sorted()
        return larger + smaller
    }

    static func cyclesSize(_ cmd: WindowCommand) -> Bool {
        switch cmd {
        case .leftHalf, .rightHalf, .topHalf, .bottomHalf, .centerHalf,
             .topLeft, .topRight, .bottomLeft, .bottomRight: return true
        default: return false
        }
    }

    private static func rotated(_ order: [WindowCommand], from start: WindowCommand) -> [WindowCommand] {
        guard let i = order.firstIndex(of: start) else { return order }
        return Array(order[i...] + order[..<i])
    }

    /// Repeating these moves the window to the next position in the sequence.
    static func positionCycle(_ cmd: WindowCommand, landscape: Bool) -> [WindowCommand]? {
        switch cmd {
        case .firstThird: return [.firstThird, .centerThird, .lastThird]
        case .lastThird: return [.lastThird, .centerThird, .firstThird]
        case .firstTwoThirds: return [.firstTwoThirds, .lastTwoThirds]
        case .lastTwoThirds: return [.lastTwoThirds, .firstTwoThirds]
        case .firstFourth: return [.firstFourth, .secondFourth, .thirdFourth, .lastFourth]
        case .lastFourth: return [.lastFourth, .thirdFourth, .secondFourth, .firstFourth]
        case .firstThreeFourths: return [.firstThreeFourths, .lastThreeFourths]
        case .lastThreeFourths: return [.lastThreeFourths, .firstThreeFourths]
        case .topVerticalThird: return [.topVerticalThird, .middleVerticalThird, .bottomVerticalThird]
        case .bottomVerticalThird: return [.bottomVerticalThird, .middleVerticalThird, .topVerticalThird]
        case .topVerticalTwoThirds: return [.topVerticalTwoThirds, .bottomVerticalTwoThirds]
        case .bottomVerticalTwoThirds: return [.bottomVerticalTwoThirds, .topVerticalTwoThirds]
        case .topLeftSixth, .topCenterSixth, .topRightSixth, .bottomLeftSixth, .bottomCenterSixth, .bottomRightSixth:
            // Reading order of the cells on this orientation.
            let order: [WindowCommand] = landscape
                ? [.topLeftSixth, .topCenterSixth, .topRightSixth, .bottomLeftSixth, .bottomCenterSixth, .bottomRightSixth]
                : [.topLeftSixth, .topRightSixth, .topCenterSixth, .bottomCenterSixth, .bottomLeftSixth, .bottomRightSixth]
            return rotated(order, from: cmd)
        case .topLeftNinth, .topCenterNinth, .topRightNinth, .middleLeftNinth, .middleCenterNinth, .middleRightNinth,
             .bottomLeftNinth, .bottomCenterNinth, .bottomRightNinth:
            return rotated(ninths, from: cmd)
        case .topLeftEighth, .topCenterLeftEighth, .topCenterRightEighth, .topRightEighth,
             .bottomLeftEighth, .bottomCenterLeftEighth, .bottomCenterRightEighth, .bottomRightEighth:
            return rotated(eighths, from: cmd)
        case .topLeftThird, .topRightThird, .bottomLeftThird, .bottomRightThird:
            return rotated([.topLeftThird, .topRightThird, .bottomLeftThird, .bottomRightThird], from: cmd)
        default: return nil
        }
    }

    static let ninths: [WindowCommand] = [.topLeftNinth, .topCenterNinth, .topRightNinth,
                                          .middleLeftNinth, .middleCenterNinth, .middleRightNinth,
                                          .bottomLeftNinth, .bottomCenterNinth, .bottomRightNinth]
    static let eighths: [WindowCommand] = [.topLeftEighth, .topCenterLeftEighth, .topCenterRightEighth, .topRightEighth,
                                           .bottomLeftEighth, .bottomCenterLeftEighth, .bottomCenterRightEighth, .bottomRightEighth]

    // MARK: Grid helpers

    /// Grid line `i` of `n` across a span, on whole points; neighbours tile exactly.
    static func line(_ start: CGFloat, _ length: CGFloat, _ i: Int, _ n: Int) -> CGFloat {
        start + (length * CGFloat(i) / CGFloat(n)).rounded()
    }

    static func cell(_ v: CGRect, cols: Int, rows: Int, col: Int, row: Int, colSpan: Int = 1, rowSpan: Int = 1) -> CGRect {
        let x0 = line(v.minX, v.width, col, cols), x1 = line(v.minX, v.width, col + colSpan, cols)
        let y0 = line(v.minY, v.height, row, rows), y1 = line(v.minY, v.height, row + rowSpan, rows)
        return CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
    }

    /// Columns on landscape screens, rows on portrait ones.
    static func slice(_ v: CGRect, _ n: Int, _ i: Int, span: Int = 1) -> CGRect {
        isLandscape(v)
            ? cell(v, cols: n, rows: 1, col: i, row: 0, colSpan: span)
            : cell(v, cols: 1, rows: n, col: 0, row: i, rowSpan: span)
    }

    /// A centred band along the main axis (full height on landscape screens).
    static func centeredBand(_ v: CGRect, fraction: CGFloat) -> CGRect {
        if isLandscape(v) {
            let w = (v.width * fraction).rounded()
            return CGRect(x: v.minX + ((v.width - w) / 2).rounded(), y: v.minY, width: w, height: v.height)
        }
        let h = (v.height * fraction).rounded()
        return CGRect(x: v.minX, y: v.minY + ((v.height - h) / 2).rounded(), width: v.width, height: h)
    }

    // MARK: Base rects

    static func baseRect(_ cmd: WindowCommand, in v: CGRect, window w: CGRect, options o: GeometryOptions) -> CGRect {
        let landscape = isLandscape(v)
        switch cmd {
        case .leftHalf: return cell(v, cols: 2, rows: 1, col: 0, row: 0)
        case .rightHalf: return cell(v, cols: 2, rows: 1, col: 1, row: 0)
        case .topHalf: return cell(v, cols: 1, rows: 2, col: 0, row: 0)
        case .bottomHalf: return cell(v, cols: 1, rows: 2, col: 0, row: 1)
        case .centerHalf: return centeredBand(v, fraction: 0.5)
        case .topLeft: return cell(v, cols: 2, rows: 2, col: 0, row: 0)
        case .topRight: return cell(v, cols: 2, rows: 2, col: 1, row: 0)
        case .bottomLeft: return cell(v, cols: 2, rows: 2, col: 0, row: 1)
        case .bottomRight: return cell(v, cols: 2, rows: 2, col: 1, row: 1)

        case .firstThird: return slice(v, 3, 0)
        case .centerThird: return slice(v, 3, 1)
        case .lastThird: return slice(v, 3, 2)
        case .firstTwoThirds: return slice(v, 3, 0, span: 2)
        case .lastTwoThirds: return slice(v, 3, 1, span: 2)
        case .centerTwoThirds: return centeredBand(v, fraction: 2.0 / 3)

        case .firstFourth: return slice(v, 4, 0)
        case .secondFourth: return slice(v, 4, 1)
        case .thirdFourth: return slice(v, 4, 2)
        case .lastFourth: return slice(v, 4, 3)
        case .firstThreeFourths: return slice(v, 4, 0, span: 3)
        case .lastThreeFourths: return slice(v, 4, 1, span: 3)
        case .centerThreeFourths: return centeredBand(v, fraction: 0.75)

        case .topLeftSixth, .topCenterSixth, .topRightSixth, .bottomLeftSixth, .bottomCenterSixth, .bottomRightSixth:
            let order: [WindowCommand] = landscape
                ? [.topLeftSixth, .topCenterSixth, .topRightSixth, .bottomLeftSixth, .bottomCenterSixth, .bottomRightSixth]
                : [.topLeftSixth, .topRightSixth, .topCenterSixth, .bottomCenterSixth, .bottomLeftSixth, .bottomRightSixth]
            let i = order.firstIndex(of: cmd) ?? 0
            let cols = landscape ? 3 : 2
            return cell(v, cols: cols, rows: 6 / cols, col: i % cols, row: i / cols)

        case .topLeftNinth, .topCenterNinth, .topRightNinth, .middleLeftNinth, .middleCenterNinth, .middleRightNinth,
             .bottomLeftNinth, .bottomCenterNinth, .bottomRightNinth:
            let i = ninths.firstIndex(of: cmd) ?? 0
            return cell(v, cols: 3, rows: 3, col: i % 3, row: i / 3)

        case .topLeftEighth, .topCenterLeftEighth, .topCenterRightEighth, .topRightEighth,
             .bottomLeftEighth, .bottomCenterLeftEighth, .bottomCenterRightEighth, .bottomRightEighth:
            let i = eighths.firstIndex(of: cmd) ?? 0
            let cols = landscape ? 4 : 2
            return cell(v, cols: cols, rows: 8 / cols, col: i % cols, row: i / cols)

        case .topLeftThird, .topRightThird, .bottomLeftThird, .bottomRightThird:
            let right = cmd == .topRightThird || cmd == .bottomRightThird
            let bottom = cmd == .bottomLeftThird || cmd == .bottomRightThird
            return landscape
                ? cell(v, cols: 3, rows: 2, col: right ? 1 : 0, row: bottom ? 1 : 0, colSpan: 2)
                : cell(v, cols: 2, rows: 3, col: right ? 1 : 0, row: bottom ? 1 : 0, rowSpan: 2)

        case .topVerticalThird: return cell(v, cols: 1, rows: 3, col: 0, row: 0)
        case .middleVerticalThird: return cell(v, cols: 1, rows: 3, col: 0, row: 1)
        case .bottomVerticalThird: return cell(v, cols: 1, rows: 3, col: 0, row: 2)
        case .topVerticalTwoThirds: return cell(v, cols: 1, rows: 3, col: 0, row: 0, rowSpan: 2)
        case .bottomVerticalTwoThirds: return cell(v, cols: 1, rows: 3, col: 0, row: 1, rowSpan: 2)

        case .maximize: return v
        case .almostMaximize:
            let wd = (v.width * o.almostMaximize.width).rounded(), ht = (v.height * o.almostMaximize.height).rounded()
            return CGRect(x: v.minX + ((v.width - wd) / 2).rounded(), y: v.minY + ((v.height - ht) / 2).rounded(), width: wd, height: ht)
        case .maximizeHeight:
            return CGRect(x: w.minX, y: v.minY, width: w.width, height: v.height)
        case .center: return centered(w, in: v)
        case .larger, .smaller, .largerWidth, .smallerWidth, .largerHeight, .smallerHeight:
            return changeSize(cmd, window: w, in: v, options: o)
        case .moveLeft, .moveRight, .moveUp, .moveDown:
            return moved(cmd, window: w, in: v, options: o)
        case .halveWidthLeft, .halveWidthRight, .halveHeightUp, .halveHeightDown,
             .doubleWidthLeft, .doubleWidthRight, .doubleHeightUp, .doubleHeightDown:
            return halvedOrDoubled(cmd, window: w, in: v, options: o)
        case .restore, .nextDisplay, .previousDisplay, .displayLeft, .displayRight,
             .tileAll, .cascadeAll, .tileActiveApp, .cascadeActiveApp:
            return w
        }
    }

    /// The cycled variants of the size-cycling commands.
    static func fractionalRect(_ cmd: WindowCommand, fraction f: CGFloat, in v: CGRect) -> CGRect {
        let wd = (v.width * f).rounded(), ht = (v.height * f).rounded()
        let midY = line(v.minY, v.height, 1, 2)
        switch cmd {
        case .leftHalf: return CGRect(x: v.minX, y: v.minY, width: wd, height: v.height)
        case .rightHalf: return CGRect(x: v.maxX - wd, y: v.minY, width: wd, height: v.height)
        case .topHalf: return CGRect(x: v.minX, y: v.minY, width: v.width, height: ht)
        case .bottomHalf: return CGRect(x: v.minX, y: v.maxY - ht, width: v.width, height: ht)
        case .centerHalf: return centeredBand(v, fraction: f)
        case .topLeft: return CGRect(x: v.minX, y: v.minY, width: wd, height: midY - v.minY)
        case .topRight: return CGRect(x: v.maxX - wd, y: v.minY, width: wd, height: midY - v.minY)
        case .bottomLeft: return CGRect(x: v.minX, y: midY, width: wd, height: v.maxY - midY)
        case .bottomRight: return CGRect(x: v.maxX - wd, y: midY, width: wd, height: v.maxY - midY)
        default: return baseRect(cmd, in: v, window: v, options: GeometryOptions())
        }
    }

    /// Rectangle's Center: keep the size, centre on the screen; an axis that
    /// doesn't fit spans the screen.
    static func centered(_ w: CGRect, in v: CGRect) -> CGRect {
        let tooTall = w.height > v.height, tooWide = w.width > v.width
        if tooTall && tooWide { return v }
        var r = w
        if tooTall { r.origin.y = v.minY; r.size.height = v.height } else { r.origin.y = v.minY + ((v.height - w.height) / 2).rounded() }
        if tooWide { r.origin.x = v.minX; r.size.width = v.width } else { r.origin.x = v.minX + ((v.width - w.width) / 2).rounded() }
        return r
    }

    /// Rectangle's Make Larger / Smaller with "curtain" behaviour: a window
    /// edge resting on a screen edge stays there.
    static func changeSize(_ cmd: WindowCommand, window w: CGRect, in v: CGRect, options o: GeometryOptions) -> CGRect {
        let step = max(1, o.sizeStep)
        let offset: CGFloat
        switch cmd {
        case .larger, .largerWidth, .largerHeight: offset = step
        default: offset = -step
        }
        let m = o.screenMargin
        let tol = max(5, m + 1)
        let left = abs(w.minX - v.minX) <= tol, right = abs(w.maxX - v.maxX) <= tol
        let top = abs(w.minY - v.minY) <= tol, bottom = abs(w.maxY - v.maxY) <= tol
        var r = w

        if [.larger, .smaller, .largerWidth, .smallerWidth].contains(cmd) {
            r.size.width += offset
            r.origin.x -= (offset / 2).rounded(.down)
            if right {
                r.origin.x = v.maxX - r.width - m
                if left { r.size.width = v.width - 2 * m }
            }
            if left { r.origin.x = v.minX + m }
            if r.width >= v.width { r.size.width = v.width }
        }
        if [.larger, .smaller, .largerHeight, .smallerHeight].contains(cmd) {
            r.size.height += offset
            r.origin.y -= (offset / 2).rounded(.down)
            if cmd != .smallerHeight {
                if top {
                    r.origin.y = v.minY + m
                    if bottom { r.size.height = v.height - 2 * m }
                }
                if bottom { r.origin.y = v.maxY - r.height - m }
            }
            if r.height >= v.height { r.size.height = v.height; r.origin.y = w.minY }
        }
        if left && right && top && bottom && offset < 0 {
            // A maximized window shrinks around its centre.
            if cmd == .smaller || cmd == .smallerWidth {
                r.size.width = w.width + offset
                r.origin.x = w.minX - (offset / 2).rounded(.down)
            }
            if cmd == .smaller || cmd == .smallerHeight {
                r.size.height = w.height + offset
                r.origin.y = w.minY - (offset / 2).rounded(.down)
            }
        }
        if offset < 0, tooSmall(r, in: v, o) { return w }
        if offset > 0 { r = clamp(r, into: v) }
        return r
    }

    static func tooSmall(_ r: CGRect, in v: CGRect, _ o: GeometryOptions) -> Bool {
        r.width < max(1, (v.width * o.minimumFraction).rounded(.down)) || r.height < max(1, (v.height * o.minimumFraction).rounded(.down))
    }

    /// Shifts (never resizes beyond fitting) a rect so it lies inside `v`.
    static func clamp(_ r: CGRect, into v: CGRect) -> CGRect {
        var r = r
        r.size.width = min(r.width, v.width)
        r.size.height = min(r.height, v.height)
        if r.maxX > v.maxX { r.origin.x = v.maxX - r.width }
        if r.minX < v.minX { r.origin.x = v.minX }
        if r.maxY > v.maxY { r.origin.y = v.maxY - r.height }
        if r.minY < v.minY { r.origin.y = v.minY }
        return r
    }

    /// Move to an edge without resizing (Rectangle's Move Left/Right/Up/Down).
    static func moved(_ cmd: WindowCommand, window w: CGRect, in v: CGRect, options o: GeometryOptions) -> CGRect {
        let inner = v.insetBy(dx: o.screenMargin, dy: o.screenMargin)
        var r = w
        switch cmd {
        case .moveLeft, .moveRight:
            r.origin.x = cmd == .moveLeft ? inner.minX : inner.maxX - r.width
            if o.centeredDirectionalMove { r.origin.y = v.minY + ((v.height - r.height) / 2).rounded() }
            if w.height >= v.height { r.size.height = v.height; r.origin.y = v.minY }
        default:
            r.origin.y = cmd == .moveUp ? inner.minY : inner.maxY - r.height
            if o.centeredDirectionalMove { r.origin.x = v.minX + ((v.width - r.width) / 2).rounded() }
            if w.width >= v.width { r.size.width = v.width; r.origin.x = v.minX }
        }
        return r
    }

    static func halvedOrDoubled(_ cmd: WindowCommand, window w: CGRect, in v: CGRect, options o: GeometryOptions) -> CGRect {
        var r = w
        switch cmd {
        case .halveWidthLeft: r.size.width = (w.width / 2).rounded()
        case .halveWidthRight: r.size.width = (w.width / 2).rounded(); r.origin.x = w.maxX - r.width
        case .halveHeightUp: r.size.height = (w.height / 2).rounded()
        case .halveHeightDown: r.size.height = (w.height / 2).rounded(); r.origin.y = w.maxY - r.height
        case .doubleWidthLeft: r.size.width = w.width * 2; r.origin.x = w.minX - w.width
        case .doubleWidthRight: r.size.width = w.width * 2
        case .doubleHeightUp: r.size.height = w.height * 2; r.origin.y = w.minY - w.height
        case .doubleHeightDown: r.size.height = w.height * 2
        default: break
        }
        if r.width < w.width || r.height < w.height, tooSmall(r, in: v, o) { return w }
        return r
    }

    // MARK: Gaps

    static func gapDims(_ cmd: WindowCommand, _ o: GeometryOptions) -> GapDims {
        switch cmd {
        case .maximize: return o.gapsOnMaximize ? .both : []
        case .maximizeHeight: return o.gapsOnMaximize ? .vertical : []
        case .almostMaximize, .center, .larger, .smaller, .largerWidth, .smallerWidth, .largerHeight, .smallerHeight,
             .moveLeft, .moveRight, .moveUp, .moveDown, .restore, .nextDisplay, .previousDisplay, .displayLeft, .displayRight,
             .halveWidthLeft, .halveWidthRight, .halveHeightUp, .halveHeightDown,
             .doubleWidthLeft, .doubleWidthRight, .doubleHeightUp, .doubleHeightDown,
             .tileAll, .cascadeAll, .tileActiveApp, .cascadeActiveApp:
            return []
        default: return .both
        }
    }

    /// Edges on a screen edge move in by the margin, edges shared with a
    /// neighbouring slot move in by half the window gap (so two neighbours end
    /// up exactly one gap apart).
    static func applyGaps(_ r: CGRect, in v: CGRect, dims: GapDims, gap: CGFloat, margin: CGFloat) -> CGRect {
        guard !dims.isEmpty, gap > 0 || margin > 0 else { return r }
        var minX = r.minX, maxX = r.maxX, minY = r.minY, maxY = r.maxY
        let t: CGFloat = 1
        if dims.contains(.horizontal) {
            minX += abs(r.minX - v.minX) <= t ? margin : gap / 2
            maxX -= abs(r.maxX - v.maxX) <= t ? margin : gap / 2
        }
        if dims.contains(.vertical) {
            minY += abs(r.minY - v.minY) <= t ? margin : gap / 2
            maxY -= abs(r.maxY - v.maxY) <= t ? margin : gap / 2
        }
        return CGRect(x: minX, y: minY, width: max(1, maxX - minX), height: max(1, maxY - minY))
    }

    static func integral(_ r: CGRect) -> CGRect {
        let x0 = r.minX.rounded(), y0 = r.minY.rounded()
        return CGRect(x: x0, y: y0, width: max(1, r.maxX.rounded() - x0), height: max(1, r.maxY.rounded() - y0))
    }

    static func finalize(_ r: CGRect, command: WindowCommand, in v: CGRect, options o: GeometryOptions) -> CGRect {
        integral(applyGaps(r, in: v, dims: gapDims(command, o), gap: o.windowGap, margin: o.screenMargin))
    }

    // MARK: Displays

    /// Screens ordered left to right (then top to bottom) for next/previous.
    static func displayOrder(_ screens: [ScreenRect]) -> [Int] {
        screens.indices.sorted {
            let a = screens[$0].frame, b = screens[$1].frame
            return a.minX != b.minX ? a.minX < b.minX : a.minY < b.minY
        }
    }

    /// Next/previous display in left-to-right order, wrapping around.
    static func cycledDisplay(from i: Int, in screens: [ScreenRect], step: Int) -> Int? {
        guard screens.count > 1 else { return nil }
        let order = displayOrder(screens)
        guard let pos = order.firstIndex(of: i) else { return nil }
        return order[((pos + step) % order.count + order.count) % order.count]
    }

    /// The display spatially to the left (-1) or right (+1), without wrapping.
    static func neighbor(of i: Int, in screens: [ScreenRect], direction: Int) -> Int? {
        guard screens.indices.contains(i) else { return nil }
        let cur = screens[i].frame
        let candidates = screens.indices.filter { j in
            j != i && (direction < 0 ? screens[j].frame.midX < cur.midX : screens[j].frame.midX > cur.midX)
        }
        return candidates.min { a, b in
            score(screens[a].frame, from: cur, direction) < score(screens[b].frame, from: cur, direction)
        }
    }

    private static func score(_ s: CGRect, from cur: CGRect, _ direction: Int) -> CGFloat {
        let horizontal = direction < 0 ? max(0, cur.minX - s.maxX) : max(0, s.minX - cur.maxX)
        let vertical = abs(s.midY - cur.midY)
        return horizontal * 4 + vertical
    }

    static func displayMove(_ input: GeometryInput) -> GeometryResult? {
        let screens = input.screens, cur = input.screenIndex
        let target: Int?
        switch input.command {
        case .nextDisplay: target = cycledDisplay(from: cur, in: screens, step: 1)
        case .previousDisplay: target = cycledDisplay(from: cur, in: screens, step: -1)
        case .displayLeft: target = neighbor(of: cur, in: screens, direction: -1)
        case .displayRight: target = neighbor(of: cur, in: screens, direction: 1)
        default: target = nil
        }
        guard let t = target, t != cur else { return nil }
        let dst = screens[t].visible
        // A window Bento placed (e.g. Left Half, ⅔ cycle) is placed the same way there.
        if let last = input.last, last.command.isPositional, near(last.rect, input.window) {
            let r = rect(for: last.command, count: last.count, in: dst, window: input.window, options: input.options)
            return GeometryResult(rect: r, screenIndex: t, command: last.command, count: last.count)
        }
        let r = proportional(input.window, from: screens[cur].visible, to: dst)
        return GeometryResult(rect: r, screenIndex: t, command: input.command, count: 0)
    }

    /// Maps a frame between screens keeping its relative position and size.
    static func proportional(_ w: CGRect, from s: CGRect, to d: CGRect) -> CGRect {
        guard s.width > 0, s.height > 0 else { return w }
        let r = CGRect(x: d.minX + (w.minX - s.minX) / s.width * d.width,
                       y: d.minY + (w.minY - s.minY) / s.height * d.height,
                       width: w.width / s.width * d.width,
                       height: w.height / s.height * d.height)
        return integral(clamp(r, into: d))
    }

    // MARK: Several windows

    /// A grid for `count` windows; the last row stretches its windows to fill.
    static func tileRects(count: Int, in v: CGRect, options o: GeometryOptions) -> [CGRect] {
        guard count > 0 else { return [] }
        let cols = Int(CGFloat(count).squareRoot().rounded(.up))
        let rows = Int((CGFloat(count) / CGFloat(cols)).rounded(.up))
        var out: [CGRect] = []
        for i in 0..<count {
            let row = i / cols
            let inRow = row == rows - 1 ? count - row * cols : cols
            let r = cell(v, cols: inRow, rows: rows, col: i % cols, row: row)
            out.append(integral(applyGaps(r, in: v, dims: .both, gap: o.windowGap, margin: o.screenMargin)))
        }
        return out
    }

    /// Cascade from the top-left; windows keep their size where it fits.
    static func cascadeRects(sizes: [CGSize], in v: CGRect, step: CGFloat = 30, options o: GeometryOptions) -> [CGRect] {
        let inner = v.insetBy(dx: o.screenMargin, dy: o.screenMargin)
        let n = CGFloat(max(0, sizes.count - 1))
        return sizes.enumerated().map { i, s in
            let off = CGFloat(i) * step
            let w = min(s.width, inner.width - n * step), h = min(s.height, inner.height - n * step)
            return integral(CGRect(x: inner.minX + off, y: inner.minY + off, width: max(200, w), height: max(150, h)))
        }
    }

    // MARK: Snap areas

    enum Directional: Equatable { case topLeft, top, topRight, left, right, bottomLeft, bottom, bottomRight }

    struct SnapOptions: Equatable {
        var edgeMargin: CGFloat = 5
        var cornerSize: CGFloat = 20
        /// On the left/right edges, this close to a corner snaps to the top/bottom half.
        var shortEdge: CGFloat = 145
        var topMaximizes = true
        var corners = true
        var sides = true
        var sideCornerHalves = true
        var bottomThirds = true
        /// Top / bottom edge offer sixths after coming from a corner.
        var sixths = false
    }

    struct SnapArea: Equatable {
        var screenIndex: Int
        var directional: Directional
        var command: WindowCommand
    }

    static func directional(at p: CGPoint, in f: CGRect, _ o: SnapOptions) -> Directional? {
        guard p.x >= f.minX, p.x <= f.maxX, p.y >= f.minY, p.y <= f.maxY else { return nil }
        let corner = o.edgeMargin + o.cornerSize
        let nearLeft = p.x < f.minX + corner, nearRight = p.x > f.maxX - corner
        let nearTop = p.y < f.minY + corner, nearBottom = p.y > f.maxY - corner
        if nearLeft && nearTop { return .topLeft }
        if nearRight && nearTop { return .topRight }
        if nearLeft && nearBottom { return .bottomLeft }
        if nearRight && nearBottom { return .bottomRight }
        if p.x < f.minX + o.edgeMargin { return .left }
        if p.x > f.maxX - o.edgeMargin { return .right }
        if p.y < f.minY + o.edgeMargin { return .top }
        if p.y > f.maxY - o.edgeMargin { return .bottom }
        return nil
    }

    /// Rectangle's default snap areas: corners → quarters, top → maximize,
    /// left/right → halves (top/bottom half near the corners), bottom → thirds
    /// (dragging along the bottom from a side third widens to two thirds).
    /// Portrait screens: sides → thirds, bottom → left/right half.
    static func snapArea(at p: CGPoint, screens: [ScreenRect], prior: WindowCommand?, options o: SnapOptions) -> SnapArea? {
        for (i, s) in screens.enumerated() {
            let f = s.frame
            guard let dir = directional(at: p, in: f, o) else { continue }
            let cmd = snapCommand(dir, at: p, in: f, prior: prior, o)
            return cmd.map { SnapArea(screenIndex: i, directional: dir, command: $0) }
        }
        return nil
    }

    private static func snapCommand(_ dir: Directional, at p: CGPoint, in f: CGRect, prior: WindowCommand?, _ o: SnapOptions) -> WindowCommand? {
        let landscape = isLandscape(f)
        let third = (f.width / 3).rounded(.down)
        switch dir {
        case .topLeft: return o.corners ? .topLeft : nil
        case .topRight: return o.corners ? .topRight : nil
        case .bottomLeft: return o.corners ? .bottomLeft : nil
        case .bottomRight: return o.corners ? .bottomRight : nil
        case .top:
            if o.sixths, landscape, let prior {
                if p.x <= f.minX + third, [.topLeft, .topLeftSixth, .topCenterSixth].contains(prior) { return .topLeftSixth }
                if p.x >= f.maxX - third, [.topRight, .topRightSixth, .topCenterSixth].contains(prior) { return .topRightSixth }
                if [.topLeftSixth, .topRightSixth, .topCenterSixth].contains(prior) { return .topCenterSixth }
            }
            return o.topMaximizes ? .maximize : nil
        case .left, .right:
            guard o.sides else { return nil }
            if o.sideCornerHalves {
                if p.y < f.minY + o.edgeMargin + o.shortEdge { return .topHalf }
                if p.y > f.maxY - o.edgeMargin - o.shortEdge { return .bottomHalf }
            }
            if landscape { return dir == .left ? .leftHalf : .rightHalf }
            // Portrait: thirds along the height.
            let h3 = (f.height / 3).rounded(.down)
            if p.y < f.minY + h3 { return .firstThird }
            if p.y > f.maxY - h3 { return .lastThird }
            return middleThird(prior)
        case .bottom:
            if !landscape { return p.x < f.midX ? .leftHalf : .rightHalf }
            if o.sixths, let prior {
                if p.x <= f.minX + third, [.bottomLeft, .bottomLeftSixth, .bottomCenterSixth].contains(prior) { return .bottomLeftSixth }
                if p.x >= f.maxX - third, [.bottomRight, .bottomRightSixth, .bottomCenterSixth].contains(prior) { return .bottomRightSixth }
                if p.x > f.minX + third, p.x < f.maxX - third,
                   [.bottomLeftSixth, .bottomRightSixth, .bottomCenterSixth].contains(prior) { return .bottomCenterSixth }
            }
            guard o.bottomThirds else { return nil }
            if p.x <= f.minX + third { return .firstThird }
            if p.x > f.maxX - third { return .lastThird } // the middle band is inclusive in Rectangle
            return middleThird(prior)
        }
    }

    private static func middleThird(_ prior: WindowCommand?) -> WindowCommand {
        switch prior {
        case .firstThird?, .firstTwoThirds?: return .firstTwoThirds
        case .lastThird?, .lastTwoThirds?: return .lastTwoThirds
        default: return .centerThird
        }
    }

    // MARK: Modifier drag

    /// Which edges a resize drag moves: -1 = min edge, +1 = max edge, 0 = none.
    struct ResizeHandle: Equatable {
        var x: Int
        var y: Int
    }

    /// Live nearest-edge resizing: on each axis the edge on the pointer's side
    /// of the window's centre follows the pointer, re-decided at every step, so
    /// it is always a corner and the direction flips as the pointer crosses the
    /// middle (e.g. after shrinking past it). A small dead band around the
    /// centre keeps the current side so it doesn't flicker.
    static func liveSide(_ v: CGFloat, mid: CGFloat, current: Int, band: CGFloat = 4) -> Int {
        if v > mid + band { return 1 }
        if v < mid - band { return -1 }
        return current != 0 ? current : (v >= mid ? 1 : -1)
    }

    /// The corner a resize starts from: the pointer's quarter of the window.
    static func liveHandle(at p: CGPoint, in f: CGRect) -> ResizeHandle {
        ResizeHandle(x: liveSide(p.x, mid: f.midX, current: 0), y: liveSide(p.y, mid: f.midY, current: 0))
    }

    /// Rectangle Pro classic: resizing always moves the bottom-right corner.
    static let classicHandle = ResizeHandle(x: 1, y: 1)

    /// One resize step for a pointer move q → p (AX coordinates, y down).
    /// Returns the new (unrounded) frame and the sides used. `live` re-decides
    /// the sides from the pointer's position; otherwise `sides` are kept.
    static func liveResizeStep(_ f: CGRect, from q: CGPoint, to p: CGPoint, sides: ResizeHandle, live: Bool = true,
                               minSize: CGSize = CGSize(width: 120, height: 60)) -> (CGRect, ResizeHandle) {
        let sx = live ? liveSide(q.x, mid: f.midX, current: sides.x) : sides.x
        let sy = live ? liveSide(q.y, mid: f.midY, current: sides.y) : sides.y
        let dx = p.x - q.x, dy = p.y - q.y
        var minX = f.minX, maxX = f.maxX, minY = f.minY, maxY = f.maxY
        if sx > 0 { maxX = max(maxX + dx, minX + minSize.width) } else { minX = min(minX + dx, maxX - minSize.width) }
        if sy > 0 { maxY = max(maxY + dy, minY + minSize.height) } else { minY = min(minY + dy, maxY - minSize.height) }
        return (CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY), ResizeHandle(x: sx, y: sy))
    }

    /// Rectangle's restore while the system drags a window by its title bar:
    /// keep the window where it is and shift it right only as far as needed
    /// for the grab point (`grabX`, screen x) to stay on the narrower window.
    static func titleBarUnsnapShift(current: CGRect, size: CGSize, grabX: CGFloat) -> CGFloat {
        let inset = min(32, size.width / 2)
        let needed = grabX - current.minX - (size.width - inset)
        return min(max(0, needed), max(0, current.width - size.width)).rounded()
    }

    /// Frame for a snapped window being dragged away: back to its old size,
    /// keeping the grab point at the same relative spot under the cursor.
    static func unsnapped(_ current: CGRect, restoreSize s: CGSize, grab: CGPoint, keepVertical: Bool) -> CGRect {
        let fx = current.width > 0 ? (grab.x - current.minX) / current.width : 0.5
        let fy = current.height > 0 ? (grab.y - current.minY) / current.height : 0
        let x = grab.x - fx * s.width
        let y = keepVertical ? current.minY : grab.y - fy * s.height
        return integral(CGRect(x: x, y: y, width: s.width, height: s.height))
    }
}
