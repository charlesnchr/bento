import Foundation
import SQLite3

/// Minimal SQLite wrapper (system libsqlite3, no dependencies).
///
///     let db = try SQLiteDB(path: url.path)
///     try db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, name TEXT)")
///     try db.run("INSERT INTO t (name) VALUES (?)", ["hello"])
///     let rows = try db.query("SELECT id, name FROM t WHERE name LIKE ?", ["%he%"])
///     rows[0]["name"] as? String
///
/// Bind values: String, Int, Int64, Double, Bool, Data, nil (NSNull).
/// Result values: Int64, Double, String, Data, or nil for NULL.
/// Not thread-safe; use one connection per queue.
public final class SQLiteDB {
    public struct Error: Swift.Error, CustomStringConvertible {
        public let message: String
        public var description: String { message }
    }

    public typealias Row = [String: Any?]

    private var handle: OpaquePointer?
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    public init(path: String) throws {
        if sqlite3_open_v2(path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) != SQLITE_OK {
            throw Error(message: "open \(path): \(String(cString: sqlite3_errmsg(handle)))")
        }
        try exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;")
    }

    deinit { sqlite3_close_v2(handle) }

    public func exec(_ sql: String) throws {
        var err: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(handle, sql, nil, nil, &err) != SQLITE_OK {
            let msg = err.map { String(cString: $0) } ?? "unknown"
            sqlite3_free(err)
            throw Error(message: msg)
        }
    }

    /// Runs a statement that returns no rows. Returns number of changed rows.
    @discardableResult
    public func run(_ sql: String, _ params: [Any?] = []) throws -> Int {
        let stmt = try prepare(sql, params)
        defer { sqlite3_finalize(stmt) }
        let rc = sqlite3_step(stmt)
        guard rc == SQLITE_DONE || rc == SQLITE_ROW else { throw lastError() }
        return Int(sqlite3_changes(handle))
    }

    public func query(_ sql: String, _ params: [Any?] = []) throws -> [Row] {
        let stmt = try prepare(sql, params)
        defer { sqlite3_finalize(stmt) }
        var rows: [Row] = []
        while true {
            let rc = sqlite3_step(stmt)
            if rc == SQLITE_DONE { break }
            guard rc == SQLITE_ROW else { throw lastError() }
            var row: Row = [:]
            for i in 0..<sqlite3_column_count(stmt) {
                let name = String(cString: sqlite3_column_name(stmt, i))
                switch sqlite3_column_type(stmt, i) {
                case SQLITE_INTEGER: row[name] = sqlite3_column_int64(stmt, i)
                case SQLITE_FLOAT: row[name] = sqlite3_column_double(stmt, i)
                case SQLITE_TEXT:
                    // Explicit length: text may contain NUL characters.
                    let n = Int(sqlite3_column_bytes(stmt, i))
                    if let p = sqlite3_column_text(stmt, i) {
                        row[name] = String(decoding: UnsafeBufferPointer(start: p, count: n), as: UTF8.self)
                    } else {
                        row[name] = ""
                    }
                case SQLITE_BLOB:
                    let n = Int(sqlite3_column_bytes(stmt, i))
                    row[name] = n > 0 ? Data(bytes: sqlite3_column_blob(stmt, i), count: n) : Data()
                default: row[name] = .some(nil)
                }
            }
            rows.append(row)
        }
        return rows
    }

    public var lastInsertRowID: Int64 { sqlite3_last_insert_rowid(handle) }

    public func transaction<T>(_ body: () throws -> T) throws -> T {
        try exec("BEGIN IMMEDIATE")
        do {
            let r = try body()
            try exec("COMMIT")
            return r
        } catch {
            try? exec("ROLLBACK")
            throw error
        }
    }

    private func prepare(_ sql: String, _ params: [Any?]) throws -> OpaquePointer? {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &stmt, nil) == SQLITE_OK else { throw lastError() }
        for (i, p) in params.enumerated() {
            let idx = Int32(i + 1)
            switch p {
            case nil, is NSNull: sqlite3_bind_null(stmt, idx)
            case let v as String:
                // Explicit byte length so embedded NULs don't truncate the text.
                let bytes = Array(v.utf8)
                if bytes.isEmpty {
                    sqlite3_bind_text(stmt, idx, "", 0, SQLiteDB.transient)
                } else {
                    _ = bytes.withUnsafeBytes {
                        sqlite3_bind_text(stmt, idx, $0.baseAddress!.assumingMemoryBound(to: CChar.self), Int32($0.count), SQLiteDB.transient)
                    }
                }
            case let v as Int: sqlite3_bind_int64(stmt, idx, Int64(v))
            case let v as Int64: sqlite3_bind_int64(stmt, idx, v)
            case let v as Int32: sqlite3_bind_int64(stmt, idx, Int64(v))
            case let v as Double: sqlite3_bind_double(stmt, idx, v)
            case let v as Bool: sqlite3_bind_int64(stmt, idx, v ? 1 : 0)
            case let v as Data:
                _ = v.withUnsafeBytes { sqlite3_bind_blob(stmt, idx, $0.baseAddress, Int32(v.count), SQLiteDB.transient) }
            default:
                sqlite3_finalize(stmt)
                throw Error(message: "unsupported bind type \(type(of: p!))")
            }
        }
        return stmt
    }

    private func lastError() -> Error { Error(message: String(cString: sqlite3_errmsg(handle))) }
}
