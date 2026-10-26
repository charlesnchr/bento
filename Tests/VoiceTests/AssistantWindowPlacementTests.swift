import AppKit
import Testing
@testable import Voice

@Suite struct AssistantWindowPlacementTests {
    let laptop = NSRect(x: 0, y: 0, width: 1728, height: 1117)
    let monitor = NSRect(x: 1728, y: -200, width: 3840, height: 1620)

    @Test func signatureIgnoresScreenOrder() {
        #expect(AssistantWindowPlacement.signature([laptop, monitor]) == AssistantWindowPlacement.signature([monitor, laptop]))
        #expect(AssistantWindowPlacement.signature([laptop]) != AssistantWindowPlacement.signature([laptop, monitor]))
    }

    @Test func savedFrameIsPerArrangementWithLastAsFallback() {
        let docked = NSRect(x: 3000, y: 200, width: 700, height: 900)
        let mobile = NSRect(x: 100, y: 100, width: 650, height: 650)
        let frames: [String: Any] = [
            AssistantWindowPlacement.signature([laptop, monitor]): NSStringFromRect(docked),
            AssistantWindowPlacement.signature([laptop]): NSStringFromRect(mobile),
            "last": NSStringFromRect(mobile),
        ]
        // Back at the desk: the docked frame, not where the window was moved to on the laptop.
        #expect(AssistantWindowPlacement.savedFrame(in: frames, for: [monitor, laptop]) == docked)
        #expect(AssistantWindowPlacement.savedFrame(in: frames, for: [laptop]) == mobile)
        // A new arrangement starts from the last frame used anywhere.
        let other = NSRect(x: -1920, y: 0, width: 1920, height: 1080)
        #expect(AssistantWindowPlacement.savedFrame(in: frames, for: [laptop, other]) == mobile)
        #expect(AssistantWindowPlacement.savedFrame(in: [:], for: [laptop]) == nil)
        #expect(AssistantWindowPlacement.savedFrame(in: ["last": "nonsense"], for: [laptop]) == nil)
    }

    @Test func constrainedFrameKeepsTheWindowOnAScreen() throws {
        // A frame from a monitor that's gone lands on the remaining screen, at most its size.
        let offscreen = NSRect(x: 4000, y: 300, width: 700, height: 900)
        let frame = try #require(AssistantWindowPlacement.constrainedFrame(offscreen, visibleFrames: [laptop]))
        #expect(laptop.contains(frame))
        #expect(frame.size == NSSize(width: 700, height: 900))
        // A frame that fits is left alone.
        let inside = NSRect(x: 200, y: 100, width: 650, height: 650)
        #expect(AssistantWindowPlacement.constrainedFrame(inside, visibleFrames: [laptop, monitor]) == inside)
        // Below the minimum size it grows to 370 × 420.
        let tiny = NSRect(x: 10, y: 10, width: 100, height: 100)
        #expect(AssistantWindowPlacement.constrainedFrame(tiny, visibleFrames: [laptop])?.size == NSSize(width: 370, height: 420))
        #expect(AssistantWindowPlacement.constrainedFrame(inside, visibleFrames: []) == nil)
    }

    @Test func narrowWidthIsKeptUntilTheSidebarNeedsRoom() throws {
        // A narrow window comes back as narrow as the user left it.
        let narrow = NSRect(x: 119, y: 186, width: 419, height: 650)
        #expect(AssistantWindowPlacement.constrainedFrame(narrow, visibleFrames: [laptop]) == narrow)
        // Showing the conversation list widens it to fit, in place.
        let withSidebar = AssistantWindowPlacement.minimumSize(sidebar: true)
        #expect(AssistantWindowPlacement.constrainedFrame(narrow, minimum: withSidebar, visibleFrames: [laptop])
            == NSRect(x: 119, y: 186, width: 610, height: 650))
        // At the screen's right edge it shifts left to stay on screen.
        let edge = NSRect(x: laptop.maxX - 419, y: 186, width: 419, height: 650)
        let widened = try #require(AssistantWindowPlacement.constrainedFrame(edge, minimum: withSidebar, visibleFrames: [laptop]))
        #expect(widened == NSRect(x: laptop.maxX - 610, y: 186, width: 610, height: 650))
    }
}

/// The placement as AssistantWindow drives it, on a real window: frames the
/// placement makes (the restore, the conversation list's extra width) never
/// overwrite the one the user chose, so it comes back after hide and relaunch.
@MainActor @Suite(.serialized) struct AssistantWindowPlacementPersistenceTests {
    let suite = "AssistantWindowPlacementTests"

    func window() -> NSWindow {
        NSWindow(contentRect: NSRect(x: 0, y: 0, width: 650, height: 650),
                 styleMask: [.titled, .resizable, .fullSizeContentView], backing: .buffered, defer: true)
    }

    @Test func userFrameSurvivesHideRelaunchAndTheSidebar() throws {
        guard let screen = NSScreen.screens.first?.visibleFrame, screen.width >= 800, screen.height >= 600 else { return }
        _ = NSApplication.shared
        let defaults = try #require(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        defer { defaults.removePersistentDomain(forName: suite) }
        let screens = NSScreen.screens.map(\.frame)
        // Narrower than the conversation list needs and nearly as short as allowed.
        let narrow = NSRect(x: screen.minX + 40, y: screen.minY + 40, width: 419, height: 430)
        defaults.set([AssistantWindowPlacement.signature(screens): NSStringFromRect(narrow)], forKey: "frames")
        func saved() -> NSRect? { AssistantWindowPlacement.savedFrame(in: defaults.dictionary(forKey: "frames") ?? [:], for: screens) }

        let first = window()
        let placement = AssistantWindowPlacement(window: first, key: "frames", defaults: defaults)
        placement.prepareToShow()
        #expect(first.frame == narrow)
        // Showing the conversation list widens the window, but hiding the window
        // (or quitting) then doesn't save that width as the user's.
        placement.sidebar = true
        #expect(first.frame == NSRect(x: narrow.minX, y: narrow.minY, width: 610, height: 430))
        // Nor can the user then resize it narrower than the list needs.
        #expect(placement.resizing(to: NSSize(width: 300, height: 300)) == NSSize(width: 610, height: 420))
        placement.save()
        #expect(saved() == narrow)
        // Hiding the list gives the window back its own width.
        placement.sidebar = false
        #expect(first.frame == narrow)
        #expect(placement.resizing(to: NSSize(width: 300, height: 300)) == NSSize(width: 370, height: 420))
        #expect(placement.resizing(to: NSSize(width: 400, height: 450)) == NSSize(width: 400, height: 450))

        // Relaunch: the same frame.
        let second = window()
        let relaunched = AssistantWindowPlacement(window: second, key: "frames", defaults: defaults)
        relaunched.prepareToShow()
        #expect(second.frame == narrow)
        // A resize to the minimum size is the user's, kept as is.
        let smallest = NSRect(x: narrow.minX + 10, y: narrow.minY + 10, width: 370, height: 420)
        second.setFrame(smallest, display: false)
        relaunched.save()
        #expect(saved() == smallest)
        let third = window()
        AssistantWindowPlacement(window: third, key: "frames", defaults: defaults).prepareToShow()
        #expect(third.frame == smallest)
    }
}
