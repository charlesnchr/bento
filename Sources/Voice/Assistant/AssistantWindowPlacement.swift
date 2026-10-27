import AppKit

/// Owns the assistant's frame independently of its hide/show lifecycle.
///
/// The frame is the user's: it changes only when they move or resize the
/// window. It is remembered per display arrangement, so docking to the desk's
/// monitor brings back the frame used there, and fitting the window onto a
/// smaller screen meanwhile doesn't overwrite it.
@MainActor
final class AssistantWindowPlacement {
    private let window: NSWindow
    private let defaults: UserDefaults
    private let key: String
    private var placed = false
    /// Set while this class moves the window, so only the user's moves are saved.
    private var adjusting = false
    /// The frame this class last gave the window (fitted to a screen, widened
    /// for the conversation list). Until the user moves or resizes the window
    /// away from it there is nothing of theirs to save, even on hide or quit.
    private var adjusted: NSRect?
    /// The display arrangement the saved frames were last read or written for.
    /// A move under a different one is macOS relocating the window for a
    /// display that slept or went away, not the user.
    private var arrangement = ""
    /// The smallest size the user can resize the window to. Not the window's
    /// minSize: the SwiftUI hosting view resets that to zero on every layout.
    private var minSize = AssistantWindowPlacement.minimumSize(sidebar: false)
    /// The conversation list is showing, so the window needs room for it too.
    /// Showing it widens a narrower window; hiding it again gives the window
    /// back the frame the user saved.
    var sidebar = false {
        didSet {
            guard sidebar != oldValue else { return }
            if !sidebar, placed, let saved = Self.savedFrame(in: defaults.dictionary(forKey: key) ?? [:], for: NSScreen.screens.map(\.frame)),
               let frame = Self.constrainedFrame(saved, visibleFrames: NSScreen.screens.map(\.visibleFrame)) {
                set(frame)
            }
            constrainToScreens()
        }
    }

    init(window: NSWindow, key: String = "assistantWindowFrames", defaults: UserDefaults = .standard) {
        self.window = window
        self.key = key
        self.defaults = defaults
    }

    func prepareToShow() {
        let screens = NSScreen.screens.map(\.visibleFrame)
        if !placed {
            arrangement = Self.signature(NSScreen.screens.map(\.frame))
            let saved = Self.savedFrame(in: defaults.dictionary(forKey: key) ?? [:], for: NSScreen.screens.map(\.frame))
            if let saved, let frame = Self.constrainedFrame(saved, visibleFrames: screens) {
                set(frame)
            } else if let screen = NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) }) ?? NSScreen.screens.first {
                let bounds = screen.visibleFrame
                set(NSRect(x: bounds.maxX - window.frame.width - 24, y: bounds.midY - window.frame.height / 2,
                           width: window.frame.width, height: window.frame.height))
            }
            placed = true
        }
        constrainToScreens()
    }

    /// Records the current frame for the current display arrangement: any move
    /// or resize (a drag, a window-management shortcut), except this class's
    /// own and the ones macOS makes when the displays change.
    func save() {
        guard placed, !adjusting, window.frame != adjusted else { return }
        let current = Self.signature(NSScreen.screens.map(\.frame))
        guard current == arrangement else { return }
        adjusted = nil
        var frames = defaults.dictionary(forKey: key) ?? [:]
        let value = NSStringFromRect(window.frame)
        frames[current] = value
        frames["last"] = value
        defaults.set(frames, forKey: key)
    }

    /// Keeps the window on the current screens (after a display goes away)
    /// without forgetting where the user had put it. Showing the conversation
    /// list widens a narrower window to fit it, shifting left to stay on screen.
    func constrainToScreens() {
        let minimum = Self.minimumSize(sidebar: sidebar)
        guard placed, let frame = Self.constrainedFrame(window.frame, minimum: minimum,
                                                        visibleFrames: NSScreen.screens.map(\.visibleFrame)) else { return }
        // A smaller replacement screen takes precedence over the normal resize minimum.
        minSize = NSSize(width: min(minimum.width, frame.width), height: min(minimum.height, frame.height))
        if window.frame != frame { set(frame) }
    }

    /// The size a user's resize to `proposed` gets (the window delegate's windowWillResize).
    func resizing(to proposed: NSSize) -> NSSize {
        NSSize(width: max(proposed.width, minSize.width), height: max(proposed.height, minSize.height))
    }

    /// Screen parameters changed (a display came or went, slept or woke, the
    /// Dock moved). For a new arrangement, use the frame remembered for it;
    /// otherwise only keep the window on screen.
    func screensChanged() {
        guard placed else { return }
        let current = Self.signature(NSScreen.screens.map(\.frame))
        if current != arrangement {
            arrangement = current
            let frames = defaults.dictionary(forKey: key) ?? [:]
            if let saved = (frames[current] as? String).map(NSRectFromString),
               let frame = Self.constrainedFrame(saved, visibleFrames: NSScreen.screens.map(\.visibleFrame)) {
                set(frame)
            }
        }
        constrainToScreens()
    }

    private func set(_ frame: NSRect) {
        adjusting = true
        window.setFrame(frame, display: window.isVisible)
        adjusted = window.frame
        adjusting = false
    }

    /// The frame saved for this arrangement, else the last one saved anywhere.
    nonisolated static func savedFrame(in frames: [String: Any], for screens: [NSRect]) -> NSRect? {
        let value = frames[signature(screens)] as? String ?? frames["last"] as? String
        return value.map(NSRectFromString).flatMap { valid($0) ? $0 : nil }
    }

    /// Identifies a display arrangement by its screens' frames (not the visible
    /// frames, which change with the Dock and menu bar).
    nonisolated static func signature(_ screens: [NSRect]) -> String {
        screens.map { "\(Int($0.minX)),\(Int($0.minY)),\(Int($0.width)),\(Int($0.height))" }.sorted().joined(separator: ";")
    }

    /// The conversation needs 370 wide; the conversation list takes another 220 when shown.
    nonisolated static func minimumSize(sidebar: Bool) -> NSSize {
        NSSize(width: sidebar ? 610 : 370, height: 420)
    }

    nonisolated static func constrainedFrame(_ proposed: NSRect, minimum: NSSize = minimumSize(sidebar: false),
                                             visibleFrames: [NSRect]) -> NSRect? {
        let screens = visibleFrames.filter { valid($0) }
        guard let fallback = screens.first else { return nil }
        let frame = valid(proposed) ? proposed : NSRect(origin: fallback.origin, size: NSSize(width: 650, height: 650))
        // Prefer the display containing most of the window, not the bounding box
        // of all displays, which can include gaps and disconnected coordinates.
        let target = screens.max { a, b in
            area(frame.intersection(a)) < area(frame.intersection(b))
        }.flatMap { area(frame.intersection($0)) > 0 ? $0 : nil } ?? fallback
        let size = NSSize(width: min(max(frame.width, minimum.width), target.width),
                          height: min(max(frame.height, minimum.height), target.height))
        return NSRect(x: min(max(frame.minX, target.minX), target.maxX - size.width),
                      y: min(max(frame.minY, target.minY), target.maxY - size.height),
                      width: size.width, height: size.height)
    }

    nonisolated private static func valid(_ frame: NSRect) -> Bool {
        [frame.origin.x, frame.origin.y, frame.width, frame.height, frame.maxX, frame.maxY].allSatisfy(\.isFinite)
            && frame.width > 0 && frame.height > 0
    }

    nonisolated private static func area(_ frame: NSRect) -> CGFloat {
        frame.isNull ? 0 : frame.width * frame.height
    }
}
