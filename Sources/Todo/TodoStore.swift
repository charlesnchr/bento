import Foundation
import BentoCore

/// Storage the sync engine works against (the SQLite store, or an in-memory one in tests).
typealias TodoRepository = FieldDocRepository

/// Local todo database: `<support>/Todo/todo.sqlite`, a BentoCore `FieldDocStore`
/// (documents cached in memory, written through to SQLite; change notifications
/// `TodoStore.didChange`). Main thread only.
final class TodoStore: FieldDocStore {
    static var defaultURL: URL? { AppPaths.support("Todo").appendingPathComponent("todo.sqlite") }

    init(url: URL? = TodoStore.defaultURL) {
        super.init(url: url, name: "todo")
    }

    // MARK: Queries

    var tasks: [TodoDoc] { allDocs.filter(\.isTask) }

    /// Live projects, archived ones last, by order.
    var projects: [TodoDoc] {
        allDocs.filter(\.isProject).sorted { a, b in
            if a.archived != b.archived { return !a.archived }
            if a.order != b.order { return a.order < b.order }
            return a.id < b.id
        }
    }

    /// Every label used by an open task, plus labels the user created, sorted.
    var labels: [String] {
        var seen: [String: String] = [:]
        for t in allDocs where t.isTask && !t.isCompleted {
            for l in t.labels where seen[l.lowercased()] == nil { seen[l.lowercased()] = l }
        }
        return seen.values.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }
}
