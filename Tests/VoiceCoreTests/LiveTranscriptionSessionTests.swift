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

/// Every way a live session can end, driven against a scripted socket so the
/// failure modes that matter are exercised on every build rather than only when
/// someone's wifi drops mid-sentence.
@Suite struct LiveTranscriptionSessionTests {

    /// A socket that says what the test tells it to say.
    final class FakeTransport: LiveTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var inbox: [Data]
        private(set) var sent: [Data] = []
        var connectError: Error?
        var sendErrorAfter: Int?
        var receiveHangs = false
        /// Frames the server sends once activityEnd reaches it, as a real one does.
        var replyToActivityEnd: [Data] = []
        private(set) var closeCount = 0

        init(script: [Data]) { self.inbox = script }

        func connect() async throws {
            if let connectError { throw connectError }
        }

        func send(_ data: Data) async throws {
            let (count, limit) = lock.withLock { (sent.count, sendErrorAfter) }
            if let limit, count >= limit {
                throw URLError(.networkConnectionLost)
            }
            lock.withLock {
                sent.append(data)
                if let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                   let realtime = root["realtimeInput"] as? [String: Any], realtime["activityEnd"] != nil {
                    inbox.append(contentsOf: replyToActivityEnd)
                }
            }
        }

        func receive() async throws -> Data {
            if receiveHangs {
                try await Task.sleep(nanoseconds: 30_000_000_000)
                throw URLError(.timedOut)
            }
            // Nothing to say yet: wait, like a real socket on a quiet server, but
            // keep checking so a reply to activityEnd is delivered when it lands.
            for _ in 0..<3_000 {
                if let next = lock.withLock({ inbox.isEmpty ? nil : inbox.removeFirst() }) { return next }
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            throw URLError(.timedOut)
        }

        func close() { lock.lock(); closeCount += 1; lock.unlock() }

        /// What was actually put on the wire, in order, as decoded JSON keys.
        var sentKinds: [String] {
            lock.lock(); defer { lock.unlock() }
            return sent.compactMap { data in
                guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
                if root["setup"] != nil { return "setup" }
                guard let realtime = root["realtimeInput"] as? [String: Any] else { return nil }
                if realtime["activityStart"] != nil { return "activityStart" }
                if realtime["activityEnd"] != nil { return "activityEnd" }
                if realtime["audio"] != nil { return "audio" }
                return nil
            }
        }
    }

    private func frame(_ object: [String: Any]) -> Data {
        try! JSONSerialization.data(withJSONObject: object)
    }

    private func setupCompleteFrame() -> Data { frame(["setupComplete": [:] as [String: Any]]) }
    private func finalFrame(_ text: String) -> Data {
        frame(["serverContent": ["inputTranscription": ["text": text]]])
    }
    private func partialFrame(_ text: String) -> Data {
        frame(["serverContent": ["interimInputTranscription": ["text": text]]])
    }

    private func activityFrame(_ type: String, offset: String = "0s") -> Data {
        frame(["voiceActivity": ["type": type, "audioOffset": offset]])
    }

    private func makeSession(_ transport: FakeTransport, ring: PCMRing = PCMRing()) -> LiveTranscriptionSession {
        LiveTranscriptionSession(transport: transport, setup: LiveSetup(), ring: ring)
    }

    // MARK: - The happy path

    @Test func cleanSessionCompletesWithFinalText() async throws {
        let transport = FakeTransport(script: [setupCompleteFrame(), finalFrame("Ship it on Friday.")])
        let session = makeSession(transport)
        try await session.start()
        session.enqueue(Data(repeating: 0x01, count: 3_328))
        try await Task.sleep(nanoseconds: 120_000_000)
        let outcome = await session.finish(deadline: 2.0)
        #expect(outcome == .completed("Ship it on Friday."))
    }

    /// The ordering guarantee that stops the user's last words being cut off:
    /// activityEnd must reach the wire AFTER every audio chunk queued before it.
    @Test func activityEndNeverOvertakesQueuedAudio() async throws {
        let transport = FakeTransport(script: [setupCompleteFrame(), finalFrame("done")])
        let session = makeSession(transport)
        try await session.start()
        for _ in 0..<12 { session.enqueue(Data(repeating: 0x02, count: 3_328)) }
        _ = await session.finish(deadline: 2.0)

        let kinds = transport.sentKinds
        let endIndex = try #require(kinds.firstIndex(of: "activityEnd"))
        let audioIndices = kinds.enumerated().filter { $0.element == "audio" }.map(\.offset)
        #expect(!audioIndices.isEmpty, "audio must actually have been sent")
        #expect(audioIndices.allSatisfy { $0 < endIndex },
                "every audio chunk must precede activityEnd — the server finalizes on what it has")
    }

    @Test func setupIsSentBeforeActivityStart() async throws {
        let transport = FakeTransport(script: [setupCompleteFrame(), finalFrame("x")])
        let session = makeSession(transport)
        try await session.start()
        _ = await session.finish(deadline: 1.0)
        let kinds = transport.sentKinds
        #expect(kinds.first == "setup")
        #expect(kinds.dropFirst().first == "activityStart")
    }

    /// A server that reports turns is trusted once ACTIVITY_END covers the audio.
    @Test func turnEndCoveringTheAudioCompletes() async throws {
        let transport = FakeTransport(script: [setupCompleteFrame(), activityFrame("ACTIVITY_START")])
        // 20 chunks of 3,328 bytes at 32,000 bytes/s is 2.08s.
        transport.replyToActivityEnd = [finalFrame("Ship it on Friday."), activityFrame("ACTIVITY_END", offset: "2.080s")]
        let session = makeSession(transport)
        try await session.start()
        for _ in 0..<20 { session.enqueue(Data(repeating: 0x01, count: 3_328)) }
        let outcome = await session.finish(deadline: 2.0)
        #expect(outcome == .completed("Ship it on Friday."))
    }

    // MARK: - Everything that must fall back

    /// The 337s dictation that came back as its first 216s. The server closed
    /// the turn during a pause, sent the final for what it had heard, and ignored
    /// everything after. That final must not be inserted as the whole dictation.
    @Test func turnTheServerEndedByItselfFallsBack() async throws {
        let transport = FakeTransport(script: [
            setupCompleteFrame(),
            activityFrame("ACTIVITY_START"),
            finalFrame("Everything before the pause."),
            frame(["serverContent": ["generationComplete": true]]),
            activityFrame("ACTIVITY_END", offset: "216.120s"),
        ])
        let session = makeSession(transport)
        try await session.start()
        for _ in 0..<20 { session.enqueue(Data(repeating: 0x06, count: 3_328)) }
        try await Task.sleep(nanoseconds: 150_000_000)
        let outcome = await session.finish(deadline: 1.0)
        guard case .unusable(let why) = outcome else {
            Issue.record("a turn the server ended early must be unusable, got \(outcome)")
            return
        }
        #expect(LiveStats.classify(why) == .turnEndedEarly, "got: \(why)")
    }

    /// The bug itself: a final in hand from earlier audio used to end the wait
    /// the moment activityEnd was sent, before the rest could be transcribed.
    @Test func anEarlierFinalDoesNotStandInForTheTurnEnd() async throws {
        let transport = FakeTransport(script: [
            setupCompleteFrame(), activityFrame("ACTIVITY_START"), finalFrame("Only the first half."),
        ])
        let session = makeSession(transport)
        try await session.start()
        session.enqueue(Data(repeating: 0x07, count: 3_328))
        try await Task.sleep(nanoseconds: 120_000_000)
        let outcome = await session.finish(deadline: 0.4)
        guard case .unusable = outcome else {
            Issue.record("without the server's turn end the transcript is unproven, got \(outcome)")
            return
        }
    }

    @Test func turnEndShortOfTheAudioSentFallsBack() async throws {
        let transport = FakeTransport(script: [setupCompleteFrame(), activityFrame("ACTIVITY_START")])
        transport.replyToActivityEnd = [finalFrame("Half of it."), activityFrame("ACTIVITY_END", offset: "0.500s")]
        let session = makeSession(transport)
        try await session.start()
        for _ in 0..<20 { session.enqueue(Data(repeating: 0x08, count: 3_328)) }
        let outcome = await session.finish(deadline: 2.0)
        guard case .unusable(let why) = outcome else {
            Issue.record("a turn end that heard 0.5s of 2.08s must be unusable, got \(outcome)")
            return
        }
        #expect(LiveStats.classify(why) == .turnEndedEarly, "got: \(why)")
    }

    @Test func voiceActivityFramesDecode() {
        #expect(LiveProtocol.decode(activityFrame("ACTIVITY_START")) == .activityStarted)
        #expect(LiveProtocol.decode(activityFrame("ACTIVITY_END", offset: "216.120s")) == .activityEnded(216.12))
    }

    /// The failure the whole design is arranged around: dropped audio yields a
    /// fluent-but-truncated transcript. It must NEVER be promoted.
    @Test func droppedAudioDisqualifiesTheSession() async throws {
        // A ring so small that streaming more than a second guarantees eviction.
        let ring = PCMRing(seconds: 1.0)
        let transport = FakeTransport(script: [setupCompleteFrame(), finalFrame("…by Friday.")])
        let session = LiveTranscriptionSession(transport: transport, setup: LiveSetup(), ring: ring)
        // Fill before start so nothing can drain it: the socket is not pumping yet.
        for _ in 0..<40 { ring.append(Data(repeating: 0x03, count: 3_328)) }
        #expect(ring.didDrop, "precondition: the ring must have evicted")

        try await session.start()
        let outcome = await session.finish(deadline: 1.0)
        guard case .unusable(let why) = outcome else {
            Issue.record("a truncated stream must be unusable, got \(outcome)")
            return
        }
        #expect(why.contains("truncated"), "the reason should name truncation, got: \(why)")
    }

    @Test func setupTimeoutIsThrownNotSwallowed() async throws {
        let transport = FakeTransport(script: [])
        transport.receiveHangs = true
        let session = makeSession(transport)
        // Any throw is correct — the caller falls back to batch either way.
        await #expect(throws: (any Error).self, "start must throw when setup never completes") {
            try await session.start(setupTimeout: 0.2)
        }
    }

    @Test func connectFailureThrows() async throws {
        let transport = FakeTransport(script: [])
        transport.connectError = URLError(.notConnectedToInternet)
        let session = makeSession(transport)
        await #expect(throws: (any Error).self, "start must throw when the socket cannot connect") {
            try await session.start(setupTimeout: 0.5)
        }
    }

    @Test func serverErrorEnvelopeIsRefused() async throws {
        let transport = FakeTransport(script: [frame(["error": ["message": "API key not valid"]])])
        let session = makeSession(transport)
        await #expect(throws: LiveError.refused("API key not valid"), "an error envelope during setup must throw") {
            try await session.start(setupTimeout: 1.0)
        }
    }

    @Test func noFinalBeforeDeadlineIsUnusable() async throws {
        // Setup succeeds, then the server says nothing more.
        let transport = FakeTransport(script: [setupCompleteFrame()])
        let session = makeSession(transport)
        try await session.start()
        session.enqueue(Data(repeating: 0x04, count: 1_024))
        let outcome = await session.finish(deadline: 0.4)
        guard case .unusable = outcome else {
            Issue.record("no final transcript must be unusable, got \(outcome)")
            return
        }
    }

    @Test func goAwayMakesTheSessionUnusable() async throws {
        let transport = FakeTransport(script: [setupCompleteFrame(), frame(["goAway": [:] as [String: Any]])])
        let session = makeSession(transport)
        try await session.start()
        try await Task.sleep(nanoseconds: 120_000_000)
        let outcome = await session.finish(deadline: 0.5)
        guard case .unusable = outcome else {
            Issue.record("goAway must be unusable, got \(outcome)")
            return
        }
    }

    @Test func sendFailureMidStreamIsUnusable() async throws {
        let transport = FakeTransport(script: [setupCompleteFrame(), finalFrame("partial words")])
        let session = makeSession(transport)
        try await session.start()
        // setup + activityStart already sent; fail on the next write.
        transport.sendErrorAfter = 2
        for _ in 0..<4 { session.enqueue(Data(repeating: 0x05, count: 3_328)) }
        try await Task.sleep(nanoseconds: 150_000_000)
        let outcome = await session.finish(deadline: 0.5)
        guard case .unusable = outcome else {
            Issue.record("a mid-stream send failure must be unusable, got \(outcome)")
            return
        }
    }

    // MARK: - Partials must never become the transcript

    @Test func partialsAreNeverPromotedToTheOutcome() async throws {
        let transport = FakeTransport(script: [
            setupCompleteFrame(),
            partialFrame("ship it on fry"),
            partialFrame("ship it on friday"),
            finalFrame("Ship it on Friday."),
        ])
        let session = makeSession(transport)
        try await session.start()
        try await Task.sleep(nanoseconds: 200_000_000)
        let outcome = await session.finish(deadline: 1.5)
        #expect(outcome == .completed("Ship it on Friday."), "the outcome must be the FINAL text, never the last interim")
    }

    @Test func partialOnlySessionIsUnusable() async throws {
        let transport = FakeTransport(script: [setupCompleteFrame(), partialFrame("half a thought")])
        let session = makeSession(transport)
        try await session.start()
        try await Task.sleep(nanoseconds: 120_000_000)
        let outcome = await session.finish(deadline: 0.4)
        guard case .unusable = outcome else {
            Issue.record("interim text alone must never be usable, got \(outcome)")
            return
        }
    }

    // MARK: - Lifecycle

    @Test func abortIsIdempotent() async throws {
        let transport = FakeTransport(script: [setupCompleteFrame(), finalFrame("x")])
        let session = makeSession(transport)
        try await session.start()
        await session.abort()
        await session.abort()
        await session.abort()
        #expect(transport.closeCount == 1, "close must happen exactly once however many aborts arrive")
    }

    @Test func finishBeforeStartIsUnusableNotACrash() async {
        let transport = FakeTransport(script: [])
        let session = makeSession(transport)
        let outcome = await session.finish(deadline: 0.2)
        guard case .unusable = outcome else {
            Issue.record("finishing a session that never started must be unusable")
            return
        }
    }

    @Test func emptyFinalIsUnusable() async throws {
        let transport = FakeTransport(script: [setupCompleteFrame(), finalFrame("   ")])
        let session = makeSession(transport)
        try await session.start()
        try await Task.sleep(nanoseconds: 120_000_000)
        let outcome = await session.finish(deadline: 0.5)
        guard case .unusable = outcome else {
            Issue.record("whitespace-only text must not be inserted, got \(outcome)")
            return
        }
    }
}
