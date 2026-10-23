import AppKit
import BentoShell
import MenuBar

// BENTO_APPEARANCE=dark|light: the harness's own appearance, for screenshots
// of either look without touching the system setting.
if let look = ProcessInfo.processInfo.environment["BENTO_APPEARANCE"] {
    NSApplication.shared.appearance = NSAppearance(named: look == "dark" ? .darkAqua : .aqua)
}
BentoApp.runDev("menubar", modules: [MenuBarModule()])
