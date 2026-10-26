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

@Suite struct TimeoutPolicyTests {
    @Test func overallDeadlineScalesGently() {
        #expect(abs(TimeoutPolicy.overallDeadline(audioDuration: 5) - 31.25) <= 0.01)
        #expect(abs(TimeoutPolicy.overallDeadline(audioDuration: 30) - 37.5) <= 0.01)
        // 10-minute cap case: ~2.5 minutes, never the old 2×duration (20 min) formula.
        #expect(abs(TimeoutPolicy.overallDeadline(audioDuration: 600) - 180) <= 0.01)
    }

    @Test func slowStateFiresWellBeforeFirstByteDeadline() {
        #expect(TimeoutPolicy.slowStateUI < TimeoutPolicy.timeToFirstByte)
    }
}
