import AppKit
import AVFoundation
import VoiceCore

/// A voice call with Gemini 3.8 Live over dictation's Google connection: the Gemini API with
/// the user's key, or the direct Vertex helper's /conversation route (`routedTransport`).
/// Bento sends microphone audio and function results and plays the reply. Same contract as
/// `AzureLiveController`.
@MainActor
final class GeminiLiveController {
    private let audio = AzureLiveAudio(inputRate: 16000, maxQueuedSeconds: 120, realTimeOutput: false)
    private let makeTransport: () throws -> LiveTransport
    private var transport: LiveTransport?
    private var reader: Task<Void, Never>?
    private var sender: Task<Void, Never>?
    private var watchdog: Task<Void, Never>?
    private var toolTask: Task<Void, Never>?
    private var runningTurn: Int?
    private var cancelledCalls = Set<String>()
    private var goingAway = false
    private var generation = UUID()
    private var protocolState = GeminiLiveProtocol()
    private var audioContinuation: AsyncStream<Data>.Continuation?
    private var started = 0.0
    private var lastCaptureAt: Double?
    private var inputChunks = 0
    private var outputChunks = 0
    private var outputBytes = 0
    private(set) var active = false
    var onStatus: ((String) -> Void)?
    var onTranscript: ((String, String) -> Void)?
    var onEnd: (() -> Void)?
    var onTool: ((AzureLiveProtocol.Call) async -> String)?

    init(makeTransport: @escaping () throws -> LiveTransport = GeminiLiveController.routedTransport) {
        self.makeTransport = makeTransport
    }

    private var now: Double { ProcessInfo.processInfo.systemUptime }
    private static let listening = "Gemini Live listening. Use headphones. Stop ends voice and tools."

    func start() throws {
        guard !active else { return }
        guard !SecureInput.isActive, AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
            throw ACPClient.Failure(message: "Allow microphone access and leave secure input before starting Gemini voice.")
        }
        let transport = try makeTransport()
        self.transport = transport
        active = true; generation = UUID(); protocolState = GeminiLiveProtocol(); started = now
        lastCaptureAt = nil; runningTurn = nil; cancelledCalls = []; goingAway = false
        inputChunks = 0; outputChunks = 0; outputBytes = 0
        AzureLiveDiagnostics.record(.connecting, log: .gemini)
        let token = generation
        onStatus?("Connecting to Gemini 3.8 Live...")
        reader = Task { [weak self] in
            do {
                try await transport.connect()
                while !Task.isCancelled {
                    let data = try await transport.receive()
                    guard let self, self.active, self.generation == token else { return }
                    self.receive(data, token: token)
                }
            } catch { }
            guard let self else { return }
            let ending = (transport as? LiveSocketReporting)?.ending ?? LiveSocketEnding()
            let outcome = GeminiLiveEnding.outcome(ending, goingAway: self.goingAway, geminiAPI: transport is GeminiAPILiveTransport)
            self.failed(outcome.message, token: token, code: outcome.code, httpStatus: ending.httpStatus, closeCode: ending.closeCode)
        }
        watchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard let self, self.active, self.generation == token, !Task.isCancelled else { return }
                if SecureInput.isActive { self.failed("Secure input is active. Voice stopped.", token: token, code: .secureInput); return }
                if self.now - self.started >= 600 {
                    self.failed("Ten-minute voice session ended. Start again to continue.", token: token, code: .sessionLimit); return
                }
                if self.sender == nil, self.now - self.started >= 25 {
                    self.failed("Gemini voice connection timed out.", token: token, code: .connectionTimeout); return
                }
                if self.sender != nil, self.now - (self.lastCaptureAt ?? self.started) >= 5 {
                    self.failed("Microphone stopped delivering audio. Voice stopped.", token: token, code: .captureTimeout); return
                }
            }
        }
    }

    private func receive(_ data: Data, token: UUID) {
        guard data.count <= 4 * 1024 * 1024,
              let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        // Gemini warns before closing a connection at its time limit.
        if event["goAway"] != nil { goingAway = true }
        if let error = event["error"] as? [String: Any] {
            let code = error["code"] as? String
            let message = code == "busy" ? "Another Gemini voice call is already running."
                : goingAway && code == "upstream_closed" ? "Gemini ended the call at its time limit. Start again to continue."
                : "Gemini voice failed. No task was retried. See gemini-live.jsonl for a safe error code."
            failed(message, token: token, code: goingAway && code == "upstream_closed" ? .sessionLimit : .bridgeFailure, bridgeCode: code,
                   httpStatus: error["httpStatus"] as? Int, closeCode: error["closeCode"] as? Int)
            return
        }
        if event["setupComplete"] != nil { listen(token: token) }
        switch (event["voiceActivity"] as? [String: Any])?["type"] as? String {
        case "ACTIVITY_START": protocolState.activityStarted(at: now)
        case "ACTIVITY_END": protocolState.activityEnded(at: now)
        default: break
        }
        let content = event["serverContent"] as? [String: Any] ?? [:]
        // Transcripts arrive inside serverContent; the reference also allows them top level.
        for source in [content, event] {
            if let text = (source["inputTranscription"] as? [String: Any])?["text"] as? String, !text.isEmpty {
                protocolState.transcript(role: "user", text: text, at: now)
                onTranscript?("user", text)
            }
            if let text = (source["outputTranscription"] as? [String: Any])?["text"] as? String, !text.isEmpty {
                protocolState.transcript(role: "assistant", text: text, at: now)
                onTranscript?("assistant", text)
            }
        }
        if content["interrupted"] as? Bool == true { audio.flush() }
        for part in (content["modelTurn"] as? [String: Any])?["parts"] as? [[String: Any]] ?? [] {
            guard let inline = part["inlineData"] as? [String: Any],
                  (inline["mimeType"] as? String)?.hasPrefix("audio/") == true else { continue }
            guard inline["mimeType"] as? String == "audio/pcm;rate=24000",
                  let raw = inline["data"] as? String, let pcm = Data(base64Encoded: raw),
                  !pcm.isEmpty, pcm.count % 2 == 0, pcm.count <= 480000 else {
                failed("Invalid Gemini voice audio. Start a new session.", token: token, code: .invalidAudio); return
            }
            outputChunks += 1; outputBytes += pcm.count
            audio.play(pcm)
        }
        if let ids = (event["toolCallCancellation"] as? [String: Any])?["ids"] as? [String] {
            cancelledCalls.formUnion(ids.prefix(32))
        }
        for call in (event["toolCall"] as? [String: Any])?["functionCalls"] as? [[String: Any]] ?? [] {
            guard active else { return }
            delegate(call, token: token)
        }
    }

    private func listen(token: UUID) {
        guard sender == nil, let transport else { return }
        lastCaptureAt = now
        let (stream, continuation) = AsyncStream<Data>.makeStream(bufferingPolicy: .bufferingOldest(24))
        audioContinuation = continuation
        audio.onFailure = { [weak self] reason in self?.failed(reason, token: token) }
        sender = Task { [weak self] in
            for await pcm in stream {
                guard let self, self.active, self.generation == token, !Task.isCancelled else { return }
                self.lastCaptureAt = self.now
                self.inputChunks += 1
                do {
                    let event: [String: Any] = ["realtimeInput": ["audio": ["mimeType": "audio/pcm;rate=16000",
                                                                            "data": pcm.base64EncodedString()]]]
                    try await transport.send(try JSONSerialization.data(withJSONObject: event))
                } catch { self.failed("Gemini audio could not be sent.", token: token, code: .sendFailure); return }
            }
        }
        do {
            try audio.start { [weak self] pcm in
                if case .dropped = continuation.yield(pcm) {
                    Task { @MainActor in self?.failed("Microphone streaming fell behind.", token: token, code: .captureBacklog) }
                }
            }
            onStatus?(Self.listening)
            AzureLiveDiagnostics.record(.listening, log: .gemini)
        } catch { failed("Could not start full-duplex audio: " + error.localizedDescription, token: token) }
    }

    private func delegate(_ call: [String: Any], token: UUID) {
        guard let delegation = protocolState.delegation(call, at: now) else {
            // Anything but a new ask_hermes call is answered, never run, so the model isn't left waiting.
            if let id = call["id"] as? String, !id.isEmpty, id.count < 200,
               let name = call["name"] as? String, name != GeminiLiveProtocol.tool, name.count < 200 {
                Task { await respond(id, name: name, "Not executed: unknown tool. Only ask_hermes exists.", executed: false, token: token) }
            }
            return
        }
        AzureLiveDiagnostics.record(.delegationReceived, log: .gemini)
        if toolTask != nil {
            // Said aloud. A different turn is consumed so a later call cannot replay it;
            // a repeat of the running call's turn leaves it to that call.
            let duplicate = delegation.turn != nil && delegation.turn == runningTurn
            if !duplicate { protocolState.discardRequest(for: delegation) }
            Task { await respond(delegation.id, duplicate
                ? "Not executed: Hermes is already working on this request. Wait for its result. No automatic retry."
                : "Not executed: Hermes is still working on an earlier request, so this one was not started. Tell the user to ask again after that result. No automatic retry.",
                executed: false, token: token) }
            return
        }
        runningTurn = delegation.turn
        toolTask = Task { [weak self] in
            guard let self, await self.settle(delegation, token: token) else { return }
            let finish = { [weak self] in
                guard let self, self.active, self.generation == token else { return }
                self.toolTask = nil; self.runningTurn = nil
                self.onStatus?(Self.listening)
            }
            // Gemini cancels a call when the user interrupts; one cancelled before Hermes starts never runs.
            // Its turn is consumed either way, so a later call cannot replay it.
            let request = self.protocolState.request(for: delegation)
            if self.cancelledCalls.contains(delegation.id) { finish(); return }
            guard let request else {
                await self.respond(delegation.id, "Not executed: no complete new transcribed request could be identified. Ask the user to repeat a short, specific request. No action was run.",
                                   executed: false, token: token)
                finish(); return
            }
            let result = await self.onTool?(request) ?? "Not executed: local tools unavailable."
            guard self.active, self.generation == token, !Task.isCancelled else { return }
            if self.cancelledCalls.contains(delegation.id) {
                // Gemini dropped the call; the reply stays in the chat.
                finish(); self.onStatus?("Hermes finished. Gemini cancelled that request, so it hasn't heard the result.")
                return
            }
            await self.respond(delegation.id, result, executed: true, token: token)
            finish()
        }
    }

    /// Waits for the call's turn to end with words and go quiet, since its transcript can
    /// trail the call; at most five seconds. False once the call has ended.
    private func settle(_ delegation: GeminiLiveProtocol.Delegation, token: UUID) async -> Bool {
        guard delegation.turn != nil else { return active && generation == token }
        while true {
            try? await Task.sleep(for: .milliseconds(100))
            guard active, generation == token, !Task.isCancelled else { return false }
            let turn = protocolState.turnState(for: delegation)
            if turn.complete && now - (turn.changed ?? delegation.at) >= 0.8 || now - delegation.at >= 5 { return true }
        }
    }

    private func respond(_ id: String, name: String = GeminiLiveProtocol.tool, _ message: String, executed: Bool, token: UUID) async {
        guard active, generation == token, let transport else { return }
        do {
            let event = GeminiLiveProtocol.response(id: id, name: name, message: message, executed: executed)
            try await transport.send(try JSONSerialization.data(withJSONObject: event))
            if executed { AzureLiveDiagnostics.record(.delegationResultSent, log: .gemini) }
        } catch { failed("Tool result could not reach Gemini. Completed actions were not undone.", token: token, code: .toolSendFailure) }
    }

    private func failed(_ message: String, token: UUID, code: AzureLiveDiagnostics.Code = .audioFailure,
                        bridgeCode: String? = nil, httpStatus: Int? = nil, closeCode: Int? = nil) {
        guard generation == token, active else { return }
        AzureLiveDiagnostics.record(code, inputChunks: inputChunks, outputChunks: outputChunks, outputBytes: outputBytes,
                                    bridgeCode: bridgeCode, httpStatus: httpStatus, closeCode: closeCode, log: .gemini)
        stop(); onStatus?(message)
    }

    func stop() {
        guard active else { return }
        AzureLiveDiagnostics.record(.stopped, inputChunks: inputChunks, outputChunks: outputChunks,
                                    outputBytes: outputBytes, log: .gemini)
        active = false; generation = UUID()
        audio.stop(); audioContinuation?.finish(); audioContinuation = nil
        sender?.cancel(); sender = nil
        reader?.cancel(); reader = nil
        watchdog?.cancel(); watchdog = nil
        toolTask?.cancel(); toolTask = nil
        // Closing the socket ends the call at once. Do not drain actions after the user presses Stop.
        transport?.close(); transport = nil
        onEnd?()
    }
}
