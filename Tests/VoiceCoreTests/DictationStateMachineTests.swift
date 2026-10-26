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

@Suite struct DictationStateMachineTests {
    private func run(_ events: [DictationEvent], from start: DictationState = .idle) -> DictationState {
        events.reduce(start) { state, event in
            DictationStateMachine.transition(state, on: event) ?? state
        }
    }

    // MARK: Happy paths

    @Test func holdSpeakReleaseInsert() {
        let final = run([.hotkeyBegin, .engineStarted, .finalize, .audioFinalized, .transcriptReady, .inserted])
        #expect(final == .done(.inserted))
    }

    @Test func handsFreeLockThenStop() {
        var state = run([.hotkeyBegin, .engineStarted, .lockIn])
        #expect(state == .recording(locked: true))
        state = run([.finalize, .audioFinalized, .transcriptReady, .inserted], from: state)
        #expect(state == .done(.inserted))
    }

    // MARK: Cancellation & accidents

    @Test func escCancelsWhileRecording() {
        #expect(run([.hotkeyBegin, .engineStarted, .cancel]) == .cancelled)
    }

    @Test func accidentalChordAbortsWarming() {
        #expect(run([.hotkeyBegin, .abortAccidental]) == .cancelled)
    }

    @Test func escCancelsDuringTranscription() {
        let final = run([.hotkeyBegin, .engineStarted, .finalize, .audioFinalized, .cancel])
        #expect(final == .cancelled)
    }

    @Test func cannotCancelDuringInsertion() {
        let inserting = run([.hotkeyBegin, .engineStarted, .finalize, .audioFinalized, .transcriptReady])
        #expect(inserting == .inserting)
        #expect(DictationStateMachine.transition(inserting, on: .cancel) == nil)
    }

    // MARK: Failure paths (never lose words)

    @Test func releaseBeforeEngineStartStillFinalizes() {
        // Ultra-quick press-release: audio from t=0 must still be processed.
        #expect(run([.hotkeyBegin, .finalize]) == .finalizing)
    }

    @Test func zeroBuffersIsAnErrorNeverEmptyTranscript() {
        let final = run([.hotkeyBegin, .engineStarted, .finalize, .noAudioCaptured])
        #expect(final == .failed(.noAudio))
    }

    @Test func silenceOnlyIsCalmNotAnError() {
        let final = run([.hotkeyBegin, .engineStarted, .finalize, .silenceOnly])
        #expect(final == .done(.silent))
    }

    @Test func offlineQueuesForRetry() {
        let final = run([.hotkeyBegin, .engineStarted, .finalize, .audioFinalized, .queuedForRetry])
        #expect(final == .done(.queuedForRetry))
    }

    @Test func midRecordingEngineDeathPreservesAudio() {
        let final = run([.hotkeyBegin, .engineStarted, .engineFailed(.audio)])
        #expect(final == .finalizing, "captured audio must flow to finalize, not be dropped")
    }

    @Test func warmingEngineFailureCarriesHonestReason() {
        let final = run([.hotkeyBegin, .engineFailed(.noMicrophone)])
        #expect(final == .failed(.noMicrophone))
    }

    @Test func transcriptionFailureCarriesReason() {
        let final = run([.hotkeyBegin, .engineStarted, .finalize, .audioFinalized, .transcriptFailed(.auth)])
        #expect(final == .failed(.auth))
    }

    @Test func focusChangeNeverBlindPastes() {
        let final = run([.hotkeyBegin, .engineStarted, .finalize, .audioFinalized, .transcriptReady, .frontmostChangedAwaitingChip])
        #expect(final == .done(.awaitingChip))
    }

    @Test func secureFieldHoldsTextInHistoryOnly() {
        let final = run([.hotkeyBegin, .engineStarted, .finalize, .audioFinalized, .transcriptReady, .insertionBlockedSecure])
        #expect(final == .done(.heldForSecureField))
    }

    // MARK: Invalid / stale events are ignored

    @Test func staleEventsReturnNil() {
        #expect(DictationStateMachine.transition(.idle, on: .finalize) == nil)
        #expect(DictationStateMachine.transition(.idle, on: .transcriptReady) == nil)
        #expect(DictationStateMachine.transition(.done(.inserted), on: .inserted) == nil)
        #expect(DictationStateMachine.transition(.cancelled, on: .transcriptReady) == nil)
        #expect(DictationStateMachine.transition(.recording(locked: false), on: .hotkeyBegin) == nil)
    }

    @Test func doubleLockIsIgnored() {
        let locked = DictationState.recording(locked: true)
        #expect(DictationStateMachine.transition(locked, on: .lockIn) == nil)
    }

    @Test func terminalStatesAreTerminal() {
        for state in [DictationState.done(.inserted), .cancelled, .failed(.network)] {
            #expect(state.isTerminal)
            for event in [DictationEvent.hotkeyBegin, .finalize, .transcriptReady, .inserted] {
                #expect(DictationStateMachine.transition(state, on: event) == nil)
            }
        }
    }
}
