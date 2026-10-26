import AppKit
import Foundation

/// Bounded, local troubleshooting records. Never include text or window titles.
@MainActor
enum SelectionDiagnostics {
    static func record(_ status: String, targetPID: pid_t?) {
        let app = targetPID.flatMap { NSRunningApplication(processIdentifier: $0) }
        let entry: [String: Any] = [
            "time": ISO8601DateFormatter().string(from: Date()),
            "status": status,
            "app": app?.bundleIdentifier ?? "unknown",
            "frontmostMatches": targetPID != nil && NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPID,
            "accessibilityTrusted": AXIsProcessTrusted(),
            "secureInput": SecureInput.isActive
        ]
        guard let line = try? JSONSerialization.data(withJSONObject: entry, options: [.sortedKeys]) else { return }
        let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Bento", isDirectory: true)
        let url = directory.appendingPathComponent("selection-diagnostics.jsonl")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
            var data = (try? Data(contentsOf: url)) ?? Data()
            if data.count > 65_536 { data = Data() }
            data.append(line)
            data.append(0x0A)
            try data.write(to: url, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        } catch {
            Log.insertion.error("Selection diagnostics could not be saved")
        }
    }
}
