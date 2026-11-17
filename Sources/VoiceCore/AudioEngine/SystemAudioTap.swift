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
import CoreAudio
import Foundation

/// A thread-safe FIFO of 16kHz mono Int16 samples between a producer on one
/// clock and a consumer on another — the system-audio tap and the mic.
///
/// `pull` never waits: short reads are padded with silence, and a backlog past
/// `maxBacklog` is trimmed oldest-first so the two clocks drifting apart over an
/// hour (or the mic pausing for a device rebuild) can never accumulate lag.
public final class SampleFIFO: @unchecked Sendable {
    private var samples: [Int16] = []
    private var head = 0
    private let capacity: Int
    private let maxBacklog: Int
    private let lock = NSLock()

    /// The backlog bound is also the alignment bound: with speakers the mic
    /// hears the far end too, and two copies more than a beat apart read to the
    /// model as an echo.
    public init(capacitySeconds: Double = 2, maxBacklogSeconds: Double = 0.12) {
        self.capacity = Int(capacitySeconds * MeetingAudio.sampleRate)
        self.maxBacklog = Int(maxBacklogSeconds * MeetingAudio.sampleRate)
        samples.reserveCapacity(capacity)
    }

    public func append(_ incoming: UnsafeBufferPointer<Int16>) {
        guard !incoming.isEmpty else { return }
        lock.lock()
        defer { lock.unlock() }
        samples.append(contentsOf: incoming)
        let overflow = (samples.count - head) - capacity
        if overflow > 0 { head += overflow }
        compactIfNeeded()
    }

    public func append(_ incoming: [Int16]) {
        incoming.withUnsafeBufferPointer { append($0) }
    }

    /// Exactly `count` samples: the oldest available, padded with silence.
    public func pull(_ count: Int) -> [Int16] {
        lock.lock()
        defer { lock.unlock() }
        let available = samples.count - head
        if available > count + maxBacklog {
            head += available - count - maxBacklog
        }
        let take = min(count, samples.count - head)
        var out = Array(samples[head..<(head + take)])
        head += take
        if take < count { out.append(contentsOf: repeatElement(0, count: count - take)) }
        compactIfNeeded()
        return out
    }

    public var count: Int {
        lock.lock(); defer { lock.unlock() }
        return samples.count - head
    }

    private func compactIfNeeded() {
        if head > 0, head >= samples.count / 2 {
            samples.removeFirst(head)
            head = 0
        }
    }
}

/// The tap's samples, out of the input an aggregate device hands its IOProc.
///
/// The tap's streams are the last ones. Bento's aggregate holds nothing else,
/// but one that also held a device with a mic (a USB interface, a headset)
/// would list that mic first, and reading the first buffer as the tap records
/// the mic's channel — usually silence — in place of the call.
enum TapInput {
    /// A copy, so nothing outlives the IO cycle that owns `bufferList`. Nil
    /// when the trailing buffers are not shaped like `format`.
    static func buffer(in bufferList: UnsafePointer<AudioBufferList>, format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: bufferList))
        let wanted = format.isInterleaved ? 1 : Int(format.channelCount)
        let channelsPerBuffer = format.isInterleaved ? format.channelCount : 1
        let bytesPerFrame = Int(format.streamDescription.pointee.mBytesPerFrame)
        guard wanted > 0, bytesPerFrame > 0, buffers.count >= wanted else { return nil }
        let own = buffers[(buffers.count - wanted)...]
        let byteSize = own[own.startIndex].mDataByteSize
        guard own.allSatisfy({ $0.mNumberChannels == channelsPerBuffer && $0.mDataByteSize == byteSize && $0.mData != nil })
        else { return nil }
        let frames = Int(byteSize) / bytesPerFrame
        guard frames > 0, let copy = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))
        else { return nil }
        copy.frameLength = AVAudioFrameCount(frames)
        let target = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        for (index, source) in own.enumerated() {
            memcpy(target[index].mData, source.mData, frames * bytesPerFrame)
        }
        return copy
    }
}

/// Decides when a tap that has stopped delivering needs rebuilding.
///
/// A tap's IOProc runs whether or not anything is playing (measured on a
/// tap-only aggregate over a silent process), so a quiet call is not a stall;
/// no callbacks is. That was seen when the aggregate still held the output
/// device: Bluetooth headphones drop from music to call mode the moment the
/// meeting opens their mic, the HAL stops the aggregate's IO for the switch,
/// and its own restart can fail without a word.
struct TapWatchdog {
    enum Fault: Equatable {
        case notBuilt
        case formatChanged
        case stalled
    }

    var stallAfter: TimeInterval = 0.75
    /// How long each rebuild gets to prove itself; a device that stays broken
    /// is retried ever more slowly.
    var backoff: [TimeInterval] = [1, 2, 4, 8]
    private var attempts = 0
    private var holdUntil: TimeInterval = 0

    /// Why to rebuild now, if at all. `now` and `lastIO` share a monotonic
    /// clock, and `lastIO` is the IOProc's own: a build must not set it, or a
    /// tap that never delivers reads as recovered. `formatChanged` is only
    /// asked of a built tap that is not being held.
    mutating func check(now: TimeInterval, lastIO: TimeInterval, built: Bool,
                        formatChanged: @autoclosure () -> Bool) -> Fault? {
        guard now >= holdUntil else { return nil }
        let fault: Fault? = !built ? .notBuilt
            : formatChanged() ? .formatChanged
            : now - lastIO > stallAfter ? .stalled : nil
        guard let fault else {
            attempts = 0
            return nil
        }
        holdUntil = now + hold(after: attempts)
        attempts += 1
        return fault
    }

    /// A build finished at `now`, for whatever reason: nothing is judged until
    /// it has had its time to deliver.
    mutating func rebuilt(now: TimeInterval) {
        holdUntil = max(holdUntil, now + hold(after: 0))
    }

    private func hold(after attempts: Int) -> TimeInterval {
        backoff.isEmpty ? 1 : backoff[min(attempts, backoff.count - 1)]
    }
}

/// Captures what the Mac is playing — the other side of a call — through a
/// Core Audio process tap on every process except Bento itself (so earcons never
/// reach the notes), read through a private aggregate device that holds the tap
/// and nothing else.
///
/// The tap is rebuilt whenever the default output moves, its format changes or
/// its IO stops arriving, so a device change mid-meeting costs a second of the
/// far side, not the rest of the call.
///
/// Requires macOS 14.2+ and `NSAudioCaptureUsageDescription`. The first start
/// asks for "System Audio Recording" permission; when it is denied the tap
/// keeps running and delivers silence, which the mixer treats like a quiet call.
@available(macOS 14.2, *)
public final class SystemAudioTap {
    public enum TapError: Error, Equatable {
        case createTap(OSStatus)
        case unreadableFormat
        case aggregate(OSStatus)
        case ioProc(OSStatus)
        case start(OSStatus)
    }

    private let fifo: SampleFIFO
    private let queue = DispatchQueue(label: "com.charles.bento.voice.meeting.system-tap", qos: .userInitiated)
    /// Device-change handling must not share the IO queue: stopping the device
    /// from the queue its IOProc is dispatched onto can deadlock against it.
    private let controlQueue = DispatchQueue(label: "com.charles.bento.voice.meeting.system-tap.control")
    private let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: MeetingAudio.sampleRate, channels: 1, interleaved: true
    )!
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private var tapFormat: AVAudioFormat?
    private var converter: AVAudioConverter?
    private var outputListener: AudioObjectPropertyListenerBlock?
    /// When the IOProc last ran, on `now()`'s clock.
    private var lastIO: TimeInterval = 0
    /// Whether this build's input has already been reported as unreadable.
    private var refusalLogged = false
    private let stateLock = NSLock()
    // Only on `controlQueue`, like every build and teardown after `init`.
    private var stopped = true
    private var watchdog = TapWatchdog()
    private var watchdogTimer: DispatchSourceTimer?
    private let onControlQueue = DispatchSpecificKey<Bool>()

    public init(fifo: SampleFIFO) {
        self.fifo = fifo
        controlQueue.setSpecific(key: onControlQueue, value: true)
    }

    deinit {
        stop()
    }

    public func start() throws {
        try onControl {
            stopped = false
            watchdog = TapWatchdog()
            do {
                try build()
            } catch {
                stopped = true
                throw error
            }
            watchdog.rebuilt(now: Self.now())
        }
        listenForOutputChanges()
        startWatchdog()
    }

    public func stop() {
        if let outputListener {
            var address = Self.defaultOutputAddress
            AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, controlQueue, outputListener)
            self.outputListener = nil
        }
        onControl {
            stopped = true
            watchdogTimer?.cancel()
            watchdogTimer = nil
            tearDown()
        }
    }

    /// Runs `body` on the control queue, from anywhere — the last reference can
    /// go away inside one of that queue's own blocks.
    private func onControl<T>(_ body: () throws -> T) rethrows -> T {
        if DispatchQueue.getSpecific(key: onControlQueue) == true { return try body() }
        return try controlQueue.sync(execute: body)
    }

    private static func now() -> TimeInterval {
        TimeInterval(DispatchTime.now().uptimeNanoseconds) / 1_000_000_000
    }

    // MARK: - Graph

    private func build() throws {
        let excluded = Self.ownProcessObject().map { [$0] } ?? []
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: excluded)
        description.uuid = UUID()
        description.name = "Bento meeting capture"
        description.isPrivate = true
        description.muteBehavior = .unmuted

        var tap = AudioObjectID(kAudioObjectUnknown)
        var status = AudioHardwareCreateProcessTap(description, &tap)
        guard status == noErr else { throw TapError.createTap(status) }
        stateLock.lock(); tapID = tap; stateLock.unlock()

        // No sub-device. With the output device in it the aggregate runs at that
        // device's rate and hands over the tap resampled to it — 44.1kHz for
        // Bluetooth music, 16kHz once the headset's mic opens — while the tap
        // and its stream still report 48kHz, so the recording came out as bursts
        // of sped-up sound. Alone, the tap keeps its own rate through all of that.
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Bento Meeting Capture",
            kAudioAggregateDeviceUIDKey: "com.charles.bento.voice.meeting-tap.\(UUID().uuidString)",
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapDriftCompensationKey: true,
                kAudioSubTapUIDKey: description.uuid.uuidString,
            ]],
        ]
        var device = AudioObjectID(kAudioObjectUnknown)
        status = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &device)
        guard status == noErr else {
            tearDown()
            throw TapError.aggregate(status)
        }
        stateLock.lock(); aggregateID = device; stateLock.unlock()

        guard let format = Self.format(of: tap, through: device),
              let converter = AVAudioConverter(from: format, to: targetFormat)
        else {
            tearDown()
            throw TapError.unreadableFormat
        }
        // Without this a stereo mix becomes its left channel, and a voice panned
        // right — some conferencing apps do this — goes missing.
        converter.downmix = true
        stateLock.lock()
        tapFormat = format
        self.converter = converter
        refusalLogged = false
        stateLock.unlock()

        var proc: AudioDeviceIOProcID?
        status = AudioDeviceCreateIOProcIDWithBlock(&proc, device, queue) { [weak self] _, input, _, _, _ in
            self?.ingest(input)
        }
        guard status == noErr, let proc else {
            tearDown()
            throw TapError.ioProc(status)
        }
        stateLock.lock(); procID = proc; stateLock.unlock()
        status = AudioDeviceStart(device, proc)
        guard status == noErr else {
            tearDown()
            throw TapError.start(status)
        }
        let inputs = Self.inputStreamChannels(of: device).map(String.init).joined(separator: "+")
        Log.audio.info("system audio tap running: \(Int(format.sampleRate))Hz/\(format.channelCount)ch, output \(Self.defaultOutputUID() ?? "none", privacy: .public), input streams \(inputs, privacy: .public)")
    }

    private func tearDown() {
        stateLock.lock()
        let device = aggregateID, proc = procID, tap = tapID
        aggregateID = AudioObjectID(kAudioObjectUnknown)
        procID = nil
        tapID = AudioObjectID(kAudioObjectUnknown)
        converter = nil
        tapFormat = nil
        stateLock.unlock()
        if device != kAudioObjectUnknown {
            if let proc {
                AudioDeviceStop(device, proc)
                AudioDeviceDestroyIOProcID(device, proc)
            }
            AudioHardwareDestroyAggregateDevice(device)
        }
        if tap != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tap)
        }
    }

    /// Rebuilds when the user moves output (AirPods connect mid-call). Whether a
    /// tap made before the move still hears the new device was never measured.
    private func listenForOutputChanges() {
        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            self?.rebuild("default output changed")
        }
        var address = Self.defaultOutputAddress
        if AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, controlQueue, listener) == noErr {
            outputListener = listener
        }
    }

    /// On `controlQueue`.
    private func rebuild(_ why: String) {
        guard !stopped else { return }
        Log.audio.info("\(why, privacy: .public) — rebuilding the system audio tap")
        tearDown()
        do {
            try build()
        } catch {
            Log.audio.error("system audio tap rebuild failed: \(String(describing: error), privacy: .public)")
        }
        watchdog.rebuilt(now: Self.now())
    }

    private func startWatchdog() {
        let timer = DispatchSource.makeTimerSource(queue: controlQueue)
        timer.schedule(deadline: .now() + 0.25, repeating: 0.25, leeway: .milliseconds(50))
        timer.setEventHandler { [weak self] in self?.checkHealth() }
        onControl { watchdogTimer = timer }
        timer.resume()
    }

    private func checkHealth() {
        guard !stopped else { return }
        stateLock.lock()
        let tap = tapID, device = aggregateID, format = tapFormat, last = lastIO
        stateLock.unlock()
        let built = tap != kAudioObjectUnknown && format != nil
        let now = Self.now()
        let fault = watchdog.check(now: now, lastIO: last, built: built,
                                   formatChanged: built && Self.format(of: tap, through: device) != format)
        switch fault {
        case .stalled: rebuild("no system audio IO for \(Int((now - last) * 1000))ms")
        case .formatChanged: rebuild("the tap's format changed")
        case .notBuilt: rebuild("the system audio tap is down")
        case nil: break
        }
    }

    // MARK: - IO (runs on `queue`)

    private func ingest(_ bufferList: UnsafePointer<AudioBufferList>) {
        stateLock.lock()
        lastIO = Self.now()
        let format = tapFormat, converter = self.converter
        stateLock.unlock()
        guard let format, let converter else { return }
        guard let input = TapInput.buffer(in: bufferList, format: format) else {
            reportRefusedInput(bufferList, format: format)
            return
        }
        let capacity = AVAudioFrameCount(Double(input.frameLength) * targetFormat.sampleRate / format.sampleRate) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }
        var fed = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if fed {
                status.pointee = .noDataNow
                return nil
            }
            fed = true
            status.pointee = .haveData
            return input
        }
        guard error == nil, output.frameLength > 0, let channel = output.int16ChannelData else { return }
        fifo.append(UnsafeBufferPointer(start: channel[0], count: Int(output.frameLength)))
    }

    /// Once per build: input that can't be read as the tap records as silence,
    /// which nothing else would say.
    private func reportRefusedInput(_ bufferList: UnsafePointer<AudioBufferList>, format: AVAudioFormat) {
        stateLock.lock()
        let first = !refusalLogged
        refusalLogged = true
        stateLock.unlock()
        guard first else { return }
        let shape = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: bufferList))
            .map { "\($0.mNumberChannels)ch/\($0.mDataByteSize)B" }.joined(separator: ",")
        Log.audio.error("system audio tap input [\(shape, privacy: .public)] is not shaped like \(format.channelCount)ch \(format.isInterleaved ? "interleaved" : "planar", privacy: .public): recording silence")
    }

    // MARK: - HAL helpers

    private static var defaultOutputAddress: AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
    }

    /// What the IOProc receives: the tap's layout at the aggregate's rate. The
    /// aggregate resamples the tap to its own rate, and that is the only place
    /// the delivered rate is reported.
    private static func format(of tap: AudioObjectID, through device: AudioObjectID) -> AVAudioFormat? {
        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        guard AudioObjectGetPropertyData(tap, &address, 0, nil, &size, &asbd) == noErr else { return nil }
        var rate: Float64 = 0
        size = UInt32(MemoryLayout<Float64>.size)
        address.mSelector = kAudioDevicePropertyNominalSampleRate
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &rate) == noErr, rate > 0 else { return nil }
        asbd.mSampleRate = rate
        return AVAudioFormat(streamDescription: &asbd)
    }

    /// Channels per input stream, in the order the IOProc receives them.
    private static func inputStreamChannels(of device: AudioObjectID) -> [UInt32] {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioObjectPropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, raw) == noErr else { return [] }
        return UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self)).map(\.mNumberChannels)
    }

    private static func ownProcessObject() -> AudioObjectID? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var pid = ProcessInfo.processInfo.processIdentifier
        var object = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address,
            UInt32(MemoryLayout<pid_t>.size), &pid, &size, &object
        )
        return status == noErr && object != kAudioObjectUnknown ? object : nil
    }

    private static func defaultOutputUID() -> String? {
        var address = defaultOutputAddress
        var device = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr,
              device != 0 else { return nil }
        var uidAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var uid: Unmanaged<CFString>?
        var uidSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(device, &uidAddress, 0, nil, &uidSize, &uid) == noErr,
              let value = uid?.takeRetainedValue() else { return nil }
        return value as String
    }
}
