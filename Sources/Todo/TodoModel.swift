import Foundation

/// Minimal JSON value for document fields, so unknown fields written by other
/// clients survive a round trip.
enum JSONValue: Equatable, Hashable {
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

    var string: String? { if case .string(let s) = self { return s }; return nil }
    var double: Double? { if case .number(let n) = self { return n }; return nil }
    var bool: Bool? { if case .bool(let b) = self { return b }; return nil }
    var int64: Int64? { double.flatMap(TodoDoc.int64) }

    /// Canonical JSON text (sorted keys): the merge tie-break and change detection.
    var canonical: String {
        guard let d = try? JSONSerialization.data(withJSONObject: [any], options: [.sortedKeys, .fragmentsAllowed]),
              let s = String(data: d, encoding: .utf8) else { return "" }
        return s
    }
}

/// One synced todo document (a task or a project) plus local bookkeeping.
///
/// Fields carry their own clocks (ms of the last change) so concurrent edits of
/// different fields on two devices merge instead of overwriting each other; see
/// "Todo documents" in docs/SYNC_PROTOCOL.md.
struct TodoDoc: Equatable {
    enum Kind: String { case task, project }

    var id: String
    /// "task" or "project"; other values are kept but ignored.
    var type: String
    var fields: [String: JSONValue] = [:]
    var clocks: [String: Int64] = [:]
    /// Unknown top-level keys of the body, preserved.
    var extra: [String: JSONValue] = [:]
    var createdAt: Int64
    var updatedAt: Int64
    var deleted = false
    /// Server seq of the version we last saw (nil: never synced).
    var seq: Int64?
    var device = ""
    var meta: [String: JSONValue] = [:]
    // Local only
    var dirty = false

    init(id: String = UUID().uuidString, kind: Kind, createdAt: Int64 = TodoDoc.now()) {
        self.id = id
        self.type = kind.rawValue
        self.createdAt = createdAt
        self.updatedAt = createdAt
    }

    init(id: String, type: String, createdAt: Int64, updatedAt: Int64) {
        self.id = id
        self.type = type
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    var kind: Kind? { Kind(rawValue: type) }
    var isTask: Bool { !deleted && kind == .task }
    var isProject: Bool { !deleted && kind == .project }

    static func now() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }

    /// A clock for a new local change: now, but always after `t` (clocks come from other
    /// devices and may be ahead of ours; never overflow).
    static func nextClock(after t: Int64...) -> Int64 {
        t.reduce(now()) { acc, x in max(acc, x == .max ? .max : x + 1) }
    }

    static func int64(_ d: Double) -> Int64? {
        guard d.isFinite else { return nil }
        if d >= 9.2e18 { return .max }
        if d <= -9.2e18 { return .min }
        return Int64(d)
    }

    // MARK: Fields

    /// Sets a field as a local change (no-op when the value is unchanged).
    mutating func set(_ key: String, _ value: JSONValue, at clock: Int64? = nil) {
        guard fields[key] != value else { return }
        let c = clock ?? TodoDoc.nextClock(after: updatedAt)
        fields[key] = value
        clocks[key] = c
        updatedAt = max(updatedAt, c)
    }

    /// Turns the document into a tombstone as a local change.
    mutating func markDeleted(at clock: Int64? = nil) {
        guard !deleted else { return }
        deleted = true
        updatedAt = max(updatedAt + 1, clock ?? TodoDoc.nextClock(after: updatedAt))
    }

    var maxClock: Int64 { clocks.values.max() ?? createdAt }

    /// Field-by-field merge: per field the larger clock wins; ties go to the value whose
    /// canonical JSON sorts higher, so every device converges on the same result.
    /// Bookkeeping (seq, dirty, updatedAt, deleted) comes from `self`.
    func merged(with other: TodoDoc) -> TodoDoc {
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
    func sameContent(_ o: TodoDoc) -> Bool {
        type == o.type && fields == o.fields && clocks == o.clocks && extra == o.extra
            && deleted == o.deleted && meta == o.meta && updatedAt == o.updatedAt && createdAt == o.createdAt
    }

    // MARK: Body (wire)

    var body: String {
        guard !deleted else { return "" }
        var obj: [String: Any] = extra.mapValues(\.any)
        obj["type"] = type
        obj["fields"] = fields.mapValues(\.any)
        obj["clocks"] = clocks.mapValues { NSNumber(value: $0) }
        guard let d = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
              let s = String(data: d, encoding: .utf8) else { return "" }
        return s
    }

    /// Fills type/fields/clocks/extra from a body; false when it isn't a todo body.
    mutating func load(body: String) -> Bool {
        guard let data = body.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let t = obj["type"] as? String else { return false }
        type = t
        fields = (obj["fields"] as? [String: Any] ?? [:]).mapValues { JSONValue(any: $0) }
        clocks = (obj["clocks"] as? [String: Any] ?? [:]).compactMapValues { ($0 as? NSNumber).flatMap { TodoDoc.int64($0.doubleValue) } }
        extra = obj.filter { !["type", "fields", "clocks"].contains($0.key) }.mapValues { JSONValue(any: $0) }
        return true
    }
}

// MARK: - Typed access

extension TodoDoc {
    // Tasks
    var title: String { fields["title"]?.string ?? "" }
    var notes: String { fields["description"]?.string ?? "" }
    /// Project id; nil = Inbox.
    var project: String? { fields["project"]?.string }
    var labels: [String] {
        guard case .array(let a)? = fields["labels"] else { return [] }
        return a.compactMap(\.string)
    }
    /// 1 = p1 (highest) … 4 = p4 (none).
    var priority: Int {
        guard let p = fields["priority"]?.double, p >= 1, p <= 4 else { return 4 }
        return Int(p)
    }
    var due: DueDate? {
        guard case .object(let o)? = fields["due"], let d = o["date"]?.string, !d.isEmpty else { return nil }
        return DueDate(date: d, time: o["time"]?.string)
    }
    var completedAt: Int64? { fields["completed_at"]?.int64 }
    var isCompleted: Bool { completedAt != nil }
    var order: Double { fields["order"]?.double ?? Double(createdAt) }

    // Projects
    var name: String { fields["name"]?.string ?? "" }
    var color: String { fields["color"]?.string ?? "grey" }
    var archived: Bool { fields["archived"]?.bool ?? false }

    mutating func setTitle(_ s: String, at c: Int64? = nil) { set("title", .string(s), at: c) }
    mutating func setNotes(_ s: String, at c: Int64? = nil) { set("description", .string(s), at: c) }
    mutating func setProject(_ id: String?, at c: Int64? = nil) { set("project", id.map(JSONValue.string) ?? .null, at: c) }
    mutating func setLabels(_ l: [String], at c: Int64? = nil) { set("labels", .array(l.map(JSONValue.string)), at: c) }
    mutating func setPriority(_ p: Int, at c: Int64? = nil) { set("priority", .number(Double(min(4, max(1, p)))), at: c) }
    mutating func setDue(_ d: DueDate?, at c: Int64? = nil) {
        guard let d else { set("due", .null, at: c); return }
        var o: [String: JSONValue] = ["date": .string(d.date)]
        if let t = d.time { o["time"] = .string(t) }
        set("due", .object(o), at: c)
    }
    mutating func setCompleted(_ ms: Int64?, at c: Int64? = nil) { set("completed_at", ms.map { .number(Double($0)) } ?? .null, at: c) }
    mutating func setOrder(_ o: Double, at c: Int64? = nil) { set("order", .number(o), at: c) }
    mutating func setName(_ s: String, at c: Int64? = nil) { set("name", .string(s), at: c) }
    mutating func setColor(_ s: String, at c: Int64? = nil) { set("color", .string(s), at: c) }
    mutating func setArchived(_ b: Bool, at c: Int64? = nil) { set("archived", .bool(b), at: c) }

    /// A new task with every field stamped, so a field never merges against "no clock".
    static func newTask(title: String, project: String? = nil, labels: [String] = [], priority: Int = 4,
                        due: DueDate? = nil, order: Double, now: Int64 = TodoDoc.now()) -> TodoDoc {
        var d = TodoDoc(kind: .task, createdAt: now)
        d.setTitle(title, at: now)
        d.setProject(project, at: now)
        d.setLabels(labels, at: now)
        d.setPriority(priority, at: now)
        d.setDue(due, at: now)
        d.setOrder(order, at: now)
        d.updatedAt = now
        return d
    }

    static func newProject(name: String, color: String = "grey", order: Double, now: Int64 = TodoDoc.now()) -> TodoDoc {
        var d = TodoDoc(kind: .project, createdAt: now)
        d.setName(name, at: now)
        d.setColor(color, at: now)
        d.setOrder(order, at: now)
        d.updatedAt = now
        return d
    }
}

// MARK: - Wire

/// The protocol's document object for the `todos` collection.
enum TodoWire {
    static let collection = "todos"

    static func encode(_ d: TodoDoc, device: String) -> [String: Any] {
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

    /// nil for anything that isn't a todo document (wrong collection, unreadable body).
    static func decode(_ obj: Any?) -> TodoDoc? {
        guard let o = obj as? [String: Any], let id = o["id"] as? String, !id.isEmpty else { return nil }
        // Servers with collections always say which; anything else (e.g. an old server's
        // notes) isn't ours.
        guard o["collection"] as? String == collection else { return nil }
        func int(_ k: String) -> Int64? { (o[k] as? NSNumber).flatMap { TodoDoc.int64($0.doubleValue) } }
        guard let updated = int("updated_at") else { return nil }
        var d = TodoDoc(id: id, type: "", createdAt: int("created_at") ?? updated, updatedAt: updated)
        d.deleted = (o["deleted"] as? Bool) ?? ((o["deleted"] as? NSNumber)?.boolValue ?? false)
        if !d.deleted, !d.load(body: o["body"] as? String ?? "") { return nil }
        d.seq = int("seq")
        d.device = o["device"] as? String ?? ""
        if let m = o["meta"] as? [String: Any] { d.meta = m.mapValues { JSONValue(any: $0) } }
        return d
    }
}
