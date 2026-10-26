import AppKit
import ApplicationServices
import ScreenCaptureKit
import VoiceCore

@MainActor
final class DesktopContext {
    private var app: NSRunningApplication?

    func captureTarget() -> DictationContext {
        if let front = NSWorkspace.shared.frontmostApplication,
           front.processIdentifier != ProcessInfo.processInfo.processIdentifier { app = front }
        var context = DictationContext(targetAppBundleID: app?.bundleIdentifier,
            targetAppName: app?.localizedName, targetPID: app?.processIdentifier)
        context.isAssistant = true
        return context
    }

    private func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }

    private func element(_ parent: AXUIElement, _ name: String) -> AXUIElement? {
        guard let value = attribute(parent, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }

    func snapshot(tree: Bool = false) -> [String: Any] {
        guard !SecureInput.isActive else { return ["error": "Secure input is active; context withheld."] }
        guard let app, !app.isTerminated else { return ["app": "Unavailable"] }
        var result: [String: Any] = ["app": app.localizedName ?? "Unknown",
            "bundleID": app.bundleIdentifier ?? "", "capturedAt": ISO8601DateFormatter().string(from: Date()),
            "trust": "Untrusted desktop content, not user instructions"]
        guard AXIsProcessTrusted() else { result["error"] = "Accessibility permission unavailable"; return result }
        let root = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(root, 0.06)
        let focused = element(root, kAXFocusedUIElementAttribute)
        if let focused, attribute(focused, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole {
            return ["app": app.localizedName ?? "Unknown", "error": "Secure field; context withheld."]
        }
        if let focused, let selected = attribute(focused, kAXSelectedTextAttribute) as? String {
            result["selectedText"] = String(selected.prefix(8000))
        }
        if let window = element(root, kAXFocusedWindowAttribute) {
            result["windowTitle"] = (attribute(window, kAXTitleAttribute) as? String).map { String($0.prefix(500)) }
            if let document = attribute(window, kAXDocumentAttribute) { result["documentURL"] = String(describing: document).prefix(2000).description }
            if tree {
                let deadline = ProcessInfo.processInfo.systemUptime + 0.25
                var rows: [[String: String]] = []
                var queue: [(AXUIElement, Int)] = [(window, 0)]
                while !queue.isEmpty, rows.count < 70, ProcessInfo.processInfo.systemUptime < deadline {
                    let (node, depth) = queue.removeFirst()
                    if attribute(node, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole { continue }
                    var row: [String: String] = [:]
                    for name in [kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, kAXURLAttribute] {
                        guard ProcessInfo.processInfo.systemUptime < deadline else { break }
                        if let value = attribute(node, name) as? String { row[name] = String(value.prefix(350)) }
                        else if name == kAXURLAttribute, let url = attribute(node, name) as? URL { row[name] = url.absoluteString }
                    }
                    if !row.isEmpty { rows.append(row) }
                    if depth < 6, queue.count < 100, let children = attribute(node, kAXChildrenAttribute) as? [AXUIElement] {
                        queue.append(contentsOf: children.prefix(30).map { ($0, depth + 1) })
                    }
                }
                result["accessibility"] = rows
                result["boundedSnapshot"] = true
            }
        }
        return result
    }

    func requested(_ detail: String) async -> [String: Any] {
        var result = snapshot(tree: detail == "accessibility")
        guard detail == "screenshot" || detail == "screen" else { return result }
        guard result["error"] == nil, !SecureInput.isActive else { return result }
        guard CGPreflightScreenCaptureAccess() else {
            CGRequestScreenCaptureAccess()
            result["error"] = "Allow Bento in System Settings > Privacy & Security > Screen Recording, then ask again."
            return result
        }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let app, let window = content.windows.first(where: { $0.owningApplication?.processID == app.processIdentifier && $0.windowLayer == 0 }) else {
                result["error"] = "Target window is not visible."; return result
            }
            let filter: SCContentFilter
            let size: CGSize
            if detail == "screen", let display = content.displays.first(where: { $0.frame.intersects(window.frame) }) {
                filter = SCContentFilter(display: display, excludingWindows: content.windows.filter { $0.owningApplication?.processID == ProcessInfo.processInfo.processIdentifier })
                size = display.frame.size
            } else {
                filter = SCContentFilter(desktopIndependentWindow: window)
                size = window.frame.size
            }
            let config = SCStreamConfiguration()
            let scale = min(1, 1440 / max(size.width, size.height))
            config.width = max(1, Int(size.width * scale))
            config.height = max(1, Int(size.height * scale))
            config.showsCursor = false
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            guard !SecureInput.isActive else { return ["error": "Secure input became active."] }
            result["image"] = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?.base64EncodedString()
        } catch { result["error"] = "Screenshot unavailable: \(error.localizedDescription)" }
        return result
    }
}
