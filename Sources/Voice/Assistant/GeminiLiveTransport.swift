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
final class GeminiAPILiveTransport: LiveTransport {
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

    /// `{"setup": …}`: the shared setup with the Gemini API's model name.
    static func setupFrame(from url: URL? = VoiceResources.url("gemini_live_setup", "json", in: "helper")) -> Data? {
        guard let url, let data = try? Data(contentsOf: url),
              var setup = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        setup["model"] = "models/" + SettingsStore.GeminiLiveRoute.geminiAPIModel
        return try? JSONSerialization.data(withJSONObject: ["setup": setup])
    }
}
