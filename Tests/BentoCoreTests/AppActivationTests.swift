import AppKit
import Testing
@testable import BentoCore

/// Counts ordering calls; never actually puts a window on the user's screen.
private final class OrderingWindow: NSWindow {
    var orderOuts = 0
    var ordersFront = 0
    init() { super.init(contentRect: NSRect(x: 0, y: 0, width: 100, height: 100), styleMask: [.titled], backing: .buffered, defer: true); isReleasedWhenClosed = false }
    override func orderOut(_ sender: Any?) { orderOuts += 1 }
    override func orderFrontRegardless() { ordersFront += 1 }
}

private func resignActive() {
    NotificationCenter.default.post(name: NSApplication.didResignActiveNotification, object: NSApp)
}

/// Hiding a window hands focus back first and orders the window out once Bento
/// has resigned active, so no other Bento window is raised in between.
@Suite(.serialized) @MainActor struct AppActivationOrderOutTests {
    /// Keeps the test process out of the Dock and app switcher; set once per run.
    private static let prohibitActivation: Void = { NSApplication.shared.setActivationPolicy(.prohibited) }()
    init() { _ = Self.prohibitActivation }

    @Test func ordersOutOnceBentoResignsActive() {
        let w = OrderingWindow()
        AppActivation.orderOutOnResign(w)
        #expect(AppActivation.isOrderingOut(w))
        #expect(w.orderOuts == 0)
        resignActive()
        #expect(w.orderOuts == 1)
        #expect(!AppActivation.isOrderingOut(w))
        resignActive()
        #expect(w.orderOuts == 1)
    }

    @Test func showingAgainCancelsThePendingOrderOut() {
        let w = OrderingWindow()
        AppActivation.orderOutOnResign(w)
        AppActivation.show(w, activate: false)
        #expect(w.ordersFront == 1)
        #expect(!AppActivation.isOrderingOut(w))
        resignActive()
        #expect(w.orderOuts == 0)
    }

    @Test func ordersOutAfterTheTimeoutWhenActivationNeverLands() async throws {
        let w = OrderingWindow()
        AppActivation.orderOutOnResign(w, timeout: 0.05)
        try await Task.sleep(for: .milliseconds(300))
        #expect(w.orderOuts == 1)
        #expect(!AppActivation.isOrderingOut(w))
    }

    @Test func aSupersededTimeoutLeavesTheNewerOrderOutAlone() async throws {
        let w = OrderingWindow()
        AppActivation.orderOutOnResign(w, timeout: 0.05)
        AppActivation.orderOutOnResign(w, timeout: 10)
        try await Task.sleep(for: .milliseconds(300))
        #expect(w.orderOuts == 0)
        #expect(AppActivation.isOrderingOut(w))
        resignActive()
        #expect(w.orderOuts == 1)
    }

    @Test func inactiveBentoOrdersOutAtOnce() {
        // The test process is never active: there is nothing to hand focus away from.
        let w = OrderingWindow()
        AppActivation.orderOut(w, activating: NSWorkspace.shared.frontmostApplication)
        #expect(w.orderOuts == 1)
        #expect(!AppActivation.isOrderingOut(w))
    }

    @Test func focusFallsBackToThePreviousAppWhenTheOriginIsUnusable() throws {
        let other = try #require(NSWorkspace.shared.runningApplications.first { $0.processIdentifier != getpid() })
        let bento = NSRunningApplication.current
        #expect(AppActivation.focusTarget(other, previous: nil) == other)
        #expect(AppActivation.focusTarget(bento, previous: other) == other)
        #expect(AppActivation.focusTarget(bento, previous: bento) == nil)
        #expect(AppActivation.focusTarget(nil, previous: other) == nil)
    }
}
