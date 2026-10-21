import Foundation
import Combine

/// The single human-editable config file: `~/.config/bento/config.json`.
///
/// The file is a JSON object with one key per section: `general`, `shortcuts`
/// (action id -> shortcut string) and one section per module (`shot`, `windows`,
/// `tiling`, `launcher`, `clipboard`, `notes`, ...). Each module owns a Codable
/// settings struct and reads it with `section(_:default:)`. Missing keys are
/// filled in from the module's defaults, so hand-edited files can stay minimal.
/// The file is watched; external edits are picked up live.
public final class ConfigStore {
    public static let shared = ConfigStore()

    public static let didChange = Notification.Name("BentoConfigDidChange")
    /// userInfo key holding the `Set<String>` of section names that changed.
    public static let changedSectionsKey = "sections"

    public let url: URL
    private var root: [String: Any] = [:]
    private var watcher: DispatchSourceFileSystemObject?
    private var lastWrittenData: Data?
    private var pendingWrite: DispatchWorkItem?

    init(url: URL = AppPaths.configDir.appendingPathComponent("config.json")) {
        self.url = url
        load()
        watch()
    }

    // MARK: Sections

    /// Decodes a section, filling missing keys from `defaultValue`.
    public func section<T: Codable>(_ key: String, default defaultValue: T) -> T {
        guard let stored = root[key] else { return defaultValue }
        do {
            let defaultsObject = try JSONSerialization.jsonObject(with: JSONEncoder().encode(defaultValue))
            let merged = ConfigStore.merge(defaultsObject, stored)
            let data = try JSONSerialization.data(withJSONObject: merged, options: [.fragmentsAllowed])
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            BentoLog.core.error("Config section \(key, privacy: .public) is invalid, using defaults: \(String(describing: error), privacy: .public)")
            return defaultValue
        }
    }

    /// Replaces a section and schedules a write.
    public func setSection<T: Codable>(_ key: String, _ value: T) {
        guard let data = try? JSONEncoder().encode(value),
              let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else { return }
        if let old = root[key], ConfigStore.jsonEqual(old, object) { return }
        root[key] = object
        scheduleWrite()
        post([key])
    }

    /// Writes the section back merged with defaults, so the config file always
    /// lists every available option (new options appear after upgrades).
    /// Call once when a module starts.
    public func materialize<T: Codable>(_ key: String, default defaultValue: T) {
        setSection(key, section(key, default: defaultValue))
    }

    /// Raw access for dynamic data.
    public func rawSection(_ key: String) -> Any? { root[key] }

    // MARK: Shortcuts

    /// User overrides: action id -> shortcut string ("" means explicitly unbound).
    public var shortcutOverrides: [String: String] {
        get { root["shortcuts"] as? [String: String] ?? [:] }
        set {
            root["shortcuts"] = newValue
            scheduleWrite()
            post(["shortcuts"])
        }
    }

    // MARK: Persistence

    /// Writes immediately (used on quit).
    public func flush() {
        pendingWrite?.cancel()
        pendingWrite = nil
        write()
    }

    private func scheduleWrite() {
        pendingWrite?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.write() }
        pendingWrite = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: item)
    }

    private func write() {
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
            if data == lastWrittenData, FileManager.default.fileExists(atPath: url.path) { return }
            lastWrittenData = data
            try data.write(to: url, options: .atomic)
            watch() // atomic writes replace the inode
        } catch {
            BentoLog.core.error("Failed to write config: \(String(describing: error), privacy: .public)")
        }
    }

    private func load() {
        guard let data = try? Data(contentsOf: url) else { root = [:]; return }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            BentoLog.core.error("Config file is not valid JSON; keeping previous values")
            return
        }
        lastWrittenData = data
        root = obj
    }

    private func reloadFromDisk() {
        guard let data = try? Data(contentsOf: url), data != lastWrittenData else { return }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            BentoLog.core.error("Edited config is not valid JSON; ignoring until fixed")
            return
        }
        let old = root
        root = obj
        lastWrittenData = data
        var changed = Set<String>()
        for key in Set(old.keys).union(obj.keys) {
            switch (old[key], obj[key]) {
            case let (a?, b?): if !ConfigStore.jsonEqual(a, b) { changed.insert(key) }
            case (nil, nil): break
            default: changed.insert(key)
            }
        }
        if !changed.isEmpty { post(changed) }
    }

    private func watch() {
        watcher?.cancel()
        watcher = nil
        if !FileManager.default.fileExists(atPath: url.path) {
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            return
        }
        let fd = open(url.path, O_EVTONLY)
        guard fd >= 0 else { return }
        let src = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .delete, .rename, .extend], queue: .main)
        src.setEventHandler { [weak self] in
            guard let self else { return }
            let flags = src.data
            if flags.contains(.delete) || flags.contains(.rename) {
                // Editors save atomically; re-attach to the new file shortly after.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                    self.reloadFromDisk()
                    self.watch()
                }
            } else {
                self.reloadFromDisk()
            }
        }
        src.setCancelHandler { close(fd) }
        src.resume()
        watcher = src
    }

    private func post(_ sections: Set<String>) {
        NotificationCenter.default.post(name: ConfigStore.didChange, object: self,
                                        userInfo: [ConfigStore.changedSectionsKey: sections])
    }

    // MARK: JSON helpers

    /// Deep-merges `override` onto `base` (objects merge, everything else replaces).
    static func merge(_ base: Any, _ override: Any) -> Any {
        guard let b = base as? [String: Any], let o = override as? [String: Any] else { return override }
        var out = b
        for (k, v) in o { out[k] = b[k].map { merge($0, v) } ?? v }
        return out
    }

    static func jsonEqual(_ a: Any, _ b: Any) -> Bool {
        (a as? NSObject)?.isEqual(b) ?? false
    }
}

/// Observable wrapper around one config section, for SwiftUI settings panes.
///
///     @StateObject var model = ConfigSection("clipboard", default: ClipboardSettings())
///     Toggle("Enabled", isOn: $model.value.enabled)
///
/// Edits are written back to the file; external edits update `value`.
public final class ConfigSection<T: Codable & Equatable>: ObservableObject {
    public let key: String
    private let defaultValue: T
    private var observer: NSObjectProtocol?
    private var applyingExternal = false

    @Published public var value: T {
        didSet {
            guard !applyingExternal, value != oldValue else { return }
            ConfigStore.shared.setSection(key, value)
        }
    }

    public init(_ key: String, default defaultValue: T) {
        self.key = key
        self.defaultValue = defaultValue
        self.value = ConfigStore.shared.section(key, default: defaultValue)
        observer = NotificationCenter.default.addObserver(forName: ConfigStore.didChange, object: nil, queue: .main) { [weak self] note in
            guard let self,
                  let sections = note.userInfo?[ConfigStore.changedSectionsKey] as? Set<String>,
                  sections.contains(self.key) else { return }
            let fresh = ConfigStore.shared.section(self.key, default: self.defaultValue)
            if fresh != self.value {
                self.applyingExternal = true
                self.value = fresh
                self.applyingExternal = false
            }
        }
    }

    deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }
}

public extension ConfigStore {
    /// Calls `handler` on the main queue whenever `section` changes (from the
    /// settings UI or an external edit). Keep the returned token alive.
    func observe(_ section: String, _ handler: @escaping () -> Void) -> NSObjectProtocol {
        NotificationCenter.default.addObserver(forName: ConfigStore.didChange, object: nil, queue: .main) { note in
            guard let sections = note.userInfo?[ConfigStore.changedSectionsKey] as? Set<String>,
                  sections.contains(section) else { return }
            handler()
        }
    }
}
