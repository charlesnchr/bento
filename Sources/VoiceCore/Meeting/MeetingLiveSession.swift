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

/// What a meeting socket reports. Unlike dictation, a meeting is one long stream
/// with many utterances, so turn boundaries and usage matter, not just text.
public enum MeetingLiveEvent: Equatable, Sendable {
    case setupComplete
    /// Speculative text for the utterance in progress. Display only.
    case interim(String)
    /// Authoritative text for one finished utterance.
    case final(String)
    case usage(audioTokens: Int, textTokens: Int)
    /// Server voice activity, in seconds of audio received by this session.
    case activityStart(Double)
    case activityEnd(Double)
    /// The server will close this session soon — rotate now.
    case goAway
    case failed(String)
}

/// Frames for the meeting stream, as pure functions over `Data`.
///
/// Probed against `gemini-3.5-transcribe-live-preview` through the local helper
/// (2026-10-11): with automatic activity detection the server reports
/// `voiceActivity` ACTIVITY_START/END with an `audioOffset`, sends one
/// `inputTranscription` per utterance ~2s after the speaker pauses, and
/// `audioStreamEnd` flushes an utterance cut off mid-sentence within ~0.3s. That
/// last property is what makes rotating sessions every few minutes lossless.
public enum MeetingLiveProtocol {

    /// Automatic activity detection, unlike dictation: nobody is holding a key,
    /// and the server's pauses are where a meeting's utterances really end.
    ///
    /// VERBATIM, also unlike dictation. SMART mode is tuned for one person
    /// composing text and was seen dropping a meeting's content words ("Second,
    /// Priya will…" came back without "Second"). Meeting cleanup happens in its
    /// own pass, where the raw text stays as the reference.
    ///
    /// No `languageCodes` — see `LiveProtocol.setupFrame` for why that field is
    /// never sent without probing first.
    public static func setupFrame(model: String, vocabulary: [String]) -> Data {
        var transcription: [String: Any] = ["mode": "VERBATIM"]
        if !vocabulary.isEmpty {
            transcription["customVocabulary"] = vocabulary
        }
        let frame: [String: Any] = [
            "setup": [
                "model": "models/\(model)",
                "generationConfig": ["responseModalities": ["TEXT"]],
                "inputAudioTranscription": transcription,
            ],
        ]
        return (try? JSONSerialization.data(withJSONObject: frame)) ?? Data()
    }

    public static func streamEndFrame() -> Data {
        (try? JSONSerialization.data(withJSONObject: ["realtimeInput": ["audioStreamEnd": true]])) ?? Data()
    }

    /// Everything one server frame says, in the order it matters. A frame that
    /// carries a final also carries its usage, and must not lose either.
    public static func decode(_ data: Data) -> [MeetingLiveEvent] {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return []
        }
        if root["setupComplete"] != nil || root["setup_complete"] != nil {
            return [.setupComplete]
        }
        if let error = root["error"] as? [String: Any] {
            return [.failed(error["message"] as? String ?? "unknown live error")]
        }
        var events: [MeetingLiveEvent] = []
        var activityEnd: Double?
        if let activity = (root["voiceActivity"] ?? root["voice_activity"]) as? [String: Any] {
            let type = (activity["type"] ?? activity["voiceActivityType"]) as? String ?? ""
            let offset = parseDuration(activity["audioOffset"] ?? activity["audio_offset"]) ?? 0
            if type.hasSuffix("START") {
                events.append(.activityStart(offset))
            } else if type.hasSuffix("END") {
                activityEnd = offset
            }
        }
        if let content = (root["serverContent"] ?? root["server_content"]) as? [String: Any] {
            if let text = transcriptText(content, "interimInputTranscription", "interim_input_transcription") {
                events.append(.interim(text))
            }
            if let text = transcriptText(content, "inputTranscription", "input_transcription") {
                events.append(.final(text))
            }
            if content["goAway"] != nil || content["go_away"] != nil { events.append(.goAway) }
        }
        if let usage = (root["usageMetadata"] ?? root["usage_metadata"]) as? [String: Any] {
            let audio = audioTokens(usage)
            let text = (usage["candidatesTokenCount"] ?? usage["candidates_token_count"]) as? Int ?? 0
            if audio > 0 || text > 0 { events.append(.usage(audioTokens: audio, textTokens: text)) }
        }
        if let activityEnd { events.append(.activityEnd(activityEnd)) }
        if root["goAway"] != nil || root["go_away"] != nil { events.append(.goAway) }
        return events
    }

    /// "0.320s" — protobuf Duration in JSON. Tolerates a bare number.
    static func parseDuration(_ value: Any?) -> Double? {
        if let number = value as? Double { return number }
        if let number = value as? Int { return Double(number) }
        guard let text = value as? String else { return nil }
        return Double(text.hasSuffix("s") ? String(text.dropLast()) : text)
    }

    private static func audioTokens(_ usage: [String: Any]) -> Int {
        let details = (usage["promptTokensDetails"] ?? usage["prompt_tokens_details"]) as? [[String: Any]] ?? []
        let audio = details
            .filter { ($0["modality"] as? String) == "AUDIO" }
            .compactMap { ($0["tokenCount"] ?? $0["token_count"]) as? Int }
            .reduce(0, +)
        if audio > 0 { return audio }
        return (usage["promptTokenCount"] ?? usage["prompt_token_count"]) as? Int ?? 0
    }

    private static func transcriptText(_ content: [String: Any], _ camel: String, _ snake: String) -> String? {
        guard let node = (content[camel] ?? content[snake]) as? [String: Any],
              let text = node["text"] as? String
        else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

/// One Live socket in a meeting. Sessions are capped at ten minutes, so a
/// meeting is a relay of these: the recorder opens the next one while the
/// current one is still streaming, switches the audio between two chunks, and
/// only then asks the old one to flush and close.
///
/// The constraints are the dictation session's: `enqueue` runs on the audio
/// write queue and must never wait, and the end-of-stream marker travels in band
/// behind the audio it must not overtake.
public actor MeetingLiveSession {

    private enum Command: Sendable {
        case pcmAvailable
        case endStream
    }

    private let transport: LiveTransport
    private let setupFrame: Data
    public nonisolated let ring: PCMRing

    private let commands: AsyncStream<Command>
    private let commandSink: AsyncStream<Command>.Continuation
    public nonisolated let events: AsyncStream<MeetingLiveEvent>
    private let eventSink: AsyncStream<MeetingLiveEvent>.Continuation

    private var sendLoop: Task<Void, Never>?
    private var receiveLoop: Task<Void, Never>?
    private var didSetup = false
    private var closed = false
    private var failure: String?
    private var streamEndSent = false
    private var speechActive = false
    private var activityEndedAfterStreamEnd = false

    /// - Parameter ringSeconds: how long the socket may stall before audio is
    ///   dropped from the network stream. A meeting can afford far more than a
    ///   dictation: anything dropped is recovered from disk by the batch path,
    ///   but every drop costs a re-upload of the whole chunk.
    public init(transport: LiveTransport, setupFrame: Data, ringSeconds: Double = 30) {
        self.transport = transport
        self.setupFrame = setupFrame
        self.ring = PCMRing(seconds: ringSeconds)
        (self.commands, self.commandSink) = AsyncStream<Command>.makeStream(bufferingPolicy: .unbounded)
        (self.events, self.eventSink) = AsyncStream<MeetingLiveEvent>.makeStream(bufferingPolicy: .unbounded)
    }

    /// Called from the audio write queue. Must not block, must not await.
    public nonisolated func enqueue(_ pcm: Data) {
        ring.append(pcm)
        commandSink.yield(.pcmAvailable)
    }

    /// Connects and handshakes. Audio enqueued meanwhile waits in the ring.
    /// A session that throws here is already closed.
    public func start(setupTimeout: TimeInterval = 8) async throws {
        do {
            try await handshake(timeout: setupTimeout)
        } catch {
            close()
            throw error
        }
        receiveLoop = Task { [weak self] in await self?.runReceiveLoop() }
        sendLoop = Task { [weak self] in await self?.runSendLoop() }
    }

    private func handshake(timeout: TimeInterval) async throws {
        guard !closed else { throw LiveError.setupTimedOut }
        try await transport.connect()
        try await transport.send(setupFrame)
        let deadline = Date().addingTimeInterval(timeout)
        while !didSetup {
            let remaining = deadline.timeIntervalSinceNow
            guard remaining > 0 else { break }
            let frame = try await Self.receive(from: transport, within: remaining)
            for event in MeetingLiveProtocol.decode(frame) {
                switch event {
                case .setupComplete: didSetup = true
                case .failed(let why): throw LiveError.refused(why)
                default: continue
                }
            }
        }
        guard didSetup else { throw LiveError.setupTimedOut }
    }

    private static func receive(from transport: LiveTransport, within seconds: TimeInterval) async throws -> Data {
        try await withThrowingTaskGroup(of: Data.self) { group in
            group.addTask { try await transport.receive() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
                throw LiveError.setupTimedOut
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw LiveError.setupTimedOut }
            return first
        }
    }

    private func runSendLoop() async {
        for await command in commands {
            if closed { return }
            for chunk in ring.drain() {
                do {
                    try await transport.send(LiveProtocol.audioFrame(chunk))
                    ring.markAccepted(chunk.count)
                } catch {
                    fail("send failed: \(error)")
                    return
                }
            }
            if case .endStream = command {
                do {
                    try await transport.send(MeetingLiveProtocol.streamEndFrame())
                    streamEndSent = true
                } catch {
                    fail("audioStreamEnd failed: \(error)")
                }
                return
            }
        }
    }

    private func runReceiveLoop() async {
        while !closed {
            let frame: Data
            do {
                frame = try await transport.receive()
            } catch {
                if !closed { fail("receive failed: \(error)") }
                return
            }
            for event in MeetingLiveProtocol.decode(frame) {
                switch event {
                case .activityStart:
                    speechActive = true
                case .activityEnd:
                    speechActive = false
                    if streamEndSent { activityEndedAfterStreamEnd = true }
                case .failed(let why):
                    fail(why)
                    return
                default:
                    break
                }
                eventSink.yield(event)
            }
        }
    }

    private func fail(_ why: String) {
        guard failure == nil, !closed else { return }
        failure = why
        eventSink.yield(.failed(why))
        close()
    }

    /// Flushes the stream and waits for the utterance in progress, if any.
    /// Returns true only when the session saw every byte and ended cleanly —
    /// anything else means the chunk is re-transcribed from disk.
    public func finish(deadline: TimeInterval = 6) async -> Bool {
        guard didSetup, failure == nil, !closed else {
            close()
            return false
        }
        commandSink.yield(.endStream)
        let flushDeadline = Date().addingTimeInterval(5)
        while !streamEndSent, failure == nil, Date() < flushDeadline {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        guard streamEndSent, failure == nil else {
            close()
            return false
        }
        // The server needs a beat to notice an utterance that began just before
        // the end marker; past that, an idle session has nothing left to say.
        let grace = Date().addingTimeInterval(0.8)
        let finalDeadline = Date().addingTimeInterval(deadline)
        while failure == nil, Date() < finalDeadline {
            if !speechActive, activityEndedAfterStreamEnd || Date() >= grace { break }
            try? await Task.sleep(nanoseconds: 40_000_000)
        }
        let clean = failure == nil && !speechActive && !ring.didDrop
        close()
        return clean
    }

    /// Tear down without waiting. Idempotent.
    public func abort() {
        close()
    }

    private func close() {
        guard !closed else { return }
        closed = true
        sendLoop?.cancel()
        receiveLoop?.cancel()
        commandSink.finish()
        eventSink.finish()
        transport.close()
    }

    public var hasFailed: Bool { failure != nil }
}
