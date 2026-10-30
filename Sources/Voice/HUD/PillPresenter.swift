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

import AppKit
import AVFoundation
import Combine
import VoiceCore

/// Coordinator state → pill, earcons and the status item's visual state. All
/// HUD timing lives here (experience spec is canonical); DictationController
/// decides what happens, this decides how it looks and sounds.
@MainActor
final class PillPresenter {
    private let coordinator: DictationCoordinator
    private let vertexState: VertexRuntimeConfig.State
    private let hud = PillHUDController()
    private let earcons = EarconPlayer.shared
    private var cancellables: Set<AnyCancellable> = []

    private var previousState: DictationState = .idle
    private var sessionStartedAt: Date?
    private var elapsedTimer: Timer?
    private var slowTimer: Timer?
    private var dismissTask: Task<Void, Never>?

    var onStatusItemState: ((VoiceIndicator) -> Void)?
    /// An assistant turn owns the pill while it runs.
    var isAssistantBusy: () -> Bool = { false }

    init(coordinator: DictationCoordinator, vertexState: VertexRuntimeConfig.State) {
        self.coordinator = coordinator
        self.vertexState = vertexState
        bind()
    }

    /// Only once the engine is active is there a pill to paint into.
    func show() { hud.show() }
    func hide() { hud.hide() }

    /// With the Dictation module off there is no resting dot to click.
    var showsRestingDot = true

    var isResting: Bool { hud.model.state == .idleDot || hud.model.state == .hidden }

    // MARK: - Coordinator streams

    /// Matches GeminiSweep's duration — the finished sentence stays up exactly
    /// as long as the sweep across it takes.
    private static let correctionHold: TimeInterval = 1.5
    private var correctionHoldUntil = Date.distantPast
    private var correctionDeferral: DispatchWorkItem?

    private func bind() {
        coordinator.$micLevel
            .receive(on: DispatchQueue.main)
            .sink { [weak self] level in
                self?.hud.model.level = level
            }
            .store(in: &cancellables)

        coordinator.$coachingHint
            .compactMap { $0 }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] hint in
                self?.showNotice(hint, for: 3.0, sound: nil)
            }
            .store(in: &cancellables)

        // Deliberately NOT routed through coachingHint: that sink calls
        // showNotice(for: 3.0), which would arm a fresh three-second dismiss
        // timer on every token and leave the pill flickering between states for
        // the whole dictation.
        coordinator.$partialTranscript
            .receive(on: DispatchQueue.main)
            .sink { [weak self] text in
                guard let self else { return }
                // The session ends immediately after the correction lands, which
                // clears this — and clearing it mid-sweep means the animation the
                // whole treatment exists for is never actually seen. How long the
                // finished sentence stays on screen is a display decision, so the
                // display layer makes it: ignore the clear until the sweep is done.
                if text.isEmpty, Date() < self.correctionHoldUntil { return }
                self.hud.model.partial = text
            }
            .store(in: &cancellables)

        coordinator.$correctedTranscript
            .receive(on: DispatchQueue.main)
            .sink { [weak self] text in
                guard let self, !text.isEmpty else { return }
                self.hud.model.corrected = text
                self.hud.model.correction = self.coordinator.correctionSegments
                // An edit needs longer on screen than a plain swap: the marked
                // words have to be readable before they collapse.
                let hold = self.coordinator.correctionSegments.isEmpty
                    ? Self.correctionHold
                    : CorrectionView.total + 0.35
                self.correctionHoldUntil = Date().addingTimeInterval(hold)
                // Clear it ourselves once the sweep has run, so the pill does not
                // carry the last dictation's words into the next one.
                DispatchQueue.main.asyncAfter(deadline: .now() + hold) { [weak self] in
                    guard let self, self.coordinator.partialTranscript.isEmpty else { return }
                    self.hud.model.partial = ""
                    self.hud.model.corrected = ""
                    self.hud.model.correction = []
                }
            }
            .store(in: &cancellables)
    }

    // MARK: - State → HUD/earcons (frame-synced: sound fires on the same tick)

    func transition(to state: DictationState) {
        defer { previousState = state }
        dismissTask?.cancel()

        // Background notices deferred during a live session flush once it ends.
        if case .idle = state { flushPendingNotice() }
        if state.isTerminal { flushPendingNotice() }

        switch state {
        case .idle:
            setPill(.idleDot)
            onStatusItemState?(.idle)

        case .warming:
            correctionDeferral?.cancel()
            correctionDeferral = nil
            correctionHoldUntil = .distantPast
            sessionStartedAt = Date()
            earcons.play(.start)
            hud.repositionToActiveScreen() // follow the dictation display (audit L14)
            setPill(.listening(locked: false))
            startElapsedTimer()
            onStatusItemState?(.listening)

        case .recording(let locked):
            if case .recording(false) = previousState, locked {
                earcons.play(.lock)
            }
            setPill(.listening(locked: locked))
            onStatusItemState?(.listening)

        case .finalizing:
            earcons.play(.stop)
            stopElapsedTimer()
            setPill(.processing)
            armSlowTimer()
            onStatusItemState?(.processing)

        case .transcribing, .inserting:
            setPill(.processing)
            onStatusItemState?(.processing)

        case .done(let outcome):
            clearSlowTimer()
            onStatusItemState?(.idle)
            // The text has ALREADY landed at the cursor by now — insertion is not
            // waiting on anything here. What waits is the pill: a correction that
            // just fired needs its sweep to finish, and jumping straight to the
            // success badge cuts it off mid-travel, which is exactly the "it just
            // switched back and showed the new text" complaint. Only the visual
            // is deferred, never the words.
            let remaining = correctionHoldUntil.timeIntervalSinceNow
            if remaining > 0 {
                let work = DispatchWorkItem { [weak self] in self?.handleOutcome(outcome) }
                correctionDeferral?.cancel()
                correctionDeferral = work
                DispatchQueue.main.asyncAfter(deadline: .now() + remaining, execute: work)
            } else {
                handleOutcome(outcome)
            }

        case .cancelled:
            clearSlowTimer()
            stopElapsedTimer()
            onStatusItemState?(.idle)
            // Short accidental taps stay silent; deliberate cancels get the soft damp.
            if let startedAt = sessionStartedAt, Date().timeIntervalSince(startedAt) > 0.5 {
                earcons.play(.cancel)
            }
            setPill(.idleDot)

        case .failed(let failure):
            clearSlowTimer()
            stopElapsedTimer()
            earcons.play(.error)
            // Key/permission problems persist beyond the toast — the menu bar
            // icon carries the attention state until resolved (audit L12).
            onStatusItemState?(failure == .auth || failure == .modelAccess ? .attention : .idle)
            showError(copy(for: failure))
        }
    }

    private func handleOutcome(_ outcome: DictationOutcome) {
        if isAssistantBusy() { setPill(.processing); onStatusItemState?(.processing); return }
        switch outcome {
        case .inserted:
            earcons.play(.success)
            let words = coordinator.lastResult.map { $0.split(separator: " ").count }
            setPill(.success(words: words))
            dismissAfter(0.7)
        case .copiedToClipboard:
            earcons.play(.success)
            showNotice("Copied — press ⌘V to paste", for: 4.0, sound: nil)
        case .awaitingChip:
            showNotice("You switched apps — press ⌘V to paste", for: 5.0, sound: nil)
        case .heldForSecureField:
            showNotice("Secure input is on — saved to History", for: 4.0, sound: nil)
        case .queuedForRetry:
            showNotice("You're offline — saved to History", for: 4.0, sound: nil)
        case .silent:
            consecutiveSilentSessions += 1
            if AVCaptureDevice.authorizationStatus(for: .audio) != .authorized {
                showNotice("Microphone access is off — re-enable it in System Settings → Privacy & Security", for: 5.0, sound: nil)
                onStatusItemState?(.attention)
            } else if coordinator.lastSilenceReason == .tooNoisy {
                // A loud room with nothing above it. The recording is kept, so say
                // where it went — this is the one no-speech case with a Retry.
                showNotice("Too noisy to make out speech — saved to History", for: 4.0, sound: nil)
            } else if consecutiveSilentSessions >= 2 {
                // Twice in a row is a muted/zero-volume mic, not a quiet user.
                showNotice("Didn't catch any speech — check your mic's input volume in System Settings", for: 5.0, sound: nil)
            } else {
                showNotice("Didn't catch any speech", for: 2.0, sound: nil)
            }
        }
        if case .silent = outcome {} else {
            consecutiveSilentSessions = 0
        }
    }

    /// Consecutive no-speech outcomes — two in a row means the MIC is the
    /// problem, and the user deserves better advice than a shrug.
    private var consecutiveSilentSessions = 0

    // MARK: - Pill helpers

    func setPill(_ state: PillState) {
        // "Only while dictating" preference: the resting dot becomes nothing.
        if case .idleDot = state, !showsRestingDot || !SettingsStore().showIdleIndicator {
            hud.model.state = .hidden
        } else {
            hud.model.state = state
        }
        if case .processing = state {} else {
            hud.model.slow = false
        }
    }

    /// Re-applies the resting indicator preference, never touching an active
    /// session's pill.
    func applyIdleIndicatorSetting() {
        if isResting { setPill(.idleDot) }
    }

    /// Notices about BACKGROUND events (retry drain, recovery, auto-degrade)
    /// must never hijack a live session's pill — they wait for it to end.
    /// Session-critical notices (cap warning, device change) still interrupt.
    private var pendingNotice: (message: String, seconds: TimeInterval, sound: EarconPlayer.Earcon?)?

    func showBackgroundNotice(_ message: String, for seconds: TimeInterval, sound: EarconPlayer.Earcon?) {
        switch coordinator.state {
        case .idle, .done, .cancelled, .failed:
            showNotice(message, for: seconds, sound: sound)
        default:
            pendingNotice = (message, seconds, sound)
        }
    }

    private func flushPendingNotice() {
        guard let notice = pendingNotice else { return }
        pendingNotice = nil
        // Give the terminal pill (success check / error chip) its moment first.
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            guard let self else { return }
            switch self.coordinator.state {
            case .idle, .done, .cancelled, .failed:
                self.showNotice(notice.message, for: notice.seconds, sound: notice.sound)
            default:
                // A new session started — re-queue for its end.
                self.pendingNotice = self.pendingNotice ?? notice
            }
        }
    }

    func showNotice(_ message: String, for seconds: TimeInterval, sound: EarconPlayer.Earcon?) {
        if let sound {
            earcons.play(sound)
        }
        setPill(.notice(message))
        dismissAfter(seconds)
    }

    func showError(_ message: String) {
        setPill(.error(message))
        dismissAfter(6.0)
    }

    /// Cancels a pending dismiss, so a notice that is about to be replaced
    /// cannot snap the pill back underneath it.
    func cancelDismiss() { dismissTask?.cancel() }

    private func dismissAfter(_ seconds: TimeInterval) {
        dismissTask?.cancel()
        dismissTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            // Re-derive from coordinator state — a hardcoded .idleDot after the
            // 9-min cap warning stranded a HOT MIC behind the resting dot
            // (production pass 2, P0). Terminal/idle states still land on the dot.
            self.setPill(Self.restingPill(for: self.coordinator.state))
        }
    }

    private static func restingPill(for state: DictationState) -> PillState {
        switch state {
        case .warming: return .listening(locked: false)
        case .recording(let locked): return .listening(locked: locked)
        case .finalizing, .transcribing, .inserting: return .processing
        default: return .idleDot
        }
    }

    // MARK: - Timers

    private func startElapsedTimer() {
        hud.model.elapsed = 0
        elapsedTimer?.invalidate()
        elapsedTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, let startedAt = self.sessionStartedAt else { return }
                self.hud.model.elapsed = Date().timeIntervalSince(startedAt)
            }
        }
    }

    private func stopElapsedTimer() {
        elapsedTimer?.invalidate()
        elapsedTimer = nil
    }

    private func armSlowTimer() {
        slowTimer?.invalidate()
        slowTimer = Timer.scheduledTimer(withTimeInterval: TimeoutPolicy.slowStateUI, repeats: false) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.hud.model.slow = true
            }
        }
    }

    private func clearSlowTimer() {
        slowTimer?.invalidate()
        slowTimer = nil
        hud.model.slow = false
    }

    // MARK: - Copy

    private func copy(for failure: DictationFailure) -> String {
        // On Parakeet a model failure is the on-device model, not a key or a Vertex model.
        let engine = SettingsStore().transcriptionEngine
        if failure == .modelAccess, engine.isLocal {
            return "\(engine.displayName) couldn't load — retry in Settings → Dictation. Saved to History"
        }
        if vertexState.isRequested {
            switch failure {
            case .network: return "Couldn't reach the local Vertex gateway — saved to History"
            case .auth: return "Vertex authentication failed — saved to History"
            case .modelAccess: return "The configured Vertex model is unavailable — saved to History"
            case .badRequest: return "Vertex rejected the request — saved to History"
            case .quotaExhausted: return "Vertex quota reached — saved to History"
            default: break
            }
        }
        switch failure {
        case .network: return "Couldn't reach Gemini — saved to History"
        case .auth:
            return APIKeyStore.loadAPIKey() == nil
                ? "Add your Gemini API key in Settings — recording saved to History"
                : "API key isn't working — saved to History"
        case .modelAccess:
            return SettingsStore().transcribeModelOverride != nil
                ? "That model isn't available to your key — check Settings → Advanced. Saved to History"
                : "Your key can't use the transcription model yet — recording saved to History"
        case .badRequest: return "Gemini rejected the request — saved to History"
        case .rateLimited: return "Rate limited — History will retry it shortly"
        case .noMicrophone: return "No microphone found — connect one to dictate"
        case .quotaExhausted: return "Daily quota reached for your key — check Google AI Studio. Saved to History"
        case .timeout: return "Timed out — saved to History"
        case .validation: return "Couldn't transcribe — saved to History"
        case .safetyBlocked: return "The API declined this one — saved to History"
        case .noAudio: return "Mic didn't start in time — try again"
        case .audio: return "Mic didn't start — try again"
        case .storage: return "Disk problem — couldn't save the audio"
        }
    }
}
