// AX-level driver for the platform e2e tests (scripts/e2e/platform.sh).
// Targets the Bento instance under test by pid (dev binaries have no bundle id,
// so bentoctl's --expect can't address them). Same safety rules as bentoctl:
// refuses everything while /tmp/bento-user-active exists, only types into the
// given pid when it is frontmost, only clicks points owned by that pid, and
// registers its pid with the input guard.
// Build: swiftc -O scripts/e2e/platform-ctl.swift -o /tmp/platform-ctl
//
//   platform-ctl tree <pid> [depth]            dump the AX tree (role id title value frame)
//   platform-ctl find <pid> <query>            print "x y w h" (AX coords) of the first match
//   platform-ctl count <pid> <query>           number of matches
//   platform-ctl press <pid> <query>           AXPress the first match
//   platform-ctl value <pid> <query>           print its AXValue
//   platform-ctl setvalue <pid> <query> <text> set AXValue (text fields) and confirm
//   platform-ctl attr <pid> <query> <AXAttr>   print an attribute
//   platform-ctl wait <pid> <query> [secs]     wait until a match exists (exit 1 on timeout)
//   platform-ctl gone <pid> <query> [secs]     wait until no match exists
//   platform-ctl front <pid>                   make the pid frontmost (it must be ours)
//   platform-ctl frontmost                     print "<pid> <bundle id>" of the frontmost app
//   platform-ctl key <pid> <combo>...          post key combos; refuses unless <pid> is frontmost
//   platform-ctl keyto <bundleid> <combo>...   same, for a test app we launched (by bundle id)
//   platform-ctl type <pid> <text>             type text (US layout) into <pid> when it is frontmost
//   platform-ctl click <pid> x y               click; refuses unless the point belongs to <pid>
//   platform-ctl clickel <pid> <query> [dx]    click the centre (or maxX-dx) of a matched element
//   platform-ctl hold <combo> <secs>           own a global hotkey (simulates another app)
//   platform-ctl focusedtitle <bundleid>       title of the focused window of an app
//   platform-ctl url <bento-home> <bento://…>  open a bento:// URL in the dev instance with that BENTO_HOME
//   platform-ctl cgwindows <pid>               on-screen windows of a pid: id layer x y w h title
//
// Query: space-separated terms that must all match: id=, role=, subrole=, title=,
// title~= (contains), desc=, desc~=, value=, value~=, help~=, index=N, and
// in=extras|menubar to search only the status items / main menu. "_" = space.
//   platform-ctl appstate <bundleid>           "<running> <hidden> <active>"
import AppKit
import ApplicationServices
import Carbon.HIToolbox

setvbuf(stdout, nil, _IOLBF, 0)
let args = Array(CommandLine.arguments.dropFirst())
func fail(_ s: String, code: Int32 = 1) -> Never { FileHandle.standardError.write((s + "\n").data(using: .utf8)!); exit(code) }
guard let cmd = args.first else { fail("usage: see header") }

let userFlag = "/tmp/bento-user-active"
func refuseIfUserActive() {
    if FileManager.default.fileExists(atPath: userFlag) { fail("user is active; refusing", code: 75) }
}
func registerWithGuard() {
    let path = "/tmp/bento-e2e-pids"
    if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
    if let h = FileHandle(forWritingAtPath: path) { h.seekToEndOfFile(); h.write("\(getpid())\n".data(using: .utf8)!); h.closeFile() }
}

// MARK: AX helpers

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}
func str(_ el: AXUIElement, _ name: String) -> String? {
    guard let v = attr(el, name) else { return nil }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
}
func children(_ el: AXUIElement) -> [AXUIElement] {
    var out: [AXUIElement] = []
    for name in [kAXChildrenAttribute, "AXExtrasMenuBar"] {
        if let v = attr(el, name) {
            if CFGetTypeID(v) == AXUIElementGetTypeID() { out.append(v as! AXUIElement) }
            else if let list = v as? [AnyObject] { out += list.filter { CFGetTypeID($0) == AXUIElementGetTypeID() }.map { $0 as! AXUIElement } }
        }
    }
    return out
}
func frame(_ el: AXUIElement) -> CGRect? {
    guard let p = attr(el, kAXPositionAttribute), let s = attr(el, kAXSizeAttribute),
          CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var pt = CGPoint.zero, sz = CGSize.zero
    AXValueGetValue(p as! AXValue, .cgPoint, &pt)
    AXValueGetValue(s as! AXValue, .cgSize, &sz)
    return CGRect(origin: pt, size: sz)
}
func appElement(_ pid: pid_t) -> AXUIElement {
    let el = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(el, 3)
    return el
}

struct Query {
    var terms: [(String, String)] = []
    var index = 0
    var scope: String? { terms.first { $0.0 == "in" }?.1 }
    init(_ s: String) {
        for part in s.split(separator: " ", omittingEmptySubsequences: true) {
            let p = String(part)
            if let r = p.range(of: "~=") { terms.append((String(p[..<r.lowerBound]) + "~", String(p[r.upperBound...]).replacingOccurrences(of: "_", with: " "))) }
            else if let r = p.range(of: "=") {
                let k = String(p[..<r.lowerBound]), v = String(p[r.upperBound...]).replacingOccurrences(of: "_", with: " ")
                if k == "index" { index = Int(v) ?? 0 } else { terms.append((k, v)) }
            }
        }
    }
    func matches(_ el: AXUIElement) -> Bool {
        for (k, v) in terms {
            if k == "in" { continue }
            let field: String?
            switch k.replacingOccurrences(of: "~", with: "") {
            case "id": field = str(el, "AXIdentifier")
            case "role": field = str(el, kAXRoleAttribute)
            case "subrole": field = str(el, kAXSubroleAttribute)
            case "title": field = str(el, kAXTitleAttribute)
            case "desc": field = str(el, kAXDescriptionAttribute)
            case "value": field = str(el, kAXValueAttribute)
            case "help": field = str(el, kAXHelpAttribute)
            default: field = nil
            }
            guard let f = field else { return false }
            if k.hasSuffix("~") { if !f.localizedCaseInsensitiveContains(v) { return false } } else if f != v { return false }
        }
        return true
    }
}

func search(_ pid: pid_t, _ q: Query, limit: Int = 4000) -> [AXUIElement] {
    var out: [AXUIElement] = []
    let app = appElement(pid)
    var queue = [app]
    // in=extras / in=menubar: only the status items / the main menu.
    if let scope = q.scope {
        guard let root = attr(app, scope == "extras" ? "AXExtrasMenuBar" : kAXMenuBarAttribute),
              CFGetTypeID(root) == AXUIElementGetTypeID() else { return [] }
        queue = [root as! AXUIElement]
    }
    var seen = 0
    while !queue.isEmpty, seen < limit {
        let el = queue.removeFirst()
        seen += 1
        if q.matches(el) { out.append(el) }
        queue += children(el)
    }
    return out
}

func one(_ pid: pid_t, _ qs: String) -> AXUIElement {
    let q = Query(qs)
    let all = search(pid, q)
    guard q.index < all.count else { fail("no match for '\(qs)' in pid \(pid) (\(all.count) matches)") }
    return all[q.index]
}

func pidArg(_ i: Int) -> pid_t {
    guard args.count > i, let p = pid_t(args[i]) else { fail("missing pid") }
    guard NSRunningApplication(processIdentifier: p) != nil else { fail("pid \(p) not running") }
    return p
}

// MARK: Input

let keyCodes: [String: Int] = [
    "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E, "f": kVK_ANSI_F,
    "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J, "k": kVK_ANSI_K, "l": kVK_ANSI_L,
    "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O, "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R,
    "s": kVK_ANSI_S, "t": kVK_ANSI_T, "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X,
    "y": kVK_ANSI_Y, "z": kVK_ANSI_Z, "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3,
    "4": kVK_ANSI_4, "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
    "minus": kVK_ANSI_Minus, "equal": kVK_ANSI_Equal, "comma": kVK_ANSI_Comma, "period": kVK_ANSI_Period,
    "slash": kVK_ANSI_Slash, "return": kVK_Return, "tab": kVK_Tab, "space": kVK_Space, "delete": kVK_Delete,
    "forwarddelete": kVK_ForwardDelete, "escape": kVK_Escape, "left": kVK_LeftArrow, "right": kVK_RightArrow,
    "up": kVK_UpArrow, "down": kVK_DownArrow, "home": kVK_Home, "end": kVK_End,
    "f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4, "f5": kVK_F5, "f6": kVK_F6, "f7": kVK_F7, "f8": kVK_F8,
    "f9": kVK_F9, "f10": kVK_F10, "f11": kVK_F11, "f12": kVK_F12, "f13": kVK_F13, "f14": kVK_F14, "f15": kVK_F15,
    "f16": kVK_F16, "f17": kVK_F17, "f18": kVK_F18, "f19": kVK_F19, "f20": kVK_F20,
    "lcmd": kVK_Command, "lshift": kVK_Shift, "lopt": kVK_Option, "lctrl": kVK_Control,
]
let fnKeys: Set<Int> = [kVK_LeftArrow, kVK_RightArrow, kVK_UpArrow, kVK_DownArrow, kVK_Home, kVK_End, kVK_ForwardDelete,
                        kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6, kVK_F7, kVK_F8, kVK_F9, kVK_F10, kVK_F11, kVK_F12,
                        kVK_F13, kVK_F14, kVK_F15, kVK_F16, kVK_F17, kVK_F18, kVK_F19, kVK_F20]

func flags(_ tokens: [Substring]) -> CGEventFlags {
    var f: CGEventFlags = []
    for t in tokens {
        switch t {
        case "cmd": f.insert(.maskCommand)
        case "opt", "alt": f.insert(.maskAlternate)
        case "ctrl": f.insert(.maskControl)
        case "shift": f.insert(.maskShift)
        case "hyper": f.formUnion([.maskCommand, .maskAlternate, .maskControl, .maskShift])
        default: fail("bad modifier \(t)")
        }
    }
    return f
}

func postKey(_ combo: String) {
    let parts = combo.lowercased().split(separator: "+")
    guard let name = parts.last, let code = keyCodes[String(name)] else { fail("bad key \(combo)") }
    var f = flags(Array(parts.dropLast()))
    let src = CGEventSource(stateID: .hidSystemState)
    if ["lcmd", "lshift", "lopt", "lctrl"].contains(String(name)) {
        // A bare modifier press: flagsChanged down/up.
        let mask: CGEventFlags = ["lcmd": .maskCommand, "lshift": .maskShift, "lopt": .maskAlternate, "lctrl": .maskControl][String(name)]!
        let down = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(code), keyDown: true)!
        down.type = .flagsChanged; down.flags = f.union(mask)
        let up = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(code), keyDown: false)!
        up.type = .flagsChanged; up.flags = f
        down.post(tap: .cghidEventTap); usleep(40000); up.post(tap: .cghidEventTap)
        return
    }
    if [kVK_LeftArrow, kVK_RightArrow, kVK_UpArrow, kVK_DownArrow].contains(code) { f.insert(.maskNumericPad) }
    if fnKeys.contains(code) { f.insert(.maskSecondaryFn) }
    let down = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(code), keyDown: true)!
    let up = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(code), keyDown: false)!
    down.flags = f; up.flags = f
    down.post(tap: .cghidEventTap); usleep(25000); up.post(tap: .cghidEventTap)
}

/// Synthetic key events carry modifier flags without flagsChanged events, so
/// the system can think ⌃⌥⌘ are still down afterwards (the next click would
/// be a ⌃-click = context menu). Release them explicitly.
func releaseModifiers() {
    let src = CGEventSource(stateID: .hidSystemState)
    for code in [kVK_Control, kVK_Option, kVK_Command, kVK_Shift] {
        guard let e = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(code), keyDown: false) else { continue }
        e.type = .flagsChanged
        e.flags = []
        e.post(tap: .cghidEventTap)
    }
}

func clickAt(_ p: CGPoint) {
    let src = CGEventSource(stateID: .hidSystemState)
    for (type, wait) in [(CGEventType.mouseMoved, 60000), (.leftMouseDown, 40000), (.leftMouseUp, 0)] {
        let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: .left)!
        e.flags = [] // a plain click, whatever modifier state is left over
        e.post(tap: .cghidEventTap)
        if wait > 0 { usleep(useconds_t(wait)) }
    }
}

/// Key combos for typing text (US layout): "Ab/." -> shift+a, b, slash, period.
func combos(forText text: String) -> [String] {
    let symbols: [Character: String] = ["/": "slash", ".": "period", ",": "comma", "-": "minus", "=": "equal", " ": "space"]
    return text.map { ch in
        if let s = symbols[ch] { return s }
        let lower = String(ch).lowercased()
        return ch.isUppercase ? "shift+" + lower : lower
    }
}

func ownerOf(_ p: CGPoint) -> pid_t {
    var el: AXUIElement?
    var pid: pid_t = 0
    if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(p.x), Float(p.y), &el) == .success, let el { AXUIElementGetPid(el, &pid) }
    return pid
}

func click(_ pid: pid_t, _ p: CGPoint) {
    refuseIfUserActive()
    let owner = ownerOf(p)
    guard owner == pid else { fail("point \(p) belongs to pid \(owner), expected \(pid); not clicking") }
    registerWithGuard()
    clickAt(p)
}

func waitFor(_ cond: () -> Bool, _ secs: Double) -> Bool {
    let end = Date().addingTimeInterval(secs)
    while Date() < end {
        if cond() { return true }
        usleep(100_000)
    }
    return cond()
}

// MARK: Commands

switch cmd {
case "tree":
    let pid = pidArg(1)
    let maxDepth = args.count > 2 ? Int(args[2]) ?? 12 : 12
    func dump(_ el: AXUIElement, _ depth: Int) {
        guard depth <= maxDepth else { return }
        let f = frame(el).map { "\(Int($0.minX)),\(Int($0.minY)) \(Int($0.width))x\(Int($0.height))" } ?? ""
        let parts = [str(el, kAXRoleAttribute), str(el, kAXSubroleAttribute).map { "sub=\($0)" }, str(el, "AXIdentifier").map { "id=\($0)" },
                     str(el, kAXTitleAttribute).map { "title=\($0)" }, str(el, kAXDescriptionAttribute).map { "desc=\($0)" },
                     str(el, kAXValueAttribute).map { "value=\($0.prefix(60))" }, f].compactMap { $0 }.filter { !$0.isEmpty }
        print(String(repeating: "  ", count: depth) + parts.joined(separator: " "))
        for c in children(el) { dump(c, depth + 1) }
    }
    dump(appElement(pid), 0)
case "find":
    let el = one(pidArg(1), args[2])
    guard let r = frame(el) else { fail("no frame") }
    print(Int(r.minX), Int(r.minY), Int(r.width), Int(r.height))
case "count":
    print(search(pidArg(1), Query(args[2])).count)
case "press":
    refuseIfUserActive()
    let el = one(pidArg(1), args[2])
    let err = AXUIElementPerformAction(el, kAXPressAction as CFString)
    if err != .success { fail("AXPress failed: \(err.rawValue)") }
case "value":
    print(str(one(pidArg(1), args[2]), kAXValueAttribute) ?? "")
case "setvalue":
    refuseIfUserActive()
    let el = one(pidArg(1), args[2])
    AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    let err = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, args[3] as CFString)
    if err != .success { fail("set value failed: \(err.rawValue)") }
    AXUIElementPerformAction(el, kAXConfirmAction as CFString)
case "attr":
    let el = one(pidArg(1), args[2])
    if let v = attr(el, args[3]) { print(v) } else { print("") }
case "wait", "gone":
    let pid = pidArg(1)
    let q = Query(args[2])
    let secs = args.count > 3 ? Double(args[3]) ?? 5 : 5
    let ok = waitFor({ cmd == "wait" ? !search(pid, q).isEmpty : search(pid, q).isEmpty }, secs)
    if !ok { fail("timeout waiting for \(cmd == "wait" ? "" : "absence of ")'\(args[2])'") }
case "front":
    refuseIfUserActive()
    let pid = pidArg(1)
    AXUIElementSetAttributeValue(appElement(pid), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    NSRunningApplication(processIdentifier: pid)?.activate()
    _ = waitFor({ NSWorkspace.shared.frontmostApplication?.processIdentifier == pid }, 2)
    print(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0)
case "frontmost":
    let app = NSWorkspace.shared.frontmostApplication
    print(app?.processIdentifier ?? 0, app?.bundleIdentifier ?? "-")
case "key", "keyto", "type":
    refuseIfUserActive()
    let front = NSWorkspace.shared.frontmostApplication
    if cmd == "keyto" {
        guard front?.bundleIdentifier == args[1] else { fail("frontmost is \(front?.bundleIdentifier ?? "?"), expected \(args[1]); not typing") }
    } else {
        let pid = pidArg(1)
        guard front?.processIdentifier == pid else { fail("frontmost is \(front?.processIdentifier ?? 0) (\(front?.bundleIdentifier ?? "?")), expected \(pid); not typing") }
    }
    registerWithGuard()
    let list = cmd == "type" ? combos(forText: args.dropFirst(2).joined(separator: " ")) : Array(args.dropFirst(2))
    for combo in list { postKey(combo); usleep(cmd == "type" ? 30000 : 80000) }
    releaseModifiers()
case "click":
    click(pidArg(1), CGPoint(x: Double(args[2])!, y: Double(args[3])!))
case "clickel":
    let pid = pidArg(1)
    let el = one(pid, args[2])
    guard let r = frame(el) else { fail("no frame") }
    let dx = args.count > 3 ? Double(args[3]) : nil
    click(pid, CGPoint(x: dx.map { r.maxX - $0 } ?? r.midX, y: r.midY))
case "hold":
    // Owns a combination system-wide like another app would.
    guard args.count > 2, let secs = Double(args[2]) else { fail("usage: hold <combo> <secs>") }
    _ = NSApplication.shared
    let parts = args[1].lowercased().split(separator: "+")
    guard let name = parts.last, let code = keyCodes[String(name)] else { fail("bad key") }
    let f = flags(Array(parts.dropLast()))
    var mods: UInt32 = 0
    if f.contains(.maskCommand) { mods |= UInt32(cmdKey) }
    if f.contains(.maskAlternate) { mods |= UInt32(optionKey) }
    if f.contains(.maskControl) { mods |= UInt32(controlKey) }
    if f.contains(.maskShift) { mods |= UInt32(shiftKey) }
    var ref: EventHotKeyRef?
    let status = RegisterEventHotKey(UInt32(code), mods, EventHotKeyID(signature: 0x504C4154, id: 1), GetApplicationEventTarget(), 0, &ref)
    guard status == noErr else { fail("RegisterEventHotKey failed: \(status)") }
    print("holding \(args[1])")
    RunLoop.current.run(until: Date().addingTimeInterval(secs))
case "url":
    // bento:// URL for the dev instance whose BENTO_HOME is args[1] (BentoShell dev hook).
    guard args.count > 2 else { fail("usage: url <bento-home> <bento://…>") }
    DistributedNotificationCenter.default().postNotificationName(Notification.Name("com.charles.bento.dev.url"), object: args[1],
                                                                 userInfo: ["url": args[2]], deliverImmediately: true)
    usleep(50000)
case "cgwindows":
    // On-screen windows of a pid: id layer x y w h title
    let pid = pidArg(1)
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
    for w in list where (w[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) == pid {
        let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
        print(w[kCGWindowNumber as String] ?? 0, w[kCGWindowLayer as String] ?? 0, b["X"] ?? 0, b["Y"] ?? 0, b["Width"] ?? 0, b["Height"] ?? 0,
              w[kCGWindowName as String] ?? "")
    }
case "syscombo":
    // An enabled macOS shortcut in config syntax (e.g. "cmd+space"), for "used by macOS" tests.
    var array: Unmanaged<CFArray>?
    guard CopySymbolicHotKeys(&array) == noErr, let list = array?.takeRetainedValue() as? [[String: Any]] else { fail("no symbolic hotkeys") }
    let names = Dictionary(keyCodes.map { ($0.value, $0.key) }, uniquingKeysWith: { a, _ in a })
    for e in list where (e[kHISymbolicHotKeyEnabled] as? Bool) == true {
        guard let code = (e[kHISymbolicHotKeyCode] as? NSNumber)?.intValue, let name = names[code], !name.hasPrefix("l"),
              let m = (e[kHISymbolicHotKeyModifiers] as? NSNumber)?.intValue, m & (cmdKey | optionKey | controlKey) != 0 else { continue }
        var parts: [String] = []
        if m & controlKey != 0 { parts.append("ctrl") }
        if m & optionKey != 0 { parts.append("opt") }
        if m & cmdKey != 0 { parts.append("cmd") }
        if m & shiftKey != 0 { parts.append("shift") }
        print((parts + [name]).joined(separator: "+"))
        exit(0)
    }
    fail("no usable enabled macOS shortcut")
case "appstate":
    // "<running> <hidden> <active>" for a bundle id, e.g. "true false true".
    let app = NSRunningApplication.runningApplications(withBundleIdentifier: args[1]).first { !$0.isTerminated }
    print(app != nil, app?.isHidden ?? false, app?.isActive ?? false)
case "focusedtitle":
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: args[1]).first else { fail("not running") }
    let el = appElement(app.processIdentifier)
    if let w = attr(el, kAXFocusedWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID() {
        print(str(w as! AXUIElement, kAXTitleAttribute) ?? "")
    } else { print("") }
default:
    fail("unknown command \(cmd)")
}
