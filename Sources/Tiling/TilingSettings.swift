import Foundation

/// The `tiling` section of the config file.
public struct TilingSettings: Codable, Equatable {
    /// Whether the tiling manager is running (toggled with `tiling.toggle`).
    public var managerOn = false
    /// Layout for displays that have not been switched individually.
    public var defaultLayout: LayoutKind = .tiles
    /// Where new windows go in the layout.
    public var newWindowPlacement: Placement = .afterFocused
    /// Gap between windows, in points.
    public var innerGap: Double = 8
    /// Gap between windows and the screen edges, in points.
    public var outerGap: Double = 8
    /// Width of the master area in the master-stack layout (0.1 to 0.9).
    public var masterRatio: Double = 0.55
    /// How much one grow/shrink step changes a split (fraction of the area).
    public var resizeStep: Double = 0.05
    /// Drop a tiled window onto another one to swap them; resize to change splits.
    public var mouseSupport = true
    /// Apps whose windows always float (bundle ids).
    public var floatingApps: [String] = TilingSettings.defaultFloatingApps
    /// When non-empty, only windows of these apps are tiled (bundle ids). Useful
    /// to try tiling with a few apps first.
    public var onlyApps: [String] = []

    public init() {}

    public static let defaultFloatingApps = [
        "com.apple.systempreferences",   // System Settings
        "com.apple.calculator",
        "com.charles.bento",
        "com.apple.SecurityAgent",       // password prompts
        "com.apple.CoreServicesUIAgent", // "app downloaded from the internet" prompts
        "com.apple.archiveutility",
        "com.apple.print.PrinterProxy",
        "com.apple.ScreenContinuity",    // iPhone Mirroring
        "com.apple.PhotoBooth",
    ]

    // Tolerant decoding: unknown enum strings fall back to defaults instead of
    // invalidating the whole section.
    public init(from decoder: Decoder) throws {
        let d = TilingSettings()
        let c = try decoder.container(keyedBy: CodingKeys.self)
        managerOn = (try? c.decode(Bool.self, forKey: .managerOn)) ?? d.managerOn
        defaultLayout = (try? c.decode(LayoutKind.self, forKey: .defaultLayout)) ?? d.defaultLayout
        newWindowPlacement = (try? c.decode(Placement.self, forKey: .newWindowPlacement)) ?? d.newWindowPlacement
        innerGap = (try? c.decode(Double.self, forKey: .innerGap)) ?? d.innerGap
        outerGap = (try? c.decode(Double.self, forKey: .outerGap)) ?? d.outerGap
        masterRatio = (try? c.decode(Double.self, forKey: .masterRatio)) ?? d.masterRatio
        resizeStep = (try? c.decode(Double.self, forKey: .resizeStep)) ?? d.resizeStep
        mouseSupport = (try? c.decode(Bool.self, forKey: .mouseSupport)) ?? d.mouseSupport
        floatingApps = (try? c.decode([String].self, forKey: .floatingApps)) ?? d.floatingApps
        onlyApps = (try? c.decode([String].self, forKey: .onlyApps)) ?? d.onlyApps
    }

    // Values clamped to sane ranges (the file is hand-editable).
    var clampedInnerGap: CGFloat { CGFloat(min(max(innerGap, 0), 100)) }
    var clampedOuterGap: CGFloat { CGFloat(min(max(outerGap, 0), 200)) }
    var clampedMasterRatio: Double { LayoutMath.clampRatio(masterRatio) }
    var clampedResizeStep: Double { min(max(resizeStep, 0.01), 0.3) }
}
