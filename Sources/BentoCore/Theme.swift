import AppKit
import SwiftUI

/// Bento's look, picked in Settings → General → Appearance and stored as
/// `general.theme` in the config. Windows follow it through `ThemeCenter`.
public enum Theme: String, Codable, CaseIterable, Identifiable {
    /// The native macOS look: system materials and window backgrounds.
    case standard
    /// Frosted glass: the desktop shows through Bento's windows, blurred.
    case glass
    /// Frosted glass washed with the accent colour.
    case tinted
    /// Near-black, high-contrast windows, dark even in light mode.
    case graphite
    /// Warm off-white windows, light even in dark mode.
    case paper

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .standard: return "Standard"
        case .glass: return "Glass"
        case .tinted: return "Tinted"
        case .graphite: return "Graphite"
        case .paper: return "Paper"
        }
    }

    /// Themes that were removed, mapped to the closest current one.
    static let renamed: [String: Theme] = [
        // Aero (glass, accent tint and a gloss) became Tinted without the gloss.
        "aero": .tinted,
    ]

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)
        guard let theme = Theme(rawValue: raw) ?? Self.renamed[raw] else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unknown theme \(raw)")
        }
        self = theme
    }
}

/// An sRGB colour with separate light and dark values.
public struct ThemeColor: Equatable {
    public var light: Components
    public var dark: Components

    public struct Components: Equatable {
        public var red, green, blue, alpha: CGFloat
        public init(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat, _ alpha: CGFloat = 1) {
            (self.red, self.green, self.blue, self.alpha) = (red, green, blue, alpha)
        }
        public var color: NSColor { NSColor(srgbRed: red, green: green, blue: blue, alpha: alpha) }
    }

    public init(light: Components, dark: Components) {
        self.light = light
        self.dark = dark
    }

    public func components(dark isDark: Bool) -> Components { isDark ? dark : light }

    /// Resolves to the light or dark value wherever it's drawn.
    public var dynamic: NSColor {
        NSColor(name: nil) { [self] appearance in
            components(dark: appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua).color
        }
    }
}

/// What a window background draws for a theme: a surface colour over an
/// optional blur of the desktop, an optional accent wash, and optionally a
/// fixed light or dark appearance.
public struct ThemeStyle: Equatable {
    /// The blur behind the surface. nil with a surface: an opaque window.
    public var material: NSVisualEffectView.Material?
    /// Replaces the window's own background; nil keeps it (the standard look).
    /// Under glass its alpha decides how much of the desktop shows through.
    public var surface: ThemeColor?
    /// Opacity of the accent colour over the surface.
    public var tint: CGFloat
    /// A wash over the surface that sets sidebars and list columns apart
    /// (`themedSidebarBackground`); nil in the standard theme.
    public var sidebar: ThemeColor?
    /// Pins the windows to light or dark; nil follows the system.
    public var appearance: NSAppearance.Name?

    /// The theme paints the window's background: views hide their own opaque
    /// backgrounds (`themedBackground`) so it shows.
    public var replacesBackground: Bool { surface != nil }
    /// The desktop shows through.
    public var isGlass: Bool { surface != nil && material != nil }

    public static let standard = ThemeStyle(material: nil, surface: nil, tint: 0, appearance: nil)

    /// Darker in light mode, lighter in dark mode: a 3–4% step.
    private static let neutralSidebar = ThemeColor(light: .init(0, 0, 0, 0.035), dark: .init(1, 1, 1, 0.045))

    /// Reduce Transparency turns glass into the standard look (the opaque themes
    /// stay); Increase Contrast frosts glass more so text stands out from
    /// what's behind the window.
    public init(theme: Theme, reduceTransparency: Bool = false, increaseContrast: Bool = false) {
        switch theme {
        case .standard:
            self = .standard
        case .glass:
            // A heavy neutral frost over the blur: the desktop reads as soft
            // light and colour, not as shapes behind the text.
            self.init(material: Self.glassMaterial,
                      surface: ThemeColor(light: .init(0.97, 0.97, 0.98, 0.72), dark: .init(0.08, 0.08, 0.09, 0.66)),
                      tint: 0, sidebar: Self.neutralSidebar, appearance: nil)
        case .tinted:
            // Glass in the accent colour: a cooler frost and a clear wash.
            self.init(material: Self.glassMaterial,
                      surface: ThemeColor(light: .init(0.97, 0.98, 1, 0.8), dark: .init(0.05, 0.06, 0.09, 0.66)),
                      tint: 0.16, sidebar: Self.neutralSidebar, appearance: nil)
        case .graphite:
            self.init(material: nil,
                      surface: ThemeColor(light: .init(0.075, 0.078, 0.086), dark: .init(0.075, 0.078, 0.086)),
                      tint: 0, sidebar: ThemeColor(light: .init(1, 1, 1, 0.045), dark: .init(1, 1, 1, 0.045)), appearance: .darkAqua)
        case .paper:
            self.init(material: nil,
                      surface: ThemeColor(light: .init(0.965, 0.945, 0.905), dark: .init(0.965, 0.945, 0.905)),
                      tint: 0, sidebar: ThemeColor(light: .init(0.35, 0.25, 0.1, 0.06), dark: .init(0.35, 0.25, 0.1, 0.06)), appearance: .aqua)
        }
        if isGlass, reduceTransparency { self = .standard }
        if isGlass, increaseContrast, let s = surface {
            surface = ThemeColor(light: s.light.frosted(by: 0.3), dark: s.dark.frosted(by: 0.3))
        }
    }

    public init(material: NSVisualEffectView.Material?, surface: ThemeColor?, tint: CGFloat,
                sidebar: ThemeColor? = nil, appearance: NSAppearance.Name?) {
        self.material = material
        self.surface = surface
        self.tint = tint
        self.sidebar = sidebar
        self.appearance = appearance
    }

    /// Blurs harder and more neutrally than `.hudWindow`: a busy desktop
    /// reads as soft colour instead of shapes behind the text.
    static let glassMaterial = NSVisualEffectView.Material.underWindowBackground
}

private extension ThemeColor.Components {
    func frosted(by amount: CGFloat) -> Self { Self(red, green, blue, min(1, alpha + amount)) }
}

/// The current theme. The shell sets the selection from the config; windows
/// read `style` (or use `ThemedBackgroundView` / `themedBackground`) and
/// update on `didChange`. All calls on the main thread.
public final class ThemeCenter: ObservableObject {
    public static let shared = ThemeCenter()
    public static let didChange = Notification.Name("BentoThemeDidChange")

    @Published public private(set) var selected: Theme = .standard
    /// What windows draw: the selection, adjusted for the accessibility settings.
    @Published public private(set) var style: ThemeStyle = .standard
    @Published public private(set) var reduceTransparency = NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency
    private var increaseContrast = NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast
    private var observer: NSObjectProtocol?

    init() {
        observer = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            self?.updateAccessibility(
                reduceTransparency: NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency,
                increaseContrast: NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast)
        }
    }

    deinit { if let observer { NSWorkspace.shared.notificationCenter.removeObserver(observer) } }

    func updateAccessibility(reduceTransparency: Bool, increaseContrast: Bool) {
        if self.reduceTransparency != reduceTransparency { self.reduceTransparency = reduceTransparency }
        self.increaseContrast = increaseContrast
        update()
    }

    public func select(_ theme: Theme) {
        guard theme != selected else { return }
        selected = theme
        update()
    }

    private func update() {
        let new = ThemeStyle(theme: selected, reduceTransparency: reduceTransparency, increaseContrast: increaseContrast)
        guard new != style else { return }
        style = new
        NotificationCenter.default.post(name: Self.didChange, object: self)
    }
}

// MARK: - AppKit

/// A window's background that follows the theme: `material` (or the window's
/// own background when nil) in the standard theme, the theme's surface in the
/// others. Add the window's views to `effect` (or pass `content`); they sit
/// above the surface and keep AppKit's vibrant appearance. Themes with a fixed
/// appearance set it on the window while they're selected.
///
///     let background = ThemedBackgroundView(material: .popover, content: host)
///     window.contentView = background
public final class ThemedBackgroundView: NSView {
    /// Configure blending or state here; the theme sets its material.
    public let effect = NSVisualEffectView()
    /// Called after the theme changed, for views that adjust their own backgrounds.
    public var onChange: ((ThemeStyle) -> Void)?
    private let standardMaterial: NSVisualEffectView.Material?
    private let glaze = GlazeView()
    private var observer: NSObjectProtocol?

    public init(material: NSVisualEffectView.Material?, content: NSView? = nil) {
        standardMaterial = material
        super.init(frame: .zero)
        effect.blendingMode = .behindWindow
        effect.state = .active
        for v in [effect, glaze] + (content.map { [$0] } ?? []) {
            let parent: NSView = v === effect || (v === content && material == nil) ? self : effect
            v.translatesAutoresizingMaskIntoConstraints = false
            parent.addSubview(v)
            NSLayoutConstraint.activate([
                v.leadingAnchor.constraint(equalTo: parent.leadingAnchor),
                v.trailingAnchor.constraint(equalTo: parent.trailingAnchor),
                v.topAnchor.constraint(equalTo: parent.topAnchor),
                v.bottomAnchor.constraint(equalTo: parent.bottomAnchor),
            ])
        }
        apply(ThemeCenter.shared.style)
        observer = NotificationCenter.default.addObserver(forName: ThemeCenter.didChange, object: ThemeCenter.shared, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.apply(ThemeCenter.shared.style)
            self.onChange?(ThemeCenter.shared.style)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }

    public override func viewWillMove(toWindow newWindow: NSWindow?) {
        // The window it leaves gets its own look back.
        if let window, newWindow !== window { WindowTheming.apply(nil, to: window) }
        super.viewWillMove(toWindow: newWindow)
    }

    public override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let window { WindowTheming.apply(ThemeCenter.shared.style, to: window) }
    }

    private func apply(_ style: ThemeStyle) {
        // Opaque themes keep the effect view (the content lives in it) and cover it.
        let material = style.replacesBackground ? style.material ?? .windowBackground : standardMaterial
        effect.isHidden = material == nil
        if let material { effect.material = material }
        glaze.style = style
        glaze.isHidden = !style.replacesBackground
        if let window { WindowTheming.apply(style, to: window) }
    }
}

public extension NSWindow {
    /// For child panels (menus, palettes): match `parent`'s appearance, which
    /// a theme may pin, instead of the system's.
    func followAppearance(of parent: NSWindow) {
        if appearance != parent.appearance { appearance = parent.appearance }
    }
}

/// What a theme changes on a window: the pinned appearance, and a clear title
/// bar so the surface runs under it instead of meeting the toolbar's own
/// background. The window's own values are kept per window (not per view), so
/// several themed views in one window, or a view moving between windows,
/// never take a themed value for the window's own.
enum WindowTheming {
    private final class Originals {
        var appearance: NSAppearance??
        var titlebarTransparent: Bool?
        var isEmpty: Bool { appearance == nil && titlebarTransparent == nil }
    }
    private static let originals = NSMapTable<NSWindow, Originals>.weakToStrongObjects()

    /// nil puts back what the window had before any theme changed it.
    static func apply(_ style: ThemeStyle?, to window: NSWindow) {
        let saved = originals.object(forKey: window) ?? Originals()
        if style?.replacesBackground == true {
            if saved.titlebarTransparent == nil { saved.titlebarTransparent = window.titlebarAppearsTransparent }
            window.titlebarAppearsTransparent = true
        } else if let own = saved.titlebarTransparent {
            window.titlebarAppearsTransparent = own
            saved.titlebarTransparent = nil
        }
        if let name = style?.appearance {
            if saved.appearance == nil { saved.appearance = .some(window.appearance) }
            window.appearance = NSAppearance(named: name)
        } else if let own = saved.appearance {
            window.appearance = own
            saved.appearance = nil
        }
        if saved.isEmpty { originals.removeObject(forKey: window) } else { originals.setObject(saved, forKey: window) }
    }
}

/// The layers over the blur: the surface and the accent tint.
private final class GlazeView: NSView {
    var style = ThemeStyle.standard { didSet { if style != oldValue { needsDisplay = true } } }
    private let surface = CALayer()
    private let tint = CALayer()
    private var colorsObserver: NSObjectProtocol?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        for l in [surface, tint] { layer?.addSublayer(l) }
        colorsObserver = NotificationCenter.default.addObserver(forName: NSColor.systemColorsDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            self?.needsDisplay = true
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    deinit { if let colorsObserver { NotificationCenter.default.removeObserver(colorsObserver) } }

    override var wantsUpdateLayer: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for l in [surface, tint] { l.frame = bounds }
        CATransaction.commit()
    }

    override func updateLayer() {
        let dark = effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        surface.backgroundColor = style.surface?.components(dark: dark).color.cgColor
        effectiveAppearance.performAsCurrentDrawingAppearance {
            tint.backgroundColor = NSColor.controlAccentColor.withAlphaComponent(style.tint).cgColor
        }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }
}

// MARK: - SwiftUI

public extension View {
    /// `background` in the standard theme; nothing in the others, so the
    /// theme's surface shows through an otherwise opaque part of the view.
    func themedBackground<B: View>(_ background: B) -> some View {
        modifier(ThemedBackground(background: background))
    }

    /// For sidebars and list columns: `background` in the standard theme; the
    /// theme's sidebar wash in the others, so the split stays visible.
    func themedSidebarBackground<B: View>(_ background: B) -> some View {
        modifier(ThemedSidebarBackground(background: background))
    }

    /// `themedSidebarBackground` for columns with no background of their own.
    func themedSidebarBackground() -> some View {
        themedSidebarBackground(EmptyView())
    }

    /// Hides the opaque backgrounds of forms and lists outside the standard theme.
    func themedScrollBackground() -> some View {
        modifier(ThemedScrollBackground())
    }
}

/// `ThemedBackgroundView` for SwiftUI: put it behind a window's root view
/// with `.background(ThemeBackdrop().ignoresSafeArea())`.
/// The material is fixed when the view is created.
public struct ThemeBackdrop: NSViewRepresentable {
    public var material: NSVisualEffectView.Material?

    public init(material: NSVisualEffectView.Material? = nil) {
        self.material = material
    }

    public func makeNSView(context: Context) -> ThemedBackgroundView {
        ThemedBackgroundView(material: material)
    }

    public func updateNSView(_ view: ThemedBackgroundView, context: Context) {}
}

private struct ThemedBackground<B: View>: ViewModifier {
    let background: B
    @ObservedObject private var themes = ThemeCenter.shared

    func body(content: Content) -> some View {
        content.background { if !themes.style.replacesBackground { background } }
    }
}

private struct ThemedSidebarBackground<B: View>: ViewModifier {
    let background: B
    @ObservedObject private var themes = ThemeCenter.shared

    func body(content: Content) -> some View {
        content.background {
            if let wash = themes.style.sidebar {
                Rectangle().fill(Color(nsColor: wash.dynamic))
            } else if !themes.style.replacesBackground {
                background
            }
        }
    }
}

private struct ThemedScrollBackground: ViewModifier {
    @ObservedObject private var themes = ThemeCenter.shared

    func body(content: Content) -> some View {
        content.scrollContentBackground(themes.style.replacesBackground ? .hidden : .automatic)
    }
}
