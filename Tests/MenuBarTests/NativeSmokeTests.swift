import AppKit
import Foundation
import Testing
import BentoCore
@testable import MenuBar

/// Opt-in only, inside scripts/e2e/session. Creates only our status items;
/// never sends input or moves the pointer or another app's items.
@Test(.enabled(if: ProcessInfo.processInfo.environment["BENTO_NATIVE_MENUBAR_SMOKE"] == "1"))
@MainActor func nativeManualArrangementSmoke() async throws {
    let fm = FileManager.default
    try #require(fm.fileExists(atPath: "/tmp/bento-gui.lock/owner"))
    func checkSession() throws {
        try #require(!fm.fileExists(atPath: "/tmp/bento-user-active"))
    }
    func settle(_ seconds: Double) async throws {
        for _ in 0..<Int(seconds * 10) {
            try checkSession()
            try await Task.sleep(for: .milliseconds(100))
        }
    }
    try checkSession()
    _ = NSApplication.shared
    NSApp.setActivationPolicy(.accessory)
    let cursor = try #require(CGEvent(source: nil)?.location)
    let before = Dictionary(uniqueKeysWithValues: WindowServer.menuBarItemWindows().map { ($0.id, $0.frame) })
    // The shell normally creates Bento's recovery icon before these controls.
    var recovery: NSStatusItem? = NSStatusBar.system.statusItem(withLength:
        StatusItemSizing.shared.normalLength(contentWidth: 24, fallback: 24))
    recovery?.autosaveName = "BentoQARecoveryIcon"
    recovery?.button?.title = "B"
    defer { if let recovery { NSStatusBar.system.removeStatusItem(recovery) } }
    try await settle(0.3)
    let recoveryWindow = try #require(WindowServer.menuBarItemWindows().first { $0.name == "BentoQARecoveryIcon" })
    // The Swift Testing runner has no application AX extras on macOS 26.
    // Seed ownership only for the fixture we just created; read native geometry.
    let scanner = ItemScanner(owners: [recoveryWindow.id: .init(pid: getpid(), bundleID: nil, appName: "Bento QA")])
    var settings = MenuBarSettings()
    settings.bar = .never
    settings.autoRehide = true
    settings.rehideDelay = 3
    let controller = MenuBarController(settings: settings, scanner: scanner)
    defer { controller.stop() }
    controller.start()
    try await settle(1.5)
    #expect(controller.controls.hidden != nil)
    #expect(controller.controls.alwaysHidden != nil)
    #expect(controller.visibility == .hidden)
    #expect(controller.controls.hiddenExpanded)

    controller.beginArrangement()
    #expect(controller.isArranging)
    #expect(controller.visibility == .shownAll)
    #expect(!controller.controls.hiddenExpanded && !controller.controls.alwaysHiddenExpanded)
    controller.hide()
    try await settle(3.5)
    #expect(controller.isArranging && controller.visibility == .shownAll)
    controller.finishArrangement()
    #expect(!controller.isArranging && controller.visibility == .hidden)
    #expect(controller.controls.hiddenExpanded)

    controller.show(all: true, reason: .user)
    controller.beginArrangement()
    controller.finishArrangement()
    #expect(controller.visibility == .shownAll)
    controller.beginArrangement()
    controller.stop()
    #expect(!controller.isArranging)
    #expect(controller.controls.hidden == nil && controller.controls.alwaysHidden == nil && controller.controls.toggle == nil)
    if let recovery { NSStatusBar.system.removeStatusItem(recovery) }
    recovery = nil
    try await settle(0.5)
    let after = Dictionary(uniqueKeysWithValues: WindowServer.menuBarItemWindows().map { ($0.id, $0.frame) })
    for (id, frame) in before where after[id] != nil {
        #expect(after[id] == frame, "Existing menu bar window \(id) changed position")
    }
    let endCursor = try #require(CGEvent(source: nil)?.location)
    #expect(endCursor == cursor)
}
