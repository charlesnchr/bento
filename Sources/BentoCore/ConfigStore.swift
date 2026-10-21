import Foundation
import Combine

/// The single human-editable config file: `~/.config/bento/config.json`.
///
/// The file is a JSON object with one key per section: `general`, `shortcuts`
/// (action id -> shortcut string) and one section per module (`shot`, `windows`,
/// `tiling`, `launcher`, `clipboard`, `notes`, ...). Each module owns a Codable
/// settings struct and reads it with `section(_:default:)`. Missing keys are
/// filled in from the module's defaults, so hand-edited files can stay minimal;
/// keys with a wrong type fall back to their default individually.
/// The file is watched; external edits are picked up live. A file that isn't
/// valid JSON is never silently replaced: it is copied to
/// `config.invalid.json` before Bento writes its own version.
/// All calls must happen on the main thread.
public final class ConfigStore {
    public static let shared = ConfigStore()

    public static let didChange = Notification.Name("BentoConfigDidChange")
    /// userInfo key holding the `Set<String>` of section names that changed.
    public static let changedSectionsKey = "sections"
    /// A config is a few KB; refuse absurd files instead of parsing them on the main thread.
    static let maxFileSize = 8 << 20

    public let url: URL
    /// Called with a short, user-facing message when the file has a problem
    /// (invalid JSON, wrong value types). The shell shows it as a HUD.
    public var problemHandler: ((String) -> Void)?
    /// The last problem found in the file (nil once it reads cleanly).
    public private(set) var lastProblem: String?

    private var root: [String: Any] = [:]
    /// What the file on disk contains as far as we know (last load / write).
    private var diskRoot: [String: Any] = [:]
    /// Bytes of the file as last read or written by us.
    private var lastWrittenData: Data?
    /// Sections changed in memory since the last write.
    private var dirty: Set<String> = []
    private var pendingWrite: DispatchWorkItem?
    private var fileWatcher: DispatchSourceFileSystemObject?
    private var dirWatcher: DispatchSourceFileSystemObject?
    private var reattachScheduled = false
    private var reportedProblems: Set<String> = []

    init(url: URL = AppPaths.configDir.appendingPathComponent("config.json")) {
        self.url = url
        load()
        watch()
    }

    deinit {
        fileWatcher?.cancel()
        dirWatcher?.cancel()
    }

    /// Symlinked configs (dotfiles repos) are written through, not replaced.
    private var fileURL: URL { url.resolvingSymlinksInPath() }

    // MARK: Sections

    /// Decodes a section, filling missing keys from `defaultValue`. Values
    /// that don't decode (wrong type, bad shortcut string…) are replaced by
    /// their defaults one by one instead of discarding the whole section.
    public func section<T: Codable>(_ key: String, default defaultValue: T) -> T {
        guard let stored = root[key] else { return defaultValue }
        guard let defaultsObject = ConfigStore.jsonObject(defaultValue) else { return defaultValue }
        if let value: T = ConfigStore.decode(ConfigStore.merge(defaultsObject, stored)) { return value }

        var dropped: [String] = []
        let salvaged = ConfigStore.salvage(defaults: defaultsObject, stored: stored, dropped: &dropped) {
            (ConfigStore.decode($0) as T?) != nil
        }
        report("Config “\(key)”: invalid value for \(dropped.isEmpty ? "the section" : dropped.joined(separator: ", ")); using defaults there")
        return ConfigStore.decode(salvaged) ?? defaultValue
    }

    /// Replaces a section and schedules a write.
    public func setSection<T: Codable>(_ key: String, _ value: T) {
        guard let object = ConfigStore.jsonObject(value) else {
            BentoLog.core.error("Config section \(key, privacy: .public) could not be encoded")
            return
        }
        if let old = root[key], ConfigStore.jsonEqual(old, object) { return }
        root[key] = object
        dirty.insert(key)
        scheduleWrite()
        post([key])
    }

    /// Adds every option missing from the stored section (new options appear
    /// after upgrades), so the file always lists all of them. Values already
    /// in the file are kept as written, even ones that don't decode, so a typo
    /// never costs the rest of the section. Call once when a module starts.
    public func materialize<T: Codable>(_ key: String, default defaultValue: T) {
        guard let defaultsObject = ConfigStore.jsonObject(defaultValue) else { return }
        let merged = root[key].map { ConfigStore.merge(defaultsObject, $0) } ?? defaultsObject
        if let old = root[key], ConfigStore.jsonEqual(old, merged) { return }
        root[key] = merged
        dirty.insert(key)
        scheduleWrite()
        post([key])
    }

    /// Raw access for dynamic data.
    public func rawSection(_ key: String) -> Any? { root[key] }

    // MARK: Shortcuts

    /// User overrides: action id -> shortcut string ("" means explicitly unbound).
    /// `null`/`false` in the file also mean unbound; other non-strings are ignored.
    public var shortcutOverrides: [String: String] {
        get {
            guard let raw = root["shortcuts"] as? [String: Any] else { return [:] }
            var out: [String: String] = [:]
            for (id, value) in raw {
                if let s = value as? String { out[id] = s }
                else if value is NSNull || (value as? NSNumber).map({ CFGetTypeID($0) == CFBooleanGetTypeID() && !$0.boolValue }) == true { out[id] = "" }
            }
            return out
        }
        set {
            if let old = root["shortcuts"], ConfigStore.jsonEqual(old, newValue as NSDictionary) { return }
            root["shortcuts"] = newValue
            dirty.insert("shortcuts")
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

    /// True while a change is waiting to be written.
    public var hasPendingWrite: Bool { pendingWrite != nil }

    private func scheduleWrite() {
        pendingWrite?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.write() }
        pendingWrite = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: item)
    }

    private enum DiskState {
        case missing
        case invalid(Data?, String)
        case valid([String: Any], Data)
    }

    private func readDisk() -> DiskState {
        let path = fileURL.path
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: path) else { return .missing }
        if let size = (attrs[.size] as? NSNumber)?.intValue, size > ConfigStore.maxFileSize {
            return .invalid(nil, "config.json is too large (\(size / 1024) KB)")
        }
        guard let data = FileManager.default.contents(atPath: path) else { return .invalid(nil, "config.json can't be read") }
        do {
            guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return .invalid(data, "config.json must contain a JSON object")
            }
            return .valid(obj, data)
        } catch {
            let detail = (error as NSError).userInfo[NSDebugDescriptionErrorKey] as? String ?? "invalid JSON"
            return .invalid(data, "config.json is not valid JSON: \(detail)")
        }
    }

    private func write() {
        pendingWrite = nil
        // Never clobber an edit we haven't picked up yet: merge in an
        // external save that raced our debounced write, and don't overwrite
        // a file the user is still fixing (changes stay in memory and are
        // written once it parses again).
        switch readDisk() {
        case .valid(let obj, let data) where data != lastWrittenData:
            adopt(obj, data: data)
        case .invalid(_, let why):
            // We only ever write valid JSON, so this is the user's edit.
            report(why + " (not saving until it's fixed)")
            return
        default:
            break
        }
        let data = JSONWriter.data(root)
        let target = fileURL
        if data == lastWrittenData, FileManager.default.fileExists(atPath: target.path) {
            dirty = []
            return
        }
        do {
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: target, options: .atomic)
            lastWrittenData = data
            diskRoot = root
            dirty = []
            watch() // atomic writes replace the inode
        } catch {
            BentoLog.core.error("Failed to write config: \(String(describing: error), privacy: .public)")
        }
    }

    private func load() {
        switch readDisk() {
        case .missing:
            root = [:]
        case .invalid(let data, let why):
            // Run on defaults; the file is left alone until it's fixed.
            root = [:]
            lastWrittenData = data
            report(why + " (using defaults until it's fixed)")
        case .valid(let obj, let data):
            root = obj
            diskRoot = obj
            lastWrittenData = data
        }
    }

    private func reloadFromDisk() {
        switch readDisk() {
        case .missing:
            return // deleted or mid-save: keep what we have; the next write recreates it
        case .invalid(let data, let why):
            // Remember the bytes, so restoring the previous content counts as a change.
            if let data { lastWrittenData = data }
            report(why + " (changes ignored until fixed)")
        case .valid(let obj, let data):
            guard data != lastWrittenData else { return }
            adopt(obj, data: data)
        }
    }

    /// Takes the file's content. Sections changed in memory but not yet
    /// written survive, unless the file changed the same section.
    private func adopt(_ disk: [String: Any], data: Data) {
        let old = root
        var merged = disk
        for key in dirty where ConfigStore.optionalEqual(diskRoot[key], disk[key]) {
            merged[key] = root[key]
        }
        dirty = dirty.filter { ConfigStore.optionalEqual(diskRoot[$0], disk[$0]) }
        root = merged
        diskRoot = disk
        lastWrittenData = data
        lastProblem = nil
        reportedProblems = []
        let changed = Set(old.keys).union(merged.keys).filter { !ConfigStore.optionalEqual(old[$0], merged[$0]) }
        if !dirty.isEmpty, pendingWrite == nil { scheduleWrite() } // changes held back while the file was invalid
        if !changed.isEmpty { post(changed) }
    }

    /// Logs and shows each distinct problem once (until the file changes).
    private func report(_ message: String) {
        lastProblem = message
        guard reportedProblems.insert(message).inserted else { return }
        BentoLog.core.error("\(message, privacy: .public)")
        problemHandler?(message)
    }

    // MARK: Watching

    /// Whether external edits are being watched (diagnostics).
    public var isWatching: Bool { fileWatcher != nil || dirWatcher != nil }

    private func watch() {
        fileWatcher?.cancel()
        fileWatcher = nil
        let fd = open(fileURL.path, O_EVTONLY)
        guard fd >= 0 else {
            // No file (yet, or an editor is between delete and create): watch
            // the directory until it appears.
            watchDirectory()
            return
        }
        dirWatcher?.cancel()
        dirWatcher = nil
        let src = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .delete, .rename, .extend], queue: .main)
        src.setEventHandler { [weak self, weak src] in
            guard let self, let src else { return }
            let flags = src.data
            if flags.contains(.delete) || flags.contains(.rename) {
                // Editors save atomically; re-attach to the new file shortly after.
                self.scheduleReattach()
            } else {
                self.reloadFromDisk()
            }
        }
        src.setCancelHandler { close(fd) }
        src.resume()
        fileWatcher = src
    }

    private func scheduleReattach() {
        guard !reattachScheduled else { return }
        reattachScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            guard let self else { return }
            self.reattachScheduled = false
            self.reloadFromDisk()
            self.watch()
        }
    }

    private func watchDirectory() {
        guard dirWatcher == nil else { return }
        let dir = fileURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let fd = open(dir.path, O_EVTONLY)
        guard fd >= 0 else { return }
        let src = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write], queue: .main)
        src.setEventHandler { [weak self] in
            guard let self, FileManager.default.fileExists(atPath: self.fileURL.path) else { return }
            self.reloadFromDisk()
            self.watch()
        }
        src.setCancelHandler { close(fd) }
        src.resume()
        dirWatcher = src
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

    /// Builds the largest valid version of `stored` on top of `defaults`:
    /// keys (recursively for objects, element by element for arrays) are
    /// applied one at a time and kept only if the whole still decodes.
    static func salvage(defaults: Any, stored: Any, dropped: inout [String], isValid: (Any) -> Bool) -> Any {
        var current = defaults
        salvage(stored, at: [], into: &current, dropped: &dropped, isValid: isValid)
        return current
    }

    private static func salvage(_ stored: Any, at path: [String], into current: inout Any, dropped: inout [String], isValid: (Any) -> Bool) {
        let existing = value(at: path, in: current)
        if let dict = stored as? [String: Any], existing is [String: Any] {
            for k in dict.keys.sorted() {
                let p = path + [k]
                let candidate = setting(value(at: p, in: current).map { merge($0, dict[k]!) } ?? dict[k]!, at: p[...], in: current)
                if isValid(candidate) { current = candidate; continue }
                let sub = value(at: p, in: current)
                if (dict[k] is [String: Any] && sub is [String: Any]) || (dict[k] is [Any] && sub is [Any]) {
                    salvage(dict[k]!, at: p, into: &current, dropped: &dropped, isValid: isValid)
                } else {
                    dropped.append(p.joined(separator: "."))
                }
            }
        } else if let array = stored as? [Any], existing is [Any] {
            var kept: [Any] = []
            for (i, element) in array.enumerated() {
                let candidate = setting(kept + [element], at: path[...], in: current)
                if isValid(candidate) { kept.append(element) } else { dropped.append((path + ["\(i)"]).joined(separator: ".")) }
            }
            current = setting(kept, at: path[...], in: current)
        } else {
            dropped.append(path.isEmpty ? "the section" : path.joined(separator: "."))
        }
    }

    private static func value(at path: [String], in object: Any) -> Any? {
        var cur: Any? = object
        for k in path { cur = (cur as? [String: Any])?[k] }
        return cur
    }

    private static func setting(_ value: Any, at path: ArraySlice<String>, in object: Any) -> Any {
        guard let k = path.first else { return value }
        var dict = object as? [String: Any] ?? [:]
        dict[k] = setting(value, at: path.dropFirst(), in: dict[k] ?? [String: Any]())
        return dict
    }

    static func jsonObject<T: Encodable>(_ value: T) -> Any? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }

    static func decode<T: Decodable>(_ object: Any) -> T? {
        // JSONSerialization raises (uncatchable) on non-JSON values; config
        // objects only ever hold JSON types, but don't bet the app on it.
        guard JSONSerialization.isValidJSONObject(object) || object is String || object is NSNumber || object is NSNull,
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed]) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    static func jsonEqual(_ a: Any, _ b: Any) -> Bool {
        (a as? NSObject)?.isEqual(b) ?? false
    }

    static func optionalEqual(_ a: Any?, _ b: Any?) -> Bool {
        switch (a, b) {
        case (nil, nil): return true
        case let (a?, b?): return jsonEqual(a, b)
        default: return false
        }
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
    /// settings UI or an external edit). Keep the returned token alive and
    /// remove it with `NotificationCenter.default.removeObserver` in `stop()`.
    func observe(_ section: String, _ handler: @escaping () -> Void) -> NSObjectProtocol {
        NotificationCenter.default.addObserver(forName: ConfigStore.didChange, object: self, queue: .main) { note in
            guard let sections = note.userInfo?[ConfigStore.changedSectionsKey] as? Set<String>,
                  sections.contains(section) else { return }
            handler()
        }
    }
}
