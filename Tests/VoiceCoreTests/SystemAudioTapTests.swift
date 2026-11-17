import AVFoundation
import Testing
@testable import VoiceCore

@Suite struct SystemAudioTapTests {
    private let stereo = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 2, interleaved: true)!

    /// Builds the input of one IO cycle from each stream's channel count and
    /// samples, and hands it to `body` the way the HAL hands it to an IOProc.
    private func withInput<T>(_ streams: [(channels: UInt32, samples: [Float])],
                              _ body: (UnsafePointer<AudioBufferList>) -> T) -> T {
        let list = AudioBufferList.allocate(maximumBuffers: streams.count)
        defer {
            for buffer in list { buffer.mData?.deallocate() }
            free(list.unsafeMutablePointer)
        }
        for (index, stream) in streams.enumerated() {
            let bytes = stream.samples.count * MemoryLayout<Float>.size
            let data = UnsafeMutableRawPointer.allocate(byteCount: max(bytes, 1), alignment: MemoryLayout<Float>.alignment)
            stream.samples.withUnsafeBytes { data.copyMemory(from: $0.baseAddress!, byteCount: bytes) }
            list[index] = AudioBuffer(mNumberChannels: stream.channels, mDataByteSize: UInt32(bytes), mData: data)
        }
        return body(UnsafePointer(list.unsafeMutablePointer))
    }

    private func samples(_ buffer: AVAudioPCMBuffer?, buffer index: Int = 0) -> [Float]? {
        guard let buffer else { return nil }
        let source = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)[index]
        let count = Int(source.mDataByteSize) / MemoryLayout<Float>.size
        return Array(UnsafeBufferPointer(start: source.mData?.assumingMemoryBound(to: Float.self), count: count))
    }

    @Test func onSpeakersTheTapIsTheOnlyStream() {
        let tap: [Float] = [0.1, -0.1, 0.2, -0.2]
        let read = withInput([(2, tap)]) { samples(TapInput.buffer(in: $0, format: stereo)) }
        #expect(read == tap)
    }

    /// A USB interface or a headset: its mic comes first, and reading that as
    /// the tap recorded an hour of silence in place of the call.
    @Test func theOutputDevicesOwnInputIsSkipped() {
        let tap: [Float] = [0.3, -0.3, 0.4, -0.4, 0.5, -0.5]
        let monoMic = withInput([(1, [0, 0, 0]), (2, tap)]) { TapInput.buffer(in: $0, format: stereo) }
        #expect(monoMic?.frameLength == 3)
        #expect(samples(monoMic) == tap)
        let stereoMic = withInput([(2, [0, 0, 0, 0, 0, 0]), (2, tap)]) { samples(TapInput.buffer(in: $0, format: stereo)) }
        #expect(stereoMic == tap)
    }

    @Test func aPlanarTapIsItsLastBufferPerChannel() {
        let planar = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 2, interleaved: false)!
        let read = withInput([(1, [0, 0]), (1, [0.1, 0.2]), (1, [0.3, 0.4])]) { TapInput.buffer(in: $0, format: planar) }
        #expect(read?.frameLength == 2)
        #expect(samples(read, buffer: 0) == [0.1, 0.2])
        #expect(samples(read, buffer: 1) == [0.3, 0.4])
    }

    @Test func inputThatIsNotShapedLikeTheTapIsRefused() {
        #expect(withInput([(2, [0.1, 0.2]), (1, [0.3])]) { TapInput.buffer(in: $0, format: stereo) } == nil)
        #expect(withInput([(2, [])]) { TapInput.buffer(in: $0, format: stereo) } == nil)
    }

    // MARK: - Watchdog

    @Test func aQuietButRunningTapIsLeftAlone() {
        var watchdog = TapWatchdog()
        for tick in 0..<40 {
            let now = Double(tick) * 0.25
            #expect(watchdog.check(now: now, lastIO: now - 0.02, built: true, formatChanged: false) == nil)
        }
    }

    /// Bluetooth headphones switching to call mode: IO stops and never resumes.
    @Test func aTapWhoseIOStoppedIsRebuiltAndGivenTimeToRecover() {
        var watchdog = TapWatchdog()
        #expect(watchdog.check(now: 0.5, lastIO: 0.06, built: true, formatChanged: false) == nil)
        #expect(watchdog.check(now: 1.0, lastIO: 0.06, built: true, formatChanged: false) == .stalled)
        // The rebuild restarts the stall clock; nothing is judged until it has had a second.
        #expect(watchdog.check(now: 1.25, lastIO: 1.0, built: true, formatChanged: false) == nil)
        #expect(watchdog.check(now: 1.9, lastIO: 1.0, built: true, formatChanged: false) == nil)
        #expect(watchdog.check(now: 2.0, lastIO: 1.99, built: true, formatChanged: false) == nil)
    }

    @Test func aDeviceThatStaysBrokenIsRetriedMoreSlowly() {
        var watchdog = TapWatchdog()
        var rebuilds: [Double] = []
        var now = 0.0
        while now <= 20 {
            if watchdog.check(now: now, lastIO: 0, built: false, formatChanged: false) != nil { rebuilds.append(now) }
            now += 0.25
        }
        #expect(rebuilds == [0, 1, 3, 7, 15])
        // Once it runs again the next failure is answered promptly.
        #expect(watchdog.check(now: 23, lastIO: 22.99, built: true, formatChanged: false) == nil)
        #expect(watchdog.check(now: 24, lastIO: 22.99, built: true, formatChanged: false) == .stalled)
        #expect(watchdog.check(now: 25, lastIO: 24, built: true, formatChanged: false) == .stalled)
    }

    @Test func aChangedFormatIsRebuiltEvenWhileIOFlows() {
        var watchdog = TapWatchdog()
        #expect(watchdog.check(now: 5, lastIO: 4.99, built: true, formatChanged: true) == .formatChanged)
    }

    @Test func aRebuildForAnotherReasonAlsoGetsItsTime() {
        var watchdog = TapWatchdog()
        watchdog.rebuilt(now: 10)
        #expect(watchdog.check(now: 10.9, lastIO: 0, built: true, formatChanged: false) == nil)
        #expect(watchdog.check(now: 11, lastIO: 0, built: true, formatChanged: false) == .stalled)
    }
}
