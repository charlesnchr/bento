import AppKit
import SwiftUI
import BentoCore

/// Notes: a port of Raycast Notes (floating markdown notes) with realtime sync.
/// See RaycastNotesSpec.swift for the reference behaviour and docs/SYNC_PROTOCOL.md.
public final class NotesModule: BentoModule {
    public let id = "notes"
    public let title = "Notes"
    public let symbol = "note.text"

    private lazy var controller = NotesController()
    private let isDev = ProcessInfo.processInfo.environment["BENTO_DEV"] != nil

    public init() {}

    public var actions: [BentoAction] {
        var a = [
            BentoAction("notes.toggle", "Toggle Notes", shortcut: "ctrl+opt+n") { [weak self] in self?.controller.toggle() },
            BentoAction("notes.new", "New Note") { [weak self] in self?.controller.newNoteFromAnywhere() },
            BentoAction("notes.search", "Search Notes") { [weak self] in self?.controller.searchFromAnywhere() },
        ]
        if isDev {
            a.append(BentoAction("notes.debug", "Debug Script", hiddenFromMenu: true) { [weak self] in
                guard let self else { return }
                NotesDebug.run(self.controller)
            })
        }
        return a
    }

    public func start() { started = true; controller.start() }
    public func stop() { started = false; controller.stop() }

    private var started = false

    /// Appends dictated text to the capture note as a collapsible, timestamped entry
    /// (Dictation's Capture Thought to Note). Returns the note's title; nil when Notes
    /// is off or there is no text.
    public func capture(_ text: String) -> String? {
        guard started else { return nil }
        return controller.capture(text)
    }

    public func makeSettingsView() -> AnyView? {
        controller.makeSettingsView(actions: actions.filter { !$0.id.hasPrefix("notes.debug") })
    }
}
