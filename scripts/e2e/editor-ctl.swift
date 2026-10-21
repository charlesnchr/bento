// End-to-end helper for the ShotEditor regression script (scripts/e2e/editor.sh).
// Build: swiftc -O scripts/e2e/editor-ctl.swift -o /tmp/editor-ctl
//
// bentoctl's --expect needs a bundle id; the raw debug Bento binary has none,
// so this tool targets the process under test by pid instead. Same safety
// rules as bentoctl: refuses to post input while /tmp/bento-user-active exists,
// key events only while that pid is frontmost, mouse events only on points
// owned by that pid; registers its own pid so the guard ignores its events.
//
// Input (all need the target pid first):
//   key <pid> combo...                 key combos ("cmd+z", "escape", "t", "shift+leftbracket")
//   keypid <pid> combo...              same, posted into that process only (works while it isn't frontmost)
//   type <pid> text                    types ASCII text (letters, digits, space, basic punctuation)
//   click <pid> x y [mods]             click at global CG coordinates (top-left origin)
//   dblclick <pid> x y                 double-click
//   drag <pid> x1 y1 x2 y2 [mods] [ms] left-button drag in 30 steps, holding [ms] (120) at the end
//   scroll <pid> x y dy [mods]         scroll wheel (line units; positive = up)
// Inspection (no input):
//   windows <pid>                      on-screen windows: id layer alpha x y w h title
//   wait-window <pid> <title> [secs]   waits for a window whose title contains <title>; prints "id x y w h"
//   wait-gone <pid> <title> [secs]     waits until no such window is on screen
//   texts <pid> <title>                AX static texts / button titles in that window, one per line
//   unblock <pid> <title>              moves that window of <pid> (AX) to the nearest spot no other
//                                      window covers; prints "id x y w h"
//   spot <pid> x y w h                 prints a point in the rect that belongs to <pid>
//   frontmost                          frontmost app pid
//   footprint <pid>                    physical footprint in MB (what Activity Monitor shows as Memory)
// Pasteboard:
//   pb-info                            types; PNG pixel size and point size; then asks for TIFF (lazy
//                                      providers run) and prints its pixel/point size and how long it took
//   pb-save <file> / pb-restore <file> archive / restore every item and type (keeps the user's clipboard)
//   pb-image <png>                     puts a PNG file on the pasteboard (as PNG data)
//   pb-text <text>                     puts plain text on the pasteboard
//   pb-string                          prints the plain-text contents
// Fixtures:
//   mkimage <out.png> <w> <h> [scale]  test image: light background, dark bars and labels every 200 px
//   seed-history <root> <n> [days]     writes n synthetic captures spread over the last `days` days
import AppKit
import ApplicationServices
import Carbon.HIToolbox
import ImageIO
import UniformTypeIdentifiers

let argv = Array(CommandLine.arguments.dropFirst())
func fail(_ s: String, code: Int32 = 1) -> Never { FileHandle.standardError.write((s + "\n").data(using: .utf8)!); exit(code) }
func arg(_ i: Int) -> String {
    guard i < argv.count else { fail("missing argument \(i)") }
    return argv[i]
}
func num(_ i: Int) -> Double {
    guard let v = Double(arg(i)) else { fail("bad number \(arg(i))") }
    return v
}

let keyCodes: [String: Int] = [
    "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E, "f": kVK_ANSI_F,
    "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J, "k": kVK_ANSI_K, "l": kVK_ANSI_L,
    "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O, "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R,
    "s": kVK_ANSI_S, "t": kVK_ANSI_T, "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X,
    "y": kVK_ANSI_Y, "z": kVK_ANSI_Z, "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3,
    "4": kVK_ANSI_4, "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
    "minus": kVK_ANSI_Minus, "equal": kVK_ANSI_Equal, "leftbracket": kVK_ANSI_LeftBracket,
    "rightbracket": kVK_ANSI_RightBracket, "comma": kVK_ANSI_Comma, "period": kVK_ANSI_Period,
    "slash": kVK_ANSI_Slash, "semicolon": kVK_ANSI_Semicolon, "quote": kVK_ANSI_Quote,
    "return": kVK_Return, "tab": kVK_Tab, "space": kVK_Space, "delete": kVK_Delete,
    "escape": kVK_Escape, "left": kVK_LeftArrow, "right": kVK_RightArrow, "up": kVK_UpArrow, "down": kVK_DownArrow,
]
let typeable: [Character: (String, Bool)] = {
    var m: [Character: (String, Bool)] = [" ": ("space", false), ".": ("period", false), ",": ("comma", false),
                                          "-": ("minus", false), "/": ("slash", false), "!": ("1", true), "?": ("slash", true)]
    for c in "abcdefghijklmnopqrstuvwxyz0123456789" { m[c] = (String(c), false) }
    for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ" { m[c] = (String(c).lowercased(), true) }
    return m
}()

func parseFlags(_ s: String) -> CGEventFlags {
    var f: CGEventFlags = []
    for t in s.split(separator: "+") {
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

let source = CGEventSource(stateID: .hidSystemState)

/// Posts a key combo through the HID tap (normal routing to the frontmost app),
/// or straight into one process (`toPid`), which never reaches any other app.
func postKey(_ combo: String, toPid: pid_t? = nil) {
    let parts = combo.lowercased().split(separator: "+").map(String.init)
    guard let name = parts.last, let code = keyCodes[name] else { fail("bad key \(combo)") }
    var flags = parseFlags(parts.dropLast().joined(separator: "+"))
    if [kVK_LeftArrow, kVK_RightArrow, kVK_UpArrow, kVK_DownArrow].contains(code) { flags.formUnion([.maskNumericPad, .maskSecondaryFn]) }
    let down = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(code), keyDown: true)!
    let up = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(code), keyDown: false)!
    down.flags = flags; up.flags = flags
    if let toPid {
        down.postToPid(toPid); usleep(20000); up.postToPid(toPid)
    } else {
        down.post(tap: .cghidEventTap); usleep(20000); up.post(tap: .cghidEventTap)
    }
}

func mouse(_ type: CGEventType, _ p: CGPoint, _ flags: CGEventFlags = [], clicks: Int64 = 1) {
    let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: .left)!
    e.flags = flags
    e.setIntegerValueField(.mouseEventClickState, value: clicks)
    e.post(tap: .cghidEventTap)
}

/// Owner of whatever is on top at a point: AX first; when AX can't answer
/// (an app in a modal alert), the frontmost on-screen window containing it.
func pidAt(_ p: CGPoint) -> pid_t {
    var el: AXUIElement?
    var pid: pid_t = 0
    if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(p.x), Float(p.y), &el) == .success, let el {
        AXUIElementGetPid(el, &pid)
    }
    if pid != 0 { return pid }
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
    // Front to back, skipping the always-present system overlays (Notification
    // Center's full-screen layer, Dock, menu bar: layers 20 and up).
    for w in list where (w[kCGWindowLayer as String] as? Int ?? 0) < 20 {
        let b = w[kCGWindowBounds as String] as? [String: Double] ?? [:]
        let r = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
        let alpha = w[kCGWindowAlpha as String] as? Double ?? 1
        if r.contains(p), alpha > 0.01 { return w[kCGWindowOwnerPID as String] as? pid_t ?? 0 }
    }
    return 0
}

func cgWindows(_ pid: pid_t) -> [[String: Any]] {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
    return list.filter { ($0[kCGWindowOwnerPID as String] as? pid_t) == pid }
}

func describe(_ w: [String: Any]) -> (id: Int, layer: Int, alpha: Double, rect: CGRect, title: String) {
    let b = w[kCGWindowBounds as String] as? [String: Double] ?? [:]
    return (w[kCGWindowNumber as String] as? Int ?? 0, w[kCGWindowLayer as String] as? Int ?? 0,
            w[kCGWindowAlpha as String] as? Double ?? 1,
            CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0),
            w[kCGWindowName as String] as? String ?? "")
}

// MARK: Safety

let inputCommands: Set<String> = ["key", "keypid", "type", "click", "dblclick", "drag", "scroll"]
guard let cmd = argv.first else { fail("usage: see header", code: 2) }
var target: pid_t = 0
if inputCommands.contains(cmd) {
    if FileManager.default.fileExists(atPath: "/tmp/bento-user-active") { fail("user is active; refusing to post input", code: 75) }
    guard let t = pid_t(arg(1)) else { fail("bad pid") }
    target = t
    guard kill(target, 0) == 0 else { fail("pid \(target) is not running") }
    if cmd == "keypid" {
        // Delivered to that process only (e.g. a non-activating pin panel while
        // another app stays frontmost), so no frontmost check is needed.
    } else if cmd == "key" || cmd == "type" {
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
        if front != target { fail("frontmost pid is \(front), expected \(target); not typing") }
    } else {
        let p = CGPoint(x: num(2), y: num(3))
        let owner = pidAt(p)
        if owner != target { fail("point \(p) belongs to pid \(owner), expected \(target); not clicking") }
    }
    // Register so the guard never mistakes our events for the user's.
    let pids = "/tmp/bento-e2e-pids"
    if !FileManager.default.fileExists(atPath: pids) { FileManager.default.createFile(atPath: pids, contents: nil) }
    if let h = FileHandle(forWritingAtPath: pids) { h.seekToEndOfFile(); h.write("\(getpid())\n".data(using: .utf8)!); h.closeFile() }
}

// MARK: Pasteboard archive

func pbArchive() -> [[String: Data]] {
    (NSPasteboard.general.pasteboardItems ?? []).map { item in
        var d: [String: Data] = [:]
        for t in item.types { if let data = item.data(forType: t) { d[t.rawValue] = data } }
        return d
    }
}

// MARK: Fixtures

func makeImage(width w: Int, height h: Int) -> CGImage {
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setFillColor(CGColor(srgbRed: 0.96, green: 0.96, blue: 0.95, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
    // Full-width bars every 200 px, labelled "Row <y>" every 400 px across, so
    // any part of the image shows content (and tiling/flipping errors are visible).
    var y = 0
    while y < h {
        ctx.setFillColor(CGColor(srgbRed: 0.15, green: 0.3, blue: 0.7, alpha: 1))
        ctx.fill(CGRect(x: min(20, w / 4), y: h - y - 40, width: max(1, w - 2 * min(20, w / 4)), height: 24))
        if w > 60 {
            let s = NSAttributedString(string: "Row \(y)", attributes: [.font: NSFont.systemFont(ofSize: 28, weight: .bold),
                                                                         .foregroundColor: NSColor.black])
            var x = 30
            while x < w - 60 { s.draw(at: CGPoint(x: x, y: h - y - 90)); x += 400 }
        }
        y += 200
    }
    NSGraphicsContext.restoreGraphicsState()
    return ctx.makeImage()!
}

func png(_ image: CGImage, scale: Double) -> Data {
    let out = NSMutableData()
    let dest = CGImageDestinationCreateWithData(out, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, image, [kCGImagePropertyDPIWidth: 72 * scale, kCGImagePropertyDPIHeight: 72 * scale] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { fail("png encode failed") }
    return out as Data
}

func jpeg(_ image: CGImage) -> Data {
    let out = NSMutableData()
    let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, image, nil)
    CGImageDestinationFinalize(dest)
    return out as Data
}

func iso(_ d: Date) -> String { ISO8601DateFormatter().string(from: d) }

// MARK: Commands

switch cmd {
case "key":
    for combo in argv.dropFirst(2) { postKey(combo); usleep(50000) }
case "keypid":
    for combo in argv.dropFirst(2) { postKey(combo, toPid: target); usleep(50000) }
case "type":
    for ch in argv.dropFirst(2).joined(separator: " ") {
        guard let (name, shift) = typeable[ch] else { fail("can't type \(ch)") }
        postKey(shift ? "shift+" + name : name)
        usleep(15000)
    }
case "click", "dblclick":
    let p = CGPoint(x: num(2), y: num(3))
    let flags = argv.count > 4 ? parseFlags(arg(4)) : []
    mouse(.mouseMoved, p, flags); usleep(50000)
    for n in 1...(cmd == "dblclick" ? 2 : 1) {
        mouse(.leftMouseDown, p, flags, clicks: Int64(n)); usleep(30000)
        mouse(.leftMouseUp, p, flags, clicks: Int64(n)); usleep(60000)
    }
case "drag":
    let p1 = CGPoint(x: num(2), y: num(3)), p2 = CGPoint(x: num(4), y: num(5))
    let flags = argv.count > 6 && !arg(6).isEmpty ? parseFlags(arg(6)) : []
    let hold = argv.count > 7 ? useconds_t(num(7) * 1000) : 120_000
    mouse(.mouseMoved, p1, flags); usleep(60000)
    mouse(.leftMouseDown, p1, flags); usleep(80000)
    for i in 1...30 {
        let t = Double(i) / 30
        mouse(.leftMouseDragged, CGPoint(x: p1.x + (p2.x - p1.x) * t, y: p1.y + (p2.y - p1.y) * t), flags)
        usleep(12000)
    }
    // Hold at the target (drop targets need a moment to accept a drag).
    for _ in 0..<3 { mouse(.leftMouseDragged, p2, flags); usleep(hold / 3) }
    mouse(.leftMouseUp, p2, flags)
case "scroll":
    let p = CGPoint(x: num(2), y: num(3))
    let flags = argv.count > 5 ? parseFlags(arg(5)) : []
    mouse(.mouseMoved, p, flags); usleep(40000)
    let e = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 1, wheel1: Int32(num(4)), wheel2: 0, wheel3: 0)!
    e.location = p
    e.flags = flags
    e.post(tap: .cghidEventTap)
case "windows":
    for w in cgWindows(pid_t(arg(1)) ?? 0) {
        let d = describe(w)
        print(d.id, d.layer, String(format: "%.2f", d.alpha), Int(d.rect.minX), Int(d.rect.minY), Int(d.rect.width), Int(d.rect.height), d.title)
    }
case "wait-window", "wait-gone":
    let pid = pid_t(arg(1)) ?? 0, title = arg(2)
    let deadline = Date().addingTimeInterval(argv.count > 3 ? num(3) : 10)
    while Date() < deadline {
        let match = cgWindows(pid).map(describe).first { $0.title.contains(title) && $0.rect.width > 1 }
        if cmd == "wait-window", let m = match {
            print(m.id, Int(m.rect.minX), Int(m.rect.minY), Int(m.rect.width), Int(m.rect.height)); exit(0)
        }
        if cmd == "wait-gone", match == nil { exit(0) }
        usleep(100_000)
    }
    fail("timed out waiting for '\(title)' \(cmd == "wait-gone" ? "to close" : "")")
case "texts":
    let app = AXUIElementCreateApplication(pid_t(arg(1)) ?? 0)
    var v: CFTypeRef?
    AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &v)
    let wins = (v as? [AXUIElement]) ?? []
    func attr(_ e: AXUIElement, _ a: String) -> CFTypeRef? { var r: CFTypeRef?; AXUIElementCopyAttributeValue(e, a as CFString, &r); return r }
    guard let win = wins.first(where: { (attr($0, kAXTitleAttribute) as? String ?? "").contains(arg(2)) }) else { fail("no window \(arg(2))") }
    func walk(_ e: AXUIElement, _ depth: Int) {
        guard depth < 12 else { return }
        let role = attr(e, kAXRoleAttribute) as? String ?? ""
        if role == kAXStaticTextRole as String, let s = attr(e, kAXValueAttribute) as? String, !s.isEmpty { print(s) }
        if role == kAXButtonRole as String, let s = attr(e, kAXTitleAttribute) as? String, !s.isEmpty { print(s) }
        for c in (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { walk(c, depth + 1) }
    }
    walk(win, 0)
case "unblock":
    // Other apps' windows can sit above ours (a system alert, a floating panel).
    // Move our window (AX, our own process only) to the nearest spot where no
    // other window covers any part of it; prints "id x y w h".
    let pid = pid_t(arg(1)) ?? 0, title = arg(2)
    let app = AXUIElementCreateApplication(pid)
    func attr(_ e: AXUIElement, _ a: String) -> CFTypeRef? { var r: CFTypeRef?; AXUIElementCopyAttributeValue(e, a as CFString, &r); return r }
    let wins = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
    guard let win = wins.first(where: { (attr($0, kAXTitleAttribute) as? String ?? "").contains(title) }) else { fail("no window \(title)") }
    func axFrame() -> CGRect {
        var p = CGPoint.zero, s = CGSize.zero
        if let v = attr(win, kAXPositionAttribute) { AXValueGetValue(v as! AXValue, .cgPoint, &p) }
        if let v = attr(win, kAXSizeAttribute) { AXValueGetValue(v as! AXValue, .cgSize, &s) }
        return CGRect(origin: p, size: s)
    }
    func clear(_ r: CGRect) -> Bool {
        for i in 0..<9 { for j in 0..<7 {
            let p = CGPoint(x: r.minX + 6 + (r.width - 12) * CGFloat(i) / 8, y: r.minY + 6 + (r.height - 12) * CGFloat(j) / 6)
            if pidAt(p) != pid { return false }
        } }
        return true
    }
    var f = axFrame()
    if !clear(f) {
        let primaryH = NSScreen.screens.first?.frame.height ?? 0
        let vfc = (NSScreen.main ?? NSScreen.screens[0]).visibleFrame
        let vf = CGRect(x: vfc.minX, y: primaryH - vfc.maxY, width: vfc.width, height: vfc.height)
        var found = false
        // Same size anywhere on screen first; then shorter (big captures open
        // nearly screen-high, and a covering alert may leave no such spot).
        var size = f.size
        while !found {
            var spots: [CGPoint] = []
            for y in stride(from: vf.minY, through: max(vf.minY, vf.maxY - size.height), by: 80) {
                for x in stride(from: vf.minX, through: max(vf.minX, vf.maxX - size.width), by: 80) { spots.append(CGPoint(x: x, y: y)) }
            }
            spots.append(CGPoint(x: vf.minX, y: vf.maxY - size.height)) // bottom-left corner
            spots.sort { hypot($0.x - f.minX, $0.y - f.minY) < hypot($1.x - f.minX, $1.y - f.minY) }
            for s in spots {
                var p = s
                AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &p)!)
                usleep(70_000)
                f = axFrame()
                if clear(f) { found = true; break }
            }
            if found || size.height <= 330 { break }
            size.height = max(320, (size.height * 0.8).rounded())
            var sz = size
            AXUIElementSetAttributeValue(win, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &sz)!)
            usleep(100_000)
            size = axFrame().size
        }
        if !found { fail("no uncovered spot for '\(title)'") }
    }
    let id = cgWindows(pid).map(describe).first { $0.title.contains(title) }?.id ?? 0
    print(id, Int(f.minX), Int(f.minY), Int(f.width), Int(f.height))
case "spot":
    // spot <pid> x y w h: a point inside that rect that belongs to <pid> (centre first).
    let pid = pid_t(arg(1)) ?? 0
    let r = CGRect(x: num(2), y: num(3), width: num(4), height: num(5))
    var pts = [CGPoint(x: r.midX, y: r.midY)]
    for i in 1..<8 { for j in 1..<8 { pts.append(CGPoint(x: r.minX + r.width * CGFloat(i) / 8, y: r.minY + r.height * CGFloat(j) / 8)) } }
    guard let p = pts.first(where: { pidAt($0) == pid }) else { fail("no uncovered point in \(r)") }
    print(Int(p.x), Int(p.y))
case "frontmost":
    print(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0)
case "footprint":
    var info = rusage_info_v4()
    let ok = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid_t(arg(1)) ?? 0, RUSAGE_INFO_V4, $0) }
    }
    guard ok == 0 else { fail("proc_pid_rusage failed") }
    print(String(format: "%.1f", Double(info.ri_phys_footprint) / 1_048_576))
case "pb-info":
    let pb = NSPasteboard.general
    let types = pb.types ?? []
    print("types:", types.map(\.rawValue).joined(separator: ","))
    if let png = pb.data(forType: .png), let rep = NSBitmapImageRep(data: png) {
        print("png:", rep.pixelsWide, rep.pixelsHigh, "points:", Int(rep.size.width.rounded()), Int(rep.size.height.rounded()), "bytes:", png.count)
    } else { print("png: none") }
    let t0 = Date()
    if let tiff = pb.data(forType: .tiff), let rep = NSBitmapImageRep(data: tiff) {
        print("tiff:", rep.pixelsWide, rep.pixelsHigh, "points:", Int(rep.size.width.rounded()), Int(rep.size.height.rounded()),
              "bytes:", tiff.count, "ms:", Int(Date().timeIntervalSince(t0) * 1000))
    } else { print("tiff: none") }
case "pb-save":
    let data = try! PropertyListSerialization.data(fromPropertyList: pbArchive(), format: .binary, options: 0)
    try! data.write(to: URL(fileURLWithPath: arg(1)))
case "pb-restore":
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: arg(1))),
          let items = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [[String: Data]] else { fail("no archive") }
    let pb = NSPasteboard.general
    pb.clearContents()
    pb.writeObjects(items.map { d in
        let item = NSPasteboardItem()
        for (t, v) in d { item.setData(v, forType: NSPasteboard.PasteboardType(t)) }
        return item
    })
case "pb-image":
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: arg(1))) else { fail("can't read \(arg(1))") }
    let pb = NSPasteboard.general
    pb.clearContents()
    pb.setData(data, forType: .png)
case "pb-text":
    let pb = NSPasteboard.general
    pb.clearContents()
    pb.setString(argv.dropFirst().joined(separator: " "), forType: .string)
case "pb-string":
    print(NSPasteboard.general.string(forType: .string) ?? "")
case "mkimage":
    let scale = argv.count > 4 ? num(4) : 2
    try! png(makeImage(width: Int(num(2)), height: Int(num(3))), scale: scale).write(to: URL(fileURLWithPath: arg(1)))
case "seed-history":
    let root = URL(fileURLWithPath: arg(1), isDirectory: true)
    let n = Int(num(2)), days = argv.count > 3 ? num(3) : 20
    let image = makeImage(width: 400, height: 240)
    let original = png(image, scale: 2), thumb = jpeg(image)
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyyMMdd-HHmmss"
    for i in 0..<n {
        let date = Date().addingTimeInterval(-days * 86_400 * Double(i + 1) / Double(n))
        let id = f.string(from: date) + String(format: "-s%03d", i % 1000)
        let dir = root.appendingPathComponent(id, isDirectory: true)
        try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let annotations = i % 3 == 0 ? """
        [{"color":"#FF3B30","id":"\(UUID().uuidString)","kind":"arrow","p1":[10,10],"p2":[120,80],"size":4,"style":0}]
        """ : "[]"
        let doc = """
        {"annotations":\(annotations),"captureRect":[[0,0],[0,0]],"created":"\(iso(date))","id":"\(id)","kind":"area",
         "modified":"\(iso(date))","pixelHeight":240,"pixelWidth":400,"scale":2,"version":1}
        """
        try! doc.data(using: .utf8)!.write(to: dir.appendingPathComponent("document.json"))
        try! original.write(to: dir.appendingPathComponent("original.png"))
        try! thumb.write(to: dir.appendingPathComponent("thumbnail.jpg"))
    }
default:
    fail("unknown command \(cmd)", code: 2)
}
