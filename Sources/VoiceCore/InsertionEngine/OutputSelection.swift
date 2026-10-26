import AppKit
import ApplicationServices

@MainActor
public enum OutputSelection {
    public struct Snapshot {
        let element: AXUIElement
        let value: String
        let range: CFRange
        let identifier: String?
        let window: AXUIElement?

        public init(element: AXUIElement, value: String, range: CFRange, identifier: String? = nil, window: AXUIElement? = nil) {
            self.element = element
            self.value = value
            self.range = range
            self.identifier = identifier
            self.window = window
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
        var identifier: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXIdentifierAttribute as CFString, &identifier)
        var window: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXWindowAttribute as CFString, &window)
        let axWindow = window.flatMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? unsafeDowncast($0 as AnyObject, to: AXUIElement.self) : nil }
        return Snapshot(element: element, value: value, range: range, identifier: identifier as? String, window: axWindow)
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

    private static func insertedRange(text: String, before: Snapshot, current: Snapshot) -> CFRange? {
        let source = before.value as NSString
        let value = current.value as NSString
        let start = before.range.location
        guard start >= 0, before.range.length >= 0, start <= source.length,
              before.range.length <= source.length - start else { return nil }
        let prefix = source.substring(to: start)
        let suffix = source.substring(from: start + before.range.length)
        let (canonical, offsets) = canonicalOffsets(current.value)
        let canonicalPrefix = normalized(prefix)
        let canonicalText = normalized(text)
        guard canonical == canonicalPrefix + canonicalText + normalized(suffix) else { return nil }
        let normalizedStart = (canonicalPrefix as NSString).length
        let normalizedEnd = normalizedStart + (canonicalText as NSString).length
        guard let mappedStart = offsets[normalizedStart], let mappedEnd = offsets[normalizedEnd],
              mappedStart <= mappedEnd, mappedEnd <= value.length else { return nil }
        return CFRange(location: mappedStart, length: mappedEnd - mappedStart)
    }

    // Keep AX offsets in the editor's UTF-16 representation while comparing
    // canonical newlines across the whole replacement, including surrounding text.
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

    public static func replacementValue(before: String, range: NSRange, text: String) -> String? {
        let source = before as NSString
        guard range.location >= 0, range.length >= 0, range.location <= source.length,
              range.length <= source.length - range.location else { return nil }
        return source.replacingCharacters(in: range, with: text)
    }

    public static func selectInserted(_ text: String, before: Snapshot?, targetPID: pid_t?) async -> Bool {
        let activity = SelectionActivity(targetPID: targetPID)
        defer { activity.stop() }
        return await selectInserted(text, before: before, targetPID: targetPID, activity: activity)
    }

    static func selectInserted(_ text: String, before: Snapshot?, targetPID: pid_t?, activity: SelectionActivity) async -> Bool {
        let result = await selectInserted(text, before: before, read: { capture(targetPID: targetPID) },
            setRange: { element, range in
                var range = range
                guard let value = AXValueCreate(.cfRange, &range) else { return false }
                let error = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, value)
                if error != .success { SelectionDiagnostics.record("selection.writeError:\(error.rawValue)", targetPID: targetPID) }
                return error == .success
            }, permitted: { activity.valid }, pause: {
                try? await Task.sleep(nanoseconds: 40_000_000)
            }, report: { SelectionDiagnostics.record($0, targetPID: targetPID) })
        if result, equivalent(selectedText(targetPID: targetPID), text) { return true }
        guard activity.valid else { return false }
        // A keyboard fallback needs positive caret/text evidence, not merely a
        // posted paste. Never guess its starting point in an unreadable editor.
        guard let before, let current = capture(targetPID: targetPID),
              sameEditor(before, current), let expected = insertedRange(text: text, before: before, current: current),
              (current.range.length == 0 && current.range.location == expected.location + expected.length) ||
              (current.range.location == expected.location && current.range.length == expected.length) else {
            SelectionDiagnostics.record("selection.noSafeKeyboardAnchor", targetPID: targetPID)
            return false
        }
        if current.range.length > 0 {
            let copied = await KeyboardSelection.readSelectedText(targetPID: targetPID, permitted: { activity.valid })
            return activity.valid && equivalent(copied, text)
        }
        let fallback = await KeyboardSelection.select(text, targetPID: targetPID, activity: activity)
        SelectionDiagnostics.record(fallback ? "selection.keyboardVerified" : "selection.keyboardUnverified", targetPID: targetPID)
        return fallback
    }

    public static func selectInserted(_ text: String, before: Snapshot?,
        read: () -> Snapshot?, setRange: (AXUIElement, CFRange) -> Bool,
        permitted: () -> Bool, pause: () async -> Void, report: (String) -> Void = { _ in }) async -> Bool {
        guard let before, !text.isEmpty else {
            report(before == nil ? "selection.noInitialSnapshot" : "selection.emptyOutput")
            return false
        }
        var lastWrite = -10
        var stableReads = 0
        var observedEnd = false
        // AX value, caret, and selection notifications arrive independently.
        // Wait for convergence and a short stable selection, bounded to 1.2 seconds.
        for tick in 0..<30 {
            guard !Task.isCancelled, permitted() else { report("selection.cancelledOrBlocked"); return false }
            guard let current = read() else { report("selection.snapshotLost"); return false }
            // Browser renderers can replace the AX node on paste. The complete
            // replacement match below plus the caller's input/window guard own safety.
            if !sameEditor(before, current) {
                stableReads = 0
                await pause()
                continue
            }
            if let selection = insertedRange(text: text, before: before, current: current) {
                let isSelected = current.range.location == selection.location && current.range.length == selection.length
                let atEnd = current.range.location == selection.location + selection.length && current.range.length == 0
                let unchangedCaret = current.range.location == before.range.location && current.range.length == before.range.length
                if isSelected {
                    stableReads += 1
                    if stableReads >= 5 { report("selection.verified"); return true }
                } else {
                    stableReads = 0
                    if atEnd {
                        observedEnd = true
                        // Give asynchronous selection writes time to arrive before retrying.
                        if tick - lastWrite >= 5 {
                            guard setRange(current.element, selection) else { report("selection.writeRejected"); return false }
                            lastWrite = tick
                        }
                    } else if observedEnd || !unchangedCaret {
                        report("selection.caretMoved")
                        return false
                    }
                }
            } else {
                stableReads = 0
                if observedEnd { report("selection.contentChanged"); return false }
            }
            await pause()
        }
        report(observedEnd ? "selection.didNotStick" : "selection.insertionNotObserved")
        return false
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

    private static func sameEditor(_ before: Snapshot, _ current: Snapshot) -> Bool {
        if CFEqual(before.element, current.element) { return true }
        guard let identifier = before.identifier, !identifier.isEmpty, identifier == current.identifier,
              let window = before.window, let otherWindow = current.window else { return false }
        return CFEqual(window, otherWindow)
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
