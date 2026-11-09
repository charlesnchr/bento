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

import AVFoundation
import Foundation
import VoiceCore

/// Keeps one capture graph built and prepared while the app is idle, so a key
/// press pays only `engine.start()`.
///
/// Measured on this machine (Bluetooth route): building the graph costs 75–135ms
/// — `engine.inputNode` alone is 42–68ms of HAL work — and that window is exactly
/// where a user's first words are lost. Preparing is not recording: no audio
/// flows and no microphone indicator appears until start(). That is also why it
/// stays on when running on battery: a prepared graph does no I/O, and without
/// it the same HAL work runs on the main thread at the key press.
///
/// When to build is PrewarmGate's call: only after the HAL has been quiet for
/// two seconds, never beside a running capture or a voice call, one build at a
/// time, and a build that overlapped a HAL change is thrown away. The
/// 2026-11-09 hang (engine.inputNode spinning against coreaudiod for four days)
/// was a build that raced a device change.
///
/// If AVFAudio hangs anyway, BuildWatchdog notices after ten seconds. The build
/// cannot be cancelled in-process, so prewarming turns off (for 24h, across the
/// relaunch) and `onHang` asks the owner to relaunch Bento once nothing is
/// recording. The graph has to live in this process to be useful, so moving the
/// build into a killable helper would build a graph nobody can use.
///
/// Concurrency: a spare is built on its own serial queue (a hung build must not
/// pin a Swift concurrency thread) and only published once fully prepared, so
/// nothing ever touches a graph that is still being built.
@MainActor
final class WarmEnginePool {
    /// A build ran past `BuildWatchdog.hungAfter`. Called once.
    var onHang: (() -> Void)?

    private var spare: AudioCaptureEngine?
    /// The spare predates a default-input change. It is dropped when the HAL
    /// is quiet again, not inside the burst (see refresh()).
    private var spareIsStale = false
    private var gate = PrewarmGate(now: WarmEnginePool.now)
    private var watchdog = BuildWatchdog()
    private var buildNumber = 0
    private var wake: Task<Void, Never>?
    private let hardware = AudioHardwareActivity()

    nonisolated private static let buildQueue = DispatchQueue(label: "com.charles.bento.voice.audio.prewarm", qos: .utility)
    nonisolated private static var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    init() {
        // Nothing is built until dictation or the assistant switches on and
        // calls resume(): HAL activity alone must not warm a microphone the
        // user has turned off.
        gate.setSuspended(true)
        if let hang = PrewarmHangRecord().recentHang(now: Date()) {
            gate.disable()
            Log.audio.error("prewarm: off for this run — a capture-graph build hung at \(hang, privacy: .public); dictation builds its graph at the key press")
        }
        hardware.onActivity = { [weak self] in self?.hardwareChanged() }
        hardware.start()
    }

    /// The engine for a session that is starting right now. The next spare is
    /// built once the session's capture ends and the HAL settles.
    func take() -> AudioCaptureEngine {
        gate.setCaptureActive(true)
        if let spare {
            // A stale spare is still correct: start() sees the device moved
            // and rebuilds.
            self.spare = nil
            spareIsStale = false
            gate.spareGone()
            return spare
        }
        // Cold path (first launch, mic just authorized, device changed): correct,
        // just slower — the session builds its own graph.
        return AudioCaptureEngine()
    }

    /// The dictation's capture started or ended (warming, recording, finalizing).
    func setCaptureActive(_ active: Bool) {
        guard active != gate.captureActive else { return }
        gate.setCaptureActive(active)
        // Stopping an engine moves the route (a Bluetooth headset drops back
        // from its call profile): let that settle before building.
        if !active { gate.noteActivity(at: Self.now) }
        prewarmNext()
    }

    /// Builds a spare if the gate allows it now, or looks again once the HAL
    /// should be quiet.
    func prewarmNext() {
        // Never touch the mic stack before the user has granted access: doing so
        // would trigger the permission prompt out of nowhere.
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else { return }
        switch gate.decide(at: Self.now) {
        case .build: startBuild()
        case .wait(let seconds): scheduleWake(after: seconds)
        case .hold: break
        }
    }

    /// Release prepared dictation I/O while the separate continuous audio mode owns the route.
    func suspend() async {
        gate.setSuspended(true)
        wake?.cancel(); wake = nil
        spare?.discardPrewarm(); spare = nil
        spareIsStale = false
        gate.spareGone()
        // A build in flight would race the call's engine, so wait for it to
        // land (it is discarded on arrival). Never past the hang bound: a hung
        // build must not keep the call from starting.
        let deadline = Self.now + watchdog.hungAfter
        while gate.building, !watchdog.hung, Self.now < deadline {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    func resume() {
        gate.setSuspended(false)
        gate.noteActivity(at: Self.now)
        prewarmNext()
    }

    /// The input device changed under the spare; build a fresh one for the
    /// new route.
    ///
    /// A route change arrives as a burst of HAL notifications, and tearing a
    /// graph down inside that burst is what raced AVAudioIOUnit's property
    /// listeners (field crash, build 42), so the old spare is only dropped once
    /// the gate sees the HAL quiet again.
    func refresh() {
        gate.noteActivity(at: Self.now)
        if spare != nil {
            spareIsStale = true
            gate.spareGone()
        }
        prewarmNext()
    }

    private func hardwareChanged() {
        gate.noteActivity(at: Self.now)
        prewarmNext()
    }

    private func scheduleWake(after seconds: TimeInterval) {
        // One pending look is enough: it asks the gate again, which waits
        // longer if more activity arrived meanwhile.
        guard wake == nil else { return }
        wake = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(max(seconds, 0.05) * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            self.wake = nil
            self.prewarmNext()
        }
    }

    private func startBuild() {
        if spareIsStale, let spare {
            spare.discardPrewarm()
            self.spare = nil
            spareIsStale = false
        }
        let quiet = Self.now - gate.lastActivity
        gate.buildStarted()
        watchdog.begin(at: Self.now)
        buildNumber += 1
        let number = buildNumber
        Log.audio.info("prewarm: building a spare graph (HAL quiet for \(quiet, format: .fixed(precision: 1))s)")
        Task { [weak self] in
            let (engine, outcome) = await Self.build()
            guard let self else { engine.discardPrewarm(); return }
            self.buildLanded(engine, outcome)
        }
        Task { [weak self] in
            while true {
                try? await Task.sleep(nanoseconds: 500_000_000)
                guard let self, self.buildNumber == number, self.watchdog.isTiming else { return }
                switch self.watchdog.check(at: Self.now) {
                case .slow(let seconds)?:
                    Log.audio.warning("prewarm: graph build still running after \(seconds, format: .fixed(precision: 1))s (normal is under 0.2s)")
                case .hung(let seconds)?:
                    self.buildHung(after: seconds)
                    return
                case nil:
                    break
                }
            }
        }
    }

    nonisolated private static func build() async -> (AudioCaptureEngine, PrewarmGate.Outcome) {
        await withCheckedContinuation { continuation in
            buildQueue.async {
                let engine = AudioCaptureEngine()
                guard AudioHardwareActivity.defaultInputLooksSettled() else {
                    continuation.resume(returning: (engine, .unsettled))
                    return
                }
                continuation.resume(returning: (engine, engine.prewarm() ? .built : .failed))
            }
        }
    }

    private func buildLanded(_ engine: AudioCaptureEngine, _ outcome: PrewarmGate.Outcome) {
        let ms = (watchdog.finish(at: Self.now) ?? 0) * 1000
        let hung = watchdog.hung
        let why = hung ? "it landed after being declared hung"
            : gate.suspended ? "audio is suspended for a voice call"
            : "the HAL changed while it was building"
        guard gate.buildFinished(outcome) else {
            engine.discardPrewarm()
            switch outcome {
            case .built:
                Log.audio.info("prewarm: discarded a spare built in \(ms, format: .fixed(precision: 1))ms — \(why, privacy: .public)")
            case .unsettled:
                Log.audio.info("prewarm: skipped — the default input looks mid-change (\(ms, format: .fixed(precision: 1))ms); waiting for the HAL")
            case .failed:
                Log.audio.info("prewarm: build failed after \(ms, format: .fixed(precision: 1))ms; the key press builds its own graph")
            }
            prewarmNext()
            return
        }
        spare = engine
        spareIsStale = false
        Log.audio.info("prewarm: spare ready in \(ms, format: .fixed(precision: 1))ms")
    }

    private func buildHung(after seconds: TimeInterval) {
        gate.disable()
        wake?.cancel(); wake = nil
        PrewarmHangRecord().record(at: Date())
        Log.audio.fault("prewarm: capture-graph build hung — engine.inputNode has not returned after \(seconds, format: .fixed(precision: 0))s. AVFAudio is stuck polling the HAL and keeps coreaudiod busy; it cannot be cancelled in-process. Prewarming is off for 24h; Bento relaunches once no dictation, voice call or meeting is active.")
        onHang?()
    }
}
