import AppKit
import Testing
@testable import Voice

@Suite struct AssistantWindowStackingTests {
    @Test func keepOnTopFloatsOnEverySpaceAndOverFullScreenApps() {
        let pip = AssistantWindowStacking.keepOnTop(true)
        #expect(pip.level.rawValue >= NSWindow.Level.floating.rawValue, "above other apps' normal windows")
        #expect(pip.collectionBehavior.contains(.canJoinAllSpaces))
        #expect(pip.collectionBehavior.contains(.fullScreenAuxiliary))
        // AppKit raises if a window both joins all Spaces and moves to the active one.
        #expect(!pip.collectionBehavior.contains(.moveToActiveSpace))
        // Typing into it must not activate Bento and pull the user off a full-screen app's Space.
        #expect(pip.nonactivating)
    }

    @Test func offKeepsTheWindowOnTheSpaceItWasShownOn() {
        let normal = AssistantWindowStacking.keepOnTop(false)
        #expect(normal == AssistantWindowStacking(level: .floating, collectionBehavior: [.fullScreenAuxiliary, .moveToActiveSpace],
                                                  nonactivating: false))
        #expect(!normal.collectionBehavior.contains(.canJoinAllSpaces))
    }
}
