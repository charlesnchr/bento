import Foundation

@MainActor
public enum ComposerFocus {
    public enum State { case activating, restoringInput, ready, unsafe }

    public static func wait(read: () -> State, pause: () async -> Void) async -> Bool {
        var stable = 0
        for _ in 0..<60 {
            guard !Task.isCancelled else { return false }
            switch read() {
            case .ready:
                stable += 1
                if stable >= 3 { return true }
            case .unsafe: return false
            case .restoringInput, .activating: stable = 0
            }
            await pause()
        }
        return false
    }
}

/// Text/range transactions shared by the native composer and its regression probe.
public struct ComposerDraft {
    public var text = ""
    public var selection = NSRange(location: 0, length: 0)
    public private(set) var history: EditingSession?
    private var pending: (text: String, range: NSRange, editing: Bool)?

    public init() {}

    public mutating func begin(editing: Bool, now: Date = Date()) -> EditingSession? {
        let range = editing && selection.length == 0 ? NSRange(location: 0, length: (text as NSString).length) : selection
        guard range.location >= 0, range.length >= 0, NSMaxRange(range) <= (text as NSString).length else { return nil }
        let selected = (text as NSString).substring(with: range)
        guard !editing || !selected.isEmpty else { return nil }
        pending = (text, range, editing)
        if !editing { history = nil; return nil }
        if history?.currentText != selected || history?.isActive(at: now) != true { history = EditingSession(seed: selected, now: now) }
        return history
    }

    public mutating func apply(_ result: String) -> Bool {
        guard let pending, text == pending.text else { return false }
        let value = (text as NSString).replacingCharacters(in: pending.range, with: result)
        text = value
        selection = NSRange(location: pending.range.location, length: (result as NSString).length)
        if !pending.editing { history = EditingSession(seed: result) }
        self.pending = nil
        return true
    }

    public mutating func recordInstruction(_ instruction: String, revision: String) {
        history?.append(instruction: instruction, revision: revision)
    }

    public mutating func cancel() { pending = nil }
}
