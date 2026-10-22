import AppKit

/// Everything the todo window does from the keyboard. Bindings follow Todoist's
/// (https://www.todoist.com/help/articles/use-keyboard-shortcuts-in-todoist-Wyovn2);
/// the same table drives the key router and the `?` overlay.
enum TodoCommand: String, CaseIterable {
    // General
    case quickAdd, addBottom, addTop, search, quickFind, toggleSidebar, help, undo, newProject, projectActions, close
    // Navigation
    case down, up, top, bottom, goHome, goInbox, goToday, goUpcoming, goProject, goLabel, back, forward, openInProject
    // Tasks
    case edit, complete, schedule, removeDate, priority, p1, p2, p3, p4, labels, move, select, extendDown, extendUp,
         selectAll, delete, moveUp, moveDown, toggleCompleted, copy

    var title: String {
        switch self {
        case .quickAdd: return "Quick Add"
        case .addBottom: return "Add task at the bottom"
        case .addTop: return "Add task at the top"
        case .search: return "Search"
        case .quickFind: return "Quick Find (views, projects, labels, tasks)"
        case .toggleSidebar: return "Show or hide the sidebar"
        case .help: return "Keyboard shortcuts"
        case .undo: return "Undo"
        case .newProject: return "New project"
        case .projectActions: return "Project actions (rename, colour, archive, delete)"
        case .close: return "Clear selection / close the window"
        case .down: return "Next task"
        case .up: return "Previous task"
        case .top: return "First task"
        case .bottom: return "Last task"
        case .goHome: return "Go to home view"
        case .goInbox: return "Go to Inbox"
        case .goToday: return "Go to Today"
        case .goUpcoming: return "Go to Upcoming"
        case .goProject: return "Go to project…"
        case .goLabel: return "Go to label…"
        case .back: return "Previous view"
        case .forward: return "Next view"
        case .openInProject: return "Open task in its project"
        case .edit: return "Edit task"
        case .complete: return "Complete task"
        case .schedule: return "Set date"
        case .removeDate: return "Remove date"
        case .priority: return "Change priority"
        case .p1: return "Priority 1"
        case .p2: return "Priority 2"
        case .p3: return "Priority 3"
        case .p4: return "Priority 4"
        case .labels: return "Labels"
        case .move: return "Move to project"
        case .select: return "Select task"
        case .extendDown: return "Extend selection down"
        case .extendUp: return "Extend selection up"
        case .selectAll: return "Select all"
        case .delete: return "Delete"
        case .moveUp: return "Move task up"
        case .moveDown: return "Move task down"
        case .toggleCompleted: return "Show or hide completed tasks"
        case .copy: return "Copy tasks as a Markdown list"
        }
    }

    enum Group: String, CaseIterable { case general = "General", navigation = "Navigation", tasks = "Tasks" }

    var group: Group {
        switch self {
        case .quickAdd, .addBottom, .addTop, .search, .quickFind, .toggleSidebar, .help, .undo, .newProject, .projectActions, .close:
            return .general
        case .down, .up, .top, .bottom, .goHome, .goInbox, .goToday, .goUpcoming, .goProject, .goLabel, .back, .forward, .openInProject:
            return .navigation
        default:
            return .tasks
        }
    }

    /// Display strings for every binding of the command.
    var keys: [String] { TodoKeyMap.bindings.filter { $0.command == self }.map(\.key.display) }
}

/// One key (a character or a special key) with the modifiers it needs.
struct TodoKey: Equatable, Hashable {
    enum Base: Equatable, Hashable { case char(String), code(UInt16) }
    var base: Base
    var command = false
    var option = false
    var control = false
    /// Only for `.code` keys (letters carry shift in their character).
    var shift = false
    /// Second key of a `g …` chord.
    var afterG = false

    static func c(_ s: String, cmd: Bool = false, opt: Bool = false, ctrl: Bool = false) -> TodoKey {
        TodoKey(base: .char(s), command: cmd, option: opt, control: ctrl)
    }

    static func k(_ code: UInt16, cmd: Bool = false, opt: Bool = false, shift: Bool = false) -> TodoKey {
        TodoKey(base: .code(code), command: cmd, option: opt, shift: shift)
    }

    static func g(_ s: String) -> TodoKey { TodoKey(base: .char(s), afterG: true) }

    enum Code {
        static let returnKey: UInt16 = 36, tab: UInt16 = 48, delete: UInt16 = 51, escape: UInt16 = 53
        static let left: UInt16 = 123, right: UInt16 = 124, down: UInt16 = 125, up: UInt16 = 126
        static let home: UInt16 = 115, end: UInt16 = 119, forwardDelete: UInt16 = 117, keypadEnter: UInt16 = 76
    }

    var display: String {
        var s = ""
        if control { s += "⌃" }
        if option { s += "⌥" }
        if shift { s += "⇧" }
        if command { s += "⌘" }
        switch base {
        case .char(let c):
            let isShifted = c.count == 1 && c != c.lowercased()
            if isShifted { s += "⇧" + c } else { s += c.uppercased() }
        case .code(let code):
            switch code {
            case Code.returnKey: s += "↩"
            case Code.delete: s += "⌫"
            case Code.escape: s += "Esc"
            case Code.up: s += "↑"
            case Code.down: s += "↓"
            case Code.left: s += "←"
            case Code.right: s += "→"
            case Code.home: s += "Home"
            case Code.end: s += "End"
            default: s += "#\(code)"
            }
        }
        return afterG ? "G then " + s : s
    }

    /// Matches a key-down event (chord state handled by the router).
    func matches(_ e: NSEvent, afterG g: Bool) -> Bool {
        guard g == afterG else { return false }
        let f = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard f.contains(.command) == command, f.contains(.option) == option, f.contains(.control) == control else { return false }
        switch base {
        case .code(let code):
            return e.keyCode == code && f.contains(.shift) == shift
        case .char(let c):
            // charactersIgnoringModifiers keeps shift ("A"), so letters carry it themselves.
            guard let chars = e.charactersIgnoringModifiers, !chars.isEmpty else { return false }
            if chars == c { return true }
            // ⌥/⌃ can change what charactersIgnoringModifiers reports on some layouts
            return (command || option || control) && chars.lowercased() == c.lowercased() && f.contains(.shift) == (c != c.lowercased())
        }
    }
}

enum TodoKeyMap {
    typealias K = TodoKey
    static let bindings: [(key: TodoKey, command: TodoCommand)] = [
        (.c("q"), .quickAdd),
        (.c("a"), .addBottom),
        (.c("A"), .addTop),
        (.c("/"), .search),
        (.c("f"), .search),
        (.c("k", cmd: true), .quickFind),
        (.c("m"), .toggleSidebar),
        (.c("?"), .help),
        (.c("z", cmd: true), .undo),
        (.c("z"), .undo),
        (.c("p", opt: true), .newProject),
        (.c("w"), .projectActions),
        (.k(K.Code.escape), .close),

        (.c("j"), .down),
        (.k(K.Code.down), .down),
        (.c("k"), .up),
        (.k(K.Code.up), .up),
        (.k(K.Code.up, cmd: true), .top),
        (.k(K.Code.home), .top),
        (.k(K.Code.down, cmd: true), .bottom),
        (.k(K.Code.end), .bottom),
        (.c("h"), .goHome),
        (.g("h"), .goHome),
        (.g("i"), .goInbox),
        (.g("t"), .goToday),
        (.g("u"), .goUpcoming),
        (.g("p"), .goProject),
        (.g("l"), .goLabel),
        (.g("v"), .goLabel),
        (.c("1", cmd: true), .goInbox),
        (.c("2", cmd: true), .goToday),
        (.c("3", cmd: true), .goUpcoming),
        (.c("[", cmd: true), .back),
        (.c("]", cmd: true), .forward),
        (.c("G"), .openInProject),

        (.k(K.Code.returnKey), .edit),
        (.k(K.Code.keypadEnter), .edit),
        (.c("e", cmd: true), .edit),
        (.c("e"), .complete),
        (.c("t"), .schedule),
        (.c("T"), .removeDate),
        (.c("y"), .priority),
        (.c("1"), .p1),
        (.c("2"), .p2),
        (.c("3"), .p3),
        (.c("4"), .p4),
        (.c("l"), .labels),
        (.c("v"), .move),
        (.c("x"), .select),
        (.c("J"), .extendDown),
        (.k(K.Code.down, shift: true), .extendDown),
        (.c("K"), .extendUp),
        (.k(K.Code.up, shift: true), .extendUp),
        (.c("a", cmd: true), .selectAll),
        (.k(K.Code.delete, cmd: true), .delete),
        (.k(K.Code.delete, shift: true), .delete),
        (.k(K.Code.forwardDelete), .delete),
        (.k(K.Code.up, cmd: true, shift: true), .moveUp),
        (.k(K.Code.down, cmd: true, shift: true), .moveDown),
        (.c("C"), .toggleCompleted),
        (.c("c", cmd: true), .copy),
    ]
}

/// Turns key-down events into commands, with Todoist's `g …` chords.
final class TodoKeyRouter {
    private(set) var awaitingG = false
    private var gWork: DispatchWorkItem?

    /// The command for an event, nil if it isn't one (or it started a chord: `consumed` is set).
    func command(for e: NSEvent, consumed: inout Bool) -> TodoCommand? {
        let mods = e.modifierFlags.intersection([.command, .option, .control])
        if awaitingG {
            awaitingG = false
            gWork?.cancel()
            consumed = true
            return TodoKeyMap.bindings.first { $0.key.matches(e, afterG: true) }?.command
        }
        if mods.isEmpty, e.charactersIgnoringModifiers == "g" {
            awaitingG = true
            consumed = true
            let w = DispatchWorkItem { [weak self] in self?.awaitingG = false }
            gWork = w
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: w)
            return nil
        }
        let c = TodoKeyMap.bindings.first { $0.key.matches(e, afterG: false) }?.command
        consumed = c != nil
        return c
    }

    func reset() {
        awaitingG = false
        gWork?.cancel()
    }
}
