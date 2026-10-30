import Foundation
import VoiceCore

extension GeminiLiveController {
    /// A call goes where dictation's Gemini goes (`SettingsStore.geminiLiveRoute`):
    /// the Gemini API with the user's key, or the direct Vertex helper. `recap` is the
    /// earlier call's transcript when this one resumes it.
    nonisolated static func routedTransport(recap: String?) throws -> LiveTransport {
        switch SettingsStore().geminiLiveRoute {
        case .vertexHelper(let vertex):
            let key = vertex.bifrostKey
            // A quiet stretch of a call must not time the socket out. The helper carries a call
            // over Vertex's connection limit itself.
            guard let recap else {
                return WebSocketTransport(apiKey: { key }, endpoint: vertex.conversationEndpoint, requestTimeout: 660)
            }
            return try GeminiHelperResumeTransport(
                socket: WebSocketTransport(apiKey: { key }, endpoint: vertex.conversationResumeEndpoint, requestTimeout: 660),
                recap: recap)
        case .geminiAPI:
            let resume = try LiveResume.context(recap ?? "")
            guard let setup = GeminiAPILiveTransport.setupFrame(instruction: resume?.instruction ?? "") else {
                throw ACPClient.Failure(message: "Gemini Live's call setup (gemini_live_setup.json) is missing from Bento.")
            }
            let socket: @Sendable () -> LiveTransport = { WebSocketTransport(apiKey: { APIKeyStore.loadAPIKey() ?? "" }, requestTimeout: 660) }
            return GeminiAPILiveTransport(
                socket: socket(), setup: setup,
                recap: try resume.map { try GeminiAPILiveTransport.recapFrame($0.recap) }, reconnect: socket)
        case .unavailable(let reason):
            throw ACPClient.Failure(message: reason)
        }
    }
}

/// A call on the Gemini API's Live socket. No helper sits in between, so this sends
/// the setup the helper sends to Vertex (`helper/gemini_live_setup.json`) as soon as
/// it connects, and a resumed call's recap as the helper does; after that the
/// controller sees the same events either way.
///
/// Like the helper, it carries a call over Gemini's connection limit: on `goAway` a
/// `reconnect` socket resumes the session from its latest handle, the old one carrying
/// audio until the new one is set up. The controller hears `goAway` only if that fails.
final class GeminiAPILiveTransport: LiveTransport, LiveSocketReporting, @unchecked Sendable {
    private var socket: LiveTransport
    private let setup: Data
    private var recap: Data?
    private let reconnect: (@Sendable () -> LiveTransport)?
    private var handle: String?
    private var rotation: Task<Bool, Never>?
    private var heldGoAway: Data?
    private var closed = false
    private let lock = NSLock()

    init(socket: LiveTransport, setup: Data, recap: Data? = nil, reconnect: (@Sendable () -> LiveTransport)? = nil) {
        self.socket = socket
        self.setup = setup
        self.recap = recap
        self.reconnect = reconnect
    }

    private var current: LiveTransport { lock.withLock { socket } }

    func connect() async throws {
        try await socket.connect()
        try await socket.send(setup)
    }

    func send(_ data: Data) async throws {
        let to = current
        do { try await to.send(data) } catch {
            // The old socket can close before its replacement is set up. Audio is dropped, since
            // waiting would back the microphone up; anything else goes to the replacement.
            if lock.withLock({ rotation != nil }),
               ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["realtimeInput"] != nil { return }
            guard await replaced(to) else { throw error }
            try await current.send(data)
        }
    }

    /// Gemini takes nothing before setupComplete. The recap goes straight after it, before
    /// the controller sees it and starts the microphone.
    func receive() async throws -> Data {
        while true {
            if let goAway = lock.withLock({ rotation == nil ? heldGoAway.take() : nil }) { return goAway }
            let from = current
            let data: Data
            do { data = try await from.receive() } catch {
                if await replaced(from) { continue }
                if let goAway = lock.withLock({ heldGoAway.take() }) { return goAway }
                throw error
            }
            guard from === current else { continue }
            if let recap = takeRecap(after: data) { try await from.send(recap) }
            let event = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            if let update = event?["sessionResumptionUpdate"] as? [String: Any], update["resumable"] as? Bool == true,
               let handle = update["newHandle"] as? String, !handle.isEmpty {
                lock.withLock { self.handle = handle }
            }
            if event?["goAway"] != nil, rotate(goAway: data) { continue }
            return data
        }
    }

    /// Whether `socket` has been replaced, once any rotation under way has finished.
    private func replaced(_ socket: LiveTransport) async -> Bool {
        if let rotation = lock.withLock({ self.rotation }) { _ = await rotation.value }
        return current !== socket
    }

    /// Starts moving the call to a socket that resumes the session. False when it can't.
    private func rotate(goAway: Data) -> Bool {
        lock.withLock {
            guard rotation == nil, !closed, let reconnect, let handle,
                  let setup = Self.resuming(setup, handle: handle) else { return false }
            heldGoAway = goAway
            rotation = Task { [weak self] in
                let next = reconnect()
                let ready = await Self.open(next, setup: setup)
                guard let self else { next.close(); return false }
                let old: LiveTransport? = self.lock.withLock {
                    self.rotation = nil
                    guard ready, !self.closed else { return nil }
                    defer { self.socket = next; self.heldGoAway = nil }
                    return self.socket
                }
                guard let old else { next.close(); return false }
                old.close()
                return true
            }
            return true
        }
    }

    /// Connects and sends the setup, then waits for setupComplete: at most 25 seconds.
    private static func open(_ socket: LiveTransport, setup: Data) async -> Bool {
        let ready = await withTaskGroup(of: Bool.self) { group in
            group.addTask {
                do {
                    try await socket.connect()
                    try await socket.send(setup)
                    var event: [String: Any]?
                    repeat {
                        event = try JSONSerialization.jsonObject(with: try await socket.receive()) as? [String: Any]
                    } while event?["setupComplete"] == nil
                    return true
                } catch { return false }
            }
            group.addTask { try? await Task.sleep(for: .seconds(25)); return false }
            let first = await group.next() ?? false
            if !first { socket.close() } // unblocks a hung connect or receive
            group.cancelAll()
            return first
        }
        return ready
    }

    /// `setup` resuming the session from `handle`.
    static func resuming(_ setup: Data, handle: String) -> Data? {
        guard var frame = (try? JSONSerialization.jsonObject(with: setup)) as? [String: Any],
              var inner = frame["setup"] as? [String: Any] else { return nil }
        inner["sessionResumption"] = ["handle": handle]
        frame["setup"] = inner
        return try? JSONSerialization.data(withJSONObject: frame)
    }

    /// The recap, once, when `data` is setupComplete.
    private func takeRecap(after data: Data) -> Data? {
        lock.withLock {
            guard let recap, ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["setupComplete"] != nil else { return nil }
            self.recap = nil
            return recap
        }
    }
    func close() {
        let socket = lock.withLock { closed = true; return self.socket }
        socket.close()
    }
    var ending: LiveSocketEnding { (current as? LiveSocketReporting)?.ending ?? LiveSocketEnding() }

    /// `{"setup": …}`: the shared setup with the Gemini API's model name. A resumed call's
    /// instructions end with `LiveResume`'s fixed line, as the helper's do.
    static func setupFrame(from url: URL? = VoiceResources.url("gemini_live_setup", "json", in: "helper"),
                           instruction resume: String = "") -> Data? {
        guard let url, let data = try? Data(contentsOf: url),
              var setup = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        setup["model"] = "models/" + SettingsStore.GeminiLiveRoute.geminiAPIModel
        if !resume.isEmpty {
            guard var instruction = setup["systemInstruction"] as? [String: Any],
                  var parts = instruction["parts"] as? [[String: Any]], let text = parts.first?["text"] as? String else { return nil }
            parts[0]["text"] = text + resume
            instruction["parts"] = parts
            setup["systemInstruction"] = instruction
        }
        return try? JSONSerialization.data(withJSONObject: ["setup": setup])
    }

    /// The earlier call's transcript as the first user turn, reference rather than instructions.
    /// turnComplete false: it joins the context without Gemini answering it.
    static func recapFrame(_ recap: String) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["clientContent": [
            "turns": [["role": "user", "parts": [["text": recap]]]], "turnComplete": false]])
    }
}

/// A resumed call through the helper's /conversation/resume. Its first message carries the
/// earlier call's transcript, which the helper hands Vertex as the first user turn; a helper
/// older than the route refuses the upgrade (`GeminiLiveEnding`).
final class GeminiHelperResumeTransport: LiveTransport, LiveSocketReporting {
    private let socket: LiveTransport
    private let resume: Data

    init(socket: LiveTransport, recap: String) throws {
        self.socket = socket
        resume = try JSONSerialization.data(withJSONObject: ["resume": ["recap": recap]])
    }

    func connect() async throws {
        try await socket.connect()
        try await socket.send(resume)
    }

    func send(_ data: Data) async throws { try await socket.send(data) }
    func receive() async throws -> Data { try await socket.receive() }
    func close() { socket.close() }
    var ending: LiveSocketEnding { (socket as? LiveSocketReporting)?.ending ?? LiveSocketEnding() }
}

/// A transport that can say how its socket ended.
protocol LiveSocketReporting { var ending: LiveSocketEnding { get } }

extension WebSocketTransport: LiveSocketReporting {}

/// What the user hears when a call's socket ends without the helper's error event.
/// The Gemini API has no helper to name the failure, so its close says it instead.
enum GeminiLiveEnding {
    static func outcome(_ ending: LiveSocketEnding, goingAway: Bool, geminiAPI: Bool, helperResume: Bool = false)
        -> (message: String, code: AzureLiveDiagnostics.Code) {
        // Gemini warns with goAway before closing a call at its time limit.
        if goingAway { return ("Gemini ended the call at its time limit. Start again to continue.", .sessionLimit) }
        // A helper older than /conversation/resume has no such route. New calls still work.
        if helperResume, ending.httpStatus == 404 {
            return ("Gemini voice couldn't resume the call: the voice helper is out of date. "
                    + "Run scripts/voice-helper.sh update, or press New Chat to start a new call.", .bridgeFailure)
        }
        // A bad key upgrades and then closes with 1007; a key without access is refused with 403.
        let keyRejected = [401, 403].contains(ending.httpStatus)
            || ending.closeCode == 1007 && ending.closeReason?.localizedCaseInsensitiveContains("API key") == true
        if keyRejected {
            return (geminiAPI ? "Gemini rejected the API key. Check it in Settings → Dictation → Advanced."
                              : "The local Vertex helper refused the call. Check bifrost_key in voice-runtime.json.", .bridgeFailure)
        }
        // A normal close (1000) says nothing more than "disconnected".
        let detail = [ending.httpStatus.map { "HTTP \($0)" }, ending.closeCode.flatMap { $0 == 1000 ? nil : "close \($0)" }]
            .compactMap { $0 }
        guard !detail.isEmpty else { return ("Gemini voice disconnected. No task was retried.", .disconnected) }
        return ("Gemini voice failed (\(detail.joined(separator: ", "))). No task was retried.", .bridgeFailure)
    }
}
