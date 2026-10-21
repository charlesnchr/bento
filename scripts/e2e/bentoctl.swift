// End-to-end driver for testing the real Bento app with real input events.
// Build: swiftc -O scripts/e2e/bentoctl.swift -o /tmp/bentoctl
//   bentoctl key "ctrl+opt+left"          post a key combo (arrow/F-keys get fn flags like real keyboards)
//   bentoctl front <bundleid> [title]     make app (and a window whose title contains <title>) frontmost
//   bentoctl frontmost                    print frontmost app bundle id
//   bentoctl frame <bundleid> <title>     print AX frame "x y w h" of the window whose title contains <title>
//   bentoctl setframe <bundleid> <title> x y w h
//   bentoctl drag x1 y1 x2 y2 [mods]      mouse drag (mods like cmd+opt held during the drag)
//   bentoctl click x y [mods]
//   bentoctl throw x1 y1 x2 y2 [mods]     press at 1, release at 2, no drag events (one process)
//   bentoctl screens                      print screens' AX frames and visible frames
//   bentoctl windows <owner>              print on-screen CG windows of an owner: id layer x y w h title
//   add --expect <bundleid> (or --expect-pid <pid>) to key/drag/click/down to refuse input unless it goes to that app.
//   All input commands refuse to run while /tmp/bento-user-active exists (user came back).
import AppKit
import ApplicationServices
import Carbon.HIToolbox

let args = Array(CommandLine.arguments.dropFirst())
func fail(_ s: String) -> Never { FileHandle.standardError.write((s + "\n").data(using: .utf8)!); exit(1) }

let keyCodes: [String: Int] = [
    "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E, "f": kVK_ANSI_F,
    "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J, "k": kVK_ANSI_K, "l": kVK_ANSI_L,
    "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O, "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R,
    "s": kVK_ANSI_S, "t": kVK_ANSI_T, "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X,
    "y": kVK_ANSI_Y, "z": kVK_ANSI_Z, "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3,
    "4": kVK_ANSI_4, "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
    "minus": kVK_ANSI_Minus, "equal": kVK_ANSI_Equal, "leftbracket": kVK_ANSI_LeftBracket,
    "rightbracket": kVK_ANSI_RightBracket, "comma": kVK_ANSI_Comma, "period": kVK_ANSI_Period,
    "slash": kVK_ANSI_Slash, "semicolon": kVK_ANSI_Semicolon, "quote": kVK_ANSI_Quote, "backslash": kVK_ANSI_Backslash,
    "grave": kVK_ANSI_Grave, "return": kVK_Return, "tab": kVK_Tab, "space": kVK_Space, "delete": kVK_Delete,
    "escape": kVK_Escape, "left": kVK_LeftArrow, "right": kVK_RightArrow, "up": kVK_UpArrow, "down": kVK_DownArrow,
    "home": kVK_Home, "end": kVK_End, "pageup": kVK_PageUp, "pagedown": kVK_PageDown, "forwarddelete": kVK_ForwardDelete,
    "f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4, "f5": kVK_F5, "f6": kVK_F6, "f12": kVK_F12,
    "f13": kVK_F13, "f17": kVK_F17, "f18": kVK_F18, "f19": kVK_F19,
]

func parseFlags(_ tokens: [Substring]) -> CGEventFlags {
    var f: CGEventFlags = []
    for t in tokens {
        switch t {
        case "cmd": f.insert(.maskCommand)
        case "opt", "alt": f.insert(.maskAlternate)
        case "ctrl": f.insert(.maskControl)
        case "shift": f.insert(.maskShift)
        case "hyper": f.formUnion([.maskCommand, .maskAlternate, .maskControl, .maskShift])
        case "": break
        default: fail("bad modifier \(t)")
        }
    }
    return f
}

func postKey(_ combo: String) {
    let parts = combo.lowercased().split(separator: "+", omittingEmptySubsequences: false)
    guard let keyName = parts.last, let code = keyCodes[String(keyName)] else { fail("bad key \(combo)") }
    var flags = parseFlags(Array(parts.dropLast()))
    // Real keyboards set these on arrows / navigation / function keys.
    if [kVK_LeftArrow, kVK_RightArrow, kVK_UpArrow, kVK_DownArrow].contains(code) { flags.formUnion([.maskNumericPad, .maskSecondaryFn]) }
    if [kVK_Home, kVK_End, kVK_PageUp, kVK_PageDown, kVK_ForwardDelete, kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6,
        kVK_F12, kVK_F13, kVK_F17, kVK_F18, kVK_F19].contains(code) { flags.insert(.maskSecondaryFn) }
    let src = CGEventSource(stateID: .hidSystemState)
    let down = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(code), keyDown: true)!
    let up = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(code), keyDown: false)!
    down.flags = flags; up.flags = flags
    down.post(tap: .cghidEventTap); usleep(25000); up.post(tap: .cghidEventTap)
}

func axApp(_ bid: String) -> (AXUIElement, NSRunningApplication) {
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bid).first else { fail("\(bid) not running") }
    return (AXUIElementCreateApplication(app.processIdentifier), app)
}

func windows(_ el: AXUIElement) -> [AXUIElement] {
    var v: CFTypeRef?
    AXUIElementCopyAttributeValue(el, kAXWindowsAttribute as CFString, &v)
    return (v as? [AXUIElement]) ?? []
}

func title(_ w: AXUIElement) -> String {
    var v: CFTypeRef?
    AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &v)
    return v as? String ?? ""
}

func findWindow(_ bid: String, _ t: String) -> AXUIElement {
    let (el, _) = axApp(bid)
    guard let w = windows(el).first(where: { title($0).contains(t) }) else { fail("no window '\(t)' in \(bid)") }
    return w
}

func frame(_ w: AXUIElement) -> CGRect {
    var p: CFTypeRef?, s: CFTypeRef?
    AXUIElementCopyAttributeValue(w, kAXPositionAttribute as CFString, &p)
    AXUIElementCopyAttributeValue(w, kAXSizeAttribute as CFString, &s)
    var pt = CGPoint.zero, sz = CGSize.zero
    AXValueGetValue(p as! AXValue, .cgPoint, &pt); AXValueGetValue(s as! AXValue, .cgSize, &sz)
    return CGRect(origin: pt, size: sz)
}

func mouse(_ type: CGEventType, _ p: CGPoint, _ flags: CGEventFlags) {
    let e = CGEvent(mouseEventSource: CGEventSource(stateID: .hidSystemState), mouseType: type, mouseCursorPosition: p, mouseButton: .left)!
    e.flags = flags
    e.post(tap: .cghidEventTap)
}

// Safety: never post input while the user is active (see scripts/e2e/session),
// and with --expect <bundleid> only into that app.
var argv = args
var expectBID: String?
if let i = argv.firstIndex(of: "--expect"), i + 1 < argv.count { expectBID = argv[i + 1]; argv.removeSubrange(i...(i + 1)) }
// --expect-pid <pid>: same checks by process id (raw debug binaries have no bundle id).
var expectPID: pid_t?
if let i = argv.firstIndex(of: "--expect-pid"), i + 1 < argv.count, let p = pid_t(argv[i + 1]) { expectPID = p; argv.removeSubrange(i...(i + 1)) }
let inputCommands: Set<String> = ["key", "drag", "click", "down", "move", "up", "throw"]
if let c = argv.first, inputCommands.contains(c) {
    if FileManager.default.fileExists(atPath: "/tmp/bento-user-active") { FileHandle.standardError.write("user is active; refusing to post input\n".data(using: .utf8)!); exit(75) }
    if let pid = expectPID {
        if c == "key", NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
            fail("frontmost pid is \(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1), expected \(pid); not typing")
        }
        if c == "drag" || c == "click" || c == "down" || c == "throw" {
            let p = CGPoint(x: Double(argv[1])!, y: Double(argv[2])!)
            var el: AXUIElement?
            var owner: pid_t = 0
            if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(p.x), Float(p.y), &el) == .success, let el { AXUIElementGetPid(el, &owner) }
            if owner != pid { fail("point \(p) belongs to pid \(owner), expected \(pid); not clicking") }
        }
    }
    if let bid = expectBID {
        if c == "key", NSWorkspace.shared.frontmostApplication?.bundleIdentifier != bid {
            fail("frontmost is \(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "?"), expected \(bid); not typing")
        }
        if c == "drag" || c == "click" || c == "down" || c == "throw" {
            let p = CGPoint(x: Double(argv[1])!, y: Double(argv[2])!)
            var el: AXUIElement?
            var pid: pid_t = 0
            if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(p.x), Float(p.y), &el) == .success, let el { AXUIElementGetPid(el, &pid) }
            let owner = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
            if owner != bid { fail("point \(p) belongs to \(owner ?? "nothing"), expected \(bid); not clicking") }
        }
    }
}
// Register our pid so the guard never mistakes our own events for the user's.
if let c = argv.first, inputCommands.contains(c),
   let h = FileHandle(forWritingAtPath: "/tmp/bento-e2e-pids") ?? {
       FileManager.default.createFile(atPath: "/tmp/bento-e2e-pids", contents: nil); return FileHandle(forWritingAtPath: "/tmp/bento-e2e-pids") }() {
    h.seekToEndOfFile(); h.write("\(getpid())\n".data(using: .utf8)!); h.closeFile()
}
let args2 = argv
guard let cmd = args2.first else { fail("usage: see header") }
switch cmd {
case "key":
    for combo in args2.dropFirst() { postKey(combo); usleep(60000) }
case "front":
    let (el, app) = axApp(args2[1])
    AXUIElementSetAttributeValue(el, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    app.activate()
    if args2.count > 2 {
        let w = findWindow(args2[1], args2[2])
        AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
        AXUIElementPerformAction(w, kAXRaiseAction as CFString)
    }
    usleep(250000)
    print(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "?")
case "frontmost":
    print(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "?")
case "frame":
    let r = frame(findWindow(args2[1], args2[2]))
    print(Int(r.minX), Int(r.minY), Int(r.width), Int(r.height))
case "setframe":
    let w = findWindow(args2[1], args2[2])
    var p = CGPoint(x: Double(args2[3])!, y: Double(args2[4])!), s = CGSize(width: Double(args2[5])!, height: Double(args2[6])!)
    AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &s)!)
    AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &p)!)
    AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &s)!)
case "drag":
    let a = args2[1...4].map { Double($0)! }
    let flags = args2.count > 5 ? parseFlags(args2[5].split(separator: "+", omittingEmptySubsequences: false)) : []
    let p1 = CGPoint(x: a[0], y: a[1]), p2 = CGPoint(x: a[2], y: a[3])
    mouse(.mouseMoved, p1, flags); usleep(80000)
    mouse(.leftMouseDown, p1, flags); usleep(120000)
    let steps = 30
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        mouse(.leftMouseDragged, CGPoint(x: p1.x + (p2.x - p1.x) * t, y: p1.y + (p2.y - p1.y) * t), flags)
        usleep(16000)
    }
    usleep(250000)
    mouse(.leftMouseUp, p2, flags)
case "down", "move", "up":
    // Step-wise drag: down x y / move x y (drags in 20 steps from the last point) / up x y
    let p = CGPoint(x: Double(args2[1])!, y: Double(args2[2])!)
    let flags = args2.count > 3 ? parseFlags(args2[3].split(separator: "+", omittingEmptySubsequences: false)) : []
    if cmd == "down" { mouse(.mouseMoved, p, flags); usleep(60000); mouse(.leftMouseDown, p, flags) }
    else if cmd == "up" { mouse(.leftMouseUp, p, flags) }
    else {
        let start = CGEvent(source: nil)?.location ?? p
        for i in 1...20 {
            let t = Double(i) / 20
            mouse(.leftMouseDragged, CGPoint(x: start.x + (p.x - start.x) * t, y: start.y + (p.y - start.y) * t), flags)
            usleep(16000)
        }
    }
case "throw":
    // Press and release far apart with no drag events in between (one process).
    let a = args2[1...4].map { Double($0)! }
    let flags = args2.count > 5 ? parseFlags(args2[5].split(separator: "+", omittingEmptySubsequences: false)) : []
    let p1 = CGPoint(x: a[0], y: a[1]), p2 = CGPoint(x: a[2], y: a[3])
    mouse(.mouseMoved, p1, flags); usleep(60000)
    mouse(.leftMouseDown, p1, flags); usleep(80000)
    mouse(.leftMouseUp, p2, flags)
case "click":
    let p = CGPoint(x: Double(args2[1])!, y: Double(args2[2])!)
    let flags = args2.count > 3 ? parseFlags(args2[3].split(separator: "+", omittingEmptySubsequences: false)) : []
    mouse(.mouseMoved, p, flags); usleep(60000)
    mouse(.leftMouseDown, p, flags); usleep(40000); mouse(.leftMouseUp, p, flags)
case "screens":
    let h = NSScreen.screens.first!.frame.height
    for s in NSScreen.screens {
        let f = s.frame, v = s.visibleFrame
        print("frame", Int(f.minX), Int(h - f.maxY), Int(f.width), Int(f.height), "visible", Int(v.minX), Int(h - v.maxY), Int(v.width), Int(v.height))
    }
case "windows":
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
    for w in list where (w[kCGWindowOwnerName as String] as? String) == args2[1] {
        let b = w[kCGWindowBounds as String] as! [String: Any]
        print(w[kCGWindowNumber as String]!, w[kCGWindowLayer as String]!, b["X"]!, b["Y"]!, b["Width"]!, b["Height"]!, w[kCGWindowName as String] ?? "")
    }
default:
    fail("unknown command \(cmd)")
}
