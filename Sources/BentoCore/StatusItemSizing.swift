import Foundation

/// AppKit adds cached spacing even to explicit status-item lengths. Disable it
/// once at process startup, then preserve normal icons' padding explicitly.
public final class StatusItemSizing {
    public static let shared = StatusItemSizing()
    public static let didChange = Notification.Name("BentoStatusItemSizingDidChange")
    private(set) var originalSpacing: CGFloat?
    public private(set) var compactShellIconRequested = false

    public init() {}

    public var shellImageSize: CGFloat { compactShellIconRequested ? 14 : 18 }

    public func shellLength(thickness: CGFloat, fallback: CGFloat) -> CGFloat {
        compactShellIconRequested ? 16 : normalLength(contentWidth: thickness, fallback: fallback)
    }

    /// Main-thread, process-local request from the live Menu Bar controller.
    /// Observers resize synchronously before it starts sampling the new layout.
    public func setCompactShellIconRequested(_ requested: Bool) {
        guard compactShellIconRequested != requested else { return }
        compactShellIconRequested = requested
        NotificationCenter.default.post(name: Self.didChange, object: self)
    }

    /// Unconfigured dev/test entrypoints keep AppKit's automatic sizing.
    public func normalLength(contentWidth: CGFloat, fallback: CGFloat) -> CGFloat {
        originalSpacing.map { contentWidth + $0 } ?? fallback
    }

    /// Must precede the first NSStatusBar access; AppKit caches this preference.
    /// NSArgumentDomain is volatile and overrides inherited global defaults.
    public func configure(defaults: UserDefaults = .standard, currentHostSpacing: () -> Any? = {
        CFPreferencesCopyValue("NSStatusItemSpacing" as CFString, kCFPreferencesAnyApplication,
                               kCFPreferencesCurrentUser, kCFPreferencesCurrentHost)
    }) {
        guard originalSpacing == nil else { return }
        let key = "NSStatusItemSpacing"
        var arguments = defaults.volatileDomain(forName: UserDefaults.argumentDomain)
        func number(_ value: Any?) -> CGFloat? {
            if let value = value as? NSNumber { return CGFloat(value.doubleValue) }
            return (value as? String).flatMap(Double.init).map { CGFloat($0) }
        }
        originalSpacing = number(arguments[key]) ?? number(currentHostSpacing()) ??
            number(defaults.object(forKey: key)) ?? 16
        arguments[key] = 0
        defaults.setVolatileDomain(arguments, forName: UserDefaults.argumentDomain)
    }
}
