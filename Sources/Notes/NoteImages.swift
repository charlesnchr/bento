import AppKit
import CryptoKit
import ImageIO
import UniformTypeIdentifiers
import BentoCore

/// Images in notes (docs/SYNC_PROTOCOL.md, Images): a line `![alt](bento-image:<sha256>)`
/// refers to a blob stored by the SHA-256 of its bytes, kept in a local cache and on the
/// sync server.
enum NoteImage {
    static let scheme = "bento-image:"
    /// Largest blob the server takes (server/src/store.rs).
    static let maxBytes = 10 * 1024 * 1024
    /// Longest side of an image that gets re-encoded.
    static let maxPixels = 4096

    private static let lineRE = try! NSRegularExpression(pattern: #"^[ \t]*!\[[^\]\n]*\]\(bento-image:([0-9a-f]{64})\)[ \t]*$"#)

    /// UTF-16 length of the shortest image line, `![](bento-image:<64 hex>)`.
    static let minLineLength = 81

    /// The hash of the image when the line (without its newline) is nothing but one image.
    static func hash(inLine line: String) -> String? {
        guard line.utf16.count >= minLineLength, line.contains(scheme) else { return nil }
        let ns = line as NSString
        guard let m = lineRE.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return ns.substring(with: m.range(at: 1))
    }

    static func markdown(_ hash: String) -> String { "![](\(scheme)\(hash))" }

    /// Hashes of the image lines in a body (not in code blocks), in order, without repeats.
    static func hashes(in body: String) -> [String] {
        guard body.contains(scheme) else { return [] }
        var seen = Set<String>(), out: [String] = [], inCode = false
        body.enumerateLines { line, _ in
            let kind = MarkdownParser.parseLine(line, inCode: inCode).kind
            if case .fence(let opening, _) = kind { inCode = opening }
            if kind == .paragraph, let h = hash(inLine: line), seen.insert(h).inserted { out.append(h) }
        }
        return out
    }

    /// Whether any line of the body is an image (code blocks included: for keeping text).
    static func hasImageLine(_ body: String) -> Bool {
        guard body.contains(scheme) else { return false }
        var found = false
        body.enumerateLines { line, stop in if hash(inLine: line) != nil { found = true; stop = true } }
        return found
    }

    /// Inserts images at the selection (replacing it), each on a line of its own, with the
    /// caret on the line after them.
    static func insertion(_ text: NSString, selection sel: NSRange, hashes: [String]) -> EditResult {
        let leading = sel.location > 0 && text.character(at: sel.location - 1) != 10
        let rep = (leading ? "\n" : "") + hashes.map(markdown).joined(separator: "\n") + "\n"
        return EditResult(edits: [TextEdit(range: sel, replacement: rep)], selection: NSRange(location: sel.location + (rep as NSString).length, length: 0))
    }

    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// The image format of `data` the server accepts, from its first bytes.
    static func mimeType(_ data: Data) -> String? {
        let b = [UInt8](data.prefix(12))
        func at(_ i: Int, _ s: String) -> Bool { b.count >= i + s.utf8.count && Array(b[i..<(i + s.utf8.count)]) == Array(s.utf8) }
        if b.starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) { return "image/png" }
        if b.starts(with: [0xFF, 0xD8, 0xFF]) { return "image/jpeg" }
        if at(0, "GIF87a") || at(0, "GIF89a") { return "image/gif" }
        if at(0, "RIFF"), at(8, "WEBP") { return "image/webp" }
        if at(4, "ftyp") {
            if at(8, "heic") || at(8, "heix") || at(8, "heim") || at(8, "heis") { return "image/heic" }
            if at(8, "mif1") || at(8, "msf1") { return "image/heif" }
        }
        return nil
    }

    /// Bytes to store for a pasted or dropped image: kept as they are when the server takes
    /// them (PNG, JPEG, GIF, WebP, HEIC up to 10 MB and 4096 px), otherwise re-encoded (PNG
    /// when it has transparency, else JPEG) and scaled down. nil when it isn't an image.
    static func prepare(_ data: Data) -> Data? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(src) > 0 else { return nil }
        let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]
        let w = props?[kCGImagePropertyPixelWidth] as? Int ?? 0, h = props?[kCGImagePropertyPixelHeight] as? Int ?? 0
        if mimeType(data) != nil, data.count <= maxBytes, max(w, h) <= maxPixels { return data }
        for side in [maxPixels, 2048, 1024] {
            let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                         kCGImageSourceThumbnailMaxPixelSize: min(side, max(w, h, 1))]
            guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
            let alpha: Bool = {
                switch img.alphaInfo { case .none, .noneSkipFirst, .noneSkipLast: return false; default: return true }
            }()
            let out = NSMutableData()
            let type = (alpha ? UTType.png : UTType.jpeg).identifier as CFString
            guard let dest = CGImageDestinationCreateWithData(out, type, 1, nil) else { return nil }
            CGImageDestinationAddImage(dest, img, (alpha ? [:] : [kCGImageDestinationLossyCompressionQuality: 0.85]) as CFDictionary)
            guard CGImageDestinationFinalize(dest) else { return nil }
            if out.length <= maxBytes { return out as Data }
        }
        return nil
    }
}

/// An image pasted, dropped or chosen: a file, or the bytes themselves.
enum ImageSource {
    case file(URL)
    case bytes(Data)

    /// Reads a file's bytes (slow: off the main thread).
    var data: Data? {
        switch self {
        case .file(let url): return try? Data(contentsOf: url)
        case .bytes(let d): return d
        }
    }
}

/// The images of notes on this Mac: `<support>/Notes/Images/<hash>`, with an empty
/// `Images/upload/<hash>` while the server doesn't have it yet. Files only, so any thread;
/// `store` posts on the main thread.
final class NoteImageStore {
    /// Posted when an image becomes available (fetched from the server); object: the hash.
    static let didLoad = Notification.Name("BentoNoteImageDidLoad")

    let dir: URL?
    private var uploadDir: URL? { dir?.appendingPathComponent("upload", isDirectory: true) }
    private let cache = NSCache<NSString, NSImage>()
    private let fm = FileManager.default

    init(dir: URL? = AppPaths.support("Notes").appendingPathComponent("Images", isDirectory: true)) {
        self.dir = dir
        if let u = dir?.appendingPathComponent("upload", isDirectory: true) { try? fm.createDirectory(at: u, withIntermediateDirectories: true) }
        cache.totalCostLimit = 256 * 1024 * 1024
    }

    private func file(_ hash: String) -> URL? { dir?.appendingPathComponent(hash) }

    func has(_ hash: String) -> Bool { file(hash).map { fm.fileExists(atPath: $0.path) } ?? false }

    func data(_ hash: String) -> Data? { file(hash).flatMap { try? Data(contentsOf: $0) } }

    func image(_ hash: String) -> NSImage? {
        if let i = cache.object(forKey: hash as NSString) { return i }
        guard let d = data(hash), let i = NSImage(data: d) else { return nil }
        // what it takes once drawn: the decoded bitmap
        let px = i.representations.map { $0.pixelsWide * $0.pixelsHigh }.max() ?? 0
        cache.setObject(i, forKey: hash as NSString, cost: max(d.count, px * 4))
        return i
    }

    /// Size in points (a Retina screenshot shows at its point size).
    func size(_ hash: String) -> NSSize? { image(hash)?.size }

    /// Adds an image made here (converting and hashing it: slow, call it off the main
    /// thread); returns its hash. It's uploaded on the next chance.
    func add(_ raw: Data) -> String? {
        guard let data = NoteImage.prepare(raw) else { return nil }
        let hash = NoteImage.sha256(data)
        guard let f = file(hash) else { return nil }
        if !has(hash) {
            do { try data.write(to: f, options: .atomic) } catch { return nil }
        }
        if let u = uploadDir?.appendingPathComponent(hash) { fm.createFile(atPath: u.path, contents: nil) }
        return hash
    }

    /// Stores an image fetched from the server (checked against its hash).
    @discardableResult
    func store(_ data: Data, hash: String) -> Bool {
        guard NoteImage.sha256(data) == hash, let f = file(hash), (try? data.write(to: f, options: .atomic)) != nil else { return false }
        NotificationCenter.default.post(name: NoteImageStore.didLoad, object: hash)
        return true
    }

    /// Images still to upload.
    var pendingUploads: [String] {
        guard let u = uploadDir, let names = try? fm.contentsOfDirectory(atPath: u.path) else { return [] }
        return names.filter { $0.count == 64 && has($0) }
    }

    /// Every image here.
    var allHashes: [String] {
        guard let dir, let names = try? fm.contentsOfDirectory(atPath: dir.path) else { return [] }
        return names.filter { $0.count == 64 && $0.allSatisfy { $0.isHexDigit && !$0.isUppercase } }.sorted()
    }

    /// An image here is to be uploaded (again).
    func markPending(_ hash: String) {
        guard has(hash), let u = uploadDir?.appendingPathComponent(hash) else { return }
        fm.createFile(atPath: u.path, contents: nil)
    }

    /// Every image here is to be uploaded again (the server lost what it had: a restore or a new server).
    func markAllPending() { allHashes.forEach(markPending) }

    func uploaded(_ hash: String) {
        if let u = uploadDir?.appendingPathComponent(hash) { try? fm.removeItem(at: u) }
    }
}

/// Moves images between the store and the sync server: uploads the pending ones and
/// fetches the ones notes show that aren't here. Main thread only.
final class NoteImageSync {
    let store: NoteImageStore
    /// The server and token while sync runs; nil otherwise.
    var endpoint: () -> (base: URL, token: String)? = { nil }
    private let session: URLSession
    private let log = BentoLog.make("notes.images")
    private var uploading = Set<String>()
    private var fetching = Set<String>()
    /// Images the server didn't have, and when we last asked (asked again after a while).
    private var missing: [String: Date] = [:]
    private var serverHasBlobs: (base: URL, ok: Bool)?
    /// Uploads that failed are tried again after this long (doubling to 10 minutes).
    private var retryDelay: TimeInterval = 30
    private var retryWork: DispatchWorkItem?

    init(store: NoteImageStore) {
        self.store = store
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 30
        c.httpAdditionalHeaders = ["User-Agent": "Bento-Notes/1"]
        session = URLSession(configuration: c, delegate: nil, delegateQueue: .main)
    }

    /// Sync (re)connected: upload what's pending and ask again for what was missing.
    /// Asks the server which of our images it lacks (it may have been restored from a backup
    /// without them), uploads those and the pending ones, and asks again for what was missing.
    func connected() {
        let wasMissing = Array(missing.keys)
        missing.removeAll()
        serverHasBlobs = nil
        retryDelay = 30
        reconcile { [weak self] in self?.uploadPending() }
        // placeholders on screen ask again (drawing them fetches)
        for h in wasMissing { NotificationCenter.default.post(name: NoteImageStore.didLoad, object: h) }
    }

    /// Marks pending every image here the server doesn't have (`POST /v1/blobs/missing`, in
    /// batches), then calls `done`.
    func reconcile(done: @escaping () -> Void) {
        guard let ep = endpoint() else { done(); return }
        withBlobs(ep) { [weak self] in self?.reconcile(ArraySlice(self?.store.allHashes ?? []), ep, done) }
    }

    private func reconcile(_ hashes: ArraySlice<String>, _ ep: (base: URL, token: String), _ done: @escaping () -> Void) {
        guard !hashes.isEmpty else { done(); return }
        let batch = hashes.prefix(1000)
        var req = URLRequest(url: ep.base.appendingPathComponent("v1/blobs/missing"))
        req.httpMethod = "POST"
        req.setValue("Bearer \(ep.token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["hashes": Array(batch)])
        session.dataTask(with: req) { [weak self] data, resp, _ in
            guard let self else { return }
            guard (resp as? HTTPURLResponse)?.statusCode == 200, let data,
                  let missing = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["missing"] as? [String] else { done(); return }
            missing.forEach(self.store.markPending)
            self.reconcile(hashes.dropFirst(batch.count), ep, done)
        }.resume()
    }

    /// Uploads the pending images one at a time (the server serves blob requests one by one).
    func uploadPending() {
        guard uploading.isEmpty, let next = store.pendingUploads.first, let ep = endpoint() else { return }
        withBlobs(ep) { [weak self] in self?.upload(next, ep) }
    }

    /// Something didn't go up (offline, server error, health check failed): try again later
    /// while sync runs, as well as on the next reconnect.
    private func retryLater() {
        guard retryWork == nil, endpoint() != nil else { return }
        let w = DispatchWorkItem { [weak self] in
            self?.retryWork = nil
            self?.uploadPending()
        }
        retryWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + retryDelay, execute: w)
        retryDelay = min(retryDelay * 2, 600)
    }

    /// The image for a note, fetching it when it isn't here (`store.didLoad` follows).
    func image(_ hash: String) -> NSImage? {
        if let i = store.image(hash) { return i }
        fetch(hash)
        return nil
    }

    /// Whether the image is being fetched (or will be asked for again soon).
    func isLoading(_ hash: String) -> Bool { fetching.contains(hash) || (missing[hash] == nil && endpoint() != nil) }

    func fetch(_ hash: String) {
        guard !store.has(hash), !fetching.contains(hash), let ep = endpoint() else { return }
        if let t = missing[hash], Date().timeIntervalSince(t) < 30 { return }
        fetching.insert(hash)
        var req = URLRequest(url: ep.base.appendingPathComponent("v1/blobs/\(hash)"))
        req.setValue("Bearer \(ep.token)", forHTTPHeaderField: "Authorization")
        session.dataTask(with: req) { [weak self] data, resp, err in
            guard let self else { return }
            self.fetching.remove(hash)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if code == 200, let data, self.store.store(data, hash: hash) {
                self.missing.removeValue(forKey: hash)
                return
            }
            // not uploaded yet (or offline): ask again later
            self.missing[hash] = Date()
            if code != 404 { self.log.info("Image \(hash.prefix(12), privacy: .public) not fetched: \(err?.localizedDescription ?? "HTTP \(code)", privacy: .public)") }
            NotificationCenter.default.post(name: NoteImageStore.didLoad, object: hash) // the placeholder says it's missing
        }.resume()
    }

    private func upload(_ hash: String, _ ep: (base: URL, token: String)) {
        guard let data = store.data(hash), !uploading.contains(hash) else { return }
        uploading.insert(hash)
        var req = URLRequest(url: ep.base.appendingPathComponent("v1/blobs/\(hash)"))
        req.httpMethod = "PUT"
        req.setValue("Bearer \(ep.token)", forHTTPHeaderField: "Authorization")
        req.setValue(NoteImage.mimeType(data) ?? "application/octet-stream", forHTTPHeaderField: "Content-Type")
        session.uploadTask(with: req, from: data) { [weak self] _, resp, err in
            guard let self else { return }
            self.uploading.remove(hash)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            switch code {
            case 200:
                self.store.uploaded(hash)
                if self.store.pendingUploads.isEmpty { self.retryDelay = 30 }
                self.uploadPending()
            case 400, 413, 415:
                // the server will never take it: stop trying, the image stays on this Mac
                self.store.uploaded(hash)
                self.log.error("Image \(hash.prefix(12), privacy: .public) refused by the server (HTTP \(code))")
                self.uploadPending()
            default:
                self.log.info("Image \(hash.prefix(12), privacy: .public) not uploaded: \(err?.localizedDescription ?? "HTTP \(code)", privacy: .public)")
                self.retryLater()
            }
        }.resume()
    }

    /// Runs `then` once the server says it stores images (`/v1/health` `blobs`).
    private func withBlobs(_ ep: (base: URL, token: String), then: @escaping () -> Void) {
        if let s = serverHasBlobs, s.base == ep.base {
            if s.ok { then() }
            return
        }
        session.dataTask(with: ep.base.appendingPathComponent("v1/health")) { [weak self] data, resp, _ in
            guard let self else { return }
            guard (resp as? HTTPURLResponse)?.statusCode == 200, let data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { self.retryLater(); return }
            let ok = obj["blobs"] as? Bool == true
            self.serverHasBlobs = (ep.base, ok)
            if ok { then() } else { self.log.info("Sync server doesn't store images yet; they stay on this Mac") }
        }.resume()
    }
}
