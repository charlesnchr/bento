// GUI test guard: watches input events and flags real user activity so
// end-to-end tests stop the moment the user touches the mouse or keyboard.
// Events posted by our own test tools (or by Bento itself, e.g. ⌘V when
// pasting) carry their process id; anything else is the user.
// Run by scripts/e2e/session; writes /tmp/bento-user-active and exits.
import CoreGraphics
import Darwin
import Foundation

let flag = "/tmp/bento-user-active"
let ours: Set<String> = ["bentoctl", "Bento", "DevShot", "DevWindows", "DevTiling", "DevLauncher", "DevClipboard",
                         "DevNotes", "osascript", "swift-frontend", "swift", "guard", "srcpid", "click", "drag", "front"]
unlink(flag)

func name(of pid: Int64) -> String? {
    guard pid > 0 else { return nil }
    var buf = [CChar](repeating: 0, count: 256)
    return proc_name(Int32(pid), &buf, 256) > 0 ? String(cString: buf) : nil
}

let types: [CGEventType] = [.keyDown, .flagsChanged, .mouseMoved, .leftMouseDown, .rightMouseDown, .leftMouseDragged, .scrollWheel, .otherMouseDown]
let mask = types.reduce(CGEventMask(0)) { $0 | (1 << $1.rawValue) }
var tapRef: CFMachPort?
let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: mask,
    callback: { _, type, event, _ in
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let t = tapRef { CGEvent.tapEnable(tap: t, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        let pid = event.getIntegerValueField(.eventSourceUnixProcessID)
        let n = name(of: pid)
        let registered = (try? String(contentsOfFile: "/tmp/bento-e2e-pids", encoding: .utf8))?
            .split(separator: "\n").contains(Substring(String(pid))) ?? false
        if !registered && (n == nil || !ours.contains(n!)) {
            let msg = "user input: event \(type.rawValue) from pid \(pid) (\(n ?? "hardware")) at \(Date())\n"
            FileManager.default.createFile(atPath: flag, contents: msg.data(using: .utf8))
            FileHandle.standardError.write(msg.data(using: .utf8)!)
            exit(0)
        }
        return Unmanaged.passUnretained(event)
    }, userInfo: nil)
guard let tap else { FileHandle.standardError.write("guard: could not create event tap\n".data(using: .utf8)!); exit(2) }
tapRef = tap
CFRunLoopAddSource(CFRunLoopGetCurrent(), CFMachPortCreateRunLoopSource(nil, tap, 0), .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
CFRunLoopRun()
