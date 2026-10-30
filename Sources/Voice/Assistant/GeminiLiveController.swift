import AppKit
import AVFoundation
import VoiceCore

/// A voice call with Gemini 3.8 Live over dictation's Google connection: the Gemini API with
/// the user's key, or the direct Vertex helper's /conversation route (`routedTransport`).
/// A call can resume an earlier one, told what was said (`LiveResume`).
/// Bento sends microphone audio and function results and plays the reply. Same contract as
/// `AzureLiveController`.
///
/// Gemini bills a connection by the second, so a call waiting on Hermes in silence for
/// `standbyAfter` seconds leaves it: the socket closes and the microphone runs on unheard.
/// When Hermes finishes, or on `wake()`, a new connection resumes the call with the
/// conversation so far (`recap`). A result that outlived its session goes in on the call's
/// connection as a turn for Gemini to speak (`resultMessage`), since the old session's
/// call is gone with it; one that arrives while a connection is being set up waits for it.
@MainActor
final class GeminiLiveController {
    private let audio: LiveCallAudio
    private let permitted: () -> Bool
    private let tick: Duration
    private let makeTransport: (_ recap: String?) throws -> LiveTransport
    private var transport: LiveTransport?
    /// The connection the reader serves; one closed for standby or replaced ends quietly.
    private var link = UUID()
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
    private var hermesWorking = false
    private var waking = false
    private var wakeStarted = 0.0
    /// The running request outlived the session its call came from: its result goes back as a turn.
    private var parked = false
    /// A parked result waiting for the connection being set up.
    private var delivery: String?
    /// A result went to the helper as `hermesResult`, which a helper older than standby refuses.
    private var resultSent = false
    /// When someone last spoke, and when Gemini's speech already received finishes playing.
    private var lastSpeech = 0.0
    private var speechUntil = 0.0
    private(set) var active = false
    /// Off Gemini while Hermes works; `onStandby` says when it changes.
    private(set) var standby = false
    var onStatus: ((String) -> Void)?
    var onTranscript: ((String, String) -> Void)?
    var onEnd: (() -> Void)?
    var onTool: ((AzureLiveProtocol.Call) async -> String)?
    var onStandby: ((Bool) -> Void)?
    /// Seconds without speech after which a call waiting on Hermes leaves Gemini (0 = never), read as the call goes.
    var standbyAfter: () -> Double = { 0 }
    /// The conversation so far, for the connection a call comes back from standby on.
    var recap: () -> String? = { nil }

    /// The defaults are the real call; tests pass a fake socket and audio, and a shorter tick.
    init(makeTransport: @escaping (_ recap: String?) throws -> LiveTransport = GeminiLiveController.routedTransport,
         audio: LiveCallAudio? = nil, permitted: (() -> Bool)? = nil, tick: Duration = .seconds(1)) {
        self.makeTransport = makeTransport
        self.audio = audio ?? AzureLiveAudio(inputRate: 16000, maxQueuedSeconds: 120, realTimeOutput: false)
        self.permitted = permitted ?? { !SecureInput.isActive && AVCaptureDevice.authorizationStatus(for: .audio) == .authorized }
        self.tick = tick
    }

    private var now: Double { ProcessInfo.processInfo.systemUptime }
    private static let listening = "Gemini Live listening. Use headphones. Stop ends voice and tools."
    private static let standing = "Gemini paused while Hermes works, to save cost, so it can't hear you. It comes back with the answer; Talk brings it back now."
    private static let reconnectFailed = "Gemini voice couldn't reconnect after standby. Voice stopped."

    func start(recap: String?) throws {
        guard !active else { return }
        guard permitted() else {
            throw ACPClient.Failure(message: "Allow microphone access and leave secure input before starting Gemini voice.")
        }
        let recap = recap?.isEmpty == false ? recap : nil
        let transport = try makeTransport(recap)
        self.transport = transport
        active = true; generation = UUID(); protocolState = GeminiLiveProtocol(); started = now
        lastCaptureAt = nil; runningTurn = nil; cancelledCalls = []; goingAway = false
        hermesWorking = false; standby = false; waking = false; parked = false; delivery = nil; resultSent = false
        lastSpeech = started; speechUntil = 0
        inputChunks = 0; outputChunks = 0; outputBytes = 0
        AzureLiveDiagnostics.record(.connecting, log: .gemini)
        let token = generation
        onStatus?(recap == nil ? "Connecting to Gemini 3.8 Live..." : "Resuming the call with Gemini 3.8 Live...")
        read(transport, token: token)
        watchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: self?.tick ?? .seconds(1))
                guard let self, self.active, self.generation == token, !Task.isCancelled else { return }
                if SecureInput.isActive { self.failed("Secure input is active. Voice stopped.", token: token, code: .secureInput); return }
                if self.sender == nil, self.now - self.started >= 25 {
                    self.failed("Gemini voice connection timed out.", token: token, code: .connectionTimeout); return
                }
                if self.sender != nil, self.now - (self.lastCaptureAt ?? self.started) >= 5 {
                    self.failed("Microphone stopped delivering audio. Voice stopped.", token: token, code: .captureTimeout); return
                }
                if self.waking, self.now - self.wakeStarted >= 25 {
                    self.failed(Self.reconnectFailed, token: token, code: .connectionTimeout); return
                }
                if self.idleWhileHermesWorks { self.standBy() }
            }
        }
    }

    /// Reads `transport` until it ends. Its end ends the call, unless the call left it for
    /// standby or moved to another.
    private func read(_ transport: LiveTransport, token: UUID) {
        let current = UUID()
        link = current
        reader?.cancel()
        reader = Task { [weak self] in
            do {
                try await transport.connect()
                while !Task.isCancelled {
                    let data = try await transport.receive()
                    guard let self, self.active, self.generation == token, self.link == current else { return }
                    self.receive(data, token: token)
                }
            } catch { }
            guard let self, self.link == current else { return }
            if self.waking {
                self.failed(Self.reconnectFailed, token: token, code: .bridgeFailure)
                return
            }
            let ending = (transport as? LiveSocketReporting)?.ending ?? LiveSocketEnding()
            let outcome = GeminiLiveEnding.outcome(ending, goingAway: self.goingAway, geminiAPI: transport is GeminiAPILiveTransport,
                                                   helperResume: transport is GeminiHelperResumeTransport)
            self.failed(outcome.message, token: token, code: outcome.code, httpStatus: ending.httpStatus, closeCode: ending.closeCode)
        }
    }

    /// Hermes is working and nobody has spoken (Gemini included) for the standby time.
    private var idleWhileHermesWorks: Bool {
        let after = standbyAfter()
        return after > 0 && hermesWorking && sender != nil && !standby && !goingAway && now - max(lastSpeech, speechUntil) >= after
    }

    /// Leaves Gemini while Hermes works: the connection closes, and the microphone runs on unheard.
    private func standBy() {
        standby = true; parked = true
        link = UUID() // the reader ends quietly
        transport?.close(); transport = nil
        AzureLiveDiagnostics.record(.standby, inputChunks: inputChunks, outputChunks: outputChunks, outputBytes: outputBytes, log: .gemini)
        onStandby?(true)
        onStatus?(Self.standing)
    }

    /// Brings a call in standby back now, to talk before Hermes finishes.
    func wake() { comeBack() }

    private func retryComeback(token: UUID) {
        link = UUID() // the refused connection's reader ends quietly
        transport?.close(); transport = nil
        let started = wakeStarted
        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard let self, self.active, self.generation == token, self.waking, self.transport == nil else { return }
            self.waking = false
            self.comeBack()
            self.wakeStarted = started // the reconnect deadline counts from the first try
        }
    }

    /// A new connection with the conversation so far; the reader finishes it at setupComplete (`cameBack`).
    private func comeBack() {
        guard active, standby, !waking else { return }
        let token = generation
        let next: LiveTransport
        do { next = try makeTransport(recap().flatMap { $0.isEmpty ? nil : $0 }) } catch {
            failed(Self.reconnectFailed, token: token, code: .bridgeFailure); return
        }
        transport = next
        waking = true; wakeStarted = now
        onStandby?(false)
        onStatus?("Reconnecting to Gemini 3.8 Live...")
        read(next, token: token)
    }

    private func cameBack(token: UUID) {
        standby = false; waking = false
        lastSpeech = now; speechUntil = 0
        AzureLiveDiagnostics.record(.standbyEnded, log: .gemini)
        onStatus?(hermesWorking ? "Hermes is working..." : Self.listening)
        if let result = delivery {
            delivery = nil
            Task { await deliver(result, token: token) }
        }
    }

    /// A parked request's result: spoken on the call's connection now, or once one is set up.
    private func deliver(_ result: String, token: UUID) async {
        guard active, generation == token else { return }
        if standby {
            delivery = result
            if !waking { comeBack() }
            return
        }
        guard let transport else { return }
        do {
            let geminiAPI = transport is GeminiAPILiveTransport
            if !geminiAPI { resultSent = true }
            try await transport.send(try Self.resultMessage(result, geminiAPI: geminiAPI))
            AzureLiveDiagnostics.record(.delegationResultSent, log: .gemini)
        } catch {
            guard self.transport === transport, !standby else { return } // left for standby meanwhile: delivery waits for the next
            failed("Hermes's answer could not reach Gemini. It's in the chat.", token: token, code: .toolSendFailure)
        }
    }

    private func receive(_ data: Data, token: UUID) {
        guard data.count <= 4 * 1024 * 1024,
              let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        // Gemini warns before closing a connection at its time limit.
        if event["goAway"] != nil { goingAway = true }
        if let error = event["error"] as? [String: Any] {
            let code = error["code"] as? String
            // The helper runs one call at a time and frees it once the connection left for standby
            // has closed upstream: a comeback that beats that waits a moment and tries again.
            if waking, code == "busy", now - wakeStarted < 20 {
                retryComeback(token: token)
                return
            }
            // A helper older than standby refuses Hermes's reply.
            let outdated = resultSent && code == "invalid_message"
            let message = code == "busy" ? "Another Gemini voice call is already running."
                : goingAway && code == "upstream_closed" ? "Gemini ended the call at its time limit. Start again to continue."
                : outdated ? "Gemini voice couldn't come back with Hermes's answer: the voice helper is out of date. Run scripts/voice-helper.sh update. The answer is in the chat."
                : "Gemini voice failed. No task was retried. See gemini-live.jsonl for a safe error code."
            failed(message, token: token, code: goingAway && code == "upstream_closed" ? .sessionLimit : .bridgeFailure, bridgeCode: code,
                   httpStatus: error["httpStatus"] as? Int, closeCode: error["closeCode"] as? Int)
            return
        }
        if event["setupComplete"] != nil {
            if waking { cameBack(token: token) } else { listen(token: token) }
        }
        switch (event["voiceActivity"] as? [String: Any])?["type"] as? String {
        case "ACTIVITY_START": protocolState.activityStarted(at: now); lastSpeech = now
        case "ACTIVITY_END": protocolState.activityEnded(at: now); lastSpeech = now
        default: break
        }
        let content = event["serverContent"] as? [String: Any] ?? [:]
        // Transcripts arrive inside serverContent; the reference also allows them top level.
        for source in [content, event] {
            if let text = (source["inputTranscription"] as? [String: Any])?["text"] as? String, !text.isEmpty {
                protocolState.transcript(role: "user", text: text, at: now)
                onTranscript?("user", text)
                lastSpeech = now
            }
            if let text = (source["outputTranscription"] as? [String: Any])?["text"] as? String, !text.isEmpty {
                protocolState.transcript(role: "assistant", text: text, at: now)
                onTranscript?("assistant", text)
                lastSpeech = now
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
            audio.play(pcm, startMS: nil, endMS: nil)
            // 24 kHz 16-bit mono: Gemini is still speaking until this has played.
            speechUntil = max(speechUntil, now) + Double(pcm.count) / 48000
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
        guard sender == nil else { return }
        lastCaptureAt = now
        let (stream, continuation) = AsyncStream<Data>.makeStream(bufferingPolicy: .bufferingOldest(24))
        audioContinuation = continuation
        audio.onFailure = { [weak self] reason in self?.failed(reason, token: token) }
        sender = Task { [weak self] in
            for await pcm in stream {
                guard let self, self.active, self.generation == token, !Task.isCancelled else { return }
                self.lastCaptureAt = self.now
                // In standby nobody is listening; the microphone runs on so the call can come back at once.
                guard !self.standby, let transport = self.transport else { continue }
                self.inputChunks += 1
                do {
                    let event: [String: Any] = ["realtimeInput": ["audio": ["mimeType": "audio/pcm;rate=16000",
                                                                            "data": pcm.base64EncodedString()]]]
                    try await transport.send(try JSONSerialization.data(withJSONObject: event))
                } catch {
                    // A connection left for standby (or replaced) fails its last sends; the call goes on.
                    guard self.transport === transport, !self.standby else { continue }
                    self.failed("Gemini audio could not be sent.", token: token, code: .sendFailure); return
                }
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
                self.toolTask = nil; self.runningTurn = nil; self.parked = false
                if !self.standby { self.onStatus?(Self.listening) }
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
            self.hermesWorking = true
            let result = await self.onTool?(request) ?? "Not executed: local tools unavailable."
            self.hermesWorking = false
            guard self.active, self.generation == token, !Task.isCancelled else { return }
            if self.cancelledCalls.contains(delegation.id) {
                // Gemini dropped the call; the reply stays in the chat. A call in standby still comes back.
                finish(); self.onStatus?("Hermes finished. Gemini cancelled that request, so it hasn't heard the result.")
                self.comeBack()
                return
            }
            if self.parked {
                // The call it answers went with its session: the reply goes in as a turn.
                finish()
                await self.deliver(result, token: token)
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
        guard active, generation == token, !standby, let transport else { return }
        do {
            let event = GeminiLiveProtocol.response(id: id, name: name, message: message, executed: executed)
            try await transport.send(try JSONSerialization.data(withJSONObject: event))
            if executed { AzureLiveDiagnostics.record(.delegationResultSent, log: .gemini) }
        } catch {
            guard self.transport === transport, !standby else { return }
            failed("Tool result could not reach Gemini. Completed actions were not undone.", token: token, code: .toolSendFailure)
        }
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
        if standby { standby = false; waking = false; onStandby?(false) }
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
