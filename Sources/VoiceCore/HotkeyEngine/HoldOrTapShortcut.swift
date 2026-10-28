import Foundation

/// The hold-or-tap grammar for a rebindable shortcut. Those are Carbon
/// hotkeys, which report only their own key-down and key-up (no Space or Esc
/// gestures, those stay with the event tap):
///
///   hold ≥ 0.3s   → push-to-talk: key-up finalizes
///   shorter tap   → hands-free: the next press finalizes
///
/// Recording starts on key-down, as with the dictation key. Whether a press
/// finishes is decided from the session itself (`recording`), not remembered,
/// because Esc, the pill's stop button or an error can end it in between.
public struct HoldOrTapShortcut: Equatable, Sendable {
    public enum Step: Equatable, Sendable {
        case begin
        case lockIn
        case finalize
    }

    /// When the key went down for a press that began a session.
    private var beganAt: TimeInterval?
    /// Key physically down, so a repeated key-down is an echo, not a press.
    private var held = false

    public init() {}

    /// `recording`: this shortcut's kind of session is recording right now.
    public mutating func keyDown(at now: TimeInterval, recording: Bool) -> Step? {
        guard !held else { return nil }
        held = true
        if recording {
            beganAt = nil
            return .finalize
        }
        beganAt = now
        return .begin
    }

    /// The `.begin` was refused (busy, no microphone, secure input): the key-up
    /// that follows has nothing to finish or lock.
    public mutating func beginRefused() {
        beganAt = nil
    }

    public mutating func keyUp(at now: TimeInterval, recording: Bool) -> Step? {
        defer { held = false; beganAt = nil }
        guard let beganAt, recording else { return nil }
        return now - beganAt >= HotkeyTuning.holdThreshold ? .finalize : .lockIn
    }

    /// From the menu or a URL, where nothing is held: start hands-free, or finish.
    public static func toggle(recording: Bool) -> [Step] {
        recording ? [.finalize] : [.begin, .lockIn]
    }
}
