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
    /// Both the display and item frames use global top-left coordinates.
    struct RecoveryDisplay: Equatable {
        var frame: CGRect
        var statusArea: ClosedRange<CGFloat>
    }

    /// Only recovery/control geometry participates in settling; another app's
    /// changing title or icon must not keep Bento's relayout alive.
    struct ControlLayoutSample: Equatable {
        struct Window: Equatable {
            var id: CGWindowID
            var frame: CGRect
            var role: MenuBarItem.Role
            var ownerPID: pid_t?
        }
        var display: RecoveryDisplay
        var windows: [Window]
    }

    /// A complete, collapsed menu row, including controls behind the notch.
    /// This establishes readiness only; safeExpansion still authorizes hiding.
    static func controlLayoutSample(items: [MenuBarItem], displays: [RecoveryDisplay],
                                    showChevron: Bool, alwaysHiddenSection: Bool, ownPID: pid_t) -> ControlLayoutSample? {
        let shell = recoveryShell(items, ownPID: ownPID)
        guard !shell.isEmpty else { return nil }
        let candidates = displays.filter { d in
            validDisplay(d) && shell.allSatisfy { fitsStatusArea($0.frame, display: d) }
        }
        guard candidates.count == 1 else { return nil }
        let display = candidates[0]
        let kinds: [ControlItems.Kind] = [.hidden] + (alwaysHiddenSection ? [.alwaysHidden] : [])
            + (showChevron ? [.toggle] : [])
        let controls = items.filter { if case .control = $0.role { return true }; return false }
        guard controls.count == kinds.count,
              kinds.allSatisfy({ kind in controls.filter { $0.role == .control(kind) }.count == 1 }),
              let rowBottom = shell.map({ $0.frame.maxY }).max(),
              controls.allSatisfy({ item in
                  let f = item.frame
                  return validFrame(f) && f.width <= 200
                      && abs(f.minY - display.frame.minY) <= 1 && abs(f.maxY - rowBottom) <= 1
                      && f.maxY <= display.frame.maxY && f.maxX <= display.frame.maxX
              }) else { return nil }
        let windows = (shell + controls).sorted { $0.windowID < $1.windowID }.map {
            ControlLayoutSample.Window(id: $0.windowID, frame: $0.frame, role: $0.role, ownerPID: $0.ownerPID)
        }
        guard Set(windows.map(\.id)).count == windows.count else { return nil }
        return ControlLayoutSample(display: display, windows: windows)
    }

    /// Try smaller controls only with a known, accessible shell and complete
    /// collapsed geometry. Expanded dividers (and items parked by them) are
    /// not evidence of crowding; wait until a revealed snapshot instead.
    static func needsCompactControls(items: [MenuBarItem], displays: [RecoveryDisplay],
                                     showChevron: Bool, alwaysHiddenSection: Bool, ownPID: pid_t) -> Bool {
        let shell = recoveryShell(items, ownPID: ownPID)
        guard !shell.isEmpty else { return false }
        let candidates = displays.filter { d in
            validDisplay(d) && shell.allSatisfy { fitsStatusArea($0.frame, display: d) }
        }
        guard candidates.count == 1 else { return false }
        let display = candidates[0]
        let kinds: [ControlItems.Kind] = [.hidden] + (alwaysHiddenSection ? [.alwaysHidden] : [])
            + (showChevron ? [.toggle] : [])
        var frames: [CGRect] = []
        for kind in kinds {
            let matches = items.filter { $0.role == .control(kind) }
            guard matches.count == 1 else { return false }
            let f = matches[0].frame
            // Native expanded lengths are at least 1000 pt. Leave ambiguous
            // widths alone too, including a relayout still in progress.
            guard validFrame(f), f.width <= 200,
                  abs(f.minY - display.frame.minY) <= 1, f.maxY <= display.frame.maxY,
                  f.maxX <= display.frame.maxX else { return false }
            frames.append(f)
        }
        return frames.contains { $0.minX < display.statusArea.lowerBound }
    }

    private static func validFrame(_ f: CGRect) -> Bool {
        f.origin.x.isFinite && f.origin.y.isFinite && f.width.isFinite && f.height.isFinite
            && f.size.width > 0 && f.size.height > 0 && f.maxX.isFinite && f.maxY.isFinite
    }

    private static func validDisplay(_ d: RecoveryDisplay) -> Bool {
        validFrame(d.frame) && d.statusArea.lowerBound.isFinite && d.statusArea.upperBound.isFinite
            && d.statusArea.lowerBound >= d.frame.minX && d.statusArea.upperBound <= d.frame.maxX
    }

    private static func fitsStatusArea(_ f: CGRect, display d: RecoveryDisplay) -> Bool {
        validFrame(f) && abs(f.minY - d.frame.minY) <= 1 && f.maxY <= d.frame.maxY
            && f.minX >= d.statusArea.lowerBound && f.maxX <= d.statusArea.upperBound
    }

    private static func recoveryShell(_ items: [MenuBarItem], ownPID: pid_t) -> [MenuBarItem] {
        items.filter {
            if case .control = $0.role { return false }
            return $0.role == .bentoIcon || $0.ownerPID == ownPID
        }
    }

    /// Status items grow to the left, with their right edge anchored. Never
    /// infer safety from separator centres (expanded widths can span displays).
    static func safeExpansion(items: [MenuBarItem], displays: [RecoveryDisplay],
                              showChevron: Bool, ownPID: pid_t) -> ControlItems.Expansion {
        let collapsed = ControlItems.Expansion(hidden: false, alwaysHidden: false)
        func controls(_ kind: ControlItems.Kind) -> [MenuBarItem] {
            items.filter { $0.role == .control(kind) }
        }
        let solid = controls(.hidden), dashed = controls(.alwaysHidden), chevrons = controls(.toggle)
        // The shell icon may have no stable autosave name. On macOS 26 its
        // owner is learned through AX; an unresolved shell keeps hiding off.
        let shell = recoveryShell(items, ownPID: ownPID)
        let recovery = shell + chevrons
        guard solid.count == 1, !shell.isEmpty, !showChevron || chevrons.count == 1,
              recovery.allSatisfy({ validFrame($0.frame) }), validFrame(solid[0].frame) else { return collapsed }
        // Require one unambiguous display containing every known recovery
        // control. A missing, parked, notched or split-display control fails closed.
        let candidates = displays.filter { d in
            validDisplay(d) && recovery.allSatisfy { fitsStatusArea($0.frame, display: d) }
        }
        guard candidates.count == 1 else { return collapsed }
        let display = candidates[0], h = solid[0].frame
        guard abs(h.minY - display.frame.minY) <= 1, h.maxY <= display.frame.maxY,
              h.maxX > display.frame.minX, h.maxX <= display.frame.maxX else { return collapsed }
        let hiddenSafe = recovery.allSatisfy { $0.frame.minX >= h.maxX }
        // The dashed separator may already be parked to the left by an
        // expanded solid separator. Compare full edges on the same menu row.
        let alwaysSafe = dashed.count == 1 && validFrame(dashed[0].frame)
            && abs(dashed[0].frame.minY - h.minY) <= 1 && dashed[0].frame.maxY <= display.frame.maxY
            && dashed[0].frame.maxX <= h.minX
            && recovery.allSatisfy { $0.frame.minX >= dashed[0].frame.maxX }
        return .init(hidden: hiddenSafe, alwaysHidden: alwaysSafe)
    }

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
