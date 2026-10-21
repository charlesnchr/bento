import AppKit
import Carbon.HIToolbox

/// Global hotkeys via Carbon `RegisterEventHotKey`.
///
/// This is the cheapest way to get system-wide shortcuts on macOS: no event tap,
/// no Input Monitoring permission, and the handler only runs when the key fires.
/// All calls must happen on the main thread.
public final class HotkeyCenter {
    public static let shared = HotkeyCenter()

    public struct Token: Hashable { fileprivate let id: UInt32 }

    private struct Entry {
        var shortcut: Shortcut
        var ref: EventHotKeyRef?
        var onPress: () -> Void
        var onRelease: (() -> Void)?
    }

    private var entries: [UInt32: Entry] = [:]
    private var nextID: UInt32 = 1
    private var handlerRef: EventHandlerRef?
    private var suspended = false
    private static let signature: OSType = 0x42454E54 // 'BENT'

    private init() {
        var specs = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
        ]
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
            guard let event else { return OSStatus(eventNotHandledErr) }
            var hk = EventHotKeyID()
            let status = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                           nil, MemoryLayout<EventHotKeyID>.size, nil, &hk)
            guard status == noErr, hk.signature == HotkeyCenter.signature else { return OSStatus(eventNotHandledErr) }
            let pressed = GetEventKind(event) == UInt32(kEventHotKeyPressed)
            HotkeyCenter.shared.fire(id: hk.id, pressed: pressed)
            return noErr
        }, specs.count, &specs, nil, &handlerRef)
    }

    private func fire(id: UInt32, pressed: Bool) {
        guard let entry = entries[id] else { return }
        if pressed { entry.onPress() } else { entry.onRelease?() }
    }

    /// Registers a global shortcut. Returns nil when the system refuses it
    /// (usually because another app already owns the combination).
    @discardableResult
    public func register(_ shortcut: Shortcut, onRelease: (() -> Void)? = nil, onPress: @escaping () -> Void) -> Token? {
        let id = nextID
        nextID += 1
        var entry = Entry(shortcut: shortcut, ref: nil, onPress: onPress, onRelease: onRelease)
        if !suspended {
            guard let ref = carbonRegister(shortcut, id: id) else { return nil }
            entry.ref = ref
        }
        entries[id] = entry
        return Token(id: id)
    }

    public func unregister(_ token: Token?) {
        guard let token, let entry = entries.removeValue(forKey: token.id) else { return }
        if let ref = entry.ref { UnregisterEventHotKey(ref) }
    }

    public func unregister(_ tokens: [Token]) { tokens.forEach { unregister($0) } }

    /// True if any registered shortcut uses this combination.
    public func isRegistered(_ shortcut: Shortcut) -> Bool {
        entries.values.contains { $0.shortcut == shortcut }
    }

    /// Temporarily releases every hotkey (used while recording a new shortcut,
    /// so the keystroke reaches the recorder instead of firing an action).
    public func suspend() {
        guard !suspended else { return }
        suspended = true
        for (id, var e) in entries {
            if let ref = e.ref { UnregisterEventHotKey(ref) }
            e.ref = nil
            entries[id] = e
        }
    }

    public func resume() {
        guard suspended else { return }
        suspended = false
        for (id, var e) in entries {
            e.ref = carbonRegister(e.shortcut, id: id)
            entries[id] = e
        }
    }

    private func carbonRegister(_ s: Shortcut, id: UInt32) -> EventHotKeyRef? {
        var ref: EventHotKeyRef?
        let hkID = EventHotKeyID(signature: HotkeyCenter.signature, id: id)
        let status = RegisterEventHotKey(s.keyCode, s.carbonModifiers, hkID, GetApplicationEventTarget(), 0, &ref)
        if status != noErr {
            BentoLog.core.error("RegisterEventHotKey failed for \(s.configString, privacy: .public): \(status)")
            return nil
        }
        return ref
    }
}
