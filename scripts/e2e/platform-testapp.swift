// Tiny regular app with three windows, used as the target of App Hotkeys
// (Launcher) toggle/focus/cycle tests so they never touch the user's apps.
// scripts/e2e/platform.sh builds it into $BENTO_HOME/PlatformTest.app
// (bundle id com.charles.bento.e2e.testapp). Quits by itself after 10 minutes.
import AppKit

final class Delegate: NSObject, NSApplicationDelegate {
    var windows: [NSWindow] = []
    func applicationDidFinishLaunching(_ n: Notification) {
        for i in 1...3 {
            let w = NSWindow(contentRect: NSRect(x: 120 + i * 40, y: 200 + i * 40, width: 360, height: 220),
                             styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            w.title = "QA Window \(i)"
            w.isReleasedWhenClosed = false
            let label = NSTextField(labelWithString: "Bento platform e2e test window \(i)")
            label.frame = NSRect(x: 20, y: 100, width: 320, height: 20)
            w.contentView?.addSubview(label)
            w.makeKeyAndOrderFront(nil)
            windows.append(w)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 600) { NSApp.terminate(nil) }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { true }
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
