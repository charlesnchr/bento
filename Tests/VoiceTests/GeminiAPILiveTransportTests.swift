import Foundation
import Testing
import VoiceCore
@testable import Voice

/// A call on the Gemini API sends the helper's own setup, with the Gemini API's
/// model name, before anything else.
@Suite struct GeminiAPILiveTransportTests {
    final class FakeSocket: LiveTransport, @unchecked Sendable {
        var events: [String] = []
        var sent: [Data] = []
        func connect() async throws { events.append("connect") }
        func send(_ data: Data) async throws { events.append("send"); sent.append(data) }
        func receive() async throws -> Data { events.append("receive"); return Data(#"{"setupComplete":{}}"#.utf8) }
        func close() { events.append("close") }
    }

    private func setup() throws -> [String: Any] {
        let frame = try #require(GeminiAPILiveTransport.setupFrame())
        let object = try #require(try JSONSerialization.jsonObject(with: frame) as? [String: Any])
        #expect(Set(object.keys) == ["setup"])
        return try #require(object["setup"] as? [String: Any])
    }

    @Test func theSetupIsTheHelpersWithTheGeminiAPIModel() throws {
        let setup = try setup()
        #expect(setup["model"] as? String == "models/gemini-3.8-live")
        let tools = setup["tools"] as? [[String: Any]]
        let declarations = tools?.first?["functionDeclarations"] as? [[String: Any]]
        #expect(declarations?.map { $0["name"] as? String } == [GeminiLiveProtocol.tool])
        let generation = setup["generationConfig"] as? [String: Any]
        #expect(generation?["responseModalities"] as? [String] == ["AUDIO"])
        let instruction = ((setup["systemInstruction"] as? [String: Any])?["parts"] as? [[String: Any]])?.first?["text"] as? String
        #expect(instruction?.contains(GeminiLiveProtocol.tool) == true)
        #expect(setup["outputAudioTranscription"] != nil && setup["inputAudioTranscription"] != nil)
    }

    @Test func connectSendsTheSetupFirst() async throws {
        let socket = FakeSocket()
        let frame = try #require(GeminiAPILiveTransport.setupFrame())
        let transport = GeminiAPILiveTransport(socket: socket, setup: frame)
        try await transport.connect()
        #expect(socket.events == ["connect", "send"])
        #expect(socket.sent == [frame])
        _ = try await transport.receive()
        try await transport.send(Data("audio".utf8))
        transport.close()
        #expect(socket.events == ["connect", "send", "receive", "send", "close"])
    }

    @Test func aMissingSetupFileIsNil() {
        #expect(GeminiAPILiveTransport.setupFrame(from: nil) == nil)
        #expect(GeminiAPILiveTransport.setupFrame(from: URL(fileURLWithPath: "/nonexistent/gemini_live_setup.json")) == nil)
    }
}

/// Opens a real call on the Gemini API with the shipped setup and waits for
/// setupComplete, then hangs up; no audio is sent. Opt in explicitly:
///
///   BENTO_VOICE_LIVE_PROBE=1 GEMINI_API_KEY=... scripts/test VoiceTests --filter GeminiAPILiveProbe
@Suite(.enabled(if: ProcessInfo.processInfo.environment["BENTO_VOICE_LIVE_PROBE"] == "1"
                    && ProcessInfo.processInfo.environment["GEMINI_API_KEY"] != nil,
                "live probe: needs the network and credentials; set BENTO_VOICE_LIVE_PROBE=1 and GEMINI_API_KEY"))
struct GeminiAPILiveProbeTests {
    @Test func theGeminiAPIAcceptsTheCallSetup() async throws {
        let key = try #require(ProcessInfo.processInfo.environment["GEMINI_API_KEY"])
        let transport = GeminiAPILiveTransport(socket: WebSocketTransport(apiKey: { key }),
                                               setup: try #require(GeminiAPILiveTransport.setupFrame()))
        defer { transport.close() }
        try await transport.connect()
        let reply = try await transport.receive()
        let event = try JSONSerialization.jsonObject(with: reply) as? [String: Any]
        #expect(event?["setupComplete"] != nil, "First event keys: \(event.map { Array($0.keys) } ?? [])")
    }
}
