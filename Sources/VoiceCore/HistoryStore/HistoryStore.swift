// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import Foundation
import BentoCore

/// Queryable index over the session folders (which remain the source of truth —
/// meta.json per folder). The DB makes History fast to search and stats cheap.
public struct DictationRecord: Codable, Equatable, Identifiable, Sendable {

    public var id: String
    public var folder: String
    public var startedAt: Date
    public var status: String
    public var targetAppName: String?
    public var targetAppBundleID: String?
    public var durationSeconds: Double?
    public var rawTranscript: String?
    public var cleanedTranscript: String?
    public var errorCode: String?
    public var errorMessage: String?
    public var pipelineSeconds: Double?

    public var displayText: String {
        cleanedTranscript ?? rawTranscript ?? ""
    }

    public var folderURL: URL {
        URL(fileURLWithPath: folder, isDirectory: true)
    }

    public init(id: String, folder: String, startedAt: Date, status: String, targetAppName: String?,
                targetAppBundleID: String?, durationSeconds: Double?, rawTranscript: String?,
                cleanedTranscript: String?, errorCode: String?, errorMessage: String?, pipelineSeconds: Double?) {
        self.id = id
        self.folder = folder
        self.startedAt = startedAt
        self.status = status
        self.targetAppName = targetAppName
        self.targetAppBundleID = targetAppBundleID
        self.durationSeconds = durationSeconds
        self.rawTranscript = rawTranscript
        self.cleanedTranscript = cleanedTranscript
        self.errorCode = errorCode
        self.errorMessage = errorMessage
        self.pipelineSeconds = pipelineSeconds
    }

    public init(meta: SessionMeta, folder: URL) {
        self.id = meta.id.uuidString
        self.folder = folder.path
        self.startedAt = meta.startedAt
        self.status = meta.status.rawValue
        self.targetAppName = meta.targetAppName
        self.targetAppBundleID = meta.targetAppBundleID
        self.durationSeconds = meta.audioDurationSeconds
        self.rawTranscript = meta.rawTranscript
        self.cleanedTranscript = meta.cleanedTranscript
        self.errorCode = meta.errorCode
        self.errorMessage = meta.errorMessage
        self.pipelineSeconds = meta.pipelineSeconds
    }
}

public extension Notification.Name {
    /// Posted after any HistoryStore write so an open History pane refreshes as
    /// dictations land, retries drain, or rows are deleted — no polling.
    static let gtHistoryDidChange = Notification.Name("com.charles.bento.voice.history-changed")
}

public final class HistoryStore: @unchecked Sendable {
    /// One connection, used only on this queue.
    private let queue = DispatchQueue(label: "com.charles.bento.voice.history")
    private let db: SQLiteDB

    private static func notifyChanged() {
        NotificationCenter.default.post(name: .gtHistoryDidChange, object: nil)
    }

    public init(databaseURL: URL) throws {
        try FileManager.default.createDirectory(
            at: databaseURL.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        db = try Self.openOrRecreate(at: databaseURL)
        try migrate()
    }

    /// A corrupt index must not disable history/recovery forever — the folders
    /// are the source of truth, so quarantine and rebuild (audit L6).
    /// SQLiteDB opens in WAL + synchronous NORMAL: reindex() rebuilds the index
    /// from the folders, so a per-write fsync would buy nothing.
    private static func openOrRecreate(at databaseURL: URL) throws -> SQLiteDB {
        do {
            let db = try SQLiteDB(path: databaseURL.path)
            // Probe readability so corruption surfaces here, not at first query.
            _ = try db.query("PRAGMA schema_version")
            return db
        } catch {
            Log.history.error("HistoryStore: open failed (\(error)) — quarantining and recreating index")
            let quarantine = databaseURL.deletingPathExtension()
                .appendingPathExtension("corrupt-\(Int(Date().timeIntervalSince1970)).sqlite")
            try? FileManager.default.moveItem(at: databaseURL, to: quarantine)
            for suffix in ["-wal", "-shm"] {
                let sidecar = URL(fileURLWithPath: databaseURL.path + suffix)
                try? FileManager.default.moveItem(at: sidecar, to: URL(fileURLWithPath: quarantine.path + suffix))
            }
            return try SQLiteDB(path: databaseURL.path)
        }
    }

    public static func standard() throws -> HistoryStore {
        try HistoryStore(databaseURL: FileLayout.appSupportRoot.appendingPathComponent("history.sqlite"))
    }

    private func migrate() throws {
        try queue.sync {
            let version = (try db.query("PRAGMA user_version").first?["user_version"] as? Int64) ?? 0
            if version < 1 {
                try db.transaction {
                    try db.exec("""
                        CREATE TABLE IF NOT EXISTS dictation (
                            id TEXT PRIMARY KEY NOT NULL,
                            folder TEXT NOT NULL,
                            startedAt REAL NOT NULL,
                            status TEXT NOT NULL,
                            targetAppName TEXT,
                            targetAppBundleID TEXT,
                            durationSeconds REAL,
                            rawTranscript TEXT,
                            cleanedTranscript TEXT,
                            errorCode TEXT,
                            errorMessage TEXT,
                            pipelineSeconds REAL
                        );
                        CREATE INDEX IF NOT EXISTS dictation_startedAt ON dictation(startedAt);
                        CREATE INDEX IF NOT EXISTS dictation_status ON dictation(status);
                        PRAGMA user_version = 1;
                        """)
                }
            }
        }
    }

    private static let columns = "id, folder, startedAt, status, targetAppName, targetAppBundleID, durationSeconds, rawTranscript, cleanedTranscript, errorCode, errorMessage, pipelineSeconds"

    private static func record(_ row: SQLiteDB.Row) -> DictationRecord? {
        guard let id = row["id"] as? String, let folder = row["folder"] as? String,
              let status = row["status"] as? String else { return nil }
        func double(_ key: String) -> Double? {
            switch row[key] ?? nil {
            case let d as Double: return d
            case let i as Int64: return Double(i)
            default: return nil
            }
        }
        return DictationRecord(
            id: id, folder: folder,
            startedAt: Date(timeIntervalSince1970: double("startedAt") ?? 0),
            status: status,
            targetAppName: row["targetAppName"] as? String,
            targetAppBundleID: row["targetAppBundleID"] as? String,
            durationSeconds: double("durationSeconds"),
            rawTranscript: row["rawTranscript"] as? String,
            cleanedTranscript: row["cleanedTranscript"] as? String,
            errorCode: row["errorCode"] as? String,
            errorMessage: row["errorMessage"] as? String,
            pipelineSeconds: double("pipelineSeconds")
        )
    }

    private func fetch(_ whereSQL: String, _ params: [Any?] = [], order: String = "startedAt DESC", limit: Int? = nil) -> [DictationRecord] {
        let tail = limit.map { " LIMIT \($0)" } ?? ""
        let sql = "SELECT \(Self.columns) FROM dictation WHERE \(whereSQL) ORDER BY \(order)\(tail)"
        return queue.sync {
            do { return try db.query(sql, params).compactMap(Self.record) } catch {
                Log.history.error("HistoryStore: query failed: \(error)")
                return []
            }
        }
    }

    // MARK: - Writes

    public func upsert(meta: SessionMeta, folder: URL) {
        let r = DictationRecord(meta: meta, folder: folder)
        do {
            try queue.sync {
                try db.run("""
                    INSERT OR REPLACE INTO dictation (\(Self.columns)) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, [r.id, r.folder, r.startedAt.timeIntervalSince1970, r.status, r.targetAppName, r.targetAppBundleID,
                          r.durationSeconds, r.rawTranscript, r.cleanedTranscript, r.errorCode, r.errorMessage, r.pipelineSeconds])
            }
            Self.notifyChanged()
        } catch {
            Log.history.error("HistoryStore: upsert failed: \(error)")
        }
    }

    public func delete(id: String, removeFolder: Bool) {
        let record = fetch("id = ?", [id]).first
        do {
            try queue.sync { _ = try db.run("DELETE FROM dictation WHERE id = ?", [id]) }
            if removeFolder, let record {
                try? FileManager.default.removeItem(at: record.folderURL)
            }
            Self.notifyChanged()
        } catch {
            Log.history.error("HistoryStore: delete failed: \(error)")
        }
    }

    public func deleteAll(removeFolders: Bool, sparing activeFolder: URL? = nil) {
        do {
            try queue.sync { _ = try db.run("DELETE FROM dictation") }
            Self.notifyChanged()
        } catch {
            Log.history.error("HistoryStore: deleteAll failed: \(error)")
        }
        if removeFolders {
            // Sweep the DIRECTORY, not the query — the visible-records filter hides
            // cancelled sessions whose audio would otherwise survive (audit #5).
            // The live session's folder is spared (audit L7).
            let folders = (try? FileManager.default.contentsOfDirectory(
                at: FileLayout.recordingsRoot, includingPropertiesForKeys: nil
            )) ?? []
            for folder in folders where folder.hasDirectoryPath {
                if let activeFolder, folder.standardizedFileURL == activeFolder.standardizedFileURL {
                    continue
                }
                try? FileManager.default.removeItem(at: folder)
            }
        }
    }

    /// Rebuild the index from the folders on disk (launch reconciliation).
    /// Folders are the source of truth: rows whose folders vanished (external
    /// cleanup, Finder deletion) are pruned, never shown as ghosts.
    public func reindex(recordingsRoot: URL = FileLayout.recordingsRoot) {
        let folders = (try? FileManager.default.contentsOfDirectory(
            at: recordingsRoot, includingPropertiesForKeys: nil
        )) ?? []
        for folder in folders where folder.hasDirectoryPath {
            if let meta = SessionMeta.read(from: folder) {
                upsert(meta: meta, folder: folder)
            }
        }
        // Prune orphaned rows — from the UNFILTERED table. records() hides
        // silent/short-cancelled rows, and exactly those would otherwise linger
        // forever as invisible ghosts after external folder cleanup.
        let orphans = fetch("1", order: "startedAt").filter {
            !FileManager.default.fileExists(atPath: $0.folder)
        }
        for orphan in orphans {
            delete(id: orphan.id, removeFolder: false)
        }
        if !orphans.isEmpty {
            Log.history.info("reindex pruned \(orphans.count) orphaned row(s)")
        }
    }

    // MARK: - Reads

    public func records(matching query: String? = nil, limit: Int = 500) -> [DictationRecord] {
        // History is a library of words + things needing attention — never an
        // event log. Visible: anything with a transcript; retryable failures and
        // offline-queued items; long cancelled recordings (recoverable). Silent
        // rows and short cancels are discarded at the source and filtered here
        // for legacy data. In-flight statuses (recording/recorded/transcribing)
        // are NOT visible: the live session would surface in the attention shelf
        // with Retry/Discard controls that double-upload or destroy it mid-flight
        // (production pass 2); crash recovery reads them via interruptedRecords()
        // and normalizes every one at launch.
        let visible = """
            (rawTranscript IS NOT NULL OR cleanedTranscript IS NOT NULL
             OR status IN ('failed','queuedForRetry')
             OR (status = 'cancelled' AND durationSeconds >= 10))
            AND status != 'silent'
            """
        if let query, !query.trimmingCharacters(in: .whitespaces).isEmpty {
            // Escape LIKE wildcards so "100%" finds "100%" (audit L28).
            let escaped = query
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "%", with: "\\%")
                .replacingOccurrences(of: "_", with: "\\_")
            let pattern = "%\(escaped)%"
            return fetch("(rawTranscript LIKE ? ESCAPE '\\' OR cleanedTranscript LIKE ? ESCAPE '\\' OR targetAppName LIKE ? ESCAPE '\\') AND \(visible)",
                         [pattern, pattern, pattern], limit: limit)
        }
        return fetch(visible, limit: limit)
    }

    /// Every row id, visibility filter bypassed — test-only observability.
    func allIDsForTesting() -> [String] {
        fetch("1", order: "startedAt").map(\.id)
    }

    /// Sessions the RetryQueue should drain: offline-queued plus transient failures.
    public func retryableRecords() -> [DictationRecord] {
        fetch("status = ? OR (status = ? AND errorCode IN (?, ?, ?))",
              [SessionMeta.Status.queuedForRetry.rawValue, SessionMeta.Status.failed.rawValue,
               "network", "timeout", "rate_limit"], order: "startedAt ASC")
    }

    /// Non-terminal sessions found at launch = the app died mid-flight.
    public func interruptedRecords() -> [DictationRecord] {
        fetch("status IN (?, ?, ?)",
              [SessionMeta.Status.recording.rawValue, SessionMeta.Status.recorded.rawValue,
               SessionMeta.Status.transcribing.rawValue])
    }

    public struct Stats: Equatable, Sendable {
        public var totalWords: Int
        public var totalDictations: Int
        public var averageWPM: Int

        public init(totalWords: Int, totalDictations: Int, averageWPM: Int) {
            self.totalWords = totalWords
            self.totalDictations = totalDictations
            self.averageWPM = averageWPM
        }
    }

    public func stats() -> Stats {
        let rows: [SQLiteDB.Row] = queue.sync {
            (try? db.query("SELECT cleanedTranscript, durationSeconds FROM dictation WHERE cleanedTranscript IS NOT NULL")) ?? []
        }
        var words = 0
        var timedWords = 0
        var speech = 0.0
        for row in rows {
            let text = row["cleanedTranscript"] as? String ?? ""
            // Whitespace-aware split (newlines count too — audit L29).
            let count = text.split(whereSeparator: \.isWhitespace).count
            words += count
            let duration = (row["durationSeconds"] as? Double) ?? (row["durationSeconds"] as? Int64).map(Double.init)
            if let duration, duration > 0 {
                timedWords += count
                speech += duration
            }
        }
        // WPM only over rows that actually have a duration.
        let wpm = speech > 10 ? Int(Double(timedWords) / (speech / 60)) : 0
        return Stats(totalWords: words, totalDictations: rows.count, averageWPM: wpm)
    }
}
