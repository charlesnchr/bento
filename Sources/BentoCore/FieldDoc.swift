import Foundation

/// Minimal JSON value for document fields, so unknown fields written by other
/// clients survive a round trip.
public enum SyncValue: Equatable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([SyncValue])
    case object([String: SyncValue])

    public init(any: Any?) {
        switch any {
        case nil, is NSNull: self = .null
        case let n as NSNumber:
            // NSNumber bridges Bool too; CFBoolean has its own type id.
            if CFGetTypeID(n) == CFBooleanGetTypeID() { self = .bool(n.boolValue) } else { self = .number(n.doubleValue) }
        case let s as String: self = .string(s)
        case let a as [Any]: self = .array(a.map { SyncValue(any: $0) })
        case let d as [String: Any]: self = .object(d.mapValues { SyncValue(any: $0) })
        default: self = .null
        }
    }

    public var any: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let b): return b
        case .number(let n): return n.rounded() == n && abs(n) < 1e15 ? NSNumber(value: Int64(n)) : NSNumber(value: n)
        case .string(let s): return s
        case .array(let a): return a.map(\.any)
        case .object(let o): return o.mapValues(\.any)
        }
    }

    public var string: String? { if case .string(let s) = self { return s }; return nil }
    public var double: Double? { if case .number(let n) = self { return n }; return nil }
    public var bool: Bool? { if case .bool(let b) = self { return b }; return nil }
    public var int64: Int64? { double.flatMap(FieldDoc.int64) }

    /// Canonical JSON text (sorted keys): the merge tie-break and change detection.
    public var canonical: String {
        guard let d = try? JSONSerialization.data(withJSONObject: [any], options: [.sortedKeys, .fragmentsAllowed]),
              let s = String(data: d, encoding: .utf8) else { return "" }
        return s
    }
}

/// One synced field document plus local bookkeeping: a todo task or project, a voice
/// dictionary entry or settings.
///
/// Fields carry their own clocks (ms of the last change) so concurrent edits of
/// different fields on two devices merge instead of overwriting each other; see
/// "Todo documents" in docs/SYNC_PROTOCOL.md.
public struct FieldDoc: Equatable {
    public var id: String
    /// The document's kind ("task", "entry"…); values a client doesn't know are kept but ignored.
    public var type: String
    public var fields: [String: SyncValue] = [:]
    public var clocks: [String: Int64] = [:]
    /// Unknown top-level keys of the body, preserved.
    public var extra: [String: SyncValue] = [:]
    public var createdAt: Int64
    public var updatedAt: Int64
    public var deleted = false
    /// Server seq of the version we last saw (nil: never synced).
    public var seq: Int64?
    public var device = ""
    public var meta: [String: SyncValue] = [:]
    // Local only
    public var dirty = false

    public init(id: String, type: String, createdAt: Int64, updatedAt: Int64) {
        self.id = id
        self.type = type
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    public static func now() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }

    /// A clock for a new local change: now, but always after `t` (clocks come from other
    /// devices and may be ahead of ours; never overflow).
    public static func nextClock(after t: Int64...) -> Int64 {
        t.reduce(now()) { acc, x in max(acc, x == .max ? .max : x + 1) }
    }

    public static func int64(_ d: Double) -> Int64? {
        guard d.isFinite else { return nil }
        if d >= 9.2e18 { return .max }
        if d <= -9.2e18 { return .min }
        return Int64(d)
    }

    // MARK: Fields

    /// Sets a field as a local change (no-op when the value is unchanged).
    public mutating func set(_ key: String, _ value: SyncValue, at clock: Int64? = nil) {
        guard fields[key] != value else { return }
        let c = clock ?? FieldDoc.nextClock(after: updatedAt)
        fields[key] = value
        clocks[key] = c
        updatedAt = max(updatedAt, c)
    }

    /// Turns the document into a tombstone as a local change.
    public mutating func markDeleted(at clock: Int64? = nil) {
        guard !deleted else { return }
        deleted = true
        updatedAt = max(updatedAt == .max ? .max : updatedAt + 1, clock ?? FieldDoc.nextClock(after: updatedAt))
    }

    public var maxClock: Int64 { clocks.values.max() ?? createdAt }

    /// Field-by-field merge: per field the larger clock wins; ties go to the value whose
    /// canonical JSON sorts higher, so every device converges on the same result.
    /// Bookkeeping (seq, dirty, updatedAt, deleted) comes from `self`.
    public func merged(with other: FieldDoc) -> FieldDoc {
        var m = self
        for key in Set(fields.keys).union(other.fields.keys).union(clocks.keys).union(other.clocks.keys) {
            let a = clocks[key] ?? (fields[key] == nil ? -1 : 0)
            let b = other.clocks[key] ?? (other.fields[key] == nil ? -1 : 0)
            let takeOther: Bool
            if a != b {
                takeOther = b > a
            } else {
                takeOther = (other.fields[key]?.canonical ?? "") > (fields[key]?.canonical ?? "")
            }
            if takeOther {
                m.fields[key] = other.fields[key]
                if let c = other.clocks[key] { m.clocks[key] = c }
            }
        }
        // Extra keys have no clocks; no client writes them yet, so take the server's.
        for (k, v) in other.extra { m.extra[k] = v }
        m.createdAt = min(createdAt, other.createdAt)
        return m
    }

    /// Same synced content (ignores seq/dirty/device bookkeeping).
    public func sameContent(_ o: FieldDoc) -> Bool {
        type == o.type && fields == o.fields && clocks == o.clocks && extra == o.extra
            && deleted == o.deleted && meta == o.meta && updatedAt == o.updatedAt && createdAt == o.createdAt
    }

    // MARK: Body (wire)

    public var body: String {
        guard !deleted else { return "" }
        var obj: [String: Any] = extra.mapValues(\.any)
        obj["type"] = type
        obj["fields"] = fields.mapValues(\.any)
        obj["clocks"] = clocks.mapValues { NSNumber(value: $0) }
        guard let d = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
              let s = String(data: d, encoding: .utf8) else { return "" }
        return s
    }

    /// Fills type/fields/clocks/extra from a body; false when it isn't a field document body.
    public mutating func load(body: String) -> Bool {
        guard let data = body.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let t = obj["type"] as? String else { return false }
        type = t
        fields = (obj["fields"] as? [String: Any] ?? [:]).mapValues { SyncValue(any: $0) }
        clocks = (obj["clocks"] as? [String: Any] ?? [:]).compactMapValues { ($0 as? NSNumber).flatMap { FieldDoc.int64($0.doubleValue) } }
        extra = obj.filter { !["type", "fields", "clocks"].contains($0.key) }.mapValues { SyncValue(any: $0) }
        return true
    }
}

// MARK: - Wire

/// The protocol's document object for one collection of field documents (`todos`, `voice`).
public struct FieldDocWire {
    public let collection: String

    public init(collection: String) { self.collection = collection }

    public func encode(_ d: FieldDoc, device: String) -> [String: Any] {
        [
            "id": d.id,
            "body": d.body,
            "created_at": d.createdAt,
            "updated_at": d.updatedAt,
            "deleted": d.deleted,
            "device": device,
            "meta": d.meta.mapValues(\.any),
            "collection": collection,
        ]
    }

    /// nil for anything that isn't a document of this collection (wrong collection, unreadable body).
    public func decode(_ obj: Any?) -> FieldDoc? {
        guard let o = obj as? [String: Any], let id = o["id"] as? String, !id.isEmpty else { return nil }
        // Servers with collections always say which; anything else (e.g. an old server's
        // notes) isn't ours.
        guard o["collection"] as? String == collection else { return nil }
        func int(_ k: String) -> Int64? { (o[k] as? NSNumber).flatMap { FieldDoc.int64($0.doubleValue) } }
        guard let updated = int("updated_at") else { return nil }
        var d = FieldDoc(id: id, type: "", createdAt: int("created_at") ?? updated, updatedAt: updated)
        d.deleted = (o["deleted"] as? Bool) ?? ((o["deleted"] as? NSNumber)?.boolValue ?? false)
        if !d.deleted, !d.load(body: o["body"] as? String ?? "") { return nil }
        d.seq = int("seq")
        d.device = o["device"] as? String ?? ""
        if let m = o["meta"] as? [String: Any] { d.meta = m.mapValues { SyncValue(any: $0) } }
        return d
    }
}
