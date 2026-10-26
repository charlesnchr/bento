import AppKit
import Carbon.HIToolbox

/// Layout-correct key codes for shortcuts: ⌘V is key 9 on QWERTY but 47 on
/// Dvorak. Reads the current ASCII-capable layout once and again after the
/// input source changes.
public enum KeyboardLayout {
    private static let lock = NSLock()
    private static var map: [Character: CGKeyCode]?
    private static var observer: NSObjectProtocol?

    /// The key that types `character` (lowercase ASCII) without modifiers,
    /// or the QWERTY key when the layout doesn't have one.
    public static func keyCode(for character: Character) -> CGKeyCode {
        lock.lock()
        defer { lock.unlock() }
        if map == nil {
            map = build()
            observeChanges()
        }
        return map?[character] ?? qwerty[character] ?? 0
    }

    /// The first lookup pays a Text Input Sources round trip (tens of ms); pay it
    /// while idle instead of between transcript-ready and ⌘V.
    public static func warm() { _ = keyCode(for: "v") }

    private static func observeChanges() {
        guard observer == nil else { return }
        observer = DistributedNotificationCenter.default().addObserver(
            forName: Notification.Name(kTISNotifySelectedKeyboardInputSourceChanged as String),
            object: nil, queue: nil
        ) { _ in
            lock.lock()
            map = nil
            lock.unlock()
        }
    }

    private static func build() -> [Character: CGKeyCode] {
        guard let source = TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue(),
              let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return [:] }
        let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
        var result: [Character: CGKeyCode] = [:]
        data.withUnsafeBytes { buffer in
            guard let layout = buffer.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return }
            for code in 0..<CGKeyCode(128) {
                var deadKeys: UInt32 = 0
                var chars = [UniChar](repeating: 0, count: 4)
                var length = 0
                let status = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDisplay), 0, UInt32(LMGetKbdType()),
                                            OptionBits(kUCKeyTranslateNoDeadKeysBit), &deadKeys, chars.count, &length, &chars)
                guard status == noErr, length == 1,
                      let scalar = Unicode.Scalar(chars[0]) else { continue }
                let character = Character(scalar).lowercased().first ?? Character(scalar)
                // Keep the first (lowest) code: keypad keys come later.
                if result[character] == nil { result[character] = code }
            }
        }
        return result
    }

    private static let qwerty: [Character: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "o": 31, "u": 32,
        "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
    ]
}
