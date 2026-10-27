import AppKit

/// Reads the current selection by Copy, for editors whose AX tree hides it.
@MainActor
public enum KeyboardSelection {
    static func key(_ code: CGKeyCode, flags: CGEventFlags, permitted: () -> Bool) async -> Bool {
        guard permitted(), let source = CGEventSource(stateID: .privateState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else { return false }
        for event in [down, up] {
            event.flags = flags
            event.setIntegerValueField(.eventSourceUserData, value: SyntheticEventTag.magic)
        }
        down.post(tap: .cghidEventTap)
        try? await Task.sleep(nanoseconds: 4_000_000)
        // Always release a key we posted, even when the operation was cancelled.
        up.post(tap: .cghidEventTap)
        return permitted()
    }

    public static func readSelectedText(targetPID: pid_t?) async -> String? {
        let activity = SelectionActivity(targetPID: targetPID)
        defer { activity.stop() }
        return await readSelectedText(targetPID: targetPID, permitted: { activity.valid })
    }

    static func readSelectedText(targetPID: pid_t?, permitted: () -> Bool) async -> String? {
        guard permitted() else { return nil }
        let board = NSPasteboard.general
        let saved = PasteInserter.snapshot(board, includeTransient: true)
        let count = board.changeCount
        guard await key(KeyboardLayout.keyCode(for: "c"), flags: .maskCommand, permitted: permitted) else { return nil }
        for _ in 0..<20 {
            try? await Task.sleep(nanoseconds: 20_000_000)
            guard permitted() else { return nil }
            if board.changeCount != count {
                let copiedCount = board.changeCount
                let result = board.string(forType: .string)
                guard board.changeCount == copiedCount, permitted() else { return nil }
                // A no-op Copy must never validate the pre-existing transcript.
                PasteInserter.restore(saved, to: board)
                return result
            }
        }
        return nil
    }
}
