import AppKit
import SwiftUI
import BentoCore

/// Todo: a keyboard-first task list with Todoist's bindings and realtime sync
/// (the `todos` collection of bento-sync, see docs/SYNC_PROTOCOL.md).
public final class TodoModule: BentoModule {
    public let id = "todo"
    public let title = "Todo"
    public let symbol = "checklist"

    public init() {}

    public var actions: [BentoAction] { [] }

    public func start() {}
    public func stop() {}
}
