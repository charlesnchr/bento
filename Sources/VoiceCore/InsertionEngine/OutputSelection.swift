import AppKit
import ApplicationServices

@MainActor
public enum OutputSelection {
    public struct Snapshot {
        let element: AXUIElement
        let value: String
        let range: CFRange

        public init(element: AXUIElement, value: String, range: CFRange) {
            self.element = element
            self.value = value
            self.range = range
        }
    }

    public static func capture(targetPID: pid_t?, diagnose: Bool = false) -> Snapshot? {
        func report(_ status: String) {
            if diagnose { SelectionDiagnostics.record(status, targetPID: targetPID) }
        }
        guard !SecureInput.isActive, let targetPID,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPID else {
            report("capture.guardFailed")
            return nil
        }
        let app = AXUIElementCreateApplication(targetPID)
        AXUIElementSetMessagingTimeout(app, 0.3)
        var ref: CFTypeRef?
        let focusError = AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &ref)
        guard focusError == .success,
              let ref, CFGetTypeID(ref) == AXUIElementGetTypeID() else {
            report("capture.focusUnavailable:\(focusError.rawValue)")
            return nil
        }
        let element = editableRoot(unsafeDowncast(ref as AnyObject, to: AXUIElement.self))
        guard let value = value(element) else {
            report("capture.valueUnavailable")
            return nil
        }
        guard let range = range(element) else {
            report("capture.rangeUnavailable")
            return nil
        }
        guard range.location >= 0, range.length >= 0,
              range.location <= (value as NSString).length,
              range.length <= (value as NSString).length - range.location else {
            report("capture.invalidRange")
            return nil
        }
        report("capture.ready")
        return Snapshot(element: element, value: value, range: range)
    }

    public static func selectedText(targetPID: pid_t?) -> String? {
        guard !SecureInput.isActive, let targetPID,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPID else { return nil }
        let app = AXUIElementCreateApplication(targetPID)
        AXUIElementSetMessagingTimeout(app, 0.3)
        var focused: CFTypeRef?
        if AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
           let focused, CFGetTypeID(focused) == AXUIElementGetTypeID() {
            var text: CFTypeRef?
            let element = editableRoot(unsafeDowncast(focused as AnyObject, to: AXUIElement.self))
            if AXUIElementCopyAttributeValue(element, kAXSelectedTextAttribute as CFString, &text) == .success,
               let selected = text as? String { return selected }
        }
        guard let snapshot = capture(targetPID: targetPID) else { return nil }
        return (snapshot.value as NSString).substring(with: NSRange(location: snapshot.range.location, length: snapshot.range.length))
    }

    public static func equivalent(_ left: String?, _ right: String) -> Bool {
        guard let left else { return false }
        return normalized(left) == normalized(right)
    }

    private static func normalized(_ text: String) -> String {
        text.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .replacingOccurrences(of: "\u{2028}", with: "\n")
            .replacingOccurrences(of: "\u{2029}", with: "\n")
    }

    /// Where `text` sits for a replacement: already selected, or immediately before
    /// a collapsed caret, which is where dictation leaves it. Offsets are UTF-16, as AX uses.
    public static func recentOutputRange(_ text: String, value: String, selection: CFRange) -> CFRange? {
        let source = value as NSString
        guard !text.isEmpty, selection.location >= 0, selection.length >= 0,
              selection.location <= source.length, selection.length <= source.length - selection.location else { return nil }
        if selection.length > 0 {
            let selected = source.substring(with: NSRange(location: selection.location, length: selection.length))
            return equivalent(selected, text) ? selection : nil
        }
        let (canonical, offsets) = canonicalOffsets(source.substring(to: selection.location))
        let target = normalized(text)
        let start = (canonical as NSString).length - (target as NSString).length
        guard start >= 0, (canonical as NSString).substring(from: start) == target,
              let mappedStart = offsets[start] else { return nil }
        return CFRange(location: mappedStart, length: selection.location - mappedStart)
    }

    /// True when `text` is selected or ends at the caret in the focused editor.
    public static func isRecentOutput(_ text: String, targetPID: pid_t?) -> Bool {
        if equivalent(selectedText(targetPID: targetPID), text) { return true }
        guard let snapshot = capture(targetPID: targetPID) else { return false }
        return recentOutputRange(text, value: snapshot.value, selection: snapshot.range) != nil
    }

    /// Selects `text` just before it is replaced, and only when it ends at the caret.
    /// Dictation itself never leaves a selection behind.
    public static func selectRecentOutput(_ text: String, targetPID: pid_t?, permitted: () -> Bool) async -> Bool {
        if equivalent(selectedText(targetPID: targetPID), text) { return true }
        guard permitted(), let snapshot = capture(targetPID: targetPID, diagnose: true),
              let range = recentOutputRange(text, value: snapshot.value, selection: snapshot.range) else {
            SelectionDiagnostics.record("selection.recentOutputNotFound", targetPID: targetPID)
            return false
        }
        guard setRange(range, on: snapshot.element, targetPID: targetPID) else { return false }
        // Some editors apply AX selection writes asynchronously. Verify before replacing.
        for _ in 0..<10 {
            guard permitted() else { break }
            if equivalent(selectedText(targetPID: targetPID), text) { return true }
            try? await Task.sleep(nanoseconds: 30_000_000)
        }
        SelectionDiagnostics.record("selection.didNotStick", targetPID: targetPID)
        // Never leave a highlight behind when the replacement falls back to the clipboard.
        _ = setRange(snapshot.range, on: snapshot.element, targetPID: targetPID)
        return false
    }

    private static func setRange(_ range: CFRange, on element: AXUIElement, targetPID: pid_t?) -> Bool {
        var range = range
        guard let value = AXValueCreate(.cfRange, &range) else { return false }
        let error = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, value)
        if error != .success { SelectionDiagnostics.record("selection.writeError:\(error.rawValue)", targetPID: targetPID) }
        return error == .success
    }

    // Keep AX offsets in the editor's UTF-16 representation while comparing
    // canonical newlines.
    private static func canonicalOffsets(_ text: String) -> (String, [Int: Int]) {
        var canonical = ""
        var offsets = [0: 0]
        var sourceOffset = 0
        var canonicalOffset = 0
        for character in text {
            let source = String(character)
            let replacement = normalized(source)
            canonical += replacement
            sourceOffset += source.utf16.count
            canonicalOffset += replacement.utf16.count
            offsets[canonicalOffset] = sourceOffset
        }
        return (canonical, offsets)
    }

    private static func value(_ element: AXUIElement) -> String? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &ref) == .success else { return nil }
        return ref as? String
    }

    private static func editableRoot(_ element: AXUIElement) -> AXUIElement {
        var ancestor: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, "AXEditableAncestor" as CFString, &ancestor) == .success,
           let ancestor, CFGetTypeID(ancestor) == AXUIElementGetTypeID() {
            return unsafeDowncast(ancestor as AnyObject, to: AXUIElement.self)
        }
        return element
    }

    private static func range(_ element: AXUIElement) -> CFRange? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &ref) == .success,
              let ref, CFGetTypeID(ref) == AXValueGetTypeID() else { return nil }
        var range = CFRange()
        guard AXValueGetValue(unsafeDowncast(ref as AnyObject, to: AXValue.self), .cfRange, &range) else { return nil }
        return range
    }
}
