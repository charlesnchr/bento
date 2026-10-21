import Foundation

/// The `shot` config section. Every field has a default so hand-edited files
/// can stay minimal; `ConfigStore.materialize` writes all of them out.
struct ShotSettings: Codable, Equatable {
    enum AfterCapture: String, Codable, CaseIterable {
        case editor, copy, save, copyAndSave, pin
        var title: String {
            switch self {
            case .editor: return "Open Editor"
            case .copy: return "Copy to Clipboard"
            case .save: return "Save to Folder"
            case .copyAndSave: return "Copy and Save"
            case .pin: return "Pin to Screen"
            }
        }
    }

    enum ImageFormat: String, Codable, CaseIterable {
        case png, jpeg
        var title: String { self == .png ? "PNG" : "JPEG" }
        var fileExtension: String { self == .png ? "png" : "jpg" }
    }

    enum WindowBackground: String, Codable, CaseIterable {
        case transparent, solid, wallpaper
        var title: String {
            switch self {
            case .transparent: return "Transparent"
            case .solid: return "Solid Colour"
            case .wallpaper: return "Wallpaper"
            }
        }
    }

    enum DelayedTarget: String, Codable, CaseIterable {
        case area, fullscreen
        var title: String { self == .area ? "Area (frozen screen)" : "Fullscreen" }
    }

    enum ScrollMode: String, Codable, CaseIterable {
        case auto, manual
        var title: String { self == .auto ? "Automatic" : "Manual (you scroll)" }
    }

    enum ScrollSpeed: String, Codable, CaseIterable {
        case slow, normal, fast
        var title: String { rawValue.capitalized }
        /// Fraction of the region height scrolled per step.
        var stepFraction: CGFloat {
            switch self { case .slow: return 0.4; case .normal: return 0.6; case .fast: return 0.75 }
        }
        /// Settle time after each scroll before grabbing the next frame.
        var settle: TimeInterval {
            switch self { case .slow: return 0.4; case .normal: return 0.22; case .fast: return 0.12 }
        }
    }

    // After capture
    var afterCapture: AfterCapture = .editor
    var playSound = true

    // Saving
    var saveFolder = "~/Desktop"
    /// `{…}` holds a date format (`{yyyy-MM-dd}`) or one of `{app}`, `{kind}`, `{w}`, `{h}`.
    var filenamePattern = "Screenshot {yyyy-MM-dd} at {HH.mm.ss}"
    var format: ImageFormat = .png
    var jpegQuality = 0.9
    /// Save Retina captures at 1x (point) resolution.
    var downscaleRetina = false

    // Area / fullscreen
    var showMagnifier = true
    /// Keep the selection after releasing the mouse so it can be adjusted;
    /// Return captures. Off = capture on release (like Shottr/macOS).
    var adjustSelectionBeforeCapture = false
    /// Fullscreen captures every display into one image instead of the one under the mouse.
    var fullscreenAllDisplays = false
    /// Include the mouse pointer in area, window, fullscreen and repeat captures.
    var includeCursor = false

    // Window capture
    var windowShadow = true
    var windowBackground: WindowBackground = .transparent
    var windowBackgroundColor = "#FFFFFF"
    /// Extra space around the window, in points.
    var windowPadding = 0

    // Delayed capture
    var delaySeconds = 3
    var delayedTarget: DelayedTarget = .area

    // Scrolling capture
    var scrollMode: ScrollMode = .auto
    var scrollSpeed: ScrollSpeed = .normal
    /// Stop when the stitched image reaches this many pixels (1,000…100,000;
    /// wide regions stop earlier, see `ScrollStitcher.pixelBudget`).
    var scrollMaxHeight = 50_000
    /// For mouse utilities that invert synthetic scroll events (Mos, Scroll Reverser, …).
    var scrollReverse = false

    // Text and colour
    var ocrKeepLineBreaks = true
    /// Vision language code to prefer for Copy Text ("" = detect automatically).
    var ocrLanguage = ""
    var colorFormat: ColorFormat = .hex

    static var current: ShotSettings { ConfigStoreAccess.settings }
}

/// Indirection so pure code (and tests) don't need ConfigStore.
enum ConfigStoreAccess {
    static var settings = ShotSettings()
}
