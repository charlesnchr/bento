import AppKit
import CoreGraphics

/// The window server calls the menu bar manager needs. Private CoreGraphics
/// (SkyLight) functions are looked up at runtime, so a missing symbol on some
/// macOS version degrades to the public window list instead of failing to load.
///
/// All functions are thread-safe (plain window server queries).
enum WindowServer {
    typealias ConnectionID = Int32

    private static let handle = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_LAZY)

    private static func symbol<T>(_ name: String, as: T.Type) -> T? {
        guard let handle, let sym = dlsym(handle, name) else { return nil }
        return unsafeBitCast(sym, to: T.self)
    }

    private typealias MainConnection = @convention(c) () -> ConnectionID
    private typealias WindowCount = @convention(c) (ConnectionID, ConnectionID, UnsafeMutablePointer<Int32>) -> CGError
    private typealias WindowList = @convention(c) (ConnectionID, ConnectionID, Int32, UnsafeMutablePointer<CGWindowID>, UnsafeMutablePointer<Int32>) -> CGError
    private typealias ScreenRect = @convention(c) (ConnectionID, CGWindowID, UnsafeMutablePointer<CGRect>) -> CGError
    private typealias WindowLevel = @convention(c) (ConnectionID, CGWindowID, UnsafeMutablePointer<CGWindowLevel>) -> CGError
    private typealias ImageFromArray = @convention(c) (CGRect, CFArray, CGWindowImageOption) -> Unmanaged<CGImage>?

    private static let mainConnection = symbol("CGSMainConnectionID", as: MainConnection.self)
    private static let windowCount = symbol("CGSGetWindowCount", as: WindowCount.self)
    private static let menuBarWindowList = symbol("CGSGetProcessMenuBarWindowList", as: WindowList.self)
    private static let screenRect = symbol("CGSGetScreenRectForWindow", as: ScreenRect.self)
    private static let windowLevel = symbol("CGSGetWindowLevel", as: WindowLevel.self)
    // Obsoleted in the macOS 15 SDK, still the only way to capture items that
    // are parked off-screen (ScreenCaptureKit refuses those windows).
    private static let imageFromArray = symbol("CGWindowListCreateImageFromArray", as: ImageFromArray.self)

    static let statusLevel = CGWindowLevel(CGWindowLevelForKey(.statusWindow))

    /// Whether the private item list is available (diagnostics).
    static var usesPrivateList: Bool { mainConnection != nil && windowCount != nil && menuBarWindowList != nil }

    struct WindowInfo: Equatable {
        var id: CGWindowID
        var frame: CGRect
        var name: String
        var ownerPID: pid_t
        var ownerName: String
        var isOnScreen: Bool
    }

    /// Status item windows on every display, right to left as the window
    /// server lists them. Includes parked (off-screen) items.
    static func menuBarItemWindows() -> [WindowInfo] {
        if let ids = privateMenuBarWindowIDs() {
            return describe(ids)
        }
        return publicMenuBarItemWindows()
    }

    private static func privateMenuBarWindowIDs() -> [CGWindowID]? {
        guard let mainConnection, let windowCount, let menuBarWindowList else { return nil }
        let cid = mainConnection()
        var count: Int32 = 0
        guard windowCount(cid, 0, &count) == .success else { return nil }
        var ids = [CGWindowID](repeating: 0, count: Int(max(count, 0)) + 64)
        var out: Int32 = 0
        guard menuBarWindowList(cid, 0, Int32(ids.count), &ids, &out) == .success else { return nil }
        let list = Array(ids.prefix(Int(max(0, min(out, Int32(ids.count))))))
        // macOS 26 lists the menu bar window itself too (main menu level).
        guard let windowLevel else { return list }
        return list.filter { wid in
            var level: CGWindowLevel = 0
            return windowLevel(cid, wid, &level) != .success || level == statusLevel
        }
    }

    private static func describe(_ ids: [CGWindowID]) -> [WindowInfo] {
        guard !ids.isEmpty else { return [] }
        var values: [UnsafeRawPointer?] = ids.map { UnsafeRawPointer(bitPattern: UInt($0)) }
        guard let array = CFArrayCreate(nil, &values, values.count, nil),
              let descriptions = CGWindowListCreateDescriptionFromArray(array) as? [[String: Any]] else { return [] }
        var byID: [CGWindowID: [String: Any]] = [:]
        for d in descriptions {
            if let n = d[kCGWindowNumber as String] as? NSNumber { byID[n.uint32Value] = d }
        }
        return ids.compactMap { id in
            guard let d = byID[id] else { return nil }
            var info = windowInfo(d)
            if let live = frame(of: id) { info.frame = live }
            return info
        }
    }

    private static func publicMenuBarItemWindows() -> [WindowInfo] {
        guard let all = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else { return [] }
        // CGDisplay, not NSScreen: this runs off the main thread too.
        var count: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &count)
        var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
        CGGetActiveDisplayList(count, &displays, &count)
        let tops = Set(displays.map { CGDisplayBounds($0).minY })
        return all.compactMap { d -> WindowInfo? in
            guard (d[kCGWindowLayer as String] as? Int) == Int(statusLevel) else { return nil }
            let info = windowInfo(d)
            // Status items sit at the top of a display and are menu bar high
            // (other status-level windows, e.g. Karabiner's, don't).
            guard tops.contains(info.frame.minY), info.frame.height > 10, info.frame.height < 60 else { return nil }
            return info
        }
    }

    private static func windowInfo(_ d: [String: Any]) -> WindowInfo {
        var frame = CGRect.zero
        if let b = d[kCGWindowBounds as String] as? NSDictionary as CFDictionary? { CGRectMakeWithDictionaryRepresentation(b, &frame) }
        return WindowInfo(id: (d[kCGWindowNumber as String] as? NSNumber)?.uint32Value ?? 0,
                          frame: frame,
                          name: d[kCGWindowName as String] as? String ?? "",
                          ownerPID: (d[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0,
                          ownerName: d[kCGWindowOwnerName as String] as? String ?? "",
                          isOnScreen: (d[kCGWindowIsOnscreen as String] as? Bool) ?? false)
    }

    /// The live frame of a window (global, top-left origin).
    static func frame(of id: CGWindowID) -> CGRect? {
        if let mainConnection, let screenRect {
            var r = CGRect.zero
            if screenRect(mainConnection(), id, &r) == .success { return r }
        }
        var values: [UnsafeRawPointer?] = [UnsafeRawPointer(bitPattern: UInt(id))]
        guard let array = CFArrayCreate(nil, &values, 1, nil),
              let d = (CGWindowListCreateDescriptionFromArray(array) as? [[String: Any]])?.first else { return nil }
        return windowInfo(d).frame
    }

    /// Read-only display geometry used to reject off-screen activation.
    static func onScreen(_ frame: CGRect) -> Bool {
        var count: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &count)
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        CGGetActiveDisplayList(count, &ids, &count)
        return MenuBarLayout.isOnDisplay(frame, displays: ids.map { CGDisplayBounds($0) })
    }

    // MARK: Images

    /// Whether item images can be captured (the symbol exists and Screen Recording is granted).
    static var canCaptureImages: Bool { imageFromArray != nil && CGPreflightScreenCaptureAccess() }

    /// An image of one status item window, wherever it is (also parked
    /// off-screen: with a null rect the window server renders the window's
    /// own backing store, where an explicit off-screen rect comes back empty).
    /// The window's size is checked first: a degenerate or huge capture can
    /// take the window server down.
    static func image(of id: CGWindowID, frame: CGRect) -> CGImage? {
        guard let imageFromArray, isSafeCaptureRect(frame) else { return nil }
        var values: [UnsafeRawPointer?] = [UnsafeRawPointer(bitPattern: UInt(id))]
        guard let array = CFArrayCreate(nil, &values, 1, nil) else { return nil }
        guard let image = imageFromArray(.null, array, [.boundsIgnoreFraming, .bestResolution])?.takeRetainedValue(),
              image.width > 1, image.height > 1, image.width <= 4_000, image.height <= 400 else { return nil }
        return image
    }

    static func isSafeCaptureRect(_ r: CGRect) -> Bool {
        r.origin.x.isFinite && r.origin.y.isFinite && r.width.isFinite && r.height.isFinite
            && r.width >= 1 && r.height >= 1 && r.width <= 2_000 && r.height <= 200
            && abs(r.minX) < 100_000 && abs(r.minY) < 100_000
    }
}
