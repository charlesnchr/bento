import AppKit
import BentoCore

/// Status item spacing and selection padding: the per-host global defaults
/// `NSStatusItemSpacing` / `NSStatusItemSelectionPadding` (what
/// `defaults -currentHost write -globalDomain …` sets). Apps read them when
/// they start, so a change shows as each app restarts (or after logging out).
enum ItemSpacing {
    static let spacingKey = "NSStatusItemSpacing"
    static let paddingKey = "NSStatusItemSelectionPadding"
    /// macOS's values when the keys are absent.
    static let defaultSpacing = 16
    static let defaultPadding = 16
    static let range = 0...24

    struct Values: Equatable {
        var spacing: Int?
        var padding: Int?
    }

    static func read() -> Values {
        Values(spacing: value(spacingKey), padding: value(paddingKey))
    }

    private static func value(_ key: String) -> Int? {
        let v = CFPreferencesCopyValue(key as CFString, kCFPreferencesAnyApplication, kCFPreferencesCurrentUser, kCFPreferencesCurrentHost)
        return (v as? NSNumber)?.intValue
    }

    /// Writes the values (nil removes a key, back to macOS's default).
    static func write(_ values: Values) {
        set(spacingKey, values.spacing.map { $0.clamped(range) })
        set(paddingKey, values.padding.map { $0.clamped(range) })
        CFPreferencesSynchronize(kCFPreferencesAnyApplication, kCFPreferencesCurrentUser, kCFPreferencesCurrentHost)
    }

    private static func set(_ key: String, _ value: Int?) {
        CFPreferencesSetValue(key as CFString, value.map { NSNumber(value: $0) }, kCFPreferencesAnyApplication,
                              kCFPreferencesCurrentUser, kCFPreferencesCurrentHost)
    }

    /// The equivalent Terminal commands (shown in Settings, for reference).
    static func commands(_ values: Values) -> [String] {
        [(spacingKey, values.spacing), (paddingKey, values.padding)].map { key, v in
            v.map { "defaults -currentHost write -globalDomain \(key) -int \($0.clamped(range))" }
                ?? "defaults -currentHost delete -globalDomain \(key)"
        }
    }
}

/// Optional tint, border and shadow behind the menu bar, one borderless
/// click-through window per display, just below the menu bar's own level.
final class MenuBarOverlay {
    private var windows: [CGDirectDisplayID: NSWindow] = [:]
    private var appearance = MenuBarAppearance()

    func update(_ new: MenuBarAppearance) {
        appearance = new
        layout()
    }

    func layout() {
        let screens = NSScreen.screens
        let ids = Set(screens.map(\.displayID))
        for (id, w) in windows where !ids.contains(id) {
            w.orderOut(nil)
            windows.removeValue(forKey: id)
        }
        for screen in screens {
            let w = windows[screen.displayID] ?? makeWindow()
            windows[screen.displayID] = w
            let barHeight = max(NSStatusBar.system.thickness, screen.frame.maxY - screen.visibleFrame.maxY)
            let shadow: CGFloat = appearance.shadow ? 8 : 0
            w.setFrame(NSRect(x: screen.frame.minX, y: screen.frame.maxY - barHeight - shadow,
                              width: screen.frame.width, height: barHeight + shadow), display: false)
            (w.contentView as? OverlayView)?.configure(appearance, barHeight: barHeight)
            w.orderFrontRegardless()
        }
    }

    func close() {
        windows.values.forEach { $0.orderOut(nil) }
        windows = [:]
    }

    private func makeWindow() -> NSWindow {
        let w = NSWindow(contentRect: .zero, styleMask: [.borderless], backing: .buffered, defer: false)
        w.isOpaque = false
        w.backgroundColor = .clear
        w.ignoresMouseEvents = true
        w.hasShadow = false
        w.isReleasedWhenClosed = false
        w.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) - 1)
        w.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        w.contentView = OverlayView()
        return w
    }
}

private final class OverlayView: NSView {
    private var appearanceSettings = MenuBarAppearance()
    private var barHeight: CGFloat = 24

    func configure(_ a: MenuBarAppearance, barHeight: CGFloat) {
        appearanceSettings = a
        self.barHeight = barHeight
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        let bar = NSRect(x: 0, y: bounds.maxY - barHeight, width: bounds.width, height: barHeight)
        if let c = MenuBarAppearance.rgba(appearanceSettings.tint) {
            NSColor(srgbRed: c.r, green: c.g, blue: c.b, alpha: c.a).setFill()
            bar.fill()
        }
        if appearanceSettings.border, let c = MenuBarAppearance.rgba(appearanceSettings.borderColor) {
            let width = CGFloat(MenuBarSettings.finite(appearanceSettings.borderWidth, in: 0.5...4, else: 1))
            NSColor(srgbRed: c.r, green: c.g, blue: c.b, alpha: c.a).setFill()
            NSRect(x: 0, y: bar.minY, width: bounds.width, height: width).fill()
        }
        if appearanceSettings.shadow, bar.minY > 0 {
            let gradient = NSGradient(starting: NSColor.black.withAlphaComponent(0.22), ending: .clear)
            gradient?.draw(in: NSRect(x: 0, y: 0, width: bounds.width, height: bar.minY), angle: -90)
        }
    }
}
