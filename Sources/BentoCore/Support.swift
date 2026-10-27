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

/// A non-activating panel that window management still treats as one of
/// Bento's regular windows: titled, movable and typed into, it only doesn't
/// activate Bento when clicked (the assistant kept on top).
public protocol ManagedPanel: NSWindow {}

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

    /// Shows one of Bento's windows in front; `activate` also focuses it
    /// (activates Bento and makes it key). Cancels a pending `orderOut`.
    public static func show(_ window: NSWindow, activate: Bool = true) {
        cancelOrderOut(window)
        if activate {
            activateSelf()
            window.makeKeyAndOrderFront(nil)
        }
        window.orderFrontRegardless()
    }

    /// Hides one of Bento's windows and gives focus to `app`, without another
    /// of Bento's windows surfacing on the way.
    ///
    /// Ordering out the key window while Bento is active makes AppKit key and
    /// raise the next window that can take it (the Todo window left open
    /// behind the user's app, say) until `app`'s activation lands, a visible
    /// flash. So `app` is activated first and the window ordered out once
    /// Bento has resigned active. If `app` has quit or is Bento itself, focus
    /// goes to `previousApp` instead. With `app` nil, nothing usable to hand
    /// focus to, or Bento inactive, the window is ordered out at once.
    public static func orderOut(_ window: NSWindow, activating app: NSRunningApplication?) {
        cancelOrderOut(window)
        guard NSApp.isActive, let target = focusTarget(app, previous: previousApp), target.activate(options: []) else {
            window.orderOut(nil)
            return
        }
        // Already in front, as behind a non-activating panel (the assistant
        // kept on top): activating it changes nothing and Bento never resigns,
        // so don't wait out the timeout. Bento is active in name only here, so
        // deactivating is enough; when it is really frontmost, wait as above.
        if target.isActive {
            NSApp.deactivate()
            window.orderOut(nil)
            return
        }
        orderOutOnResign(window)
    }

    /// The app `orderOut` hands focus to: `app`, or `previous` when `app` has
    /// quit or is Bento itself. Nil `app` means focus stays put.
    static func focusTarget(_ app: NSRunningApplication?, previous: NSRunningApplication?) -> NSRunningApplication? {
        guard let app else { return nil }
        let usable = { (candidate: NSRunningApplication) in !candidate.isTerminated && candidate.processIdentifier != getpid() }
        if usable(app) { return app }
        return previous.flatMap { usable($0) ? $0 : nil }
    }

    /// Whether `orderOut` is about to order the window out (it counts as hidden).
    public static func isOrderingOut(_ window: NSWindow) -> Bool {
        pendingOrderOuts[ObjectIdentifier(window)] != nil
    }

    private final class PendingOrderOut {
        var observer: NSObjectProtocol?
    }
    private static var pendingOrderOuts: [ObjectIdentifier: PendingOrderOut] = [:]

    /// Orders `window` out when Bento next resigns active, or after `timeout`
    /// if the other app's activation never lands.
    static func orderOutOnResign(_ window: NSWindow, timeout: TimeInterval = 0.5) {
        cancelOrderOut(window)
        let id = ObjectIdentifier(window)
        let pending = PendingOrderOut()
        pendingOrderOuts[id] = pending
        let finish = { [weak window] in
            guard pendingOrderOuts[id] === pending else { return }
            cancelOrderOut(id)
            window?.orderOut(nil)
        }
        pending.observer = NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification,
                                                                  object: nil, queue: nil) { _ in finish() }
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout, execute: finish)
    }

    static func cancelOrderOut(_ window: NSWindow) { cancelOrderOut(ObjectIdentifier(window)) }

    private static func cancelOrderOut(_ id: ObjectIdentifier) {
        guard let pending = pendingOrderOuts.removeValue(forKey: id) else { return }
        if let observer = pending.observer { NotificationCenter.default.removeObserver(observer) }
    }
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
