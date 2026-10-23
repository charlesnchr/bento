import AppKit
import ApplicationServices
import os

// MARK: - Paths

public enum AppPaths {
    /// Set `BENTO_HOME=/some/dir` to keep config and data out of the real
    /// locations (dev harnesses default to `/tmp/bento-dev/<module>`).
    static let home: URL? = ProcessInfo.processInfo.environment["BENTO_HOME"].map { URL(fileURLWithPath: $0, isDirectory: true) }

    /// `~/.config/bento` — the human-editable config lives here.
    public static let configDir: URL = {
        let url = home?.appendingPathComponent("config", isDirectory: true)
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/bento", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    /// `~/Library/Application Support/Bento` — databases, screenshots, caches.
    public static let supportDir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let url = home?.appendingPathComponent("support", isDirectory: true) ?? base.appendingPathComponent("Bento", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    /// A subdirectory of `supportDir`, created on demand.
    public static func support(_ name: String) -> URL {
        let url = supportDir.appendingPathComponent(name, isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}

// MARK: - Logging

public enum BentoLog {
    public static let subsystem = "com.charles.bento"
    public static let core = Logger(subsystem: subsystem, category: "core")
    public static func make(_ category: String) -> Logger { Logger(subsystem: subsystem, category: category) }
}

// MARK: - Permissions

public enum Permissions {
    public static var accessibility: Bool { AXIsProcessTrusted() }

    /// Shows the system Accessibility prompt if not yet trusted.
    @discardableResult
    public static func requestAccessibility() -> Bool {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        return AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
    }

    public static var screenRecording: Bool { CGPreflightScreenCaptureAccess() }

    @discardableResult
    public static func requestScreenRecording() -> Bool { CGRequestScreenCaptureAccess() }

    public enum Pane: String {
        case accessibility = "Privacy_Accessibility"
        case screenRecording = "Privacy_ScreenCapture"
        case inputMonitoring = "Privacy_ListenEvent"
        case automation = "Privacy_Automation"
    }

    public static func open(_ pane: Pane) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane.rawValue)") {
            NSWorkspace.shared.open(url)
        }
    }

    /// Asks for the permission, then gets the user to its switch. The request is what
    /// adds Bento to the System Settings list, but the entry lands a moment later and an
    /// open pane never reloads its list: opening the pane in the same instant leaves
    /// Bento missing from it. The request's own prompt (shown once per app) opens the
    /// pane after the entry exists, but it's an ordinary window that appears behind
    /// everything else, so bring it forward. Without a prompt Bento was asked before
    /// and is already listed: open the pane.
    public static func grant(_ pane: Pane) {
        switch pane {
        case .accessibility: requestAccessibility()
        case .screenRecording: requestScreenRecording()
        default: open(pane); return
        }
        waitForPrompt(tries: 12) { prompt in
            if let prompt {
                NSApp.yieldActivation(to: prompt)
                prompt.activate()
            } else {
                open(pane)
            }
        }
    }

    private static func waitForPrompt(tries: Int, _ done: @escaping (NSRunningApplication?) -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            if let prompt = visiblePrompt() { done(prompt) }
            else if tries > 1 { waitForPrompt(tries: tries - 1, done) }
            else { done(nil) }
        }
    }

    /// The system's permission prompt, if it's on screen.
    private static func visiblePrompt() -> NSRunningApplication? {
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.accessibility.universalAccessAuthWarn").first,
              let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
        else { return nil }
        let pid = app.processIdentifier
        return windows.contains { ($0[kCGWindowOwnerPID as String] as? pid_t) == pid } ? app : nil
    }
}

// MARK: - Keyboard synthesis

public enum Keyboard {
    /// Posts a key press (down + up) to the frontmost app. Needs Accessibility.
    public static func post(keyCode: CGKeyCode, flags: CGEventFlags = []) {
        let src = CGEventSource(stateID: .combinedSessionState)
        // Avoid inheriting physically-held modifiers (e.g. the hotkey's own).
        src?.setLocalEventsFilterDuringSuppressionState([.permitLocalMouseEvents, .permitSystemDefinedEvents],
                                                         state: .eventSuppressionStateSuppressionInterval)
        let down = CGEvent(keyboardEventSource: src, virtualKey: keyCode, keyDown: true)
        let up = CGEvent(keyboardEventSource: src, virtualKey: keyCode, keyDown: false)
        down?.flags = flags
        up?.flags = flags
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
    }

    /// Simulates ⌘V in the frontmost app.
    public static func paste() { post(keyCode: 9, flags: .maskCommand) }

    /// Simulates ⌘C in the frontmost app.
    public static func copy() { post(keyCode: 8, flags: .maskCommand) }
}

// MARK: - Panels

/// Borderless/nonactivating panels normally refuse key status; this one accepts
/// it so text fields and key handling work in floating UIs.
open class KeyablePanel: NSPanel {
    open override var canBecomeKey: Bool { true }
    open override var canBecomeMain: Bool { true }
}

// MARK: - App activation helpers

public enum AppActivation {
    /// Activates Bento itself (needed before showing windows from an accessory app).
    /// Accessory apps launched in the background are not allowed to take focus
    /// cooperatively, so this uses the forceful variant; callers should also
    /// `orderFrontRegardless()` the window they show.
    public static func activateSelf() {
        NSApp.activate(ignoringOtherApps: true)
    }

    /// The app that was frontmost before Bento took focus. Updated by the shell.
    public static var previousApp: NSRunningApplication?
}

// MARK: - Dock presence

/// Bento is a menu-bar (accessory) app. Document-like windows (screenshot
/// editor, settings) retain Dock presence so they show up in ⌘-Tab and the
/// Dock while open; the icon disappears again when the last one closes.
public enum DockPresence {
    private static var count = 0

    /// Outstanding retains (diagnostics).
    public static var retainCount: Int { count }

    public static func retain() {
        count += 1
        if count == 1 { NSApp.setActivationPolicy(.regular) }
    }

    public static func release() {
        guard count > 0 else {
            BentoLog.core.error("DockPresence.release() without matching retain()")
            return
        }
        count -= 1
        guard count == 0 else { return }
        // Defer so a window closing and another opening doesn't flicker the icon.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            if count == 0 { NSApp.setActivationPolicy(.accessory) }
        }
    }
}

// MARK: - Misc

public extension NSImage {
    /// PNG data for an image (via its best CGImage representation).
    var pngData: Data? {
        guard let cg = cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
        return NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:])
    }
}

public extension CGImage {
    var pngData: Data? { NSBitmapImageRep(cgImage: self).representation(using: .png, properties: [:]) }
}

public extension Comparable {
    func clamped(_ range: ClosedRange<Self>) -> Self { min(max(self, range.lowerBound), range.upperBound) }
}
