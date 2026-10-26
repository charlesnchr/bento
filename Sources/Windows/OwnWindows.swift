import AppKit
import BentoCore

/// Bento's own regular windows (Todo, Notes, Settings, the editor…), so the
/// window commands treat them like any other app's. Their AX elements are
/// resolved in-process, which is a direct call on the main thread only.
enum OwnWindows {
    /// Titled, activating, movable and not full screen. Not popups, HUDs,
    /// pins, Quick Add or the clipboard panel.
    static func isRegular(_ w: NSWindow) -> Bool {
        w.isVisible && w.isMovable && !w.ignoresMouseEvents && w.styleMask.contains(.titled)
            && !w.styleMask.contains(.nonactivatingPanel) && !w.styleMask.contains(.fullScreen)
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
