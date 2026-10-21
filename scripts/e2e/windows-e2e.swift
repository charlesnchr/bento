// End-to-end checks for the Windows module with real input, on our own TextEdit
// document only. Run by scripts/e2e/windows.sh inside a GUI session; not alone.
// Build: swiftc -O scripts/e2e/windows-e2e.swift -o /tmp/windows-e2e
//   windows-e2e keys snap drag misc [spaces] [cleanup]
// Env: BENTO_LOG (Bento's stderr, BENTO_LOG_EVENTS=1), BENTO_CONFIG, BENTO_PID,
//      QA_TITLE (document title), BENTOCTL, WINDOWS_CLICK.
// Input goes through bentoctl/windows-click with --expect com.apple.TextEdit;
// every step first checks that our document is the focused / top-most window
// and stops (exit 75) the moment the user is active.
import AppKit
import ApplicationServices

@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ wid: UnsafeMutablePointer<CGWindowID>) -> AXError
@_silgen_name("CGSMainConnectionID") func CGSMainConnectionID() -> Int32
@_silgen_name("CGSCopySpacesForWindows") func CGSCopySpacesForWindows(_ cid: Int32, _ mask: Int32, _ wids: CFArray) -> CFArray?

setvbuf(stdout, nil, _IOLBF, 0)
let env = ProcessInfo.processInfo.environment
let ctlPath = env["BENTOCTL"] ?? "/tmp/bentoctl"
let clickPath = env["WINDOWS_CLICK"] ?? "/tmp/windows-click"
let logPath = env["BENTO_LOG"] ?? "/tmp/bento-e2e-windows.log"
let configPath = env["BENTO_CONFIG"] ?? "/tmp/bento-e2e-windows/config/config.json"
let bentoPID = pid_t(env["BENTO_PID"] ?? "") ?? 0
let title = env["QA_TITLE"] ?? "windows-qa"
let te = "com.apple.TextEdit"
let flagFile = "/tmp/bento-user-active"

var passed = 0
var failed: [String] = []
var skipped: [String] = []

func summary() {
    print("\n== windows e2e: \(passed) passed, \(failed.count) failed, \(skipped.count) skipped")
    for f in failed { print("FAIL \(f)") }
    for s in skipped { print("SKIP \(s)") }
}

func stopForUser() -> Never {
    print("!! user became active: stopping now")
    summary()
    exit(75)
}

func checkUser() { if FileManager.default.fileExists(atPath: flagFile) { stopForUser() } }
func pause(_ s: Double) { usleep(useconds_t(s * 1_000_000)) }

@discardableResult
func run(_ path: String, _ args: [String]) -> (Int32, String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    let out = Pipe()
    p.standardOutput = out
    p.standardError = out
    do { try p.run() } catch { return (127, "\(error)") }
    p.waitUntilExit()
    let s = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    return (p.terminationStatus, s.trimmingCharacters(in: .whitespacesAndNewlines))
}

/// bentoctl with --expect TextEdit for input commands; exits on user activity.
@discardableResult
func ctl(_ args: [String], input: Bool = true) -> Bool {
    checkUser()
    let (st, out) = run(ctlPath, args + (input ? ["--expect", te] : []))
    if st == 75 { stopForUser() }
    if st != 0 { print("   bentoctl \(args.joined(separator: " ")) -> \(st) \(out)") }
    return st == 0
}

// MARK: Our window (AX)

let screen = NSScreen.screens[0]
let primaryH = screen.frame.height
func ax(_ r: CGRect) -> CGRect { CGRect(x: r.minX, y: primaryH - r.maxY, width: r.width, height: r.height) }
let F = ax(screen.frame)
let V = ax(screen.visibleFrame)

func attr<T>(_ el: AXUIElement, _ name: String) -> T? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success, let v else { return nil }
    return v as? T
}

var appPID: pid_t { NSRunningApplication.runningApplications(withBundleIdentifier: te).first?.processIdentifier ?? 0 }

func myWindow() -> AXUIElement? {
    let app = AXUIElementCreateApplication(appPID)
    let wins: [AXUIElement] = attr(app, kAXWindowsAttribute) ?? []
    return wins.first { ((attr($0, kAXTitleAttribute) as String?) ?? "").contains(title) }
}

func frame(_ w: AXUIElement? = myWindow()) -> CGRect? {
    guard let w, let pv: AXValue = attr(w, kAXPositionAttribute), let sv: AXValue = attr(w, kAXSizeAttribute) else { return nil }
    var p = CGPoint.zero, s = CGSize.zero
    AXValueGetValue(pv, .cgPoint, &p); AXValueGetValue(sv, .cgSize, &s)
    return CGRect(origin: p, size: s)
}

func setFrame(_ r: CGRect) {
    guard let w = myWindow() else { return }
    var s = r.size, p = r.origin
    AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &s)!)
    AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &p)!)
    AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &s)!)
    pause(0.15)
}

func windowID(_ w: AXUIElement?) -> CGWindowID {
    guard let w else { return 0 }
    var id: CGWindowID = 0
    return _AXUIElementGetWindow(w, &id) == .success ? id : 0
}

/// Front-most window (below the Dock layer) containing a point.
func topWindow(at p: CGPoint) -> CGWindowID? {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    for d in list {
        let layer = d[kCGWindowLayer as String] as? Int ?? 0
        guard layer >= 0, layer < 20, (d[kCGWindowAlpha as String] as? Double ?? 1) > 0.01,
              let b = d[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b), r.contains(p) else { continue }
        if (d[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) == bentoPID, layer > 0 { continue } // HUD / preview
        return (d[kCGWindowNumber as String] as? Int).map { CGWindowID($0) }
    }
    return nil
}

/// TextEdit is frontmost with our document focused (or we stop: never type into anything else).
func ensureFront() {
    for attempt in 0..<3 {
        checkUser()
        let app = AXUIElementCreateApplication(appPID)
        let focused: AXUIElement? = attr(app, kAXFocusedWindowAttribute)
        let t: String = focused.flatMap { attr($0, kAXTitleAttribute) } ?? ""
        if NSWorkspace.shared.frontmostApplication?.bundleIdentifier == te, t.contains(title) { return }
        if attempt == 2 { break }
        ctl(["front", te, title], input: false)
    }
    print("!! could not focus our TextEdit document; stopping")
    summary()
    exit(3)
}

/// The point is on our window, nothing above it.
func onMyWindow(_ p: CGPoint) -> Bool {
    let mine = windowID(myWindow())
    return mine != 0 && topWindow(at: p) == mine
}

// MARK: Bento

func placedCount() -> Int {
    guard let s = try? String(contentsOfFile: logPath, encoding: .utf8) else { return 0 }
    return s.split(separator: "\n").filter { $0.hasPrefix("windowPlaced") }.count
}

func perform(_ id: String) {
    checkUser()
    DistributedNotificationCenter.default().postNotificationName(Notification.Name("com.charles.bento.dev.perform"), object: id,
                                                                 userInfo: nil, deliverImmediately: true)
}

func bentoWindows() -> [(CGRect, Int)] {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
    return list.compactMap { d in
        guard (d[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) == bentoPID,
              let b = d[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b) else { return nil }
        return (r, d[kCGWindowLayer as String] as? Int ?? 0)
    }
}

func editWindowsConfig(_ change: (inout [String: Any]) -> Void) { editConfig("windows", change) }

func editConfig(_ section: String, _ change: (inout [String: Any]) -> Void) {
    guard let data = FileManager.default.contents(atPath: configPath),
          var root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { print("   can't read config"); return }
    var w = root[section] as? [String: Any] ?? [:]
    change(&w)
    root[section] = w
    if let out = try? JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys]) {
        try? out.write(to: URL(fileURLWithPath: configPath), options: .atomic)
    }
    pause(0.9) // file watcher + debounced reloads
}

// MARK: Assertions

func near(_ a: CGRect, _ b: CGRect, _ t: CGFloat) -> Bool {
    abs(a.minX - b.minX) <= t && abs(a.minY - b.minY) <= t && abs(a.width - b.width) <= t && abs(a.height - b.height) <= t
}

func fmt(_ r: CGRect?) -> String { r.map { "(\(Int($0.minX)),\(Int($0.minY)) \(Int($0.width))x\(Int($0.height)))" } ?? "nil" }

func record(_ ok: Bool, _ name: String, _ detail: String) {
    if ok { passed += 1; print("ok   \(name)"); return }
    failed.append("\(name): \(detail)")
    print("FAIL \(name): \(detail)")
    // Bento's modifier-drag decisions (BENTO_LOG_EVENTS) around the failure.
    let log = (try? String(contentsOfFile: logPath, encoding: .utf8)) ?? ""
    for line in log.split(separator: "\n").filter({ $0.hasPrefix("drag ") }).suffix(3) { print("     \(line)") }
}

/// Waits (≤ 1.2 s) for the frame to match; checks the windowPlaced count too.
func expectFrame(_ name: String, _ want: CGRect, since placedBefore: Int? = nil, placed: Int = 1, tol: CGFloat = 1) {
    var got = frame()
    for _ in 0..<12 {
        if let g = got, near(g, want, tol) { break }
        pause(0.1)
        got = frame()
    }
    var ok = got.map { near($0, want, tol) } ?? false
    var detail = "got \(fmt(got)) want \(fmt(want))"
    if let before = placedBefore {
        pause(0.05)
        let n = placedCount() - before
        if n != placed { ok = false; detail += ", windowPlaced ×\(n) (want \(placed))" }
    }
    record(ok, name, detail)
}

// MARK: Geometry (Rectangle's definitions on the visible frame)

func cell(_ cols: Int, _ rows: Int, _ c: Int, _ r: Int, cs: Int = 1, rs: Int = 1) -> CGRect {
    func line(_ s: CGFloat, _ len: CGFloat, _ i: Int, _ n: Int) -> CGFloat { s + (len * CGFloat(i) / CGFloat(n)).rounded() }
    let x0 = line(V.minX, V.width, c, cols), x1 = line(V.minX, V.width, c + cs, cols)
    let y0 = line(V.minY, V.height, r, rows), y1 = line(V.minY, V.height, r + rs, rows)
    return CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
}

func band(_ f: CGFloat) -> CGRect {
    let w = (V.width * f).rounded()
    return CGRect(x: V.minX + ((V.width - w) / 2).rounded(), y: V.minY, width: w, height: V.height)
}

/// A free-floating start frame, away from other apps' floating / modal windows (system alerts…),
/// which would sit above our document and block the test points.
var S: CGRect = {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let overlays: [CGRect] = list.compactMap { d in
        let layer = d[kCGWindowLayer as String] as? Int ?? 0
        guard layer > 0, layer < 20, (d[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) != bentoPID,
              let b = d[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b) else { return nil }
        return r
    }
    // Keep ≥ 40 pt from the screen edges so "make larger" (+15 per side) never touches them.
    for (dx, dy) in [(300.0, 167.0), (40.0, 167.0), (870.0, 167.0), (300.0, 440.0), (40.0, 440.0), (870.0, 440.0)] {
        let r = CGRect(x: V.minX + dx, y: V.minY + dy, width: 600, height: 400)
        if r.maxX <= V.maxX, r.maxY <= V.maxY, !overlays.contains(where: { $0.intersects(r.insetBy(dx: -4, dy: -4)) }) { return r }
    }
    return CGRect(x: V.minX + 300, y: V.minY + 167, width: 600, height: 400)
}()

// MARK: Phases

func key(_ combo: String) { ensureFront(); ctl(["key", combo]) }

/// Runs `act` from `start` (nil = from where the window is) and checks the result.
func step(_ name: String, from start: CGRect? = S, _ act: () -> Void, _ want: CGRect, placed: Int = 1, tol: CGFloat = 1) {
    if let start { setFrame(start) }
    let before = placedCount()
    act()
    expectFrame(name, want, since: before, placed: placed, tol: tol)
}

func phaseKeys() {
    print("\n-- keyboard actions (real hotkeys; perform for actions without a default key)")
    ensureFront()
    let w = V.width, h = V.height
    step("left half ⌃⌥←", { key("ctrl+opt+left") }, cell(2, 1, 0, 0))
    step("left half again: ⅔", from: nil, { key("ctrl+opt+left") }, CGRect(x: V.minX, y: V.minY, width: (w * 2 / 3).rounded(), height: h))
    step("left half again: ⅓", from: nil, { key("ctrl+opt+left") }, CGRect(x: V.minX, y: V.minY, width: (w / 3).rounded(), height: h))
    step("left half again: ½", from: nil, { key("ctrl+opt+left") }, cell(2, 1, 0, 0))
    step("restore ⌃⌥⌫", from: nil, { key("ctrl+opt+delete") }, S)
    step("right half ⌃⌥→", { key("ctrl+opt+right") }, cell(2, 1, 1, 0))
    step("right half again: ⅔", from: nil, { key("ctrl+opt+right") },
         CGRect(x: V.maxX - (w * 2 / 3).rounded(), y: V.minY, width: (w * 2 / 3).rounded(), height: h))
    step("top half ⌃⌥↑", { key("ctrl+opt+up") }, cell(1, 2, 0, 0))
    step("bottom half ⌃⌥↓", { key("ctrl+opt+down") }, cell(1, 2, 0, 1))
    step("top left ⌃⌥U", { key("ctrl+opt+u") }, cell(2, 2, 0, 0))
    step("top left again: ⅔ width", from: nil, { key("ctrl+opt+u") },
         CGRect(x: V.minX, y: V.minY, width: (w * 2 / 3).rounded(), height: cell(2, 2, 0, 0).height))
    step("top right ⌃⌥I", { key("ctrl+opt+i") }, cell(2, 2, 1, 0))
    step("bottom left ⌃⌥J", { key("ctrl+opt+j") }, cell(2, 2, 0, 1))
    step("bottom right ⌃⌥K", { key("ctrl+opt+k") }, cell(2, 2, 1, 1))
    step("first third ⌃⌥D", { key("ctrl+opt+d") }, cell(3, 1, 0, 0))
    step("first third again: center", from: nil, { key("ctrl+opt+d") }, cell(3, 1, 1, 0))
    step("first third again: last", from: nil, { key("ctrl+opt+d") }, cell(3, 1, 2, 0))
    step("first third again: first", from: nil, { key("ctrl+opt+d") }, cell(3, 1, 0, 0))
    step("center third ⌃⌥F", { key("ctrl+opt+f") }, cell(3, 1, 1, 0))
    step("last third ⌃⌥G", { key("ctrl+opt+g") }, cell(3, 1, 2, 0))
    step("first two thirds ⌃⌥E", { key("ctrl+opt+e") }, cell(3, 1, 0, 0, cs: 2))
    step("first two thirds again: last two thirds", from: nil, { key("ctrl+opt+e") }, cell(3, 1, 1, 0, cs: 2))
    step("last two thirds ⌃⌥T", { key("ctrl+opt+t") }, cell(3, 1, 1, 0, cs: 2))
    step("center two thirds ⌃⌥R", { key("ctrl+opt+r") }, band(2.0 / 3))
    step("maximize ⌃⌥↩", { key("ctrl+opt+return") }, V)
    step("maximize height ⌃⌥⇧↑", { key("ctrl+opt+shift+up") }, CGRect(x: S.minX, y: V.minY, width: S.width, height: h))
    step("center ⌃⌥C", { key("ctrl+opt+c") },
         CGRect(x: V.minX + ((w - S.width) / 2).rounded(), y: V.minY + ((h - S.height) / 2).rounded(), width: S.width, height: S.height))
    step("make larger ⌃⌥=", { key("ctrl+opt+equal") }, S.insetBy(dx: -15, dy: -15))
    step("make smaller ⌃⌥-", { key("ctrl+opt+minus") }, S.insetBy(dx: 15, dy: 15))
    step("make larger at the left edge (curtain)", from: CGRect(x: V.minX, y: S.minY, width: 600, height: 400), { key("ctrl+opt+equal") },
         CGRect(x: V.minX, y: S.minY - 15, width: 630, height: 430))
    step("restore after two actions", { key("ctrl+opt+left"); key("ctrl+opt+k"); key("ctrl+opt+delete") }, S, placed: 3)
    let aw = (w * 0.9).rounded(), ah = (h * 0.9).rounded()
    step("almost maximize", { perform("windows.almost-maximize") },
         CGRect(x: V.minX + ((w - aw) / 2).rounded(), y: V.minY + ((h - ah) / 2).rounded(), width: aw, height: ah))
    step("center half", { perform("windows.center-half") }, band(0.5))
    step("move left", { perform("windows.move-left") }, CGRect(x: V.minX, y: V.minY + ((h - 400) / 2).rounded(), width: 600, height: 400))
    step("move right", { perform("windows.move-right") }, CGRect(x: V.maxX - 600, y: V.minY + ((h - 400) / 2).rounded(), width: 600, height: 400))
    step("move up", { perform("windows.move-up") }, CGRect(x: V.minX + ((w - 600) / 2).rounded(), y: V.minY, width: 600, height: 400))
    step("move down", { perform("windows.move-down") }, CGRect(x: V.minX + ((w - 600) / 2).rounded(), y: V.maxY - 400, width: 600, height: 400))
    for (i, n) in ["first", "second", "third", "last"].enumerated() {
        step("\(n) fourth", { perform("windows.\(n)-fourth") }, cell(4, 1, i, 0))
    }
    step("first fourth twice: second", { perform("windows.first-fourth"); pause(0.3); perform("windows.first-fourth") },
         cell(4, 1, 1, 0), placed: 2)
    step("first three fourths", { perform("windows.first-three-fourths") }, cell(4, 1, 0, 0, cs: 3))
    step("last three fourths", { perform("windows.last-three-fourths") }, cell(4, 1, 1, 0, cs: 3))
    step("center three fourths", { perform("windows.center-three-fourths") }, band(0.75))
    let sixths = ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"]
    for (i, n) in sixths.enumerated() { step("\(n) sixth", { perform("windows.\(n)-sixth") }, cell(3, 2, i % 3, i / 3)) }
    step("top left sixth again: top center", { perform("windows.top-left-sixth"); pause(0.3); perform("windows.top-left-sixth") },
         cell(3, 2, 1, 0), placed: 2)
    let ninths = ["top-left", "top-center", "top-right", "middle-left", "middle-center", "middle-right", "bottom-left", "bottom-center", "bottom-right"]
    for (i, n) in ninths.enumerated() where [0, 4, 8].contains(i) {
        step("\(n) ninth", { perform("windows.\(n)-ninth") }, cell(3, 3, i % 3, i / 3))
    }
    step("top left eighth", { perform("windows.top-left-eighth") }, cell(4, 2, 0, 0))
    step("bottom right eighth", { perform("windows.bottom-right-eighth") }, cell(4, 2, 3, 1))
    step("top left two thirds", { perform("windows.top-left-third") }, cell(3, 2, 0, 0, cs: 2))
    step("top third (vertical)", { perform("windows.top-vertical-third") }, cell(1, 3, 0, 0))
    step("bottom two thirds (vertical)", { perform("windows.bottom-vertical-two-thirds") }, cell(1, 3, 0, 1, rs: 2))
    let wide = CGRect(x: S.minX, y: S.minY, width: 1000, height: 400)
    step("halve width (left)", from: wide, { perform("windows.halve-width-left") }, CGRect(x: S.minX, y: S.minY, width: 500, height: 400))
    step("halve width (right)", from: wide, { perform("windows.halve-width-right") }, CGRect(x: S.minX + 500, y: S.minY, width: 500, height: 400))
    // Like Rectangle, halving below 25 % of the screen is refused.
    step("halve width below ¼ screen: no change", { perform("windows.halve-width-left") }, S)
    step("double width (right)", { perform("windows.double-width-right") }, CGRect(x: S.minX, y: S.minY, width: 1200, height: 400))
    step("larger width", { perform("windows.larger-width") }, CGRect(x: S.minX - 15, y: S.minY, width: 630, height: 400))
    // One display: display moves are no-ops and must not report a placement.
    step("next display ⌃⌥] (one display: no-op)", { key("ctrl+opt+rightbracket") }, S, placed: 0)
    step("previous display ⌃⌥[ (one display: no-op)", { key("ctrl+opt+leftbracket") }, S, placed: 0)
    step("display on right ⌃⌥⌘→ (one display: no-op)", { key("ctrl+opt+cmd+right") }, S, placed: 0)
    // With one display those no-ops don't prove ⌃⌥] / ⌃⌥[ fire: lend the keys to visible actions.
    editConfig("shortcuts") { $0["windows.next-display"] = ""; $0["windows.previous-display"] = ""
        $0["windows.maximize"] = "ctrl+opt+rightbracket"; $0["windows.center"] = "ctrl+opt+leftbracket" }
    step("⌃⌥] hotkey fires (lent to Maximize)", { key("ctrl+opt+rightbracket") }, V)
    step("⌃⌥[ hotkey fires (lent to Center)", { key("ctrl+opt+leftbracket") },
         CGRect(x: V.minX + ((w - S.width) / 2).rounded(), y: V.minY + ((h - S.height) / 2).rounded(), width: S.width, height: S.height))
    editConfig("shortcuts") { $0 = [:] }

    print("\n-- gaps 10/10")
    editWindowsConfig { $0["windowGap"] = 10; $0["screenMargin"] = 10 }
    step("left half with gaps", { key("ctrl+opt+left") }, CGRect(x: V.minX + 10, y: V.minY + 10, width: cell(2, 1, 0, 0).width - 15, height: h - 20))
    step("top right with gaps", { key("ctrl+opt+i") },
         CGRect(x: cell(2, 2, 1, 0).minX + 5, y: V.minY + 10, width: cell(2, 2, 1, 0).width - 15, height: cell(2, 2, 1, 0).height - 15))
    step("maximize with gaps", { key("ctrl+opt+return") }, V.insetBy(dx: 10, dy: 10))
    editWindowsConfig { $0["gapsOnMaximize"] = false }
    step("maximize, gaps off for maximize", { key("ctrl+opt+return") }, V)
    editWindowsConfig { $0["windowGap"] = 0; $0["screenMargin"] = 0; $0["gapsOnMaximize"] = true }
    step("left half, gaps off again", { key("ctrl+opt+left") }, cell(2, 1, 0, 0))

    print("\n-- HUD option")
    editWindowsConfig { $0["showHUD"] = true }
    setFrame(S)
    key("ctrl+opt+right")
    pause(0.25)
    let hud = bentoWindows().contains { $0.1 > 0 && $0.0.width < 600 && $0.0.height < 300 }
    record(hud, "HUD shows the action name", "no Bento HUD window on screen")
    editWindowsConfig { $0["showHUD"] = false }
}

/// Title-bar grab point of our window (away from the traffic lights and the title).
func grab(_ f: CGRect) -> CGPoint { CGPoint(x: f.minX + 110, y: f.minY + 14) }

func titleDrag(_ name: String, to p: CGPoint, want: CGRect?, placed: Int = 1, from start: CGRect = S) {
    setFrame(start)
    ensureFront()
    guard let f = frame() else { record(false, name, "no window"); return }
    let g = grab(f)
    guard onMyWindow(g) else { skipped.append("\(name): grab point not on our window"); return }
    let before = placedCount()
    ctl(["drag", "\(Int(g.x))", "\(Int(g.y))", "\(Int(p.x))", "\(Int(p.y))"])
    if let want {
        expectFrame(name, want, since: before, placed: placed, tol: 1)
    } else {
        pause(0.5)
        let got = frame()
        let moved = got.map { abs($0.width - start.width) <= 1 && abs($0.height - start.height) <= 1 } ?? false
        let n = placedCount() - before
        record(moved && n == placed, name, "got \(fmt(got)) (size must stay \(Int(start.width))x\(Int(start.height))), windowPlaced ×\(n)")
    }
}

func phaseSnap() {
    print("\n-- drag-to-snap by the title bar (cursor at the true screen edges)")
    let maxX = F.maxX - 1, maxY = F.maxY - 1
    titleDrag("snap top edge → maximize", to: CGPoint(x: F.midX, y: F.minY), want: V)
    titleDrag("snap top-left corner → top left", to: CGPoint(x: F.minX + 1, y: F.minY + 1), want: cell(2, 2, 0, 0))
    titleDrag("snap top-right corner → top right", to: CGPoint(x: maxX, y: F.minY + 1), want: cell(2, 2, 1, 0))
    titleDrag("snap bottom-left corner → bottom left", to: CGPoint(x: F.minX + 1, y: maxY), want: cell(2, 2, 0, 1))
    titleDrag("snap bottom-right corner → bottom right", to: CGPoint(x: maxX, y: maxY), want: cell(2, 2, 1, 1))
    titleDrag("snap left edge → left half", to: CGPoint(x: F.minX + 1, y: F.midY), want: cell(2, 1, 0, 0))
    titleDrag("snap right edge → right half", to: CGPoint(x: maxX, y: F.midY), want: cell(2, 1, 1, 0))
    titleDrag("snap left edge near top → top half", to: CGPoint(x: F.minX + 1, y: F.minY + 100), want: cell(1, 2, 0, 0))
    titleDrag("snap right edge near top (1510,36) → top half (Rectangle)", to: CGPoint(x: maxX - 1, y: F.minY + 36), want: cell(1, 2, 0, 0))
    titleDrag("snap left edge near bottom → bottom half", to: CGPoint(x: F.minX + 1, y: F.maxY - 100), want: cell(1, 2, 0, 1))
    titleDrag("snap bottom edge left → first third", to: CGPoint(x: F.minX + 200, y: maxY), want: cell(3, 1, 0, 0))
    titleDrag("snap bottom edge middle → center third", to: CGPoint(x: F.midX, y: maxY), want: cell(3, 1, 1, 0))
    titleDrag("snap bottom edge right → last third", to: CGPoint(x: F.maxX - 200, y: maxY), want: cell(3, 1, 2, 0))
    titleDrag("just under the menu bar (756,34): moves, no snap (Rectangle)", to: CGPoint(x: F.midX, y: V.minY + 1), want: nil, placed: 0)
    titleDrag("release in the middle: moves, no snap", to: CGPoint(x: F.midX, y: F.midY), want: nil, placed: 0)

    // Along the bottom from the first third to the middle → first two thirds, with the preview shown.
    setFrame(S); ensureFront()
    if let f = frame(), onMyWindow(grab(f)) {
        let g = grab(f), before = placedCount()
        ctl(["down", "\(Int(g.x))", "\(Int(g.y))"])
        ctl(["move", "\(Int(F.minX + 200))", "\(Int(maxY))"], input: true)
        pause(0.35)
        ctl(["move", "\(Int(F.midX))", "\(Int(maxY))"])
        pause(0.45)
        let want = cell(3, 1, 0, 0, cs: 2)
        let preview = bentoWindows().contains { $0.1 > 0 && near($0.0, want, 2) }
        ctl(["up", "\(Int(F.midX))", "\(Int(maxY))"])
        record(preview, "preview footprint shows first two thirds", "Bento windows: \(bentoWindows().map { fmt($0.0) })")
        expectFrame("snap along the bottom → first two thirds", want, since: before)
    }

    // Unsnap: a snapped window dragged out gets its old size back, under the cursor.
    titleDrag("snap left (for unsnap)", to: CGPoint(x: F.minX + 1, y: F.midY), want: cell(2, 1, 0, 0))
    if let f = frame() {
        let g = grab(f), end = CGPoint(x: F.midX + 100, y: F.midY)
        let before = placedCount()
        ctl(["drag", "\(Int(g.x))", "\(Int(g.y))", "\(Int(end.x))", "\(Int(end.y))"])
        pause(0.5)
        let got = frame()
        let ok = got.map { abs($0.width - S.width) <= 1 && abs($0.height - S.height) <= 1 && $0.minX < end.x && $0.maxX > end.x
            && end.y >= $0.minY && end.y <= $0.minY + 30 } ?? false
        record(ok && placedCount() == before, "unsnap restores 600x400 with the title bar under the cursor", "got \(fmt(got)), cursor \(end)")
    }

    // A drag that starts in the text (selection), not the title bar, never snaps or moves.
    setFrame(S); ensureFront()
    if let f = frame() {
        let p = CGPoint(x: f.midX, y: f.midY + 40)
        if onMyWindow(p) {
            let before = placedCount()
            ctl(["drag", "\(Int(p.x))", "\(Int(p.y))", "\(Int(F.minX + 1))", "\(Int(F.midY))"])
            expectFrame("drag starting in the text: no move, no snap", S, since: before, placed: 0, tol: 0)
        }
    }
}

func selectedRanges() -> [CFRange] {
    let app = AXUIElementCreateApplication(appPID)
    guard let el: AXUIElement = attr(app, kAXFocusedUIElementAttribute),
          let list: [AXValue] = attr(el, "AXSelectedTextRanges") else { return [] }
    return list.map { var r = CFRange(); AXValueGetValue($0, .cfRange, &r); return r }
}

func setSelection(_ loc: Int) {
    let app = AXUIElementCreateApplication(appPID)
    guard let el: AXUIElement = attr(app, kAXFocusedUIElementAttribute) else { return }
    var r = CFRange(location: loc, length: 0)
    AXUIElementSetAttributeValue(el, kAXSelectedTextRangeAttribute as CFString, AXValueCreate(.cfRange, &r)!)
}

/// Left mouse downs/ups (near `p`, or anywhere) that pass every session tap, Bento's included.
func spyClicks(near p: CGPoint?, _ body: @escaping () -> Void) -> (Int, Int) {
    final class Box { var downs = 0, ups = 0; var p: CGPoint? }
    let box = Box()
    box.p = p
    let mask = (CGEventMask(1) << CGEventType.leftMouseDown.rawValue) | (CGEventMask(1) << CGEventType.leftMouseUp.rawValue)
    let ref = Unmanaged.passRetained(box)
    defer { ref.release() }
    guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly, eventsOfInterest: mask,
                                      callback: { _, type, event, refcon in
        if let refcon {
            let b = Unmanaged<Box>.fromOpaque(refcon).takeUnretainedValue()
            let l = event.location
            if b.p.map({ hypot($0.x - l.x, $0.y - l.y) < 6 }) ?? true {
                if type == .leftMouseDown { b.downs += 1 } else if type == .leftMouseUp { b.ups += 1 }
            }
        }
        return Unmanaged.passUnretained(event)
    }, userInfo: ref.toOpaque()) else { print("   can't create the spy tap"); return (-1, -1) }
    let src = CFMachPortCreateRunLoopSource(nil, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), src, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    // bentoctl runs as a child process; keep this run loop serving the tap meanwhile.
    let done = DispatchSemaphore(value: 0)
    DispatchQueue.global().async { body(); done.signal() }
    while done.wait(timeout: .now()) == .timedOut { CFRunLoopRunInMode(.defaultMode, 0.05, false) }
    CFRunLoopRunInMode(.defaultMode, 0.4, false)
    CGEvent.tapEnable(tap: tap, enable: false)
    CFRunLoopRemoveSource(CFRunLoopGetCurrent(), src, .commonModes)
    CFMachPortInvalidate(tap)
    return (box.downs, box.ups)
}

func modDrag(_ name: String, from a: CGPoint, by d: CGPoint, mods: String, want: CGRect, start: CGRect = S, placed: Int = 1) {
    setFrame(start)
    ensureFront()
    guard onMyWindow(a) else { skipped.append("\(name): start point not on our window"); return }
    let before = placedCount()
    ctl(["drag", "\(Int(a.x))", "\(Int(a.y))", "\(Int(a.x + d.x))", "\(Int(a.y + d.y))", mods])
    expectFrame(name, want, since: before, placed: placed)
}

func phaseDrag() {
    print("\n-- modifier drag (⌘⌥ move, ⌘⌥⇧ resize)")
    let mv = "cmd+opt", rs = "cmd+opt+shift"
    modDrag("⌘⌥ move by the drag delta", from: CGPoint(x: S.midX, y: S.midY), by: CGPoint(x: 100, y: 50), mods: mv, want: S.offsetBy(dx: 100, dy: 50))
    func r(_ dx0: CGFloat, _ dy0: CGFloat, _ dw: CGFloat, _ dh: CGFloat) -> CGRect {
        CGRect(x: S.minX + dx0, y: S.minY + dy0, width: S.width + dw, height: S.height + dh)
    }
    let inset: CGFloat = 25
    // Rectangle Pro classic (the default): wherever the drag starts, the bottom-right corner moves.
    let regions: [(String, CGPoint, CGPoint, CGRect)] = [
        ("bottom-right corner", CGPoint(x: S.maxX - inset, y: S.maxY - inset), CGPoint(x: 50, y: 30), r(0, 0, 50, 30)),
        ("top-left corner (shrinks from bottom-right)", CGPoint(x: S.minX + inset, y: S.minY + inset), CGPoint(x: -40, y: -20), r(0, 0, -40, -20)),
        ("top-right corner", CGPoint(x: S.maxX - inset, y: S.minY + inset), CGPoint(x: 40, y: -20), r(0, 0, 40, -20)),
        ("bottom-left corner", CGPoint(x: S.minX + inset, y: S.maxY - inset), CGPoint(x: -40, y: 20), r(0, 0, -40, 20)),
        ("right-edge middle", CGPoint(x: S.maxX - inset, y: S.midY), CGPoint(x: 50, y: 30), r(0, 0, 50, 30)),
        ("left-edge middle", CGPoint(x: S.minX + inset, y: S.midY), CGPoint(x: -50, y: 30), r(0, 0, -50, 30)),
        ("top-edge middle", CGPoint(x: S.midX, y: S.minY + 60), CGPoint(x: 30, y: -30), r(0, 0, 30, -30)),
        ("centre", CGPoint(x: S.midX - 10, y: S.midY - 10), CGPoint(x: -20, y: -20), r(0, 0, -20, -20)),
    ]
    for (n, p, d, want) in regions { modDrag("⌘⌥⇧ resize from \(n)", from: p, by: d, mods: rs, want: want) }
    // Classic: a drag starting at the top-left grows the window at the bottom-right.
    setFrame(S); ensureFront()
    var before = placedCount()
    let tl = CGPoint(x: S.minX + inset, y: S.minY + inset)
    if onMyWindow(tl) {
        ctl(["drag", "\(Int(tl.x))", "\(Int(tl.y))", "\(Int(tl.x + 100))", "\(Int(tl.y + 60))", rs])
        pause(0.5)
        let g = frame()
        let ok = g.map { abs($0.minX - S.minX) <= 1 && abs($0.minY - S.minY) <= 1 && abs($0.width - (S.width + 100)) <= 2 && abs($0.height - (S.height + 60)) <= 2 } ?? false
        record(ok && placedCount() - before == 1, "⌘⌥⇧ from the top-left still moves the bottom-right corner", "got \(fmt(g))")
    }

    // Very fast: down and up far away with no drag events in between.
    setFrame(S); ensureFront()
    before = placedCount()
    let c = CGPoint(x: S.midX, y: S.midY)
    if onMyWindow(c) {
        // One process for press and release: a release posted by a second process can be dropped by
        // the window server (real hardware never splits a click across processes).
        ctl(["throw", "\(Int(c.x))", "\(Int(c.y))", "\(Int(c.x + 300))", "\(Int(c.y + 100))", mv])
        expectFrame("⌘⌥ throw: down/up with no drag events still moves", S.offsetBy(dx: 300, dy: 100), since: before)
    }
    modDrag("⌘⌥ drag to the right screen edge snaps (right half)", from: c, by: CGPoint(x: F.maxX - 1 - c.x, y: 0), mods: mv, want: cell(2, 1, 1, 0))
    // Past the screen edge: the pointer stops at the edge (a right-edge snap), or the event keeps
    // the off-screen x (a plain move). Either is fine; it must end and report once.
    setFrame(S); ensureFront()
    before = placedCount()
    if onMyWindow(c) {
        ctl(["drag", "\(Int(c.x))", "\(Int(c.y))", "\(Int(c.x + 900))", "\(Int(c.y))", mv])
        pause(0.5)
        let g = frame()
        let ok = g.map { near($0, cell(2, 1, 1, 0), 1) || near($0, S.offsetBy(dx: 900, dy: 0), 1) } ?? false
        record(ok && placedCount() - before == 1, "⌘⌥ drag ending past the screen edge → \(fmt(g))", "got \(fmt(g)), windowPlaced ×\(placedCount() - before)")
    }

    // Modifiers released mid-drag: the drag continues until the button goes up.
    setFrame(S); ensureFront()
    before = placedCount()
    if onMyWindow(c) {
        ctl(["down", "\(Int(c.x))", "\(Int(c.y))", mv])
        ctl(["move", "\(Int(c.x + 30))", "\(Int(c.y + 10))", mv])
        ctl(["move", "\(Int(c.x + 60))", "\(Int(c.y + 20))"])
        ctl(["up", "\(Int(c.x + 60))", "\(Int(c.y + 20))"])
        expectFrame("modifiers released mid-drag: drag completes", S.offsetBy(dx: 60, dy: 20), since: before)
    }

    // ⌘⌥-dragging a snapped window out of its slot restores its size around the grab point.
    setFrame(S); ensureFront()
    key("ctrl+opt+left")
    pause(0.3)
    if let f = frame() {
        let a = CGPoint(x: f.minX + 200, y: f.midY), end = CGPoint(x: f.minX + 600, y: f.midY + 50)
        if onMyWindow(a) {
            before = placedCount()
            ctl(["drag", "\(Int(a.x))", "\(Int(a.y))", "\(Int(end.x))", "\(Int(end.y))", mv])
            pause(0.4)
            let g = frame() ?? .zero
            let fx0 = (a.x - f.minX) / f.width, fx1 = (end.x - g.minX) / max(1, g.width)
            let ok = abs(g.width - S.width) <= 1 && abs(g.height - S.height) <= 1 && g.contains(end) && abs(fx0 - fx1) < 0.03
            record(ok && placedCount() - before == 1, "⌘⌥ drag out of a snapped slot restores 600x400 around the grab point",
                   "got \(fmt(g)), cursor \(end), grab fraction \(fx0) → \(fx1)")
        }
    }

    // A modifier click without a drag reaches the app and changes nothing.
    print("\n-- modifier clicks pass through")
    setFrame(S); ensureFront()
    key("ctrl+opt+left") // snapped: a click must not unsnap it
    pause(0.3)
    let snapped = frame() ?? .zero
    setSelection(0)
    let textPoint = CGPoint(x: snapped.minX + 150, y: snapped.minY + 120)
    before = placedCount()
    if onMyWindow(textPoint) {
        // NSTextView shows nothing for a ⌘⌥-click, so watch the event stream after Bento's tap
        // (a listen-only tap at the tail of the session taps sees what the app gets).
        let c1 = spyClicks(near: textPoint) { ctl(["click", "\(Int(textPoint.x))", "\(Int(textPoint.y))", mv]) }
        record(c1 == (1, 1), "⌘⌥-click reaches the app (after Bento's tap: \(c1.0) down, \(c1.1) up)", "click swallowed or doubled")
        expectFrame("⌘⌥-click doesn't move or unsnap the window", snapped, since: before, placed: 0, tol: 0)
        let c2 = spyClicks(near: textPoint) { ctl(["click", "\(Int(textPoint.x))", "\(Int(textPoint.y))", rs]) }
        record(c2 == (1, 1), "⌘⌥⇧-click reaches the app (\(c2.0) down, \(c2.1) up)", "click swallowed or doubled")
        expectFrame("⌘⌥⇧-click doesn't resize the window", snapped, since: before, placed: 0, tol: 0)
        let c3 = spyClicks(near: nil) {
            ctl(["drag", "\(Int(textPoint.x))", "\(Int(textPoint.y))", "\(Int(textPoint.x + 80))", "\(Int(textPoint.y + 40))", mv])
        }
        record(c3 == (0, 0), "⌘⌥-drag: the app sees no click (\(c3.0) down, \(c3.1) up)", "drag clicks leaked to the app")
        setFrame(snapped)
        before = placedCount()
        setSelection(0)
        let run2 = run(clickPath, ["double", "\(Int(textPoint.x))", "\(Int(textPoint.y))", mv, "--expect", te])
        if run2.0 == 75 { stopForUser() }
        pause(0.3)
        let sel2 = selectedRanges()
        record(sel2.contains { $0.length > 0 }, "⌘⌥-double-click selects a word (click counts kept)",
               "ranges \(sel2.map { "\($0.location):\($0.length)" }) \(run2.1)")
        expectFrame("⌘⌥-double-click doesn't move the window", snapped, since: before, placed: 0, tol: 0)
    }

    // A press whose mouse-up never arrives must not swallow the next normal click.
    print("\n-- lost mouse-up")
    setFrame(S); ensureFront()
    before = placedCount()
    if onMyWindow(c) {
        ctl(["down", "\(Int(c.x))", "\(Int(c.y))", mv])
        ctl(["move", "\(Int(c.x + 40))", "\(Int(c.y))", mv])
        pause(0.2)
        let afterFirst = frame() ?? .zero
        // No mouse-up. Now a plain drag in the text: must reach TextEdit and not move the window.
        let p = CGPoint(x: afterFirst.minX + 150, y: afterFirst.minY + 150)
        ctl(["down", "\(Int(p.x))", "\(Int(p.y))"])
        ctl(["move", "\(Int(p.x + 120))", "\(Int(p.y + 20))"])
        ctl(["up", "\(Int(p.x + 120))", "\(Int(p.y + 20))"])
        pause(0.3)
        let got = frame()
        let sel = selectedRanges()
        record(got.map { near($0, afterFirst, 1) } ?? false, "plain drag after a lost ⌘⌥ mouse-up doesn't move the window",
               "got \(fmt(got)) want \(fmt(afterFirst))")
        record(sel.contains { $0.length > 0 }, "plain drag after a lost mouse-up selects text (not swallowed)",
               "ranges \(sel.map { "\($0.location):\($0.length)" })")
        let n = placedCount() - before
        record(n == 1, "stale drag reported once when it ended", "windowPlaced ×\(n)")
    }
}

func phaseMisc() {
    print("\n-- layouts, stash")
    // Layout restore with an entry for our document only (other TextEdit windows stay put).
    editWindowsConfig { w in
        w["layouts"] = [["id": "qa1", "name": "QA", "launchApps": false,
                         "windows": [["bundleID": te, "appName": "TextEdit", "title": "\(title).txt", "index": 0,
                                      "frame": ["x": V.minX + 100, "y": V.minY + 100, "w": 500, "h": 300],
                                      "screen": ["x": F.minX, "y": F.minY, "w": F.width, "h": F.height]]]]]
    }
    pause(0.4) // action list reload is debounced
    step("restore layout", { perform("windows.layout-qa1") }, CGRect(x: V.minX + 100, y: V.minY + 100, width: 500, height: 300))
    editWindowsConfig { $0["layouts"] = [Any]() }

    setFrame(S); ensureFront()
    var before = placedCount()
    perform("windows.stash-left")
    expectFrame("stash left leaves a 12 pt sliver", CGRect(x: F.minX - S.width + 12, y: S.minY, width: S.width, height: S.height),
                since: before, placed: 0)
    perform("windows.stash-reveal")
    expectFrame("reveal stashed window", S)
    perform("windows.stash-reveal")
    expectFrame("stash it again", CGRect(x: F.minX - S.width + 12, y: S.minY, width: S.width, height: S.height))
    perform("windows.stash-unstash-all")
    expectFrame("unstash all", S)
    ensureFront()
    before = placedCount()
    perform("windows.stash-right")
    expectFrame("stash right", CGRect(x: F.maxX - 12, y: S.minY, width: S.width, height: S.height), since: before, placed: 0)
    perform("windows.stash-right") // toggles back
    expectFrame("stash right again unstashes", S)
}

func axFrame(_ el: AXUIElement) -> CGRect? {
    guard let pv: AXValue = attr(el, kAXPositionAttribute), let sv: AXValue = attr(el, kAXSizeAttribute) else { return nil }
    var p = CGPoint.zero, s = CGSize.zero
    AXValueGetValue(pv, .cgPoint, &p); AXValueGetValue(sv, .cgSize, &s)
    return CGRect(origin: p, size: s)
}

func phasePanels() {
    print("\n-- non-resizable panel and sheet (TextEdit's About panel, Page Setup sheet on our document)")
    ensureFront()
    let app = AXUIElementCreateApplication(appPID)
    let before: [AXUIElement] = attr(app, kAXWindowsAttribute) ?? []
    // TextEdit › About TextEdit, pressed through AX (not synthetic input).
    if let bar: AXUIElement = attr(app, kAXMenuBarAttribute), let items: [AXUIElement] = attr(bar, kAXChildrenAttribute), items.count > 1,
       let menus: [AXUIElement] = attr(items[1], kAXChildrenAttribute), let menu = menus.first,
       let entries: [AXUIElement] = attr(menu, kAXChildrenAttribute),
       let about = entries.first(where: { ((attr($0, kAXTitleAttribute) as String?) ?? "").hasPrefix("About") }) {
        AXUIElementPerformAction(about, kAXPressAction as CFString)
        pause(0.8)
    }
    let after: [AXUIElement] = attr(app, kAXWindowsAttribute) ?? []
    let panel = after.first { w in !before.contains { CFEqual($0, w) } }
    if let panel, let f0 = axFrame(panel), !((attr(panel, kAXTitleAttribute) as String?) ?? "").contains(title) {
        let wid = windowID(panel)
        let c = CGPoint(x: f0.midX, y: f0.midY)
        if topWindow(at: c) == wid {
            var n = placedCount()
            ctl(["drag", "\(Int(c.x))", "\(Int(c.y))", "\(Int(c.x + 60))", "\(Int(c.y + 40))", "cmd+opt"])
            pause(0.4)
            let f1 = axFrame(panel)
            record(f1.map { near($0, f0.offsetBy(dx: 60, dy: 40), 1) } ?? false, "⌘⌥ moves a non-resizable panel", "got \(fmt(f1)) from \(fmt(f0))")
            let br = CGPoint(x: (f1 ?? f0).maxX - 15, y: (f1 ?? f0).maxY - 15)
            ctl(["drag", "\(Int(br.x))", "\(Int(br.y))", "\(Int(br.x + 80))", "\(Int(br.y + 60))", "cmd+opt+shift"])
            pause(0.4)
            let f2 = axFrame(panel)
            record(f2.map { near($0, f1 ?? f0, 1) } ?? false, "⌘⌥⇧ on a non-resizable panel changes nothing", "got \(fmt(f2)) from \(fmt(f1))")
            let tl = CGPoint(x: (f2 ?? f0).minX + 15, y: (f2 ?? f0).minY + 30)
            ctl(["drag", "\(Int(tl.x))", "\(Int(tl.y))", "\(Int(tl.x - 50))", "\(Int(tl.y - 30))", "cmd+opt+shift"])
            pause(0.4)
            let f3 = axFrame(panel)
            record(f3.map { near($0, f2 ?? f0, 1) } ?? false, "⌘⌥⇧ from its top-left doesn't drift a fixed-size panel", "got \(fmt(f3)) from \(fmt(f2))")
            n = placedCount() - n
            record(n == 3, "panel drags reported once each", "windowPlaced ×\(n)")
        } else { skipped.append("About panel covered") }
        if let b: AXUIElement = attr(panel, kAXCloseButtonAttribute) { AXUIElementPerformAction(b, kAXPressAction as CFString) }
        pause(0.3)
    } else { skipped.append("couldn't open TextEdit's About panel") }

    // Page Setup sheet on our document: ⌘⌥-dragging the sheet moves the document window.
    setFrame(S); ensureFront()
    key("cmd+shift+p")
    pause(1.0)
    let children: [AXUIElement] = myWindow().flatMap { w -> [AXUIElement]? in attr(w, kAXChildrenAttribute) } ?? []
    let sheets = children.filter { (attr($0, kAXRoleAttribute) as String?) == "AXSheet" }
    if let sheet = sheets.first, let sf = axFrame(sheet), let w0 = frame() { // (macOS may shift the window to fit a wide sheet)
        let p = CGPoint(x: sf.midX, y: sf.minY + 20)
        let n = placedCount()
        ctl(["drag", "\(Int(p.x))", "\(Int(p.y))", "\(Int(p.x + 50))", "\(Int(p.y + 30))", "cmd+opt"])
        pause(0.4)
        let got = frame()
        record((got.map { near($0, w0.offsetBy(dx: 50, dy: 30), 1) } ?? false) && placedCount() - n == 1, "⌘⌥ on a sheet moves its document window",
               "window \(fmt(got)) want \(fmt(w0.offsetBy(dx: 50, dy: 30))), sheet was \(fmt(sf)), windowPlaced ×\(placedCount() - n)")
        ensureFrontSheetAware()
        ctl(["key", "escape"])
        pause(0.5)
    } else { skipped.append("no Page Setup sheet appeared") }
}

/// With a sheet open the document stays focused; just make sure TextEdit is frontmost.
func ensureFrontSheetAware() {
    checkUser()
    if NSWorkspace.shared.frontmostApplication?.bundleIdentifier != te { ctl(["front", te, title], input: false) }
}

/// Presses OK in an alert of the Bento under test (AX, our own process); returns the alert's text.
func confirmBentoAlert() -> String? {
    let app = AXUIElementCreateApplication(bentoPID)
    for _ in 0..<25 {
        for w in (attr(app, kAXWindowsAttribute) as [AXUIElement]?) ?? [] {
            let kids: [AXUIElement] = attr(w, kAXChildrenAttribute) ?? []
            guard let ok = kids.first(where: { (attr($0, kAXRoleAttribute) as String?) == "AXButton" && (attr($0, kAXTitleAttribute) as String?) == "OK" })
            else { continue }
            let text = kids.compactMap { (attr($0, kAXValueAttribute) as String?) }.joined(separator: " | ")
            AXUIElementPerformAction(ok, kAXPressAction as CFString)
            return text
        }
        pause(0.2)
    }
    return nil
}

func phaseImport() {
    print("\n-- manual Rectangle import (this Mac's Rectangle Pro plist, into the test instance's config only)")
    let prefs = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Preferences/com.knollsoft.Hookshot.plist")
    guard FileManager.default.fileExists(atPath: prefs.path) else { skipped.append("no Rectangle Pro preferences on this Mac"); return }
    perform("windows.import-rectangle")
    let text = confirmBentoAlert()
    record(text != nil, "import shows its summary", "no alert")
    if let text { print("   summary: \(text.prefix(400))") }
    pause(1.0)
    let root = FileManager.default.contents(atPath: configPath).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
    let sc = root?["shortcuts"] as? [String: String] ?? [:]
    let w = root?["windows"] as? [String: Any] ?? [:]
    // Overrides only (an imported key equal to Bento's default, like ⌃⌥] for Next Display, stores none).
    let expected = ["windows.left-half": "opt+comma", "windows.move-left": "ctrl+opt+left", "windows.top-half": "opt+shift+comma"]
    for (id, want) in expected {
        record(sc[id] == want, "imported \(id) = \(want)", "got \(sc[id] ?? "nil")")
    }
    record(sc["windows.next-display"] == nil, "imported Next Display = ⌃⌥] (Bento's default: no override)", "got \(sc["windows.next-display"] ?? "nil")")
    record(Set(w["dragMoveModifiers"] as? [String] ?? []) == ["cmd", "opt"], "imported ⌘⌥ move gesture", "\(w["dragMoveModifiers"] ?? "nil")")
    // That plist puts ⌃⌥← on Move Left (the user's original "broken" report): it now moves to the edge.
    step("⌃⌥← after importing that plist = Move Left", { key("ctrl+opt+left") },
         CGRect(x: V.minX, y: V.minY + ((V.height - S.height) / 2).rounded(), width: S.width, height: S.height))
}

func phaseSpaces() {
    print("\n-- Spaces (our window only)")
    setFrame(S); ensureFront()
    let wid = windowID(myWindow())
    func spaces() -> [Int] { (CGSCopySpacesForWindows(CGSMainConnectionID(), 0x7, [NSNumber(value: wid)] as CFArray) as? [NSNumber] ?? []).map(\.intValue) }
    let original = spaces()
    perform("windows.next-space")
    pause(2.5)
    let moved = spaces()
    record(!moved.isEmpty && moved != original, "next space moves our window", "spaces \(original) → \(moved)")
    ensureFront()
    perform("windows.prev-space")
    pause(2.5)
    let back = spaces()
    record(back == original, "previous space brings it back", "spaces \(moved) → \(back), want \(original)")
}

func cleanup() {
    // Close our (unmodified) document via its close button.
    if let w = myWindow(), let b: AXUIElement = attr(w, kAXCloseButtonAttribute) {
        AXUIElementPerformAction(b, kAXPressAction as CFString)
        pause(0.4)
    }
    print(myWindow() == nil ? "closed \(title)" : "!! \(title) still open")
}

// MARK: Main

guard myWindow() != nil else { print("no TextEdit window titled \(title)"); exit(2) }
print("screen \(fmt(F)) visible \(fmt(V)); Bento pid \(bentoPID)")
for phase in CommandLine.arguments.dropFirst() {
    switch phase {
    case "keys": phaseKeys()
    case "snap": phaseSnap()
    case "drag": phaseDrag()
    case "misc": phaseMisc()
    case "panels": phasePanels()
    case "import": phaseImport()
    case "spaces": phaseSpaces()
    case "cleanup": cleanup()
    default: print("unknown phase \(phase)")
    }
}
summary()
exit(failed.isEmpty ? 0 : 1)
