import AppKit
import Carbon.HIToolbox

/// A global keyboard shortcut: one key plus modifiers.
///
/// Shortcuts are stored in the config file as human-editable strings such as
/// `"ctrl+opt+left"`, `"cmd+shift+2"`, `"hyper+t"` (hyper = ctrl+opt+cmd+shift)
/// or `"meh+n"` (meh = ctrl+opt+shift). Key names follow the US layout.
public struct Shortcut: Hashable, Codable, CustomStringConvertible {
    public var keyCode: UInt32
    public var modifiers: NSEvent.ModifierFlags

    public init(keyCode: UInt32, modifiers: NSEvent.ModifierFlags) {
        self.keyCode = keyCode
        self.modifiers = modifiers.intersection(Shortcut.relevantModifiers)
    }

    /// Convenience: `Shortcut("cmd+shift+2")`. Returns nil for unparseable strings.
    public init?(_ string: String) {
        guard let parsed = Shortcut.parse(string) else { return nil }
        self = parsed
    }

    public static let relevantModifiers: NSEvent.ModifierFlags = [.command, .option, .control, .shift, .function]

    public static func == (a: Shortcut, b: Shortcut) -> Bool {
        a.keyCode == b.keyCode && a.modifiers.rawValue == b.modifiers.rawValue
    }

    public func hash(into h: inout Hasher) {
        h.combine(keyCode)
        h.combine(modifiers.rawValue)
    }

    // MARK: Codable as a string

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        let s = try c.decode(String.self)
        guard let parsed = Shortcut.parse(s) else {
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Invalid shortcut \(s)")
        }
        self = parsed
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(configString)
    }

    // MARK: Formatting

    /// Canonical config representation, e.g. `ctrl+opt+cmd+left`.
    public var configString: String {
        var parts: [String] = []
        let hyper: NSEvent.ModifierFlags = [.control, .option, .command, .shift]
        if modifiers.isSuperset(of: hyper) {
            parts.append("hyper")
        } else {
            if modifiers.contains(.control) { parts.append("ctrl") }
            if modifiers.contains(.option) { parts.append("opt") }
            if modifiers.contains(.command) { parts.append("cmd") }
            if modifiers.contains(.shift) { parts.append("shift") }
        }
        if modifiers.contains(.function) { parts.append("fn") }
        parts.append(Shortcut.keyName(for: keyCode) ?? "key\(keyCode)")
        return parts.joined(separator: "+")
    }

    /// Menu-style representation, e.g. `⌃⌥⌘←`.
    public var displayString: String {
        var s = ""
        if modifiers.contains(.function) { s += "fn " }
        if modifiers.contains(.control) { s += "⌃" }
        if modifiers.contains(.option) { s += "⌥" }
        if modifiers.contains(.shift) { s += "⇧" }
        if modifiers.contains(.command) { s += "⌘" }
        return s + Shortcut.keySymbol(for: keyCode)
    }

    public var description: String { configString }

    /// Carbon modifier mask for RegisterEventHotKey.
    public var carbonModifiers: UInt32 {
        var m: UInt32 = 0
        if modifiers.contains(.command) { m |= UInt32(cmdKey) }
        if modifiers.contains(.option) { m |= UInt32(optionKey) }
        if modifiers.contains(.control) { m |= UInt32(controlKey) }
        if modifiers.contains(.shift) { m |= UInt32(shiftKey) }
        return m
    }

    static let functionKeyCodes: Set<UInt32> = Set([
        kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6, kVK_F7, kVK_F8, kVK_F9, kVK_F10,
        kVK_F11, kVK_F12, kVK_F13, kVK_F14, kVK_F15, kVK_F16, kVK_F17, kVK_F18, kVK_F19, kVK_F20,
    ].map(UInt32.init))

    /// False for combinations that would hijack typing if registered globally:
    /// plain or Shift-only keys (except F-keys). The recorder never produces
    /// them, but a hand-edited config can ("t" instead of "hyper+t").
    public var isSafeGlobalHotkey: Bool {
        !modifiers.intersection([.command, .option, .control]).isEmpty || Shortcut.functionKeyCodes.contains(keyCode)
    }

    /// Key equivalent for NSMenuItem display (only for keys with a character).
    public var menuKeyEquivalent: (String, NSEvent.ModifierFlags)? {
        guard let ch = Shortcut.menuCharacter(for: keyCode) else { return nil }
        return (ch, modifiers.subtracting(.function))
    }

    /// True when this event matches the shortcut (for local key monitors).
    public func matches(_ event: NSEvent) -> Bool {
        UInt32(event.keyCode) == keyCode
            && event.modifierFlags.intersection(Shortcut.relevantModifiers).subtracting(.function)
                == modifiers.subtracting(.function)
    }

    // MARK: Parsing

    public static func parse(_ raw: String) -> Shortcut? {
        let tokens = raw.lowercased()
            .replacingOccurrences(of: " ", with: "")
            .split(separator: "+", omittingEmptySubsequences: false)
            .map(String.init)
        // "cmd++" style is not supported; use "equal"/"plus".
        guard let keyToken = tokens.last, !keyToken.isEmpty else { return nil }
        var mods: NSEvent.ModifierFlags = []
        for t in tokens.dropLast() {
            switch t {
            case "cmd", "command", "⌘", "super", "win": mods.insert(.command)
            case "opt", "option", "alt", "⌥": mods.insert(.option)
            case "ctrl", "control", "ctl", "⌃": mods.insert(.control)
            case "shift", "⇧": mods.insert(.shift)
            case "fn", "function": mods.insert(.function)
            case "hyper": mods.formUnion([.control, .option, .command, .shift])
            case "meh": mods.formUnion([.control, .option, .shift])
            default: return nil
            }
        }
        guard let code = keyCode(for: keyToken) else { return nil }
        return Shortcut(keyCode: code, modifiers: mods)
    }

    // MARK: Key tables (US layout)

    static let namedKeys: [(String, Int)] = [
        ("a", kVK_ANSI_A), ("b", kVK_ANSI_B), ("c", kVK_ANSI_C), ("d", kVK_ANSI_D),
        ("e", kVK_ANSI_E), ("f", kVK_ANSI_F), ("g", kVK_ANSI_G), ("h", kVK_ANSI_H),
        ("i", kVK_ANSI_I), ("j", kVK_ANSI_J), ("k", kVK_ANSI_K), ("l", kVK_ANSI_L),
        ("m", kVK_ANSI_M), ("n", kVK_ANSI_N), ("o", kVK_ANSI_O), ("p", kVK_ANSI_P),
        ("q", kVK_ANSI_Q), ("r", kVK_ANSI_R), ("s", kVK_ANSI_S), ("t", kVK_ANSI_T),
        ("u", kVK_ANSI_U), ("v", kVK_ANSI_V), ("w", kVK_ANSI_W), ("x", kVK_ANSI_X),
        ("y", kVK_ANSI_Y), ("z", kVK_ANSI_Z),
        ("0", kVK_ANSI_0), ("1", kVK_ANSI_1), ("2", kVK_ANSI_2), ("3", kVK_ANSI_3),
        ("4", kVK_ANSI_4), ("5", kVK_ANSI_5), ("6", kVK_ANSI_6), ("7", kVK_ANSI_7),
        ("8", kVK_ANSI_8), ("9", kVK_ANSI_9),
        ("minus", kVK_ANSI_Minus), ("equal", kVK_ANSI_Equal),
        ("leftbracket", kVK_ANSI_LeftBracket), ("rightbracket", kVK_ANSI_RightBracket),
        ("backslash", kVK_ANSI_Backslash), ("semicolon", kVK_ANSI_Semicolon),
        ("quote", kVK_ANSI_Quote), ("comma", kVK_ANSI_Comma), ("period", kVK_ANSI_Period),
        ("slash", kVK_ANSI_Slash), ("grave", kVK_ANSI_Grave), ("section", kVK_ISO_Section),
        ("return", kVK_Return), ("tab", kVK_Tab), ("space", kVK_Space),
        ("delete", kVK_Delete), ("forwarddelete", kVK_ForwardDelete), ("escape", kVK_Escape),
        ("left", kVK_LeftArrow), ("right", kVK_RightArrow), ("up", kVK_UpArrow), ("down", kVK_DownArrow),
        ("home", kVK_Home), ("end", kVK_End), ("pageup", kVK_PageUp), ("pagedown", kVK_PageDown),
        ("f1", kVK_F1), ("f2", kVK_F2), ("f3", kVK_F3), ("f4", kVK_F4), ("f5", kVK_F5),
        ("f6", kVK_F6), ("f7", kVK_F7), ("f8", kVK_F8), ("f9", kVK_F9), ("f10", kVK_F10),
        ("f11", kVK_F11), ("f12", kVK_F12), ("f13", kVK_F13), ("f14", kVK_F14), ("f15", kVK_F15),
        ("f16", kVK_F16), ("f17", kVK_F17), ("f18", kVK_F18), ("f19", kVK_F19), ("f20", kVK_F20),
        ("kp0", kVK_ANSI_Keypad0), ("kp1", kVK_ANSI_Keypad1), ("kp2", kVK_ANSI_Keypad2),
        ("kp3", kVK_ANSI_Keypad3), ("kp4", kVK_ANSI_Keypad4), ("kp5", kVK_ANSI_Keypad5),
        ("kp6", kVK_ANSI_Keypad6), ("kp7", kVK_ANSI_Keypad7), ("kp8", kVK_ANSI_Keypad8),
        ("kp9", kVK_ANSI_Keypad9), ("kpplus", kVK_ANSI_KeypadPlus), ("kpminus", kVK_ANSI_KeypadMinus),
        ("kpmultiply", kVK_ANSI_KeypadMultiply), ("kpdivide", kVK_ANSI_KeypadDivide),
        ("kpenter", kVK_ANSI_KeypadEnter), ("kpequals", kVK_ANSI_KeypadEquals),
        ("kpdecimal", kVK_ANSI_KeypadDecimal), ("kpclear", kVK_ANSI_KeypadClear),
    ]

    static let aliases: [String: String] = [
        "enter": "return", "esc": "escape", "backspace": "delete", "del": "forwarddelete",
        "spacebar": "space", "=": "equal", "plus": "equal", "-": "minus", "[": "leftbracket",
        "]": "rightbracket", "\\": "backslash", ";": "semicolon", "'": "quote", ",": "comma",
        ".": "period", "/": "slash", "`": "grave", "backtick": "grave", "arrowleft": "left",
        "arrowright": "right", "arrowup": "up", "arrowdown": "down", "pgup": "pageup", "pgdn": "pagedown",
        "←": "left", "→": "right", "↑": "up", "↓": "down",
    ]

    static let nameToCode: [String: UInt32] = {
        var d: [String: UInt32] = [:]
        for (n, c) in namedKeys { d[n] = UInt32(c) }
        return d
    }()

    static let codeToName: [UInt32: String] = {
        var d: [UInt32: String] = [:]
        for (n, c) in namedKeys where d[UInt32(c)] == nil { d[UInt32(c)] = n }
        return d
    }()

    public static func keyCode(for name: String) -> UInt32? {
        let n = aliases[name] ?? name
        if let c = nameToCode[n] { return c }
        if n.hasPrefix("key"), let raw = UInt32(n.dropFirst(3)) { return raw }
        return nil
    }

    public static func keyName(for code: UInt32) -> String? { codeToName[code] }

    static let symbols: [Int: String] = [
        kVK_Return: "↩", kVK_Tab: "⇥", kVK_Space: "Space", kVK_Delete: "⌫", kVK_ForwardDelete: "⌦",
        kVK_Escape: "⎋", kVK_LeftArrow: "←", kVK_RightArrow: "→", kVK_UpArrow: "↑", kVK_DownArrow: "↓",
        kVK_Home: "↖", kVK_End: "↘", kVK_PageUp: "⇞", kVK_PageDown: "⇟",
        kVK_ANSI_Minus: "-", kVK_ANSI_Equal: "=", kVK_ANSI_LeftBracket: "[", kVK_ANSI_RightBracket: "]",
        kVK_ANSI_Backslash: "\\", kVK_ANSI_Semicolon: ";", kVK_ANSI_Quote: "'", kVK_ANSI_Comma: ",",
        kVK_ANSI_Period: ".", kVK_ANSI_Slash: "/", kVK_ANSI_Grave: "`", kVK_ANSI_KeypadEnter: "⌤",
    ]

    public static func keySymbol(for code: UInt32) -> String {
        if let s = symbols[Int(code)] { return s }
        guard let name = keyName(for: code) else { return "#\(code)" }
        if name.hasPrefix("kp") { return "Keypad " + String(name.dropFirst(2)).uppercased() }
        return name.uppercased()
    }

    static func menuCharacter(for code: UInt32) -> String? {
        switch Int(code) {
        case kVK_LeftArrow: return String(UnicodeScalar(NSLeftArrowFunctionKey)!)
        case kVK_RightArrow: return String(UnicodeScalar(NSRightArrowFunctionKey)!)
        case kVK_UpArrow: return String(UnicodeScalar(NSUpArrowFunctionKey)!)
        case kVK_DownArrow: return String(UnicodeScalar(NSDownArrowFunctionKey)!)
        case kVK_Return: return "\r"
        case kVK_Tab: return "\t"
        case kVK_Space: return " "
        case kVK_Delete: return String(UnicodeScalar(8))
        case kVK_Escape: return String(UnicodeScalar(27))
        default: break
        }
        if let s = symbols[Int(code)], s.count == 1 { return s }
        guard let name = keyName(for: code), name.count == 1 else { return nil }
        return name
    }
}
