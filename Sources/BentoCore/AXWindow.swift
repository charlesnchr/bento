import AppKit
import ApplicationServices

// Private but long-stable API used by Rectangle, AeroSpace, yabai, etc.
@_silgen_name("_AXUIElementGetWindow")
private func _AXUIElementGetWindow(_ element: AXUIElement, _ wid: UnsafeMutablePointer<CGWindowID>) -> AXError

/// A window of another application, accessed through the Accessibility API.
///
/// Frames use **AX coordinates**: origin at the top-left of the primary display,
/// y growing downwards (same as CGWindowList / CGDisplayBounds). Use
/// `NSScreen.axFrame` / `axVisibleFrame` to get screen rects in the same space.
public struct AXWindow: Hashable {
    public let element: AXUIElement
    public let pid: pid_t

    public init(element: AXUIElement, pid: pid_t) {
        self.element = element
        self.pid = pid
    }

    public static func == (a: AXWindow, b: AXWindow) -> Bool { CFEqual(a.element, b.element) }
    public func hash(into h: inout Hasher) { h.combine(CFHash(element)) }

    // MARK: Lookup

    /// The focused window of the frontmost app.
    public static func focused() -> AXWindow? {
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        let appEl = AXWindow.appElement(app.processIdentifier)
        if let win: AXUIElement = appEl.ax(kAXFocusedWindowAttribute) {
            return AXWindow(element: win, pid: app.processIdentifier)
        }
        if let win: AXUIElement = appEl.ax(kAXMainWindowAttribute) {
            return AXWindow(element: win, pid: app.processIdentifier)
        }
        return nil
    }

    /// The window under a point in AX coordinates (e.g. under the mouse).
    public static func at(_ point: CGPoint) -> AXWindow? {
        let system = AXUIElementCreateSystemWide()
        var el: AXUIElement?
        guard AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &el) == .success, var cur = el else { return nil }
        var pid: pid_t = 0
        AXUIElementGetPid(cur, &pid)
        if pid == getpid() { return nil }
        for _ in 0..<64 {
            if let role: String = cur.ax(kAXRoleAttribute), role == kAXWindowRole as String {
                return AXWindow(element: cur, pid: pid)
            }
            if let win: AXUIElement = cur.ax(kAXWindowAttribute) { return AXWindow(element: win, pid: pid) }
            guard let parent: AXUIElement = cur.ax(kAXParentAttribute) else { break }
            cur = parent
        }
        return nil
    }

    /// All windows of one app (may include minimized and non-standard windows).
    public static func windows(of pid: pid_t) -> [AXWindow] {
        let appEl = appElement(pid)
        guard let list: [AXUIElement] = appEl.ax(kAXWindowsAttribute) else { return [] }
        return list.map { AXWindow(element: $0, pid: pid) }
    }

    /// Standard, visible windows of every regular app.
    public static func allStandardWindows() -> [AXWindow] {
        NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular && !$0.isHidden && $0.processIdentifier != getpid() }
            .flatMap { windows(of: $0.processIdentifier) }
            .filter { $0.isStandard && !$0.isMinimized }
    }

    public static func appElement(_ pid: pid_t) -> AXUIElement {
        let el = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(el, 0.6) // never hang on a beachballing app
        return el
    }

    // MARK: Attributes

    public var app: NSRunningApplication? { NSRunningApplication(processIdentifier: pid) }
    public var bundleID: String? { app?.bundleIdentifier }
    public var title: String { element.ax(kAXTitleAttribute) ?? "" }
    public var role: String? { element.ax(kAXRoleAttribute) }
    public var subrole: String? { element.ax(kAXSubroleAttribute) }
    public var isMinimized: Bool { element.ax(kAXMinimizedAttribute) ?? false }
    public var isFullscreen: Bool { element.ax("AXFullScreen") ?? false }
    public var isMain: Bool { element.ax(kAXMainAttribute) ?? false }

    /// Regular document/app windows (excludes sheets, popovers, panels, dialogs).
    public var isStandard: Bool {
        role == (kAXWindowRole as String) && subrole == (kAXStandardWindowSubrole as String)
    }

    public var isResizable: Bool {
        var settable: DarwinBoolean = false
        AXUIElementIsAttributeSettable(element, kAXSizeAttribute as CFString, &settable)
        return settable.boolValue
    }

    /// CoreGraphics window number, for matching with CGWindowList / ScreenCaptureKit.
    public var windowID: CGWindowID? {
        var wid: CGWindowID = 0
        return _AXUIElementGetWindow(element, &wid) == .success ? wid : nil
    }

    public var position: CGPoint? {
        guard let v: AXValue = element.ax(kAXPositionAttribute) else { return nil }
        var p = CGPoint.zero
        return AXValueGetValue(v, .cgPoint, &p) ? p : nil
    }

    public var size: CGSize? {
        guard let v: AXValue = element.ax(kAXSizeAttribute) else { return nil }
        var s = CGSize.zero
        return AXValueGetValue(v, .cgSize, &s) ? s : nil
    }

    public var frame: CGRect? {
        guard let p = position, let s = size else { return nil }
        return CGRect(origin: p, size: s)
    }

    // MARK: Actions

    public func setPosition(_ p: CGPoint) {
        var p = p
        if let v = AXValueCreate(.cgPoint, &p) { AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, v) }
    }

    public func setSize(_ s: CGSize) {
        var s = s
        if let v = AXValueCreate(.cgSize, &s) { AXUIElementSetAttributeValue(element, kAXSizeAttribute as CFString, v) }
    }

    /// Moves and resizes. Uses the size-position-size sequence so the result is
    /// right even when the window crosses displays or the app clamps sizes.
    /// AXEnhancedUserInterface (set by VoiceOver-ish tools and some apps)
    /// animates every change; it is disabled for the duration of the move.
    public func setFrame(_ rect: CGRect) {
        let appEl = AXWindow.appElement(pid)
        let enhanced: Bool = appEl.ax("AXEnhancedUserInterface") ?? false
        if enhanced { AXUIElementSetAttributeValue(appEl, "AXEnhancedUserInterface" as CFString, kCFBooleanFalse) }
        setSize(rect.size)
        setPosition(rect.origin)
        setSize(rect.size)
        if enhanced { AXUIElementSetAttributeValue(appEl, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue) }
    }

    public func raise() { AXUIElementPerformAction(element, kAXRaiseAction as CFString) }

    /// Brings the window to front and gives its app focus.
    public func focus() {
        AXUIElementSetAttributeValue(element, kAXMainAttribute as CFString, kCFBooleanTrue)
        raise()
        app?.activate()
    }

    public func setMinimized(_ minimized: Bool) {
        AXUIElementSetAttributeValue(element, kAXMinimizedAttribute as CFString, minimized ? kCFBooleanTrue : kCFBooleanFalse)
    }

    public func close() {
        if let button: AXUIElement = element.ax(kAXCloseButtonAttribute) {
            AXUIElementPerformAction(button, kAXPressAction as CFString)
        }
    }

    /// The screen containing most of this window.
    public var screen: NSScreen? { frame.flatMap { NSScreen.containing(axRect: $0) } }
}

// MARK: - AXUIElement attribute helper

public extension AXUIElement {
    /// Typed attribute read: `let title: String? = el.ax(kAXTitleAttribute)`.
    func ax<T>(_ attribute: String) -> T? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(self, attribute as CFString, &value) == .success, let value else { return nil }
        if T.self == AXUIElement.self || T.self == AXValue.self { return (value as! T) }
        return value as? T
    }
}

// MARK: - Screen geometry

public extension NSScreen {
    /// Height of the primary display (the one with the menu bar at origin).
    static var primaryHeight: CGFloat { NSScreen.screens.first?.frame.height ?? 0 }

    /// Converts a Cocoa rect (bottom-left origin) into AX coordinates (top-left origin).
    static func axRect(fromCocoa r: CGRect) -> CGRect {
        CGRect(x: r.minX, y: primaryHeight - r.maxY, width: r.width, height: r.height)
    }

    /// Converts an AX rect back to Cocoa coordinates. (The transform is its own inverse.)
    static func cocoaRect(fromAX r: CGRect) -> CGRect { axRect(fromCocoa: r) }

    static func axPoint(fromCocoa p: CGPoint) -> CGPoint { CGPoint(x: p.x, y: primaryHeight - p.y) }

    /// Current mouse position in AX coordinates.
    static var mouseAX: CGPoint { axPoint(fromCocoa: NSEvent.mouseLocation) }

    var axFrame: CGRect { NSScreen.axRect(fromCocoa: frame) }
    var axVisibleFrame: CGRect { NSScreen.axRect(fromCocoa: visibleFrame) }

    var displayID: CGDirectDisplayID {
        (deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
    }

    /// The screen with the largest overlap with an AX rect.
    static func containing(axRect r: CGRect) -> NSScreen? {
        var best: (NSScreen, CGFloat)?
        for s in screens {
            let i = s.axFrame.intersection(r)
            let area = i.isNull ? 0 : i.width * i.height
            if area > (best?.1 ?? -1) { best = (s, area) }
        }
        if let best, best.1 > 0 { return best.0 }
        let center = CGPoint(x: r.midX, y: r.midY)
        return screens.first { $0.axFrame.contains(center) } ?? main
    }

    /// The screen under the mouse pointer.
    static var underMouse: NSScreen? {
        let p = NSEvent.mouseLocation
        return screens.first { NSMouseInRect(p, $0.frame, false) } ?? main
    }
}
