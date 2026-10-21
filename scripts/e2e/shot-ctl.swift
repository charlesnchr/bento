// Input driver for Shot e2e tests against a raw (bundle-less) Bento binary.
// bentoctl's --expect needs a bundle id, which the dev binary doesn't have;
// this tool checks the target by process id instead, with the same rules:
// it refuses while the user is active (/tmp/bento-user-active, exit 75) and
// only posts input whose target is the Bento under test (or our own
// TextEdit document).
// Build: swiftc -O scripts/e2e/shot-ctl.swift -o /tmp/shot-ctl
//   shot-ctl drag x1 y1 x2 y2 [mods] --pid P      both points must be on a window of P
//   shot-ctl click|rclick x y [mods] --pid P
//   shot-ctl move x y --pid P                      pointer move (hover, loupe)
//   shot-ctl key combo... --pid P [--doc NAME]     P frontmost, or P's overlay (layer >= 1000)
//                                                  on screen, or TextEdit frontmost with NAME open
//   shot-ctl scroll x y dy --doc NAME              pixel scroll over our TextEdit document
//   shot-ctl windows P                             id layer x y w h title of P's on-screen windows
//   shot-ctl wait P layer [timeout]                wait until P has an on-screen window at layer
//   shot-ctl gone P layer [timeout]                wait until it hasn't
//   shot-ctl top x y                               owner pid / layer / name of the window at a point
//   shot-ctl flags [mods] --pid P                  modifier change (hold/release Option for the ruler)
//   shot-ctl clip-save FILE | clip-restore FILE    keep the user's clipboard across a session
//   shot-ctl clip                                  "image WxH" / "text <first line>" / "empty"
//   shot-ctl clip-png FILE                         write the clipboard image as PNG
//   shot-ctl imgsize FILE | ocr FILE | imgdiff A B (mean abs channel difference 0…255)
//   shot-ctl axclose BUNDLEID TITLE                close a window WE opened in another app (exact title)
//   shot-ctl opaque FILE                           WxH of the opaque (alpha >= 250) bounding box
import AppKit
import ApplicationServices
import Carbon.HIToolbox
import Vision

var argv = Array(CommandLine.arguments.dropFirst())
func fail(_ s: String, _ code: Int32 = 1) -> Never { FileHandle.standardError.write((s + "\n").data(using: .utf8)!); exit(code) }
func option(_ name: String) -> String? {
    guard let i = argv.firstIndex(of: name), i + 1 < argv.count else { return nil }
    let v = argv[i + 1]
    argv.removeSubrange(i...(i + 1))
    return v
}
let pidOpt = option("--pid").flatMap { pid_t($0) }
let docOpt = option("--doc")

let keyCodes: [String: Int] = [
    "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E, "f": kVK_ANSI_F,
    "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J, "k": kVK_ANSI_K, "l": kVK_ANSI_L,
    "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O, "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R,
    "s": kVK_ANSI_S, "t": kVK_ANSI_T, "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X,
    "y": kVK_ANSI_Y, "z": kVK_ANSI_Z, "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3,
    "4": kVK_ANSI_4, "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
    "leftbracket": kVK_ANSI_LeftBracket, "rightbracket": kVK_ANSI_RightBracket, "return": kVK_Return,
    "tab": kVK_Tab, "space": kVK_Space, "escape": kVK_Escape, "left": kVK_LeftArrow, "right": kVK_RightArrow,
    "up": kVK_UpArrow, "down": kVK_DownArrow, "f13": kVK_F13, "f14": kVK_F14, "f15": kVK_F15, "f16": kVK_F16,
    "f17": kVK_F17, "f18": kVK_F18, "f19": kVK_F19,
]

func flags(_ s: String?) -> CGEventFlags {
    var f: CGEventFlags = []
    for t in (s ?? "").split(separator: "+") {
        switch t {
        case "cmd": f.insert(.maskCommand)
        case "opt", "alt": f.insert(.maskAlternate)
        case "ctrl": f.insert(.maskControl)
        case "shift": f.insert(.maskShift)
        default: fail("bad modifier \(t)")
        }
    }
    return f
}

struct Win { let id: Int; let pid: pid_t; let layer: Int; let frame: CGRect; let owner: String; let title: String }

func onScreenWindows() -> [Win] {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
    return list.compactMap { d in
        guard let id = d[kCGWindowNumber as String] as? Int, let pid = d[kCGWindowOwnerPID as String] as? pid_t,
              let layer = d[kCGWindowLayer as String] as? Int, let b = d[kCGWindowBounds as String] as? NSDictionary,
              let frame = CGRect(dictionaryRepresentation: b) else { return nil }
        if let a = d[kCGWindowAlpha as String] as? Double, a < 0.01 { return nil }
        return Win(id: id, pid: pid, layer: layer, frame: frame, owner: d[kCGWindowOwnerName as String] as? String ?? "",
                   title: d[kCGWindowName as String] as? String ?? "")
    }
}

/// Click-through system overlays (Dock's and Notification Center's full-screen windows).
let systemOverlays: Set<String> = ["Window Server", "Dock", "Notification Center", "Notification Centre"]

/// The topmost window containing a point, ignoring the menu bar / Dock / cursor layers.
func top(at p: CGPoint) -> Win? {
    onScreenWindows().first { $0.frame.contains(p) && $0.layer < 2000 && !systemOverlays.contains($0.owner) }
}

func requirePid() -> pid_t { guard let p = pidOpt else { fail("--pid required") }; return p }

func requireOwn(_ p: CGPoint) {
    let pid = requirePid()
    guard let w = top(at: p), w.pid == pid else {
        let w = top(at: p)
        fail("point \(p) is on \(w.map { "\($0.owner) (pid \($0.pid), layer \($0.layer))" } ?? "nothing"), expected pid \(pid); not posting")
    }
}

func textEditDocFront(_ name: String) -> Bool {
    guard let app = NSWorkspace.shared.frontmostApplication, app.bundleIdentifier == "com.apple.TextEdit" else { return false }
    let el = AXUIElementCreateApplication(app.processIdentifier)
    var w: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXFocusedWindowAttribute as CFString, &w) == .success, let w else { return false }
    var t: CFTypeRef?
    AXUIElementCopyAttributeValue(w as! AXUIElement, kAXTitleAttribute as CFString, &t)
    return (t as? String)?.contains(name) == true
}

func mouse(_ type: CGEventType, _ p: CGPoint, _ f: CGEventFlags, button: CGMouseButton = .left) {
    guard let e = CGEvent(mouseEventSource: CGEventSource(stateID: .hidSystemState), mouseType: type, mouseCursorPosition: p, mouseButton: button) else { return }
    e.flags = f
    e.post(tap: .cghidEventTap)
}

func postKey(_ combo: String) {
    let parts = combo.lowercased().split(separator: "+").map(String.init)
    guard let name = parts.last, let code = keyCodes[name] else { fail("bad key \(combo)") }
    var f = flags(parts.dropLast().joined(separator: "+"))
    if [kVK_LeftArrow, kVK_RightArrow, kVK_UpArrow, kVK_DownArrow].contains(code) { f.formUnion([.maskNumericPad, .maskSecondaryFn]) }
    if [kVK_F13, kVK_F14, kVK_F15, kVK_F16, kVK_F17, kVK_F18, kVK_F19].contains(code) { f.insert(.maskSecondaryFn) }
    let src = CGEventSource(stateID: .hidSystemState)
    guard let down = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(code), keyDown: true),
          let up = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(code), keyDown: false) else { return }
    down.flags = f; up.flags = f
    down.post(tap: .cghidEventTap); usleep(25000); up.post(tap: .cghidEventTap)
}

func point(_ i: Int) -> CGPoint {
    guard argv.count > i + 1, let x = Double(argv[i]), let y = Double(argv[i + 1]) else { fail("expected x y") }
    return CGPoint(x: x, y: y)
}

func waitFor(_ cond: () -> Bool, timeout: Double) -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end { if cond() { return true }; usleep(50000) }
    return cond()
}

func loadImage(_ path: String) -> CGImage {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { fail("can't read \(path)") }
    return img
}

/// RGBA8 pixels of an image scaled to w×h.
func rgba(_ img: CGImage, _ w: Int, _ h: Int) -> [UInt8] {
    var buf = [UInt8](repeating: 0, count: w * h * 4)
    buf.withUnsafeMutableBytes { raw in
        let ctx = CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.interpolationQuality = .medium
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    }
    return buf
}

func clipboardImage() -> CGImage? {
    let pb = NSPasteboard.general
    guard let data = pb.data(forType: .png) ?? pb.data(forType: .tiff),
          let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

guard let cmd = argv.first else { fail("usage: see header", 2) }
let inputCommands: Set<String> = ["drag", "click", "rclick", "move", "key", "scroll", "flags", "axclose"]
if inputCommands.contains(cmd) {
    if FileManager.default.fileExists(atPath: "/tmp/bento-user-active") { fail("user is active; refusing to post input", 75) }
    // Register so the guard never mistakes our events for the user's.
    let path = "/tmp/bento-e2e-pids"
    if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
    if let h = FileHandle(forWritingAtPath: path) { h.seekToEndOfFile(); h.write("\(getpid())\n".data(using: .utf8)!); h.closeFile() }
}

switch cmd {
case "drag":
    let p1 = point(1), p2 = point(3)
    let f = flags(argv.count > 5 ? argv[5] : nil)
    requireOwn(p1); requireOwn(p2)
    mouse(.mouseMoved, p1, f); usleep(80000)
    mouse(.leftMouseDown, p1, f); usleep(100000)
    for i in 1...24 {
        let t = Double(i) / 24
        mouse(.leftMouseDragged, CGPoint(x: p1.x + (p2.x - p1.x) * t, y: p1.y + (p2.y - p1.y) * t), f)
        usleep(12000)
    }
    usleep(120000)
    mouse(.leftMouseUp, p2, f)
case "click", "rclick":
    let p = point(1)
    let f = flags(argv.count > 3 ? argv[3] : nil)
    requireOwn(p)
    mouse(.mouseMoved, p, f); usleep(60000)
    if cmd == "click" {
        mouse(.leftMouseDown, p, f); usleep(40000); mouse(.leftMouseUp, p, f)
    } else {
        mouse(.rightMouseDown, p, f, button: .right); usleep(40000); mouse(.rightMouseUp, p, f, button: .right)
    }
case "move":
    let p = point(1)
    requireOwn(p)
    mouse(.mouseMoved, p, [])
case "key":
    let pid = requirePid()
    let overlayUp = onScreenWindows().contains { $0.pid == pid && $0.layer >= 1000 && $0.layer < 2000 }
    let frontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
    guard frontPid == pid || overlayUp || docOpt.map(textEditDocFront) == true else {
        fail("keys would go to \(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "?"), not Bento \(pid) or our document; not typing")
    }
    for combo in argv.dropFirst() { postKey(combo); usleep(70000) }
case "scroll":
    let p = point(1)
    guard argv.count > 3, let dy = Int32(argv[3]), let doc = docOpt else { fail("scroll x y dy --doc NAME") }
    // Bento's click-through region frame (layer 25) may lie on top; the scroll goes to what's below.
    let target = onScreenWindows().first { $0.frame.contains(p) && $0.layer < 2000 && !systemOverlays.contains($0.owner) && $0.pid != (pidOpt ?? -1) }
    guard let w = target, w.owner == "TextEdit", w.title.contains(doc) else { fail("point \(p) is not on our TextEdit document; not scrolling") }
    mouse(.mouseMoved, p, []); usleep(40000)
    var left = abs(dy)
    while left > 0 {
        let chunk = min(left, 30)
        left -= chunk
        if let e = CGEvent(scrollWheelEvent2Source: CGEventSource(stateID: .hidSystemState), units: .pixel, wheelCount: 1, wheel1: dy < 0 ? -chunk : chunk, wheel2: 0, wheel3: 0) {
            e.location = p
            e.post(tap: .cghidEventTap)
        }
        usleep(16000)
    }
case "windows":
    guard argv.count > 1, let pid = pid_t(argv[1]) else { fail("windows PID") }
    for w in onScreenWindows() where w.pid == pid {
        print(w.id, w.layer, Int(w.frame.minX), Int(w.frame.minY), Int(w.frame.width), Int(w.frame.height), w.title)
    }
case "wait", "gone":
    guard argv.count > 2, let pid = pid_t(argv[1]), let layer = Int(argv[2]) else { fail("\(cmd) PID LAYER [timeout [W H]]") }
    let timeout = argv.count > 3 ? Double(argv[3]) ?? 5 : 5
    let size = argv.count > 5 ? CGSize(width: Double(argv[4]) ?? 0, height: Double(argv[5]) ?? 0) : nil
    let ok = waitFor({
        onScreenWindows().contains { $0.pid == pid && $0.layer == layer && (size == nil || $0.frame.size == size!) } == (cmd == "wait")
    }, timeout: timeout)
    exit(ok ? 0 : 1)
case "axclose":
    // Close OUR window of another app (e.g. the Finder window the test opened) with its close button.
    guard argv.count > 2, let app = NSRunningApplication.runningApplications(withBundleIdentifier: argv[1]).first else { fail("axclose BUNDLEID TITLE") }
    let el = AXUIElementCreateApplication(app.processIdentifier)
    var v: CFTypeRef?
    AXUIElementCopyAttributeValue(el, kAXWindowsAttribute as CFString, &v)
    for w in (v as? [AXUIElement]) ?? [] {
        var t: CFTypeRef?
        AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &t)
        guard (t as? String) == argv[2] else { continue }
        var b: CFTypeRef?
        if AXUIElementCopyAttributeValue(w, kAXCloseButtonAttribute as CFString, &b) == .success, let b {
            AXUIElementPerformAction(b as! AXUIElement, kAXPressAction as CFString)
        }
    }
case "top":
    let p = point(1)
    if let w = top(at: p) { print(w.pid, w.layer, w.owner, w.title) } else { print("none") }
case "flags":
    let pid = requirePid()
    guard onScreenWindows().contains(where: { $0.pid == pid && $0.layer >= 1000 && $0.layer < 2000 }) else { fail("no overlay of \(pid) on screen; not posting") }
    let f = flags(argv.count > 1 ? argv[1] : nil)
    let vk = f.contains(.maskShift) ? kVK_Shift : f.contains(.maskCommand) ? kVK_Command : kVK_Option
    guard let e = CGEvent(keyboardEventSource: CGEventSource(stateID: .hidSystemState), virtualKey: CGKeyCode(vk), keyDown: !f.isEmpty) else { break }
    e.type = .flagsChanged
    e.flags = f
    e.post(tap: .cghidEventTap)
case "clip-save":
    guard argv.count > 1 else { fail("clip-save FILE") }
    let items = (NSPasteboard.general.pasteboardItems ?? []).map { item -> [String: Data] in
        var d: [String: Data] = [:]
        for t in item.types { if let v = item.data(forType: t) { d[t.rawValue] = v } }
        return d
    }
    let data = try! PropertyListSerialization.data(fromPropertyList: items, format: .binary, options: 0)
    try! data.write(to: URL(fileURLWithPath: argv[1]))
case "clip-restore":
    guard argv.count > 1, let data = FileManager.default.contents(atPath: argv[1]),
          let items = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [[String: Data]] else { fail("clip-restore FILE") }
    let pb = NSPasteboard.general
    pb.clearContents()
    let objs = items.map { d -> NSPasteboardItem in
        let it = NSPasteboardItem()
        for (t, v) in d { it.setData(v, forType: NSPasteboard.PasteboardType(t)) }
        return it
    }
    if !objs.isEmpty { pb.writeObjects(objs) }
case "clip":
    if let img = clipboardImage() { print("image \(img.width)x\(img.height)") }
    else if let s = NSPasteboard.general.string(forType: .string) { print("text " + (s.split(separator: "\n").first.map(String.init) ?? "")) }
    else { print("empty") }
case "clip-png":
    guard argv.count > 1, let img = clipboardImage(),
          let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: argv[1]) as CFURL, "public.png" as CFString, 1, nil) else { fail("no clipboard image") }
    CGImageDestinationAddImage(dest, img, nil)
    exit(CGImageDestinationFinalize(dest) ? 0 : 1)
case "opaque":
    guard argv.count > 1 else { fail("opaque FILE") }
    let img = loadImage(argv[1])
    let w = img.width, h = img.height
    let px = rgba(img, w, h)
    var minX = w, minY = h, maxX = -1, maxY = -1
    for y in 0..<h { for x in 0..<w where px[(y * w + x) * 4 + 3] >= 250 {
        minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
    } }
    print(maxX >= minX ? "\(maxX - minX + 1)x\(maxY - minY + 1)" : "0x0")
case "imgsize":
    guard argv.count > 1 else { fail("imgsize FILE") }
    let img = loadImage(argv[1])
    print("\(img.width)x\(img.height)")
case "ocr":
    guard argv.count > 1 else { fail("ocr FILE") }
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    try? VNImageRequestHandler(cgImage: loadImage(argv[1])).perform([req])
    for o in req.results ?? [] { if let s = o.topCandidates(1).first?.string { print(s) } }
case "imgdiff":
    guard argv.count > 2 else { fail("imgdiff A B") }
    let a = loadImage(argv[1]), b = loadImage(argv[2])
    let w = min(a.width, b.width, 400), h = max(1, Int(Double(w) * Double(a.height) / Double(a.width)))
    let pa = rgba(a, w, h), pb = rgba(b, w, h)
    var sum = 0
    for i in 0..<pa.count where i % 4 != 3 { sum += abs(Int(pa[i]) - Int(pb[i])) }
    print(String(format: "%.2f", Double(sum) / Double(w * h * 3)))
default:
    fail("unknown command \(cmd)", 2)
}
