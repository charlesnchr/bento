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
    /// Pins the windows to light or dark; nil follows the system.
    public var appearance: NSAppearance.Name?

    /// The theme paints the window's background: views hide their own opaque
    /// backgrounds (`themedBackground`) so it shows.
    public var replacesBackground: Bool { surface != nil }
    /// The desktop shows through.
    public var isGlass: Bool { surface != nil && material != nil }

    public static let standard = ThemeStyle(material: nil, surface: nil, tint: 0, appearance: nil)

    /// Reduce Transparency turns glass into the standard look (the opaque themes
    /// stay); Increase Contrast frosts glass more so text stands out from
    /// what's behind the window.
    public init(theme: Theme, reduceTransparency: Bool = false, increaseContrast: Bool = false) {
        switch theme {
        case .standard:
            self = .standard
        case .glass:
            // Neutral frost over the HUD blur: enough to keep secondary text
            // readable over a busy wallpaper, little enough to stay glass.
            self.init(material: .hudWindow,
                      surface: ThemeColor(light: .init(0.97, 0.97, 0.98, 0.6), dark: .init(0.08, 0.08, 0.09, 0.58)),
                      tint: 0, appearance: nil)
        case .tinted:
            self.init(material: .hudWindow,
                      surface: ThemeColor(light: .init(0.97, 0.97, 0.98, 0.68), dark: .init(0.08, 0.08, 0.09, 0.6)),
                      tint: 0.1, appearance: nil)
        case .graphite:
            self.init(material: nil,
                      surface: ThemeColor(light: .init(0.075, 0.078, 0.086), dark: .init(0.075, 0.078, 0.086)),
                      tint: 0, appearance: .darkAqua)
        case .paper:
            self.init(material: nil,
                      surface: ThemeColor(light: .init(0.965, 0.945, 0.905), dark: .init(0.965, 0.945, 0.905)),
                      tint: 0, appearance: .aqua)
        }
        if isGlass, reduceTransparency { self = .standard }
        if isGlass, increaseContrast, let s = surface {
            surface = ThemeColor(light: s.light.frosted(by: 0.3), dark: s.dark.frosted(by: 0.3))
        }
    }

    public init(material: NSVisualEffectView.Material?, surface: ThemeColor?, tint: CGFloat, appearance: NSAppearance.Name?) {
        self.material = material
        self.surface = surface
        self.tint = tint
        self.appearance = appearance
    }

    /// The colour views see behind them in `appearance` (`.aqua`/`.darkAqua`),
    /// with the desktop through glass taken as `backdrop`. For contrast checks.
    public func background(dark: Bool, backdrop: NSColor) -> NSColor {
        guard let surface else { return backdrop }
        let accent = NSColor.controlAccentColor.usingColorSpace(.sRGB) ?? .systemBlue
        let base = material == nil ? surface.components(dark: dark).color.withAlphaComponent(1) : surface.components(dark: dark).color
        return base.over(backdrop).blended(alpha: tint, with: accent)
    }
}

private extension ThemeColor.Components {
    func frosted(by amount: CGFloat) -> Self { Self(red, green, blue, min(1, alpha + amount)) }
}

extension NSColor {
    /// Source-over compositing of self onto an opaque `backdrop`, in sRGB.
    func over(_ backdrop: NSColor) -> NSColor {
        let f = usingColorSpace(.sRGB) ?? self, b = backdrop.usingColorSpace(.sRGB) ?? backdrop
        let a = f.alphaComponent
        return NSColor(srgbRed: f.redComponent * a + b.redComponent * (1 - a),
                       green: f.greenComponent * a + b.greenComponent * (1 - a),
                       blue: f.blueComponent * a + b.blueComponent * (1 - a), alpha: 1)
    }

    func blended(alpha: CGFloat, with color: NSColor) -> NSColor {
        alpha > 0 ? color.withAlphaComponent(alpha).over(self) : self
    }

    /// WCAG relative luminance (sRGB).
    var relativeLuminance: CGFloat {
        let c = usingColorSpace(.sRGB) ?? self
        func lin(_ v: CGFloat) -> CGFloat { v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        return 0.2126 * lin(c.redComponent) + 0.7152 * lin(c.greenComponent) + 0.0722 * lin(c.blueComponent)
    }

    /// WCAG contrast ratio against another opaque colour (1–21).
    func contrast(with other: NSColor) -> CGFloat {
        let (a, b) = (relativeLuminance, other.relativeLuminance)
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }
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
    /// The window's own appearance while a theme pins another one.
    private var windowAppearance: NSAppearance??
    /// The window's own `titlebarAppearsTransparent` while a theme paints under the title bar.
    private var windowTitlebarTransparent: Bool?

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

    public override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        applyWindow(ThemeCenter.shared.style)
    }

    private func apply(_ style: ThemeStyle) {
        // Opaque themes keep the effect view (the content lives in it) and cover it.
        let material = style.replacesBackground ? style.material ?? .windowBackground : standardMaterial
        effect.isHidden = material == nil
        if let material { effect.material = material }
        glaze.style = style
        glaze.isHidden = !style.replacesBackground
        applyWindow(style)
    }

    /// The pinned appearance, and a clear title bar so the surface runs under
    /// it instead of meeting the toolbar's own background.
    private func applyWindow(_ style: ThemeStyle) {
        guard let window else { return }
        if style.replacesBackground {
            if windowTitlebarTransparent == nil { windowTitlebarTransparent = window.titlebarAppearsTransparent }
            window.titlebarAppearsTransparent = true
        } else if let own = windowTitlebarTransparent {
            window.titlebarAppearsTransparent = own
            windowTitlebarTransparent = nil
        }
        if let name = style.appearance {
            if windowAppearance == nil { windowAppearance = .some(window.appearance) }
            window.appearance = NSAppearance(named: name)
        } else if let own = windowAppearance {
            window.appearance = own
            windowAppearance = nil
        }
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

private struct ThemedScrollBackground: ViewModifier {
    @ObservedObject private var themes = ThemeCenter.shared

    func body(content: Content) -> some View {
        content.scrollContentBackground(themes.style.replacesBackground ? .hidden : .automatic)
    }
}
