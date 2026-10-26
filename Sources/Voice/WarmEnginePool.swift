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
/// flows and no microphone indicator appears until start().
///
/// Concurrency: a spare is built on a utility queue and only published once fully
/// prepared, so nothing ever touches a graph that is still being built.
@MainActor
final class WarmEnginePool {
    private var spare: AudioCaptureEngine?
    private var buildingSpare = false
    private var suspended = false
    private var generation = UUID()
    private var buildTask: Task<AudioCaptureEngine, Never>?

    /// The engine for a session that is starting right now. Immediately begins
    /// building the next spare so back-to-back dictations stay warm.
    func take() -> AudioCaptureEngine {
        defer { prewarmNext() }
        if let spare {
            self.spare = nil
            return spare
        }
        // Cold path (first launch, mic just authorized, device changed): correct,
        // just slower — the session builds its own graph.
        return AudioCaptureEngine()
    }

    func prewarmNext() {
        guard !suspended, spare == nil, !buildingSpare else { return }
        // Never touch the mic stack before the user has granted access: doing so
        // would trigger the permission prompt out of nowhere.
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else { return }
        buildingSpare = true
        let token = generation
        let build = Task.detached(priority: .utility) {
            let engine = AudioCaptureEngine()
            engine.prewarm()
            return engine
        }
        buildTask = build
        Task { [weak self] in
            let engine = await build.value
            guard let self, self.generation == token, !self.suspended else {
                engine.discardPrewarm(); return
            }
            self.buildingSpare = false
            self.buildTask = nil
            self.spare = engine
        }
    }

    /// Release prepared dictation I/O while the separate continuous audio mode owns the route.
    func suspend() async {
        suspended = true; generation = UUID()
        spare?.discardPrewarm(); spare = nil
        if let buildTask { (await buildTask.value).discardPrewarm() }
        buildTask = nil; buildingSpare = false
    }

    func resume() { suspended = false; prewarmNext() }

    /// Drop the spare (e.g. the input device changed under it) and build a fresh
    /// one for the new route.
    ///
    /// Debounced: a route change arrives as a burst of HAL notifications, and
    /// tearing a graph down inside that burst is what raced AVAudioIOUnit's
    /// property listeners (field crash, build 42). Rebuild once it settles.
    func refresh() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 750_000_000)
            guard !Task.isCancelled, let self else { return }
            self.refreshTask = nil
            // A spare still being built targets the old route; let it land and
            // be replaced rather than racing it.
            self.generation = UUID()
            self.buildTask = nil
            self.buildingSpare = false
            self.spare?.discardPrewarm()
            self.spare = nil
            self.prewarmNext()
        }
    }

    private var refreshTask: Task<Void, Never>?
}
