import Foundation

// What the copied Notes sources need from files that aren't compiled here
// (MarkdownCommands.swift, NoteStore.swift), plus the test seams generate.sh patches
// into NoteModel.swift: a settable clock and sequential note ids, so engine scenarios
// are deterministic and can be replayed by the Kotlin tests.

struct TextEdit: Equatable {
    var range: NSRange
    var replacement: String
}

protocol NoteRepository: AnyObject {
    func note(_ id: String) -> Note?
    func save(_ note: Note)
    var lastSeq: Int64 { get set }
    func allNotes(includeTombstones: Bool) -> [Note]
    var installID: String { get }
    func renewInstallID()
    var retiredInstallIDs: Set<String> { get }
}

enum TestClock {
    /// When set, `Note.now()` returns it.
    static var now: Int64?
    static var counter = 0
    /// Default id of a new `Note` (conflicted copies).
    static func nextID() -> String {
        counter += 1
        return String(format: "ID-%06d", counter)
    }
}
