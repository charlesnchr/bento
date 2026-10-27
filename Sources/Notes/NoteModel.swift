import Foundation

/// Minimal JSON value used for the protocol's opaque `meta` object, so unknown keys
/// written by other clients survive a round trip.
enum JSONValue: Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(any: Any?) {
        switch any {
        case nil, is NSNull: self = .null
        case let n as NSNumber:
            // NSNumber bridges Bool too; CFBoolean has its own type id.
            if CFGetTypeID(n) == CFBooleanGetTypeID() { self = .bool(n.boolValue) } else { self = .number(n.doubleValue) }
        case let s as String: self = .string(s)
        case let a as [Any]: self = .array(a.map { JSONValue(any: $0) })
        case let d as [String: Any]: self = .object(d.mapValues { JSONValue(any: $0) })
        default: self = .null
        }
    }

    var any: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let b): return b
        case .number(let n): return n.rounded() == n && abs(n) < 1e15 ? NSNumber(value: Int64(n)) : NSNumber(value: n)
        case .string(let s): return s
        case .array(let a): return a.map(\.any)
        case .object(let o): return o.mapValues(\.any)
        }
    }

    var double: Double? { if case .number(let n) = self { return n }; return nil }
    var bool: Bool? { if case .bool(let b) = self { return b }; return nil }
}

/// The newest version of one Mac's text that a version of a note contains: that Mac's
/// `updated_at` for it (only ever grows for a note) and the hash of its body.
struct SyncHead: Equatable {
    var at: Int64
    var hash: UInt64
}

/// Per Mac (install id), the newest of its versions a version contains.
typealias SyncHeads = [String: SyncHead]

/// JSON text for stored heads, tagged with the hash of the body they describe:
/// `{"body": "<hex>", "heads": {"<install id>": [updated_at, "<hex hash>"]}}`.
enum SyncHeadsCodec {
    static func encode(_ h: SyncHeads, body: String) -> String {
        let heads = h.mapValues { [NSNumber(value: $0.at), String($0.hash, radix: 16)] as [Any] }
        let obj: [String: Any] = ["body": String(NoteText.hash(body), radix: 16), "heads": heads]
        guard let d = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return "{}" }
        return String(decoding: d, as: UTF8.self)
    }

    /// nil when malformed or stored with another body.
    static func decode(_ s: String, body: String) -> SyncHeads? {
        guard let obj = (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any],
              obj["body"] as? String == String(NoteText.hash(body), radix: 16),
              let heads = obj["heads"] as? [String: [Any]] else { return nil }
        var out: SyncHeads = [:]
        for (k, v) in heads {
            guard v.count == 2, let at = (v[0] as? NSNumber)?.int64Value, let h = (v[1] as? String).flatMap({ UInt64($0, radix: 16) }) else { return nil }
            out[k] = SyncHead(at: at, hash: h)
        }
        return out
    }
}

/// One note, mirroring the sync protocol's note object plus local bookkeeping.
struct Note: Equatable {
    var id: String
    var body: String
    var createdAt: Int64
    var updatedAt: Int64
    /// Protocol tombstone (permanently deleted; body is "").
    var deleted = false
    /// Server seq of the version we last saw (nil: never synced).
    var seq: Int64?
    var device = ""
    var meta: [String: JSONValue] = [:]
    // Local only
    var dirty = false
    var openedAt: Int64 = 0
    /// `NoteText.hash` of the body of the server version this local version is based on
    /// (nil: unknown). Lets the sync engine tell a real concurrent edit from a
    /// meta-only change on either side.
    var baseHash: UInt64?
    /// Which versions of each Mac's text this text contains, as far as the sync engine
    /// knows (nil: unknown). Local only; kept so merges survive a relaunch.
    var syncHeads: SyncHeads?
    /// Wire only (never stored): which versions of each Mac's text a remote version
    /// contains (`meta.base`); nil when it doesn't say. Lets the engine merge concurrent
    /// edits.
    var remoteHeads: SyncHeads?
    /// Wire only: the install id of the Mac that sent this version (`meta.base.from`).
    var remoteOrigin: String?
    /// Wire only: install ids its sender found shared with another Mac (`meta.base.retired`).
    var remoteRetired: [String] = []

    init(id: String = UUID().uuidString, body: String = "", createdAt: Int64 = Note.now(), updatedAt: Int64? = nil) {
        self.id = id
        self.body = body
        self.createdAt = createdAt
        self.updatedAt = updatedAt ?? createdAt
    }

    static func now() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }

    /// updated_at for a new local version: now, but always after `t` (timestamps come from
    /// other clients' clocks and may be far in the future; never overflow).
    static func nextUpdate(after t: Int64...) -> Int64 {
        t.reduce(now()) { acc, x in max(acc, x == .max ? .max : x + 1) }
    }

    /// Int64 from a JSON number of any size (meta values come from other clients).
    static func int64(_ d: Double) -> Int64? {
        guard d.isFinite else { return nil }
        if d >= 9.2e18 { return .max }
        if d <= -9.2e18 { return .min }
        return Int64(d)
    }

    // MARK: Meta helpers (synced client extras)

    var pinned: Bool {
        get { meta["pinned"]?.bool ?? false }
        set { if newValue { meta["pinned"] = .bool(true) } else { meta.removeValue(forKey: "pinned"); meta.removeValue(forKey: "pinOrder") } }
    }

    /// Sort key among pinned notes (ascending).
    var pinOrder: Double {
        get { meta["pinOrder"]?.double ?? Double(createdAt) }
        set { meta["pinOrder"] = .number(newValue) }
    }

    /// When the note was moved to Recently Deleted (ms), nil when live.
    var trashedAt: Int64? {
        get { meta["trashedAt"]?.double.flatMap(Note.int64) }
        set { if let v = newValue { meta["trashedAt"] = .number(Double(v)) } else { meta.removeValue(forKey: "trashedAt") } }
    }

    var isTrashed: Bool { trashedAt != nil }
    /// Visible in the normal notes list.
    var isLive: Bool { !deleted && trashedAt == nil }

    // MARK: Derived text

    var title: String { NoteText.title(of: body) }
}

/// Pure helpers deriving titles, plain text and counts from markdown bodies.
enum NoteText {
    /// First non-empty line with markdown stripped; "" when the note is empty.
    static func title(of body: String) -> String {
        var result = ""
        body.enumerateLines { line, stop in
            let t = plainLine(line).trimmingCharacters(in: .whitespaces)
            if !t.isEmpty, !isFenceOrRule(line) { result = t; stop = true }
        }
        return result
    }

    static func displayTitle(of body: String) -> String {
        let t = title(of: body)
        return t.isEmpty ? "Untitled" : t
    }

    private static func isFenceOrRule(_ line: String) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        return t.hasPrefix("```") || t.hasPrefix("~~~") || MarkdownParser.isRule(t)
    }

    /// One line without block markers and inline syntax.
    static func plainLine(_ line: String) -> String {
        let parsed = MarkdownParser.parseLine(line, inCode: false)
        let ns = line as NSString
        if case .rule = parsed.kind { return "" }
        if case .fence = parsed.kind { return "" }
        let content = ns.substring(with: parsed.contentRange)
        return MarkdownParser.stripInline(content)
    }

    /// Whole note as plain text (no markdown syntax), used for counts.
    static func plainText(of body: String) -> String {
        var lines: [String] = []
        var inCode = false
        body.enumerateLines { line, _ in
            let p = MarkdownParser.parseLine(line, inCode: inCode)
            switch p.kind {
            case .fence(let opening, _):
                inCode = opening
            case .code:
                lines.append(line)
            case .rule:
                break
            default:
                lines.append(MarkdownParser.stripInline((line as NSString).substring(with: p.contentRange)))
            }
        }
        return lines.joined(separator: "\n")
    }

    static func characterCount(of body: String) -> Int {
        plainText(of: body).reduce(0) { $1 == "\n" ? $0 : $0 + 1 }
    }

    static func wordCount(of body: String) -> Int {
        var n = 0
        let text = plainText(of: body)
        text.enumerateSubstrings(in: text.startIndex..., options: [.byWords, .substringNotRequired]) { _, _, _, _ in n += 1 }
        return n
    }

    /// Lowercased haystack for search.
    static func searchText(of body: String) -> String { plainText(of: body).lowercased() }

    /// Stable 64-bit FNV-1a hash of the UTF-8 bytes (Swift's `Hasher` is seeded per process).
    static func hash(_ s: String) -> UInt64 {
        var h: UInt64 = 0xcbf2_9ce4_8422_2325
        for b in s.utf8 {
            h ^= UInt64(b)
            h = h &* 0x0000_0100_0000_01b3
        }
        return h
    }

    /// Body of a conflicted copy: the title line gets " (conflicted copy, <device>)".
    /// nil when the body has no visible text (nothing worth keeping).
    static func conflictCopyBody(_ body: String, device: String) -> String? {
        // same line `title(of:)` picks, so the copy is recognisable in the notes list
        var lines = body.components(separatedBy: "\n")
        for (i, line) in lines.enumerated() {
            guard !isFenceOrRule(line), !plainLine(line).trimmingCharacters(in: .whitespaces).isEmpty else { continue }
            let suffix = device.isEmpty ? " (conflicted copy)" : " (conflicted copy, \(device))"
            lines[i] = line.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression) + suffix
            return lines.joined(separator: "\n")
        }
        return nil
    }
}

/// "4m ago", "3w ago" style relative dates like Raycast's notes list.
enum RelativeDate {
    static func short(_ ms: Int64, now: Int64 = Note.now()) -> String {
        let (diff, overflow) = now.subtractingReportingOverflow(ms)
        let s = overflow ? (ms < 0 ? Int64.max / 1000 : 0) : max(0, diff / 1000)
        if s < 60 { return "just now" }
        let m = s / 60
        if m < 60 { return "\(m)m ago" }
        let h = m / 60
        if h < 24 { return "\(h)h ago" }
        let d = h / 24
        if d < 7 { return "\(d)d ago" }
        if d < 30 { return "\(d / 7)w ago" }
        if d < 365 { return "\(d / 30)mo ago" }
        return "\(d / 365)y ago"
    }
}
