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

@Suite struct ReplacementEngineTests {
    private func rule(_ wrong: String, _ right: String) -> ReplacementEngine.Rule {
        .init(wrong: wrong, right: right)
    }

    @Test func basicReplacement() {
        let out = ReplacementEngine.apply([rule("cooper netties", "Kubernetes")], to: "deploy the cooper netties cluster")
        #expect(out == "deploy the Kubernetes cluster")
    }

    @Test func wordBoundaryRespected() {
        let out = ReplacementEngine.apply([rule("cat", "dog")], to: "the category has a cat")
        #expect(out == "the category has a dog")
    }

    @Test func longestMatchWins() {
        let out = ReplacementEngine.apply(
            [rule("gemini", "Gemini"), rule("gemini api", "Gemini API")],
            to: "open gemini api now"
        )
        #expect(out == "open Gemini API now")
    }

    @Test func explicitCasingCarries() {
        let out = ReplacementEngine.apply([rule("g r p c", "gRPC")], to: "The G R P C endpoint")
        #expect(out == "The gRPC endpoint")
    }

    @Test func caseInsensitiveMatching() {
        let out = ReplacementEngine.apply([rule("genny", "Gemini")], to: "Genny is fast. genny wins.")
        #expect(out == "Gemini is fast. Gemini wins.")
    }

    @Test func lowercaseRulePropagatesSentenceCase() {
        let out = ReplacementEngine.apply([rule("standup", "stand-up")], to: "Standup at nine. The standup ran long.")
        #expect(out == "Stand-up at nine. The stand-up ran long.")
    }

    @Test func noRulesIsIdentity() {
        #expect(ReplacementEngine.apply([], to: "unchanged") == "unchanged")
    }

    @Test func multipleOccurrences() {
        let out = ReplacementEngine.apply([rule("amar", "Ammaar")], to: "amar told amar's team")
        #expect(out == "Ammaar told Ammaar's team")
    }
}
