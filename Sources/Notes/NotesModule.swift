import AppKit
import SwiftUI
import BentoCore

/// Notes module. See docs/SPEC.md.
public final class NotesModule: BentoModule {
    public let id = "notes"
    public let title = "Notes"
    public let symbol = "note.text"

    public init() {}

    public var actions: [BentoAction] { [] }

    public func start() {}
    public func stop() {}
}
