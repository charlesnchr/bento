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

/// Captures what the Mac is playing — the other side of a call — through a
/// Core Audio process tap on every process except Bento itself (so earcons never
/// reach the notes), read through a private aggregate device.
///
/// Requires macOS 14.2+ and `NSAudioCaptureUsageDescription`. The first start
/// asks for "System Audio Recording" permission; when it is denied the tap
/// keeps running and delivers silence, which the mixer treats like a quiet call.
@available(macOS 14.2, *)
public final class SystemAudioTap {
    public enum TapError: Error, Equatable {
        case createTap(OSStatus)
        case unreadableFormat
        case noOutputDevice
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
    private let stateLock = NSLock()

    public init(fifo: SampleFIFO) {
        self.fifo = fifo
    }

    deinit {
        stop()
    }

    public func start() throws {
        try build()
        listenForOutputChanges()
    }

    public func stop() {
        if let outputListener {
            var address = Self.defaultOutputAddress
            AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, controlQueue, outputListener)
            self.outputListener = nil
        }
        tearDown()
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

        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var formatAddress = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        status = AudioObjectGetPropertyData(tap, &formatAddress, 0, nil, &size, &asbd)
        guard status == noErr,
              let format = AVAudioFormat(streamDescription: &asbd),
              let converter = AVAudioConverter(from: format, to: targetFormat)
        else {
            tearDown()
            throw TapError.unreadableFormat
        }
        // Without this a stereo mix becomes its left channel, and a voice panned
        // right — some conferencing apps do this — goes missing.
        converter.downmix = true

        guard let outputUID = Self.defaultOutputUID() else {
            tearDown()
            throw TapError.noOutputDevice
        }
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Bento Meeting Capture",
            kAudioAggregateDeviceUIDKey: "com.charles.bento.voice.meeting-tap.\(UUID().uuidString)",
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
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
        stateLock.lock()
        aggregateID = device
        tapFormat = format
        self.converter = converter
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
        Log.audio.info("system audio tap running: \(Int(format.sampleRate))Hz/\(format.channelCount)ch via \(outputUID, privacy: .public)")
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

    /// The aggregate is clocked by the output device it was built on. When the
    /// user moves output (AirPods connect mid-call) that device may vanish, so
    /// rebuild on the new default rather than go quiet for the rest of the call.
    private func listenForOutputChanges() {
        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            guard let self else { return }
            Log.audio.info("default output changed — rebuilding the system audio tap")
            self.tearDown()
            do {
                try self.build()
            } catch {
                Log.audio.error("system audio tap rebuild failed: \(String(describing: error), privacy: .public)")
            }
        }
        var address = Self.defaultOutputAddress
        if AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, controlQueue, listener) == noErr {
            outputListener = listener
        }
    }

    // MARK: - IO (runs on `queue`)

    private func ingest(_ bufferList: UnsafePointer<AudioBufferList>) {
        stateLock.lock()
        let format = tapFormat, converter = self.converter
        stateLock.unlock()
        guard let format, let converter,
              let input = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: bufferList, deallocator: nil),
              input.frameLength > 0
        else { return }
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

    // MARK: - HAL helpers

    private static var defaultOutputAddress: AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
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
