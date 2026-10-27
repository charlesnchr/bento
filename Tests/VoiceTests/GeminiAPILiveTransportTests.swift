import Foundation
import Testing
import VoiceCore
@testable import Voice

/// A call on the Gemini API sends the helper's own setup, with the Gemini API's
/// model name, before anything else.
@Suite struct GeminiAPILiveTransportTests {
    class FakeSocket: LiveTransport, @unchecked Sendable {
        var events: [String] = []
        var sent: [Data] = []
        func connect() async throws { events.append("connect") }
        func send(_ data: Data) async throws { events.append("send"); sent.append(data) }
        func receive() async throws -> Data { events.append("receive"); return Data(#"{"setupComplete":{}}"#.utf8) }
        func close() { events.append("close") }
    }

    private func setup(recap: String = "") throws -> [String: Any] {
        let frame = try #require(GeminiAPILiveTransport.setupFrame(recap: recap))
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

    private func instruction(_ setup: [String: Any]) -> String? {
        ((setup["systemInstruction"] as? [String: Any])?["parts"] as? [[String: Any]])?.first?["text"] as? String
    }

    @Test func aResumedCallsInstructionsEndWithTheRecap() throws {
        let fresh = try setup(), resumed = try setup(recap: "User: book a table\nHermes: Booked for 7pm.")
        let base = try #require(instruction(fresh))
        #expect(!base.contains("earlier_conversation"))
        // The helper's wording, from the same file (LiveResumeNoteTests).
        #expect(instruction(resumed) == base + " " + LiveResumeNoteTests.instruction
                + "\n<earlier_conversation>\nUser: book a table\nHermes: Booked for 7pm.\n</earlier_conversation>")
        // Nothing else changes.
        var a = fresh, b = resumed
        a["systemInstruction"] = nil; b["systemInstruction"] = nil
        #expect(NSDictionary(dictionary: a) == NSDictionary(dictionary: b))
        #expect(instruction(try setup(recap: " \n")) == base)
    }

    @Test func aRecapOverTheLimitHasNoSetup() {
        #expect(GeminiAPILiveTransport.setupFrame(recap: String(repeating: "x", count: 8001)) == nil)
    }

    @Test func aResumeThroughTheHelperSendsOnlyTheRecapFirst() async throws {
        let socket = FakeSocket()
        let transport = try GeminiHelperResumeTransport(socket: socket, recap: "User: hi")
        try await transport.connect()
        #expect(socket.events == ["connect", "send"])
        let first = try #require(try JSONSerialization.jsonObject(with: socket.sent[0]) as? [String: Any])
        #expect(NSDictionary(dictionary: first) == NSDictionary(dictionary: ["resume": ["recap": "User: hi"]]))
        _ = try await transport.receive()
        try await transport.send(Data("audio".utf8))
        transport.close()
        #expect(socket.events == ["connect", "send", "receive", "send", "close"])
        #expect(socket.sent.last == Data("audio".utf8))
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

    @Test func endingForwardsTheSocketsEnding() {
        final class Reporting: FakeSocket, LiveSocketReporting, @unchecked Sendable {
            var ending: LiveSocketEnding { LiveSocketEnding(closeCode: 1007, closeReason: "API key not valid.") }
        }
        #expect(GeminiAPILiveTransport(socket: Reporting(), setup: Data()).ending.closeCode == 1007)
        #expect(GeminiAPILiveTransport(socket: FakeSocket(), setup: Data()).ending == LiveSocketEnding())
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

    /// The Gemini API upgrades a bad key and then closes; the socket must report it.
    @Test func aBadKeyEndsAsARejectedKey() async throws {
        let socket = WebSocketTransport(apiKey: { "AIzaSyInvalidKeyForBentoProbe0000000000" })
        let transport = GeminiAPILiveTransport(socket: socket, setup: try #require(GeminiAPILiveTransport.setupFrame()))
        defer { transport.close() }
        try await transport.connect()
        await #expect(throws: (any Error).self) { _ = try await transport.receive() }
        let ending = transport.ending
        #expect(ending.closeCode == 1007)
        #expect(GeminiLiveEnding.outcome(ending, goingAway: false, geminiAPI: true).message.hasPrefix("Gemini rejected the API key"))
    }
}

/// What the user is told when a call's socket ends.
@Suite struct GeminiLiveEndingTests {
    private func outcome(_ ending: LiveSocketEnding, goingAway: Bool = false, geminiAPI: Bool = true)
        -> (message: String, code: AzureLiveDiagnostics.Code) {
        GeminiLiveEnding.outcome(ending, goingAway: goingAway, geminiAPI: geminiAPI)
    }

    @Test func aRejectedKeySaysSo() {
        for ending in [LiveSocketEnding(httpStatus: 401), LiveSocketEnding(httpStatus: 403),
                       LiveSocketEnding(closeCode: 1007, closeReason: "API key not valid. Please pass a valid API key.")] {
            #expect(outcome(ending).message == "Gemini rejected the API key. Check it in Settings → Dictation → Advanced.")
            #expect(outcome(ending).code == .bridgeFailure)
        }
        #expect(outcome(LiveSocketEnding(httpStatus: 401), geminiAPI: false).message.contains("Vertex helper"),
                "Through the helper a 401 is the helper's own key, not Google's")
    }

    @Test func otherFailuresCarryTheirCodes() {
        #expect(outcome(LiveSocketEnding(closeCode: 1007, closeReason: "Invalid setup field")).message
                == "Gemini voice failed (close 1007). No task was retried.")
        let throttled = outcome(LiveSocketEnding(httpStatus: 429))
        #expect(throttled.message == "Gemini voice failed (HTTP 429). No task was retried.")
        #expect(throttled.code == .bridgeFailure)
        #expect(outcome(LiveSocketEnding(closeCode: 1011)).message.contains("close 1011"))
    }

    @Test func aHelperWithoutTheResumeRouteSaysToUpdateIt() {
        let outdated = GeminiLiveEnding.outcome(LiveSocketEnding(httpStatus: 404), goingAway: false, geminiAPI: false, helperResume: true)
        #expect(outdated.message == "Gemini voice couldn't resume the call: the voice helper is out of date. "
                + "Run scripts/voice-helper.sh update, or press New Chat to start a new call.")
        #expect(outdated.code == .bridgeFailure)
        // A new call's 404 isn't about the resume route; neither is another failure while resuming.
        #expect(outcome(LiveSocketEnding(httpStatus: 404), geminiAPI: false).message == "Gemini voice failed (HTTP 404). No task was retried.")
        #expect(GeminiLiveEnding.outcome(LiveSocketEnding(httpStatus: 401), goingAway: false, geminiAPI: false, helperResume: true)
                .message.contains("Vertex helper refused"))
        #expect(GeminiLiveEnding.outcome(LiveSocketEnding(), goingAway: false, geminiAPI: false, helperResume: true)
                .message == "Gemini voice disconnected. No task was retried.")
    }

    @Test func aDropWithNothingToSayIsADisconnect() {
        for ending in [LiveSocketEnding(), LiveSocketEnding(closeCode: 1000)] {
            #expect(outcome(ending).message == "Gemini voice disconnected. No task was retried.")
            #expect(outcome(ending).code == .disconnected)
        }
    }

    @Test func aCloseAfterGoAwayIsTheTimeLimit() {
        for ending in [LiveSocketEnding(), LiveSocketEnding(closeCode: 1001), LiveSocketEnding(httpStatus: 403)] {
            #expect(outcome(ending, goingAway: true).message == "Gemini ended the call at its time limit. Start again to continue.")
            #expect(outcome(ending, goingAway: true).code == .sessionLimit)
        }
    }
}
