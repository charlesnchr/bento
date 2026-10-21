import AppKit

/// Editor tools, in Shottr's toolbar order, with Shottr's single-key shortcuts
/// (Draw menu: A T R D M H B S C O L, V for select/crop). E, U, I fill gaps
/// for tools Shottr has no letter for.
enum EditorTool: String, CaseIterable {
    case select, arrow, text, rect, freehand, magnifier, highlight, blur, erase, spotlight, counter, oval, line, ruler, eyedropper

    var key: Character {
        switch self {
        case .select: return "v"
        case .arrow: return "a"
        case .text: return "t"
        case .rect: return "r"
        case .freehand: return "d"
        case .magnifier: return "m"
        case .highlight: return "h"
        case .blur: return "b"
        case .erase: return "e"
        case .spotlight: return "s"
        case .counter: return "c"
        case .oval: return "o"
        case .line: return "l"
        case .ruler: return "u"
        case .eyedropper: return "i"
        }
    }

    var keyHint: String { String(key).uppercased() }

    var title: String {
        switch self {
        case .select: return "Select / Crop"
        case .arrow: return "Arrow"
        case .text: return "Text"
        case .rect: return "Rectangle"
        case .freehand: return "Freehand"
        case .magnifier: return "Magnifier"
        case .highlight: return "Highlighter"
        case .blur: return "Blur / Pixelate"
        case .erase: return "Erase (smart fill)"
        case .spotlight: return "Spotlight"
        case .counter: return "Counter"
        case .oval: return "Oval"
        case .line: return "Line"
        case .ruler: return "Ruler"
        case .eyedropper: return "Colour Picker"
        }
    }

    var symbol: String {
        switch self {
        case .select: return "crop"
        case .arrow: return "arrow.up.right"
        case .text: return "textformat"
        case .rect: return "rectangle"
        case .freehand: return "scribble.variable"
        case .magnifier: return "magnifyingglass.circle"
        case .highlight: return "highlighter"
        case .blur: return "drop"
        case .erase: return "eraser"
        case .spotlight: return "light.max"
        case .counter: return "1.circle"
        case .oval: return "circle"
        case .line: return "line.diagonal"
        case .ruler: return "ruler"
        case .eyedropper: return "eyedropper"
        }
    }

    var kind: Annotation.Kind? {
        switch self {
        case .select, .eyedropper: return nil
        case .arrow: return .arrow
        case .text: return .text
        case .rect: return .rect
        case .freehand: return .freehand
        case .magnifier: return .magnifier
        case .highlight: return .highlight
        case .blur: return .blur
        case .erase: return .erase
        case .spotlight: return .spotlight
        case .counter: return .counter
        case .oval: return .oval
        case .line: return .line
        case .ruler: return .ruler
        }
    }

    var hint: String {
        switch self {
        case .select: return "Drag to select (⌘-click an object) · ↩ crop · A fit · ⌘C copy · B blur · ⌫ erase · C colour"
        case .arrow: return "Drag to draw an arrow · ⇧ snaps to 45° · A again: style"
        case .text: return "Click to add text · Esc to finish"
        case .rect: return "Drag to draw · ⇧ square · R again: outline/translucent/filled"
        case .freehand: return "Draw freely"
        case .magnifier: return "Drag from the centre to set the size"
        case .highlight: return "Drag over text · ⇧ keeps it straight"
        case .blur: return "Drag over what to hide · B again: blur/pixelate"
        case .erase: return "Drag to erase and fill from the surroundings"
        case .spotlight: return "Drag to spotlight an area · 1–9 dims"
        case .counter: return "Click to place numbered steps · type to renumber"
        case .oval: return "Drag to draw · ⇧ circle · O again: style"
        case .line: return "Drag to draw a line · ⇧ snaps to 45°"
        case .ruler: return "Click to measure the gap · drag to measure · ←→ ↑↓ axis"
        case .eyedropper: return "Click to pick a colour (copies hex) · Tab anywhere"
        }
    }

    static func forKey(_ c: Character) -> EditorTool? { allCases.first { $0.key == c } }
}

/// Remembers size and style per annotation kind across editors (like Shottr).
enum ToolMemory {
    /// Replaceable so tests don't read or write the app's remembered sizes.
    static var defaults = UserDefaults.standard
    private static let sizeKey = "ShotEditor.toolSizes"
    private static let styleKey = "ShotEditor.toolStyles"

    static let defaultSizes: [Annotation.Kind: Double] = [
        .arrow: 4, .line: 3, .rect: 3, .oval: 3, .text: 4, .highlight: 4, .freehand: 3,
        .blur: 5, .erase: 5, .counter: 4, .spotlight: 3, .magnifier: 4, .ruler: 3,
    ]

    static func size(for kind: Annotation.Kind) -> Double {
        (defaults.dictionary(forKey: sizeKey)?[kind.rawValue] as? Double) ?? defaultSizes[kind] ?? 4
    }

    static func setSize(_ v: Double, for kind: Annotation.Kind) {
        var d = defaults.dictionary(forKey: sizeKey) ?? [:]
        d[kind.rawValue] = v
        defaults.set(d, forKey: sizeKey)
    }

    static func style(for kind: Annotation.Kind) -> Int {
        (defaults.dictionary(forKey: styleKey)?[kind.rawValue] as? Int) ?? 0
    }

    static func setStyle(_ v: Int, for kind: Annotation.Kind) {
        var d = defaults.dictionary(forKey: styleKey) ?? [:]
        d[kind.rawValue] = v
        defaults.set(d, forKey: styleKey)
    }
}
