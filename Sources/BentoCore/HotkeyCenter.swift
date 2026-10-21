import AppKit
import Carbon.HIToolbox

/// Global hotkeys via Carbon `RegisterEventHotKey`.
///
/// This is the cheapest way to get system-wide shortcuts on macOS: no event tap,
/// no Input Monitoring permission, and the handler only runs when the key fires.
/// All calls must happen on the main thread.
public final class HotkeyCenter {
    public static let shared = HotkeyCenter()

    /// Posted on the main thread when the last `suspend()` is balanced by
    /// `resume()`. Registrations that could not be restored are inactive
    /// (`isActive(_:) == false`).
    public static let didResume = Notification.Name("BentoHotkeyCenterDidResume")

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
    /// Nesting depth of `suspend()`; hotkeys are live only at 0.
    private var suspendDepth = 0
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
        // A Carbon event can still arrive for a key released while suspended.
        guard suspendDepth == 0, let entry = entries[id] else { return }
        if pressed { entry.onPress() } else { entry.onRelease?() }
    }

    /// Registers a global shortcut. Returns nil when the system refuses it
    /// (usually because another app, or another registration in Bento,
    /// already owns the combination).
    @discardableResult
    public func register(_ shortcut: Shortcut, onRelease: (() -> Void)? = nil, onPress: @escaping () -> Void) -> Token? {
        let id = allocateID()
        var entry = Entry(shortcut: shortcut, ref: nil, onPress: onPress, onRelease: onRelease)
        if suspendDepth == 0 {
            guard let ref = carbonRegister(shortcut, id: id) else { return nil }
            entry.ref = ref
        } else {
            // While suspended nothing is registered with the system, so check
            // availability now instead of failing silently on resume.
            if entries.values.contains(where: { $0.shortcut == shortcut }) { return nil }
            guard let probe = carbonRegister(shortcut, id: id) else { return nil }
            UnregisterEventHotKey(probe)
        }
        entries[id] = entry
        return Token(id: id)
    }

    public func unregister(_ token: Token?) {
        guard let token, let entry = entries.removeValue(forKey: token.id) else { return }
        if let ref = entry.ref { UnregisterEventHotKey(ref) }
    }

    public func unregister(_ tokens: [Token]) { tokens.forEach { unregister($0) } }

    /// Replaces the handlers of a live registration without touching the
    /// system registration (used by the action registry on reload).
    func setHandlers(_ token: Token, onPress: @escaping () -> Void, onRelease: (() -> Void)? = nil) {
        guard var e = entries[token.id] else { return }
        e.onPress = onPress
        e.onRelease = onRelease
        entries[token.id] = e
    }

    /// True if any registered shortcut uses this combination.
    public func isRegistered(_ shortcut: Shortcut) -> Bool {
        entries.values.contains { $0.shortcut == shortcut }
    }

    /// False when the token is unknown or its key could not be re-registered
    /// after a suspension (another app took it meanwhile).
    public func isActive(_ token: Token) -> Bool {
        guard let e = entries[token.id] else { return false }
        return suspendDepth > 0 || e.ref != nil
    }

    public var isSuspended: Bool { suspendDepth > 0 }

    /// Number of registrations (live or suspended), for diagnostics.
    public var registrationCount: Int { entries.count }

    /// Temporarily releases every hotkey (used while recording a new shortcut,
    /// so the keystroke reaches the recorder instead of firing an action).
    /// Calls nest: every `suspend()` must be balanced by one `resume()`.
    public func suspend() {
        suspendDepth += 1
        guard suspendDepth == 1 else { return }
        for (id, var e) in entries {
            if let ref = e.ref { UnregisterEventHotKey(ref) }
            e.ref = nil
            entries[id] = e
        }
    }

    public func resume() {
        guard suspendDepth > 0 else {
            BentoLog.core.error("HotkeyCenter.resume() without matching suspend()")
            return
        }
        suspendDepth -= 1
        guard suspendDepth == 0 else { return }
        for (id, var e) in entries where e.ref == nil {
            e.ref = carbonRegister(e.shortcut, id: id)
            entries[id] = e
        }
        NotificationCenter.default.post(name: HotkeyCenter.didResume, object: self)
    }

    private func allocateID() -> UInt32 {
        let id = nextID
        nextID = nextID == UInt32.max ? 1 : nextID + 1
        return id
    }

    /// Only same-process duplicates fail here: RegisterEventHotKey accepts a
    /// combination another app or macOS already uses (it just never fires),
    /// so callers check `SystemShortcuts.isReserved` for the system's own.
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

/// macOS's own enabled shortcuts (System Settings → Keyboard → Shortcuts:
/// Spotlight, Mission Control, screenshots, input sources…). The system
/// handles them before any app, so a Bento hotkey on one of them never fires.
public enum SystemShortcuts {
    private static var cache: (time: Date, set: Set<Shortcut>)?

    public static func isReserved(_ shortcut: Shortcut) -> Bool {
        reserved().contains(Shortcut(keyCode: shortcut.keyCode, modifiers: shortcut.modifiers.subtracting(.function)))
    }

    /// Re-read at most every few seconds (the user can change them any time).
    static func reserved() -> Set<Shortcut> {
        if let cache, Date().timeIntervalSince(cache.time) < 5 { return cache.set }
        var out = Set<Shortcut>()
        var array: Unmanaged<CFArray>?
        if CopySymbolicHotKeys(&array) == noErr, let list = array?.takeRetainedValue() as? [[String: Any]] {
            for entry in list where (entry[kHISymbolicHotKeyEnabled] as? Bool) == true {
                guard let code = (entry[kHISymbolicHotKeyCode] as? NSNumber)?.intValue, (0..<0xFFFF).contains(code),
                      let mods = (entry[kHISymbolicHotKeyModifiers] as? NSNumber)?.intValue else { continue }
                var flags: NSEvent.ModifierFlags = []
                if mods & cmdKey != 0 { flags.insert(.command) }
                if mods & optionKey != 0 { flags.insert(.option) }
                if mods & controlKey != 0 { flags.insert(.control) }
                if mods & shiftKey != 0 { flags.insert(.shift) }
                out.insert(Shortcut(keyCode: UInt32(code), modifiers: flags))
            }
        }
        cache = (Date(), out)
        return out
    }
}
