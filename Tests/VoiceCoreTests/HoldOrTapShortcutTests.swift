import Foundation
import Testing
@testable import VoiceCore

@Suite struct HoldOrTapShortcutTests {
    @Test func holdIsPushToTalk() {
        var gesture = HoldOrTapShortcut()
        #expect(gesture.keyDown(at: 0, recording: false) == .begin)
        #expect(gesture.keyUp(at: 1.2, recording: true) == .finalize)
    }

    @Test func tapGoesHandsFreeAndTheNextPressFinishes() {
        var gesture = HoldOrTapShortcut()
        #expect(gesture.keyDown(at: 0, recording: false) == .begin)
        #expect(gesture.keyUp(at: 0.1, recording: true) == .lockIn)
        #expect(gesture.keyDown(at: 5, recording: true) == .finalize)
        #expect(gesture.keyUp(at: 6, recording: false) == nil, "the finishing press's release does nothing")
        #expect(gesture.keyDown(at: 7, recording: false) == .begin, "and the one after starts again")
    }

    @Test func holdThresholdMatchesTheDictationKey() {
        var gesture = HoldOrTapShortcut()
        _ = gesture.keyDown(at: 10, recording: false)
        #expect(gesture.keyUp(at: 10 + HotkeyTuning.holdThreshold - 0.01, recording: true) == .lockIn)
        _ = gesture.keyDown(at: 20, recording: false)
        #expect(gesture.keyUp(at: 20 + HotkeyTuning.holdThreshold, recording: true) == .finalize)
    }

    @Test func repeatedKeyDownsWhileHeldAreEchoes() {
        var gesture = HoldOrTapShortcut()
        #expect(gesture.keyDown(at: 0, recording: false) == .begin)
        #expect(gesture.keyDown(at: 0.5, recording: true) == nil)
        #expect(gesture.keyDown(at: 0.6, recording: true) == nil)
        #expect(gesture.keyUp(at: 1, recording: true) == .finalize)
    }

    @Test func refusedBeginLeavesNothingForTheRelease() {
        var gesture = HoldOrTapShortcut()
        #expect(gesture.keyDown(at: 0, recording: false) == .begin)
        gesture.beginRefused()
        #expect(gesture.keyUp(at: 0.1, recording: false) == nil)
        #expect(gesture.keyDown(at: 1, recording: false) == .begin)
    }

    @Test func sessionEndedElsewhereMidHoldIsNotFinishedOrLocked() {
        // Esc, the pill's stop button or an error ended it before the key came up.
        var gesture = HoldOrTapShortcut()
        _ = gesture.keyDown(at: 0, recording: false)
        #expect(gesture.keyUp(at: 2, recording: false) == nil)
        _ = gesture.keyDown(at: 3, recording: false)
        #expect(gesture.keyUp(at: 3.1, recording: false) == nil)
    }

    @Test func aHandsFreeSessionStoppedElsewhereMeansTheNextPressStartsOne() {
        var gesture = HoldOrTapShortcut()
        _ = gesture.keyDown(at: 0, recording: false)
        #expect(gesture.keyUp(at: 0.1, recording: true) == .lockIn)
        // Cancelled with Esc meanwhile: nothing is remembered as "locked".
        #expect(gesture.keyDown(at: 4, recording: false) == .begin)
    }

    @Test func menuAndURLsToggle() {
        #expect(HoldOrTapShortcut.toggle(recording: false) == [.begin, .lockIn])
        #expect(HoldOrTapShortcut.toggle(recording: true) == [.finalize])
    }
}
