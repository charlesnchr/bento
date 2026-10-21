import AppKit

/// The `windows` config section. Every field has a default so hand-edited
/// files can stay minimal.
struct WindowsSettings: Codable, Equatable {
    // Keyboard actions
    var cycleOnRepeat = true
    /// Sizes for repeated half / corner actions: any of "1/4", "1/3", "1/2", "2/3", "3/4".
    var cycleSizes: [String] = ["1/2", "2/3", "1/3"]
    var moveToAdjacentDisplayOnRepeat = false
    var almostMaximizeWidth = 0.9
    var almostMaximizeHeight = 0.9
    var sizeStep = 30.0
    var showHUD = false

    // Gaps
    var windowGap = 0.0
    var screenMargin = 0.0
    var gapsOnMaximize = true

    // Snapping (drag a window by its title bar to a screen edge)
    var snapping = true
    var snapTopMaximizes = true
    var snapCorners = true
    var snapSides = true
    var snapSideCornerHalves = true
    var snapBottomThirds = true
    var snapSixths = false
    var restoreSizeOnUnsnap = true

    // Modifier-drag anywhere in a window
    var dragMove = true
    var dragMoveModifiers: [String] = ["cmd", "opt"]
    var dragResize = true
    var dragResizeModifiers: [String] = ["cmd", "opt", "shift"]
    var dragFocusesWindow = true
    var dragSnaps = true
    /// Rectangle Pro style: holding the modifiers and moving the pointer is
    /// enough (no click); pressing and dragging works too.
    var dragHover = true
    /// "classic": resize from the bottom-right corner (Rectangle Pro);
    /// "live": the edges on the pointer's side, re-decided as it moves.
    var dragResizeStyle = "classic"

    // Layouts and per-app launch positions
    var layouts: [SavedLayout] = []
    var launchRules: [LaunchRule] = []

    // Stash
    var stashSliver = 12.0
    var stashRevealOnHover = true

    /// Set once Rectangle / Rectangle Pro settings were imported (automatically
    /// on first start, or from settings), so the automatic import runs once.
    var importedFromRectangle = false

    init() {}

    // MARK: Derived

    var geometry: GeometryOptions {
        var o = GeometryOptions()
        o.windowGap = CGFloat(WindowsSettings.finite(windowGap, in: 0...200, else: 0))
        o.screenMargin = CGFloat(WindowsSettings.finite(screenMargin, in: 0...200, else: 0))
        o.gapsOnMaximize = gapsOnMaximize
        o.cycleOnRepeat = cycleOnRepeat
        o.cycleFractions = Geometry.cycleOrder(cycleSizes.compactMap(WindowsSettings.fraction))
        if o.cycleFractions.isEmpty { o.cycleFractions = [0.5] }
        o.traverseDisplays = moveToAdjacentDisplayOnRepeat
        o.almostMaximize = CGSize(width: WindowsSettings.finite(almostMaximizeWidth, in: 0.3...1, else: 0.9),
                                  height: WindowsSettings.finite(almostMaximizeHeight, in: 0.3...1, else: 0.9))
        o.sizeStep = CGFloat(WindowsSettings.finite(sizeStep, in: 1...1000, else: 30))
        return o
    }

    /// Clamps a hand-edited number; NaN / infinity fall back to `fallback`.
    static func finite(_ v: Double, in range: ClosedRange<Double>, else fallback: Double) -> Double {
        v.isFinite ? v.clamped(range) : fallback
    }

    /// Whole points for labels (never traps on odd config values).
    static func points(_ v: Double) -> Int {
        v.isFinite ? Int(v.clamped(-1e6...1e6).rounded()) : 0
    }

    var snap: Geometry.SnapOptions {
        var s = Geometry.SnapOptions()
        s.topMaximizes = snapTopMaximizes
        s.corners = snapCorners
        s.sides = snapSides
        s.sideCornerHalves = snapSideCornerHalves
        s.bottomThirds = snapBottomThirds
        s.sixths = snapSixths
        return s
    }

    static let cycleChoices: [(String, String)] = [("1/4", "¼"), ("1/3", "⅓"), ("1/2", "½"), ("2/3", "⅔"), ("3/4", "¾")]

    static func fraction(_ s: String) -> CGFloat? {
        let parts = s.split(separator: "/")
        guard parts.count == 2, let a = Double(parts[0]), let b = Double(parts[1]), a.isFinite, b.isFinite, b > 0, a > 0, a < b else { return nil }
        return CGFloat(a / b)
    }

    static func flags(_ names: [String]) -> CGEventFlags {
        var f: CGEventFlags = []
        for n in names {
            switch n.lowercased() {
            case "cmd", "command": f.insert(.maskCommand)
            case "opt", "option", "alt": f.insert(.maskAlternate)
            case "ctrl", "control": f.insert(.maskControl)
            case "shift": f.insert(.maskShift)
            case "fn": f.insert(.maskSecondaryFn)
            default: break
            }
        }
        return f
    }
}

/// A named set of window positions, restorable from a shortcut or the menu.
struct SavedLayout: Codable, Equatable, Identifiable {
    var id: String = UUID().uuidString.prefix(8).lowercased()
    var name: String
    var windows: [Entry] = []
    /// Launch apps of the layout that aren't running when restoring.
    var launchApps = false

    struct Entry: Codable, Equatable {
        var bundleID: String
        var appName: String
        var title: String
        /// Position among the app's windows at capture time (front to back).
        var index: Int
        var frame: Rect
        /// The display it was on, to map positions when displays change.
        var screen: Rect
        var displayUUID: String?
    }

    var actionID: String { "windows.layout-\(id)" }
}

/// Move an app's first window to a position when the app launches.
struct LaunchRule: Codable, Equatable, Identifiable {
    var id: String = UUID().uuidString.prefix(8).lowercased()
    var bundleID: String
    var appName: String
    /// A `WindowCommand` raw value, e.g. "leftHalf".
    var command: String
}

/// A JSON-friendly rect (`{"x":0,"y":0,"w":100,"h":100}`) in AX coordinates.
struct Rect: Codable, Equatable {
    var x, y, w, h: Double

    init(_ r: CGRect) {
        x = Double(r.minX); y = Double(r.minY); w = Double(r.width); h = Double(r.height)
    }

    var cg: CGRect { CGRect(x: x, y: y, width: w, height: h) }
}
