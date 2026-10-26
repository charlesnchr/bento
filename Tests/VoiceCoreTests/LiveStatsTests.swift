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

/// The counters that make live mode's reliability answerable, and the guard that
/// stops a broken live path taxing every dictation.
///
/// Serialized because the tests share one private defaults suite.
@Suite(.serialized) struct LiveStatsTests {

    private let suite = PrivateDefaults("live-stats")
    private var defaults: UserDefaults { suite.defaults }
    private let stats: LiveStats

    init() {
        stats = LiveStats(defaults: suite.defaults)
    }

    @Test func successAndFallbackBothCountAsAttempts() {
        stats.recordSuccess()
        stats.recordFallback(.noFinal)
        stats.recordSuccess()
        #expect(stats.attempts == 3)
        #expect(stats.successes == 2)
        #expect(stats.count(of: .noFinal) == 1)
    }

    /// The guard: three failures in a row stops it, because by then every
    /// dictation is paying for a handshake and then uploading anyway.
    @Test func stopsTryingAfterThreeConsecutiveFailures() {
        #expect(!stats.shouldStopTrying)
        stats.recordFallback(.neverOpened)
        stats.recordFallback(.neverOpened)
        #expect(!stats.shouldStopTrying, "two is a bad moment, not a broken feature")
        stats.recordFallback(.neverOpened)
        #expect(stats.shouldStopTrying)
    }

    /// A flaky network must heal itself — one good dictation is enough.
    @Test func oneSuccessClearsTheStreak() {
        for _ in 0..<5 { stats.recordFallback(.droppedMidSession) }
        #expect(stats.shouldStopTrying)
        stats.recordSuccess()
        #expect(!stats.shouldStopTrying, "live must recover without the user touching a setting")
        #expect(stats.consecutiveFailures == 0)
    }

    @Test func failurePauseExpiresWithoutChangingToggle() {
        let failedAt = Date(timeIntervalSince1970: 1_000)
        for _ in 0..<3 { stats.recordFallback(.neverOpened, at: failedAt) }
        #expect(stats.shouldStopTrying(at: failedAt.addingTimeInterval(59)))
        #expect(!stats.shouldStopTrying(at: failedAt.addingTimeInterval(60)))
        #expect(stats.attempts == 3)
        stats.recordFallback(.noFinal, at: failedAt.addingTimeInterval(60))
        #expect(stats.shouldStopTrying(at: failedAt.addingTimeInterval(61)))
    }

    @Test func legacyStreakAndClockChangeDoNotPauseForever() {
        defaults.set(3, forKey: "liveConsecutiveFailures")
        #expect(!stats.shouldStopTrying)
        let future = Date().addingTimeInterval(3_600)
        stats.recordFallback(.neverOpened, at: future)
        #expect(!stats.shouldStopTrying, "wall-clock corrections must not strand Live")
    }

    /// Re-enabling the toggle is an explicit "try again", but must not erase the
    /// evidence — the footer should still tell the truth afterwards.
    @Test func clearStreakKeepsHistory() {
        for _ in 0..<4 { stats.recordFallback(.truncated) }
        stats.clearStreak()
        #expect(!stats.shouldStopTrying)
        #expect(stats.attempts == 4, "history survives")
        #expect(stats.count(of: .truncated) == 4)
    }

    @Test func noSummaryBeforeAnyAttempts() {
        #expect(stats.summary == nil, "an empty stat line is worse than none")
    }

    @Test func summaryReportsRateAndDominantReason() throws {
        for _ in 0..<7 { stats.recordSuccess() }
        for _ in 0..<3 { stats.recordFallback(.droppedMidSession) }
        let summary = try #require(stats.summary)
        #expect(summary.contains("7 of the last 10"), "\(summary)")
        #expect(summary.contains("70%"), "\(summary)")
        #expect(summary.contains("dropped mid-sentence"),
                "the dominant reason is what tells the user whether to blame wifi or us: \(summary)")
    }

    @Test func perfectRunMentionsNoFailure() throws {
        for _ in 0..<4 { stats.recordSuccess() }
        let summary = try #require(stats.summary)
        #expect(!summary.contains("fell back"), "\(summary)")
    }

    /// The session's own free-text reasons must land in the right bucket, or the
    /// footer will confidently blame the wrong thing.
    @Test func classificationOfRealSessionReasons() {
        #expect(LiveStats.classify("dropped 3 chunks — stream is truncated") == .truncated)
        #expect(LiveStats.classify("setup never completed") == .neverOpened)
        #expect(LiveStats.classify("connect failed: offline") == .neverOpened)
        #expect(LiveStats.classify("no final transcript before deadline") == .noFinal)
        #expect(LiveStats.classify("final transcript was empty") == .noFinal)
        #expect(LiveStats.classify("server sent goAway") == .droppedMidSession)
        #expect(LiveStats.classify("something nobody anticipated") == .droppedMidSession,
                "an unknown reason must still be counted, not dropped")
    }

    @Test func resetClearsEverything() {
        stats.recordSuccess()
        stats.recordFallback(.noFinal)
        stats.reset()
        #expect(stats.attempts == 0)
        #expect(stats.successes == 0)
        #expect(stats.count(of: .noFinal) == 0)
        #expect(stats.summary == nil)
    }
}
