import Foundation
import VoiceCore

extension GeminiLiveController {
    /// A call goes where dictation's Gemini goes (`SettingsStore.geminiLiveRoute`):
    /// the Gemini API with the user's key, or the direct Vertex helper.
    nonisolated static func routedTransport() throws -> LiveTransport {
        switch SettingsStore().geminiLiveRoute {
        case .vertexHelper(let vertex):
            let key = vertex.bifrostKey
            // The call runs up to ten minutes; a quiet stretch must not time the socket out.
            return WebSocketTransport(apiKey: { key }, endpoint: vertex.conversationEndpoint, requestTimeout: 660)
        case .geminiAPI:
            guard let setup = GeminiAPILiveTransport.setupFrame() else {
                throw ACPClient.Failure(message: "Gemini Live's call setup is missing from Bento.")
            }
            return GeminiAPILiveTransport(
                socket: WebSocketTransport(apiKey: { KeychainStore.loadAPIKey() ?? "" }, requestTimeout: 660), setup: setup)
        case .unavailable(let reason):
            throw ACPClient.Failure(message: reason)
        }
    }
}

/// A call on the Gemini API's Live socket. No helper sits in between, so this sends
/// the setup the helper sends to Vertex (`helper/gemini_live_setup.json`) as soon as
/// it connects; after that the controller sees the same events either way.
final class GeminiAPILiveTransport: LiveTransport, LiveSocketReporting {
    private let socket: LiveTransport
    private let setup: Data

    init(socket: LiveTransport, setup: Data) {
        self.socket = socket
        self.setup = setup
    }

    func connect() async throws {
        try await socket.connect()
        try await socket.send(setup)
    }

    func send(_ data: Data) async throws { try await socket.send(data) }
    func receive() async throws -> Data { try await socket.receive() }
    func close() { socket.close() }
    var ending: LiveSocketEnding { (socket as? LiveSocketReporting)?.ending ?? LiveSocketEnding() }

    /// `{"setup": …}`: the shared setup with the Gemini API's model name.
    static func setupFrame(from url: URL? = VoiceResources.url("gemini_live_setup", "json", in: "helper")) -> Data? {
        guard let url, let data = try? Data(contentsOf: url),
              var setup = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        setup["model"] = "models/" + SettingsStore.GeminiLiveRoute.geminiAPIModel
        return try? JSONSerialization.data(withJSONObject: ["setup": setup])
    }
}

/// A transport that can say how its socket ended.
protocol LiveSocketReporting { var ending: LiveSocketEnding { get } }

extension WebSocketTransport: LiveSocketReporting {}

/// What the user hears when a call's socket ends without the helper's error event.
/// The Gemini API has no helper to name the failure, so its close says it instead.
enum GeminiLiveEnding {
    static func outcome(_ ending: LiveSocketEnding, goingAway: Bool, geminiAPI: Bool)
        -> (message: String, code: AzureLiveDiagnostics.Code) {
        // Gemini warns with goAway before closing a call at its time limit.
        if goingAway { return ("Gemini ended the call at its time limit. Start again to continue.", .sessionLimit) }
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
