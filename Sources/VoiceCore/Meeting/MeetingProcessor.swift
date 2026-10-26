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

/// Decides what the rolling cleanup pass should work on next. Pure, so the
/// cadence — and the guarantee that text about to be replaced is never paid to
/// clean — is testable without a model.
public enum MeetingCleanupPlanner {
    public struct Batch: Equatable, Sendable {
        public var chunk: Int
        public var segments: [MeetingSegment]
        public var context: String
    }

    /// - Parameters:
    ///   - minWords: clean once this much new text has arrived…
    ///   - maxWait: …or once the oldest uncleaned text is this old.
    ///   - maxWords: cap per call, so one request never carries ten minutes.
    ///   - force: stopping — clean everything that is final.
    public static func next(in document: MeetingDocument, now: Date, force: Bool,
                            minWords: Int = 140, maxWait: TimeInterval = 75, maxWords: Int = 450) -> Batch? {
        for chunk in document.meta.chunks.sorted(by: { $0.index < $1.index }) {
            // While recording, this text is about to be replaced by the batch
            // transcript. At the end it is the best transcript there is — a
            // later Retry that succeeds replaces these blocks anyway.
            if !force, chunk.status == .awaitingBatch || chunk.status == .failed || chunk.status == .buffering { continue }
            let pending = document.transcript.pendingSegments(chunk: chunk.index)
            guard let oldest = pending.first else { continue }
            let words = pending.reduce(0) { $0 + wordCount($1.text) }
            let settled = !chunk.isOpen && (chunk.status == .complete || chunk.status == .batched)
            guard force || settled || words >= minWords || now.timeIntervalSince(oldest.receivedAt) >= maxWait else {
                continue
            }
            var take: [MeetingSegment] = []
            var taken = 0
            for segment in pending {
                if !take.isEmpty, taken + wordCount(segment.text) > maxWords { break }
                take.append(segment)
                taken += wordCount(segment.text)
            }
            return Batch(chunk: chunk.index, segments: take,
                         context: context(before: chunk.index, segment: take[0].id, in: document.transcript))
        }
        return nil
    }

    /// The tail of the cleaned text just before this point, so the model keeps
    /// continuity across calls without being asked to rewrite it.
    static func context(before chunk: Int, segment: Int, in transcript: MeetingTranscript, characters: Int = 600) -> String {
        let earlier = transcript.blocks
            .filter { $0.chunk < chunk || ($0.chunk == chunk && $0.lastSegment < segment) }
            .sorted { ($0.chunk, $0.firstSegment) < ($1.chunk, $1.firstSegment) }
        guard let last = earlier.last else { return "" }
        guard last.text.count > characters else { return last.text }
        let tail = last.text.suffix(characters)
        let start = tail.firstIndex(where: \.isWhitespace).map { tail.index(after: $0) } ?? tail.startIndex
        return String(tail[start...])
    }

    static func wordCount(_ text: String) -> Int {
        text.split(whereSeparator: \.isWhitespace).count
    }
}

/// Owns one meeting's document and does the work that turns raw finals into
/// notes: rolling cleanup while it records, batch transcription of anything Live
/// did not cover cleanly, and the summary at the end. Every change is written
/// to disk shortly after it happens, so a crash costs nothing that launch
/// recovery cannot rebuild from the audio.
@MainActor
public final class MeetingProcessor: ObservableObject, Identifiable {
    @Published public private(set) var document: MeetingDocument
    /// What finishing is doing right now, for the UI. Nil when idle.
    @Published public private(set) var step: String?

    public nonisolated let id: UUID
    public var onFinished: (() -> Void)?

    private let services: MeetingServices
    private var cleanupTask: Task<Void, Never>?
    private var batchTask: Task<Void, Never>?
    private var cleanupRetryAt = Date.distantPast
    private var batchRetryAt = Date.distantPast
    private var finishing = false
    private var saveTask: Task<Void, Never>?
    private static let ioQueue = DispatchQueue(label: "com.charles.bento.voice.meeting.io", qos: .utility)

    public init(document: MeetingDocument, services: MeetingServices) {
        self.document = document
        self.id = document.meta.id
        self.services = services
    }

    public var isFinishing: Bool { finishing }

    // MARK: - Mutations from the recorder

    func addPart(_ part: MeetingPart) {
        document.meta.parts.append(part)
        saveNow()
    }

    func updatePart(_ index: Int, save immediately: Bool = false, _ mutate: (inout MeetingPart) -> Void) {
        guard let position = document.meta.parts.firstIndex(where: { $0.index == index }) else { return }
        mutate(&document.meta.parts[position])
        immediately ? saveNow() : saveSoon()
    }

    func openChunk(part: Int, startFrame: Int64, status: MeetingChunk.Status) -> Int {
        let index = (document.meta.chunks.map(\.index).max() ?? 0) + 1
        document.meta.chunks.append(MeetingChunk(index: index, part: part, startFrame: startFrame, status: status))
        saveNow()
        return index
    }

    func updateChunk(_ index: Int, _ mutate: (inout MeetingChunk) -> Void) {
        guard let position = document.meta.chunks.firstIndex(where: { $0.index == index }) else { return }
        mutate(&document.meta.chunks[position])
        saveNow()
        pump()
    }

    func chunk(_ index: Int) -> MeetingChunk? {
        document.meta.chunks.first { $0.index == index }
    }

    func appendFinal(chunk: Int, text: String, start: Double) {
        // A span the batch path already rewrote owns its text outright.
        guard let record = self.chunk(chunk), record.status != .batched, record.status != .failed else { return }
        let corrected = ReplacementEngine.apply(services.replacementRules(), to: text)
        let id = document.transcript.nextSegmentID
        document.transcript.nextSegmentID += 1
        document.transcript.segments.append(MeetingSegment(
            id: id, chunk: chunk, start: start, text: corrected, fromBatch: false, receivedAt: Date()
        ))
        saveSoon()
        pump()
    }

    func addUsage(audioTokens: Int, textTokens: Int) {
        document.meta.usage.liveAudioTokens += audioTokens
        document.meta.usage.liveTextTokens += textTokens
        saveSoon()
    }

    func setStatus(_ status: MeetingMeta.Status) {
        document.meta.status = status
        saveNow()
    }

    func setEndedAt(_ date: Date) {
        document.meta.endedAt = date
        saveNow()
    }

    public func rename(_ title: String) {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        document.meta.title = trimmed.isEmpty ? nil : trimmed
        document.meta.titleIsUserSet = !trimmed.isEmpty
        saveNow()
    }

    // MARK: - Persistence

    private func saveSoon() {
        guard saveTask == nil else { return }
        saveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            self?.saveNow()
        }
    }

    /// Snapshot here, write off the main actor, in order.
    public func saveNow() {
        saveTask?.cancel()
        saveTask = nil
        guard let snapshot = try? MeetingStore.snapshot(document) else { return }
        Self.ioQueue.async { MeetingStore.write(snapshot) }
    }

    /// For termination: the bytes are on disk when this returns.
    public func saveSynchronously() {
        saveTask?.cancel()
        saveTask = nil
        guard let snapshot = try? MeetingStore.snapshot(document) else { return }
        Self.ioQueue.sync { MeetingStore.write(snapshot) }
    }

    // MARK: - Background work while recording

    /// Starts whatever work is due. Cheap; called on every change and on the
    /// recorder's tick.
    public func pump() {
        guard !finishing else { return }
        let now = Date()
        if cleanupTask == nil, now >= cleanupRetryAt,
           let batch = MeetingCleanupPlanner.next(in: document, now: now, force: false) {
            cleanupTask = Task { [weak self] in
                await self?.runCleanup(batch, rawOnFailure: false)
                self?.cleanupTask = nil
                self?.pump()
            }
        }
        if batchTask == nil, now >= batchRetryAt,
           let chunk = document.meta.chunks.filter({ $0.status == .awaitingBatch }).min(by: { $0.index < $1.index }) {
            batchTask = Task { [weak self] in
                await self?.runBatch(chunk.index, lastChance: false)
                self?.batchTask = nil
                self?.pump()
            }
        }
    }

    private func runCleanup(_ batch: MeetingCleanupPlanner.Batch, rawOnFailure: Bool) async {
        let raw = batch.segments.map(\.text).joined(separator: " ")
        var text = raw
        var cleaned = false
        if let model = services.text {
            let prompt = MeetingPrompts.cleanup(newText: raw, context: batch.context,
                                                vocabulary: services.vocabulary(), spellings: services.spellings())
            do {
                let response = try await model.generate(prompt: prompt, json: false, deadline: 60)
                document.meta.usage.textCalls += 1
                if let accepted = MeetingPrompts.acceptCleanup(raw: raw, response: response) {
                    text = accepted
                    cleaned = true
                }
            } catch {
                guard rawOnFailure else {
                    // Mid-meeting there is time to wait for the network to come
                    // back; storing the raw text now would keep it raw forever.
                    Log.transcription.info("meeting cleanup unavailable (\(String(describing: error), privacy: .public)) — retrying later")
                    cleanupRetryAt = Date().addingTimeInterval(30)
                    return
                }
            }
        }
        // The batch path may have replaced this chunk while the model was busy.
        let current = document.transcript.pendingSegments(chunk: batch.chunk).prefix(batch.segments.count)
        guard current.map(\.id) == batch.segments.map(\.id) else { return }
        document.transcript.blocks.append(MeetingBlock(
            chunk: batch.chunk,
            firstSegment: batch.segments[0].id,
            lastSegment: batch.segments[batch.segments.count - 1].id,
            start: batch.segments[0].start,
            text: ReplacementEngine.apply(services.replacementRules(), to: text),
            cleaned: cleaned
        ))
        saveSoon()
    }

    private func runBatch(_ index: Int, lastChance: Bool) async {
        guard let chunk = chunk(index), chunk.status == .awaitingBatch,
              let end = chunk.endFrame, let part = document.meta.part(chunk.part) else { return }
        guard let batch = services.batch else {
            updateChunk(index) { $0.status = .failed; $0.lastError = "No transcription service is configured" }
            return
        }
        let folder = document.folder
        let vocabulary = services.vocabulary()
        let base = document.meta.meetingSeconds(part: chunk.part, frame: chunk.startFrame)
        let range = MeetingFrameRange(start: chunk.startFrame, end: end)
        let result = await Task.detached(priority: .utility) {
            await Self.transcribe(folder: folder, part: part, chunk: index, range: range,
                                  batch: batch, vocabulary: vocabulary)
        }.value
        guard let position = document.meta.chunks.firstIndex(where: { $0.index == index }),
              document.meta.chunks[position].status == .awaitingBatch else { return }
        switch result {
        case .success(let pieces):
            let rules = services.replacementRules()
            document.transcript.segments.removeAll { $0.chunk == index }
            document.transcript.blocks.removeAll { $0.chunk == index }
            for piece in pieces where !piece.text.isEmpty {
                let id = document.transcript.nextSegmentID
                document.transcript.nextSegmentID += 1
                document.transcript.segments.append(MeetingSegment(
                    id: id, chunk: index, start: base + piece.offset,
                    text: ReplacementEngine.apply(rules, to: piece.text), fromBatch: true, receivedAt: Date()
                ))
            }
            document.meta.chunks[position].status = .batched
            document.meta.chunks[position].lastError = nil
            document.meta.usage.batchSeconds += MeetingAudio.seconds(range.end - range.start)
            batchRetryAt = .distantPast
            Log.transcription.info("meeting chunk \(index) transcribed from audio (\(pieces.count) window(s))")
        case .failure(let error):
            document.meta.chunks[position].attempts += 1
            document.meta.chunks[position].lastError = Self.describe(error)
            let attempts = document.meta.chunks[position].attempts
            if Self.isPermanent(error) || (lastChance && attempts >= 3) {
                document.meta.chunks[position].status = .failed
            } else {
                let backoff: [TimeInterval] = [5, 15, 30, 60, 120, 300]
                batchRetryAt = Date().addingTimeInterval(backoff[min(attempts - 1, backoff.count - 1)])
            }
            Log.transcription.info("meeting chunk \(index) batch failed (attempt \(attempts)): \(Self.describe(error), privacy: .public)")
        }
        saveNow()
    }

    private nonisolated static func transcribe(
        folder: URL, part: MeetingPart, chunk: Int, range: MeetingFrameRange,
        batch: any MeetingBatchTranscribing, vocabulary: [String]
    ) async -> Result<[(offset: Double, text: String)], Error> {
        do {
            let samples = try MeetingAudioExtractor.samples(folder: folder, part: part, range: range)
            var pieces: [(offset: Double, text: String)] = []
            for (number, window) in MeetingAudioExtractor.windows(sampleCount: samples.count, samples: samples).enumerated() {
                // Digital silence (a muted stretch): nothing an upload could return.
                guard samples[window].contains(where: { $0 > 120 || $0 < -120 }) else { continue }
                // A span this short sits between two others — a reconnect landing
                // just after a cut — and may hold the end of a word. The API
                // rejects clips under ~0.4s, so pad rather than skip it.
                var audio = samples[window]
                let minimum = Int(0.5 * MeetingAudio.sampleRate)
                if audio.count < minimum { audio.append(contentsOf: repeatElement(0, count: minimum - audio.count)) }
                let seconds = MeetingAudio.seconds(Int64(audio.count))
                let caf = folder.appendingPathComponent("batch-\(chunk)-\(number).caf")
                let flac = folder.appendingPathComponent("batch-\(chunk)-\(number).flac")
                defer {
                    try? FileManager.default.removeItem(at: caf)
                    try? FileManager.default.removeItem(at: flac)
                }
                try MeetingAudioExtractor.writeCAF(audio, to: caf)
                let encoded = try FLACEncoder.encode(cafURL: caf, flacURL: flac)
                let data = try Data(contentsOf: encoded.url)
                let text: String
                do {
                    text = try await batch.transcribe(flac: data, durationSeconds: seconds, vocabulary: vocabulary)
                } catch TranscriptionError.emptyTranscript {
                    text = ""
                }
                pieces.append((offset: MeetingAudio.seconds(Int64(window.lowerBound)),
                               text: text.trimmingCharacters(in: .whitespacesAndNewlines)))
            }
            return .success(pieces)
        } catch {
            return .failure(error)
        }
    }

    private static func isPermanent(_ error: Error) -> Bool {
        if error is MeetingAudioExtractor.ExtractError { return true }
        switch error as? TranscriptionError {
        case .badRequest, .auth, .modelUnavailable, .safetyBlocked, .rateLimitedDaily: return true
        default: return false
        }
    }

    private static func describe(_ error: Error) -> String {
        switch error as? TranscriptionError {
        case .offline: return "Offline"
        case .network: return "Network error"
        case .timeout: return "Timed out"
        case .auth: return "Authentication failed"
        case .modelUnavailable: return "Transcription model unavailable"
        case .rateLimitedDaily: return "Daily quota reached"
        case .rateLimitedTransient: return "Rate limited"
        case .badRequest: return "Request rejected"
        case .safetyBlocked: return "Declined by the model"
        case .emptyTranscript: return "No speech found"
        case .reviewRejected: return "Review failed validation"
        case nil:
            return error is MeetingAudioExtractor.ExtractError ? "Audio file missing" : "Could not read the audio"
        }
    }

    // MARK: - Finishing

    /// Runs once capture is over: transcribe what Live missed, clean everything,
    /// summarize. Bounded — a meeting that cannot reach the network finishes
    /// with gaps marked in the notes and a Retry, rather than spinning forever.
    public func finish() async {
        guard !finishing else { return }
        finishing = true
        document.meta.status = .finishing
        saveNow()
        await cleanupTask?.value
        await batchTask?.value

        for round in 0..<3 {
            let pending = document.meta.chunks.filter { $0.status == .awaitingBatch }.map(\.index)
            if pending.isEmpty { break }
            step = "Transcribing missed audio…"
            for index in pending.sorted() {
                await runBatch(index, lastChance: round == 2)
            }
            if round < 2, document.meta.pendingBatchCount > 0 {
                try? await Task.sleep(nanoseconds: round == 0 ? 3_000_000_000 : 10_000_000_000)
            }
        }

        step = "Cleaning up the transcript…"
        var guardrail = document.transcript.segments.count + 4
        while guardrail > 0, let batch = MeetingCleanupPlanner.next(in: document, now: Date(), force: true) {
            await runCleanup(batch, rawOnFailure: true)
            guardrail -= 1
        }

        if services.summaryEnabled(), let model = services.text, document.transcript.wordCount >= 25 {
            step = "Writing the summary…"
            do {
                let prompt = MeetingPrompts.summary(transcript: document.plainTranscript, startedAt: document.meta.startedAt)
                let response = try await model.generate(prompt: prompt, json: true, deadline: 120)
                document.meta.usage.textCalls += 1
                if let summary = MeetingPrompts.parseSummary(response) {
                    document.meta.summary = summary
                    document.meta.summaryError = nil
                    if !document.meta.titleIsUserSet, !summary.title.isEmpty {
                        document.meta.title = summary.title
                    }
                } else {
                    document.meta.summaryError = "The summary came back unreadable"
                }
            } catch {
                document.meta.summaryError = Self.describe(error)
            }
        }

        document.meta.status = .complete
        if document.meta.endedAt == nil { document.meta.endedAt = Date() }
        step = nil
        finishing = false
        saveNow()
        onFinished?()
    }

    /// Gives failed spans, raw-fallback cleanup and a missing summary another go.
    public func retry() async {
        guard !finishing else { return }
        for position in document.meta.chunks.indices where document.meta.chunks[position].status == .failed {
            document.meta.chunks[position].status = .awaitingBatch
            document.meta.chunks[position].attempts = 0
        }
        document.transcript.blocks.removeAll { !$0.cleaned }
        batchRetryAt = .distantPast
        cleanupRetryAt = .distantPast
        await finish()
    }

    /// Whether anything is left that `retry` could improve.
    public var canRetry: Bool {
        let meta = document.meta
        return meta.status == .complete && (meta.failedChunkCount > 0 || meta.pendingBatchCount > 0
            || meta.summaryError != nil || document.transcript.blocks.contains { !$0.cleaned })
    }

    // MARK: - Recovery

    /// A meeting the app died in the middle of, made finishable from what reached
    /// disk. Live text whose session never closed cleanly is re-transcribed from
    /// the audio rather than trusted.
    public nonisolated static func recovered(_ document: MeetingDocument,
                                             recordedFrames: (MeetingPart) -> Int64?) -> MeetingDocument {
        var document = document
        for position in document.meta.parts.indices where !document.meta.parts[position].ended {
            let part = document.meta.parts[position]
            document.meta.parts[position].frames = max(part.frames, recordedFrames(part) ?? 0)
            document.meta.parts[position].ended = true
        }
        for position in document.meta.chunks.indices {
            let chunk = document.meta.chunks[position]
            if chunk.endFrame == nil {
                document.meta.chunks[position].endFrame = document.meta.part(chunk.part)?.frames ?? chunk.startFrame
            }
            if chunk.status == .streaming || chunk.status == .buffering {
                document.meta.chunks[position].status = .awaitingBatch
            }
            if let end = document.meta.chunks[position].endFrame, end <= chunk.startFrame,
               document.meta.chunks[position].status == .awaitingBatch {
                document.meta.chunks[position].status = .batched
            }
        }
        document.meta.status = .finishing
        if document.meta.endedAt == nil {
            document.meta.endedAt = document.meta.startedAt.addingTimeInterval(document.meta.durationSeconds)
        }
        return document
    }

    /// Frames actually in a part's mic recording — the truth after a crash.
    public nonisolated static func framesOnDisk(folder: URL, part: MeetingPart) -> Int64? {
        let url = folder.appendingPathComponent(part.micFileName)
        guard let file = try? AVAudioFile(forReading: url, commonFormat: .pcmFormatInt16, interleaved: true) else {
            return nil
        }
        return file.length
    }
}
