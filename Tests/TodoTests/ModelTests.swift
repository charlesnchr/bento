import Foundation
import Testing
@testable import Todo

private let cal: Calendar = {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone(identifier: "Europe/London")!
    c.locale = Locale(identifier: "en_GB")
    return c
}()
/// Wednesday 21 Oct 2026, 10:00 London.
private let now = cal.date(from: DateComponents(year: 2026, month: 10, day: 21, hour: 10))!
private let dates = TodoDates(calendar: cal, now: now)

private func t(_ title: String, due: String? = nil, time: String? = nil, project: String? = nil, labels: [String] = [],
               priority: Int = 4, order: Double = 0, done: Bool = false) -> TodoDoc {
    var d = TodoDoc.newTask(title: title, project: project, labels: labels, priority: priority,
                            due: due.map { DueDate(date: $0, time: time) }, order: order, now: 1000)
    d.id = title
    if done { d.setCompleted(now.timeIntervalSince1970 > 0 ? Int64(now.timeIntervalSince1970 * 1000) : 1, at: 2000) }
    return d
}

private func titles(_ rows: [TodoRow]) -> [String] {
    rows.map { r in
        switch r {
        case .header(_, let title, _, _): return "[\(title)]"
        case .task(let x): return x.title
        }
    }
}

@Suite struct Queries {
    let project = { () -> TodoDoc in var p = TodoDoc.newProject(name: "Work", order: 1, now: 1); p.id = "work"; return p }()

    @Test func todayGroupsOverdueThenTodayByTimeAndPriority() {
        let tasks = [
            t("late", due: "2026-10-19"), t("p1", due: "2026-10-21", priority: 1), t("nine", due: "2026-10-21", time: "09:00"),
            t("p4", due: "2026-10-21"), t("tomorrow", due: "2026-10-22"), t("none"),
        ]
        let rows = TodoQuery.rows(for: .today, tasks: tasks, projects: [], showCompleted: false, dates: dates)
        #expect(titles(rows) == ["[Overdue]", "late", "[Wed 21 Oct]", "nine", "p1", "p4"])
    }

    @Test func upcomingShowsEveryDayOfTheWeekThenLaterDaysWithTasks() {
        let tasks = [t("fri", due: "2026-10-23"), t("dec", due: "2026-12-01")]
        let rows = TodoQuery.rows(for: .upcoming, tasks: tasks, projects: [], showCompleted: false, dates: dates)
        let heads = rows.filter { $0.task == nil }
        #expect(heads.count == 8)
        #expect(titles(rows).suffix(2) == ["[Tue 1 Dec]", "dec"])
        #expect(titles(rows).contains("fri"))
    }

    @Test func inboxProjectsAndCompleted() {
        let tasks = [t("b", order: 2), t("a", order: 1), t("w", project: "work"), t("orphan", project: "gone", order: 3),
                     t("done", done: true)]
        let inbox = TodoQuery.rows(for: .inbox, tasks: tasks, projects: [project], showCompleted: false, dates: dates)
        #expect(titles(inbox) == ["a", "b", "orphan"])
        let withDone = TodoQuery.rows(for: .inbox, tasks: tasks, projects: [project], showCompleted: true, dates: dates)
        #expect(titles(withDone) == ["a", "b", "orphan", "[Completed]", "done"])
        #expect(titles(TodoQuery.rows(for: .project("work"), tasks: tasks, projects: [project], showCompleted: false, dates: dates)) == ["w"])
    }

    @Test func searchMatchesTitleLabelsAndProject() {
        let tasks = [t("Email Bob", labels: ["admin"]), t("Ship it", project: "work"), t("Other")]
        func s(_ q: String) -> [String] { titles(TodoQuery.rows(for: .search(q), tasks: tasks, projects: [project], showCompleted: false, dates: dates)) }
        #expect(s("bob") == ["Email Bob"])
        #expect(s("@admin") == ["Email Bob"])
        #expect(s("#work") == ["Ship it"])
        #expect(s("") == [])
    }

    @Test func countsAndOrderBetween() {
        let tasks = [t("a", due: "2026-10-20"), t("b", due: "2026-10-21", project: "work"), t("c")]
        let c = TodoQuery.counts(tasks: tasks, projects: [project], dates: dates)
        #expect(c.inbox == 2 && c.today == 2 && c.overdue == 1 && c.byProject["work"] == 1)
        #expect(TodoQuery.order(between: 1, and: 3) == 2)
        #expect(TodoQuery.order(between: nil, and: 100) < 100)
        #expect(TodoQuery.order(between: 100, and: nil) > 100)
    }

    @Test func labels() {
        #expect(dates.label(DueDate(date: "2026-10-21")) == "Today")
        #expect(dates.label(DueDate(date: "2026-10-22")) == "Tomorrow")
        #expect(dates.header("2026-10-22").subtitle == "Tomorrow")
        #expect(dates.isOverdue(DueDate(date: "2026-10-21", time: "09:00")))
        #expect(!dates.isOverdue(DueDate(date: "2026-10-21", time: "11:00")))
    }
}

@Suite struct Undo {
    @Test func restoreFieldsDeletionAndCreation() {
        var cur = t("x")
        let old = cur
        cur.setTitle("changed", at: 5000)
        cur.setPriority(1, at: 5000)
        let r = TodoController.restore(cur, to: old)
        #expect(r.title == "x" && r.priority == 4 && r.dirty && r.clocks["title"]! > 5000)

        var del = old
        del.markDeleted(at: 6000)
        let back = TodoController.restore(del, to: old)
        #expect(!back.deleted && back.title == "x" && back.maxClock > 6000)

        var gone = old
        gone.deleted = true
        #expect(TodoController.restore(old, to: gone).deleted)
    }
}
