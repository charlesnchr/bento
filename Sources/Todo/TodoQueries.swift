import Foundation

/// What the main list shows.
enum TodoListView: Hashable, Codable {
    case inbox, today, upcoming
    case project(String)
    case label(String)
    case search(String)

    /// Views with a manual order (reordering, add-at-top/bottom).
    var isManualOrder: Bool {
        switch self {
        case .inbox, .project: return true
        default: return false
        }
    }

    /// The project new tasks land in (nil = Inbox).
    var projectID: String? { if case .project(let id) = self { return id }; return nil }
}

/// One row of the main list.
enum TodoRow: Identifiable, Equatable {
    /// A group heading ("Overdue", "Thu 23 Oct · Tomorrow"); `date` is the day new tasks
    /// added under it are due.
    case header(id: String, title: String, subtitle: String?, date: String?)
    case task(TodoDoc)

    var id: String {
        switch self {
        case .header(let id, _, _, _): return "h:" + id
        case .task(let t): return t.id
        }
    }

    var task: TodoDoc? { if case .task(let t) = self { return t }; return nil }
}

/// Calendar arithmetic on the protocol's floating `yyyy-MM-dd` dates.
struct TodoDates {
    var calendar: Calendar
    var now: Date

    init(calendar: Calendar = .current, now: Date = Date()) {
        self.calendar = calendar
        self.now = now
    }

    var today: String { string(now) }

    func string(_ d: Date) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: d)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    func date(_ s: String) -> Date? {
        let p = s.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: p[0], month: p[1], day: p[2], hour: 12))
    }

    func adding(days: Int, to s: String) -> String {
        guard let d = date(s), let r = calendar.date(byAdding: .day, value: days, to: d) else { return s }
        return string(r)
    }

    /// Whole days from today to `s` (negative = past).
    func days(until s: String) -> Int {
        guard let d = date(s), let t = date(today) else { return 0 }
        return calendar.dateComponents([.day], from: t, to: d).day ?? 0
    }

    func isOverdue(_ due: DueDate) -> Bool { due.isOverdue(now: now, calendar: calendar) }

    /// Todoist-style label: "Today", "Tomorrow", a weekday within the next week, "23 Oct"; plus the time.
    func label(_ due: DueDate) -> String { due.label(now: now, calendar: calendar, locale: calendar.locale ?? .current) }

    /// Heading for a day in Upcoming: "Thu 23 Oct · Tomorrow".
    func header(_ s: String) -> (title: String, subtitle: String?) {
        let n = days(until: s)
        let title = format(s, s.prefix(4) == today.prefix(4) ? "EEE d MMM" : "EEE d MMM yyyy")
        switch n {
        case 0: return (title, "Today")
        case 1: return (title, "Tomorrow")
        case 2...6: return (title, format(s, "EEEE"))
        default: return (title, nil)
        }
    }

    private func format(_ s: String, _ template: String) -> String {
        guard let d = date(s) else { return s }
        let f = DateFormatter()
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.locale = calendar.locale ?? .current
        f.setLocalizedDateFormatFromTemplate(template)
        return f.string(from: d)
    }
}

/// Builds the rows of each view from the task list. Pure, so it is unit tested.
enum TodoQuery {
    /// Open tasks first by time of day (untimed last), then priority, then manual order.
    static func dayOrder(_ a: TodoDoc, _ b: TodoDoc) -> Bool {
        let ta = a.due?.time ?? "99", tb = b.due?.time ?? "99"
        if ta != tb { return ta < tb }
        if a.priority != b.priority { return a.priority < b.priority }
        return manualOrder(a, b)
    }

    static func manualOrder(_ a: TodoDoc, _ b: TodoDoc) -> Bool {
        if a.order != b.order { return a.order < b.order }
        if a.createdAt != b.createdAt { return a.createdAt < b.createdAt }
        return a.id < b.id
    }

    /// Completed tasks, most recently completed first.
    static func completedOrder(_ a: TodoDoc, _ b: TodoDoc) -> Bool {
        (a.completedAt ?? 0) > (b.completedAt ?? 0)
    }

    static func rows(for view: TodoListView, tasks: [TodoDoc], projects: [TodoDoc], showCompleted: Bool,
                     dates: TodoDates) -> [TodoRow] {
        let live = Set(projects.map(\.id))
        // Tasks of a deleted project behave like Inbox tasks until moved.
        func inInbox(_ t: TodoDoc) -> Bool { t.project.map { !live.contains($0) } ?? true }
        let open = tasks.filter { !$0.isCompleted }
        let done = tasks.filter(\.isCompleted)

        func withCompleted(_ rows: [TodoRow], _ matching: (TodoDoc) -> Bool) -> [TodoRow] {
            guard showCompleted else { return rows }
            let c = done.filter(matching).sorted(by: completedOrder)
            guard !c.isEmpty else { return rows }
            return rows + [.header(id: "completed", title: "Completed", subtitle: "\(c.count)", date: nil)] + c.map(TodoRow.task)
        }

        switch view {
        case .inbox:
            return withCompleted(open.filter(inInbox).sorted(by: manualOrder).map(TodoRow.task), inInbox)

        case .project(let id):
            let match = { (t: TodoDoc) in t.project == id }
            return withCompleted(open.filter(match).sorted(by: manualOrder).map(TodoRow.task), match)

        case .label(let name):
            let match = { (t: TodoDoc) in t.labels.contains { $0.caseInsensitiveCompare(name) == .orderedSame } }
            return withCompleted(open.filter(match).sorted(by: dayThenManual(dates)).map(TodoRow.task), match)

        case .today:
            let today = dates.today
            let overdue = open.filter { ($0.due?.date ?? "9") < today }.sorted { a, b in
                a.due!.date != b.due!.date ? a.due!.date < b.due!.date : dayOrder(a, b)
            }
            let due = open.filter { $0.due?.date == today }.sorted(by: dayOrder)
            var rows: [TodoRow] = []
            if !overdue.isEmpty {
                rows.append(.header(id: "overdue", title: "Overdue", subtitle: nil, date: nil))
                rows += overdue.map(TodoRow.task)
                let h = dates.header(today)
                rows.append(.header(id: today, title: h.title, subtitle: h.subtitle, date: today))
            }
            rows += due.map(TodoRow.task)
            return withCompleted(rows) { t in
                guard let c = t.completedAt else { return false }
                return dates.string(Date(timeIntervalSince1970: Double(c) / 1000)) == today
            }

        case .upcoming:
            let today = dates.today
            var rows: [TodoRow] = []
            let overdue = open.filter { ($0.due?.date ?? "9") < today }.sorted { a, b in
                a.due!.date != b.due!.date ? a.due!.date < b.due!.date : dayOrder(a, b)
            }
            if !overdue.isEmpty {
                rows.append(.header(id: "overdue", title: "Overdue", subtitle: nil, date: nil))
                rows += overdue.map(TodoRow.task)
            }
            let byDay = Dictionary(grouping: open.filter { ($0.due?.date ?? "") >= today }, by: { $0.due!.date })
            // The next week always shows every day (somewhere to add to); later only days with tasks.
            let week = (0..<7).map { dates.adding(days: $0, to: today) }
            for day in Set(week).union(byDay.keys).sorted() {
                let h = dates.header(day)
                rows.append(.header(id: day, title: h.title, subtitle: h.subtitle, date: day))
                rows += (byDay[day] ?? []).sorted(by: dayOrder).map(TodoRow.task)
            }
            return rows

        case .search(let q):
            let terms = q.lowercased().split(separator: " ").map(String.init)
            guard !terms.isEmpty else { return [] }
            let names = Dictionary(uniqueKeysWithValues: projects.map { ($0.id, $0.name.lowercased()) })
            func match(_ t: TodoDoc) -> Bool {
                let hay = ([t.title, t.notes] + t.labels.map { "@" + $0 } + [t.project.flatMap { names[$0] }.map { "#" + $0 } ?? "#inbox"])
                    .joined(separator: " ").lowercased()
                return terms.allSatisfy { hay.contains($0) }
            }
            var rows = open.filter(match).sorted(by: dayThenManual(dates)).map(TodoRow.task)
            let c = done.filter(match).sorted(by: completedOrder)
            if !c.isEmpty {
                rows.append(.header(id: "completed", title: "Completed", subtitle: "\(c.count)", date: nil))
                rows += c.map(TodoRow.task)
            }
            return rows
        }
    }

    /// Dated tasks first by date, then undated; within a date by `dayOrder`.
    static func dayThenManual(_ dates: TodoDates) -> (TodoDoc, TodoDoc) -> Bool {
        { a, b in
            let da = a.due?.date ?? "9999", db = b.due?.date ?? "9999"
            return da != db ? da < db : dayOrder(a, b)
        }
    }

    /// Open-task counts for the sidebar.
    static func counts(tasks: [TodoDoc], projects: [TodoDoc], dates: TodoDates) -> (inbox: Int, today: Int, overdue: Int, byProject: [String: Int]) {
        let live = Set(projects.map(\.id))
        var inbox = 0, today = 0, overdue = 0
        var by: [String: Int] = [:]
        let t = dates.today
        for x in tasks where !x.isCompleted {
            if let p = x.project, live.contains(p) { by[p, default: 0] += 1 } else { inbox += 1 }
            if let d = x.due?.date {
                if d == t { today += 1 } else if d < t { today += 1; overdue += 1 }
            }
        }
        return (inbox, today, overdue, by)
    }

    /// An `order` between two neighbours (fractional, so a move rewrites one document).
    static func order(between a: Double?, and b: Double?) -> Double {
        switch (a, b) {
        case let (a?, b?): return (a + b) / 2
        case let (a?, nil): return a + 1024
        case let (nil, b?): return b - 1024
        case (nil, nil): return 1024
        }
    }
}
