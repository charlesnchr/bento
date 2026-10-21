import AppKit
import ApplicationServices
import os

// MARK: - Paths

public enum AppPaths {
    /// `~/.config/bento` — the human-editable config lives here.
    public static let configDir: URL = {
        let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/bento", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    /// `~/Library/Application Support/Bento` — databases, screenshots, caches.
    public static let supportDir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let url = base.appendingPathComponent("Bento", isDirectory: true)
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
    public static func activateSelf() {
        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    /// The app that was frontmost before Bento took focus. Updated by the shell.
    public static var previousApp: NSRunningApplication?
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
