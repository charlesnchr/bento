import AppKit
import SwiftUI
import BentoCore

struct TodoRootView: View {
    @ObservedObject var c: TodoController

    var body: some View {
        HStack(spacing: 0) {
            if c.sidebarVisible {
                TodoSidebar(c: c)
                    .frame(width: 220)
                    .themedBackground(VisualEffect(material: .sidebar))
                Divider()
            }
            VStack(spacing: 0) {
                TodoHeader(c: c)
                TodoList(c: c)
                TodoFooter(c: c, status: c.client.status)
            }
            .themedBackground(Color(nsColor: .textBackgroundColor))
        }
        .background(ThemeBackdrop().ignoresSafeArea())
        .overlay {
            if let p = c.picker { PickerOverlay(model: p, close: { c.closePicker() }) }
        }
        .overlay {
            if c.showHelp { HelpOverlay(close: { c.showHelp = false }) }
        }
        .ignoresSafeArea()
        .frame(minWidth: TodoStyle.minWidth(sidebar: c.sidebarVisible), minHeight: TodoStyle.minHeight)
    }
}

// MARK: - Sidebar

struct TodoSidebar: View {
    @ObservedObject var c: TodoController

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 1) {
                item(.inbox, "Inbox", "tray.fill", .blue, count: c.counts.inbox)
                item(.today, "Today", "calendar", .green, count: c.counts.today, alert: c.counts.overdue > 0)
                item(.upcoming, "Upcoming", "calendar.badge.clock", .purple, count: nil)

                sectionHeader("Projects", add: { c.promptNewProject() })
                ForEach(c.projects.filter { !$0.archived }, id: \.id) { p in
                    item(.project(p.id), p.name, "number", TodoStyle.project(p.color), count: c.counts.byProject[p.id])
                }
                if !c.labels.isEmpty {
                    sectionHeader("Labels", add: nil)
                    ForEach(c.labels, id: \.self) { l in
                        item(.label(l), l, "tag", Color(nsColor: TodoStyle.tokenColor(.label)), count: nil)
                    }
                }
            }
            .padding(.horizontal, 10)
            .padding(.top, 40)
            .padding(.bottom, 12)
        }
    }

    private func sectionHeader(_ title: String, add: (() -> Void)?) -> some View {
        HStack {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            Spacer()
            if let add {
                Button(action: add) { Image(systemName: "plus") }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                    .help("New project (⌥P)")
            }
        }
        .padding(.horizontal, 8)
        .padding(.top, 14)
        .padding(.bottom, 4)
    }

    private func item(_ v: TodoListView, _ title: String, _ symbol: String, _ tint: Color, count: Int?, alert: Bool = false) -> some View {
        let active = c.view == v
        return HStack(spacing: 8) {
            Image(systemName: symbol).foregroundStyle(tint).frame(width: 18)
            Text(title).lineLimit(1)
            Spacer()
            if let count, count > 0 {
                Text("\(count)").font(.caption).monospacedDigit()
                    .foregroundStyle(alert ? Color(nsColor: TodoStyle.priority(1)) : .secondary)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(active ? Color.accentColor.opacity(0.18) : .clear, in: RoundedRectangle(cornerRadius: 6))
        .contentShape(Rectangle())
        .onTapGesture { c.go(v) }
    }
}

// MARK: - Header

struct TodoHeader: View {
    @ObservedObject var c: TodoController

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            if let s = c.search {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TokenField(model: s, placeholder: "Search tasks, #projects, @labels", font: .systemFont(ofSize: 18),
                               onSubmit: { _ in c.searchToResults() }, onCancel: { c.closeSearch(restore: true) },
                               onArrow: { d in if d > 0 { c.searchToResults(); return true }; return false })
                }
            } else {
                if case .project(let id) = c.view, let p = c.store.doc(id) {
                    Circle().fill(TodoStyle.project(p.color)).frame(width: 10, height: 10)
                }
                Text(c.title).font(.title2.weight(.bold)).lineLimit(1)
                if c.view == .today {
                    Text(c.dates.header(c.dates.today).title).font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                if c.showCompleted {
                    Label("Completed shown", systemImage: "checkmark.circle").font(.caption).foregroundStyle(.secondary)
                }
                if !c.selection.isEmpty {
                    Text("\(c.selection.count) selected").font(.caption.weight(.medium))
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Color.accentColor.opacity(0.18), in: Capsule())
                }
                if c.awaitingChord {
                    Text("G…").font(.caption.monospaced()).padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Color.secondary.opacity(0.18), in: RoundedRectangle(cornerRadius: 4))
                }
            }
        }
        .padding(.horizontal, 24)
        .padding(.top, c.sidebarVisible ? 18 : 34)
        .padding(.bottom, 10)
    }
}

// MARK: - List

struct TodoList: View {
    @ObservedObject var c: TodoController

    enum Item: Identifiable {
        case row(TodoRow)
        case editor(TaskEditor)

        var id: String {
            switch self {
            case .row(let r): return r.id
            case .editor(let e): return "editor-" + e.id.uuidString
            }
        }
    }

    /// Rows with the inline editor placed where it belongs.
    var items: [Item] {
        var out = c.rows.map(Item.row)
        guard let e = c.editor else { return out }
        if let id = e.taskID, let i = out.firstIndex(where: { $0.id == id }) {
            out[i] = .editor(e)
            return out
        }
        var at = out.count
        switch e.anchor {
        case .top:
            at = 0
        case .bottom:
            at = out.firstIndex { $0.id == "h:completed" } ?? out.count
        case .after(let id):
            at = out.firstIndex { $0.id == id }.map { $0 + 1 } ?? out.count
        case .endOfGroup(let hid):
            if let h = out.firstIndex(where: { $0.id == hid }) {
                at = out[(h + 1)...].firstIndex { if case .row(.header) = $0 { return true }; return false } ?? out.count
            }
        }
        out.insert(.editor(e), at: at)
        return out
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(items) { item in
                        switch item {
                        case .row(.header(let id, let title, let subtitle, _)):
                            GroupHeader(title: title, subtitle: subtitle, first: c.rows.first?.id == "h:" + id)
                        case .row(.task(let t)):
                            TaskRow(c: c, t: t, focused: c.focus == t.id, selected: c.selection.contains(t.id))
                                .id(t.id)
                        case .editor(let e):
                            EditorRow(e: e, c: c).id(item.id)
                        }
                    }
                    if c.rows.allSatisfy({ $0.task == nil }) && c.editor == nil {
                        EmptyState(view: c.view)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .onChange(of: c.focus) { id in
                guard let id else { return }
                proxy.scrollTo(id)
            }
            .onChange(of: c.editor?.id) { _ in
                if let e = c.editor { proxy.scrollTo("editor-" + e.id.uuidString) }
            }
        }
    }
}

struct GroupHeader: View {
    let title: String
    let subtitle: String?
    let first: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(title).font(.subheadline.weight(.semibold))
                if let subtitle { Text("· " + subtitle).font(.subheadline).foregroundStyle(.secondary) }
            }
            Divider()
        }
        .padding(.horizontal, 8)
        .padding(.top, first ? 4 : 18)
        .padding(.bottom, 2)
    }
}

struct EmptyState: View {
    let view: TodoListView

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: symbol).font(.system(size: 34)).foregroundStyle(.tertiary)
            Text(message).foregroundStyle(.secondary)
            Text(hint).font(.caption).foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 80)
    }

    private var symbol: String {
        switch view {
        case .today: return "sun.max"
        case .search: return "magnifyingglass"
        default: return "checkmark.circle"
        }
    }

    private var message: String {
        switch view {
        case .today: return "Nothing due today."
        case .inbox: return "Your inbox is empty."
        case .search(let q): return q.isEmpty ? "Type to search." : "No tasks match “\(q)”."
        default: return "No tasks here."
        }
    }

    private var hint: String {
        if case .search = view { return "Esc goes back" }
        return "A adds a task · Q opens Quick Add · ? shows all shortcuts"
    }
}

struct PriorityCircle: View {
    let priority: Int
    let completed: Bool

    var body: some View {
        let color = Color(nsColor: TodoStyle.priority(priority))
        ZStack {
            Circle().fill(color.opacity(completed ? 0.9 : (priority < 4 ? 0.12 : 0)))
            Circle().strokeBorder(color, lineWidth: 1.5)
            if completed {
                Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)).foregroundStyle(.white)
            }
        }
        .frame(width: 18, height: 18)
    }
}

struct TaskRow: View {
    @ObservedObject var c: TodoController
    let t: TodoDoc
    let focused: Bool
    let selected: Bool

    private var showProject: Bool {
        switch c.view {
        case .project, .inbox: return false
        default: return true
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            // Not a Button: the row's tap gestures swallow its clicks. The whole circle is
            // the target (an unfilled p4 circle would otherwise only take clicks on its ring).
            PriorityCircle(priority: t.priority, completed: t.isCompleted)
                .contentShape(Circle())
                .highPriorityGesture(TapGesture().onEnded { c.toggleComplete([t.id]) })
                .accessibilityElement()
                .accessibilityLabel(t.isCompleted ? "Mark \(t.title) not done" : "Complete \(t.title)")
                .accessibilityAddTraits(.isButton)
                .accessibilityAction { c.toggleComplete([t.id]) }
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                Text(t.title.isEmpty ? "Untitled" : t.title)
                    .strikethrough(t.isCompleted)
                    .foregroundStyle(t.isCompleted || t.title.isEmpty ? .secondary : .primary)
                    .lineLimit(3)
                if let line = t.notes.split(separator: "\n").first {
                    Text(line).font(.callout).foregroundStyle(.secondary).lineLimit(1)
                }
                if t.due != nil || !t.labels.isEmpty {
                    HStack(spacing: 10) {
                        if let d = t.due {
                            Label(c.dates.label(d), systemImage: "calendar")
                                .foregroundStyle(TodoStyle.due(d, dates: c.dates))
                        }
                        ForEach(t.labels, id: \.self) { l in
                            Label(l, systemImage: "tag").foregroundStyle(Color(nsColor: TodoStyle.tokenColor(.label)))
                        }
                    }
                    .font(.caption)
                    .labelStyle(TightLabel())
                }
            }
            Spacer(minLength: 8)
            if showProject {
                HStack(spacing: 4) {
                    Text(c.projectName(t.project)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    if let p = t.project.flatMap({ c.store.doc($0) }), p.isProject {
                        Circle().fill(TodoStyle.project(p.color)).frame(width: 7, height: 7)
                    } else {
                        Image(systemName: "tray").font(.caption2).foregroundStyle(.secondary)
                    }
                }
                .padding(.top, 2)
            }
        }
        .padding(.vertical, 7)
        .padding(.horizontal, 8)
        .background(background, in: RoundedRectangle(cornerRadius: 6))
        .overlay(alignment: .leading) {
            if selected {
                RoundedRectangle(cornerRadius: 1.5).fill(Color.accentColor).frame(width: 3).padding(.vertical, 6)
            }
        }
        .contentShape(Rectangle())
        .gesture(TapGesture(count: 2).onEnded { c.beginEdit(t.id) })
        .simultaneousGesture(TapGesture().onEnded { click() })
        .contextMenu { menu }
    }

    private var background: Color {
        if focused { return Color.accentColor.opacity(selected ? 0.24 : 0.14) }
        if selected { return Color.accentColor.opacity(0.10) }
        return .clear
    }

    private func click() {
        let f = NSEvent.modifierFlags
        if f.contains(.command) {
            if c.selection.contains(t.id) { c.selection.remove(t.id) } else { c.selection.insert(t.id) }
            if let cur = c.focus, c.selection.count == 1, cur != t.id { c.selection.insert(cur) }
        } else if f.contains(.shift), let cur = c.focus, let a = c.taskIDs.firstIndex(of: cur), let b = c.taskIDs.firstIndex(of: t.id) {
            c.selection.formUnion(c.taskIDs[min(a, b)...max(a, b)])
        } else {
            c.selection = []
        }
        c.focus = t.id
        c.windowController?.focusList()
    }

    @ViewBuilder private var menu: some View {
        Button("Edit") { c.beginEdit(t.id) }
        Button(t.isCompleted ? "Mark Not Done" : "Complete") { c.toggleComplete([t.id]) }
        Divider()
        Button("Schedule…") { c.focus = t.id; c.openSchedule() }
        Button("Priority…") { c.focus = t.id; c.openPriority() }
        Button("Labels…") { c.focus = t.id; c.openLabels() }
        Button("Move to…") { c.focus = t.id; c.openMove() }
        Divider()
        Button("Delete", role: .destructive) { c.focus = t.id; c.selection = []; c.deleteTargets() }
    }
}

struct TightLabel: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 3) { configuration.icon; configuration.title }
    }
}

// MARK: - Editor

struct EditorRow: View {
    @ObservedObject var e: TaskEditor
    @ObservedObject var title: TokenFieldModel
    let c: TodoController

    init(e: TaskEditor, c: TodoController) {
        self.e = e
        self.title = e.title
        self.c = c
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TokenField(model: e.title, placeholder: "Task name, e.g. Pay rent tomorrow p1 #Home @admin",
                       font: .systemFont(ofSize: 14, weight: .medium),
                       onSubmit: { f in c.submitEditor(continueAdding: e.taskID == nil && !f.contains(.command)) },
                       onCancel: { c.cancelEditor() },
                       onTab: { back in if !back { e.notes.focus() }; return true })
            CompletionList(model: e.title, colorOf: { name in
                TodoStyle.project(c.projects.first { $0.name == name }?.color ?? "grey")
            })
            TokenField(model: e.notes, placeholder: "Description", font: .systemFont(ofSize: 12), multiline: true,
                       onSubmit: { f in c.submitEditor(continueAdding: e.taskID == nil && !f.contains(.command)) },
                       onCancel: { c.cancelEditor() },
                       onTab: { back in if back { e.title.focus(); return true }; return false })
            HStack(spacing: 6) {
                ParsedChips(c: c, parsed: title.parsed, defaults: e.defaults, task: e.taskID.flatMap { c.task($0) })
                Spacer()
                Text(e.taskID == nil ? "↩ Add · ⌘↩ Add and close · ⇥ Description · Esc" : "↩ Save · ⇥ Description · Esc")
                    .font(.caption).foregroundStyle(.tertiary)
            }
        }
        .padding(10)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.primary.opacity(0.15)))
        .padding(.vertical, 4)
    }
}

/// What a task will get: project, date, priority, labels (from the text, else the defaults).
struct ParsedChips: View {
    let c: TodoController
    let parsed: QuickAddResult?
    let defaults: TaskEditor.Defaults
    let task: TodoDoc?

    var body: some View {
        let p = parsed
        let projectName = p?.project.flatMap { name in c.projects.first { $0.name.caseInsensitiveCompare(name) == .orderedSame }?.name }
            ?? c.projectName(task?.project ?? defaults.project)
        let due = p?.clearDue == true ? nil : (p?.due ?? task?.due ?? defaults.due)
        let priority = p?.priority ?? task?.priority ?? 4
        let labels = (task?.labels ?? defaults.label.map { [$0] } ?? []) + (p?.labels ?? [])
        HStack(spacing: 6) {
            chip(projectName == "Inbox" ? "tray" : "number", projectName, .secondary)
            if let due { chip("calendar", c.dates.label(due), TodoStyle.due(due, dates: c.dates)) }
            if priority < 4 { chip("flag.fill", "P\(priority)", Color(nsColor: TodoStyle.priority(priority))) }
            ForEach(Array(Set(labels.map { $0.lowercased() })).sorted(), id: \.self) { l in
                chip("tag", labels.first { $0.lowercased() == l } ?? l, Color(nsColor: TodoStyle.tokenColor(.label)))
            }
        }
    }

    private func chip(_ symbol: String, _ text: String, _ tint: Color) -> some View {
        Label(text, systemImage: symbol)
            .labelStyle(TightLabel())
            .font(.caption)
            .foregroundStyle(tint)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 4))
    }
}

// MARK: - Footer

struct TodoFooter: View {
    @ObservedObject var c: TodoController
    @ObservedObject var status: TodoSyncStatus

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: status.symbol).foregroundStyle(status.isHealthy || status.state == .disabled ? Color.secondary : Color.orange)
            Text(status.summary).foregroundStyle(.secondary)
            Spacer()
            if let t = c.toast {
                Text(t.message)
                if t.undoable {
                    Button("Undo") { c.undo(t.undoID) }.buttonStyle(.link)
                    Text("Z").foregroundStyle(.tertiary)
                }
            } else {
                Text("? Shortcuts").foregroundStyle(.tertiary)
            }
        }
        .font(.caption)
        .padding(.horizontal, 16)
        .frame(height: 28)
        .themedBackground(Rectangle().fill(.bar))
        .overlay(alignment: .top) { Divider() }
    }
}
