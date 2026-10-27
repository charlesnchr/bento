import AppKit
import SwiftUI

/// Bento's look, picked in Settings → General → Appearance and stored as
/// `general.theme` in the config. Windows follow it through `ThemeCenter`.
public enum Theme: String, Codable, CaseIterable, Identifiable {
    /// The native macOS look: system materials and window backgrounds.
    case standard
    /// Frosted glass: the desktop shows through Bento's windows, blurred.
    case glass
    /// Glass tinted with the accent colour and a glossy sheen across the top,
    /// after Windows Vista's Aero.
    case aero

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .standard: return "Standard"
        case .glass: return "Glass"
        case .aero: return "Aero"
        }
    }
}

/// What a window background draws for a theme. Values are opacities (0–1) of
/// layers over the blur, from the bottom up.
public struct ThemeStyle: Equatable {
    /// Replaces the window's own background; nil keeps it (the standard look).
    public var material: NSVisualEffectView.Material?
    /// Neutral wash (dark in dark mode, light in light mode) that keeps text readable.
    public var frost: CGFloat
    /// The accent colour.
    public var tint: CGFloat
    /// White gloss fading out down the top of the window.
    public var sheen: CGFloat

    public var isGlass: Bool { material != nil }

    public static let standard = ThemeStyle(material: nil, frost: 0, tint: 0, sheen: 0)

    /// Reduce Transparency always gets the standard look; Increase Contrast
    /// gets a heavier frost so text stands out from what's behind the window.
    public init(theme: Theme, reduceTransparency: Bool = false, increaseContrast: Bool = false) {
        switch reduceTransparency ? .standard : theme {
        case .standard: self = .standard
        case .glass: self.init(material: .hudWindow, frost: 0.22, tint: 0, sheen: 0.08)
        case .aero: self.init(material: .hudWindow, frost: 0.16, tint: 0.18, sheen: 0.2)
        }
        if isGlass, increaseContrast { frost = min(1, frost + 0.3) }
    }

    public init(material: NSVisualEffectView.Material?, frost: CGFloat, tint: CGFloat, sheen: CGFloat) {
        self.material = material
        self.frost = frost
        self.tint = tint
        self.sheen = sheen
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
/// own background when nil) in the standard theme, glass in the others. Add
/// the window's views to `effect` (or pass `content`); they sit above the glass
/// and keep AppKit's vibrant appearance.
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

    private func apply(_ style: ThemeStyle) {
        let material = style.material ?? standardMaterial
        effect.isHidden = material == nil
        if let material { effect.material = material }
        glaze.style = style
        glaze.isHidden = !style.isGlass
    }
}

/// The layers over the blur: frost, accent tint and sheen.
private final class GlazeView: NSView {
    var style = ThemeStyle.standard { didSet { if style != oldValue { needsDisplay = true } } }
    private let frost = CALayer()
    private let tint = CALayer()
    private let sheen = CAGradientLayer()
    private var colorsObserver: NSObjectProtocol?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        for l in [frost, tint, sheen] { layer?.addSublayer(l) }
        // Layer y points up: from the top edge down.
        sheen.startPoint = CGPoint(x: 0.5, y: 1)
        sheen.endPoint = CGPoint(x: 0.5, y: 0)
        sheen.locations = [0, 0.38, 0.4, 1]
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
        for l in [frost, tint, sheen] { l.frame = bounds }
        CATransaction.commit()
    }

    override func updateLayer() {
        let dark = effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        effectiveAppearance.performAsCurrentDrawingAppearance {
            frost.backgroundColor = (dark ? NSColor.black : NSColor.white).withAlphaComponent(style.frost).cgColor
            tint.backgroundColor = NSColor.controlAccentColor.withAlphaComponent(style.tint).cgColor
        }
        // Aero's gloss: bright at the top, a soft edge part way down, then clear.
        let s = style.sheen * (dark ? 1 : 0.7)
        sheen.colors = [s, s * 0.35, s * 0.12, 0].map { NSColor.white.withAlphaComponent($0).cgColor }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }
}

// MARK: - SwiftUI

public extension View {
    /// `background` in the standard theme; nothing under glass, so the window's
    /// glass shows through an otherwise opaque part of the view.
    func themedBackground<B: View>(_ background: B) -> some View {
        modifier(ThemedBackground(background: background))
    }

    /// Hides the opaque backgrounds of forms and lists under glass.
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
        content.background { if !themes.style.isGlass { background } }
    }
}

private struct ThemedScrollBackground: ViewModifier {
    @ObservedObject private var themes = ThemeCenter.shared

    func body(content: Content) -> some View {
        content.scrollContentBackground(themes.style.isGlass ? .hidden : .automatic)
    }
}
