import Foundation
import BentoCore

/// Storage the sync engine works against (the SQLite store, or an in-memory one in tests).
protocol NoteRepository: AnyObject {
    func note(_ id: String) -> Note?
    func save(_ note: Note)
    var lastSeq: Int64 { get set }
    func allNotes(includeTombstones: Bool) -> [Note]
}

/// Local notes database: `<support>/Notes/notes.sqlite`.
///
/// All notes are cached in memory (they're small) and written through to SQLite.
/// Main thread only.
final class NoteStore: NoteRepository {
    static let didChange = Notification.Name("BentoNotesStoreDidChange")
    /// userInfo: "ids" -> Set<String>, "remote" -> Bool
    private let db: SQLiteDB?
    private var cache: [String: Note] = [:]
    private var kvCache: [String: String] = [:]
    private let log = BentoLog.make("notes")

    static var defaultURL: URL? { AppPaths.support("Notes").appendingPathComponent("notes.sqlite") }

    init(url: URL? = NoteStore.defaultURL) {
        var db: SQLiteDB?
        if let url {
            do {
                db = try SQLiteDB(path: url.path)
            } catch {
                BentoLog.make("notes").error("Cannot open notes DB: \(String(describing: error), privacy: .public)")
            }
        }
        self.db = db
        migrate()
        load()
    }

    private func migrate() {
        guard let db else { return }
        do {
            try db.exec("""
            CREATE TABLE IF NOT EXISTS notes (
              id TEXT PRIMARY KEY,
              body TEXT NOT NULL DEFAULT '',
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              deleted INTEGER NOT NULL DEFAULT 0,
              seq INTEGER,
              device TEXT NOT NULL DEFAULT '',
              meta TEXT NOT NULL DEFAULT '{}',
              dirty INTEGER NOT NULL DEFAULT 0,
              opened_at INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            """)
            let columns = try db.query("PRAGMA table_info(notes)").compactMap { $0["name"] as? String }
            if !columns.contains("base_hash") {
                try db.exec("ALTER TABLE notes ADD COLUMN base_hash INTEGER")
            }
        } catch {
            log.error("Notes DB migration failed: \(String(describing: error), privacy: .public)")
        }
    }

    /// False when the database couldn't be opened: notes then only live in memory.
    var isPersistent: Bool { db != nil }

    private func load() {
        guard let db else { return }
        do {
            for row in try db.query("SELECT * FROM notes") {
                guard let id = row["id"] as? String else { continue }
                var n = Note(id: id, body: row["body"] as? String ?? "",
                             createdAt: row["created_at"] as? Int64 ?? 0, updatedAt: row["updated_at"] as? Int64 ?? 0)
                n.deleted = (row["deleted"] as? Int64 ?? 0) != 0
                n.seq = row["seq"] as? Int64
                n.device = row["device"] as? String ?? ""
                n.meta = NoteStore.decodeMeta(row["meta"] as? String ?? "{}")
                n.dirty = (row["dirty"] as? Int64 ?? 0) != 0
                n.openedAt = row["opened_at"] as? Int64 ?? 0
                n.baseHash = (row["base_hash"] as? Int64).map { UInt64(bitPattern: $0) }
                cache[id] = n
            }
            for row in try db.query("SELECT key, value FROM kv") {
                if let k = row["key"] as? String, let v = row["value"] as? String { kvCache[k] = v }
            }
        } catch {
            log.error("Loading notes failed: \(String(describing: error), privacy: .public)")
        }
    }

    static func decodeMeta(_ s: String) -> [String: JSONValue] {
        guard let data = s.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return obj.mapValues { JSONValue(any: $0) }
    }

    static func encodeMeta(_ m: [String: JSONValue]) -> String {
        guard !m.isEmpty, let data = try? JSONSerialization.data(withJSONObject: m.mapValues(\.any), options: [.sortedKeys]) else { return "{}" }
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    // MARK: NoteRepository

    func note(_ id: String) -> Note? { cache[id] }

    func save(_ note: Note) {
        save(note, notify: true, remote: false)
    }

    @discardableResult
    func save(_ note: Note, notify: Bool, remote: Bool, requirePersistence: Bool = false) -> Bool {
        guard !requirePersistence || isPersistent else { return false }
        var note = note
        // The SQLite layer passes text as C strings: a NUL would truncate the body on disk.
        if note.body.utf8.contains(0) { note.body = note.body.replacingOccurrences(of: "\u{0}", with: "") }
        if cache[note.id] == note { return true }
        let saved = write(note)
        guard saved || !requirePersistence else { return false }
        cache[note.id] = note
        if notify { post([note.id], remote: remote) }
        return saved
    }

    func allNotes(includeTombstones: Bool = false) -> [Note] {
        includeTombstones ? Array(cache.values) : cache.values.filter { !$0.deleted }
    }

    var lastSeq: Int64 {
        get { Int64(kv("last_seq") ?? "0") ?? 0 }
        set { setKV("last_seq", String(newValue)) }
    }

    // MARK: Queries

    /// Live notes: pinned first (by pin order), then by last opened, newest first.
    var liveNotes: [Note] {
        cache.values.filter(\.isLive).sorted(by: NoteStore.listOrder)
    }

    var trashedNotes: [Note] {
        cache.values.filter { !$0.deleted && $0.isTrashed }.sorted { ($0.trashedAt ?? 0) > ($1.trashedAt ?? 0) }
    }

    static func listOrder(_ a: Note, _ b: Note) -> Bool {
        if a.pinned != b.pinned { return a.pinned }
        if a.pinned { return a.pinOrder < b.pinOrder }
        let ka = max(a.openedAt, a.createdAt), kb = max(b.openedAt, b.createdAt)
        if ka != kb { return ka > kb }
        return a.updatedAt > b.updatedAt
    }

    // MARK: Local-only fields

    func markOpened(_ id: String, at ms: Int64 = Note.now()) {
        guard var n = cache[id] else { return }
        n.openedAt = ms
        cache[id] = n
        _ = try? db?.run("UPDATE notes SET opened_at = ? WHERE id = ?", [ms, id])
    }

    /// Removes a row entirely (never-synced empty notes).
    func remove(_ id: String) {
        cache.removeValue(forKey: id)
        _ = try? db?.run("DELETE FROM notes WHERE id = ?", [id])
        post([id], remote: false)
    }

    // MARK: KV

    func kv(_ key: String) -> String? { kvCache[key] }

    func setKV(_ key: String, _ value: String?) {
        if kvCache[key] == value { return }
        kvCache[key] = value
        if let value {
            _ = try? db?.run("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value])
        } else {
            _ = try? db?.run("DELETE FROM kv WHERE key = ?", [key])
        }
    }

    func kvJSON<T: Codable>(_ key: String, as: T.Type) -> T? {
        guard let s = kv(key), let d = s.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(T.self, from: d)
    }

    func setKVJSON<T: Codable>(_ key: String, _ value: T?) {
        guard let value, let d = try? JSONEncoder().encode(value) else { setKV(key, nil); return }
        setKV(key, String(data: d, encoding: .utf8))
    }

    // MARK: Private

    private func write(_ n: Note) -> Bool {
        do {
            try db?.run("""
            INSERT INTO notes (id, body, created_at, updated_at, deleted, seq, device, meta, dirty, opened_at, base_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET body = excluded.body, created_at = excluded.created_at,
              updated_at = excluded.updated_at, deleted = excluded.deleted, seq = excluded.seq,
              device = excluded.device, meta = excluded.meta, dirty = excluded.dirty, opened_at = excluded.opened_at,
              base_hash = excluded.base_hash
            """, [n.id, n.body, n.createdAt, n.updatedAt, n.deleted, n.seq, n.device, NoteStore.encodeMeta(n.meta), n.dirty, n.openedAt,
                  n.baseHash.map { Int64(bitPattern: $0) }])
            return db != nil
        } catch {
            log.error("Saving note failed: \(String(describing: error), privacy: .public)")
            return false
        }
    }

    private func post(_ ids: Set<String>, remote: Bool) {
        NotificationCenter.default.post(name: NoteStore.didChange, object: self, userInfo: ["ids": ids, "remote": remote])
    }
}
