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

/// The meeting pipeline's one audio format: 16kHz mono Int16, byte-for-byte what
/// the Live socket takes and what every CAF Bento writes contains.
public enum MeetingAudio {
    public static let sampleRate: Double = 16_000

    public static func seconds(_ frames: Int64) -> Double { Double(frames) / sampleRate }
    public static func frames(_ seconds: Double) -> Int64 { Int64((seconds * sampleRate).rounded()) }
}

public struct MeetingFrameRange: Codable, Equatable, Sendable {
    public var start: Int64
    public var end: Int64

    public init(start: Int64, end: Int64) {
        self.start = start
        self.end = end
    }
}

/// One continuous capture: meeting start to pause, resume to stop, or the span
/// between two mic restarts. Each part has its own files, and frame offsets in
/// chunks are relative to the part they belong to.
public struct MeetingPart: Codable, Equatable, Sendable {
    public var index: Int
    public var startedAt: Date
    /// Frames delivered to the stream, which equals frames in the mic CAF: the
    /// capture engine hands a buffer on only after writing it.
    public var frames: Int64
    public var hasSystemAudio: Bool
    /// Where the mic was kept out of the stream because the user was dictating.
    /// Batch re-transcription applies the same ranges, or a dictation the live
    /// stream never heard would reappear in the notes.
    public var mutedRanges: [MeetingFrameRange]
    public var ended: Bool

    public init(index: Int, startedAt: Date) {
        self.index = index
        self.startedAt = startedAt
        self.frames = 0
        self.hasSystemAudio = false
        self.mutedRanges = []
        self.ended = false
    }

    public var micFileName: String { "part-\(index)-mic.caf" }
    public var systemFileName: String { "part-\(index)-system.caf" }
}

/// A span of one part that a single transcript source covers: one Live session,
/// or a stretch with no session that the batch path transcribes from disk.
public struct MeetingChunk: Codable, Equatable, Sendable {
    public enum Status: String, Codable, Sendable {
        /// A Live session is attached. Also the state while a closed chunk's
        /// session is flushing its last utterance.
        case streaming
        /// Audio only — Live is unavailable, failed, or reconnecting.
        case buffering
        /// The Live session ended cleanly; its finals are the transcript.
        case complete
        /// Closed, and must be transcribed from the recording.
        case awaitingBatch
        /// The batch transcript replaced whatever Live produced for this span.
        case batched
        /// Batch gave up on a permanent error. Retry is manual.
        case failed
    }

    public var index: Int
    public var part: Int
    public var startFrame: Int64
    public var endFrame: Int64?
    public var status: Status
    public var attempts: Int
    public var lastError: String?

    public init(index: Int, part: Int, startFrame: Int64, status: Status) {
        self.index = index
        self.part = part
        self.startFrame = startFrame
        self.endFrame = nil
        self.status = status
        self.attempts = 0
        self.lastError = nil
    }

    public var isOpen: Bool { endFrame == nil }

    /// True while this span's text may still be replaced wholesale.
    public var isProvisional: Bool {
        switch status {
        case .buffering, .awaitingBatch, .failed: return true
        case .streaming, .complete, .batched: return false
        }
    }
}

/// One final transcript from the model, as it arrived. Never edited in place:
/// cleanup produces blocks over segments, and batch replaces a chunk's segments.
public struct MeetingSegment: Codable, Equatable, Sendable, Identifiable {
    public var id: Int
    public var chunk: Int
    /// Seconds into the meeting's recorded audio (paused time excluded).
    public var start: Double
    public var text: String
    public var fromBatch: Bool
    public var receivedAt: Date

    public init(id: Int, chunk: Int, start: Double, text: String, fromBatch: Bool, receivedAt: Date) {
        self.id = id
        self.chunk = chunk
        self.start = start
        self.text = text
        self.fromBatch = fromBatch
        self.receivedAt = receivedAt
    }
}

/// Cleaned text covering a contiguous run of one chunk's segments. Blocks never
/// span chunks, so replacing a chunk only ever invalidates that chunk's blocks.
public struct MeetingBlock: Codable, Equatable, Sendable {
    public var chunk: Int
    public var firstSegment: Int
    public var lastSegment: Int
    public var start: Double
    public var text: String
    /// False when the cleanup model was unavailable or its output was rejected,
    /// and this is the raw text with dictionary corrections applied.
    public var cleaned: Bool

    public init(chunk: Int, firstSegment: Int, lastSegment: Int, start: Double, text: String, cleaned: Bool) {
        self.chunk = chunk
        self.firstSegment = firstSegment
        self.lastSegment = lastSegment
        self.start = start
        self.text = text
        self.cleaned = cleaned
    }
}

public struct MeetingActionItem: Codable, Equatable, Sendable {
    public var task: String
    public var owner: String?
    public var due: String?

    public init(task: String, owner: String? = nil, due: String? = nil) {
        self.task = task
        self.owner = owner
        self.due = due
    }
}

public struct MeetingSummary: Codable, Equatable, Sendable {
    public var title: String
    public var overview: [String]
    public var decisions: [String]
    public var actionItems: [MeetingActionItem]

    public init(title: String, overview: [String], decisions: [String], actionItems: [MeetingActionItem]) {
        self.title = title
        self.overview = overview
        self.decisions = decisions
        self.actionItems = actionItems
    }
}

/// What the meeting cost, from the model's own usage reports where it sends
/// them. An estimate: Vertex and the public API price these identically today,
/// but nothing here asks the billing system.
public struct MeetingUsage: Codable, Equatable, Sendable {
    public var liveAudioTokens: Int = 0
    public var liveTextTokens: Int = 0
    public var batchSeconds: Double = 0
    public var textCalls: Int = 0

    public init() {}

    /// Published Live Transcribe rates: $3.50 per 1M audio tokens in, $21 per 1M
    /// text tokens out. Batch Transcribe is about $0.005 per minute. Text-model
    /// calls are small and left out rather than guessed.
    public var estimatedCostUSD: Double {
        Double(liveAudioTokens) * 3.5 / 1_000_000
            + Double(liveTextTokens) * 21 / 1_000_000
            + batchSeconds / 60 * 0.005
    }
}

public struct MeetingMeta: Codable, Equatable, Sendable {
    public enum Status: String, Codable, Sendable {
        case recording
        case paused
        /// Capture is over; batch, cleanup and summary are still running.
        case finishing
        case complete
        /// The app quit or crashed with this meeting in flight. Launch recovery
        /// turns it back into `finishing` from what reached disk.
        case interrupted
    }

    public var id: UUID
    public var startedAt: Date
    public var endedAt: Date?
    public var status: Status
    public var title: String?
    public var titleIsUserSet: Bool
    public var parts: [MeetingPart]
    public var chunks: [MeetingChunk]
    public var summary: MeetingSummary?
    public var summaryError: String?
    public var usage: MeetingUsage

    public init(id: UUID, startedAt: Date) {
        self.id = id
        self.startedAt = startedAt
        self.endedAt = nil
        self.status = .recording
        self.title = nil
        self.titleIsUserSet = false
        self.parts = []
        self.chunks = []
        self.summary = nil
        self.summaryError = nil
        self.usage = MeetingUsage()
    }

    public var recordedFrames: Int64 { parts.reduce(0) { $0 + $1.frames } }
    public var durationSeconds: Double { MeetingAudio.seconds(recordedFrames) }

    /// Frames recorded before `part` began — the offset that turns a part-local
    /// frame into meeting time.
    public func frameBase(ofPart part: Int) -> Int64 {
        parts.filter { $0.index < part }.reduce(0) { $0 + $1.frames }
    }

    public func meetingSeconds(part: Int, frame: Int64) -> Double {
        MeetingAudio.seconds(frameBase(ofPart: part) + frame)
    }

    public func part(_ index: Int) -> MeetingPart? { parts.first { $0.index == index } }

    /// Chunks whose audio still has to be transcribed from disk.
    public var pendingBatchCount: Int { chunks.filter { $0.status == .awaitingBatch }.count }
    public var failedChunkCount: Int { chunks.filter { $0.status == .failed }.count }
}

public struct MeetingTranscript: Codable, Equatable, Sendable {
    public var segments: [MeetingSegment]
    public var blocks: [MeetingBlock]
    public var nextSegmentID: Int

    public init() {
        self.segments = []
        self.blocks = []
        self.nextSegmentID = 1
    }

    /// The last segment of `chunk` covered by a block, or 0 when none is.
    public func cleanedThrough(chunk: Int) -> Int {
        blocks.filter { $0.chunk == chunk }.map(\.lastSegment).max() ?? 0
    }

    public func pendingSegments(chunk: Int) -> [MeetingSegment] {
        let through = cleanedThrough(chunk: chunk)
        return segments.filter { $0.chunk == chunk && $0.id > through }.sorted { $0.id < $1.id }
    }

    public var wordCount: Int {
        segments.reduce(0) { $0 + $1.text.split(whereSeparator: \.isWhitespace).count }
    }
}

/// One rendered paragraph of the notes, in reading order.
public struct MeetingParagraph: Equatable, Identifiable, Sendable {
    public enum Kind: Equatable, Sendable {
        /// Cleanup has run over it.
        case cleaned
        /// Final from the model, not cleaned yet.
        case pending
        /// Audio that has no transcript yet, or that batch gave up on.
        case gap(seconds: Double, failed: Bool)
    }

    public var id: String
    public var start: Double?
    public var text: String
    public var kind: Kind
}

public struct MeetingDocument: Equatable, Sendable {
    public var folder: URL
    public var meta: MeetingMeta
    public var transcript: MeetingTranscript

    public init(folder: URL, meta: MeetingMeta, transcript: MeetingTranscript) {
        self.folder = folder
        self.meta = meta
        self.transcript = transcript
    }

    public var displayTitle: String {
        if let title = meta.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty {
            return title
        }
        return "Meeting, " + meta.startedAt.formatted(date: .abbreviated, time: .shortened)
    }

    /// Reading order: chunk by chunk, each chunk's cleaned blocks followed by
    /// whatever has arrived since the last cleanup. A chunk with no text and no
    /// transcript yet shows as a gap, so missing audio is visible rather than a
    /// silent jump in the middle of the notes.
    public var paragraphs: [MeetingParagraph] {
        var out: [MeetingParagraph] = []
        let blocksByChunk = Dictionary(grouping: transcript.blocks, by: \.chunk)
        let segmentsByChunk = Dictionary(grouping: transcript.segments, by: \.chunk)
        for chunk in meta.chunks.sorted(by: { $0.index < $1.index }) {
            let blocks = (blocksByChunk[chunk.index] ?? []).sorted { $0.firstSegment < $1.firstSegment }
            for block in blocks {
                let pieces = block.text
                    .components(separatedBy: "\n\n")
                    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }
                for (offset, piece) in pieces.enumerated() {
                    out.append(MeetingParagraph(
                        id: "b\(block.chunk)-\(block.firstSegment)-\(offset)",
                        start: offset == 0 ? block.start : nil,
                        text: piece,
                        kind: .cleaned
                    ))
                }
            }
            let through = blocks.map(\.lastSegment).max() ?? 0
            let pending = (segmentsByChunk[chunk.index] ?? [])
                .filter { $0.id > through }
                .sorted { $0.id < $1.id }
            if !pending.isEmpty {
                out.append(MeetingParagraph(
                    id: "p\(chunk.index)-\(pending[0].id)",
                    start: blocks.isEmpty ? pending[0].start : nil,
                    text: pending.map(\.text).joined(separator: " "),
                    kind: .pending
                ))
            } else if blocks.isEmpty, chunk.status == .awaitingBatch || chunk.status == .failed,
                      let end = chunk.endFrame, end > chunk.startFrame {
                out.append(MeetingParagraph(
                    id: "g\(chunk.index)",
                    start: meta.meetingSeconds(part: chunk.part, frame: chunk.startFrame),
                    text: "",
                    kind: .gap(seconds: MeetingAudio.seconds(end - chunk.startFrame), failed: chunk.status == .failed)
                ))
            }
        }
        return out
    }

    /// The transcript as plain text, cleaned where cleanup has run — what the
    /// summary is written from.
    public var plainTranscript: String {
        paragraphs.compactMap { paragraph -> String? in
            if case .gap = paragraph.kind { return nil }
            return paragraph.text
        }
        .joined(separator: "\n\n")
    }

    public var markdown: String {
        var lines: [String] = ["# \(displayTitle)", ""]
        var subtitle = meta.startedAt.formatted(date: .long, time: .shortened)
        let minutes = Int((meta.durationSeconds / 60).rounded())
        if meta.durationSeconds > 0 { subtitle += " · \(max(1, minutes)) min" }
        lines.append("_\(subtitle)_")
        lines.append("")
        if let summary = meta.summary {
            if !summary.overview.isEmpty {
                lines.append("## Summary")
                lines += summary.overview.map { "- \($0)" }
                lines.append("")
            }
            if !summary.decisions.isEmpty {
                lines.append("## Decisions")
                lines += summary.decisions.map { "- \($0)" }
                lines.append("")
            }
            if !summary.actionItems.isEmpty {
                lines.append("## Action items")
                for item in summary.actionItems {
                    var line = "- [ ] "
                    if let owner = item.owner, !owner.isEmpty { line += "**\(owner)**: " }
                    line += item.task
                    if let due = item.due, !due.isEmpty { line += " (due \(due))" }
                    lines.append(line)
                }
                lines.append("")
            }
        }
        lines.append("## Transcript")
        lines.append("")
        let paragraphs = self.paragraphs
        if paragraphs.isEmpty {
            lines.append("_Nothing transcribed yet._")
            lines.append("")
        }
        for paragraph in paragraphs {
            let stamp = paragraph.start.map { "**[\(Self.timestamp($0))]** " } ?? ""
            switch paragraph.kind {
            case .cleaned, .pending:
                lines.append(stamp + paragraph.text)
            case .gap(let seconds, let failed):
                let length = Self.timestamp(seconds)
                lines.append(stamp + (failed
                    ? "_\(length) of audio could not be transcribed. Retry from Bento's Meetings window._"
                    : "_\(length) of audio is still being transcribed._"))
            }
            lines.append("")
        }
        return lines.joined(separator: "\n")
    }

    /// "4:07", or "1:02:09" past the hour.
    public static func timestamp(_ seconds: Double) -> String {
        let total = max(0, Int(seconds.rounded(.down)))
        let hours = total / 3600, minutes = (total % 3600) / 60, secs = total % 60
        return hours > 0
            ? String(format: "%d:%02d:%02d", hours, minutes, secs)
            : String(format: "%d:%02d", minutes, secs)
    }
}
