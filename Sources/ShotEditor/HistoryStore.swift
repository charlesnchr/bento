import AppKit
import BentoCore

/// Capture history on disk: one folder per capture under
/// `~/Library/Application Support/Bento/Captures/<id>/` holding
/// `original.png` (untouched pixels), `document.json` (annotations, crop) and
/// `thumbnail.jpg` (flattened preview). Folder names sort chronologically.
final class HistoryStore {
    static let shared = HistoryStore(root: AppPaths.support("Captures"))

    struct Entry: Equatable {
        let id: String
        let dir: URL
        var doc: ShotDocument
        var imageURL: URL { dir.appendingPathComponent(HistoryStore.imageName) }
        var docURL: URL { dir.appendingPathComponent(HistoryStore.docName) }
        var thumbURL: URL { dir.appendingPathComponent(HistoryStore.thumbName) }
    }

    static let imageName = "original.png"
    static let docName = "document.json"
    static let thumbName = "thumbnail.jpg"

    let root: URL
    /// Serial queue for image / thumbnail writes; reads of an image wait for it.
    private let io = DispatchQueue(label: "bento.shoteditor.history", qos: .utility)
    private let log = BentoLog.make("shoteditor")

    init(root: URL) {
        self.root = root
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    // MARK: Create

    static func makeID(date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyyMMdd-HHmmss"
        let letters = "abcdefghijklmnopqrstuvwxyz"
        let suffix = String((0..<4).map { _ in letters.randomElement()! })
        return "\(f.string(from: date))-\(suffix)"
    }

    /// Stores a new capture. The document is written immediately; the PNG is
    /// written synchronously or on the IO queue (`async`), so the editor can
    /// show the image without waiting for PNG encoding.
    @discardableResult
    func add(image: CGImage, scale: CGFloat, date: Date, kind: String, rect: CGRect,
             appName: String?, bundleID: String?, async: Bool) -> Entry {
        let id = HistoryStore.makeID(date: date)
        let dir = root.appendingPathComponent(id, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let doc = ShotDocument(id: id, created: date, modified: date, kind: kind, scale: scale,
                               pixelWidth: image.width, pixelHeight: image.height,
                               sourceAppName: appName, sourceBundleID: bundleID, captureRect: rect)
        let entry = Entry(id: id, dir: dir, doc: doc)
        writeDocument(doc, to: entry)
        let write = { [log] in
            do {
                try ImageCodec.write(image, scale: scale, format: .png, to: entry.imageURL)
                if let thumb = ImageCodec.thumbnail(image) { try thumb.write(to: entry.thumbURL, options: .atomic) }
            } catch {
                log.error("History write failed: \(String(describing: error), privacy: .public)")
            }
        }
        if async { io.async(execute: write) } else { io.sync(execute: write) }
        return entry
    }

    // MARK: Update

    func writeDocument(_ doc: ShotDocument, to entry: Entry) {
        do {
            try doc.encoded().write(to: entry.docURL, options: .atomic)
        } catch {
            log.error("Document write failed: \(String(describing: error), privacy: .public)")
        }
    }

    /// Saves the document and refreshes the thumbnail from the flattened image.
    func update(_ doc: ShotDocument, flattened: CGImage?) {
        let entry = Entry(id: doc.id, dir: root.appendingPathComponent(doc.id, isDirectory: true), doc: doc)
        guard FileManager.default.fileExists(atPath: entry.dir.path) else { return }
        writeDocument(doc, to: entry)
        guard let flattened else { return }
        io.async {
            if let thumb = ImageCodec.thumbnail(flattened) { try? thumb.write(to: entry.thumbURL, options: .atomic) }
        }
    }

    // MARK: Read

    /// All entries, newest first.
    func entries() -> [Entry] {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: root.path) else { return [] }
        var out: [Entry] = []
        for name in names where !name.hasPrefix(".") {
            let dir = root.appendingPathComponent(name, isDirectory: true)
            guard let data = try? Data(contentsOf: dir.appendingPathComponent(HistoryStore.docName)),
                  let doc = try? ShotDocument.decode(data) else { continue }
            out.append(Entry(id: name, dir: dir, doc: doc))
        }
        return out.sorted { ($0.doc.created, $0.id) > ($1.doc.created, $1.id) }
    }

    func entry(id: String) -> Entry? {
        let dir = root.appendingPathComponent(id, isDirectory: true)
        guard let data = try? Data(contentsOf: dir.appendingPathComponent(HistoryStore.docName)),
              let doc = try? ShotDocument.decode(data) else { return nil }
        return Entry(id: id, dir: dir, doc: doc)
    }

    /// The entry an image file belongs to, if it is a history original.
    func entry(forImageAt url: URL) -> Entry? {
        let dir = url.deletingLastPathComponent().standardizedFileURL
        guard url.lastPathComponent == HistoryStore.imageName,
              dir.deletingLastPathComponent().standardizedFileURL.path == root.standardizedFileURL.path else { return nil }
        return entry(id: dir.lastPathComponent)
    }

    func loadImage(_ entry: Entry) -> CGImage? {
        io.sync {} // wait for a pending write of this capture
        return ImageCodec.load(entry.imageURL)?.0
    }

    /// Runs `block` on the main queue once pending writes have finished.
    func whenWritten(_ block: @escaping () -> Void) {
        io.async { DispatchQueue.main.async(execute: block) }
    }

    // MARK: Delete / prune

    /// Moves a capture to the Trash (falls back to deleting).
    func trash(_ id: String) {
        io.sync {}
        let dir = root.appendingPathComponent(id, isDirectory: true)
        do {
            try FileManager.default.trashItem(at: dir, resultingItemURL: nil)
        } catch {
            try? FileManager.default.removeItem(at: dir)
        }
    }

    func delete(_ id: String) {
        io.sync {}
        try? FileManager.default.removeItem(at: root.appendingPathComponent(id, isDirectory: true))
    }

    /// Removes captures older than `days` (0 = keep all). Returns removed ids.
    @discardableResult
    func prune(retentionDays days: Int, now: Date = Date(), keeping: Set<String> = []) -> [String] {
        guard days > 0 else { return [] }
        let cutoff = now.addingTimeInterval(-Double(days) * 86_400)
        var removed: [String] = []
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: root.path) else { return [] }
        for name in names where !name.hasPrefix(".") && !keeping.contains(name) {
            let dir = root.appendingPathComponent(name, isDirectory: true)
            let created: Date? = {
                if let data = try? Data(contentsOf: dir.appendingPathComponent(HistoryStore.docName)),
                   let doc = try? ShotDocument.decode(data) { return doc.modified > doc.created ? doc.modified : doc.created }
                return (try? fm.attributesOfItem(atPath: dir.path))?[.modificationDate] as? Date
            }()
            if let created, created < cutoff {
                try? fm.removeItem(at: dir)
                removed.append(name)
            }
        }
        if !removed.isEmpty { log.info("Pruned \(removed.count) old captures") }
        return removed
    }

    func sizeDescription() -> String {
        let fm = FileManager.default
        var total: Int64 = 0
        var count = 0
        if let e = fm.enumerator(at: root, includingPropertiesForKeys: [.fileSizeKey]) {
            for case let url as URL in e {
                if url.lastPathComponent == HistoryStore.docName { count += 1 }
                total += Int64((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
            }
        }
        return "\(count) captures, \(ByteCountFormatter.string(fromByteCount: total, countStyle: .file))"
    }
}
