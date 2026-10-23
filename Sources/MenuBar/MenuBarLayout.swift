import CoreGraphics
import Foundation

/// The three sections of the menu bar, separated by Bento's control items
/// (right to left: Visible, then Hidden left of the hidden separator, then
/// Always Hidden left of the always-hidden separator).
public enum MenuBarSection: String, Codable, CaseIterable, Identifiable {
    case visible, hidden, alwaysHidden

    public var id: String { rawValue }

    var title: String {
        switch self {
        case .visible: "Visible"
        case .hidden: "Hidden"
        case .alwaysHidden: "Always Hidden"
        }
    }

    var symbol: String {
        switch self {
        case .visible: "eye"
        case .hidden: "eye.slash"
        case .alwaysHidden: "eye.trianglebadge.exclamationmark"
        }
    }
}

/// An item as the pure layout logic sees it: a stable key and a horizontal
/// extent in global (top-left origin) coordinates.
struct LayoutItem: Equatable {
    var key: String
    var minX: CGFloat
    var width: CGFloat
    var maxX: CGFloat { minX + width }
    var midX: CGFloat { minX + width / 2 }
}

/// Where to drop an item relative to another one.
enum MoveDestination: Equatable {
    case leftOf(String)
    case rightOf(String)

    var target: String {
        switch self {
        case .leftOf(let k), .rightOf(let k): k
        }
    }
}

struct PlannedMove: Equatable {
    var key: String
    var destination: MoveDestination
}

/// Pure menu bar layout logic: sections from positions, move planning and
/// notch overflow. No AppKit, so it is unit-tested directly.
enum MenuBarLayout {
    /// Items sorted left to right. Expanded separators are thousands of points
    /// wide, so comparisons use centres: an item is left of a separator when
    /// its centre is left of the separator's centre.
    static func leftToRight(_ items: [LayoutItem]) -> [LayoutItem] {
        items.sorted { $0.midX != $1.midX ? $0.midX < $1.midX : $0.key < $1.key }
    }

    /// The section of each item given the separators' frames. A missing
    /// always-hidden separator means that section is off (its items count as hidden).
    static func sections(of items: [LayoutItem], hiddenSeparator: LayoutItem?,
                         alwaysHiddenSeparator: LayoutItem?) -> [String: MenuBarSection] {
        var out: [String: MenuBarSection] = [:]
        for item in items {
            out[item.key] = section(ofMidX: item.midX, hiddenSeparator: hiddenSeparator,
                                    alwaysHiddenSeparator: alwaysHiddenSeparator)
        }
        return out
    }

    static func section(ofMidX x: CGFloat, hiddenSeparator: LayoutItem?, alwaysHiddenSeparator: LayoutItem?) -> MenuBarSection {
        guard let hidden = hiddenSeparator, x < hidden.midX else { return .visible }
        if let always = alwaysHiddenSeparator, always.midX < hidden.midX, x < always.midX { return .alwaysHidden }
        return .hidden
    }

    /// Splits a left-to-right order into the three sections, each left to right.
    static func arrangement(order: [String], sections: [String: MenuBarSection]) -> [MenuBarSection: [String]] {
        var out: [MenuBarSection: [String]] = [.visible: [], .hidden: [], .alwaysHidden: []]
        for key in order { if let s = sections[key] { out[s, default: []].append(key) } }
        return out
    }

    /// The full left-to-right order for a desired arrangement: always hidden,
    /// the always-hidden separator, hidden, the hidden separator, visible.
    /// `pinnedRight` (the toggle, Bento's own icon, the clock…) keep their
    /// current place relative to each other at the right of the visible section.
    static func targetOrder(_ arrangement: [MenuBarSection: [String]], hiddenSeparator: String,
                            alwaysHiddenSeparator: String?) -> [String] {
        var order = arrangement[.alwaysHidden] ?? []
        if let a = alwaysHiddenSeparator { order.append(a) }
        order += arrangement[.hidden] ?? []
        order.append(hiddenSeparator)
        order += arrangement[.visible] ?? []
        return order
    }

    /// Moves that turn `current` (left to right) into `target` (the same keys,
    /// in the wanted order). `anchors` can't be moved (Bento's separators, the
    /// clock, Control Centre); their relative order must already match.
    /// Keeps the longest run of items already in order and moves the rest one
    /// by one, right to left, each next to a neighbour that is already in place.
    static func planMoves(current: [String], target: [String], anchors: Set<String>) -> [PlannedMove] {
        let targetIndex = Dictionary(target.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
        let seq = current.filter { targetIndex[$0] != nil }
        guard seq.count > 1 else { return [] }

        // Anchors stay; every other item must fall between the anchors around
        // it in the current order to be kept, and those form independent runs.
        var kept = Set<String>()
        var bracket: [String] = []
        var lowerBound = -1
        func flush(upper: Int) {
            let candidates = bracket.filter { let t = targetIndex[$0]!; return t > lowerBound && t < upper }
            for k in longestIncreasingRun(candidates.map { targetIndex[$0]! }).map({ candidates[$0] }) { kept.insert(k) }
            bracket = []
        }
        for key in seq {
            if anchors.contains(key) {
                let t = targetIndex[key]!
                flush(upper: t)
                kept.insert(key)
                lowerBound = max(lowerBound, t)
            } else {
                bracket.append(key)
            }
        }
        flush(upper: Int.max)

        var settled = kept
        var moves: [PlannedMove] = []
        let wanted = target.filter { seq.contains($0) }
        for (i, key) in wanted.enumerated().reversed() where !settled.contains(key) {
            if i + 1 < wanted.count {
                moves.append(PlannedMove(key: key, destination: .leftOf(wanted[i + 1])))
            } else if let left = wanted[..<i].last(where: { settled.contains($0) }) {
                moves.append(PlannedMove(key: key, destination: .rightOf(left)))
            } else {
                continue
            }
            settled.insert(key)
        }
        return moves
    }

    /// Inserts `key` into a section's list (left to right) where a remembered
    /// order puts it: after the nearest key remembered before it that is in
    /// the list, else first.
    static func inserting(_ key: String, into list: [String], remembered: [String]) -> [String] {
        var out = list.filter { $0 != key }
        guard let i = remembered.firstIndex(of: key) else { out.insert(key, at: 0); return out }
        if let before = remembered[..<i].reversed().first(where: { out.contains($0) }), let j = out.firstIndex(of: before) {
            out.insert(key, at: j + 1)
        } else {
            out.insert(key, at: 0)
        }
        return out
    }

    /// Indices of one longest strictly increasing subsequence (O(n log n)).
    static func longestIncreasingRun(_ values: [Int]) -> [Int] {
        guard !values.isEmpty else { return [] }
        var tails: [Int] = []          // indices into values
        var previous = [Int](repeating: -1, count: values.count)
        for (i, v) in values.enumerated() {
            var lo = 0, hi = tails.count
            while lo < hi {
                let mid = (lo + hi) / 2
                if values[tails[mid]] < v { lo = mid + 1 } else { hi = mid }
            }
            if lo > 0 { previous[i] = tails[lo - 1] }
            if lo == tails.count { tails.append(i) } else { tails[lo] = i }
        }
        var out: [Int] = []
        var i = tails.last ?? -1
        while i >= 0 { out.append(i); i = previous[i] }
        return out.reversed()
    }

    /// Whether `key` sits directly left (or right) of `target` in a left-to-right
    /// order, ignoring `transparent` keys (zero-width items) in between.
    static func isPlaced(_ key: String, _ destination: MoveDestination, in order: [String], ignoring transparent: Set<String> = []) -> Bool {
        let seq = order.filter { !transparent.contains($0) || $0 == key || $0 == destination.target }
        guard let i = seq.firstIndex(of: key) else { return false }
        switch destination {
        case .leftOf(let t): return i + 1 < seq.count && seq[i + 1] == t
        case .rightOf(let t): return i > 0 && seq[i - 1] == t
        }
    }

    /// The point to release a ⌘-drag at, so the item lands on that side of the
    /// target: macOS inserts before or after the item under the pointer
    /// depending on which half it is in.
    static func dropPoint(for destination: MoveDestination, targetFrame: CGRect) -> CGPoint {
        let y = targetFrame.midY
        switch destination {
        case .leftOf: return CGPoint(x: targetFrame.minX + min(4, targetFrame.width / 4), y: y)
        case .rightOf: return CGPoint(x: targetFrame.maxX - min(4, targetFrame.width / 4), y: y)
        }
    }

    /// How to release a teleported item next to its target. Moving right to
    /// just left of the target, macOS goes by where the item's left edge
    /// lands, so the release goes a width before the target's edge; every
    /// other way, a release inside the target's near half works
    /// (`dropPoint`). Measured on macOS 26.
    static func releasesBeforeEdge(itemMidX: CGFloat, targetMidX: CGFloat, destination: MoveDestination) -> Bool {
        if case .leftOf = destination { return itemMidX < targetMidX }
        return false
    }

    /// Whether an item's window is on one of the displays. The clock's
    /// window pokes a little past the right edge of the screen, so only the
    /// left edge and the centre count horizontally.
    static func isOnDisplay(_ frame: CGRect, displays: [CGRect]) -> Bool {
        displays.contains { d in
            frame.width > 0 && frame.minX >= d.minX - 0.5 && frame.midX < d.maxX
                && frame.minY >= d.minY - 0.5 && frame.maxY <= d.maxY + 0.5
        }
    }

    // MARK: Notch and overflow

    /// The x range of the status item area on a screen (global coordinates):
    /// right of the notch on notched displays, else right of `appMenuMaxX`.
    static func statusArea(screenMinX: CGFloat, screenMaxX: CGFloat, notch: ClosedRange<CGFloat>?, appMenuMaxX: CGFloat?) -> ClosedRange<CGFloat> {
        var lower = screenMinX
        if let notch { lower = max(lower, notch.upperBound) }
        if let appMenuMaxX, appMenuMaxX > lower { lower = appMenuMaxX }
        return lower...max(lower, screenMaxX)
    }

    /// Items that should show but can't: macOS pushes items that don't fit in
    /// the status area off-screen to the left, or behind the notch. Only
    /// `shown` keys count (the visible section, plus hidden while revealed).
    /// The right end doesn't count: the clock's window pokes past the screen edge.
    static func overflow(_ items: [LayoutItem], shown: Set<String>, area: ClosedRange<CGFloat>) -> [String] {
        items.filter { shown.contains($0.key) && $0.width > 0 && $0.minX < area.lowerBound - 0.5 }.map(\.key)
    }

    /// How many points the shown items need beyond the available area (0 when they fit).
    static func shortfall(_ items: [LayoutItem], shown: Set<String>, available: CGFloat) -> CGFloat {
        let need = items.filter { shown.contains($0.key) }.reduce(0) { $0 + $1.width }
        return max(0, need - available)
    }
}
