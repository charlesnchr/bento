import Foundation
import BentoCore

/// Document field values (BentoCore's `SyncValue`).
typealias JSONValue = SyncValue

/// One synced todo document (a task or a project) plus local bookkeeping: a BentoCore
/// field document whose `type` is "task" or "project".
///
/// Fields carry their own clocks (ms of the last change) so concurrent edits of
/// different fields on two devices merge instead of overwriting each other; see
/// "Todo documents" in docs/SYNC_PROTOCOL.md.
typealias TodoDoc = FieldDoc

extension TodoDoc {
    enum Kind: String { case task, project }

    init(id: String = UUID().uuidString, kind: Kind, createdAt: Int64 = TodoDoc.now()) {
        self.init(id: id, type: kind.rawValue, createdAt: createdAt, updatedAt: createdAt)
    }

    var kind: Kind? { Kind(rawValue: type) }
    var isTask: Bool { !deleted && kind == .task }
    var isProject: Bool { !deleted && kind == .project }
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
    private static let wire = FieldDocWire(collection: collection)

    static func encode(_ d: TodoDoc, device: String) -> [String: Any] { wire.encode(d, device: device) }

    /// nil for anything that isn't a todo document (wrong collection, unreadable body).
    static func decode(_ obj: Any?) -> TodoDoc? { wire.decode(obj) }
}
