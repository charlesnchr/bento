import Foundation
import BentoCore

/// Storage the sync engine works against (the SQLite store, or an in-memory one in tests).
protocol TodoRepository: AnyObject {
    func doc(_ id: String) -> TodoDoc?
    func save(_ doc: TodoDoc, remote: Bool)
    var lastSeq: Int64 { get set }
    var allDocs: [TodoDoc] { get }
}

/// Local todo database: `<support>/Todo/todo.sqlite`.
///
/// All documents are cached in memory (a few thousand tasks at most) and written
/// through to SQLite. Main thread only.
final class TodoStore: TodoRepository {
    static let didChange = Notification.Name("BentoTodoStoreDidChange")
    /// userInfo: "ids" -> Set<String>, "remote" -> Bool

    private let db: SQLiteDB?
    private var cache: [String: TodoDoc] = [:]
    private var kvCache: [String: String] = [:]
    private let log = BentoLog.make("todo")
    /// Coalesces change notifications from a burst of saves (a snapshot, a bulk edit).
    private var pendingIDs: Set<String> = []
    private var pendingRemote = false
    private var postScheduled = false
    /// Documents whose last write failed (database locked): written again with the next save.
    private var unsaved: Set<String> = []

    static var defaultURL: URL? { AppPaths.support("Todo").appendingPathComponent("todo.sqlite") }

    init(url: URL? = TodoStore.defaultURL) {
        var db: SQLiteDB?
        if let url {
            do {
                db = try SQLiteDB(path: url.path)
                // Wait briefly for another connection's lock instead of failing the write.
                try? db?.exec("PRAGMA busy_timeout=1000")
            } catch {
                BentoLog.make("todo").error("Cannot open todo DB: \(String(describing: error), privacy: .public)")
            }
        }
        self.db = db
        migrate()
        load()
    }

    var isPersistent: Bool { db != nil }

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
            log.error("Todo DB migration failed: \(String(describing: error), privacy: .public)")
        }
    }

    private func load() {
        guard let db else { return }
        do {
            for row in try db.query("SELECT * FROM docs") {
                guard let id = row["id"] as? String else { continue }
                var d = TodoDoc(id: id, type: row["type"] as? String ?? "",
                                createdAt: row["created_at"] as? Int64 ?? 0, updatedAt: row["updated_at"] as? Int64 ?? 0)
                d.deleted = (row["deleted"] as? Int64 ?? 0) != 0
                if !d.deleted { _ = d.load(body: row["body"] as? String ?? "") }
                d.seq = row["seq"] as? Int64
                d.device = row["device"] as? String ?? ""
                d.meta = TodoStore.decodeObject(row["meta"] as? String ?? "{}")
                d.dirty = (row["dirty"] as? Int64 ?? 0) != 0
                cache[id] = d
            }
            for row in try db.query("SELECT key, value FROM kv") {
                if let k = row["key"] as? String, let v = row["value"] as? String { kvCache[k] = v }
            }
        } catch {
            log.error("Loading todos failed: \(String(describing: error), privacy: .public)")
        }
    }

    static func decodeObject(_ s: String) -> [String: JSONValue] {
        guard let data = s.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return obj.mapValues { JSONValue(any: $0) }
    }

    static func encodeObject(_ m: [String: JSONValue]) -> String {
        guard !m.isEmpty, let data = try? JSONSerialization.data(withJSONObject: m.mapValues(\.any), options: [.sortedKeys]) else { return "{}" }
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    // MARK: TodoRepository

    func doc(_ id: String) -> TodoDoc? { cache[id] }

    func save(_ doc: TodoDoc, remote: Bool) {
        retryUnsaved()
        if cache[doc.id] == doc { return }
        cache[doc.id] = doc
        write(doc)
        post(doc.id, remote: remote)
    }

    /// Saves several documents in one transaction (bulk edits, reordering).
    func save(_ docs: [TodoDoc]) {
        retryUnsaved()
        let changed = docs.filter { cache[$0.id] != $0 }
        guard !changed.isEmpty else { return }
        for d in changed { cache[d.id] = d }
        do {
            try db?.transaction { for d in changed { write(d) } }
        } catch {
            // The change stays in memory and is written with the next save.
            log.error("Todo transaction failed: \(String(describing: error), privacy: .public)")
            unsaved.formUnion(changed.map(\.id))
        }
        for d in changed { post(d.id, remote: false) }
    }

    var allDocs: [TodoDoc] { Array(cache.values) }

    var lastSeq: Int64 {
        get { Int64(kv("last_seq") ?? "0") ?? 0 }
        set { setKV("last_seq", String(newValue)) }
    }

    // MARK: Queries

    var tasks: [TodoDoc] { cache.values.filter(\.isTask) }

    /// Live projects, archived ones last, by order.
    var projects: [TodoDoc] {
        cache.values.filter(\.isProject).sorted { a, b in
            if a.archived != b.archived { return !a.archived }
            if a.order != b.order { return a.order < b.order }
            return a.id < b.id
        }
    }

    /// Every label used by an open task, plus labels the user created, sorted.
    var labels: [String] {
        var seen: [String: String] = [:]
        for t in cache.values where t.isTask && !t.isCompleted {
            for l in t.labels where seen[l.lowercased()] == nil { seen[l.lowercased()] = l }
        }
        return seen.values.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    // MARK: KV (local UI state: last view, collapsed groups…)

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
    private func write(_ d: TodoDoc) -> Bool {
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
            """, [d.id, body, d.type, d.createdAt, d.updatedAt, d.deleted, d.seq, d.device, TodoStore.encodeObject(d.meta), d.dirty])
            return true
        } catch {
            log.error("Saving todo failed: \(String(describing: error), privacy: .public)")
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
            NotificationCenter.default.post(name: TodoStore.didChange, object: self, userInfo: ["ids": ids, "remote": remote])
        }
    }
}
