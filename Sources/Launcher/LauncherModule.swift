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
    private var started = false

    public init() {}

    var settings: LauncherSettings { ConfigStore.shared.section(id, default: LauncherSettings()) }

    public var actions: [BentoAction] {
        settings.entries.map { entry in
            let actionID = entry.actionID
            return BentoAction(actionID, entry.actionTitle, group: "Apps", shortcut: entry.shortcut,
                               bindingWriter: { [weak self] sc in self?.setShortcut(sc, for: actionID) }) {
                Launcher.trigger(entry)
            }
        }
    }

    public func start() {
        guard !started else { return }
        started = true
        ConfigStore.shared.materialize(id, default: LauncherSettings())
        observer = ConfigStore.shared.observe(id) { ActionRegistry.shared.reload() }
    }

    public func stop() {
        guard started else { return }
        started = false
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
    }

    public func makeSettingsView() -> AnyView? { AnyView(LauncherSettingsView()) }

    public func diagnostics() -> [String: Any] {
        let entries = settings.entries
        return ["started": started, "observing": observer != nil, "entries": entries.count,
                "runningCommands": Launcher.runningCommands.count]
    }

    private func setShortcut(_ shortcut: Shortcut?, for actionID: String) {
        var s = settings
        guard let i = s.entries.firstIndex(where: { $0.actionID == actionID }) else { return }
        s.entries[i].shortcut = shortcut?.configString
        ConfigStore.shared.setSection(id, s)
    }
}

// MARK: - Keyboard overview

extension LauncherModule: AppHotkeyProvider {
    public func makeAppSearch(changed: @escaping () -> Void) -> AppSearch {
        InstalledAppSearch(entries: { [weak self] in self?.settings.entries ?? [] }, changed: changed)
    }

    public func addApp(_ app: FoundApp) -> String {
        var s = settings
        let entry = s.entry(for: AppCandidate(url: app.url, name: app.name, bundleID: app.bundleID))
        if s != settings { ConfigStore.shared.setSection(id, s) }
        return entry.actionID
    }

    @discardableResult
    public func removeEntry(_ actionID: String) -> Bool {
        var s = settings
        guard s.removeEntry(actionID) else { return false }
        ConfigStore.shared.setSection(id, s)
        return true
    }

    public func iconFile(for actionID: String) -> URL? {
        settings.entries.first { $0.actionID == actionID }?.iconFile
    }
}

// MARK: - Model

struct LauncherSettings: Codable, Equatable {
    var entries: [LauncherEntry] = []

    init(entries: [LauncherEntry] = []) {
        self.entries = LauncherSettings.uniquingKeys(entries)
    }

    // Lenient: a malformed entry in a hand-edited file is skipped instead of
    // making the whole section (every hotkey) invalid.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let raw = (try? c.decodeIfPresent([Lenient<LauncherEntry>].self, forKey: .entries)) ?? []
        let valid = raw.compactMap(\.value)
        if valid.count < raw.count {
            BentoLog.make("launcher").error("Skipped \(raw.count - valid.count) invalid launcher entries")
        }
        entries = LauncherSettings.uniquingKeys(valid)
    }

    /// The entry that opens `app`, appending one without a shortcut when no
    /// entry does (the overview's ⌘E and a click in the picker).
    mutating func entry(for app: AppCandidate, resolve: (String) -> URL? = AppResolver.url(for:),
                        bundleID: (URL) -> String? = AppResolver.bundleID(for:)) -> LauncherEntry {
        if let existing = BoundApps(entries, resolve: resolve, bundleID: bundleID).entry(for: app) { return existing }
        entries = LauncherSettings.uniquingKeys(entries + [LauncherEntry(kind: .app, target: app.bundleID ?? app.url.path, name: app.name)])
        return entries[entries.count - 1]
    }

    /// False when no entry has that action id.
    mutating func removeEntry(_ actionID: String) -> Bool {
        let before = entries.count
        entries.removeAll { $0.actionID == actionID }
        return entries.count < before
    }

    /// Duplicate entries (same target twice, "Safari" and "safari", copied
    /// keys) would share an action id; later ones get a numbered key.
    static func uniquingKeys(_ entries: [LauncherEntry]) -> [LauncherEntry] {
        var out = entries
        var seen = Set<String>()
        for i in out.indices {
            if seen.contains(out[i].actionID) {
                let base = out[i].keyBase
                var n = 2
                while seen.contains("launcher.\(base)-\(n)") { n += 1 }
                out[i].key = "\(base)-\(n)"
            }
            seen.insert(out[i].actionID)
        }
        return out
    }
}

/// Decodes a value, or nil if it is malformed.
struct Lenient<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
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

    // Lenient decoding: everything but `target` is optional in the file, and
    // a field with the wrong type is treated as missing.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        target = try c.decode(String.self, forKey: .target)
        key = (try? c.decodeIfPresent(String.self, forKey: .key)).flatMap { $0.isEmpty ? nil : $0 }
        kind = (try? c.decodeIfPresent(Kind.self, forKey: .kind)) ?? .app
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? nil
        shortcut = (try? c.decodeIfPresent(String.self, forKey: .shortcut)) ?? nil
        behavior = (try? c.decodeIfPresent(Behavior.self, forKey: .behavior)) ?? .toggle
    }

    var id: String { actionID }

    /// The key, or one derived from the target.
    var keyBase: String {
        if let key { return key }
        let derived = target.lowercased().map { $0.isLetter || $0.isNumber ? $0 : "-" }.reduce(into: "") { $0.append($1) }
        return derived.isEmpty ? "entry" : derived
    }

    var actionID: String { "launcher.\(keyBase)" }

    /// What the entry's icon is drawn from: the app, file or folder it opens.
    var iconFile: URL? {
        switch kind {
        case .app: return AppResolver.url(for: target)
        case .path:
            let path = (target as NSString).expandingTildeInPath
            return FileManager.default.fileExists(atPath: path) ? URL(fileURLWithPath: path) : nil
        case .url, .command: return nil
        }
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
        case .url: return Launcher.url(from: target)?.host ?? target
        case .path: return (target as NSString).lastPathComponent
        case .command: return target
        }
    }
}

// MARK: - Resolving apps

enum AppResolver {
    private static var cache: [String: URL] = [:]
    /// Recent misses, so settings rows and reloads don't rescan directories
    /// for a missing app on every render.
    private static var misses: [String: Date] = [:]
    static let missTTL: TimeInterval = 5

    static let searchDirs: [String] = [
        "/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities",
        NSHomeDirectory() + "/Applications", "/opt/homebrew/opt", "/System/Library/CoreServices",
        "/System/Library/CoreServices/Applications",
    ]

    private static let lock = NSLock()

    /// Resolves an app by path, bundle id, or name (case-insensitive).
    /// Thread-safe (the caches are locked; lookups run unlocked).
    static func url(for target: String) -> URL? {
        let target = target.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !target.isEmpty else { return nil }
        let (hit, missed) = lock.withLock { (cache[target], misses[target]) }
        if let hit {
            if FileManager.default.fileExists(atPath: hit.path) { return hit }
            lock.withLock { cache[target] = nil } // moved, renamed or deleted
        }
        if let missed, Date().timeIntervalSince(missed) < missTTL { return nil }
        let found = resolve(target)
        lock.withLock {
            if let found { cache[target] = found; misses[target] = nil } else { misses[target] = Date() }
        }
        return found
    }

    /// Forgets lookups (e.g. after the user installs or renames an app).
    static func invalidate() {
        lock.withLock {
            cache = [:]
            misses = [:]
        }
    }

    private static func resolve(_ target: String) -> URL? {
        let expanded = (target as NSString).expandingTildeInPath
        if expanded.hasPrefix("/") {
            return FileManager.default.fileExists(atPath: expanded) ? URL(fileURLWithPath: expanded) : nil
        }
        if target.contains("."), !target.lowercased().hasSuffix(".app"),
           let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: target) {
            return url
        }
        let wanted = (target.lowercased().hasSuffix(".app") ? target : target + ".app").lowercased()
        let fm = FileManager.default
        for dir in searchDirs {
            guard let items = try? fm.contentsOfDirectory(atPath: dir) else { continue }
            if let match = items.first(where: { $0.lowercased() == wanted }) {
                return URL(fileURLWithPath: dir).appendingPathComponent(match)
            }
        }
        // Running apps (covers apps launched from unusual locations).
        let name = target.lowercased().hasSuffix(".app") ? String(target.dropLast(4)) : target
        return NSWorkspace.shared.runningApplications.first {
            $0.localizedName?.lowercased() == name.lowercased() || $0.bundleIdentifier?.lowercased() == target.lowercased()
        }?.bundleURL
    }

    static func bundleID(for url: URL) -> String? { Bundle(url: url)?.bundleIdentifier }
}

// MARK: - Triggering

enum Launcher {
    /// Shell commands still running (kept alive until they exit).
    static var runningCommands: Set<Process> = []

    static func trigger(_ entry: LauncherEntry) {
        let target = entry.target.trimmingCharacters(in: .whitespacesAndNewlines)
        switch entry.kind {
        case .app:
            toggleApp(entry)
        case .url:
            guard let url = url(from: target) else {
                HUD.show("Invalid URL", symbol: "exclamationmark.triangle")
                return
            }
            if !NSWorkspace.shared.open(url) { HUD.show("Can't open \(target)", symbol: "exclamationmark.triangle") }
        case .path:
            let path = (target as NSString).expandingTildeInPath
            guard FileManager.default.fileExists(atPath: path) else {
                HUD.show("Can't find \((target as NSString).lastPathComponent)", symbol: "questionmark.folder")
                return
            }
            if !NSWorkspace.shared.open(URL(fileURLWithPath: path)) {
                HUD.show("Can't open \((target as NSString).lastPathComponent)", symbol: "exclamationmark.triangle")
            }
        case .command:
            guard !target.isEmpty else { return }
            run(command: target)
        }
    }

    /// URL from an entry; "github.com" means https://github.com.
    static func url(from target: String) -> URL? {
        let t = target.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, !t.contains(where: \.isWhitespace) else { return nil }
        // "scheme:…" as written, but "localhost:3000" is a host and port.
        if let url = URL(string: t), let scheme = url.scheme, !scheme.isEmpty,
           !(t.dropFirst(scheme.count + 1).first?.isNumber ?? false) {
            return url
        }
        return URL(string: "https://" + t)
    }

    private static func run(command: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", command]
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        p.terminationHandler = { proc in
            DispatchQueue.main.async {
                runningCommands.remove(proc)
                if proc.terminationStatus != 0 {
                    HUD.show("Command failed (exit \(proc.terminationStatus))", symbol: "exclamationmark.triangle")
                }
            }
        }
        do {
            try p.run()
            runningCommands.insert(p)
        } catch {
            HUD.show("Command failed", symbol: "exclamationmark.triangle")
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
