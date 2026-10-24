// Optional native fixtures for the manual MenuBar smoke in docs/QA.md.
// The old menubar.sh automation is obsolete. This helper has no pointer controls.
// Build: swiftc -O scripts/e2e/menubar-items.swift -o /tmp/menubar-items
//   menubar-items items <log> X Y Z   throwaway status items, one per title (autosave name
//                                     BentoQA<title>); each logs "open <title>" to <log> when its
//                                     menu opens and closes the menu itself after 0.8 s. SIGUSR1
//                                     changes their titles (an icon update); removed on
//                                     SIGTERM/SIGINT (and gone with the process anyway).
//   menubar-items order               every status item window left to right: "<id> <name> <x>"
//                                     (names are blank while an item is parked off-screen)
//   menubar-items url <home> <url>    sends a bento:// URL to the dev instance with that BENTO_HOME
//   menubar-items perform <action>    runs an action in running dev instances (scripts/perform)
import AppKit

let args = Array(CommandLine.arguments.dropFirst())
func usage() -> Never {
    FileHandle.standardError.write("usage: menubar-items items <log> TITLE... | order | url <home> <url> | perform <action>\n".data(using: .utf8)!)
    exit(2)
}

switch args.first {
case "order":
    // The window server's list of status item windows, with live frames (also
    // for parked items). Private CoreGraphics calls, looked up at runtime.
    typealias MainConnection = @convention(c) () -> Int32
    typealias WindowCount = @convention(c) (Int32, Int32, UnsafeMutablePointer<Int32>) -> CGError
    typealias WindowList = @convention(c) (Int32, Int32, Int32, UnsafeMutablePointer<CGWindowID>, UnsafeMutablePointer<Int32>) -> CGError
    typealias ScreenRect = @convention(c) (Int32, CGWindowID, UnsafeMutablePointer<CGRect>) -> CGError
    let cg = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_LAZY)
    func sym<T>(_ name: String, _: T.Type) -> T { unsafeBitCast(dlsym(cg, name)!, to: T.self) }
    let cid = sym("CGSMainConnectionID", MainConnection.self)()
    var n: Int32 = 0
    _ = sym("CGSGetWindowCount", WindowCount.self)(cid, 0, &n)
    var ids = [CGWindowID](repeating: 0, count: Int(n) + 64)
    var count: Int32 = 0
    _ = sym("CGSGetProcessMenuBarWindowList", WindowList.self)(cid, 0, Int32(ids.count), &ids, &count)
    let rect = sym("CGSGetScreenRectForWindow", ScreenRect.self)
    var rows: [(CGWindowID, String, CGRect)] = []
    for id in ids.prefix(Int(count)) {
        let info = (CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String: Any]])?.first ?? [:]
        guard (info[kCGWindowLayer as String] as? Int) == Int(CGWindowLevelForKey(.statusWindow)) else { continue }
        var r = CGRect.zero
        _ = rect(cid, id, &r)
        let name = info[kCGWindowName as String] as? String ?? ""
        rows.append((id, name.isEmpty ? "-" : name, r))
    }
    for (id, name, r) in rows.sorted(by: { $0.2.midX < $1.2.midX }) { print(id, name, Int(r.minX.rounded())) }
    exit(0)
case "url":
    guard args.count == 3 else { usage() }
    DistributedNotificationCenter.default().postNotificationName(Notification.Name("com.charles.bento.dev.url"), object: args[1],
                                                                 userInfo: ["url": args[2]], deliverImmediately: true)
    exit(0)
case "perform":
    guard args.count == 2 else { usage() }
    DistributedNotificationCenter.default().postNotificationName(Notification.Name("com.charles.bento.dev.perform"), object: args[1],
                                                                 userInfo: nil, deliverImmediately: true)
    exit(0)
case "items":
    break
default:
    usage()
}

final class MenuLogger: NSObject, NSMenuDelegate {
    let path: String
    init(path: String) { self.path = path }

    func menuWillOpen(_ menu: NSMenu) {
        let line = "open \(menu.title)\n"
        if let h = FileHandle(forWritingAtPath: path) {
            h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); h.closeFile()
        } else {
            FileManager.default.createFile(atPath: path, contents: line.data(using: .utf8))
        }
        // Menus track in their own run loop mode: a common-modes timer still fires.
        let t = Timer(timeInterval: 0.8, repeats: false) { _ in menu.cancelTracking() }
        RunLoop.main.add(t, forMode: .common)
    }
}

guard args.count > 2 else { usage() }
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let logger = MenuLogger(path: args[1])
var items: [NSStatusItem] = []
for t in args.dropFirst(2) {
    let it = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    it.autosaveName = "BentoQA\(t)"
    it.button?.title = t
    let menu = NSMenu(title: t)
    menu.addItem(withTitle: "QA item \(t)", action: nil, keyEquivalent: "")
    menu.delegate = logger
    it.menu = menu
    items.append(it)
}
var sources: [DispatchSourceSignal] = []
signal(SIGUSR1, SIG_IGN)
let update = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
update.setEventHandler { for it in items { it.button?.title = (it.button?.title ?? "") + "!" } }
update.resume(); sources.append(update)
for sig in [SIGTERM, SIGINT] {
    signal(sig, SIG_IGN)
    let s = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    s.setEventHandler { for it in items { NSStatusBar.system.removeStatusItem(it) }; exit(0) }
    s.resume(); sources.append(s)
}
app.run()
