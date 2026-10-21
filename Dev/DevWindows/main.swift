import Foundation
import BentoCore
import BentoShell
import Windows

// BENTO_LOG_EVENTS=1 prints Bento cross-module events (e.g. windowPlaced) to stderr.
if ProcessInfo.processInfo.environment["BENTO_LOG_EVENTS"] != nil {
    _ = NotificationCenter.default.addObserver(forName: BentoEvents.windowPlaced, object: nil, queue: .main) { note in
        let w = note.userInfo?["window"] as? AXWindow
        FileHandle.standardError.write("windowPlaced \(w?.title ?? "?") \(w?.frame.map { "\($0)" } ?? "")\n".data(using: .utf8)!)
    }
}

BentoApp.runDev("windows", modules: [WindowsModule()])
