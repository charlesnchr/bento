import AppKit
import BentoCore
import Foundation
import Testing
@testable import MenuBar

/// Run alone inside a guarded session. Uses only disposable Bento controls.
@Test(.enabled(if: ProcessInfo.processInfo.environment["BENTO_NATIVE_COMPACT_SMOKE"] == "1"))
@MainActor func nativeCompactDividersHaveEightPointWindows() async throws {
    let fm = FileManager.default
    try #require(fm.fileExists(atPath: "/tmp/bento-gui.lock/owner"))
    func checkSession() throws {
        try #require(!fm.fileExists(atPath: "/tmp/bento-user-active"))
    }
    try checkSession()
    // AppKit caches spacing when its status bar is first used.
    let sizing = StatusItemSizing()
    sizing.configure()
    _ = NSApplication.shared
    NSApp.setActivationPolicy(.accessory)
    let controls = ControlItems()
    controls.create(showToggle: false, alwaysHiddenSection: true, compact: true)
    controls.apply(.shownAll, expansion: .init(hidden: false, alwaysHidden: false))
    defer { controls.removeAll() }

    let kinds: [ControlItems.Kind] = [.alwaysHidden, .hidden]
    var frames: [ControlItems.Kind: (CGWindowID, CGRect)] = [:]
    for _ in 0..<30 {
        try checkSession()
        let windows = WindowServer.menuBarItemWindows()
        frames = Dictionary(uniqueKeysWithValues: kinds.compactMap { kind in
            windows.first { $0.name == ControlItems.autosaveNames[kind] }
                .map { (kind, ($0.id, $0.frame)) }
        })
        if frames.count == 2 && frames.values.allSatisfy({ abs($0.1.width - 8) < 0.1 && $0.1.minY == 0 }) { break }
        try await Task.sleep(for: .milliseconds(100))
    }
    let folder = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("bento-compact-glyphs-\(UUID().uuidString)")
    try fm.createDirectory(at: folder, withIntermediateDirectories: true)
    for kind in kinds {
        try checkSession()
        let (id, frame) = try #require(frames[kind])
        #expect(abs(frame.width - 8) < 0.1, "Compact \(kind) has native width \(frame.width), expected 8")
        let onScreen = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        try #require(onScreen.contains { ($0[kCGWindowNumber as String] as? UInt32) == id })
        let capture = Process()
        capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        capture.arguments = ["-x", "-l", String(id), folder.appendingPathComponent("\(kind.rawValue).png").path]
        try capture.run()
        capture.waitUntilExit()
        try #require(capture.terminationStatus == 0)
    }
    print("Compact divider captures: \(folder.path)")
}
