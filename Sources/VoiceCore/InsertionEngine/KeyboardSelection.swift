import AppKit
import Carbon.HIToolbox

@MainActor
public enum KeyboardSelection {
    public static func steps(for text: String) -> Int {
        text.replacingOccurrences(of: "\r\n", with: "\n").count
    }

    public static func supports(_ text: String) -> Bool {
        // Visual Left is not logical backwards in bidi text. Leave AX in charge.
        !text.unicodeScalars.contains { scalar in
            (0x0590...0x08FF).contains(scalar.value) || (0xFB1D...0xFDFF).contains(scalar.value) ||
            (0xFE70...0xFEFF).contains(scalar.value) || (0x202A...0x202E).contains(scalar.value) ||
            (0x2066...0x2069).contains(scalar.value) || (0x10800...0x10FFF).contains(scalar.value) ||
            (0x1E800...0x1EEFF).contains(scalar.value)
        }
    }

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

    /// Selects `text` ending at the caret, verified by Copy before it counts.
    public static func select(_ text: String, targetPID: pid_t?) async -> Bool {
        let activity = SelectionActivity(targetPID: targetPID)
        defer { activity.stop() }
        return await select(text, targetPID: targetPID, activity: activity)
    }

    static func select(_ text: String, targetPID: pid_t?, activity: SelectionActivity) async -> Bool {
        await select(text, read: { await readSelectedText(targetPID: targetPID, permitted: { activity.valid }) },
            pressLeft: { await key(CGKeyCode(kVK_LeftArrow), flags: .maskShift, permitted: { activity.valid }) },
            permitted: { activity.valid }, pause: { try? await Task.sleep(nanoseconds: 100_000_000) })
    }

    /// Injectable at the keyboard/read-back boundary, including editors with no AX range.
    public static func select(_ text: String, read: () async -> String?, pressLeft: () async -> Bool,
                              permitted: () -> Bool, pause: () async -> Void) async -> Bool {
        let count = steps(for: text)
        guard count > 0, count <= 2_000, supports(text), permitted() else { return false }
        await pause()
        // AX may have succeeded visually but failed its own range verification.
        let existing = await read()
        if OutputSelection.equivalent(existing, text) { return permitted() }
        // Never extend an unrelated/partial selection into neighboring text.
        guard existing == nil || existing == "", permitted() else { return false }
        for _ in 0..<count {
            guard permitted(), await pressLeft() else { return false }
        }
        await pause()
        guard permitted() else { return false }
        let selected = await read()
        return permitted() && OutputSelection.equivalent(selected, text)
    }
}
