import Foundation
import os

/// Local database of one collection's field documents (`TodoStore`, the voice sync store).
///
/// All documents are cached in memory (a few thousand at most) and written through
/// to SQLite. Main thread only.
open class FieldDocStore: FieldDocRepository {
    /// userInfo: "ids" -> Set<String>, "remote" -> Bool
    public static let didChange = Notification.Name("BentoFieldDocStoreDidChange")

    private let db: SQLiteDB?
    private var cache: [String: FieldDoc] = [:]
    private var kvCache: [String: String] = [:]
    private let log: Logger
    private let name: String
    /// Coalesces change notifications from a burst of saves (a snapshot, a bulk edit).
    private var pendingIDs: Set<String> = []
    private var pendingRemote = false
    private var postScheduled = false
    /// Documents whose last write failed (database locked): written again with the next save.
    private var unsaved: Set<String> = []

    /// `name` labels log messages ("todo"); nil `url` keeps everything in memory.
    public init(url: URL?, name: String) {
        let log = BentoLog.make(name)
        self.name = name
        self.log = log
        var db: SQLiteDB?
        if let url {
            do {
                db = try SQLiteDB(path: url.path)
                // Wait briefly for another connection's lock instead of failing the write.
                try? db?.exec("PRAGMA busy_timeout=1000")
            } catch {
                log.error("Cannot open \(name, privacy: .public) DB: \(String(describing: error), privacy: .public)")
            }
        }
        self.db = db
        migrate()
        load()
    }

    public var isPersistent: Bool { db != nil }

    private func migrate() {
        guard let db else { return }
        do {
            try db.exec("""
            CREATE TABLE IF NOT EXISTS docs (
              id TEXT PRIMARY KEY,
              body TEXT NOT NULL DEFAULT '',
              type TEXT NOT NULL DEFAULT '',
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              deleted INTEGER NOT NULL DEFAULT 0,
              seq INTEGER,
              device TEXT NOT NULL DEFAULT '',
              meta TEXT NOT NULL DEFAULT '{}',
              dirty INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            """)
        } catch {
            log.error("\(self.name, privacy: .public) DB migration failed: \(String(describing: error), privacy: .public)")
        }
    }

    private func load() {
        guard let db else { return }
        do {
            for row in try db.query("SELECT * FROM docs") {
                guard let id = row["id"] as? String else { continue }
                var d = FieldDoc(id: id, type: row["type"] as? String ?? "",
                                 createdAt: row["created_at"] as? Int64 ?? 0, updatedAt: row["updated_at"] as? Int64 ?? 0)
                d.deleted = (row["deleted"] as? Int64 ?? 0) != 0
                if !d.deleted { _ = d.load(body: row["body"] as? String ?? "") }
                d.seq = row["seq"] as? Int64
                d.device = row["device"] as? String ?? ""
                d.meta = FieldDocStore.decodeObject(row["meta"] as? String ?? "{}")
                d.dirty = (row["dirty"] as? Int64 ?? 0) != 0
                cache[id] = d
            }
            for row in try db.query("SELECT key, value FROM kv") {
                if let k = row["key"] as? String, let v = row["value"] as? String { kvCache[k] = v }
            }
        } catch {
            log.error("Loading \(self.name, privacy: .public) documents failed: \(String(describing: error), privacy: .public)")
        }
    }

    public static func decodeObject(_ s: String) -> [String: SyncValue] {
        guard let data = s.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return obj.mapValues { SyncValue(any: $0) }
    }

    public static func encodeObject(_ m: [String: SyncValue]) -> String {
        guard !m.isEmpty, let data = try? JSONSerialization.data(withJSONObject: m.mapValues(\.any), options: [.sortedKeys]) else { return "{}" }
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    // MARK: FieldDocRepository

    public func doc(_ id: String) -> FieldDoc? { cache[id] }

    public func save(_ doc: FieldDoc, remote: Bool) {
        retryUnsaved()
        if cache[doc.id] == doc { return }
        cache[doc.id] = doc
        write(doc)
        post(doc.id, remote: remote)
    }

    /// Saves several documents in one transaction (bulk edits, reordering).
    public func save(_ docs: [FieldDoc]) {
        retryUnsaved()
        let changed = docs.filter { cache[$0.id] != $0 }
        guard !changed.isEmpty else { return }
        for d in changed { cache[d.id] = d }
        do {
            try db?.transaction { for d in changed { write(d) } }
        } catch {
            // The change stays in memory and is written with the next save.
            log.error("\(self.name, privacy: .public) transaction failed: \(String(describing: error), privacy: .public)")
            unsaved.formUnion(changed.map(\.id))
        }
        for d in changed { post(d.id, remote: false) }
    }

    public var allDocs: [FieldDoc] { Array(cache.values) }

    // MARK: KV (local state: last view, collapsed groups…)

    public func kv(_ key: String) -> String? { kvCache[key] }

    public func setKV(_ key: String, _ value: String?) {
        if kvCache[key] == value { return }
        kvCache[key] = value
        if let value {
            _ = try? db?.run("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value])
        } else {
            _ = try? db?.run("DELETE FROM kv WHERE key = ?", [key])
        }
    }

    // MARK: Private

    /// Writes what an earlier save couldn't; stops at the first failure (still locked).
    private func retryUnsaved() {
        guard !unsaved.isEmpty else { return }
        let ids = Array(unsaved)
        unsaved = []
        for (i, id) in ids.enumerated() {
            guard let d = cache[id] else { continue }
            if !write(d) {
                unsaved.formUnion(ids[i...])
                return
            }
        }
    }

    @discardableResult
    private func write(_ d: FieldDoc) -> Bool {
        var body = d.body
        // The SQLite layer passes text as C strings: a NUL would truncate the body on disk.
        if body.utf8.contains(0) { body = body.replacingOccurrences(of: "\u{0}", with: "") }
        do {
            try db?.run("""
            INSERT INTO docs (id, body, type, created_at, updated_at, deleted, seq, device, meta, dirty)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET body = excluded.body, type = excluded.type, created_at = excluded.created_at,
              updated_at = excluded.updated_at, deleted = excluded.deleted, seq = excluded.seq,
              device = excluded.device, meta = excluded.meta, dirty = excluded.dirty
            """, [d.id, body, d.type, d.createdAt, d.updatedAt, d.deleted, d.seq, d.device, FieldDocStore.encodeObject(d.meta), d.dirty])
            return true
        } catch {
            log.error("Saving \(self.name, privacy: .public) document failed: \(String(describing: error), privacy: .public)")
            unsaved.insert(d.id)
            return false
        }
    }

    private func post(_ id: String, remote: Bool) {
        pendingIDs.insert(id)
        pendingRemote = pendingRemote || remote
        guard !postScheduled else { return }
        postScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let ids = self.pendingIDs, remote = self.pendingRemote
            self.pendingIDs = []
            self.pendingRemote = false
            self.postScheduled = false
            NotificationCenter.default.post(name: FieldDocStore.didChange, object: self, userInfo: ["ids": ids, "remote": remote])
        }
    }
}
