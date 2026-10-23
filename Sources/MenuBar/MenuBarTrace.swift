import Foundation
import BentoCore

/// Dev instances (BENTO_DEV) write what the menu bar manager does to
/// `<support>/menubar/trace.log`, for end-to-end tests. Nothing otherwise.
enum MenuBarTrace {
    private static let url: URL? = ProcessInfo.processInfo.environment["BENTO_DEV"] == nil ? nil
        : AppPaths.support("menubar").appendingPathComponent("trace.log")
    private static let lock = NSLock()

    static func log(_ message: @autoclosure () -> String) {
        guard let url else { return }
        let line = "\(String(format: "%.3f", Date().timeIntervalSince1970)) \(message())\n"
        lock.lock()
        defer { lock.unlock() }
        if let h = try? FileHandle(forWritingTo: url) {
            h.seekToEndOfFile()
            h.write(Data(line.utf8))
            try? h.close()
        } else {
            try? Data(line.utf8).write(to: url)
        }
    }
}
