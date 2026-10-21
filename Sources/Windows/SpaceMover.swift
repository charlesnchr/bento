import AppKit
import BentoCore

// Private, long-stable CoreGraphics Services calls (used by Amethyst, yabai,
// Rectangle Pro, …). Only read here: which Spaces exist and where a window is.
@_silgen_name("CGSMainConnectionID") private func CGSMainConnectionID() -> Int32
@_silgen_name("CGSCopyManagedDisplaySpaces") private func CGSCopyManagedDisplaySpaces(_ cid: Int32) -> CFArray?
@_silgen_name("CGSCopySpacesForWindows") private func CGSCopySpacesForWindows(_ cid: Int32, _ mask: Int32, _ wids: CFArray) -> CFArray?

/// Moves the focused window to the previous / next Space (Rectangle Pro's
/// Next/Previous Space): it holds the window by an empty part of its title
/// bar, presses Mission Control's "Move left/right a space" shortcut, and lets
/// go once the Space has switched. It refuses rather than guesses: no free
/// title-bar spot, no Space in that direction, or the Mission Control shortcut
/// turned off all end with a message, and the result is verified.
final class SpaceMover {
    private(set) var isBusy = false

    struct SpaceList {
        var ids: [Int]
        var types: [Int]
        var current: Int
    }

    func move(direction: Int) {
        guard !isBusy else { return }
        guard Permissions.accessibility else { Permissions.requestAccessibility(); return }
        guard let w = AXWindow.focused(), w.pid != getpid(), let wid = w.windowID, let frame = w.frame, !w.isFullscreen else {
            NSSound.beep()
            return
        }
        guard let key = SpaceMover.switchShortcut(direction: direction) else {
            fail("Turn on “Move \(direction < 0 ? "left" : "right") a space” in Keyboard Shortcuts › Mission Control")
            return
        }
        let screen = NSScreen.containing(axRect: frame)
        guard let spaces = SpaceMover.spaces(on: screen), let cur = spaces.ids.firstIndex(of: spaces.current) else {
            fail("Couldn't read the Spaces of this display")
            return
        }
        let target = cur + direction
        guard spaces.ids.indices.contains(target) else {
            fail(direction < 0 ? "No Space on the left" : "No Space on the right")
            return
        }
        guard spaces.types[target] == 0 else {
            fail("The next Space is a full-screen app")
            return
        }
        guard let grab = SpaceMover.grabPoint(w, frame: frame, wid: wid) else {
            fail("Can't hold this window by its title bar")
            return
        }
        isBusy = true
        let targetID = spaces.ids[target]
        waitForModifierRelease(deadline: Date().addingTimeInterval(1.5)) { [weak self] in
            self?.run(window: w, wid: wid, grab: grab, key: key, targetSpace: targetID, screen: screen)
        }
    }

    private func fail(_ message: String) {
        NSSound.beep()
        HUD.show(message, symbol: "rectangle.on.rectangle.slash")
    }

    /// The hotkey fires while its modifiers are still down; they would leak
    /// into the synthesized events, so wait until they're released.
    private func waitForModifierRelease(deadline: Date, then: @escaping () -> Void) {
        let held = CGEventSource.flagsState(.hidSystemState).intersection([.maskCommand, .maskAlternate, .maskControl, .maskShift])
        if held.isEmpty || Date() > deadline {
            then()
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) { [weak self] in
                self?.waitForModifierRelease(deadline: deadline, then: then)
            }
        }
    }

    private func run(window: AXWindow, wid: CGWindowID, grab: CGPoint, key: (CGKeyCode, CGEventFlags), targetSpace: Int, screen: NSScreen?) {
        let cursor = CGEvent(source: nil)?.location ?? grab
        SpaceMover.postMouse(.mouseMoved, grab)
        SpaceMover.postMouse(.leftMouseDown, grab)
        SpaceMover.postMouse(.leftMouseDragged, grab)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) {
            SpaceMover.postKey(key.0, flags: key.1)
            self.waitForSpace(targetSpace, screen: screen, deadline: Date().addingTimeInterval(1.5)) { switched in
                // A little extra so the window lands after the slide finishes.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                    SpaceMover.postMouse(.leftMouseUp, grab)
                    CGWarpMouseCursorPosition(cursor)
                    CGAssociateMouseAndMouseCursorPosition(1)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                        self.isBusy = false
                        if !switched || !SpaceMover.spaces(ofWindow: wid).contains(targetSpace) {
                            self.fail("Couldn't move the window to that Space")
                        } else {
                            window.focus()
                        }
                    }
                }
            }
        }
    }

    private func waitForSpace(_ id: Int, screen: NSScreen?, deadline: Date, then: @escaping (Bool) -> Void) {
        if SpaceMover.spaces(on: screen)?.current == id { then(true); return }
        if Date() > deadline { then(false); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            self?.waitForSpace(id, screen: screen, deadline: deadline, then: then)
        }
    }

    // MARK: Helpers

    /// Plain (source-less) key events: Core's `Keyboard.post` uses a suppressing
    /// event source, which Mission Control doesn't act on reliably mid-drag.
    private static func postKey(_ code: CGKeyCode, flags: CGEventFlags) {
        for down in [true, false] {
            guard let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else { continue }
            e.flags = flags
            e.post(tap: .cghidEventTap)
        }
    }

    private static func postMouse(_ type: CGEventType, _ p: CGPoint) {
        guard let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: .left) else { return }
        e.flags = []
        e.post(tap: .cghidEventTap)
    }

    /// Mission Control's "Move left a space" (79) / "Move right a space" (81).
    static func switchShortcut(direction: Int) -> (CGKeyCode, CGEventFlags)? {
        let id = direction < 0 ? "79" : "81"
        let fallback: (CGKeyCode, CGEventFlags) = (direction < 0 ? 123 : 124, [.maskControl, .maskSecondaryFn])
        guard let all = CFPreferencesCopyAppValue("AppleSymbolicHotKeys" as CFString, "com.apple.symbolichotkeys" as CFString) as? [String: Any],
              let entry = all[id] as? [String: Any] else { return fallback }
        return shortcut(fromSymbolicHotKey: entry) ?? (((entry["enabled"] as? NSNumber)?.boolValue ?? true) ? fallback : nil)
    }

    /// `{enabled, value: {parameters: [char, keyCode, modifiers]}}`; nil if disabled.
    static func shortcut(fromSymbolicHotKey entry: [String: Any]) -> (CGKeyCode, CGEventFlags)? {
        guard (entry["enabled"] as? NSNumber)?.boolValue ?? true,
              let value = entry["value"] as? [String: Any],
              let params = value["parameters"] as? [NSNumber], params.count >= 3 else { return nil }
        return (CGKeyCode(params[1].intValue), CGEventFlags(rawValue: params[2].uint64Value))
    }

    static func spaces(on screen: NSScreen?) -> SpaceList? {
        guard let displays = CGSCopyManagedDisplaySpaces(CGSMainConnectionID()) as? [[String: Any]], !displays.isEmpty else { return nil }
        let uuid = screen.flatMap { LayoutManager.uuid(of: $0) }?.lowercased()
        let display = displays.first { ($0["Display Identifier"] as? String)?.lowercased() == uuid } ?? (displays.count == 1 ? displays[0] : nil)
        guard let d = display, let list = d["Spaces"] as? [[String: Any]],
              let current = ((d["Current Space"] as? [String: Any])?["ManagedSpaceID"] as? NSNumber)?.intValue else { return nil }
        return SpaceList(ids: list.compactMap { ($0["ManagedSpaceID"] as? NSNumber)?.intValue },
                         types: list.map { ($0["type"] as? NSNumber)?.intValue ?? 0 },
                         current: current)
    }

    static func spaces(ofWindow wid: CGWindowID) -> [Int] {
        guard let list = CGSCopySpacesForWindows(CGSMainConnectionID(), 0x7, [NSNumber(value: wid)] as CFArray) as? [NSNumber] else { return [] }
        return list.map(\.intValue)
    }

    /// An empty title-bar spot: right of the zoom button, else along the top.
    /// Only accepted if this window is the top-most there and AX reports the
    /// window itself or its toolbar background (never a control).
    static func grabPoint(_ w: AXWindow, frame f: CGRect, wid: CGWindowID) -> CGPoint? {
        var y = f.minY + 12
        var xs: [CGFloat] = []
        if let zoom: AXUIElement = w.element.ax(kAXZoomButtonAttribute), let z = frame(of: zoom) {
            y = z.midY
            xs += [z.maxX + 12, z.maxX + 40]
        }
        xs += [f.minX + 100, f.midX - 120, f.midX + 120, f.maxX - 60]
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 0.3)
        for x in xs where x > f.minX + 8 && x < f.maxX - 8 {
            let p = CGPoint(x: x, y: y)
            guard topWindow(at: p) == wid else { continue }
            var el: AXUIElement?
            guard AXUIElementCopyElementAtPosition(system, Float(p.x), Float(p.y), &el) == .success, let el else { continue }
            if CFEqual(el, w.element) { return p }
            if let role: String = el.ax(kAXRoleAttribute), role == kAXToolbarRole as String { return p }
        }
        return nil
    }

    private static func frame(of el: AXUIElement) -> CGRect? {
        guard let pv: AXValue = el.ax(kAXPositionAttribute), let sv: AXValue = el.ax(kAXSizeAttribute) else { return nil }
        var p = CGPoint.zero, s = CGSize.zero
        guard AXValueGetValue(pv, .cgPoint, &p), AXValueGetValue(sv, .cgSize, &s) else { return nil }
        return CGRect(origin: p, size: s)
    }

    /// The front-most ordinary window at a point (ignores the Dock / menu bar layers).
    private static func topWindow(at p: CGPoint) -> CGWindowID? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        for d in list {
            let layer = d[kCGWindowLayer as String] as? Int ?? 0
            guard layer >= 0, layer < 20, (d[kCGWindowAlpha as String] as? Double ?? 1) > 0.01,
                  let b = d[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b), r.contains(p) else { continue }
            return (d[kCGWindowNumber as String] as? Int).map { CGWindowID($0) }
        }
        return nil
    }
}
