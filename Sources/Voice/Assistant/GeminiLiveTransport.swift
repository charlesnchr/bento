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
            // The call runs up to ten minutes; a quiet stretch must not time the socket out.
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
            return GeminiAPILiveTransport(
                socket: WebSocketTransport(apiKey: { KeychainStore.loadAPIKey() ?? "" }, requestTimeout: 660), setup: setup,
                recap: try resume.map { try GeminiAPILiveTransport.recapFrame($0.recap) })
        case .unavailable(let reason):
            throw ACPClient.Failure(message: reason)
        }
    }
}

/// A call on the Gemini API's Live socket. No helper sits in between, so this sends
/// the setup the helper sends to Vertex (`helper/gemini_live_setup.json`) as soon as
/// it connects, and a resumed call's recap as the helper does; after that the
/// controller sees the same events either way.
final class GeminiAPILiveTransport: LiveTransport, LiveSocketReporting, @unchecked Sendable {
    private let socket: LiveTransport
    private let setup: Data
    private var recap: Data?
    private let lock = NSLock()

    init(socket: LiveTransport, setup: Data, recap: Data? = nil) {
        self.socket = socket
        self.setup = setup
        self.recap = recap
    }

    func connect() async throws {
        try await socket.connect()
        try await socket.send(setup)
    }

    func send(_ data: Data) async throws { try await socket.send(data) }

    /// Gemini takes nothing before setupComplete. The recap goes straight after it, before
    /// the controller sees it and starts the microphone.
    func receive() async throws -> Data {
        let data = try await socket.receive()
        if let recap = takeRecap(after: data) { try await socket.send(recap) }
        return data
    }

    /// The recap, once, when `data` is setupComplete.
    private func takeRecap(after data: Data) -> Data? {
        lock.withLock {
            guard let recap, ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["setupComplete"] != nil else { return nil }
            self.recap = nil
            return recap
        }
    }
    func close() { socket.close() }
    var ending: LiveSocketEnding { (socket as? LiveSocketReporting)?.ending ?? LiveSocketEnding() }

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
