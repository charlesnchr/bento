// Double-click with real click counts (bentoctl's clicks carry no click state),
// with bentoctl's safety rules: refuses while /tmp/bento-user-active exists,
// only clicks a point owned by --expect <bundleid>, registers its pid for the guard.
// Build: swiftc -O scripts/e2e/windows-click.swift -o /tmp/windows-click
//   windows-click double x y [mods] --expect <bundleid>
import AppKit
import ApplicationServices

func fail(_ s: String, code: Int32 = 1) -> Never { FileHandle.standardError.write((s + "\n").data(using: .utf8)!); exit(code) }

var argv = Array(CommandLine.arguments.dropFirst())
guard let i = argv.firstIndex(of: "--expect"), i + 1 < argv.count else { fail("--expect <bundleid> is required") }
let expect = argv[i + 1]
argv.removeSubrange(i...(i + 1))
guard argv.count >= 3, argv[0] == "double", let x = Double(argv[1]), let y = Double(argv[2]) else { fail("usage: windows-click double x y [mods] --expect <bundleid>") }
if FileManager.default.fileExists(atPath: "/tmp/bento-user-active") { fail("user is active; refusing to post input", code: 75) }

var flags: CGEventFlags = []
for m in (argv.count > 3 ? argv[3] : "").split(separator: "+") {
    switch m {
    case "cmd": flags.insert(.maskCommand)
    case "opt", "alt": flags.insert(.maskAlternate)
    case "ctrl": flags.insert(.maskControl)
    case "shift": flags.insert(.maskShift)
    default: fail("bad modifier \(m)")
    }
}
let p = CGPoint(x: x, y: y)
var el: AXUIElement?
var pid: pid_t = 0
if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(p.x), Float(p.y), &el) == .success, let el { AXUIElementGetPid(el, &pid) }
let owner = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
if owner != expect { fail("point \(p) belongs to \(owner ?? "nothing"), expected \(expect); not clicking") }

// Register with the guard (see scripts/e2e/guard.swift).
let pids = "/tmp/bento-e2e-pids"
if !FileManager.default.fileExists(atPath: pids) { FileManager.default.createFile(atPath: pids, contents: nil) }
if let h = FileHandle(forWritingAtPath: pids) { h.seekToEndOfFile(); h.write("\(getpid())\n".data(using: .utf8)!); h.closeFile() }

let src = CGEventSource(stateID: .hidSystemState)
func post(_ type: CGEventType, clicks: Int64) {
    guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: .left) else { return }
    e.flags = flags
    e.setIntegerValueField(.mouseEventClickState, value: clicks)
    e.post(tap: .cghidEventTap)
}
post(.mouseMoved, clicks: 0); usleep(60_000)
for n in Int64(1)...2 {
    post(.leftMouseDown, clicks: n); usleep(30_000)
    post(.leftMouseUp, clicks: n); usleep(80_000)
}
