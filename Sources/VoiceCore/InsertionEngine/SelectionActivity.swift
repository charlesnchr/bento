import AppKit
import ApplicationServices

/// Short-lived guard for insertion. AX node replacement alone is not user input.
@MainActor
final class SelectionActivity {
    private let pid: pid_t?
    private let window: AXUIElement?
    private var interrupted = false
    private var monitor: Any?
    private var localMonitor: Any?

    init(targetPID: pid_t?) {
        pid = targetPID
        window = Self.focusedWindow(targetPID)
        let mask: NSEvent.EventTypeMask = [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel]
        monitor = NSEvent.addGlobalMonitorForEvents(matching: mask) { [weak self] event in
            guard event.cgEvent?.getIntegerValueField(.eventSourceUserData) != SyntheticEventTag.magic else { return }
            self?.interrupted = true
        }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: mask) { [weak self] event in
            if event.cgEvent?.getIntegerValueField(.eventSourceUserData) != SyntheticEventTag.magic { self?.interrupted = true }
            return event
        }
    }

    var valid: Bool {
        guard !interrupted, !Task.isCancelled, monitor != nil, !SecureInput.isActive, let pid,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return false }
        if let window {
            guard let current = Self.focusedWindow(pid), CFEqual(window, current) else { return false }
        }
        return true
    }

    func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
        monitor = nil
        localMonitor = nil
    }

    private static func focusedWindow(_ pid: pid_t?) -> AXUIElement? {
        guard let pid else { return nil }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.2)
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &ref) == .success,
              let ref, CFGetTypeID(ref) == AXUIElementGetTypeID() else { return nil }
        return unsafeDowncast(ref as AnyObject, to: AXUIElement.self)
    }
}
