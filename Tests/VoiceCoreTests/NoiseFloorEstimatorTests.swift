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

@Suite struct NoiseFloorEstimatorTests {

    /// Below the minimum the percentile is noise about noise. Callers treat a nil
    /// floor as "no evidence", which everywhere in the pipeline means keep the audio.
    @Test func floorIsNilUntilEnoughSamples() {
        var estimator = NoiseFloorEstimator()
        for _ in 0..<(NoiseFloorEstimator.minimumSamples - 1) {
            estimator.ingest(level: 0.2)
            #expect(estimator.floorDB == nil)
        }
        estimator.ingest(level: 0.2)
        #expect(estimator.floorDB != nil)
    }

    /// The reason it is a rolling low percentile and not "the first N ms":
    /// prewarm means audio starts at key-down, so a fast talker is ALREADY
    /// speaking in the head of the recording. Treating that as the floor would
    /// classify speech as the room and make every downstream decision worse.
    @Test func floorConvergesWhenSpeechStartsAtSampleZero() throws {
        var estimator = NoiseFloorEstimator()
        // Loud from the very first sample, with the natural gaps between words.
        let quietRoom: Float = 0.02
        for index in 0..<40 {
            estimator.ingest(level: index % 4 == 3 ? quietRoom : 0.7)
        }
        let floor = try #require(estimator.floorDB)
        #expect(abs(floor - AudioLevelCurve.dBFS(fromLevel: quietRoom)) <= 0.5,
                "the gaps between words are the room, even when speech starts immediately")
        #expect(try #require(estimator.measuredSNR) > 30)
    }

    /// A loud room is the case the whole feature exists for: speech barely rises
    /// above it, and the measured separation says so.
    @Test func loudRoomProducesLowSeparation() throws {
        var estimator = NoiseFloorEstimator()
        for _ in 0..<20 { estimator.ingest(level: 0.4) }
        estimator.ingest(level: 0.5)
        let snr = try #require(estimator.measuredSNR)
        #expect(snr < 8, "nothing rose meaningfully above this room")
    }

    /// One anomalous quiet buffer must not define the room — that is the whole
    /// point of a percentile rather than a minimum.
    @Test func singleOutlierDoesNotSetTheFloor() throws {
        var estimator = NoiseFloorEstimator()
        estimator.ingest(level: 0.0) // one dropout
        for _ in 0..<30 { estimator.ingest(level: 0.3) }
        let floor = try #require(estimator.floorDB)
        #expect(abs(floor - AudioLevelCurve.dBFS(fromLevel: 0.3)) <= 0.5)
    }

    @Test func peakTracksTheLoudestSample() {
        var estimator = NoiseFloorEstimator()
        for level in [Float(0.1), 0.9, 0.3] { estimator.ingest(level: level) }
        #expect(abs(estimator.peakDB - AudioLevelCurve.dBFS(fromLevel: 0.9)) <= 0.001)
    }

    /// A floor from nine minutes ago is not this room any more.
    @Test func windowIsBounded() throws {
        var estimator = NoiseFloorEstimator(capacity: 16)
        for _ in 0..<16 { estimator.ingest(level: 0.01) } // old, quiet room
        for _ in 0..<16 { estimator.ingest(level: 0.4) }  // someone turned on a fan
        let floor = try #require(estimator.floorDB)
        #expect(abs(floor - AudioLevelCurve.dBFS(fromLevel: 0.4)) <= 0.5)
    }
}
