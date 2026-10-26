// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import Foundation
import Testing
@testable import VoiceCore

/// A class so the tests can drive the processor through `send` without each
/// being `mutating`; Swift Testing makes a fresh instance per test.
@Suite final class HotkeyProcessorTests {
    private var processor = HotkeyProcessor()

    init() {
        // The existing tests lock down the optional legacy grammar.
        processor.singleTapHandsFreeEnabled = false
    }

    @Test func defaultSingleTapLocksAndSecondPressStops() {
        processor = HotkeyProcessor()
        #expect(send(.hotkeyDown, at: 0).intents == [.begin])
        let up = send(.hotkeyUp, at: 0.1)
        #expect(up.intents == [])
        #expect(up.armTimer != nil)
        #expect(send(.doubleTapTimeout, at: 0.6).intents == [.lockIn])
        #expect(send(.hotkeyDown, at: 2).intents == [.finalize])
        #expect(send(.hotkeyUp, at: 2.1).intents == [])
    }

    @Test func defaultDoublePressFinalizesOnSecondRelease() {
        processor = HotkeyProcessor()
        send(.hotkeyDown, at: 0)
        send(.hotkeyUp, at: 0.1)
        let second = send(.hotkeyDown, at: 0.2)
        #expect(second.intents == [])
        #expect(second.disarmTimer)
        #expect(processor.isKeyHeld)
        #expect(send(.doubleTapTimeout, at: 0.6).intents == [])
        #expect(send(.hotkeyUp, at: 2).intents == [.finalize])
    }

    @Test func delayedSingleTapTimerStillTreatsLatePressAsStop() {
        processor = HotkeyProcessor()
        send(.hotkeyDown, at: 0)
        send(.hotkeyUp, at: 0.1)
        #expect(send(.hotkeyDown, at: 2).intents == [.finalize])
        #expect(send(.doubleTapTimeout, at: 2.1).intents == [])
    }

    @Test func typingDuringSingleTapWindowLocksInsteadOfCancelling() {
        processor = HotkeyProcessor()
        send(.hotkeyDown, at: 0)
        send(.hotkeyUp, at: 0.1)
        #expect(send(.otherKeyDown, at: 0.2).intents == [.lockIn])
        #expect(send(.otherKeyDown, at: 0.3).intents == [])
    }

    @discardableResult
    private func send(_ event: HotkeyProcessor.Event, at t: TimeInterval) -> HotkeyProcessor.Effects {
        processor.handle(event, at: t)
    }

    // MARK: Hold (push-to-talk)

    @Test func holdSpeakRelease() {
        #expect(send(.hotkeyDown, at: 0).intents == [.begin])
        let fx = send(.hotkeyUp, at: 2.5)
        #expect(fx.intents == [.finalize])
        #expect(!processor.isSessionActive)
    }

    @Test func holdExactlyAtThresholdIsHold() {
        send(.hotkeyDown, at: 0)
        #expect(send(.hotkeyUp, at: HotkeyTuning.holdThreshold).intents == [.finalize])
    }

    // MARK: Space-while-holding → hands-free lock (timing-free, the default gesture)

    @Test func spaceWhileHoldingLocks() {
        #expect(send(.hotkeyDown, at: 0).intents == [.begin])
        #expect(send(.spaceLock, at: 0.8).intents == [.lockIn])
        #expect(send(.hotkeyUp, at: 1.2).intents == [], "fn release after Space-lock must not finalize")
        #expect(processor.isSessionActive)
        #expect(send(.hotkeyDown, at: 5).intents == [.finalize], "press again stops")
    }

    @Test func spaceLockWorksEvenAfterLongHold() {
        send(.hotkeyDown, at: 0)
        #expect(send(.spaceLock, at: 4.0).intents == [.lockIn], "no timing window — any time while held")
    }

    @Test func spaceInIdleAndLockedDoesNothing() {
        #expect(send(.spaceLock, at: 0).intents == [], "idle: space is just typing")
        send(.hotkeyDown, at: 1)
        send(.spaceLock, at: 1.5)
        #expect(send(.spaceLock, at: 2).intents == [], "already locked: inert")
    }

    @Test func escCancelsAfterSpaceLock() {
        send(.hotkeyDown, at: 0)
        send(.spaceLock, at: 0.5)
        #expect(send(.escDown, at: 2).intents == [.cancel])
    }

    // MARK: Single short tap → coaching hint

    @Test func shortTapArmsTimerThenHints() {
        processor.doubleTapLockEnabled = true
        #expect(send(.hotkeyDown, at: 0).intents == [.begin])
        let up = send(.hotkeyUp, at: 0.1)
        #expect(up.intents == [])
        #expect(up.armTimer == HotkeyTuning.doubleTapWindow)
        #expect(processor.isSessionActive, "still recording during the double-tap window")
        #expect(send(.doubleTapTimeout, at: 0.7).intents == [.shortTapHint])
        #expect(!processor.isSessionActive)
    }

    @Test func shortTapHintsImmediatelyByDefault() {
        // Double-tap is opt-in now (dogfood: firm taps misread as holds).
        send(.hotkeyDown, at: 0)
        let up = send(.hotkeyUp, at: 0.1)
        #expect(up.intents == [.shortTapHint])
        #expect(up.armTimer == nil)
    }

    // MARK: Double-tap → hands-free lock (opt-in)

    @Test func doubleTapLocksThenPressStops() {
        processor.doubleTapLockEnabled = true
        send(.hotkeyDown, at: 0)
        send(.hotkeyUp, at: 0.1)
        let lock = send(.hotkeyDown, at: 0.3)
        #expect(lock.intents == [.lockIn])
        #expect(lock.disarmTimer)
        #expect(send(.hotkeyUp, at: 0.4).intents == [], "second tap's release is swallowed")
        #expect(processor.isSessionActive)
        // Press again = stop.
        #expect(send(.hotkeyDown, at: 5.0).intents == [.finalize])
        #expect(send(.hotkeyUp, at: 5.1).intents == [], "stop press release swallowed")
        #expect(!processor.isSessionActive)
    }

    @Test func lockedIgnoresTypingAndTimeout() {
        processor.doubleTapLockEnabled = true
        send(.hotkeyDown, at: 0)
        send(.hotkeyUp, at: 0.1)
        send(.hotkeyDown, at: 0.3)
        send(.hotkeyUp, at: 0.4)
        #expect(send(.otherKeyDown, at: 2).intents == [], "typing while locked is allowed")
        #expect(send(.doubleTapTimeout, at: 3).intents == [], "stale timer ignored")
        #expect(processor.isSessionActive)
    }

    // MARK: Esc cancels

    @Test func escWhileHolding() {
        send(.hotkeyDown, at: 0)
        #expect(send(.escDown, at: 1).intents == [.cancel])
        #expect(send(.hotkeyUp, at: 1.2).intents == [], "release after cancel is inert")
        #expect(!processor.isSessionActive)
    }

    @Test func escDuringDoubleTapWindow() {
        processor.doubleTapLockEnabled = true
        send(.hotkeyDown, at: 0)
        send(.hotkeyUp, at: 0.1)
        let fx = send(.escDown, at: 0.2)
        #expect(fx.intents == [.cancel])
        #expect(fx.disarmTimer)
    }

    @Test func escWhileLocked() {
        processor.doubleTapLockEnabled = true
        send(.hotkeyDown, at: 0)
        send(.hotkeyUp, at: 0.1)
        send(.hotkeyDown, at: 0.3)
        send(.hotkeyUp, at: 0.4)
        #expect(send(.escDown, at: 2).intents == [.cancel])
    }

    // MARK: Accidental chord guard

    @Test func typingDuringEarlyHoldAborts() {
        send(.hotkeyDown, at: 0)
        #expect(send(.otherKeyDown, at: 0.5).intents == [.abortAccidental])
        #expect(send(.hotkeyUp, at: 0.6).intents == [], "release after abort is inert")
    }

    @Test func typingAfterInterruptionWindowKeepsRecording() {
        send(.hotkeyDown, at: 0)
        #expect(send(.otherKeyDown, at: 1.5).intents == [], "deliberate chording after 1s is fine")
        #expect(processor.isSessionActive)
        #expect(send(.hotkeyUp, at: 3).intents == [.finalize])
    }

    @Test func typingDuringDoubleTapWindow() {
        processor.doubleTapLockEnabled = true
        send(.hotkeyDown, at: 0)
        send(.hotkeyUp, at: 0.1)
        let fx = send(.otherKeyDown, at: 0.2)
        #expect(fx.intents == [.abortAccidental], "within the 1s interruption window")
        #expect(fx.disarmTimer)
    }

    // MARK: Sequences & robustness

    @Test func newSessionAfterHint() {
        processor.doubleTapLockEnabled = true
        send(.hotkeyDown, at: 0)
        send(.hotkeyUp, at: 0.1)
        send(.doubleTapTimeout, at: 0.6)
        #expect(send(.hotkeyDown, at: 1.0).intents == [.begin], "fresh session after hint")
    }

    @Test func slowSecondTapStartsNewSession() {
        processor.doubleTapLockEnabled = true
        send(.hotkeyDown, at: 0)
        send(.hotkeyUp, at: 0.1)
        send(.doubleTapTimeout, at: 0.61) // window expired → hint
        let fx = send(.hotkeyDown, at: 0.8) // too late to lock
        #expect(fx.intents == [.begin])
    }

    @Test func strayEventsInIdleAreInert() {
        #expect(send(.hotkeyUp, at: 0).intents == [])
        #expect(send(.escDown, at: 1).intents == [])
        #expect(send(.otherKeyDown, at: 2).intents == [])
        #expect(send(.doubleTapTimeout, at: 3).intents == [])
        #expect(!processor.isSessionActive)
    }

    @Test func doubleTapDisabledHintsImmediately() {
        processor.doubleTapLockEnabled = false
        send(.hotkeyDown, at: 0)
        let up = send(.hotkeyUp, at: 0.1)
        #expect(up.intents == [.shortTapHint], "no pending window when lock is disabled")
        #expect(up.armTimer == nil)
        #expect(!processor.isSessionActive)
    }

    @Test func repeatedDownWhilePressedIsIgnored() {
        send(.hotkeyDown, at: 0)
        #expect(send(.hotkeyDown, at: 0.1).intents == [], "duplicate down (flag glitch) ignored")
        #expect(send(.hotkeyUp, at: 1).intents == [.finalize])
    }
}
