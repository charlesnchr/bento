import Testing
import VoiceCore
@testable import Voice

@MainActor
@Suite struct DictationSoundTests {
    @Test func handsFreeSessionPlaysSingleStartSound() {
        let states: [DictationState] = [
            .warming,
            .recording(locked: false),
            .recording(locked: true),
            .finalizing,
            .transcribing,
            .inserting,
            .done(.inserted),
        ]
        let sounds = states.compactMap { PillPresenter.earcon(for: $0) }
        #expect(sounds == [.start, .stop, .success])
    }

    @Test func lockingHandsFreeIsAlwaysSilent() {
        #expect(PillPresenter.earcon(for: .recording(locked: false)) == nil)
        #expect(PillPresenter.earcon(for: .recording(locked: true)) == nil)
    }

    @Test func cancelOnlySoundsAfterDeliberateRecording() {
        #expect(PillPresenter.earcon(for: .cancelled, sessionDuration: nil) == nil)
        #expect(PillPresenter.earcon(for: .cancelled, sessionDuration: 0.2) == nil)
        #expect(PillPresenter.earcon(for: .cancelled, sessionDuration: 0.5) == nil)
        #expect(PillPresenter.earcon(for: .cancelled, sessionDuration: 0.6) == .cancel)
    }

    @Test func outcomeAndFailureSounds() {
        #expect(PillPresenter.earcon(for: .done(.inserted)) == .success)
        #expect(PillPresenter.earcon(for: .done(.copiedToClipboard)) == .success)
        #expect(PillPresenter.earcon(for: .done(.inserted), assistantBusy: true) == nil)
        #expect(PillPresenter.earcon(for: .done(.silent)) == nil)
        #expect(PillPresenter.earcon(for: .done(.awaitingChip)) == nil)
        #expect(PillPresenter.earcon(for: .done(.heldForSecureField)) == nil)
        #expect(PillPresenter.earcon(for: .done(.queuedForRetry)) == nil)
        #expect(PillPresenter.earcon(for: .failed(.network)) == .error)
    }
}
