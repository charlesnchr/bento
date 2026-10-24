// Keyboard overview e2e helper. Never posts input events; AX actions only on
// the Bento process under test. Build: swiftc -O scripts/e2e/overview-ctl.swift -o /tmp/overview-ctl
//   overview-ctl perform <action-id>             trigger an action in running dev instances (BENTO_DEV)
//   overview-ctl url <bento-home> <url>          open a bento:// URL in the dev instance with that BENTO_HOME
//   overview-ctl windows <pid>                   on-screen windows of a process: id layer x y w h title
//   overview-ctl visible-status-window <id>      verify a known status window is on screen and clear of the notch
//   overview-ctl press <pid> <title>             AXPress the first button/link titled <title> in its windows
//   overview-ctl search-value <pid> <window>     value of the search field in the window whose title contains <window>
//   overview-ctl menu <pid> <title>              open the process's menu bar (status item) menu, print the item's
//                                                shortcut ("⌃⌥/") and choose it
//   overview-ctl status-menu <pid> <window-id> <submenu> <title> choose an item in the known status icon's submenu
//   overview-ctl spawn-disclaimed <log> <cmd…>   start <cmd> as its own TCC responsible process (so it runs without
//                                                this shell's Accessibility/Screen Recording grants); prints the pid
import AppKit
import ApplicationServices

let args = Array(CommandLine.arguments.dropFirst())
let checksUserActivity = ["press", "menu", "status-menu"].contains(args.first ?? "")
func fail(_ s: String) -> Never { FileHandle.standardError.write((s + "\n").data(using: .utf8)!); exit(1) }

func checkUserActivity() {
    if FileManager.default.fileExists(atPath: "/tmp/bento-user-active") {
        FileHandle.standardError.write(Data("user activity detected; stopping AX actions\n".utf8))
        exit(75)
    }
}

@discardableResult
func guardedAction(_ element: AXUIElement, _ action: CFString) -> AXError {
    checkUserActivity()
    let result = AXUIElementPerformAction(element, action)
    checkUserActivity()
    return result
}

func attr<T>(_ el: AXUIElement, _ name: String) -> T? {
    if checksUserActivity { checkUserActivity() }
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success, let v else { return nil }
    if T.self == AXUIElement.self { return (v as! T) }
    return v as? T
}

/// Depth-first search through an element's descendants.
func find(_ el: AXUIElement, depth: Int = 0, _ match: (AXUIElement) -> Bool) -> AXUIElement? {
    if checksUserActivity { checkUserActivity() }
    if match(el) { return el }
    guard depth < 40, let kids: [AXUIElement] = attr(el, kAXChildrenAttribute) else { return nil }
    for k in kids { if let hit = find(k, depth: depth + 1, match) { return hit } }
    return nil
}

func appWindows(_ pid: pid_t) -> [AXUIElement] {
    attr(AXUIElementCreateApplication(pid), kAXWindowsAttribute) ?? []
}

guard let cmd = args.first else { fail("usage: see header") }
switch cmd {
case "perform":
    guard args.count == 2 else { fail("perform <action-id>") }
    DistributedNotificationCenter.default().postNotificationName(Notification.Name("com.charles.bento.dev.perform"),
                                                                 object: args[1], userInfo: nil, deliverImmediately: true)
case "url":
    guard args.count == 3 else { fail("url <bento-home> <url>") }
    DistributedNotificationCenter.default().postNotificationName(Notification.Name("com.charles.bento.dev.url"),
                                                                 object: args[1], userInfo: ["url": args[2]], deliverImmediately: true)
case "windows":
    guard args.count == 2, let pid = Int(args[1]) else { fail("windows <pid>") }
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    for w in list where (w[kCGWindowOwnerPID as String] as? Int) == pid {
        let b = w[kCGWindowBounds as String] as? [String: CGFloat] ?? [:]
        let id = w[kCGWindowNumber as String] as? Int ?? 0
        let layer = w[kCGWindowLayer as String] as? Int ?? 0
        let title = w[kCGWindowName as String] as? String ?? ""
        print(id, layer, Int(b["X"] ?? 0), Int(b["Y"] ?? 0), Int(b["Width"] ?? 0), Int(b["Height"] ?? 0), title)
    }
case "visible-status-window":
    guard args.count == 2, let id = UInt32(args[1]) else { fail("visible-status-window <id>") }
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    guard let window = list.first(where: { ($0[kCGWindowNumber as String] as? UInt32) == id }),
          let bounds = window[kCGWindowBounds as String] as? NSDictionary,
          let frame = CGRect(dictionaryRepresentation: bounds) else { fail("status window \(id) is not on screen") }
    let top = NSScreen.screens.first?.frame.maxY ?? 0
    let fits = NSScreen.screens.contains { screen in
        let left = screen.safeAreaInsets.top > 0
            ? (screen.auxiliaryTopRightArea?.minX ?? screen.frame.minX) : screen.frame.minX
        return abs(frame.minY - (top - screen.frame.maxY)) <= 1
            && frame.minX >= left && frame.maxX <= screen.frame.maxX && frame.width > 0
    }
    guard fits else { fail("status window \(id) overlaps the notch or screen edge: \(frame)") }
    print("visible status window", id, frame)
case "press":
    guard args.count == 3, let pid = pid_t(args[1]) else { fail("press <pid> <title>") }
    for w in appWindows(pid) {
        let hit = find(w) { el in
            let role: String = attr(el, kAXRoleAttribute) ?? ""
            guard ["AXButton", "AXLink"].contains(role) else { return false }
            let title: String = attr(el, kAXTitleAttribute) ?? ""
            let desc: String = attr(el, kAXDescriptionAttribute) ?? ""
            return title == args[2] || desc == args[2]
        }
        if let hit {
            let err = guardedAction(hit, kAXPressAction as CFString)
            if err != .success { fail("AXPress failed: \(err.rawValue)") }
            exit(0)
        }
    }
    fail("no button '\(args[2])' in pid \(pid)")
case "search-value":
    guard args.count == 3, let pid = pid_t(args[1]) else { fail("search-value <pid> <window>") }
    guard let w = appWindows(pid).first(where: { ((attr($0, kAXTitleAttribute) as String?) ?? "").contains(args[2]) }) else {
        fail("no window '\(args[2])'")
    }
    let field = find(w) { el in
        (attr(el, kAXSubroleAttribute) as String?) == "AXSearchField" || (attr(el, kAXRoleAttribute) as String?) == "AXSearchField"
    }
    guard let field else { fail("no search field") }
    print((attr(field, kAXValueAttribute) as String?) ?? "")
case "menu", "status-menu":
    let targeted = cmd == "status-menu"
    guard args.count == (targeted ? 5 : 3), let pid = pid_t(args[1]) else { fail("menu <pid> <title> or status-menu <pid> <window-id> <submenu> <title>") }
    let app = AXUIElementCreateApplication(pid)
    guard let extras: AXUIElement = attr(app, "AXExtrasMenuBar"),
          let children: [AXUIElement] = attr(extras, kAXChildrenAttribute) else { fail("no status items") }
    var targetFrame = CGRect.zero
    if targeted {
        guard let wid = UInt32(args[2]),
              let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
              let window = list.first(where: { ($0[kCGWindowNumber as String] as? UInt32) == wid }),
              let bounds = window[kCGWindowBounds as String] as? NSDictionary,
              let frame = CGRect(dictionaryRepresentation: bounds) else { fail("target status window is not visible") }
        targetFrame = frame
    }
    let matches = targeted ? children.filter { child in
        guard let position: AXValue = attr(child, kAXPositionAttribute),
              let sizeValue: AXValue = attr(child, kAXSizeAttribute) else { return false }
        var point = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(position, .cgPoint, &point), AXValueGetValue(sizeValue, .cgSize, &size) else { return false }
        let frame = CGRect(origin: point, size: size)
        return abs(frame.midX - targetFrame.midX) <= 2 && abs(frame.midY - targetFrame.midY) <= 3
    } : Array(children.prefix(1))
    guard matches.count == 1, let status = matches.first else { fail("no unique matching status item") }
    // The app tracks the menu inside the press: don't wait for it to close.
    AXUIElementSetMessagingTimeout(status, 0.5)
    guardedAction(status, kAXPressAction as CFString)
    if targeted {
        guard let parent = find(status, { (attr($0, kAXRoleAttribute) as String?) == "AXMenuItem" && (attr($0, kAXTitleAttribute) as String?) == args[3] }) else {
            if let menu = find(status, { (attr($0, kAXRoleAttribute) as String?) == "AXMenu" }) { guardedAction(menu, kAXCancelAction as CFString) }
            fail("no submenu '\(args[3])'")
        }
        AXUIElementSetMessagingTimeout(parent, 0.5)
        guardedAction(parent, kAXPressAction as CFString)
    }
    let title = targeted ? args[4] : args[2]
    var item: AXUIElement?
    for _ in 0..<20 {
        checkUserActivity()
        item = find(status) { (attr($0, kAXRoleAttribute) as String?) == "AXMenuItem" && (attr($0, kAXTitleAttribute) as String?) == title }
        if item != nil { break }
        usleep(100_000)
    }
    guard let item else {
        if let menu = find(status, { (attr($0, kAXRoleAttribute) as String?) == "AXMenu" }) { guardedAction(menu, kAXCancelAction as CFString) }
        fail("no menu item '\(title)'")
    }
    let char: String = attr(item, kAXMenuItemCmdCharAttribute) ?? ""
    let mods = (attr(item, kAXMenuItemCmdModifiersAttribute) as NSNumber?)?.intValue ?? 0
    // kAXMenuItemModifier*: shift 1, option 2, control 4, no-command 8.
    var s = ""
    if mods & 4 != 0 { s += "⌃" }
    if mods & 2 != 0 { s += "⌥" }
    if mods & 1 != 0 { s += "⇧" }
    if mods & 8 == 0 { s += "⌘" }
    print(char.isEmpty ? "" : s + char)
    guardedAction(item, kAXPressAction as CFString)
case "spawn-disclaimed":
    guard args.count >= 3 else { fail("spawn-disclaimed <log> <cmd…>") }
    var attrs: posix_spawnattr_t?
    posix_spawnattr_init(&attrs)
    typealias Disclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
    guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim") else { fail("no disclaim API") }
    _ = unsafeBitCast(sym, to: Disclaim.self)(&attrs, 1)
    var actions: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&actions)
    posix_spawn_file_actions_addopen(&actions, 1, args[1], O_WRONLY | O_CREAT | O_APPEND, 0o644)
    posix_spawn_file_actions_adddup2(&actions, 1, 2)
    let argv = Array(args.dropFirst(2)).map { strdup($0) } + [nil]
    var pid: pid_t = 0
    let rc = posix_spawn(&pid, args[2], &actions, &attrs, argv, environ)
    if rc != 0 { fail("posix_spawn failed: \(rc)") }
    print(pid)
default:
    fail("unknown command \(cmd)")
}
