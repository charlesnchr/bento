import AppKit
import SwiftUI
import BentoCore

/// Todo: a keyboard-first task list with Todoist's bindings and realtime sync
/// (the `todos` collection of bento-sync, see docs/SYNC_PROTOCOL.md).
public final class TodoModule: BentoModule {
    public let id = "todo"
    public let title = "Todo"
    public let symbol = "checklist"

    private lazy var controller = TodoController()

    public init() {}

    public var actions: [BentoAction] {
        [
            BentoAction("todo.toggle", "Toggle Todo", shortcut: "ctrl+cmd+t") { [weak self] in self?.controller.toggle() },
            BentoAction("todo.quick-add", "Quick Add Task", shortcut: "ctrl+opt+space") { [weak self] in self?.controller.showQuickAdd() },
            BentoAction("todo.today", "Show Today", hiddenFromMenu: true) { [weak self] in
                guard let self else { return }
                self.controller.go(.today)
                self.controller.window.show()
            },
            BentoAction("todo.inbox", "Show Inbox", hiddenFromMenu: true) { [weak self] in
                guard let self else { return }
                self.controller.go(.inbox)
                self.controller.window.show()
            },
        ]
    }

    public func start() { controller.start() }
    public func stop() { controller.stop() }

    public func makeSettingsView() -> AnyView? { controller.makeSettingsView(actions: actions) }

    public func diagnostics() -> [String: Any] { controller.diagnostics }
}
