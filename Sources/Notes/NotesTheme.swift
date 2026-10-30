import AppKit

extension NSAttributedString.Key {
    /// Glyphs of characters with this attribute are not drawn and take no space.
    static let notesHidden = NSAttributedString.Key("notesHidden")
    /// On heading/list/quote prefix characters: the prefix length (for caret snapping).
    static let notesPrefixLen = NSAttributedString.Key("notesPrefixLen")
    /// `BlockDecoration` for the whole line (incl. its newline).
    static let notesBlock = NSAttributedString.Key("notesBlock")
    /// Inline code pill background (on the code span incl. backticks).
    static let notesInlineCode = NSAttributedString.Key("notesInlineCode")
    /// Fenced code block background.
    static let notesCodeBlock = NSAttributedString.Key("notesCodeBlock")
    /// URL string of a link.
    static let notesLink = NSAttributedString.Key("notesLink")
}

/// Per-line decoration drawn by the layout manager, also used to detect when restyling
/// can stop (a following line whose decoration didn't change).
final class BlockDecoration: NSObject {
    enum Kind: Hashable {
        case paragraph(empty: Bool)
        case heading(level: Int, spaced: Bool)
        case bullet(level: Int)
        case ordered(level: Int, number: Int)
        case task(level: Int, checked: Bool)
        case quote(depth: Int)
        case rule(revealed: Bool)
        case fence(opening: Bool, revealed: Bool)
        case code
        /// A line in a collapsed heading's section: hidden and squeezed to no height.
        case folded
        /// A line that is one image (`NoteImage`), drawn `width`×`height` points above the
        /// line's text, which shows only while the selection touches it. 0×0: size unknown yet.
        case image(hash: String, width: Int, height: Int, revealed: Bool)
    }

    let kind: Kind
    /// Fence state after this line.
    let inCodeAfter: Bool
    let first: Bool
    /// On a heading line: whether its section is collapsed. nil on other lines.
    let collapsed: Bool?

    init(_ kind: Kind, inCodeAfter: Bool, first: Bool, collapsed: Bool? = nil) {
        self.kind = kind
        self.inCodeAfter = inCodeAfter
        self.first = first
        self.collapsed = collapsed
    }

    override func isEqual(_ object: Any?) -> Bool {
        guard let o = object as? BlockDecoration else { return false }
        return o.kind == kind && o.inCodeAfter == inCodeAfter && o.first == first && o.collapsed == collapsed
    }

    // NSTextStorage uniques attribute dictionaries by hash: a constant hash made that slow
    override var hash: Int {
        var h = Hasher()
        h.combine(kind); h.combine(inCodeAfter); h.combine(first); h.combine(collapsed)
        return h.finalize()
    }

    var listLevel: Int? {
        switch kind {
        case .bullet(let l), .ordered(let l, _), .task(let l, _): return l
        default: return nil
        }
    }

    var isCode: Bool {
        switch kind {
        case .code, .fence: return true
        default: return false
        }
    }
}

/// Fonts, colours and metrics for the editor, derived from settings.
/// Values follow Raycast's editor CSS (see RaycastNotesSpec.swift).
struct NotesTheme {
    enum TextSize: String, CaseIterable {
        case small, medium, large, xLarge, xxLarge
        var points: CGFloat { [12, 14, 16, 18, 20][index] }
        var lineHeight: CGFloat { [1.45, 1.45, 1.35, 1.30, 1.30][index] }
        var title: String { ["Small", "Medium", "Large", "X-Large", "XX-Large"][index] }
        private var index: Int { TextSize.allCases.firstIndex(of: self)! }
    }

    var size: TextSize = .medium
    var family = "system"
    var accent: NSColor = NotesTheme.raycastRed

    static let raycastRed = NSColor(srgbRed: 1, green: 0x63 / 255.0, blue: 0x63 / 255.0, alpha: 1)

    var base: CGFloat { size.points }
    /// Text inset from the window edges (CSS padding 8px 24px).
    let horizontalInset: CGFloat = 24
    /// List indentation per level.
    let listIndent: CGFloat = 22

    // MARK: Colours (dynamic, follow light/dark)

    static func dynamic(dark: NSColor, light: NSColor) -> NSColor {
        NSColor(name: nil) { ap in ap.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light }
    }

    let heading = NotesTheme.dynamic(dark: NSColor(white: 0.95, alpha: 1), light: NSColor(white: 0.08, alpha: 1))
    let paragraph = NotesTheme.dynamic(dark: NSColor(white: 0.95, alpha: 0.88), light: NSColor(white: 0.10, alpha: 0.86))
    let checked = NotesTheme.dynamic(dark: NSColor(white: 0.95, alpha: 0.55), light: NSColor(white: 0.10, alpha: 0.5))
    let marker = NotesTheme.dynamic(dark: NSColor(white: 0.95, alpha: 0.35), light: NSColor(white: 0.10, alpha: 0.35))
    let codeText = NotesTheme.dynamic(dark: NSColor(white: 0.95, alpha: 0.75), light: NSColor(white: 0.10, alpha: 0.8))
    let codeBackground = NotesTheme.dynamic(dark: NSColor(white: 0.95, alpha: 0.10), light: NSColor(white: 0.10, alpha: 0.07))
    let separator = NotesTheme.dynamic(dark: NSColor(white: 1, alpha: 0.12), light: NSColor(white: 0, alpha: 0.12))
    let bullet = NotesTheme.dynamic(dark: NSColor(white: 0.95, alpha: 0.75), light: NSColor(white: 0.10, alpha: 0.7))

    // MARK: Fonts

    func font(_ points: CGFloat, weight: NSFont.Weight = .regular, italic: Bool = false) -> NSFont {
        var f: NSFont
        switch family {
        case "mono", "monospaced": f = NSFont.monospacedSystemFont(ofSize: points, weight: weight)
        case "rounded", "serif":
            let sys = NSFont.systemFont(ofSize: points, weight: weight)
            let design: NSFontDescriptor.SystemDesign = family == "rounded" ? .rounded : .serif
            f = sys.fontDescriptor.withDesign(design).flatMap { NSFont(descriptor: $0, size: points) } ?? sys
        case "system", "":
            f = NSFont.systemFont(ofSize: points, weight: weight)
        default:
            if let custom = NSFont(name: family, size: points) {
                f = weight >= .semibold ? NSFontManager.shared.convert(custom, toHaveTrait: .boldFontMask) : custom
            } else {
                f = NSFont.systemFont(ofSize: points, weight: weight)
            }
        }
        if italic {
            let d = f.fontDescriptor.withSymbolicTraits(f.fontDescriptor.symbolicTraits.union(.italic))
            f = NSFont(descriptor: d, size: points) ?? f
        }
        return f
    }

    func mono(_ points: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
        NSFont.monospacedSystemFont(ofSize: points, weight: weight)
    }

    var bodyFont: NSFont { font(base) }

    func headingFont(_ level: Int) -> NSFont {
        switch level {
        case 1: return font((base * 1.7).rounded(), weight: NSFont.Weight(0.36))
        case 2: return font((base * 1.425).rounded(), weight: NSFont.Weight(0.34))
        default: return font((base * 1.15).rounded(), weight: .semibold)
        }
    }

    /// Natural line height of a font in TextKit 1.
    static func lineHeight(_ f: NSFont) -> CGFloat {
        NSLayoutManager().defaultLineHeight(for: f)
    }

    /// Extra space between wrapped lines to reach the CSS line height.
    func lineSpacing(for f: NSFont, factor: CGFloat? = nil) -> CGFloat {
        max(0, (f.pointSize * (factor ?? size.lineHeight)).rounded() - NotesTheme.lineHeight(f))
    }
}
