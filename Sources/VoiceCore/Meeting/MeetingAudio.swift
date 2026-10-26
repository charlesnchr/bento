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

/// Where the mixed stream goes, and the frame count chunk boundaries are cut at.
///
/// Counting and target selection happen in one critical section, so a switch
/// lands exactly between two buffers: everything before the returned frame went
/// to the old session, everything after goes to the new one. That exactness is
/// what lets a rotation hand off without losing or doubling a word.
public final class MeetingStreamRouter: @unchecked Sendable {
    private let lock = NSLock()
    private var target: (@Sendable (Data) -> Void)?
    private var frames: Int64 = 0

    public init() {}

    /// Called on the audio write queue for every mixed buffer.
    public func deliver(_ pcm: Data) {
        lock.lock()
        frames += Int64(pcm.count / 2)
        let target = self.target
        lock.unlock()
        target?(pcm)
    }

    /// Points the stream somewhere else and returns the boundary frame.
    @discardableResult
    public func attach(_ target: (@Sendable (Data) -> Void)?) -> Int64 {
        lock.lock()
        defer { lock.unlock() }
        self.target = target
        return frames
    }

    public var framesDelivered: Int64 {
        lock.lock(); defer { lock.unlock() }
        return frames
    }
}

/// Keeps the mic out of the meeting stream while the user dictates. Read on the
/// audio queue, flipped from the main actor.
public final class MeetingMuteSwitch: @unchecked Sendable {
    private let lock = NSLock()
    private var muted = false

    public init() {}

    public var isMuted: Bool {
        get { lock.lock(); defer { lock.unlock() }; return muted }
        set { lock.lock(); muted = newValue; lock.unlock() }
    }
}

/// Mixes the mic with system audio, driven by the mic's clock: each mic buffer
/// pulls exactly as many system samples, so the system CAF stays sample-aligned
/// with the mic CAF and either file can be re-mixed later for any frame range.
final class MeetingMixer: @unchecked Sendable {
    private let fifo: SampleFIFO?
    private let systemWriter: CAFWriter?
    private let mute: MeetingMuteSwitch
    private let deliver: @Sendable (Data) -> Void
    private let format = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: MeetingAudio.sampleRate, channels: 1, interleaved: true
    )!
    private let lock = NSLock()
    private var frames: Int64 = 0
    private var muteStart: Int64?
    private var ranges: [MeetingFrameRange] = []
    private var systemLevel: Float = 0

    init(fifo: SampleFIFO?, systemWriter: CAFWriter?, mute: MeetingMuteSwitch, deliver: @escaping @Sendable (Data) -> Void) {
        self.fifo = fifo
        self.systemWriter = systemWriter
        self.mute = mute
        self.deliver = deliver
    }

    /// The capture engine's pcm sink: runs on its write queue, after the mic
    /// buffer is already on disk. Must not block.
    func ingest(mic: Data) {
        let count = mic.count / 2
        guard count > 0 else { return }
        var mixed = [Int16](repeating: 0, count: count)
        let muted = mute.isMuted
        if !muted {
            mixed.withUnsafeMutableBytes { _ = mic.copyBytes(to: $0) }
        }
        lock.lock()
        if muted, muteStart == nil { muteStart = frames }
        if !muted, let start = muteStart {
            ranges.append(MeetingFrameRange(start: start, end: frames))
            muteStart = nil
        }
        lock.unlock()

        if let fifo {
            let system = fifo.pull(count)
            writeSystem(system)
            var sumSquares: Float = 0
            for index in 0..<count {
                let sample = system[index]
                sumSquares += Float(sample) * Float(sample)
                mixed[index] = Int16(clamping: Int32(mixed[index]) + Int32(sample))
            }
            let rms = (sumSquares / Float(count)).squareRoot() / 32_768
            lock.lock(); systemLevel = AudioLevelCurve.level(fromRMS: rms); lock.unlock()
        }

        lock.lock(); frames += Int64(count); lock.unlock()
        deliver(mixed.withUnsafeBufferPointer { Data(buffer: $0) })
    }

    private func writeSystem(_ samples: [Int16]) {
        guard let systemWriter,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
              let channel = buffer.int16ChannelData
        else { return }
        samples.withUnsafeBufferPointer { channel[0].update(from: $0.baseAddress!, count: samples.count) }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        try? systemWriter.write(buffer)
    }

    var latestSystemLevel: Float {
        lock.lock(); defer { lock.unlock() }
        return systemLevel
    }

    var mutedRanges: [MeetingFrameRange] {
        lock.lock(); defer { lock.unlock() }
        if let start = muteStart { return ranges + [MeetingFrameRange(start: start, end: frames)] }
        return ranges
    }

    /// Called after the engine has stopped delivering. Closes the system file.
    func finish() -> (frames: Int64, mutedRanges: [MeetingFrameRange]) {
        let ranges = mutedRanges
        lock.lock()
        let total = frames
        lock.unlock()
        systemWriter?.close()
        return (frames: total, mutedRanges: ranges)
    }
}

/// What the recorder needs from a capture backend. The real one is mic + system
/// audio; probes substitute a file played back at real time.
public protocol MeetingAudioSource: AnyObject {
    /// 0…1, roughly 10Hz, on an arbitrary queue.
    var onLevel: ((Float) -> Void)? { get set }
    /// The capture died and could not recover itself. Audio up to here is kept.
    var onDied: ((String) -> Void)? { get set }
    /// Starts writing the part's files and delivering mixed 16kHz mono Int16 to
    /// `deliver`. Returns whether system audio is part of the mix.
    func start(folder: URL, part: MeetingPart, mute: MeetingMuteSwitch,
               deliver: @escaping @Sendable (Data) -> Void) throws -> Bool
    /// Stops, drains, and closes the part's files.
    func stop() async -> (frames: Int64, mutedRanges: [MeetingFrameRange])
}

/// The real capture: Bento's crash-safe mic recorder, plus a system audio tap
/// when one is wanted and the OS supports it.
///
/// The mic gets its own `AudioCaptureEngine`, separate from the warm pool
/// dictation draws from, so dictating mid-meeting opens a second engine on the
/// same input rather than stealing this one.
public final class MeetingCapture: MeetingAudioSource {
    public var onLevel: ((Float) -> Void)?
    public var onDied: ((String) -> Void)?

    private let captureSystemAudio: Bool
    private var engine: AudioCaptureEngine?
    private var mixer: MeetingMixer?
    private var tap: AnyObject?

    public init(captureSystemAudio: Bool) {
        self.captureSystemAudio = captureSystemAudio
    }

    public func start(folder: URL, part: MeetingPart, mute: MeetingMuteSwitch,
                      deliver: @escaping @Sendable (Data) -> Void) throws -> Bool {
        let format = AVAudioFormat(
            commonFormat: .pcmFormatInt16, sampleRate: MeetingAudio.sampleRate, channels: 1, interleaved: true
        )!
        var fifo: SampleFIFO?
        if captureSystemAudio, #available(macOS 14.2, *) {
            let candidate = SampleFIFO()
            let tap = SystemAudioTap(fifo: candidate)
            do {
                try tap.start()
                self.tap = tap
                fifo = candidate
            } catch {
                // A meeting with only the mic is still a meeting. Say so in the
                // log; the part records hasSystemAudio = false for the notes.
                Log.audio.error("system audio unavailable, recording the mic only: \(String(describing: error), privacy: .public)")
            }
        }
        let systemWriter = fifo == nil
            ? nil
            : try? CAFWriter(url: folder.appendingPathComponent(part.systemFileName), format: format)
        let mixer = MeetingMixer(fifo: systemWriter == nil ? nil : fifo, systemWriter: systemWriter,
                                 mute: mute, deliver: deliver)
        let engine = AudioCaptureEngine()
        engine.onLevel = { [weak self, weak mixer] level in
            self?.onLevel?(max(level, mixer?.latestSystemLevel ?? 0))
        }
        engine.onDeviceChange = { message in
            Log.audio.info("meeting mic: \(message, privacy: .public)")
        }
        engine.onEngineDied = { [weak self] message in self?.onDied?(message) }
        engine.onWriteFailure = { [weak self] in self?.onDied?("Disk problem") }
        do {
            try engine.start(writingTo: folder.appendingPathComponent(part.micFileName),
                             pcmSink: { [mixer] pcm in mixer.ingest(mic: pcm) })
        } catch {
            stopTap()
            throw error
        }
        self.engine = engine
        self.mixer = mixer
        return systemWriter != nil
    }

    public func stop() async -> (frames: Int64, mutedRanges: [MeetingFrameRange]) {
        let engine = self.engine
        self.engine = nil
        _ = await engine?.stop()
        stopTap()
        let result = mixer?.finish() ?? (frames: 0, mutedRanges: [])
        mixer = nil
        return result
    }

    private func stopTap() {
        if #available(macOS 14.2, *), let tap = tap as? SystemAudioTap {
            tap.stop()
        }
        tap = nil
    }
}

/// Reads recorded audio back for the batch path: the same mix the live stream
/// heard, for any frame range of a part.
public enum MeetingAudioExtractor {
    public enum ExtractError: Error {
        case missingAudio
    }

    /// Mic (with dictation ranges silenced) plus system audio, as Int16 samples.
    /// Shorter files — a crash mid-part — are padded so the two stay aligned.
    public static func samples(folder: URL, part: MeetingPart, range: MeetingFrameRange) throws -> [Int16] {
        let micURL = folder.appendingPathComponent(part.micFileName)
        guard FileManager.default.fileExists(atPath: micURL.path) else { throw ExtractError.missingAudio }
        let count = Int(max(0, range.end - range.start))
        var mixed = try read(micURL, range: range, count: count)
        for muted in part.mutedRanges {
            let lower = max(muted.start, range.start) - range.start
            let upper = min(muted.end, range.end) - range.start
            if lower < upper {
                for index in Int(lower)..<Int(upper) { mixed[index] = 0 }
            }
        }
        let systemURL = folder.appendingPathComponent(part.systemFileName)
        if part.hasSystemAudio, FileManager.default.fileExists(atPath: systemURL.path) {
            let system = try read(systemURL, range: range, count: count)
            for index in 0..<count {
                mixed[index] = Int16(clamping: Int32(mixed[index]) + Int32(system[index]))
            }
        }
        return mixed
    }

    private static func read(_ url: URL, range: MeetingFrameRange, count: Int) throws -> [Int16] {
        var out = [Int16]()
        out.reserveCapacity(count)
        let file = try AVAudioFile(forReading: url, commonFormat: .pcmFormatInt16, interleaved: true)
        if range.start < file.length {
            file.framePosition = range.start
            let end = min(range.end, file.length)
            guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 65_536) else {
                throw ExtractError.missingAudio
            }
            // Bounded by framePosition, never by read() throwing at EOF — the
            // Int16 client format can raise a spurious error there (FLACEncoder).
            while file.framePosition < end {
                let want = AVAudioFrameCount(min(Int64(buffer.frameCapacity), end - file.framePosition))
                try file.read(into: buffer, frameCount: want)
                guard buffer.frameLength > 0, let channel = buffer.int16ChannelData else { break }
                out.append(contentsOf: UnsafeBufferPointer(start: channel[0], count: Int(buffer.frameLength)))
            }
        }
        if out.count < count { out.append(contentsOf: repeatElement(0, count: count - out.count)) }
        if out.count > count { out.removeLast(out.count - count) }
        return out
    }

    /// Splits a long stretch into uploads of at most about `maxSeconds`, moving
    /// each cut to the quietest 200ms nearby so it falls between words.
    public static func windows(sampleCount: Int, samples: [Int16], maxSeconds: Double = 300,
                               searchSeconds: Double = 15) -> [Range<Int>] {
        let maxFrames = Int(maxSeconds * MeetingAudio.sampleRate)
        guard sampleCount > maxFrames, maxFrames > 0 else { return [0..<sampleCount] }
        let pieces = Int((Double(sampleCount) / Double(maxFrames)).rounded(.up))
        let search = Int(searchSeconds * MeetingAudio.sampleRate)
        let probe = Int(0.2 * MeetingAudio.sampleRate)
        let step = Int(0.05 * MeetingAudio.sampleRate)
        var cuts: [Int] = []
        for piece in 1..<pieces {
            let ideal = sampleCount * piece / pieces
            var best = ideal
            var bestEnergy = Double.infinity
            var position = max(0, ideal - search)
            let limit = min(sampleCount - probe, ideal + search)
            while position <= limit {
                var energy: Double = 0
                for index in position..<(position + probe) {
                    let value = Double(samples[index])
                    energy += value * value
                }
                if energy < bestEnergy {
                    bestEnergy = energy
                    best = position + probe / 2
                }
                position += step
            }
            if let last = cuts.last, best <= last { best = min(sampleCount - 1, last + step) }
            cuts.append(best)
        }
        var ranges: [Range<Int>] = []
        var lower = 0
        for cut in cuts where cut > lower {
            ranges.append(lower..<cut)
            lower = cut
        }
        ranges.append(lower..<sampleCount)
        return ranges
    }

    /// Writes samples as a CAF the FLAC encoder can read.
    public static func writeCAF(_ samples: ArraySlice<Int16>, to url: URL) throws {
        let format = AVAudioFormat(
            commonFormat: .pcmFormatInt16, sampleRate: MeetingAudio.sampleRate, channels: 1, interleaved: true
        )!
        let writer = try CAFWriter(url: url, format: format)
        defer { writer.close() }
        var offset = samples.startIndex
        while offset < samples.endIndex {
            let take = min(65_536, samples.endIndex - offset)
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(take)),
                  let channel = buffer.int16ChannelData else { throw ExtractError.missingAudio }
            samples[offset..<(offset + take)].withUnsafeBufferPointer {
                channel[0].update(from: $0.baseAddress!, count: take)
            }
            buffer.frameLength = AVAudioFrameCount(take)
            try writer.write(buffer)
            offset += take
        }
    }
}
