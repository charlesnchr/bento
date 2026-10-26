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

/// The native smart transcription surface. Fixtures are real responses captured
/// from the live API on 2026-08-20, not hand-written guesses.
@Suite struct TranscriptionConfigTests {

    /// THE test in this file.
    ///
    /// `{"mode":"smart","language_codes":["en-US"]}` returns VERBATIM output with
    /// HTTP 200 and no error — smart mode is silently disabled, and there is no
    /// runtime signal of any kind. The published example pairs them, so this is
    /// exactly how the regression would arrive: someone adds locale support, every
    /// dictation quietly stops being cleaned up, and nothing anywhere reports it.
    @Test func neverSendsLanguageCodes() {
        for mode in GeminiClient.TranscriptionMode.allCases {
            for vocabulary in [[], ["Spanner"], ["Ammaar", "Kubernetes"]] {
                let config = GeminiClient.transcriptionConfig(mode: mode, customVocabulary: vocabulary)
                #expect(config?["language_codes"] == nil, "language_codes silently disables smart mode — \(mode), \(vocabulary)")
                #expect(config?["languageCodes"] == nil, "camelCase spelling is the same landmine")
            }
        }
    }

    /// Verbatim is the server default: sending the field is byte-identical to
    /// omitting it, so we omit it and keep the request minimal.
    @Test func verbatimOmitsConfigEntirely() {
        #expect(GeminiClient.transcriptionConfig(mode: .verbatim, customVocabulary: []) == nil)
    }

    @Test func smartCarriesModeAndVocabulary() {
        let config = GeminiClient.transcriptionConfig(mode: .smart, customVocabulary: ["Kubernetes"])
        #expect(config?["mode"] as? String == "smart")
        #expect(config?["custom_vocabulary"] as? [String] == ["Kubernetes"])
    }

    /// Vocabulary must survive on the verbatim path too — it biases the
    /// recogniser, which is orthogonal to whether the model reformats.
    @Test func verbatimStillCarriesVocabulary() {
        let config = GeminiClient.transcriptionConfig(mode: .verbatim, customVocabulary: ["Kubernetes"])
        #expect(config?["custom_vocabulary"] as? [String] == ["Kubernetes"])
        #expect(config?["mode"] == nil, "verbatim is the default; naming it buys nothing")
    }
}

@Suite struct InteractionsEnvelopeTests {

    private func data(_ json: String) -> Data { json.data(using: .utf8)! }

    /// A real captured response, trimmed.
    @Test func parsesRealEnvelope() throws {
        let body = data("""
        {"id":"interaction-1","object":"interaction","model":"gemini-3.5-transcribe",
         "status":"completed","created":"2026-08-20T12:00:00Z",
         "steps":[{"type":"model_output","content":[{"type":"text","text":"Let's meet at 2pm."}]}],
         "usage":{"total_input_tokens":268,"total_output_tokens":0}}
        """)
        #expect(try GeminiClient.extractInteractionText(from: body) == "Let's meet at 2pm.")
    }

    @Test func joinsMultipleStepsAndTextItems() throws {
        let body = data("""
        {"status":"completed","steps":[
          {"type":"model_output","content":[{"type":"text","text":"one "},{"type":"text","text":"two "}]},
          {"type":"model_output","content":[{"type":"text","text":"three"}]}]}
        """)
        #expect(try GeminiClient.extractInteractionText(from: body) == "one two three")
    }

    /// Non-model_output steps (tool calls, reasoning) must not leak into the
    /// text that gets typed at the user's cursor.
    @Test func ignoresNonModelOutputSteps() throws {
        let body = data("""
        {"status":"completed","steps":[
          {"type":"tool_use","content":[{"type":"text","text":"SHOULD NOT APPEAR"}]},
          {"type":"model_output","content":[{"type":"text","text":"kept"}]}]}
        """)
        #expect(try GeminiClient.extractInteractionText(from: body) == "kept")
    }

    /// Empty must come back as "" and NOT throw: the service owns the
    /// empty-transcript re-send and the coordinator classifies silence by audio
    /// energy. Throwing here would route a quiet dictation into the failure path
    /// and, for a short quiet hold, into discardSessionArtifacts().
    @Test func emptyTextReturnsEmptyStringRatherThanThrowing() throws {
        let body = data("""
        {"status":"completed","steps":[{"type":"model_output","content":[]}]}
        """)
        #expect(try GeminiClient.extractInteractionText(from: body) == "")
    }

    /// An unknown status is RETRYABLE on purpose. Under never-lose-words the safe
    /// direction on a string we have never seen is keeping the row queued, not
    /// marking the dictation permanently failed.
    @Test func unknownStatusIsRetryable() throws {
        let body = data(#"{"status":"queued","steps":[]}"#)
        let error = #expect(throws: TranscriptionError.self) {
            try GeminiClient.extractInteractionText(from: body)
        }
        guard case .network? = error else {
            Issue.record("unknown status must map to .network (retryable), got \(String(describing: error))")
            return
        }
    }

    @Test func failedWithSafetyDetailMapsToSafetyBlocked() {
        let error = GeminiClient.mapInteractionStatus(
            "failed", json: ["error": ["message": "Response blocked by safety filters"]]
        )
        #expect(error == .safetyBlocked)
    }

    @Test func failedWithoutSafetyDetailIsRetryable() {
        let error = GeminiClient.mapInteractionStatus("failed", json: [:])
        guard case .network = error else {
            Issue.record("a bare failure should stay retryable, got \(error)")
            return
        }
    }

    /// The two endpoints do not share an error envelope: interactions
    /// array-wraps auth errors. Casting straight to [String: Any] yields nil and
    /// the user sees "http_400" instead of "API key not valid".
    @Test func errorMessageParsesArrayWrappedEnvelope() {
        let wrapped = data(#"[{"error":{"code":400,"message":"API key not valid."}}]"#)
        #expect(GeminiClient.errorMessage(from: wrapped) == "API key not valid.")

        let plain = data(#"{"error":{"code":400,"message":"API key not valid."}}"#)
        #expect(GeminiClient.errorMessage(from: plain) == "API key not valid.")
    }

    /// interactions reports `code` as a String ("not_found") where
    /// generateContent reports an Int. We only read `message`, so this is a
    /// regression guard on that staying true.
    @Test func errorMessageSurvivesStringCode() {
        let body = data(#"{"error":{"code":"not_found","message":"Model 'x' not found."}}"#)
        #expect(GeminiClient.errorMessage(from: body) == "Model 'x' not found.")
    }
}
