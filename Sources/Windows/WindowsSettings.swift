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

    // Layouts and per-app launch positions
    var layouts: [SavedLayout] = []
    var launchRules: [LaunchRule] = []

    // Stash
    var stashSliver = 12.0
    var stashRevealOnHover = true

    init() {}

    // MARK: Derived

    var geometry: GeometryOptions {
        var o = GeometryOptions()
        o.windowGap = CGFloat(max(0, windowGap))
        o.screenMargin = CGFloat(max(0, screenMargin))
        o.gapsOnMaximize = gapsOnMaximize
        o.cycleOnRepeat = cycleOnRepeat
        o.cycleFractions = Geometry.cycleOrder(cycleSizes.compactMap(WindowsSettings.fraction))
        if o.cycleFractions.isEmpty { o.cycleFractions = [0.5] }
        o.traverseDisplays = moveToAdjacentDisplayOnRepeat
        o.almostMaximize = CGSize(width: almostMaximizeWidth.clamped(0.3...1), height: almostMaximizeHeight.clamped(0.3...1))
        o.sizeStep = CGFloat(max(1, sizeStep))
        return o
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
        guard parts.count == 2, let a = Double(parts[0]), let b = Double(parts[1]), b > 0, a > 0, a < b else { return nil }
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
