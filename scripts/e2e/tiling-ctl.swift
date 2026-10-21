// Tiling e2e helper: AX queries and actions on the test's own TextEdit
// documents (titles containing "tiling-qa"). Never posts input events and
// never touches other windows. Build: swiftc -O scripts/e2e/tiling-ctl.swift -o /tmp/tiling-ctl
//   tiling-ctl frames                       "title x y w h [min] [full]" per test window, sorted by title
//   tiling-ctl count                        number of test windows on screen (not minimized)
//   tiling-ctl wait <n> [timeout]           wait until n test windows are on screen and their frames are stable
//   tiling-ctl settle [timeout]             wait until the frames of the test windows stop changing
//   tiling-ctl check [n] [--loose] [--except <title>]
//                                           the on-screen test windows tile the main display: inside its visible
//                                           frame, no overlaps (--loose: overlaps allowed, e.g. minimum sizes),
//                                           together covering most of it. Exit 1 with a reason otherwise.
//   tiling-ctl area                         main display's visible frame (AX): x y w h
//   tiling-ctl minimize <title> 0|1         (un)minimize a test window
//   tiling-ctl fullscreen <title> 0|1       native full screen on/off
//   tiling-ctl raise <title>                make it the main window and raise it (no app activation)
//   tiling-ctl focus <title>                raise it and make its TextEdit process frontmost
//   tiling-ctl focused                      title of the focused window if a TextEdit process is frontmost
//   tiling-ctl hide <pid> 0|1               hide / unhide one TextEdit process (only if all its windows are test windows)
//   tiling-ctl close <title>                press its close button
//   tiling-ctl pids                         pids of running TextEdit processes
//   tiling-ctl quit <pid>                   politely quit one TextEdit process (only if all its windows are test windows)
//   tiling-ctl foreign                      titles of TextEdit windows that are NOT test windows
import AppKit
import ApplicationServices

let marker = "tiling-qa"
let bundleID = "com.apple.TextEdit"
let args = Array(CommandLine.arguments.dropFirst())
func fail(_ s: String) -> Never { FileHandle.standardError.write((s + "\n").data(using: .utf8)!); exit(1) }

func attr<T>(_ el: AXUIElement, _ name: String) -> T? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success, let v else { return nil }
    if T.self == AXUIElement.self || T.self == AXValue.self { return (v as! T) }
    return v as? T
}

struct Win {
    let el: AXUIElement
    let pid: pid_t
    let title: String
    var frame: CGRect {
        var p = CGPoint.zero, s = CGSize.zero
        if let pv: AXValue = attr(el, kAXPositionAttribute) { AXValueGetValue(pv, .cgPoint, &p) }
        if let sv: AXValue = attr(el, kAXSizeAttribute) { AXValueGetValue(sv, .cgSize, &s) }
        return CGRect(origin: p, size: s)
    }
    var minimized: Bool { attr(el, kAXMinimizedAttribute) ?? false }
    var fullscreen: Bool { attr(el, "AXFullScreen") ?? false }
}

func apps() -> [NSRunningApplication] { NSRunningApplication.runningApplications(withBundleIdentifier: bundleID) }

func allWindows(_ pid: pid_t) -> [Win] {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 1)
    let list: [AXUIElement] = attr(app, kAXWindowsAttribute) ?? []
    return list.map { Win(el: $0, pid: pid, title: attr($0, kAXTitleAttribute) ?? "") }
}

func testWindows() -> [Win] {
    apps().flatMap { allWindows($0.processIdentifier) }.filter { $0.title.contains(marker) }.sorted { $0.title < $1.title }
}

/// Not minimized and not belonging to a hidden process.
func onScreen() -> [Win] {
    let hidden = Set(apps().filter(\.isHidden).map(\.processIdentifier))
    return testWindows().filter { !$0.minimized && !hidden.contains($0.pid) }
}

func find(_ t: String) -> Win {
    guard let w = testWindows().first(where: { $0.title.contains(t) }) else { fail("no test window '\(t)'") }
    return w
}

func mainArea() -> CGRect {
    let s = NSScreen.screens[0]
    let h = s.frame.height
    let v = s.visibleFrame
    return CGRect(x: v.minX, y: h - v.maxY, width: v.width, height: v.height)
}

func describe(_ w: Win) -> String {
    let f = w.frame
    var s = "\(w.title) \(Int(f.minX)) \(Int(f.minY)) \(Int(f.width)) \(Int(f.height))"
    if w.minimized { s += " min" }
    if w.fullscreen { s += " full" }
    return s
}

func snapshot() -> [String] { testWindows().map(describe) }

/// Waits until two reads 250 ms apart are identical.
func settle(timeout: Double) -> Bool {
    let end = Date().addingTimeInterval(timeout)
    var last = snapshot()
    while Date() < end {
        usleep(250_000)
        let now = snapshot()
        if now == last { return true }
        last = now
    }
    return false
}

guard let cmd = args.first else { fail("usage: see header") }
switch cmd {
case "frames":
    for w in testWindows() { print(describe(w)) }
case "count":
    print(onScreen().count)
case "wait":
    let n = Int(args[1])!
    let timeout = args.count > 2 ? Double(args[2])! : 6
    let end = Date().addingTimeInterval(timeout)
    while onScreen().count != n {
        if Date() > end { fail("expected \(n) test windows, have \(onScreen().count)") }
        usleep(150_000)
    }
    if !settle(timeout: max(1, end.timeIntervalSinceNow)) { fail("frames did not settle") }
case "settle":
    if !settle(timeout: args.count > 1 ? Double(args[1])! : 4) { fail("frames did not settle") }
case "area":
    let a = mainArea()
    print(Int(a.minX), Int(a.minY), Int(a.width), Int(a.height))
case "check":
    var rest = Array(args.dropFirst())
    let loose = rest.contains("--loose")
    rest.removeAll { $0 == "--loose" }
    var except: String?
    if let i = rest.firstIndex(of: "--except"), i + 1 < rest.count { except = rest[i + 1]; rest.removeSubrange(i...(i + 1)) }
    let wins = onScreen().filter { !$0.fullscreen && !(except.map($0.title.contains) ?? false) }
    if let n = rest.first.flatMap(Int.init), wins.count != n { fail("check: expected \(n) windows, have \(wins.count)") }
    let area = mainArea()
    let frames = wins.map { ($0.title, $0.frame) }
    var covered: CGFloat = 0
    for (t, f) in frames {
        if !area.insetBy(dx: -2, dy: -2).contains(f) && !loose { fail("check: \(t) \(f) is outside \(area)") }
        covered += f.intersection(area).width * f.intersection(area).height
    }
    if !loose {
        for i in 0..<frames.count {
            for j in (i + 1)..<max(i + 1, frames.count) {
                let x = frames[i].1.intersection(frames[j].1)
                if !x.isNull && x.width > 2 && x.height > 2 { fail("check: \(frames[i].0) overlaps \(frames[j].0) (\(x))") }
            }
        }
        if covered < area.width * area.height * 0.85 {
            fail("check: windows cover only \(Int(covered * 100 / (area.width * area.height)))% of the screen")
        }
    }
    print("ok \(frames.count) windows")
case "minimize":
    let w = find(args[1])
    AXUIElementSetAttributeValue(w.el, kAXMinimizedAttribute as CFString, (args[2] == "1" ? kCFBooleanTrue : kCFBooleanFalse)!)
case "fullscreen":
    let w = find(args[1])
    AXUIElementSetAttributeValue(w.el, "AXFullScreen" as CFString, (args[2] == "1" ? kCFBooleanTrue : kCFBooleanFalse)!)
case "raise":
    let w = find(args[1])
    AXUIElementSetAttributeValue(w.el, kAXMainAttribute as CFString, kCFBooleanTrue)
    AXUIElementPerformAction(w.el, kAXRaiseAction as CFString)
case "focus":
    let w = find(args[1])
    AXUIElementSetAttributeValue(w.el, kAXMainAttribute as CFString, kCFBooleanTrue)
    AXUIElementPerformAction(w.el, kAXRaiseAction as CFString)
    AXUIElementSetAttributeValue(AXUIElementCreateApplication(w.pid), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    NSRunningApplication(processIdentifier: w.pid)?.activate()
    usleep(300_000)
case "focused":
    guard let app = NSWorkspace.shared.frontmostApplication, app.bundleIdentifier == bundleID else { print("-"); break }
    let el = AXUIElementCreateApplication(app.processIdentifier)
    if let w: AXUIElement = attr(el, kAXFocusedWindowAttribute) { print(attr(w, kAXTitleAttribute) ?? "?") } else { print("-") }
case "hide":
    let pid = pid_t(args[1])!
    guard let app = NSRunningApplication(processIdentifier: pid), app.bundleIdentifier == bundleID else { fail("\(pid) is not TextEdit") }
    let foreign = allWindows(pid).filter { !$0.title.contains(marker) }
    if !foreign.isEmpty { fail("refusing to hide \(pid): it has other windows \(foreign.map(\.title))") }
    _ = args[2] == "1" ? app.hide() : app.unhide()
case "close":
    let w = find(args[1])
    if let b: AXUIElement = attr(w.el, kAXCloseButtonAttribute) { AXUIElementPerformAction(b, kAXPressAction as CFString) }
case "pids":
    print(apps().map { String($0.processIdentifier) }.joined(separator: " "))
case "quit":
    let pid = pid_t(args[1])!
    guard let app = NSRunningApplication(processIdentifier: pid), app.bundleIdentifier == bundleID else { fail("\(pid) is not TextEdit") }
    let foreign = allWindows(pid).filter { !$0.title.contains(marker) }
    if !foreign.isEmpty { fail("refusing to quit \(pid): it has other windows \(foreign.map(\.title))") }
    app.terminate()
case "foreign":
    for a in apps() { for w in allWindows(a.processIdentifier) where !w.title.contains(marker) { print(w.title) } }
default:
    fail("unknown command \(cmd)")
}
