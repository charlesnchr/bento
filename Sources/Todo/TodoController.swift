import AppKit
import Combine
import SwiftUI
import BentoCore

/// Inline "add task" / "edit task" row.
final class TaskEditor: ObservableObject, Identifiable {
    enum Anchor: Equatable {
        case top, bottom
        case after(String)
        /// At the end of the group under this header row id (Today/Upcoming days).
        case endOfGroup(String)
    }

    struct Defaults: Equatable {
        var project: String?
        var due: DueDate?
        var label: String?
    }

    let id = UUID()
    /// The task being edited; nil while adding.
    let taskID: String?
    var anchor: Anchor
    let defaults: Defaults
    let title: TokenFieldModel
    let notes: TokenFieldModel
    /// The task as it was when editing began (to keep a draft if it's deleted meanwhile).
    var snapshot: TodoDoc?
    /// What the editor started with: only what the user changed is written back, so a
    /// title or description changed on another device meanwhile isn't overwritten.
    let originalTitle: String
    let originalNotes: String

    init(taskID: String?, anchor: Anchor, defaults: Defaults, title: String = "", notes: String = "") {
        self.taskID = taskID
        self.anchor = anchor
        self.defaults = defaults
        self.title = TokenFieldModel(text: title, parses: true)
        self.notes = TokenFieldModel(text: notes)
        originalTitle = title
        originalNotes = notes
    }
}

/// A searchable list in an overlay: pickers (date, priority, labels, project), go-to,
/// Quick Find, prompts (new project name).
final class PickerModel: ObservableObject, Identifiable {
    struct Item: Identifiable, Equatable {
        var id: String
        var title: String
        var subtitle: String?
        var symbol: String?
        var tint: Color?
        var checked: Bool?
        var hint: String?
    }

    let id = UUID()
    let title: String
    let placeholder: String
    let field = TokenFieldModel()
    @Published private(set) var items: [Item] = []
    @Published var index = 0
    /// Line under the field (e.g. what a typed date means).
    @Published private(set) var preview: String?
    /// Items for a query.
    var source: (String) -> [Item]
    var previewFor: ((String) -> String?)?
    /// Chosen item (nil: Return on a query that matches nothing). Return true to close.
    var onChoose: (Item?, String) -> Bool
    /// Keys 1–4 pick the item at that index straight away (priority picker).
    var digitShortcuts = false
    private var sink: AnyCancellable?

    init(title: String, placeholder: String, source: @escaping (String) -> [Item], onChoose: @escaping (Item?, String) -> Bool) {
        self.title = title
        self.placeholder = placeholder
        self.source = source
        self.onChoose = onChoose
        sink = field.$text.removeDuplicates().sink { [weak self] q in
            DispatchQueue.main.async { self?.refresh(q) }
        }
    }

    func refresh(_ q: String? = nil) {
        let q = q ?? field.text
        if digitShortcuts, let n = Int(q), n >= 1, n <= items.count {
            let item = items[n - 1]
            field.text = ""
            _ = choose(item)
            return
        }
        let keep = items.indices.contains(index) ? items[index].id : nil
        items = source(q)
        index = keep.flatMap { k in items.firstIndex { $0.id == k } } ?? 0
        if !q.isEmpty, keep == nil { index = 0 }
        preview = previewFor?(q)
    }

    func move(_ d: Int) {
        guard !items.isEmpty else { return }
        index = (index + d + items.count) % items.count
    }

    var closeHandler: () -> Void = {}

    @discardableResult
    func choose(_ item: Item? = nil) -> Bool {
        let it = item ?? (items.indices.contains(index) ? items[index] : nil)
        let close = onChoose(it, field.text)
        if close { closeHandler() } else { refresh() }
        return close
    }
}

struct TodoToast: Equatable {
    var message: String
    /// The undo entry its Undo button reverts.
    var undoID: UUID?
    var id = UUID()
    var undoable: Bool { undoID != nil }
}

/// Owns the store, sync, and the todo window's state; every command lives here.
final class TodoController: ObservableObject {
    let store: TodoStore
    let engine: TodoSyncEngine
    let client: TodoSyncClient
    @Published private(set) var settings: TodoSettings

    @Published private(set) var view: TodoListView = .today
    @Published private(set) var rows: [TodoRow] = []
    @Published var focus: String?
    @Published var selection: Set<String> = []
    @Published var editor: TaskEditor?
    @Published var picker: PickerModel?
    @Published var showHelp = false
    @Published var sidebarVisible = true
    @Published var showCompleted = false
    @Published var search: TokenFieldModel?
    @Published private(set) var toast: TodoToast?
    @Published private(set) var projects: [TodoDoc] = []
    @Published private(set) var labels: [String] = []
    @Published private(set) var counts = (inbox: 0, today: 0, overdue: 0, byProject: [String: Int]())
    @Published private(set) var dates = TodoDates()
    @Published private(set) var awaitingChord = false

    let keys = TodoKeyRouter()
    private var back: [TodoListView] = []
    private var forward: [TodoListView] = []
    /// One undoable change: each document before (nil: created) and after it.
    private struct UndoEntry {
        var changes: [(before: TodoDoc?, after: TodoDoc)]
        var message: String
        var id = UUID()
    }
    private var undoStack: [UndoEntry] = []
    private var observers: [NSObjectProtocol] = []
    private var searchSink: AnyCancellable?
    private var toastWork: DispatchWorkItem?
    private var started = false
    private let log = BentoLog.make("todo")

    private(set) var windowController: TodoWindowController?
    private(set) var quickAdd: QuickAddController?

    init() {
        store = TodoStore()
        engine = TodoSyncEngine(repo: store)
        client = TodoSyncClient(engine: engine, profile: .todos)
        settings = ConfigStore.shared.section("todo", default: TodoSettings())
        view = settings.home
        if let raw = store.kv("sidebar") { sidebarVisible = raw != "0" }
        keys.onChordChange = { [weak self] waiting in self?.awaitingChord = waiting }
    }

    // MARK: Lifecycle

    func start() {
        guard !started else { return }
        started = true
        ConfigStore.shared.materialize("todo", default: TodoSettings())
        settings = ConfigStore.shared.section("todo", default: TodoSettings())
        observers.append(ConfigStore.shared.observe("todo") { [weak self] in self?.reloadSettings() })
        observers.append(NotificationCenter.default.addObserver(forName: TodoStore.didChange, object: store, queue: .main) { [weak self] _ in
            self?.refresh()
        })
        // The day rolls over: Today/Upcoming/overdue move (no timers).
        observers.append(NotificationCenter.default.addObserver(forName: .NSCalendarDayChanged, object: nil, queue: .main) { [weak self] _ in
            self?.refresh()
        })
        observers.append(NotificationCenter.default.addObserver(forName: .NSSystemTimeZoneDidChange, object: nil, queue: .main) { [weak self] _ in
            self?.refresh()
        })
        client.configure(settings.sync)
        client.start()
        refresh()
    }

    func stop() {
        guard started else { return }
        started = false
        commitEditor()
        client.stop()
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers = []
        windowController?.close()
        windowController = nil
        quickAdd?.close()
        quickAdd = nil
    }

    private func reloadSettings() {
        let s = ConfigStore.shared.section("todo", default: TodoSettings())
        guard s != settings else { return }
        settings = s
        client.configure(s.sync)
        windowController?.apply(s)
    }

    // MARK: Window

    var window: TodoWindowController {
        if let w = windowController { return w }
        let w = TodoWindowController(controller: self)
        w.apply(settings)
        windowController = w
        return w
    }

    /// Todoist's show/hide: show → focus → hide.
    func toggle() {
        let w = window
        if !w.isVisible {
            w.show()
        } else if !(NSApp.isActive && w.isKey) {
            w.show()
        } else {
            hideWindow()
        }
    }

    func hideWindow() {
        guard let w = windowController, w.isVisible else { return }
        log.debug("hideWindow")
        commitEditor()
        let wasActive = NSApp.isActive && (w.isKey || NSApp.keyWindow == nil)
        let refocus = wasActive && NSApp.windows.filter({ $0.isVisible && $0.canBecomeKey && !($0 is NSPanel) }).isEmpty
        if refocus, let prev = AppActivation.previousApp, prev.processIdentifier != getpid() {
            w.hide(activating: prev)
        } else {
            w.hide()
            if refocus { NSApp.hide(nil) }
        }
    }

    func showQuickAdd(project: String? = nil) {
        let q = quickAdd ?? QuickAddController(controller: self)
        quickAdd = q
        q.show(defaultProject: project)
    }

    // MARK: Refresh

    func refresh() {
        dates = TodoDates()
        projects = store.projects
        labels = store.labels
        let tasks = store.tasks
        counts = TodoQuery.counts(tasks: tasks, projects: projects, dates: dates)
        if case .project(let id) = view, store.doc(id)?.isProject != true { view = settings.home }
        let old = rows
        rows = TodoQuery.rows(for: view, tasks: tasks, projects: projects, showCompleted: showCompleted, dates: dates)
        fixFocus(previous: old)
    }

    /// Keeps the focus on the same task, or on the row now at its position when it left the view.
    private func fixFocus(previous: [TodoRow]) {
        let ids = Set(rows.compactMap { $0.task?.id })
        selection = selection.intersection(ids)
        if let f = focus, ids.contains(f) { return }
        let taskRows = rows.compactMap(\.task)
        guard !taskRows.isEmpty else { focus = nil; return }
        if let f = focus, let i = previous.compactMap(\.task).firstIndex(where: { $0.id == f }) {
            // the next task that is still here, else the previous one
            let prevTasks = previous.compactMap(\.task)
            if let next = prevTasks[i...].first(where: { ids.contains($0.id) }) ?? prevTasks[..<i].last(where: { ids.contains($0.id) }) {
                focus = next.id
                return
            }
        }
        focus = taskRows.first?.id
    }

    var taskIDs: [String] { rows.compactMap { $0.task?.id } }

    func task(_ id: String) -> TodoDoc? { store.doc(id).flatMap { $0.isTask ? $0 : nil } }

    func projectName(_ id: String?) -> String {
        guard let id, let p = store.doc(id), p.isProject else { return "Inbox" }
        return p.name
    }

    var title: String {
        switch view {
        case .inbox: return "Inbox"
        case .today: return "Today"
        case .upcoming: return "Upcoming"
        case .project(let id): return projectName(id)
        case .label(let l): return "@" + l
        case .search: return "Search"
        }
    }

    // MARK: Navigation

    func go(_ v: TodoListView, focusTask: String? = nil, recordHistory: Bool = true) {
        commitEditor()
        if v != view {
            if recordHistory { back.append(view); forward.removeAll() }
            if case .search = v {} else { closeSearch(restore: false) }
            view = v
            selection = []
            focus = nil
        }
        refresh()
        if let t = focusTask, taskIDs.contains(t) { focus = t }
    }

    func goBack() {
        guard let v = back.popLast() else { return }
        forward.append(view)
        go(v, recordHistory: false)
    }

    func goForward() {
        guard let v = forward.popLast() else { return }
        back.append(view)
        go(v, recordHistory: false)
    }

    func moveFocus(_ delta: Int, extend: Bool = false) {
        let ids = taskIDs
        guard !ids.isEmpty else { return }
        let i = focus.flatMap { ids.firstIndex(of: $0) } ?? (delta > 0 ? -1 : ids.count)
        let j = min(max(i + delta, 0), ids.count - 1)
        if extend, let f = focus { selection.insert(f); selection.insert(ids[j]) }
        focus = ids[j]
    }

    func focusEdge(last: Bool) {
        focus = last ? taskIDs.last : taskIDs.first
    }

    // MARK: Keyboard

    /// Key-down in the todo window while no text field has focus. True when consumed.
    func handleKey(_ e: NSEvent) -> Bool {
        if showHelp {
            showHelp = false
            return true
        }
        if picker != nil {
            if e.keyCode == TodoKey.Code.escape { closePicker(); return true }
            return false
        }
        var consumed = false
        let cmd = keys.command(for: e, consumed: &consumed)
        if let cmd { perform(cmd) }
        return consumed
    }

    func perform(_ c: TodoCommand) {
        log.debug("command \(c.rawValue, privacy: .public)")
        switch c {
        case .quickAdd: showQuickAdd(project: view.projectID)
        case .addBottom: beginAdd(top: false)
        case .addTop: beginAdd(top: true)
        case .search: openSearch()
        case .quickFind: openQuickFind()
        case .toggleSidebar:
            sidebarVisible.toggle()
            store.setKV("sidebar", sidebarVisible ? "1" : "0")
        case .help: showHelp = true
        case .undo: undo()
        case .newProject: promptNewProject()
        case .projectActions: openViewActions()
        case .close: escape()
        case .down: moveFocus(1)
        case .up: moveFocus(-1)
        case .top: focusEdge(last: false)
        case .bottom: focusEdge(last: true)
        case .goHome: go(settings.home)
        case .goInbox: go(.inbox)
        case .goToday: go(.today)
        case .goUpcoming: go(.upcoming)
        case .goProject: openGoToProject()
        case .goLabel: openGoToLabel()
        case .back: goBack()
        case .forward: goForward()
        case .openInProject:
            if let f = focus, let t = task(f) { go(t.project.map { store.doc($0)?.isProject == true ? .project($0) : .inbox } ?? .inbox, focusTask: f) }
        case .edit: if let f = focus { beginEdit(f) }
        case .complete: toggleComplete()
        case .schedule: openSchedule()
        case .removeDate: setDue(nil)
        case .priority: openPriority()
        case .p1: setPriority(1)
        case .p2: setPriority(2)
        case .p3: setPriority(3)
        case .p4: setPriority(4)
        case .labels: openLabels()
        case .move: openMove()
        case .select:
            if let f = focus { if selection.contains(f) { selection.remove(f) } else { selection.insert(f) } }
        case .extendDown: moveFocus(1, extend: true)
        case .extendUp: moveFocus(-1, extend: true)
        case .selectAll: selection = Set(taskIDs)
        case .delete: deleteTargets()
        case .moveUp: reorder(-1)
        case .moveDown: reorder(1)
        case .toggleCompleted:
            showCompleted.toggle()
            refresh()
            flash(showCompleted ? "Showing completed tasks" : "Hiding completed tasks")
        case .copy: copyTargets()
        }
    }

    private func escape() {
        if !selection.isEmpty { selection = []; return }
        if search != nil { closeSearch(restore: true); return }
        if settings.escapeKey == "close" { hideWindow() }
    }

    /// Selected tasks in list order, else the focused one.
    var targets: [String] {
        if !selection.isEmpty { return taskIDs.filter(selection.contains) }
        return focus.map { [$0] } ?? []
    }

    // MARK: Editing

    func beginAdd(top: Bool, after: String? = nil) {
        commitEditor()
        var d = TaskEditor.Defaults(project: view.projectID)
        var anchor: TaskEditor.Anchor = top ? .top : .bottom
        switch view {
        case .today:
            d.due = DueDate(date: dates.today, time: nil)
        case .label(let l):
            d.label = l
        case .upcoming:
            // add to the day of the focused task, else today
            let day = focusedGroupDate() ?? dates.today
            d.due = DueDate(date: day, time: nil)
            anchor = .endOfGroup("h:" + day)
        default:
            break
        }
        if let after { anchor = .after(after) }
        editor = makeEditor(taskID: nil, anchor: anchor, defaults: d)
    }

    /// The date of the group the focused row belongs to (Upcoming).
    private func focusedGroupDate() -> String? {
        var date: String?
        for r in rows {
            if case .header(_, _, _, let d) = r { date = d }
            if case .task(let t) = r, t.id == focus { return date }
        }
        return nil
    }

    func beginEdit(_ id: String) {
        guard let t = task(id) else { return }
        commitEditor()
        focus = id
        editor = makeEditor(taskID: id, anchor: .after(id), defaults: .init(project: t.project), title: t.title, notes: t.notes)
        editor?.snapshot = t
    }

    private func makeEditor(taskID: String?, anchor: TaskEditor.Anchor, defaults: TaskEditor.Defaults, title: String = "", notes: String = "") -> TaskEditor {
        let e = TaskEditor(taskID: taskID, anchor: anchor, defaults: defaults, title: title, notes: notes)
        e.title.projects = { [weak self] in self?.projectNames ?? [] }
        e.title.labels = { [weak self] in self?.labels ?? [] }
        e.title.reparse()
        e.title.caret = (title as NSString).length
        DispatchQueue.main.async { e.title.focus() }
        return e
    }

    var projectNames: [String] { projects.filter { !$0.archived }.map(\.name) }

    func cancelEditor() {
        editor = nil
        windowController?.focusList()
    }

    /// Saves the editor's content. Adding: Return keeps an editor open below the new task
    /// (Todoist); `continueAdding: false` closes it.
    func submitEditor(continueAdding: Bool = true) {
        guard let e = editor else { return }
        let text = e.title.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { cancelEditor(); return }
        let notes = e.notes.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let parsed = QuickAddParser.parse(text, projects: projectNames, labels: labels)
        if let id = e.taskID {
            let changedText = text != e.originalTitle.trimmingCharacters(in: .whitespacesAndNewlines)
            let changedNotes = notes != e.originalNotes.trimmingCharacters(in: .whitespacesAndNewlines)
            guard task(id) != nil else {
                // Deleted on another device while editing: a changed draft becomes a new task.
                if changedText || changedNotes, let old = e.snapshot { restoreDraft(old, parsed: changedText ? parsed : nil, notes: changedNotes ? notes : nil) }
                cancelEditor()
                return
            }
            mutate([id], message: nil) { t in
                if changedText { apply(parsed, to: &t, title: true) }
                if changedNotes { t.setNotes(notes) }
            }
            editor = nil
            windowController?.focusList()
            return
        }
        let t = createTask(parsed, notes: notes, defaults: e.defaults, anchor: e.anchor)
        focus = t.id
        if continueAdding {
            let next = makeEditor(taskID: nil, anchor: e.anchor == .top || e.anchor == .bottom ? .after(t.id) : (view == .upcoming ? e.anchor : .after(t.id)), defaults: e.defaults)
            editor = next
        } else {
            editor = nil
            windowController?.focusList()
        }
    }

    /// A copy of `old` (a task deleted elsewhere while it was being edited) with the
    /// editor's changes, as a new task.
    private func restoreDraft(_ old: TodoDoc, parsed: QuickAddResult?, notes: String?) {
        let project = old.project.flatMap { store.doc($0)?.isProject == true ? $0 : nil }
        var t = TodoDoc.newTask(title: old.title, project: project, labels: old.labels, priority: old.priority,
                                due: old.due, order: order(for: .bottom, project: project))
        t.device = client.device
        if let n = notes ?? (old.notes.isEmpty ? nil : old.notes) { t.setNotes(n) }
        if let parsed { apply(parsed, to: &t, title: true) }
        t.dirty = true
        commit([t], previous: [nil], message: "Deleted on another device, saved as a new task")
        focus = t.id
    }

    /// Commits an open editor (window hidden, view changed). Unsaved new text is kept.
    func commitEditor() {
        guard let e = editor else { return }
        if !e.title.text.trimmingCharacters(in: .whitespaces).isEmpty { submitEditor(continueAdding: false) }
        editor = nil
    }

    /// Applies quick-add results to a task. Unknown #projects stay in the title.
    func apply(_ p: QuickAddResult, to t: inout TodoDoc, title setTitle: Bool) {
        var title = p.title
        if let name = p.project {
            if let proj = projects.first(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) {
                if t.project != proj.id {
                    t.setProject(proj.id)
                    t.setOrder(nextOrder(project: proj.id, top: false))
                }
            } else if name.caseInsensitiveCompare("inbox") == .orderedSame {
                t.setProject(nil)
            } else {
                title += " #" + name
            }
        }
        if !p.labels.isEmpty {
            var l = t.labels
            for x in p.labels {
                let name = labels.first { $0.caseInsensitiveCompare(x) == .orderedSame } ?? x
                if !l.contains(where: { $0.caseInsensitiveCompare(name) == .orderedSame }) { l.append(name) }
            }
            t.setLabels(l)
        }
        if let pr = p.priority { t.setPriority(pr) }
        if let d = p.due { t.setDue(d) } else if p.clearDue { t.setDue(nil) }
        if setTitle { t.setTitle(title.isEmpty ? t.title : title) }
    }

    @discardableResult
    func createTask(_ p: QuickAddResult, notes: String = "", defaults: TaskEditor.Defaults, anchor: TaskEditor.Anchor = .bottom) -> TodoDoc {
        let project = defaults.project.flatMap { store.doc($0)?.isProject == true ? $0 : nil }
        var t = TodoDoc.newTask(title: p.title, project: project, labels: defaults.label.map { [$0] } ?? [],
                                due: defaults.due, order: order(for: anchor, project: project))
        t.device = client.device
        apply(p, to: &t, title: true)
        if !notes.isEmpty { t.setNotes(notes) }
        t.dirty = true
        commit([t], previous: [nil], message: nil)
        return t
    }

    /// Fractional orders halve a gap on every insert between the same neighbours; after
    /// ~50 they run out of precision. Respace a project's tasks before that happens.
    private func renumberIfCrowded(project: String?) {
        let siblings = store.tasks.filter { $0.project == project }.sorted(by: TodoQuery.manualOrder)
        let crowded = zip(siblings, siblings.dropFirst()).contains { a, b in b.order - a.order < 1e-6 * max(1, abs(a.order)) }
        guard crowded else { return }
        var out: [TodoDoc] = []
        for (i, t) in siblings.enumerated() {
            var d = t
            d.setOrder(Double(i + 1) * 1024)
            d.dirty = true
            d.device = client.device
            if d != t { out.append(d) }
        }
        store.save(out)
        client.localChange()
    }

    private func order(for anchor: TaskEditor.Anchor, project: String?) -> Double {
        renumberIfCrowded(project: project)
        switch anchor {
        case .top: return nextOrder(project: project, top: true)
        case .bottom, .endOfGroup: return nextOrder(project: project, top: false)
        case .after(let id):
            guard let a = task(id), a.project == project else { return nextOrder(project: project, top: false) }
            let siblings = store.tasks.filter { $0.project == project && !$0.isCompleted }.sorted(by: TodoQuery.manualOrder)
            let next = siblings.drop(while: { $0.id != id }).dropFirst().first
            return TodoQuery.order(between: a.order, and: next?.order)
        }
    }

    func nextOrder(project: String?, top: Bool) -> Double {
        let orders = store.tasks.filter { $0.project == project }.map(\.order)
        return top ? TodoQuery.order(between: nil, and: orders.min()) : TodoQuery.order(between: orders.max(), and: nil)
    }

    // MARK: Mutations

    /// Applies `f` to each task as a local change, with undo.
    func mutate(_ ids: [String], message: String?, _ f: (inout TodoDoc) -> Void) {
        var changed: [TodoDoc] = [], previous: [TodoDoc?] = []
        for id in ids {
            guard let old = store.doc(id) else { continue }
            var d = old
            f(&d)
            guard d != old else { continue }
            d.dirty = true
            d.device = client.device
            changed.append(d)
            previous.append(old)
        }
        guard !changed.isEmpty else { return }
        commit(changed, previous: previous, message: message)
    }

    private func commit(_ docs: [TodoDoc], previous: [TodoDoc?], message: String?) {
        let entry = UndoEntry(changes: Array(zip(previous, docs)), message: message ?? "Change")
        undoStack.append(entry)
        if undoStack.count > 100 { undoStack.removeFirst(undoStack.count - 100) }
        store.save(docs)
        client.localChange()
        if let message { flash(message, undoID: entry.id) }
    }

    /// Reverts the newest change, or the one with `id` (a toast's Undo button).
    func undo(_ id: UUID? = nil) {
        guard let i = id.map({ id in undoStack.lastIndex { $0.id == id } }) ?? (undoStack.isEmpty ? nil : undoStack.count - 1) else {
            flash(id == nil ? "Nothing to undo" : "Already undone")
            return
        }
        let entry = undoStack.remove(at: i)
        var out: [TodoDoc] = []
        for (before, after) in entry.changes {
            guard let cur = store.doc(after.id), var d = TodoController.restore(cur, before: before, after: after) else { continue }
            d.device = client.device
            out.append(d)
        }
        store.save(out)
        client.localChange()
        if let first = entry.changes.first, let b = first.before, b.isTask { focus = b.id }
        flash("Undone: \(entry.message)")
    }

    /// Reverts what one change did (`before` → `after`) to the document as it is now (`cur`),
    /// as a new local change with fresh clocks so it wins everywhere. Only the fields that
    /// change touched, and only where they still hold the value it wrote: edits made since,
    /// here or on another device, are kept. nil when there is nothing left to revert.
    static func restore(_ cur: TodoDoc, before: TodoDoc?, after: TodoDoc) -> TodoDoc? {
        var d = cur
        let c = TodoDoc.nextClock(after: cur.updatedAt, cur.maxClock)
        guard let before else {
            // undo a creation
            guard !cur.deleted else { return nil }
            d.markDeleted(at: c)
            d.dirty = true
            return d
        }
        if after.deleted, !before.deleted {
            // undo a deletion
            guard cur.deleted else { return nil }
            d.deleted = false
            d.type = before.type
            d.fields = before.fields
            for k in d.fields.keys { d.clocks[k] = c }
            d.updatedAt = c
            d.dirty = true
            return d
        }
        guard !cur.deleted else { return nil }
        for k in Set(before.fields.keys).union(after.fields.keys) where before.fields[k] != after.fields[k] && cur.fields[k] == after.fields[k] {
            d.set(k, before.fields[k] ?? .null, at: c)
        }
        guard d != cur else { return nil }
        d.dirty = true
        return d
    }

    func flash(_ message: String, undoID: UUID? = nil) {
        let t = TodoToast(message: message, undoID: undoID)
        toast = t
        toastWork?.cancel()
        let w = DispatchWorkItem { [weak self] in if self?.toast?.id == t.id { self?.toast = nil } }
        toastWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + (undoID != nil ? 6 : 2.5), execute: w)
    }

    private func plural(_ n: Int, _ s: String) -> String { n == 1 ? "1 \(s)" : "\(n) \(s)s" }

    func toggleComplete(_ ids: [String]? = nil) {
        let ids = ids ?? targets
        guard !ids.isEmpty else { return }
        let completing = ids.contains { task($0)?.isCompleted == false }
        let now = TodoDoc.now()
        mutate(ids, message: completing ? (ids.count == 1 ? "Task completed" : "\(ids.count) tasks completed") : "Marked \(plural(ids.count, "task")) not done") { t in
            t.setCompleted(completing ? now : nil)
        }
        selection = []
        NSSound(named: completing ? "Pop" : "Tink")?.play()
    }

    func setDue(_ d: DueDate?, ids: [String]? = nil) {
        let ids = ids ?? targets
        guard !ids.isEmpty else { return }
        mutate(ids, message: d.map { "Scheduled for \(dates.label($0))" } ?? "Date removed") { $0.setDue(d) }
    }

    func setPriority(_ p: Int, ids: [String]? = nil) {
        let ids = ids ?? targets
        guard !ids.isEmpty else { return }
        mutate(ids, message: "Priority \(p)") { $0.setPriority(p) }
    }

    func move(_ ids: [String], to project: String?) {
        var order = nextOrder(project: project, top: false)
        mutate(ids, message: "Moved to \(projectName(project))") { t in
            guard t.project != project else { return }
            t.setProject(project)
            t.setOrder(order)
            order += 1024
        }
    }

    func deleteTargets() {
        let ids = targets
        guard !ids.isEmpty else { return }
        mutate(ids, message: ids.count == 1 ? "Task deleted" : "\(ids.count) tasks deleted") { $0.markDeleted() }
        selection = []
    }

    /// Moves the focused task one place up/down in a manually ordered view.
    func reorder(_ delta: Int) {
        guard view.isManualOrder else { flash("Tasks are sorted by date here"); return }
        guard let f = focus, selection.isEmpty || selection == [f] else { return }
        renumberIfCrowded(project: task(f)?.project)
        // fresh from the store: the renumbering above isn't in `rows` yet
        let list = rows.compactMap { $0.task.flatMap { self.task($0.id) } }.filter { !$0.isCompleted }
        guard let i = list.firstIndex(where: { $0.id == f }) else { return }
        let j = i + delta
        guard list.indices.contains(j) else { return }
        // place beyond the neighbour: between it and the one after it
        let neighbour = list[j]
        let beyond = list.indices.contains(j + delta) ? list[j + delta].order : nil
        let o = delta < 0 ? TodoQuery.order(between: beyond, and: neighbour.order) : TodoQuery.order(between: neighbour.order, and: beyond)
        mutate([f], message: nil) { $0.setOrder(o) }
    }

    func copyTargets() {
        let ts = targets.compactMap(task)
        guard !ts.isEmpty else { return }
        let md = ts.map { t -> String in
            var s = "- [\(t.isCompleted ? "x" : " ")] \(t.title)"
            if let d = t.due { s += " (\(dates.label(d)))" }
            return s
        }.joined(separator: "\n")
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(md, forType: .string)
        flash("Copied \(plural(ts.count, "task"))")
    }

    // MARK: Projects

    @discardableResult
    func createProject(name: String, color: String = "grey") -> TodoDoc {
        let order = (projects.map(\.order).max() ?? 0) + 1024
        var p = TodoDoc.newProject(name: name, color: color, order: order)
        p.device = client.device
        p.dirty = true
        commit([p], previous: [nil], message: "Project “\(name)” created")
        return p
    }

    private static func same(_ a: String, _ b: String) -> Bool { a.caseInsensitiveCompare(b) == .orderedSame }

    func renameLabel(_ old: String, to new: String) {
        let ids = store.tasks.filter { $0.labels.contains { Self.same($0, old) } }.map(\.id)
        mutate(ids, message: "Label renamed") { t in
            var seen = Set<String>()
            t.setLabels(t.labels.map { Self.same($0, old) ? new : $0 }.filter { seen.insert($0.lowercased()).inserted })
        }
        if view == .label(old) { go(.label(new), recordHistory: false) }
    }

    func deleteLabel(_ name: String) {
        let ids = store.tasks.filter { $0.labels.contains { Self.same($0, name) } }.map(\.id)
        mutate(ids, message: "Label @\(name) removed") { t in t.setLabels(t.labels.filter { !Self.same($0, name) }) }
        if view == .label(name) { go(settings.home) }
    }

    func deleteProject(_ id: String) {
        guard let p = store.doc(id), p.isProject else { return }
        let ids = [id] + store.allDocs.filter { $0.isTask && $0.project == id }.map(\.id)
        mutate(ids, message: "Project “\(p.name)” deleted") { $0.markDeleted() }
        if view == .project(id) { go(settings.home) }
    }

    // MARK: Search

    func openSearch() {
        commitEditor()
        if let s = search { s.focus(); return }
        let s = TokenFieldModel()
        search = s
        let previous = view
        if case .search = view {} else { back.append(previous); forward.removeAll() }
        view = .search("")
        refresh()
        searchSink = s.$text.removeDuplicates().dropFirst().sink { [weak self] q in
            DispatchQueue.main.async {
                guard let self, self.search === s else { return }
                self.view = .search(q)
                self.refresh()
            }
        }
        DispatchQueue.main.async { s.focus() }
    }

    func closeSearch(restore: Bool) {
        guard search != nil else { return }
        search = nil
        searchSink = nil
        if restore, case .search = view { goBack() }
        windowController?.focusList()
    }

    /// Return/↓ in the search field: move to the results.
    func searchToResults() {
        windowController?.focusList()
        if focus == nil { focus = taskIDs.first }
    }

    // MARK: Pickers

    func present(_ p: PickerModel) {
        commitEditor()
        p.closeHandler = { [weak self, weak p] in
            guard let self, self.picker === p else { return }
            self.closePicker()
        }
        picker = p
        p.refresh("")
        DispatchQueue.main.async { p.field.focus() }
    }

    func closePicker() {
        picker = nil
        windowController?.focusList()
    }

    private func requireTargets() -> [String]? {
        let t = targets
        if t.isEmpty { NSSound.beep(); return nil }
        return t
    }

    func openSchedule() {
        guard let ids = requireTargets() else { return }
        let dates = self.dates
        let today = dates.today
        func item(_ id: String, _ title: String, _ due: DueDate?, _ symbol: String, _ tint: Color) -> PickerModel.Item {
            .init(id: id, title: title, subtitle: due.map { dates.header($0.date).title }, symbol: symbol, tint: tint)
        }
        let saturday: String = {
            var d = today
            for _ in 0..<7 {
                d = dates.adding(days: 1, to: d)
                if let x = dates.date(d), dates.calendar.component(.weekday, from: x) == 7 { return d }
            }
            return d
        }()
        let monday: String = {
            var d = today
            for _ in 0..<7 {
                d = dates.adding(days: 1, to: d)
                if let x = dates.date(d), dates.calendar.component(.weekday, from: x) == 2 { return d }
            }
            return d
        }()
        let fixed: [(PickerModel.Item, DueDate?)] = [
            (item("today", "Today", DueDate(date: today, time: nil), "calendar", .green), DueDate(date: today, time: nil)),
            (item("tomorrow", "Tomorrow", DueDate(date: dates.adding(days: 1, to: today), time: nil), "sun.max", .orange), DueDate(date: dates.adding(days: 1, to: today), time: nil)),
            (item("weekend", "This weekend", DueDate(date: saturday, time: nil), "sofa", .blue), DueDate(date: saturday, time: nil)),
            (item("nextweek", "Next week", DueDate(date: monday, time: nil), "arrow.right.to.line", .purple), DueDate(date: monday, time: nil)),
            (.init(id: "none", title: "No date", symbol: "nosign", tint: .secondary), nil),
        ]
        let p = PickerModel(title: ids.count == 1 ? "Schedule" : "Schedule \(ids.count) tasks", placeholder: "Type a date: tomorrow 5pm, fri, 25 oct, in 3 days…",
                            source: { q in
                                guard !q.isEmpty else { return fixed.map(\.0) }
                                var items: [PickerModel.Item] = []
                                switch DateParser.parsePhrase(q) {
                                case .due(let d)?:
                                    items.append(.init(id: "typed", title: dates.label(d), subtitle: dates.header(d.date).title, symbol: "calendar.badge.plus", tint: .accentColor))
                                case .clear?:
                                    return fixed.map(\.0).filter { $0.id == "none" }
                                case nil:
                                    break
                                }
                                return items + fixed.map(\.0).filter { $0.title.lowercased().contains(q.lowercased()) }
                            }, onChoose: { [weak self] item, q in
                                guard let self, let item else { return false }
                                if item.id == "typed", let d = DateParser.parse(q) {
                                    self.setDue(d, ids: ids)
                                } else if let f = fixed.first(where: { $0.0.id == item.id }) {
                                    self.setDue(f.1, ids: ids)
                                }
                                return true
                            })
        p.previewFor = { q in q.isEmpty || DateParser.parsePhrase(q) != nil ? nil : "Not a date yet" }
        present(p)
    }

    func openPriority() {
        guard let ids = requireTargets() else { return }
        let current = ids.count == 1 ? task(ids[0])?.priority : nil
        let p = PickerModel(title: "Priority", placeholder: "1–4", source: { q in
            (1...4).map { n in
                PickerModel.Item(id: "\(n)", title: "Priority \(n)", symbol: n == 4 ? "flag" : "flag.fill",
                                 tint: Color(nsColor: TodoStyle.priority(n)), checked: current == n ? true : nil, hint: "\(n)")
            }.filter { q.isEmpty || $0.title.lowercased().contains(q.lowercased()) || $0.id == q }
        }, onChoose: { [weak self] item, _ in
            guard let self, let item, let n = Int(item.id) else { return false }
            self.setPriority(n, ids: ids)
            return true
        })
        p.digitShortcuts = true
        present(p)
    }

    func openLabels() {
        guard let ids = requireTargets() else { return }
        let p = PickerModel(title: "Labels", placeholder: "Filter or create a label (↩ toggles, Esc closes)", source: { [weak self] q in
            guard let self else { return [] }
            let ts = ids.compactMap(self.task)
            var items = self.labels.filter { q.isEmpty || $0.lowercased().contains(q.lowercased()) }.map { l -> PickerModel.Item in
                let all = ts.allSatisfy { $0.labels.contains(l) }
                return .init(id: "l:" + l, title: l, symbol: "tag", tint: Color(nsColor: TodoStyle.tokenColor(.label)), checked: all)
            }
            let clean = q.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "@", with: "")
            if !clean.isEmpty, !self.labels.contains(where: { $0.caseInsensitiveCompare(clean) == .orderedSame }) {
                items.append(.init(id: "new:" + clean, title: "Create “\(clean)”", symbol: "plus"))
            }
            return items
        }, onChoose: { [weak self] item, _ in
            guard let self, let item else { return false }
            let name = item.id.hasPrefix("new:") ? String(item.id.dropFirst(4)) : String(item.id.dropFirst(2))
            let remove = item.checked == true
            self.mutate(ids, message: nil) { t in
                var l = t.labels
                if remove { l.removeAll { $0 == name } } else if !l.contains(name) { l.append(name) }
                t.setLabels(l)
            }
            self.labels = self.store.labels
            if item.id.hasPrefix("new:") { self.picker?.field.text = "" }
            return false
        })
        present(p)
    }

    func openMove() {
        guard let ids = requireTargets() else { return }
        let current = Set(ids.compactMap { task($0)?.project ?? "" })
        let p = PickerModel(title: "Move to", placeholder: "Project", source: { [weak self] q in
            guard let self else { return [] }
            let all: [PickerModel.Item] = [PickerModel.Item(id: "", title: "Inbox", symbol: "tray", tint: .blue, checked: current == [""] ? true : nil)]
                + self.projects.filter { !$0.archived }.map {
                    .init(id: $0.id, title: $0.name, symbol: "number", tint: TodoStyle.project($0.color), checked: current == [$0.id] ? true : nil)
                }
            return all.filter { q.isEmpty || $0.title.lowercased().contains(q.lowercased()) }
        }, onChoose: { [weak self] item, _ in
            guard let self, let item else { return false }
            self.move(ids, to: item.id.isEmpty ? nil : item.id)
            return true
        })
        present(p)
    }

    func openGoToProject() {
        let p = PickerModel(title: "Go to project", placeholder: "Project", source: { [weak self] q in
            guard let self else { return [] }
            return ([PickerModel.Item(id: "", title: "Inbox", symbol: "tray", tint: .blue, hint: "\(self.counts.inbox)")]
                + self.projects.map {
                    .init(id: $0.id, title: $0.name, subtitle: $0.archived ? "Archived" : nil, symbol: "number",
                          tint: TodoStyle.project($0.color), hint: "\(self.counts.byProject[$0.id] ?? 0)")
                }).filter { q.isEmpty || $0.title.lowercased().contains(q.lowercased()) }
        }, onChoose: { [weak self] item, _ in
            guard let self, let item else { return false }
            self.go(item.id.isEmpty ? .inbox : .project(item.id))
            return true
        })
        present(p)
    }

    func openGoToLabel() {
        let p = PickerModel(title: "Go to label", placeholder: "Label", source: { [weak self] q in
            (self?.labels ?? []).filter { q.isEmpty || $0.lowercased().contains(q.lowercased()) }.map {
                .init(id: $0, title: $0, symbol: "tag", tint: Color(nsColor: TodoStyle.tokenColor(.label)))
            }
        }, onChoose: { [weak self] item, _ in
            guard let self, let item else { return false }
            self.go(.label(item.id))
            return true
        })
        present(p)
    }

    /// ⌘K: views, projects, labels and tasks in one list.
    func openQuickFind() {
        let p = PickerModel(title: "Quick Find", placeholder: "Search views, projects, labels and tasks", source: { [weak self] q in
            guard let self else { return [] }
            let lq = q.lowercased()
            var items: [PickerModel.Item] = [
                .init(id: "v:inbox", title: "Inbox", symbol: "tray", tint: .blue, hint: "G I"),
                .init(id: "v:today", title: "Today", symbol: "calendar", tint: .green, hint: "G T"),
                .init(id: "v:upcoming", title: "Upcoming", symbol: "calendar.badge.clock", tint: .purple, hint: "G U"),
            ]
            items += self.projects.map { .init(id: "p:" + $0.id, title: $0.name, subtitle: $0.archived ? "Archived project" : "Project", symbol: "number", tint: TodoStyle.project($0.color)) }
            items += self.labels.map { .init(id: "l:" + $0, title: $0, subtitle: "Label", symbol: "tag", tint: Color(nsColor: TodoStyle.tokenColor(.label))) }
            var out = items.filter { lq.isEmpty || $0.title.lowercased().contains(lq) }
            if !lq.isEmpty {
                let tasks = self.store.tasks.filter { $0.title.lowercased().contains(lq) }
                    .sorted { a, b in a.isCompleted != b.isCompleted ? !a.isCompleted : TodoQuery.manualOrder(a, b) }
                out += tasks.prefix(30).map {
                    .init(id: "t:" + $0.id, title: $0.title, subtitle: self.projectName($0.project) + ($0.isCompleted ? " · completed" : ""),
                          symbol: $0.isCompleted ? "checkmark.circle" : "circle", tint: Color(nsColor: TodoStyle.priority($0.priority)))
                }
            }
            return out
        }, onChoose: { [weak self] item, _ in
            guard let self, let item else { return false }
            let rest = String(item.id.dropFirst(2))
            switch item.id.prefix(2) {
            case "v:": self.go(rest == "inbox" ? .inbox : rest == "today" ? .today : .upcoming)
            case "p:": self.go(.project(rest))
            case "l:": self.go(.label(rest))
            case "t:":
                guard let t = self.task(rest) else { return true }
                if t.isCompleted, !self.showCompleted { self.showCompleted = true }
                self.go(t.project.flatMap { self.store.doc($0)?.isProject == true ? .project($0) : nil } ?? .inbox, focusTask: rest)
            default: break
            }
            return true
        })
        present(p)
    }

    func promptNewProject() {
        let p = PickerModel(title: "New project", placeholder: "Project name", source: { q in
            let n = q.trimmingCharacters(in: .whitespaces)
            return n.isEmpty ? [] : [.init(id: "create", title: "Create “\(n)”", symbol: "plus")]
        }, onChoose: { [weak self] _, q in
            guard let self else { return true }
            let n = q.trimmingCharacters(in: .whitespaces)
            guard !n.isEmpty else { return false }
            let proj = self.createProject(name: n)
            self.go(.project(proj.id))
            return true
        })
        present(p)
    }

    /// `w`: actions for the current project or label.
    func openViewActions() {
        switch view {
        case .project(let id):
            guard let proj = store.doc(id) else { return }
            let p = PickerModel(title: proj.name, placeholder: "Project actions", source: { q in
                [
                    PickerModel.Item(id: "rename", title: "Rename…", symbol: "pencil"),
                    PickerModel.Item(id: "color", title: "Colour…", symbol: "paintpalette", tint: TodoStyle.project(proj.color)),
                    PickerModel.Item(id: "up", title: "Move up in the sidebar", symbol: "arrow.up"),
                    PickerModel.Item(id: "down", title: "Move down in the sidebar", symbol: "arrow.down"),
                    PickerModel.Item(id: "archive", title: proj.archived ? "Unarchive" : "Archive", symbol: "archivebox"),
                    PickerModel.Item(id: "delete", title: "Delete project and its tasks", symbol: "trash", tint: .red),
                ].filter { q.isEmpty || $0.title.lowercased().contains(q.lowercased()) }
            }, onChoose: { [weak self] item, _ in
                guard let self, let item else { return false }
                switch item.id {
                case "rename": DispatchQueue.main.async { self.promptRenameProject(id) }
                case "color": DispatchQueue.main.async { self.openProjectColor(id) }
                case "up", "down": self.moveProject(id, item.id == "up" ? -1 : 1)
                case "archive": self.mutate([id], message: proj.archived ? "Unarchived" : "Archived") { $0.setArchived(!proj.archived) }
                case "delete": self.deleteProject(id)
                default: break
                }
                return true
            })
            present(p)
        case .label(let name):
            let p = PickerModel(title: "@" + name, placeholder: "Label actions", source: { _ in
                [PickerModel.Item(id: "rename", title: "Rename…", symbol: "pencil"),
                 PickerModel.Item(id: "delete", title: "Remove from all tasks", symbol: "trash", tint: .red)]
            }, onChoose: { [weak self] item, _ in
                guard let self, let item else { return false }
                if item.id == "rename" { DispatchQueue.main.async { self.promptRenameLabel(name) } } else { self.deleteLabel(name) }
                return true
            })
            present(p)
        default:
            NSSound.beep()
        }
    }

    private func promptRenameProject(_ id: String) {
        guard let proj = store.doc(id) else { return }
        let p = PickerModel(title: "Rename project", placeholder: proj.name, source: { q in
            q.trimmingCharacters(in: .whitespaces).isEmpty ? [] : [.init(id: "ok", title: "Rename to “\(q)”", symbol: "pencil")]
        }, onChoose: { [weak self] _, q in
            let n = q.trimmingCharacters(in: .whitespaces)
            guard let self, !n.isEmpty else { return false }
            self.mutate([id], message: "Renamed") { $0.setName(n) }
            return true
        })
        present(p)
        p.field.text = proj.name
        p.field.caret = (proj.name as NSString).length
    }

    private func promptRenameLabel(_ name: String) {
        let p = PickerModel(title: "Rename label", placeholder: name, source: { q in
            q.trimmingCharacters(in: .whitespaces).isEmpty ? [] : [.init(id: "ok", title: "Rename to “\(q)”", symbol: "pencil")]
        }, onChoose: { [weak self] _, q in
            let n = q.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: " ", with: "_")
            guard let self, !n.isEmpty else { return false }
            self.renameLabel(name, to: n)
            return true
        })
        present(p)
        p.field.text = name
    }

    private func openProjectColor(_ id: String) {
        let p = PickerModel(title: "Colour", placeholder: "Colour", source: { q in
            TodoStyle.palette.map { PickerModel.Item(id: $0.name, title: TodoStyle.title($0.name), symbol: "circle.fill", tint: $0.color) }
                .filter { q.isEmpty || $0.title.lowercased().contains(q.lowercased()) }
        }, onChoose: { [weak self] item, _ in
            guard let self, let item else { return false }
            self.mutate([id], message: nil) { $0.setColor(item.id) }
            return true
        })
        present(p)
    }

    private func moveProject(_ id: String, _ delta: Int) {
        let list = projects.filter { !$0.archived }
        guard let i = list.firstIndex(where: { $0.id == id }), list.indices.contains(i + delta) else { return }
        let j = i + delta
        let beyond = list.indices.contains(j + delta) ? list[j + delta].order : nil
        let o = delta < 0 ? TodoQuery.order(between: beyond, and: list[j].order) : TodoQuery.order(between: list[j].order, and: beyond)
        mutate([id], message: nil) { $0.setOrder(o) }
    }

    // MARK: Settings / diagnostics

    func makeSettingsView(actions: [BentoAction]) -> AnyView {
        AnyView(TodoSettingsView(status: client.status, actions: actions, syncNow: { [weak self] in self?.client.syncNow() }))
    }

    var diagnostics: [String: Any] {
        [
            "tasks": store.tasks.count,
            "projects": projects.count,
            "pending": engine.pendingCount,
            "lastSeq": store.lastSeq,
            "sync": client.status.summary,
            "windowVisible": windowController?.isVisible ?? false,
        ]
    }
}
