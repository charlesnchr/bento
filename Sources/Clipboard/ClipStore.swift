import Foundation
import BentoCore

/// SQLite-backed clipboard history. Full images and thumbnails live as files
/// next to the database; rows only reference them. Main thread only (all
/// queries are small and indexed; heavy image work happens before `upsert`).
final class ClipStore {
    static let didChange = Notification.Name("BentoClipboardStoreDidChange")

    let directory: URL
    let imagesDir: URL
    let thumbsDir: URL
    private let db: SQLiteDB
    private let log = BentoLog.make("clipboard")

    init(directory: URL) throws {
        self.directory = directory
        imagesDir = directory.appendingPathComponent("images", isDirectory: true)
        thumbsDir = directory.appendingPathComponent("thumbs", isDirectory: true)
        for d in [directory, imagesDir, thumbsDir] {
            try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        }
        db = try SQLiteDB(path: directory.appendingPathComponent("history.sqlite").path)
        try db.exec("""
        CREATE TABLE IF NOT EXISTS items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            hash TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            text TEXT,
            rtf BLOB,
            html BLOB,
            extras BLOB,
            link_title TEXT,
            image_file TEXT,
            thumb_file TEXT,
            image_type TEXT,
            width INTEGER NOT NULL DEFAULT 0,
            height INTEGER NOT NULL DEFAULT 0,
            byte_size INTEGER NOT NULL DEFAULT 0,
            ocr_text TEXT,
            ocr_done INTEGER NOT NULL DEFAULT 0,
            source_app TEXT,
            source_bundle TEXT,
            first_copied REAL NOT NULL,
            last_copied REAL NOT NULL,
            copy_count INTEGER NOT NULL DEFAULT 1,
            pinned INTEGER NOT NULL DEFAULT 0,
            pinned_at REAL
        );
        CREATE INDEX IF NOT EXISTS items_order ON items(pinned, last_copied);
        CREATE INDEX IF NOT EXISTS items_ocr ON items(kind, ocr_done);
        """)
    }

    func imageURL(_ name: String?) -> URL? { name.map { imagesDir.appendingPathComponent($0) } }
    func thumbURL(_ name: String?) -> URL? { name.map { thumbsDir.appendingPathComponent($0) } }

    private func notify() {
        NotificationCenter.default.post(name: ClipStore.didChange, object: self)
    }

    // MARK: Writing

    /// Inserts a capture, or — when the same content already exists — moves
    /// that entry to the top and bumps its copy count. Returns the entry id.
    @discardableResult
    func upsert(_ d: ClipDraft, now: Date = Date()) throws -> (id: Int64, inserted: Bool) {
        let t = now.timeIntervalSince1970
        if let row = try db.query("SELECT id, image_file, thumb_file FROM items WHERE hash = ?", [d.hash]).first,
           let id = row["id"] as? Int64 {
            try db.run("""
                UPDATE items SET last_copied = ?, copy_count = copy_count + 1,
                    source_app = COALESCE(?, source_app), source_bundle = COALESCE(?, source_bundle),
                    rtf = COALESCE(?, rtf), html = COALESCE(?, html), extras = COALESCE(?, extras),
                    link_title = COALESCE(?, link_title)
                WHERE id = ?
                """, [t, d.sourceApp, d.sourceBundleID, d.rtf, d.html, d.extras, d.linkTitle, id])
            // A duplicate image was written to disk before we knew; drop it.
            if let f = d.imageFile, f != row["image_file"] as? String { removeFile(imageURL(f)) }
            if let f = d.thumbFile, f != row["thumb_file"] as? String { removeFile(thumbURL(f)) }
            notify()
            return (id, false)
        }
        try db.run("""
            INSERT INTO items (kind, hash, title, text, rtf, html, extras, link_title, image_file, thumb_file, image_type,
                               width, height, byte_size, source_app, source_bundle, first_copied, last_copied, ocr_done)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, [d.kind.rawValue, d.hash, Self.title(for: d), d.text, d.rtf, d.html, d.extras, d.linkTitle,
                  d.imageFile, d.thumbFile, d.imageType, d.width, d.height, d.byteSize,
                  d.sourceApp, d.sourceBundleID, t, t, d.kind == .image ? 0 : 1])
        let id = db.lastInsertRowID
        notify()
        return (id, true)
    }

    /// True if an entry with this content hash exists (then `touch(hash:)`).
    func id(forHash hash: String) -> Int64? {
        (try? db.query("SELECT id FROM items WHERE hash = ?", [hash]).first?["id"]) as? Int64
    }

    /// Marks an entry as just used (pasting from history moves it to the top).
    func touch(_ id: Int64, now: Date = Date()) {
        _ = try? db.run("UPDATE items SET last_copied = ? WHERE id = ?", [now.timeIntervalSince1970, id])
        notify()
    }

    func setPinned(_ id: Int64, _ pinned: Bool, now: Date = Date()) {
        _ = try? db.run("UPDATE items SET pinned = ?, pinned_at = ? WHERE id = ?",
                        [pinned, pinned ? now.timeIntervalSince1970 : nil, id])
        notify()
    }

    func setOCR(_ id: Int64, text: String?) {
        let t = text?.trimmingCharacters(in: .whitespacesAndNewlines)
        _ = try? db.run("UPDATE items SET ocr_text = ?, ocr_done = 1 WHERE id = ?", [t?.isEmpty == false ? t : nil, id])
    }

    func delete(_ id: Int64) {
        delete(ids: [id])
        notify()
    }

    /// Deletes everything (optionally keeping pinned entries).
    func clear(includePinned: Bool) {
        let rows = (try? db.query("SELECT id FROM items" + (includePinned ? "" : " WHERE pinned = 0"))) ?? []
        delete(ids: rows.compactMap { $0["id"] as? Int64 })
        notify()
    }

    private func delete(ids: [Int64]) {
        guard !ids.isEmpty else { return }
        var files: [URL] = []
        do {
            try db.transaction {
                for chunk in stride(from: 0, to: ids.count, by: 500).map({ Array(ids[$0..<min($0 + 500, ids.count)]) }) {
                    let marks = Array(repeating: "?", count: chunk.count).joined(separator: ",")
                    for r in try db.query("SELECT image_file, thumb_file FROM items WHERE id IN (\(marks))", chunk) {
                        if let u = imageURL(r["image_file"] as? String) { files.append(u) }
                        if let u = thumbURL(r["thumb_file"] as? String) { files.append(u) }
                    }
                    try db.run("DELETE FROM items WHERE id IN (\(marks))", chunk)
                }
            }
        } catch {
            log.error("delete failed: \(String(describing: error), privacy: .public)")
            return
        }
        files.forEach(removeFile)
    }

    private func removeFile(_ url: URL?) {
        guard let url else { return }
        try? FileManager.default.removeItem(at: url)
    }

    // MARK: Retention

    /// Applies retention, item-count and size limits to unpinned entries.
    /// Returns the number of deleted entries.
    @discardableResult
    func prune(retentionDays: Int, maxItems: Int, maxBytes: Int, now: Date = Date()) -> Int {
        var victims = Set<Int64>()
        if retentionDays > 0 {
            let cutoff = now.timeIntervalSince1970 - Double(retentionDays) * 86_400
            for r in (try? db.query("SELECT id FROM items WHERE pinned = 0 AND last_copied < ?", [cutoff])) ?? [] {
                if let id = r["id"] as? Int64 { victims.insert(id) }
            }
        }
        if maxItems > 0 || maxBytes > 0 {
            let rows = (try? db.query("SELECT id, byte_size FROM items WHERE pinned = 0 ORDER BY last_copied DESC")) ?? []
            var bytes = 0
            for (i, r) in rows.enumerated() {
                guard let id = r["id"] as? Int64 else { continue }
                bytes += Int(r["byte_size"] as? Int64 ?? 0)
                if (maxItems > 0 && i >= maxItems) || (maxBytes > 0 && bytes > maxBytes) { victims.insert(id) }
            }
        }
        guard !victims.isEmpty else { return 0 }
        delete(ids: Array(victims))
        log.info("pruned \(victims.count) clipboard items")
        notify()
        return victims.count
    }

    /// Deletes image/thumbnail files that no entry references (after a crash
    /// between writing the file and inserting the row).
    func removeOrphanFiles() {
        let rows = (try? db.query("SELECT image_file, thumb_file FROM items WHERE image_file IS NOT NULL OR thumb_file IS NOT NULL")) ?? []
        var keep = Set<String>()
        for r in rows {
            if let f = r["image_file"] as? String { keep.insert(f) }
            if let f = r["thumb_file"] as? String { keep.insert(f) }
        }
        let fm = FileManager.default
        for dir in [imagesDir, thumbsDir] {
            for name in (try? fm.contentsOfDirectory(atPath: dir.path)) ?? [] where !keep.contains(name) {
                try? fm.removeItem(at: dir.appendingPathComponent(name))
            }
        }
    }

    // MARK: Reading

    private static let rowColumns = """
        id, kind, title, substr(text, 1, 600) AS snippet, source_app, source_bundle, last_copied, pinned,
        thumb_file, width, height, (rtf IS NOT NULL OR html IS NOT NULL) AS rich
        """

    /// Rows for the panel: pinned first (in pin order), then most recent.
    /// Every whitespace-separated search term must match the text, file
    /// paths, link title, recognised image text or source app.
    func rows(filter: ClipFilter = .all, query: String = "", limit: Int = 200, offset: Int = 0) -> [ClipRow] {
        var clauses: [String] = []
        var params: [Any?] = []
        if let k = filter.kind {
            clauses.append("kind = ?")
            params.append(k.rawValue)
        }
        for term in Self.searchTerms(query) {
            clauses.append("""
                (title LIKE ?1 ESCAPE '\\' OR text LIKE ?1 ESCAPE '\\' OR ocr_text LIKE ?1 ESCAPE '\\'
                 OR link_title LIKE ?1 ESCAPE '\\' OR source_app LIKE ?1 ESCAPE '\\')
                """.replacingOccurrences(of: "?1", with: "?\(params.count + 1)"))
            params.append("%" + Self.escapeLike(term) + "%")
        }
        let whereSQL = clauses.isEmpty ? "" : "WHERE " + clauses.joined(separator: " AND ")
        let sql = """
            SELECT \(Self.rowColumns) FROM items \(whereSQL)
            ORDER BY pinned DESC, CASE WHEN pinned = 1 THEN pinned_at END ASC, last_copied DESC
            LIMIT \(limit) OFFSET \(offset)
            """
        do {
            return try db.query(sql, params).compactMap(Self.row)
        } catch {
            log.error("query failed: \(String(describing: error), privacy: .public)")
            return []
        }
    }

    /// The n-th most recently copied entry regardless of pinning (0 = latest).
    func latest(offset: Int) -> ClipRow? {
        let r = try? db.query("SELECT \(Self.rowColumns) FROM items ORDER BY last_copied DESC LIMIT 1 OFFSET ?", [offset])
        return r?.first.flatMap(Self.row)
    }

    func detail(_ id: Int64) -> ClipDetail? {
        guard let r = (try? db.query("SELECT \(Self.rowColumns), text, rtf, html, extras, link_title, image_file, image_type, byte_size, ocr_text, ocr_done, first_copied, copy_count FROM items WHERE id = ?", [id]))?.first,
              let row = Self.row(r) else { return nil }
        return ClipDetail(
            row: row,
            text: r["text"] as? String,
            rtf: r["rtf"] as? Data,
            html: r["html"] as? Data,
            extras: r["extras"] as? Data,
            linkTitle: r["link_title"] as? String,
            imageFile: r["image_file"] as? String,
            imageType: r["image_type"] as? String,
            byteSize: Int(r["byte_size"] as? Int64 ?? 0),
            ocrText: r["ocr_text"] as? String,
            ocrDone: (r["ocr_done"] as? Int64 ?? 0) != 0,
            firstCopied: Date(timeIntervalSince1970: r["first_copied"] as? Double ?? 0),
            copyCount: Int(r["copy_count"] as? Int64 ?? 1))
    }

    /// Next image that still needs text recognition (newest first).
    func nextPendingOCR() -> (id: Int64, file: String)? {
        guard let r = (try? db.query("SELECT id, image_file FROM items WHERE kind = 'image' AND ocr_done = 0 ORDER BY last_copied DESC LIMIT 1"))?.first,
              let id = r["id"] as? Int64 else { return nil }
        guard let f = r["image_file"] as? String else { setOCR(id, text: nil); return nextPendingOCR() }
        return (id, f)
    }

    func stats() -> (count: Int, bytes: Int, pinned: Int) {
        let r = (try? db.query("SELECT COUNT(*) AS n, COALESCE(SUM(byte_size), 0) AS b, COALESCE(SUM(pinned), 0) AS p FROM items"))?.first
        return (Int(r?["n"] as? Int64 ?? 0), Int(r?["b"] as? Int64 ?? 0), Int(r?["p"] as? Int64 ?? 0))
    }

    // MARK: Helpers

    static func searchTerms(_ q: String) -> [String] {
        q.split(whereSeparator: \.isWhitespace).map(String.init).filter { !$0.isEmpty }.prefix(8).map { $0 }
    }

    static func escapeLike(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "%", with: "\\%")
            .replacingOccurrences(of: "_", with: "\\_")
    }

    private static func row(_ r: SQLiteDB.Row) -> ClipRow? {
        guard let id = r["id"] as? Int64, let kind = (r["kind"] as? String).flatMap(ClipKind.init) else { return nil }
        return ClipRow(
            id: id, kind: kind,
            title: r["title"] as? String ?? "",
            snippet: r["snippet"] as? String ?? "",
            sourceApp: r["source_app"] as? String,
            sourceBundleID: r["source_bundle"] as? String,
            lastCopied: Date(timeIntervalSince1970: r["last_copied"] as? Double ?? 0),
            pinned: (r["pinned"] as? Int64 ?? 0) != 0,
            thumbFile: r["thumb_file"] as? String,
            width: Int(r["width"] as? Int64 ?? 0),
            height: Int(r["height"] as? Int64 ?? 0),
            isRich: (r["rich"] as? Int64 ?? 0) != 0)
    }

    /// Display title stored with the row.
    static func title(for d: ClipDraft) -> String {
        switch d.kind {
        case .image:
            return d.width > 0 ? "Image (\(d.width)×\(d.height))" : "Image"
        case .file:
            let names = (d.text ?? "").split(separator: "\n").map { ($0 as NSString).lastPathComponent }
            if names.count <= 1 { return names.first ?? "File" }
            return "\(names.count) Files: " + names.prefix(4).joined(separator: ", ")
        case .link:
            if let t = d.linkTitle, !t.isEmpty { return String(t.prefix(200)) }
            return ContentDetection.title(forText: d.text ?? "")
        case .text, .color:
            return ContentDetection.title(forText: d.text ?? "")
        }
    }
}
