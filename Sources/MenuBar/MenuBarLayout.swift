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

/// Pure section geometry, owner matching and notch overflow.
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

    // MARK: Owners

    /// Whether an Accessibility frame and a window frame are the same item:
    /// their centres agree within a point or two.
    static func sameItem(_ a: CGRect, _ b: CGRect) -> Bool {
        abs(a.midX - b.midX) <= 2 && abs(a.midY - b.midY) <= 3
    }

    /// Matches status item windows to Accessibility elements by position
    /// (window id → element index). A window that moved while the elements
    /// were read (`before` → `after`) isn't matched: its old place may hold
    /// another item's element by then. Those come back in `moved`.
    static func matchOwners(before: [UInt32: CGRect], after: [UInt32: CGRect],
                            elements: [CGRect]) -> (matched: [UInt32: Int], moved: Set<UInt32>) {
        var matched: [UInt32: Int] = [:]
        var moved = Set<UInt32>()
        for (id, frame) in before {
            guard after[id] == frame else { moved.insert(id); continue }
            if let i = elements.firstIndex(where: { sameItem($0, frame) }) { matched[id] = i }
        }
        return (matched, moved)
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
