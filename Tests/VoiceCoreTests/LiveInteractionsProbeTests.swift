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

/// A LIVE check against the real API, through the real `GeminiClient` — not curl.
/// Unit tests cover the pure parsing; this covers the thing that actually ships.
///
/// Disabled unless explicitly opted in, so it never runs in a normal build:
///
///   BENTO_VOICE_LIVE_PROBE=1 GEMINI_API_KEY=... BENTO_VOICE_PROBE_AUDIO=/path/to/clip.flac \
///     scripts/test VoiceCoreTests
///
/// The clip should contain filler words and a self-correction, e.g.
/// "umm, so let's meet at 1pm — actually, no, make it 2pm".
@Suite(.enabled(if: LiveProbe.optedIn, "live probe: needs the network and credentials; set BENTO_VOICE_LIVE_PROBE=1"))
struct LiveInteractionsProbeTests {
    // Disabled, not failed, on a missing fixture: opting into the live suite
    // without an audio file is an incomplete setup, not a broken build.
    static var hasFixture: Bool { LiveProbe.key != nil && LiveProbe.audioPath != nil }
    static let fixtureMissing: Comment = "needs GEMINI_API_KEY and BENTO_VOICE_PROBE_AUDIO (path to a FLAC/WAV clip)"

    private func requireOptIn() throws -> (GeminiClient, Data, GeminiConfig) {
        let key = try #require(LiveProbe.key)
        let path = try #require(LiveProbe.audioPath)
        let audio = try Data(contentsOf: URL(fileURLWithPath: path))
        return (GeminiClient(apiKey: { key }), audio, GeminiConfig())
    }

    /// The default path end to end: smart mode must collapse the self-correction
    /// and drop the fillers.
    @Test(.enabled(if: hasFixture, fixtureMissing))
    func smartModeCleansThroughTheShippingClient() async throws {
        let (client, audio, config) = try requireOptIn()
        let text = try await client.transcribeInteraction(
            audio: audio, model: config.transcribeModel, endpoint: config.endpoint,
            mode: .smart, customVocabulary: [], deadline: 60
        )
        #expect(!text.isEmpty, "smart mode returned nothing — the classic silent failure")
        #expect(!text.lowercased().contains("umm"), "fillers should be gone: \(text)")
        #expect(!text.lowercased().contains("actually, no"), "self-correction should collapse: \(text)")
        print("SMART → \(text)")
    }

    /// Verbatim must NOT clean, otherwise the "exact transcription" promise in
    /// Settings is false.
    @Test(.enabled(if: hasFixture, fixtureMissing))
    func verbatimKeepsTheFillers() async throws {
        let (client, audio, config) = try requireOptIn()
        let text = try await client.transcribeInteraction(
            audio: audio, model: config.transcribeModel, endpoint: config.endpoint,
            mode: .verbatim, customVocabulary: [], deadline: 60
        )
        #expect(!text.isEmpty)
        print("VERBATIM → \(text)")
    }

    /// The landmine, asserted against the live API rather than only in a comment:
    /// adding language_codes silently reverts smart mode to verbatim. If this ever
    /// starts passing, the server fixed it and the chokepoint can be relaxed.
    @Test(.enabled(if: hasFixture, fixtureMissing))
    func languageCodesStillBreaksSmartMode() async throws {
        let (client, audio, config) = try requireOptIn()
        let smart = try await client.transcribeInteraction(
            audio: audio, model: config.transcribeModel, endpoint: config.endpoint,
            mode: .smart, customVocabulary: [], deadline: 60
        )
        // Reproduce the broken request by hand — the shipping chokepoint refuses
        // to build it, which is the whole point.
        let broken = try await Self.rawInteraction(
            key: try #require(LiveProbe.key),
            audio: audio, model: config.transcribeModel,
            config: ["mode": "smart", "language_codes": ["en-US"]]
        )
        #expect(smart.trimmingCharacters(in: .whitespacesAndNewlines) != broken.trimmingCharacters(in: .whitespacesAndNewlines),
                "language_codes no longer disables smart mode — re-check the chokepoint comment")
        print("SMART → \(smart)\nWITH language_codes → \(broken)")
    }

    private static func rawInteraction(key: String, audio: Data, model: String, config: [String: Any]) async throws -> String {
        var request = URLRequest(url: URL(string: "https://generativelanguage.googleapis.com/v1beta/interactions")!)
        request.httpMethod = "POST"
        request.setValue(key, forHTTPHeaderField: "x-goog-api-key")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "model": model,
            "input": [["type": "audio", "mime_type": "audio/flac", "data": audio.base64EncodedString()]],
            "generation_config": ["transcription_config": config],
        ])
        let (data, _) = try await URLSession.shared.data(for: request)
        return try GeminiClient.extractInteractionText(from: data)
    }

    /// The bug this fixes: onboarding let a REJECTED key through.
    ///
    /// validateKey returned a bare Bool, so the caller could not tell "the server
    /// said no" from "I could not ask". It fell back to a 1-second NWPathMonitor
    /// probe that false-negatives on a cold monitor, concluded "offline", saved
    /// the unvalidated key and advanced — and because the next visit to that
    /// screen saw a stored key, there was no way back. A user had to uninstall.
    ///
    /// A bad key returns HTTP 400 on this API (not 401), which is exactly why
    /// "only 401 counts as rejection" would have kept the bug alive.
    @Test func aBadKeyIsRejectedNotMerelyUnreachable() async throws {
        let client = GeminiClient(apiKey: { "definitely-not-a-real-key" })
        let check = await client.validateKey(endpoint: GeminiConfig().endpoint)
        guard case .rejected = check else {
            Issue.record("a bad key must be .rejected, got \(check) — onboarding would advance on .unreachable")
            return
        }
    }

    /// The other half: a key that works must come back .valid, or onboarding
    /// would show a scary "couldn't verify" notice to everyone.
    @Test func aRealKeyValidates() async throws {
        let key = try #require(LiveProbe.key)
        let client = GeminiClient(apiKey: { key })
        let check = await client.validateKey(endpoint: GeminiConfig().endpoint)
        #expect(check == .valid)
    }
}
