import AppKit
import AVFoundation
import VoiceCore
import Darwin

@MainActor
final class AzureLiveController {
    private let audio = AzureLiveAudio()
    private var process: Process?
    private var input: FileHandle?
    private var output: FileHandle?
    private var reader: Task<Void, Never>?
    private var pipeReader: PipeLineReader?
    private var sender: Task<Void, Never>?
    private var watchdog: Task<Void, Never>?
    private var toolTask: Task<Void, Never>?
    private var generation = UUID()
    private var protocolState = AzureLiveProtocol()
    private var audioContinuation: AsyncStream<Data>.Continuation?
    private var lastCaptureAt: Double?
    private var lastUserTranscriptAt: Double?
    private var inputChunks = 0
    private var outputChunks = 0
    private var outputBytes = 0
    private(set) var active = false
    var onStatus: ((String) -> Void)?
    var onTranscript: ((String, String) -> Void)?
    var onEnd: (() -> Void)?
    var onTool: ((AzureLiveProtocol.Call) async -> String)?

    func start(recap: String?) throws {
        guard !active else { return }
        guard !SecureInput.isActive, AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
            throw ACPClient.Failure(message: "Allow microphone access and leave secure input before starting Azure voice.")
        }
        guard let script = VoiceResources.url("azure_live", "py") else {
            throw ACPClient.Failure(message: "The Azure voice bridge is missing from Bento.")
        }
        // The bridge reads this line before it opens the session: the earlier call's transcript when resuming.
        var setup = try JSONSerialization.data(withJSONObject: ["type": "bento.setup", "recap": recap ?? ""])
        setup.append(10)
        let child = Process(), incoming = Pipe(), outgoing = Pipe()
        child.executableURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".hermes/hermes-agent/venv/bin/python")
        child.arguments = [script.path]
        child.standardInput = incoming; child.standardOutput = outgoing
        child.standardError = FileHandle.nullDevice
        var env = ProcessInfo.processInfo.environment
        env["PYTHONUNBUFFERED"] = "1"
        // The same runtime file Bento reads (BENTO_HOME moves it in dev builds).
        env["BENTO_VOICE_RUNTIME"] = VertexRuntimeConfig.defaultURL.path
        child.environment = env
        let lines = try PipeLineReader(outgoing.fileHandleForReading)
        do { try child.run() } catch { lines.cancel(); throw error }
        process = child; input = incoming.fileHandleForWriting; output = outgoing.fileHandleForReading
        pipeReader = lines
        active = true; generation = UUID(); protocolState = AzureLiveProtocol(); lastCaptureAt = nil
        lastUserTranscriptAt = nil
        inputChunks = 0; outputChunks = 0; outputBytes = 0
        AzureLiveDiagnostics.record(.connecting)
        let token = generation
        let handle = incoming.fileHandleForWriting
        Task { [weak self] in
            do { try await Self.write(setup, to: handle) }
            catch { self?.failed("Azure voice could not start.", token: token, code: .sendFailure) }
        }
        onStatus?(recap?.isEmpty == false ? "Resuming the call with Azure GPT-Live..." : "Connecting to Azure GPT-Live...")
        reader = Task.detached { [weak self] in
            do {
                try await lines.readLines { [weak self] line in
                    await self?.receive(line, token: token)
                }
            } catch { }
            await self?.failed("Azure voice disconnected. No task was retried.", token: token, code: .disconnected)
        }
        watchdog = Task { [weak self] in
            let started = ProcessInfo.processInfo.systemUptime
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard let self, self.active, self.generation == token, !Task.isCancelled else { return }
                if SecureInput.isActive { self.failed("Secure input is active. Voice stopped.", token: token, code: .secureInput); return }
                if self.sender == nil, ProcessInfo.processInfo.systemUptime - started >= 25 {
                    self.failed("Azure voice connection timed out.", token: token, code: .connectionTimeout); return
                }
                if self.sender != nil, ProcessInfo.processInfo.systemUptime - (self.lastCaptureAt ?? started) >= 5 {
                    self.failed("Microphone stopped delivering audio. Voice stopped.", token: token, code: .captureTimeout); return
                }
            }
        }
    }

    private func receive(_ line: String, token: UUID) {
        guard active, generation == token, let data = line.data(using: .utf8), data.count <= 4 * 1024 * 1024,
              let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        if protocolState.transcript(event) { lastUserTranscriptAt = ProcessInfo.processInfo.systemUptime }
        switch event["type"] as? String {
        case "session.started":
            guard sender == nil else { return }
            lastCaptureAt = ProcessInfo.processInfo.systemUptime
            let (stream, continuation) = AsyncStream<Data>.makeStream(bufferingPolicy: .bufferingOldest(12))
            audioContinuation = continuation
            audio.onFailure = { [weak self] reason in self?.failed(reason, token: token) }
            let handle = input!
            sender = Task { [weak self] in
                for await pcm in stream {
                    guard let self, self.active, self.generation == token, !Task.isCancelled else { return }
                    self.lastCaptureAt = ProcessInfo.processInfo.systemUptime
                    self.inputChunks += 1
                    do {
                        var encoded = try JSONSerialization.data(withJSONObject: ["type": "session.input_audio.append", "audio": pcm.base64EncodedString()])
                        encoded.append(10)
                        // Pipe backpressure must never freeze the Stop button on the main actor.
                        try await Self.write(encoded, to: handle)
                    }
                    catch { self.failed("Azure audio could not be sent.", token: token, code: .sendFailure); return }
                }
            }
            do {
                try audio.start { [weak self] pcm in
                    if case .dropped = continuation.yield(pcm) {
                        Task { @MainActor in self?.failed("Microphone streaming fell behind.", token: token, code: .captureBacklog) }
                    }
                }
                onStatus?("Azure voice listening. Use headphones. Stop ends voice and tools.")
                AzureLiveDiagnostics.record(.listening)
            } catch { failed("Could not start full-duplex audio: " + error.localizedDescription, token: token) }
        case "session.input_transcript.delta":
            if let text = event["delta"] as? String { onTranscript?("user", text) }
        case "session.output_transcript.delta":
            if let text = event["delta"] as? String { onTranscript?("assistant", text) }
        case "session.output_audio.delta":
            guard let raw = event["delta"] as? String, let pcm = Data(base64Encoded: raw),
                  !pcm.isEmpty, pcm.count % 2 == 0, pcm.count <= 144000 else {
                failed("Invalid Azure voice audio. Start a new session.", token: token, code: .invalidAudio); return
            }
            let start = event["start_ms"] as? Double, end = event["end_ms"] as? Double
            guard (event["start_ms"] == nil && event["end_ms"] == nil) || (start != nil && end != nil) else {
                failed("Invalid Azure voice timing. Start a new session.", token: token, code: .invalidAudio); return
            }
            outputChunks += 1; outputBytes += pcm.count
            audio.play(pcm, startMS: start, endMS: end)
        case "bento.error", "error":
            failed("Azure voice failed. No task was retried. See azure-live.jsonl for a safe error code.",
                   token: token, code: .bridgeFailure,
                   bridgeCode: event["diagnostic_code"] as? String, httpStatus: event["http_status"] as? Int)
        case "session.closed":
            failed("Azure voice session ended.", token: token, code: .sessionEnded)
        default: break
        }
        guard active, let delegation = protocolState.delegation(event) else { return }
        AzureLiveDiagnostics.record(.delegationReceived)
        if toolTask != nil {
            protocolState.discardRequest(for: delegation)
            Task { await complete(delegation.id, result: "Not executed: another local task is pending or running. Wait for its result. No automatic retry.", token: token) }
            return
        }
        toolTask = Task { [weak self] in
            guard let self else { return }
            // Delegation can precede the last transcript fragment. Wait for quiet,
            // but never treat this heuristic as an authoritative turn boundary.
            let started = ProcessInfo.processInfo.systemUptime
            repeat {
                try? await Task.sleep(for: .milliseconds(100))
                guard self.active, self.generation == token, !Task.isCancelled else { return }
            } while ProcessInfo.processInfo.systemUptime - started < 0.8 ||
                (ProcessInfo.processInfo.systemUptime - (self.lastUserTranscriptAt ?? started) < 0.8 &&
                 ProcessInfo.processInfo.systemUptime - started < 5)
            let settled = ProcessInfo.processInfo.systemUptime - (self.lastUserTranscriptAt ?? started) >= 0.8
            let call = settled ? self.protocolState.request(for: delegation) : nil
            let result: String
            if let call { result = await self.onTool?(call) ?? "Not executed: local tools unavailable." }
            else { result = "Not executed: no complete new transcribed request could be identified. Ask the user to repeat a short, specific request. No action was run." }
            guard self.active, self.generation == token, !Task.isCancelled else { return }
            await self.complete(delegation.id, result: result, token: token)
            guard self.active, self.generation == token else { return }
            self.toolTask = nil
            self.onStatus?("Azure voice listening. Use headphones. Stop ends voice and tools.")
        }
    }

    private func complete(_ id: String, result: String, token: UUID) async {
        guard active, generation == token else { return }
        do {
            try await send(["type": "session.commentary.append", "delegation_id": id,
                            "content": AzureLiveProtocol.spokenResult(result)])
            AzureLiveDiagnostics.record(.delegationResultSent)
        } catch { failed("Tool result could not reach Azure. Completed actions were not undone.", token: token, code: .toolSendFailure) }
    }

    private func send(_ event: [String: Any]) async throws {
        guard let input else { throw ACPClient.Failure(message: "Azure voice is not connected.") }
        var data = try JSONSerialization.data(withJSONObject: event); data.append(10)
        try await Self.write(data, to: input)
    }

    // All writes share a serial queue so audio and function results never interleave bytes.
    private static let writeQueue = DispatchQueue(label: "com.charles.bento.voice.azure-live.write", qos: .userInitiated)
    private static func write(_ data: Data, to handle: FileHandle) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            writeQueue.async {
                do {
                    // Scope SIGPIPE suppression to this descriptor, not the app or Hermes children.
                    // A helper exit during a blocked write must throw EPIPE, never terminate Bento.
                    guard fcntl(handle.fileDescriptor, F_SETNOSIGPIPE, 1) != -1 else {
                        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
                    }
                    try handle.write(contentsOf: data); continuation.resume()
                }
                catch { continuation.resume(throwing: error) }
            }
        }
    }

    private func failed(_ message: String, token: UUID, code: AzureLiveDiagnostics.Code = .audioFailure,
                        bridgeCode: String? = nil, httpStatus: Int? = nil) {
        guard generation == token, active else { return }
        AzureLiveDiagnostics.record(code, inputChunks: inputChunks, outputChunks: outputChunks,
                                    outputBytes: outputBytes, bridgeCode: bridgeCode, httpStatus: httpStatus)
        stop(); onStatus?(message)
    }

    func stop() {
        guard active else { return }
        AzureLiveDiagnostics.record(.stopped, inputChunks: inputChunks, outputChunks: outputChunks, outputBytes: outputBytes)
        active = false; generation = UUID()
        audio.stop(); audioContinuation?.finish(); audioContinuation = nil
        sender?.cancel(); sender = nil
        reader?.cancel(); reader = nil
        pipeReader?.cancel(); pipeReader = nil
        watchdog?.cancel(); watchdog = nil
        toolTask?.cancel(); toolTask = nil
        // Closing transport halts media immediately. Do not drain actions after the user presses Stop.
        let child = process, incoming = input, outgoing = output
        process = nil; input = nil; output = nil
        if let child, child.isRunning { child.terminate() }
        // Never close a FileHandle on the main actor while a background write is blocked.
        Self.writeQueue.async { try? incoming?.close(); try? outgoing?.close() }
        onEnd?()
    }
}
