import BentoCore
import Foundation

/// Keeps the dictionary and the synced cleanup settings, which the app reads from
/// UserDefaults, and the voice documents in step. Main thread only.
///
/// `shadow` is the local state as of the last reconcile. A reconcile first turns what
/// changed locally since then into document changes, then writes what the documents
/// say back to UserDefaults. So a remote change is never mistaken for a local one,
/// applying it makes no new change (no echo), and an edit made while a remote change
/// was on its way isn't overwritten by it.
final class VoiceSyncBridge {
    struct State {
        var entries: [UUID: DictionaryEntry] = [:]
        var settings: [String: SyncValue] = VoiceDocs.settingsDefaults
    }

    static let dictionaryKey = "dictionaryEntries"
    static var observedKeys: [String] { [dictionaryKey] + VoiceDocs.settingsDefaults.keys.sorted() }

    let repo: FieldDocRepository
    private let defaults: UserDefaults
    private var shadow = State()
    /// The next reconcile catches up with what changed while not syncing.
    private var catchingUp = true

    init(repo: FieldDocRepository, defaults: UserDefaults) {
        self.repo = repo
        self.defaults = defaults
        begin()
    }

    /// Takes the documents as the last synced state, so whatever differs locally counts
    /// as a local change: the first sync uploads the dictionary, and edits made while
    /// sync was off or Bento wasn't running go out.
    func begin() {
        shadow = expected()
        catchingUp = true
    }

    /// What the documents say the local state should be.
    private func expected() -> State {
        let entries = VoiceDocs.dictionary(repo.allDocs).entries
        return State(entries: Dictionary(entries.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }),
                     settings: VoiceDocs.settings(repo.doc(VoiceDocs.settingsID)))
    }

    /// Returns true when documents changed, so there is something to send.
    @discardableResult
    func reconcile() -> Bool {
        var updates: [String: FieldDoc] = [:]
        func doc(_ id: String) -> FieldDoc? { updates[id] ?? repo.doc(id) }
        func update(_ d: FieldDoc) {
            var d = d
            d.dirty = true
            updates[d.id] = d
        }
        let all = repo.allDocs
        let shown = VoiceDocs.dictionary(all)
        // Entry documents by UUID, tombstones included (they arrive without a type).
        var idByUUID: [UUID: String] = [:]
        for d in all where d.type == VoiceDocs.entryType || (d.deleted && d.type.isEmpty) {
            if let uuid = UUID(uuidString: d.id) { idByUUID[uuid] = d.id }
        }
        func ids(for uuid: UUID) -> [String] { shown.docs[uuid] ?? [idByUUID[uuid] ?? uuid.uuidString] }

        /// Sets the entry's changed fields as a local change; a deleted document comes back.
        func edit(_ id: String, to e: DictionaryEntry, keys: [String]) {
            let fields = VoiceDocs.fields(e)
            guard var d = doc(id), !d.deleted else {
                var d = doc(id) ?? FieldDoc(id: id, type: VoiceDocs.entryType, createdAt: VoiceDocs.milliseconds(e.createdAt), updatedAt: 0)
                let clock = FieldDoc.nextClock(after: d.updatedAt)
                d.type = VoiceDocs.entryType
                d.deleted = false
                for (key, value) in fields { d.fields[key] = value; d.clocks[key] = clock }
                d.updatedAt = clock
                update(d)
                return
            }
            let before = d
            for key in keys { d.set(key, fields[key] ?? .null) }
            if !d.sameContent(before) { update(d) }
        }
        func changedKeys(_ a: DictionaryEntry, _ b: DictionaryEntry) -> [String] {
            let (fa, fb) = (VoiceDocs.fields(a), VoiceDocs.fields(b))
            return fb.keys.filter { fa[$0] != fb[$0] }.sorted()
        }

        // Local edits since the last reconcile. An unreadable dictionary has none; the
        // documents' copy replaces it below.
        let local = localEntries()
        if let local {
            let localByID = Dictionary(local.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            for e in local {
                if let before = shadow.entries[e.id] {
                    guard !VoiceDocs.same(before, e) else { continue }
                    // An edit reaches every document behind the entry; the creation time
                    // stays with its own.
                    let keys = changedKeys(before, e)
                    for id in ids(for: e.id) {
                        edit(id, to: e, keys: id == idByUUID[e.id] ? keys : keys.filter { $0 != "created_at" })
                    }
                } else if let id = idByUUID[e.id], let d = doc(id) {
                    if d.deleted {
                        // A copy older than the deletion (a stale config.json, a Mac that
                        // last synced before it): the deletion stands.
                        let created = VoiceDocs.milliseconds(e.createdAt)
                        guard created > d.updatedAt else { continue }
                        var back = VoiceDocs.newDoc(for: e)
                        back.id = id
                        back.seq = d.seq
                        update(back)
                    } else if let own = VoiceDocs.entry(d), !VoiceDocs.same(own, e) {
                        edit(id, to: e, keys: changedKeys(own, e))
                    }
                } else {
                    update(VoiceDocs.newDoc(for: e))
                }
            }
            for uuid in shadow.entries.keys where localByID[uuid] == nil {
                for id in ids(for: uuid) {
                    guard var d = doc(id), !d.deleted else { continue }
                    d.markDeleted()
                    update(d)
                }
            }
        }

        let settings = localSettings()
        for key in VoiceDocs.settingsDefaults.keys.sorted() {
            guard let value = settings[key], value != shadow.settings[key] else { continue }
            let now = FieldDoc.now()
            var d = doc(VoiceDocs.settingsID)
                ?? FieldDoc(id: VoiceDocs.settingsID, type: VoiceDocs.settingsType, createdAt: now, updatedAt: now)
            d.type = VoiceDocs.settingsType
            d.deleted = false
            if catchingUp, d.clocks[key] == nil {
                // No device has synced this setting yet: what this Mac had before it
                // synced counts as older than any edit made while syncing.
                d.set(key, value, at: 1)
                d.updatedAt = FieldDoc.nextClock(after: d.updatedAt)
            } else {
                d.set(key, value)
            }
            update(d)
        }

        for d in updates.values { repo.save(d, remote: false) }
        let target = expected()
        write(target, over: local, settings: settings)
        shadow = target
        catchingUp = false
        return !updates.isEmpty
    }

    // MARK: UserDefaults

    /// The stored dictionary; nil when it can't be read.
    private func localEntries() -> [DictionaryEntry]? {
        guard let data = defaults.data(forKey: Self.dictionaryKey) else {
            return defaults.object(forKey: Self.dictionaryKey) == nil ? [] : nil
        }
        return try? JSONDecoder().decode([DictionaryEntry].self, from: data)
    }

    /// The synced settings as SettingsStore reads them.
    private func localSettings() -> [String: SyncValue] {
        [
            "customInstructions": .string(defaults.string(forKey: "customInstructions") ?? ""),
            "customInstructionsEnabled": .bool(defaults.bool(forKey: "customInstructionsEnabled")),
            "cleanupEnabled": .bool(defaults.object(forKey: "cleanupEnabled") as? Bool ?? true),
        ]
    }

    /// Writes what differs, announcing each key like SettingsStore does, so open panes
    /// and SettingsSync (config.json) follow.
    private func write(_ target: State, over local: [DictionaryEntry]?, settings: [String: SyncValue]) {
        var changed: [String] = []
        let localByID = local.map { Dictionary($0.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }) }
        let inStep = local.map { $0.count == target.entries.count } == true
            && target.entries.allSatisfy { id, e in localByID?[id].map { VoiceDocs.same($0, e) } ?? false }
        if !inStep {
            let sorted = target.entries.values.sorted { a, b in
                let (ta, tb) = (VoiceDocs.milliseconds(a.createdAt), VoiceDocs.milliseconds(b.createdAt))
                return ta != tb ? ta < tb : a.id.uuidString < b.id.uuidString
            }
            if let data = try? JSONEncoder().encode(sorted) {
                defaults.set(data, forKey: Self.dictionaryKey)
                changed.append(Self.dictionaryKey)
            }
        }
        for key in VoiceDocs.settingsDefaults.keys.sorted() where target.settings[key] != settings[key] {
            switch target.settings[key] {
            case .string(let s)?: defaults.set(s, forKey: key)
            case .bool(let b)?: defaults.set(b, forKey: key)
            default: continue
            }
            changed.append(key)
        }
        for key in changed { NotificationCenter.default.post(name: .gtSettingDidChange, object: key) }
    }
}

/// Syncs the dictionary and the cleanup settings (the `voice` collection) through the
/// Notes sync server and token while a voice module runs, Notes sync is on with a
/// server, and "Sync dictionary and instructions" (Settings → Dictation) is on, as it
/// is by default. Main thread only.
public final class VoiceSync {
    public static let settingKey = "syncDictionary"

    public let status: FieldSyncStatus
    let store: FieldDocStore
    let engine: FieldSyncEngine
    let bridge: VoiceSyncBridge
    private let client: FieldSyncClient
    private let defaults: UserDefaults
    private var observers: [NSObjectProtocol] = []
    private var keyObserver: KeyObserver?
    private var reconcileWork: DispatchWorkItem?
    private var running = false
    /// Syncing: the bridge follows UserDefaults and the client is configured on.
    public private(set) var isActive = false

    public init(url: URL? = FileLayout.appSupportRoot.appendingPathComponent("voice-sync.sqlite"),
                defaults: UserDefaults = .standard) {
        self.defaults = defaults
        store = FieldDocStore(url: url, name: "voice.sync")
        engine = FieldSyncEngine(repo: store)
        bridge = VoiceSyncBridge(repo: store, defaults: defaults)
        client = FieldSyncClient(engine: engine, profile: FieldSyncProfile(
            collection: VoiceDocs.collection, userAgent: "Bento-Voice/1", logCategory: "voice.sync",
            noun: ("dictionary entry", "dictionary entries")) { d in
                d.id == VoiceDocs.settingsID ? "Dictation settings" : d.fields["term"]?.string ?? ""
            })
        status = client.status
        engine.onRemoteChange = { [weak self] _, _ in self?.scheduleReconcile(after: 0) }
    }

    private struct NotesSection: Codable { var sync = SyncServerSettings() }

    /// Notes' sync settings (`notes.sync`), which the voice documents follow.
    public static var notesSync: SyncServerSettings {
        ConfigStore.shared.section("notes", default: NotesSection()).sync
    }

    /// "Sync dictionary and instructions".
    public var isWanted: Bool { defaults.object(forKey: Self.settingKey) as? Bool ?? true }

    public func start() {
        guard !running else { return }
        running = true
        observers.append(ConfigStore.shared.observe("notes") { [weak self] in self?.configure() })
        observers.append(NotificationCenter.default.addObserver(forName: .gtSettingDidChange, object: nil, queue: .main) { [weak self] note in
            if note.object as? String == VoiceSync.settingKey { self?.configure() }
        })
        configure()
    }

    public func stop() {
        guard running else { return }
        running = false
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        configure()
    }

    public func syncNow() { client.syncNow() }

    private func configure() {
        let notes = Self.notesSync
        var settings = notes
        settings.enabled = running && notes.enabled && notes.hasServer && isWanted
        if settings.enabled, !isActive {
            isActive = true
            // Changes made while not syncing go out with the first connection.
            bridge.begin()
            bridge.reconcile()
            keyObserver = KeyObserver(defaults: defaults, keys: VoiceSyncBridge.observedKeys) { [weak self] in
                DispatchQueue.main.async { self?.scheduleReconcile(after: 0.3) }
            }
        } else if !settings.enabled, isActive {
            isActive = false
            keyObserver = nil
            reconcileWork?.cancel()
            reconcileWork = nil
        }
        client.configure(settings)
    }

    /// Local edits wait a moment (typing in the instructions); remote changes, which arrive
    /// in bursts, are applied on the next turn of the run loop.
    private func scheduleReconcile(after delay: TimeInterval) {
        guard isActive else { return }
        reconcileWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.isActive else { return }
            self.reconcileWork = nil
            if self.bridge.reconcile() { self.client.localChange() }
        }
        reconcileWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }
}
