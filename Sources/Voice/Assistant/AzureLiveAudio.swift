import AVFoundation
import Foundation
import VoiceCore

/// Separate from crash-safe dictation. Live conversation audio is ephemeral, never inserted or saved.
/// Shared by both voice calls: Azure GPT-Live wants 24 kHz input, Gemini Live 16 kHz; both reply at 24 kHz.
@MainActor
final class AzureLiveAudio {
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)!
    private let inputRate: Double
    private let maxQueuedFrames: Int
    private let realTimeOutput: Bool
    private var pendingFrames = 0
    private var generation = UUID()
    private var playback = UUID()
    private var configurationObserver: NSObjectProtocol?
    private var lastEndMS: Double?
    private var tapInstalled = false
    var onFailure: ((String) -> Void)?

    /// Azure paces its reply at real time, so 3 s queued means a stall. Gemini sends
    /// replies faster than real time and needs room to queue a whole answer, pauses included.
    init(inputRate: Double = 24000, maxQueuedSeconds: Double = 3, realTimeOutput: Bool = true) {
        self.inputRate = inputRate
        self.maxQueuedFrames = Int(24000 * maxQueuedSeconds)
        self.realTimeOutput = realTimeOutput
    }

    func start(sink: @escaping @Sendable (Data) -> Void) throws {
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        self.engine = engine
        self.player = player
        let token = UUID(); generation = token
        do {
            // Network 24 kHz belongs on the player, not the USB I/O bus.
            let outputFormat = engine.outputNode.inputFormat(forBus: 0)
            engine.connect(engine.mainMixerNode, to: engine.outputNode, format: outputFormat)
            // Headphone trial: VoiceProcessingIO failed on the current USB route.
            // Do not silently claim speaker echo cancellation or change system devices.
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            let inputFormat = engine.inputNode.outputFormat(forBus: 0)
            let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: inputRate, channels: 1, interleaved: true)!
            guard let converter = AVAudioConverter(from: inputFormat, to: target) else {
                throw NSError(domain: "AzureLiveAudio", code: 1, userInfo: [NSLocalizedDescriptionKey:
                    "Cannot convert microphone audio to \(Int(inputRate / 1000)) kHz."])
            }
            converter.primeMethod = .none
            engine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
                let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * target.sampleRate / inputFormat.sampleRate)) + 64
                guard let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
                var supplied = false
                var error: NSError?
                converter.convert(to: converted, error: &error) { _, status in
                    if supplied { status.pointee = .noDataNow; return nil }
                    supplied = true; status.pointee = .haveData; return buffer
                }
                if error != nil {
                    Task { @MainActor in
                        guard self?.generation == token else { return }
                        self?.onFailure?("Microphone conversion failed.")
                    }
                } else if converted.frameLength > 0, let samples = converted.int16ChannelData {
                    sink(Data(bytes: samples[0], count: Int(converted.frameLength) * 2))
                }
            }
            tapInstalled = true
            let expectedRate = inputFormat.sampleRate, expectedChannels = inputFormat.channelCount
            configurationObserver = NotificationCenter.default.addObserver(
                forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
            ) { [weak self] _ in
                Task { @MainActor in
                    guard self?.generation == token else { return }
                    guard let currentEngine = self?.engine else { return }
                    let current = currentEngine.inputNode.outputFormat(forBus: 0)
                    if currentEngine.isRunning, current.sampleRate == expectedRate,
                       current.channelCount == expectedChannels { return }
                    self?.onFailure?("Audio device changed. Start a new voice session.")
                }
            }
            engine.prepare()
            do { try engine.start() }
            catch { throw NSError(domain: "AzureLiveAudio", code: 2, userInfo: [NSLocalizedDescriptionKey:
                "Audio graph start failed: " + error.localizedDescription]) }
            player.play()
        } catch {
            stop()
            throw error
        }
    }

    func play(_ pcm: Data, startMS: Double? = nil, endMS: Double? = nil) {
        guard let player, let engine, engine.isRunning, !pcm.isEmpty, pcm.count % 2 == 0 else { return }
        // Azure paces output at real time, so a network stall's backlog never drains on its own.
        // Past 500 ms queued (hardware output latency included), add no more silence.
        let backlogged = pendingFrames >= 12000
        var gap = 0.0
        if let startMS, let endMS {
            guard startMS.isFinite, endMS.isFinite, startMS >= 0, endMS >= startMS, endMS - startMS <= 3000 else {
                onFailure?("Invalid voice audio range."); return
            }
            // Some deployments provide a timeline with omitted silence; others send PCM only.
            if pendingFrames > 0, !backlogged, let lastEndMS { gap = min(1000, max(0, startMS - lastEndMS)) }
            lastEndMS = endMS
        } else {
            guard startMS == nil, endMS == nil else { onFailure?("Invalid voice audio range."); return }
            // Untimed chunks are already paced by Azure. Never invent a server timeline.
            lastEndMS = nil
        }
        // Quiet stretches arrive as exact-zero chunks; pauses still play once caught up.
        if realTimeOutput, backlogged, !pcm.contains(where: { $0 != 0 }) { return }
        let silentFrames = Int(gap * 24)
        let frames = pcm.count / 2 + silentFrames
        // An overloaded connection must stop, not accumulate seconds of stale speech.
        guard pendingFrames + frames <= maxQueuedFrames,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
              let channel = buffer.floatChannelData?[0] else {
            onFailure?("Voice playback fell behind. Start a new session."); return
        }
        pcm.withUnsafeBytes { raw in
            for index in 0..<silentFrames { channel[index] = 0 }
            for index in 0..<pcm.count / 2 {
                channel[index + silentFrames] = Float(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: index * 2, as: Int16.self))) / 32768
            }
        }
        buffer.frameLength = AVAudioFrameCount(frames)
        pendingFrames += frames
        let token = generation, queue = playback
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.generation == token, self.playback == queue else { return }
                self.pendingFrames = max(0, self.pendingFrames - frames)
            }
        }
    }

    /// Drops queued speech when the user talks over the reply. The microphone keeps running.
    func flush() {
        guard let player, engine?.isRunning == true else { return }
        playback = UUID()
        player.stop(); player.play()
        pendingFrames = 0
        lastEndMS = nil
    }

    func stop() {
        generation = UUID()
        if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }
        configurationObserver = nil
        player?.stop(); player = nil
        if tapInstalled { engine?.inputNode.removeTap(onBus: 0) }
        tapInstalled = false
        engine?.stop(); engine.map(AudioEngineRetirement.retire); engine = nil
        pendingFrames = 0
        lastEndMS = nil
    }
}

/// A call's audio as the Gemini controller uses it, so tests can stand in for the engine.
@MainActor
protocol LiveCallAudio: AnyObject {
    var onFailure: ((String) -> Void)? { get set }
    func start(sink: @escaping @Sendable (Data) -> Void) throws
    func play(_ pcm: Data, startMS: Double?, endMS: Double?)
    func flush()
    func stop()
}

extension AzureLiveAudio: LiveCallAudio {}
