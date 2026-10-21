import AppKit
import ApplicationServices
import BentoCore

/// One AXObserver per observed app: app-level notifications (window created,
/// focus changed) plus per-window ones (destroyed, moved, resized, minimized).
/// Callbacks arrive on the main run loop; the refcon is the `TilingManager`.
final class AppObserver {
    let pid: pid_t
    let appElement: AXUIElement
    private let observer: AXObserver
    private let refcon: UnsafeMutableRawPointer
    private var windows: Set<AXWindow> = []

    static let appNotifications = [kAXWindowCreatedNotification, kAXFocusedWindowChangedNotification]
    static let windowNotifications = [
        kAXUIElementDestroyedNotification, kAXWindowMovedNotification, kAXWindowResizedNotification,
        kAXWindowMiniaturizedNotification, kAXWindowDeminiaturizedNotification,
    ]

    /// Nil when the app does not (yet) answer accessibility requests.
    init?(pid: pid_t, refcon: UnsafeMutableRawPointer, callback: AXObserverCallback) {
        var created: AXObserver?
        guard AXObserverCreate(pid, callback, &created) == .success, let created else { return nil }
        let app = AXWindow.appElement(pid)
        var ok = false
        for n in AppObserver.appNotifications {
            let err = AXObserverAddNotification(created, app, n as CFString, refcon)
            if err == .success || err == .notificationAlreadyRegistered { ok = true }
        }
        guard ok else { return nil }
        self.pid = pid
        self.appElement = app
        self.observer = created
        self.refcon = refcon
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .commonModes)
    }

    func observe(_ w: AXWindow) {
        guard !windows.contains(w) else { return }
        for n in AppObserver.windowNotifications {
            AXObserverAddNotification(observer, w.element, n as CFString, refcon)
        }
        windows.insert(w)
    }

    func forget(_ w: AXWindow) {
        guard windows.remove(w) != nil else { return }
        for n in AppObserver.windowNotifications {
            AXObserverRemoveNotification(observer, w.element, n as CFString)
        }
    }

    /// Removes every notification and the run loop source.
    func invalidate() {
        for w in windows {
            for n in AppObserver.windowNotifications { AXObserverRemoveNotification(observer, w.element, n as CFString) }
        }
        windows = []
        for n in AppObserver.appNotifications { AXObserverRemoveNotification(observer, appElement, n as CFString) }
        CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
    }
}

extension CGRect {
    func approxEqual(_ o: CGRect, tolerance: CGFloat = 2) -> Bool {
        abs(minX - o.minX) <= tolerance && abs(minY - o.minY) <= tolerance
            && abs(width - o.width) <= tolerance && abs(height - o.height) <= tolerance
    }
}

/// CoreGraphics window list helpers (cheap, no AX round trips).
enum WindowList {
    struct Info {
        let id: WindowID
        let pid: pid_t
        let bounds: CGRect
    }

    /// Normal-layer windows on the current Space of every display, front to back.
    static func onScreen() -> [Info] {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]] else { return [] }
        return list.compactMap { d in
            guard (d[kCGWindowLayer as String] as? Int) == 0,
                  let id = d[kCGWindowNumber as String] as? UInt32,
                  let pid = d[kCGWindowOwnerPID as String] as? Int32,
                  let b = d[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: b) else { return nil }
            if let alpha = d[kCGWindowAlpha as String] as? Double, alpha <= 0 { return nil }
            return Info(id: id, pid: pid, bounds: bounds)
        }
    }

    /// The subset of `ids` that still exist (on any Space).
    static func existing(_ ids: [WindowID]) -> Set<WindowID> {
        guard !ids.isEmpty else { return [] }
        // The array must hold raw CGWindowID values, not CFNumbers.
        var values: [UnsafeRawPointer?] = ids.map { UnsafeRawPointer(bitPattern: UInt($0)) }
        guard let array = CFArrayCreate(nil, &values, values.count, nil),
              let list = CGWindowListCreateDescriptionFromArray(array) as? [[String: Any]] else { return [] }
        return Set(list.compactMap { $0[kCGWindowNumber as String] as? UInt32 })
    }
}
