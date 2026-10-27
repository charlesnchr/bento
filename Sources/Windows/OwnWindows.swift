import AppKit
import BentoCore

/// Bento's own regular windows (Todo, Notes, Settings, the editor…), so the
/// window commands treat them like any other app's. Their AX elements are
/// resolved in-process, which is a direct call on the main thread only.
enum OwnWindows {
    /// Titled, activating (or a `ManagedPanel`), movable and not full screen.
    /// Not popups, HUDs, pins, Quick Add or the clipboard panel.
    static func isRegular(_ w: NSWindow) -> Bool {
        w.isVisible && isRegular(style: w.styleMask, movable: w.isMovable, ignoresMouse: w.ignoresMouseEvents, managed: w is ManagedPanel)
    }

    static func isRegular(style: NSWindow.StyleMask, movable: Bool, ignoresMouse: Bool, managed: Bool) -> Bool {
        movable && !ignoresMouse && style.contains(.titled) && !style.contains(.fullScreen)
            && (managed || !style.contains(.nonactivatingPanel))
    }

    /// Bento's windows take the window commands: Bento is the active app, or
    /// a `ManagedPanel` has the keyboard without activating it. Main thread.
    static var haveFocus: Bool {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid() { return true }
        guard let key = NSApp.keyWindow else { return false }
        return key is ManagedPanel && key.isKeyWindow && isRegular(key)
    }

    static var regularIDs: Set<CGWindowID> {
        Set(NSApp.windows.filter(isRegular).map { CGWindowID($0.windowNumber) })
    }

    /// The focused regular Bento window: the key window, the window a key
    /// popup belongs to (the Notes palette), or the main window. Main thread.
    static func focused() -> AXWindow? {
        dispatchPrecondition(condition: .onQueue(.main))
        let key = NSApp.keyWindow
        guard let w = [key, key?.parent, NSApp.mainWindow].compactMap({ $0 }).first(where: isRegular) else { return nil }
        return element(CGWindowID(w.windowNumber))
    }

    /// Every regular, visible Bento window. Main thread.
    static func all() -> [AXWindow] {
        dispatchPrecondition(condition: .onQueue(.main))
        let ids = regularIDs
        guard !ids.isEmpty else { return [] }
        return AXWindow.windows(of: getpid()).filter { $0.windowID.map(ids.contains) ?? false }
    }

    /// One of Bento's windows by CG id. Main thread.
    static func element(_ id: CGWindowID) -> AXWindow? {
        dispatchPrecondition(condition: .onQueue(.main))
        return AXWindow.windows(of: getpid()).first { $0.windowID == id }
    }
}
