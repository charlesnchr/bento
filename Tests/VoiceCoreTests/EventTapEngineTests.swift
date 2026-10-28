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

import CoreGraphics
import Foundation
import Testing
@testable import VoiceCore

@Suite struct EventTapEngineTests {
    private let f17: CGKeyCode = 64

    private func keyEvent(_ keyCode: CGKeyCode, down: Bool, flags: CGEventFlags = []) -> CGEvent {
        let event = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: down)!
        event.flags = flags
        return event
    }

    @Test func passThroughRetainsTemporaryEventForAssertionInspection() {
        let engine = EventTapEngine(key: .optionF17)
        let returned = engine.handleForTesting(
            type: .flagsChanged,
            event: keyEvent(58, down: true, flags: .maskAlternate),
            at: 0
        )
        #expect(returned != nil)
        #expect(returned?.getIntegerValueField(.keyboardEventKeycode) == 58)
        #expect(returned?.flags == .maskAlternate)
        // Assertion diagnostics may reflect the result after the temporary
        // input event has left scope. This must not dereference a freed event.
        #expect(!String(reflecting: returned as Any).isEmpty)
    }

    @Test func optionF17HasStableStoredValueAndDisplayName() throws {
        #expect(HotkeyKey.optionF17.rawValue == "optionF17")
        #expect(HotkeyKey.optionF17.displayName == "Option+F17")
        let data = try JSONEncoder().encode(HotkeyKey.optionF17)
        #expect(try JSONDecoder().decode(HotkeyKey.self, from: data) == .optionF17)
    }

    @Test func optionF17DownAndUpDriveHoldWithoutRepeatedBegin() {
        let engine = EventTapEngine(key: .optionF17)
        var intents: [HotkeyIntent] = []
        engine.onIntent = { intents.append($0) }

        let down = keyEvent(f17, down: true, flags: .maskAlternate)
        #expect(engine.handleForTesting(type: .keyDown, event: down, at: 0) == nil)
        #expect(engine.handleForTesting(type: .keyDown, event: down, at: 0.1) == nil)
        #expect(intents == [.begin])

        let up = keyEvent(f17, down: false, flags: .maskAlternate)
        #expect(engine.handleForTesting(type: .keyUp, event: up, at: 1) == nil)
        #expect(intents == [.begin, .finalize])
    }

    @Test func optionReleaseEndsChordAndResidualF17UpIsConsumedOnce() {
        let engine = EventTapEngine(key: .optionF17)
        var intents: [HotkeyIntent] = []
        engine.onIntent = { intents.append($0) }

        #expect(engine.handleForTesting(
            type: .flagsChanged,
            event: keyEvent(58, down: true, flags: .maskAlternate),
            at: -0.1
        ) != nil, "Option alone must pass through")
        #expect(engine.handleForTesting(
            type: .keyDown,
            event: keyEvent(f17, down: true, flags: .maskAlternate),
            at: 0
        ) == nil)
        #expect(engine.handleForTesting(
            type: .flagsChanged,
            event: keyEvent(58, down: false),
            at: 1
        ) != nil, "Option's down event passed through, so its release must also pass through")
        #expect(intents == [.begin, .finalize])
        #expect(engine.handleForTesting(type: .keyUp, event: keyEvent(f17, down: false), at: 1.1) == nil)
        #expect(intents == [.begin, .finalize])

        #expect(engine.handleForTesting(
            type: .flagsChanged,
            event: keyEvent(58, down: false),
            at: 2
        ) != nil, "an unrelated Option release must pass through")
    }

    @Test func unmatchedKeysPassThroughAndKeepExistingAccidentalChordGrammar() {
        let engine = EventTapEngine(key: .optionF17)
        var intents: [HotkeyIntent] = []
        engine.onIntent = { intents.append($0) }

        #expect(engine.handleForTesting(type: .keyDown, event: keyEvent(f17, down: true), at: 0) != nil)
        #expect(engine.handleForTesting(type: .keyUp, event: keyEvent(f17, down: false), at: 0.1) != nil)
        #expect(intents.isEmpty)

        #expect(engine.handleForTesting(
            type: .keyDown,
            event: keyEvent(f17, down: true, flags: .maskAlternate),
            at: 1
        ) == nil)
        #expect(engine.handleForTesting(type: .keyDown, event: keyEvent(0, down: true), at: 1.2) != nil)
        #expect(intents == [.begin, .abortAccidental])
        #expect(engine.handleForTesting(
            type: .keyUp,
            event: keyEvent(f17, down: false, flags: .maskAlternate),
            at: 1.3
        ) == nil)
    }

    @Test func optionF17DoesNotConsumeAdditionalModifierShortcuts() {
        for extra: CGEventFlags in [.maskShift, .maskControl, .maskCommand] {
            let engine = EventTapEngine(key: .optionF17)
            var intents: [HotkeyIntent] = []
            engine.onIntent = { intents.append($0) }
            let event = keyEvent(f17, down: true, flags: [.maskAlternate, extra])
            #expect(engine.handleForTesting(type: .keyDown, event: event, at: 0) != nil)
            #expect(intents.isEmpty)
        }
    }

    @Test func shiftOptionF17TogglesMeetingOnlyWhenAHandlerIsInstalled() {
        let engine = EventTapEngine(key: .optionF17)
        var intents: [HotkeyIntent] = []
        var toggles = 0
        engine.onIntent = { intents.append($0) }
        engine.onMeetingToggle = { toggles += 1 }
        let chord: CGEventFlags = [.maskAlternate, .maskShift]
        #expect(engine.handleForTesting(type: .keyDown, event: keyEvent(f17, down: true, flags: chord), at: 0) == nil)
        let repeated = keyEvent(f17, down: true, flags: chord)
        repeated.setIntegerValueField(.keyboardEventAutorepeat, value: 1)
        #expect(engine.handleForTesting(type: .keyDown, event: repeated, at: 0.1) == nil, "autorepeat stays consumed")
        #expect(engine.handleForTesting(type: .keyUp, event: keyEvent(f17, down: false, flags: chord), at: 0.2) == nil)
        #expect(toggles == 1)
        #expect(intents.isEmpty, "a meeting toggle never starts, locks or cancels dictation")
        #expect(engine.handleForTesting(type: .keyDown, event: keyEvent(f17, down: true, flags: [.maskAlternate, .maskControl]), at: 1) != nil,
                "other modifier combinations still pass through")
        #expect(toggles == 1)
    }

    @Test func unmatchedAutorepeatDoesNotStartRecording() {
        let engine = EventTapEngine(key: .optionF17)
        var intents: [HotkeyIntent] = []
        engine.onIntent = { intents.append($0) }
        let event = keyEvent(f17, down: true, flags: .maskAlternate)
        event.setIntegerValueField(.keyboardEventAutorepeat, value: 1)
        #expect(engine.handleForTesting(type: .keyDown, event: event, at: 0) != nil)
        #expect(intents.isEmpty)
    }

    @Test func optionF17SupportsSpaceLockEscapeAndDoubleTapGrammar() {
        let engine = EventTapEngine(key: .optionF17)
        var intents: [HotkeyIntent] = []
        engine.onIntent = { intents.append($0) }

        let chordDown = keyEvent(f17, down: true, flags: .maskAlternate)
        let chordUp = keyEvent(f17, down: false, flags: .maskAlternate)
        #expect(engine.handleForTesting(type: .keyDown, event: chordDown, at: 0) == nil)
        #expect(engine.handleForTesting(type: .keyDown, event: keyEvent(49, down: true), at: 0.5) == nil)
        #expect(engine.handleForTesting(type: .keyUp, event: chordUp, at: 0.6) == nil)
        #expect(intents == [.begin, .lockIn])
        #expect(engine.handleForTesting(type: .keyDown, event: keyEvent(53, down: true), at: 1) == nil)
        #expect(intents == [.begin, .lockIn, .cancel])

        let doubleTapEngine = EventTapEngine(key: .optionF17)
        doubleTapEngine.setDoubleTapLockEnabled(true)
        doubleTapEngine.setSingleTapHandsFreeEnabled(false)
        var doubleTapIntents: [HotkeyIntent] = []
        doubleTapEngine.onIntent = { doubleTapIntents.append($0) }
        #expect(doubleTapEngine.handleForTesting(type: .keyDown, event: chordDown, at: 2) == nil)
        #expect(doubleTapEngine.handleForTesting(type: .keyUp, event: chordUp, at: 2.1) == nil)
        #expect(doubleTapEngine.handleForTesting(type: .keyDown, event: chordDown, at: 2.2) == nil)
        #expect(doubleTapEngine.handleForTesting(type: .keyUp, event: chordUp, at: 2.3) == nil)
        #expect(doubleTapIntents == [.begin, .lockIn])
    }

    // MARK: Module gates (Bento turns Dictation and the Assistant on separately)

    @Test func disabledDictationKeyPassesThroughUntilReenabled() {
        let engine = EventTapEngine(key: .optionF17)
        var intents: [HotkeyIntent] = []
        engine.onIntent = { intents.append($0) }
        let down = keyEvent(f17, down: true, flags: .maskAlternate)
        let up = keyEvent(f17, down: false, flags: .maskAlternate)

        engine.setDictationKeyEnabled(false)
        #expect(engine.handleForTesting(type: .keyDown, event: down, at: 0) != nil,
                "with Dictation off, Option-F17 is an ordinary shortcut")
        #expect(engine.handleForTesting(type: .keyUp, event: up, at: 1) != nil)
        #expect(intents.isEmpty)

        engine.setDictationKeyEnabled(true)
        #expect(engine.handleForTesting(type: .keyDown, event: down, at: 2) == nil)
        #expect(engine.handleForTesting(type: .keyUp, event: up, at: 3) == nil)
        #expect(intents == [.begin, .finalize])
    }

    @Test func disabledFnKeyPassesThrough() {
        let engine = EventTapEngine(key: .fn)
        var intents: [HotkeyIntent] = []
        engine.onIntent = { intents.append($0) }
        let press = keyEvent(63, down: true, flags: .maskSecondaryFn)
        let release = keyEvent(63, down: false)

        engine.setDictationKeyEnabled(false)
        #expect(engine.handleForTesting(type: .flagsChanged, event: press, at: 0) != nil)
        #expect(engine.handleForTesting(type: .flagsChanged, event: release, at: 1) != nil)
        #expect(intents.isEmpty)

        engine.setDictationKeyEnabled(true)
        #expect(engine.handleForTesting(type: .flagsChanged, event: press, at: 2) == nil)
        #expect(engine.handleForTesting(type: .flagsChanged, event: release, at: 3) == nil)
        #expect(intents == [.begin, .finalize])
    }

    @Test func disabledAssistantKeysLetOptionF18PassThrough() {
        let engine = EventTapEngine(key: .optionF17)
        var intents: [HotkeyIntent] = []
        engine.onIntent = { intents.append($0) }
        let f18Down = keyEvent(79, down: true, flags: .maskAlternate)
        let f18Up = keyEvent(79, down: false, flags: .maskAlternate)

        #expect(engine.handleForTesting(type: .keyDown, event: f18Down, at: 0) == nil, "on by default: voice editing")
        #expect(engine.handleForTesting(type: .keyUp, event: f18Up, at: 1) == nil)
        #expect(intents == [.beginEditing, .finalize])

        engine.setAssistantKeysEnabled(false)
        #expect(engine.handleForTesting(type: .keyDown, event: f18Down, at: 2) != nil)
        #expect(engine.handleForTesting(type: .keyUp, event: f18Up, at: 3) != nil)
        let toggle = keyEvent(79, down: true, flags: [.maskAlternate, .maskShift])
        #expect(engine.handleForTesting(type: .keyDown, event: toggle, at: 4) != nil)
        #expect(intents == [.beginEditing, .finalize], "no assistant gesture while the Assistant is off")

        #expect(engine.handleForTesting(type: .keyDown, event: keyEvent(f17, down: true, flags: .maskAlternate), at: 5) == nil,
                "the dictation key is unaffected")
        #expect(intents == [.beginEditing, .finalize, .begin])
    }

    @Test func shiftOptionF18TogglesTheAssistantOnlyWhileClaimed() {
        let engine = EventTapEngine(key: .optionF17)
        var intents: [HotkeyIntent] = []
        engine.onIntent = { intents.append($0) }
        let chord: CGEventFlags = [.maskAlternate, .maskShift]

        #expect(engine.handleForTesting(type: .keyDown, event: keyEvent(79, down: true, flags: chord), at: 0) == nil,
                "claimed by default")
        #expect(engine.handleForTesting(type: .keyUp, event: keyEvent(79, down: false, flags: chord), at: 0.1) == nil)
        #expect(intents == [.toggleAssistant])

        engine.setClaimsAssistantWindowToggle(false)
        #expect(engine.handleForTesting(type: .keyDown, event: keyEvent(79, down: true, flags: chord), at: 1) != nil,
                "Bento binds the chord as an ordinary shortcut instead")
        #expect(engine.handleForTesting(type: .keyUp, event: keyEvent(79, down: false, flags: chord), at: 1.1) != nil)
        #expect(intents == [.toggleAssistant])

        #expect(engine.handleForTesting(type: .keyDown, event: keyEvent(79, down: true, flags: .maskAlternate), at: 2) == nil,
                "Option-F18 alone still edits by voice")
        #expect(engine.handleForTesting(type: .keyUp, event: keyEvent(79, down: false, flags: .maskAlternate), at: 3) == nil)
        #expect(intents == [.toggleAssistant, .beginEditing, .finalize])
    }

    /// Dictate to Assistant is a rebindable shortcut (⌃⌥F18 by default): the
    /// tap must hand both edges on to it, calls or not, and while the request
    /// it started is recording (when Esc still cancels).
    @Test func controlOptionF18PassesThroughToTheDictateToAssistantShortcut() {
        let engine = EventTapEngine(key: .optionF17)
        var intents: [HotkeyIntent] = []
        engine.onIntent = { intents.append($0) }
        let chord: CGEventFlags = [.maskAlternate, .maskControl]
        for calls in [false, true] {
            engine.setAssistantLiveCall(calls)
            #expect(engine.handleForTesting(type: .keyDown, event: keyEvent(79, down: true, flags: chord), at: 0) != nil)
            #expect(engine.handleForTesting(type: .keyUp, event: keyEvent(79, down: false, flags: chord), at: 0.5) != nil)
        }
        engine.setExternalSessionActive(true)
        #expect(engine.handleForTesting(type: .keyDown, event: keyEvent(79, down: true, flags: chord), at: 1) != nil)
        #expect(engine.handleForTesting(type: .keyUp, event: keyEvent(79, down: false, flags: chord), at: 1.1) != nil)
        #expect(intents.isEmpty)
        #expect(engine.handleForTesting(type: .keyDown, event: keyEvent(53, down: true), at: 2) == nil)
        #expect(intents == [.cancel])
    }
}

private extension EventTapEngine {
    /// The event tap borrows its input from macOS and returns it unretained.
    /// Tests create temporary inputs, so keep the input alive until the result
    /// becomes an owned reference that a test can safely inspect or describe.
    func handleForTesting(type: CGEventType, event: CGEvent, at now: TimeInterval) -> CGEvent? {
        withExtendedLifetime(event) {
            handle(type: type, event: event, at: now)?.takeUnretainedValue()
        }
    }
}
