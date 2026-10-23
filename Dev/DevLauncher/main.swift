import AppKit
import BentoCore
import BentoShell
import Launcher

// BENTO_SHOW_SETTINGS=1 opens settings on the App Hotkeys page (the shell
// itself would open General). BENTO_APPEARANCE=dark|light overrides the
// system appearance for this process only, to check both looks.
let env = ProcessInfo.processInfo.environment
if let look = env["BENTO_APPEARANCE"] {
    NSApplication.shared.appearance = NSAppearance(named: look == "dark" ? .darkAqua : .aqua)
}
if env["BENTO_SHOW_SETTINGS"] != nil {
    // After the shell has finished launching (it observes the request then);
    // a plain async can run while launching spins the run loop, and be lost.
    _ = NotificationCenter.default.addObserver(forName: NSApplication.didFinishLaunchingNotification,
                                               object: nil, queue: .main) { _ in
        DispatchQueue.main.async { SettingsRouter.open("launcher") }
    }
}
BentoApp.runDev("launcher", modules: [LauncherModule()])
