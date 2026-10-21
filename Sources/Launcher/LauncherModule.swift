import AppKit
import SwiftUI
import BentoCore

/// Raycast-style hotkeys: one shortcut per app (or URL, file/folder, shell
/// command). Pressing an app's hotkey launches or focuses it; pressing it again
/// while the app is frontmost hides it (or cycles its windows).
///
/// Entries live in the `launcher` config section and are hand-editable:
///
///     "launcher": { "entries": [
///       { "target": "Safari", "shortcut": "ctrl+opt+cmd+1" },
///       { "target": "com.microsoft.VSCode", "shortcut": "hyper+c", "behavior": "cycle" },
///       { "kind": "url", "target": "https://github.com", "shortcut": "hyper+g" }
///     ]}
public final class LauncherModule: BentoModule {
    public let id = "launcher"
    public let title = "App Hotkeys"
    public let symbol = "keyboard"

    private var observer: NSObjectProtocol?

    public init() {}

    var settings: LauncherSettings { ConfigStore.shared.section(id, default: LauncherSettings()) }

    public var actions: [BentoAction] {
        settings.entries.map { entry in
            BentoAction(entry.actionID, entry.actionTitle, group: "Apps", shortcut: entry.shortcut,
                        bindingWriter: { [weak self] sc in self?.setShortcut(sc, for: entry.actionID) }) {
                Launcher.trigger(entry)
            }
        }
    }

    public func start() {
        ConfigStore.shared.materialize(id, default: LauncherSettings())
        observer = ConfigStore.shared.observe(id) { ActionRegistry.shared.reload() }
    }

    public func stop() {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
    }

    public func makeSettingsView() -> AnyView? { AnyView(LauncherSettingsView()) }

    private func setShortcut(_ shortcut: Shortcut?, for actionID: String) {
        var s = settings
        guard let i = s.entries.firstIndex(where: { $0.actionID == actionID }) else { return }
        s.entries[i].shortcut = shortcut?.configString
        ConfigStore.shared.setSection(id, s)
    }
}

// MARK: - Model

struct LauncherSettings: Codable, Equatable {
    var entries: [LauncherEntry] = []
}

struct LauncherEntry: Codable, Equatable, Identifiable {
    enum Kind: String, Codable, CaseIterable { case app, url, path, command }
    enum Behavior: String, Codable, CaseIterable {
        /// Launch/focus; hide when already frontmost (Raycast behaviour).
        case toggle
        /// Launch/focus only.
        case focus
        /// Launch/focus; cycle through the app's windows when already frontmost.
        case cycle
    }

    /// Stable key for the action id. Optional in the file (derived from target).
    var key: String?
    var kind: Kind = .app
    /// App: name, bundle id or path. URL: the URL. Path: file/folder. Command: shell command.
    var target: String
    /// Display name override.
    var name: String?
    var shortcut: String?
    var behavior: Behavior = .toggle

    init(kind: Kind = .app, target: String, name: String? = nil, shortcut: String? = nil, behavior: Behavior = .toggle) {
        self.key = String(UUID().uuidString.prefix(8)).lowercased()
        self.kind = kind
        self.target = target
        self.name = name
        self.shortcut = shortcut
        self.behavior = behavior
    }

    // Lenient decoding: everything but `target` is optional in the file.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        target = try c.decode(String.self, forKey: .target)
        key = try c.decodeIfPresent(String.self, forKey: .key)
        kind = (try? c.decodeIfPresent(Kind.self, forKey: .kind)) ?? .app
        name = try c.decodeIfPresent(String.self, forKey: .name)
        shortcut = try c.decodeIfPresent(String.self, forKey: .shortcut)
        behavior = (try? c.decodeIfPresent(Behavior.self, forKey: .behavior)) ?? .toggle
    }

    var id: String { actionID }

    var actionID: String {
        let k = key ?? target.lowercased().map { $0.isLetter || $0.isNumber ? $0 : "-" }.reduce(into: "") { $0.append($1) }
        return "launcher.\(k)"
    }

    var actionTitle: String {
        kind == .command ? "Run \(displayName)" : "Open \(displayName)"
    }

    var displayName: String {
        if let name, !name.isEmpty { return name }
        switch kind {
        case .app:
            if let url = AppResolver.url(for: target) {
                return FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "")
            }
            return target
        case .url: return URL(string: target)?.host ?? target
        case .path: return (target as NSString).lastPathComponent
        case .command: return target
        }
    }
}

// MARK: - Resolving apps

enum AppResolver {
    private static var cache: [String: URL] = [:]

    static let searchDirs: [String] = [
        "/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities",
        NSHomeDirectory() + "/Applications", "/opt/homebrew/opt", "/System/Library/CoreServices",
        "/System/Library/CoreServices/Applications",
    ]

    /// Resolves an app by path, bundle id, or name (case-insensitive).
    static func url(for target: String) -> URL? {
        if let hit = cache[target], FileManager.default.fileExists(atPath: hit.path) { return hit }
        let found = resolve(target)
        if let found { cache[target] = found }
        return found
    }

    private static func resolve(_ target: String) -> URL? {
        let expanded = (target as NSString).expandingTildeInPath
        if expanded.hasPrefix("/") {
            return FileManager.default.fileExists(atPath: expanded) ? URL(fileURLWithPath: expanded) : nil
        }
        if target.contains("."), !target.hasSuffix(".app"),
           let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: target) {
            return url
        }
        let wanted = (target.hasSuffix(".app") ? target : target + ".app").lowercased()
        let fm = FileManager.default
        for dir in searchDirs {
            guard let items = try? fm.contentsOfDirectory(atPath: dir) else { continue }
            if let match = items.first(where: { $0.lowercased() == wanted }) {
                return URL(fileURLWithPath: dir).appendingPathComponent(match)
            }
        }
        // Running apps (covers apps launched from unusual locations).
        return NSWorkspace.shared.runningApplications.first {
            $0.localizedName?.lowercased() == target.lowercased()
        }?.bundleURL
    }

    static func bundleID(for url: URL) -> String? { Bundle(url: url)?.bundleIdentifier }
}

// MARK: - Triggering

enum Launcher {
    static func trigger(_ entry: LauncherEntry) {
        switch entry.kind {
        case .app:
            toggleApp(entry)
        case .url:
            if let url = URL(string: entry.target) { NSWorkspace.shared.open(url) }
            else { HUD.show("Invalid URL", symbol: "exclamationmark.triangle") }
        case .path:
            NSWorkspace.shared.open(URL(fileURLWithPath: (entry.target as NSString).expandingTildeInPath))
        case .command:
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/zsh")
            p.arguments = ["-lc", entry.target]
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            do { try p.run() } catch { HUD.show("Command failed", symbol: "exclamationmark.triangle") }
        }
    }

    private static func toggleApp(_ entry: LauncherEntry) {
        guard let url = AppResolver.url(for: entry.target) else {
            HUD.show("Can't find \(entry.target)", symbol: "questionmark.app")
            return
        }
        let bid = AppResolver.bundleID(for: url)
        let running = bid.flatMap { NSRunningApplication.runningApplications(withBundleIdentifier: $0).first { !$0.isTerminated } }
        if let app = running, NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier {
            switch entry.behavior {
            case .toggle:
                app.hide()
                return
            case .cycle:
                if cycleWindows(of: app) { return }
                app.hide()
                return
            case .focus:
                break // fall through: reopen (creates a window if none, like a Dock click)
            }
        }
        // LaunchServices activation is honoured even though Bento is a
        // background app, and sends a reopen event like clicking the Dock icon
        // (restores a window when the app has none / all minimised).
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: config) { _, error in
            if let error {
                DispatchQueue.main.async { HUD.show("Couldn't open: \(error.localizedDescription)", symbol: "exclamationmark.triangle") }
            }
        }
    }

    /// Raises the backmost standard window, so repeated presses walk through all of them.
    private static func cycleWindows(of app: NSRunningApplication) -> Bool {
        let windows = AXWindow.windows(of: app.processIdentifier).filter { $0.isStandard && !$0.isMinimized }
        guard windows.count > 1, let last = windows.last else { return false }
        last.focus()
        return true
    }
}
