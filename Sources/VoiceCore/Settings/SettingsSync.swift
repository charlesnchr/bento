import BentoCore
import Foundation

/// Where the portable settings live. In the app that's the `dictation` section
/// of Bento's config.json (`ConfigSectionStore`); tests use memory.
public protocol SettingsSyncStore: AnyObject {
    /// The stored object: nil when missing, `.failure` when it isn't an object.
    func load() -> Result<[String: Any], SettingsSync.Invalid>?
    func save(_ root: [String: Any])
    /// Calls `changed` on the main thread after the stored object changes.
    func observe(_ changed: @escaping () -> Void)
}

/// The portable dictation settings and dictionary, in Bento's config.json
/// under `dictation`, so a dotfiles repo that links config.json makes every
/// Mac dictate the same way.
///
/// UserDefaults stays what the app reads; the section mirrors it both ways
/// under the same key names, plus `dictionary`. At launch and whenever the
/// file changes, the file wins: its values are applied, and synced keys it
/// leaves out go back to their defaults. Changes made in the app are written
/// back shortly after. A section that isn't an object is never overwritten,
/// and a value of the wrong type keeps this Mac's setting and stays in the
/// file as written; `null` counts as left out. Machine state (stats, gate
/// trips, window positions, the assistant's history, model and zoom, the
/// endpoint override) is never written. Main thread only.
public final class SettingsSync {
    public struct Invalid: Error { public let reason: String }

    enum Kind { case bool, int, string }

    static let keys: [String: Kind] = [
        "hotkeyKey": .string, "doubleTapLock": .bool, "singleTapHandsFree": .bool,
        "showIdleIndicator": .bool, "soundsEnabled": .bool,
        "smartTranscription": .bool, "smartCleanupPass": .bool, "cleanupEnabled": .bool,
        "customInstructions": .string, "customInstructionsEnabled": .bool,
        "liveTranscription": .bool, "experimentalNoiseHandling": .bool,
        "legacyTranscribeEndpoint": .bool, "useDictationComposer": .bool,
        "gptTranscription": .bool, "dualTranscription": .bool, "transcriptionBackend": .string,
        "dualEngines": .string, "retryEngine": .string,
        "transcribeModelOverride": .string, "cleanupModelOverride": .string,
        "meetingCaptureSystemAudio": .bool, "meetingSummaryEnabled": .bool, "meetingExcludesDictation": .bool,
        "audioRetentionDays": .int,
        "assistantLiveCall": .bool, "assistantLiveProvider": .string,
    ]
    static let dictionaryKey = "dictionary"
    static let dictionaryDefaultsKey = "dictionaryEntries"
    private let store: SettingsSyncStore
    private let defaults: UserDefaults
    /// The stored object as last read or written here, so our own writes and
    /// unchanged reloads aren't mistaken for edits.
    private var last: NSDictionary?
    private var pendingWrite: DispatchWorkItem?
    private var observer: KeyObserver?

    public init(store: SettingsSyncStore = ConfigSectionStore("dictation"), defaults: UserDefaults = .standard) {
        self.store = store
        self.defaults = defaults
    }

    /// Applies the stored settings (creating them from the current ones if
    /// missing), then keeps the two in step.
    public func start() {
        sync()
        observer = KeyObserver(defaults: defaults, keys: Array(Self.keys.keys) + [Self.dictionaryDefaultsKey]) { [weak self] in
            DispatchQueue.main.async { self?.scheduleWrite() }
        }
        store.observe { [weak self] in self?.sync() }
    }

    /// Writes any change not yet written. Call on quit: the file wins at the
    /// next launch, so an unwritten change would be undone.
    public func flush() {
        sync()
    }

    /// Reads the stored object, applies it if it changed, then writes back
    /// whatever this Mac has that it doesn't say.
    public func sync() {
        pendingWrite?.cancel()
        pendingWrite = nil
        var root: [String: Any] = [:]
        var exists = false
        switch store.load() {
        case nil:
            break
        case .failure(let invalid)?:
            Log.settings.error("\(invalid.reason, privacy: .public); not saving dictation settings until it's fixed")
            return
        case .success(let object)?:
            let snapshot = object as NSDictionary
            if last.map({ !$0.isEqual(snapshot) }) ?? true { apply(object) }
            last = snapshot
            root = object
            exists = true
        }
        let merged = merged(onto: root)
        if !exists || !Self.equal(merged, root) {
            store.save(merged)
            last = merged as NSDictionary
        }
    }

    // MARK: Mapping

    /// The file with every synced key replaced by this Mac's value. Unknown
    /// keys survive, and so do values of the wrong type (see `apply`).
    func merged(onto root: [String: Any]) -> [String: Any] {
        var out = root
        for (key, kind) in Self.keys where Self.stored(root, key) == nil || Self.normalized(root[key], kind) != nil {
            out[key] = Self.normalized(defaults.object(forKey: key), kind)
        }
        if Self.stored(root, Self.dictionaryKey) == nil || Self.entries(fromFile: root[Self.dictionaryKey]) != nil {
            out[Self.dictionaryKey] = localEntries().map(Self.fileValue)
        }
        return out
    }

    func apply(_ root: [String: Any]) {
        var changed: [String] = []
        for (key, kind) in Self.keys.sorted(by: { $0.key < $1.key }) {
            let value = Self.normalized(root[key], kind)
            if Self.stored(root, key) != nil, value == nil {
                Log.settings.error("config.json: \(key, privacy: .public) has the wrong type; keeping this Mac's value")
                continue
            }
            guard !Self.equal(value, Self.normalized(defaults.object(forKey: key), kind)) else { continue }
            if let value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
            changed.append(key)
        }
        if let stored = Self.stored(root, Self.dictionaryKey) {
            if let entries = Self.entries(fromFile: stored) {
                if !Self.equal(Self.fileValue(entries), localEntries().map(Self.fileValue)),
                   let data = try? JSONEncoder().encode(entries) {
                    defaults.set(data, forKey: Self.dictionaryDefaultsKey)
                    changed.append(Self.dictionaryDefaultsKey)
                }
            } else {
                Log.settings.error("config.json: dictionary isn't a list of entries; keeping this Mac's dictionary")
            }
        } else if defaults.object(forKey: Self.dictionaryDefaultsKey) != nil {
            defaults.removeObject(forKey: Self.dictionaryDefaultsKey)
            changed.append(Self.dictionaryDefaultsKey)
        }
        if !changed.isEmpty {
            Log.settings.info("applied config.json: \(changed.joined(separator: ", "), privacy: .public)")
        }
        for key in changed { NotificationCenter.default.post(name: .gtSettingDidChange, object: key) }
    }

    /// A key's value in the file, with `null` meaning left out.
    static func stored(_ root: [String: Any], _ key: String) -> Any? {
        root[key] is NSNull ? nil : root[key]
    }

    /// `value` as this kind's JSON value, or nil if it isn't one.
    static func normalized(_ value: Any?, _ kind: Kind) -> Any? {
        if kind == .string { return value as? String }
        guard let number = value as? NSNumber else { return nil }
        let isBool = CFGetTypeID(number) == CFBooleanGetTypeID()
        switch kind {
        case .bool:
            return isBool || [0, 1].contains(number.doubleValue) ? number.boolValue : nil
        case .int:
            let double = number.doubleValue
            return !isBool && double.rounded() == double && abs(double) <= 1e9 ? number.intValue : nil
        case .string:
            return nil
        }
    }

    static func equal(_ a: Any?, _ b: Any?) -> Bool {
        switch (a, b) {
        case (nil, nil): return true
        case let (a?, b?): return (a as? NSObject)?.isEqual(b) ?? false
        default: return false
        }
    }

    // MARK: Dictionary

    /// Hand-added entries may leave out everything but `term`.
    private struct FileEntry: Codable {
        var term: String
        var misspelling: String?
        var starred: Bool?
        var id: UUID?
        var createdAt: Date?
    }

    private func localEntries() -> [DictionaryEntry]? {
        guard let data = defaults.data(forKey: Self.dictionaryDefaultsKey) else { return nil }
        return try? JSONDecoder().decode([DictionaryEntry].self, from: data)
    }

    static func fileValue(_ entries: [DictionaryEntry]) -> Any {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(timestamp(date))
        }
        let file = entries.map {
            FileEntry(term: $0.term, misspelling: $0.misspelling, starred: $0.starred, id: $0.id, createdAt: $0.createdAt)
        }
        guard let data = try? encoder.encode(file),
              let object = try? JSONSerialization.jsonObject(with: data) else { return [Any]() }
        return object
    }

    /// ISO 8601 in UTC, rounded to the millisecond. Foundation's fractional
    /// formatter truncates, so reading and rewriting its output lost a
    /// millisecond each time and every pull rewrote the whole dictionary.
    public static func timestamp(_ date: Date) -> String {
        let interval = date.timeIntervalSince1970
        guard interval.isFinite, abs(interval) < 1e13 else { return date.formatted(Date.ISO8601FormatStyle()) }
        let milliseconds = Int64((interval * 1000).rounded())
        let seconds = milliseconds >= 0 ? milliseconds / 1000 : (milliseconds - 999) / 1000
        let fraction = String(milliseconds - seconds * 1000)
        let whole = Date(timeIntervalSince1970: TimeInterval(seconds)).formatted(Date.ISO8601FormatStyle())
        return whole.dropLast() + "." + String(repeating: "0", count: 3 - fraction.count) + fraction + "Z"
    }

    public static func date(timestamp text: String) -> Date? {
        (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text))
            ?? (try? Date.ISO8601FormatStyle().parse(text))
    }

    static func entries(fromFile value: Any?) -> [DictionaryEntry]? {
        guard let value, JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            guard let date = date(timestamp: text) else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "not an ISO 8601 date"))
            }
            return date
        }
        guard let file = try? decoder.decode([FileEntry].self, from: data) else { return nil }
        // The same rules as adding a term in the app: 1–60 characters, no duplicates.
        var seen = Set<String>()
        return file.compactMap { item in
            let term = item.term.trimmingCharacters(in: .whitespacesAndNewlines)
            guard (1...60).contains(term.count), seen.insert(term.lowercased()).inserted else { return nil }
            let misspelling = item.misspelling?.trimmingCharacters(in: .whitespacesAndNewlines)
            var entry = DictionaryEntry(term: term, misspelling: misspelling?.isEmpty == false ? misspelling : nil,
                                        starred: item.starred ?? false)
            if let id = item.id { entry.id = id }
            if let createdAt = item.createdAt { entry.createdAt = createdAt }
            return entry
        }
    }

    private func scheduleWrite() {
        pendingWrite?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.sync() }
        pendingWrite = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: item)
    }
}

/// The `dictation` section of Bento's config.json.
public final class ConfigSectionStore: SettingsSyncStore {
    private let section: String
    private var token: NSObjectProtocol?

    public init(_ section: String) { self.section = section }

    deinit { if let token { NotificationCenter.default.removeObserver(token) } }

    public func load() -> Result<[String: Any], SettingsSync.Invalid>? {
        guard let raw = ConfigStore.shared.rawSection(section), !(raw is NSNull) else { return nil }
        guard let object = raw as? [String: Any] else {
            return .failure(.init(reason: "config.json: \(section) is not an object"))
        }
        return .success(object)
    }

    public func save(_ root: [String: Any]) {
        guard let value = JSONValue(root) else {
            Log.settings.error("dictation settings could not be encoded for config.json")
            return
        }
        ConfigStore.shared.setSection(section, value)
    }

    public func observe(_ changed: @escaping () -> Void) {
        if let token { NotificationCenter.default.removeObserver(token) }
        token = ConfigStore.shared.observe(section, changed)
    }
}

/// KVO on the synced keys only: unrelated defaults (drafts, stats, window
/// frames) change all the time and shouldn't each cost a file read.
private final class KeyObserver: NSObject {
    private let defaults: UserDefaults
    private let keys: [String]
    private let changed: () -> Void

    init(defaults: UserDefaults, keys: [String], changed: @escaping () -> Void) {
        self.defaults = defaults
        self.keys = keys
        self.changed = changed
        super.init()
        for key in keys { defaults.addObserver(self, forKeyPath: key, options: [], context: nil) }
    }

    deinit {
        for key in keys { defaults.removeObserver(self, forKeyPath: key) }
    }

    override func observeValue(forKeyPath keyPath: String?, of object: Any?,
                               change: [NSKeyValueChangeKey: Any]?, context: UnsafeMutableRawPointer?) {
        changed()
    }
}
