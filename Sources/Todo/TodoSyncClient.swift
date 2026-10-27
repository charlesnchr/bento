import Foundation
import BentoCore

/// Sync settings (`todo.sync` in config.json). Same server and token as Notes.
typealias TodoSyncSettings = SyncServerSettings
typealias TodoSyncStatus = FieldSyncStatus
typealias TodoSyncEngine = FieldSyncEngine

/// Todo syncs the `todos` collection with BentoCore's field-document client.
typealias TodoSyncClient = FieldSyncClient

extension FieldSyncProfile {
    static let todos = FieldSyncProfile(collection: TodoWire.collection, userAgent: "Bento-Todo/1", logCategory: "todo.sync",
                                        noun: ("task", "tasks")) { $0.isProject ? $0.name : $0.title }
}
