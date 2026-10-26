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
        // Below the minimum size it grows to 610 × 420.
        let tiny = NSRect(x: 10, y: 10, width: 100, height: 100)
        #expect(AssistantWindowPlacement.constrainedFrame(tiny, visibleFrames: [laptop])?.size == NSSize(width: 610, height: 420))
        #expect(AssistantWindowPlacement.constrainedFrame(inside, visibleFrames: []) == nil)
    }
}
