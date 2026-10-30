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

    private func setup(instruction: String = "") throws -> [String: Any] {
        let frame = try #require(GeminiAPILiveTransport.setupFrame(instruction: instruction))
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
        // No session time limit, and handles to resume from when a connection ends.
        #expect(NSDictionary(dictionary: setup["contextWindowCompression"] as? [String: Any] ?? [:]) == ["slidingWindow": [String: Any]()])
        #expect((setup["sessionResumption"] as? [String: Any])?.isEmpty == true)
    }

    private func instruction(_ setup: [String: Any]) -> String? {
        ((setup["systemInstruction"] as? [String: Any])?["parts"] as? [[String: Any]])?.first?["text"] as? String
    }

    @Test func aResumedCallsInstructionsEndWithOnlyTheFixedLine() throws {
        let fresh = try setup()
        let resume = try #require(try LiveResume.context("User: book a table\nHermes: Booked for 7pm."))
        let resumed = try setup(instruction: resume.instruction)
        let base = try #require(instruction(fresh))
        // The helper's wording, from the same file (LiveResumeTests); the transcript isn't in the setup.
        #expect(instruction(resumed) == base + LiveResumeTests.instruction)
        #expect(!(instruction(resumed) ?? "").contains("book a table"))
        // Nothing else changes.
        var a = fresh, b = resumed
        a["systemInstruction"] = nil; b["systemInstruction"] = nil
        #expect(NSDictionary(dictionary: a) == NSDictionary(dictionary: b))
    }

    @Test func theRecapIsAUserTurnGeminiDoesntAnswer() throws {
        let frame = try JSONSerialization.jsonObject(with: try GeminiAPILiveTransport.recapFrame("transcript")) as? [String: Any]
        let expected: [String: Any] = ["clientContent": ["turns": [["role": "user", "parts": [["text": "transcript"]]]], "turnComplete": false]]
        #expect(NSDictionary(dictionary: frame ?? [:]) == NSDictionary(dictionary: expected))
    }

    @Test func theRecapGoesStraightAfterSetupCompleteOnce() async throws {
        final class Socket: FakeSocket, @unchecked Sendable {
            var replies = [#"{"serverContent":{}}"#, #"{"setupComplete":{}}"#, #"{"setupComplete":{}}"#]
            override func receive() async throws -> Data { events.append("receive"); return Data(replies.removeFirst().utf8) }
        }
        let socket = Socket()
        let setup = try #require(GeminiAPILiveTransport.setupFrame()), recap = try GeminiAPILiveTransport.recapFrame("transcript")
        let transport = GeminiAPILiveTransport(socket: socket, setup: setup, recap: recap)
        try await transport.connect()
        _ = try await transport.receive()
        #expect(socket.sent == [setup], "Nothing before setupComplete")
        let event = try await transport.receive()
        #expect(String(decoding: event, as: UTF8.self) == #"{"setupComplete":{}}"#)
        #expect(socket.sent == [setup, recap])
        _ = try await transport.receive()
        #expect(socket.events == ["connect", "send", "receive", "receive", "send", "receive"])
    }

    @Test func aNewCallSendsNoRecap() async throws {
        let socket = FakeSocket()
        let setup = try #require(GeminiAPILiveTransport.setupFrame())
        let transport = GeminiAPILiveTransport(socket: socket, setup: setup)
        try await transport.connect()
        _ = try await transport.receive()
        #expect(socket.sent == [setup])
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

    @Test func aCallBackFromStandbyHearsTheRecapThenTheReplyAsATurn() async throws {
        let socket = FakeSocket()
        let setup = try #require(GeminiAPILiveTransport.setupFrame())
        let recap = try GeminiAPILiveTransport.recapFrame("transcript"), result = try GeminiAPILiveTransport.resultFrame("reply")
        let transport = GeminiAPILiveTransport(socket: socket, setup: setup, recap: recap, result: result)
        try await transport.connect()
        _ = try await transport.receive()
        #expect(socket.sent == [setup, recap, result])
        let frame = try JSONSerialization.jsonObject(with: result) as? [String: Any]
        let expected: [String: Any] = ["clientContent": ["turns": [["role": "user", "parts": [["text": "reply"]]]], "turnComplete": true]]
        #expect(NSDictionary(dictionary: frame ?? [:]) == NSDictionary(dictionary: expected))
        _ = try await transport.receive()
        #expect(socket.sent == [setup, recap, result], "Once")
    }

    @Test func theHelperCarriesTheReplyInTheResume() async throws {
        let socket = FakeSocket()
        let transport = try GeminiHelperResumeTransport(socket: socket, recap: "User: hi", result: "Booked.")
        #expect(transport.carriesResult)
        try await transport.connect()
        let first = try #require(try JSONSerialization.jsonObject(with: socket.sent[0]) as? [String: Any])
        #expect(NSDictionary(dictionary: first) == NSDictionary(dictionary: ["resume": ["recap": "User: hi", "result": "Booked."]]))
        #expect(try GeminiHelperResumeTransport(socket: FakeSocket(), recap: "User: hi").carriesResult == false)
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

    /// Frames queued by the test; receive waits for one and throws once closed.
    final class QueueSocket: LiveTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var inbox: [String]
        private var frames: [Data] = []
        private var isClosed = false
        var connectFails = false
        init(_ inbox: [String] = []) { self.inbox = inbox }
        func push(_ frame: String) { lock.withLock { inbox.append(frame) } }
        var sent: [Data] { lock.withLock { frames } }
        var closed: Bool { lock.withLock { isClosed } }
        func connect() async throws { if connectFails { throw URLError(.notConnectedToInternet) } }
        func send(_ data: Data) async throws {
            try lock.withLock {
                if isClosed { throw URLError(.networkConnectionLost) }
                frames.append(data)
            }
        }
        func receive() async throws -> Data {
            for _ in 0..<500 {
                let next: String? = try lock.withLock {
                    if !inbox.isEmpty { return inbox.removeFirst() }
                    if isClosed { throw URLError(.networkConnectionLost) }
                    return nil
                }
                if let next { return Data(next.utf8) }
                try await Task.sleep(for: .milliseconds(10))
            }
            throw URLError(.timedOut)
        }
        func close() { lock.withLock { isClosed = true } }
    }

    static let setupComplete = #"{"setupComplete":{}}"#
    static let resumable = #"{"sessionResumptionUpdate":{"newHandle":"h1","resumable":true}}"#
    static let goAway = #"{"goAway":{"timeLeft":"10s"}}"#
    private func text(_ data: Data) -> String { String(decoding: data, as: UTF8.self) }

    @Test func goAwayMovesTheCallToASocketThatResumesTheSession() async throws {
        let first = QueueSocket([Self.setupComplete, Self.resumable, Self.goAway])
        let second = QueueSocket([Self.setupComplete, #"{"serverContent":{"turnComplete":true}}"#])
        let transport = GeminiAPILiveTransport(socket: first, setup: try #require(GeminiAPILiveTransport.setupFrame()),
                                               reconnect: { second })
        try await transport.connect()
        #expect(text(try await transport.receive()) == Self.setupComplete)
        #expect(text(try await transport.receive()) == Self.resumable)
        // The controller hears neither the goAway nor the new socket's setupComplete.
        #expect(text(try await transport.receive()) == #"{"serverContent":{"turnComplete":true}}"#)
        #expect(first.closed)
        let resumed = try #require(try JSONSerialization.jsonObject(with: second.sent[0]) as? [String: Any])
        #expect(((resumed["setup"] as? [String: Any])?["sessionResumption"] as? [String: Any])?["handle"] as? String == "h1")
        try await transport.send(Data("audio".utf8))
        #expect(second.sent.last == Data("audio".utf8))
        #expect(first.sent.count == 1, "Only the first setup went to the old socket")
        transport.close()
        #expect(second.closed)
    }

    @Test func audioTheClosedOldSocketCantTakeIsDroppedAndAResultWaitsForTheNewOne() async throws {
        let first = QueueSocket([Self.setupComplete, Self.resumable, Self.goAway])
        let second = QueueSocket()
        let transport = GeminiAPILiveTransport(socket: first, setup: try #require(GeminiAPILiveTransport.setupFrame()),
                                               reconnect: { second })
        try await transport.connect()
        _ = try await transport.receive()
        _ = try await transport.receive()
        let reading = Task { try await transport.receive() } // takes the goAway and starts the move
        try await Task.sleep(for: .milliseconds(100))
        first.close()
        let audio = Data(#"{"realtimeInput":{"audio":{}}}"#.utf8), result = Data(#"{"toolResponse":{}}"#.utf8)
        try await transport.send(audio) // returns at once rather than holding the microphone
        let sending = Task { try await transport.send(result) }
        try await Task.sleep(for: .milliseconds(100))
        second.push(Self.setupComplete)
        second.push(#"{"serverContent":{}}"#)
        try await sending.value
        #expect(text(try await reading.value) == #"{"serverContent":{}}"#)
        #expect(second.sent.dropFirst().map { text($0) } == [text(result)])
        transport.close()
    }

    @Test func withoutAHandleTheControllerHearsGoAway() async throws {
        let first = QueueSocket([Self.setupComplete, Self.goAway])
        let transport = GeminiAPILiveTransport(socket: first, setup: try #require(GeminiAPILiveTransport.setupFrame()),
                                               reconnect: { Issue.record("Nothing to resume"); return QueueSocket() })
        try await transport.connect()
        _ = try await transport.receive()
        #expect(text(try await transport.receive()) == Self.goAway)
        transport.close()
    }

    @Test func aFailedReconnectLetsTheControllerHearGoAway() async throws {
        let first = QueueSocket([Self.setupComplete, Self.resumable, Self.goAway])
        let second = QueueSocket()
        second.connectFails = true
        let transport = GeminiAPILiveTransport(socket: first, setup: try #require(GeminiAPILiveTransport.setupFrame()),
                                               reconnect: { second })
        try await transport.connect()
        _ = try await transport.receive()
        _ = try await transport.receive()
        Task { try await Task.sleep(for: .milliseconds(200)); first.close() } // Gemini closes at its limit
        #expect(text(try await transport.receive()) == Self.goAway)
        #expect(second.closed)
        await #expect(throws: (any Error).self) { _ = try await transport.receive() }
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

/// A resumed call, live: the recap (with a codeword) goes in as the first user turn, Gemini
/// stays silent until real speech arrives, then answers a spoken question from the recap.
/// Opt in explicitly; the question is spoken by `say`:
///
///   BENTO_VOICE_LIVE_PROBE=1 GEMINI_API_KEY=... scripts/test VoiceTests --filter ResumedCallProbe
///
/// Through the Vertex helper, point at a runtime file for a helper you started yourself
/// (`BENTO_VOICE_HELPER_RUNTIME=/path/to/voice-runtime.json`); it uses that file's port and key.
@Suite(.enabled(if: ProcessInfo.processInfo.environment["BENTO_VOICE_LIVE_PROBE"] == "1",
                "live probe: needs the network, credentials and say; set BENTO_VOICE_LIVE_PROBE=1"))
struct ResumedCallProbeTests {
    static let recap = "User: Remember this codeword for later: marigold.\nGemini Live: Got it. The codeword is marigold."

    @Test(.enabled(if: ProcessInfo.processInfo.environment["GEMINI_API_KEY"] != nil, "set GEMINI_API_KEY"))
    func theGeminiAPIAnswersFromTheRecap() async throws {
        let key = try #require(ProcessInfo.processInfo.environment["GEMINI_API_KEY"])
        let resume = try #require(try LiveResume.context(Self.recap))
        let transport = GeminiAPILiveTransport(
            socket: WebSocketTransport(apiKey: { key }, requestTimeout: 120),
            setup: try #require(GeminiAPILiveTransport.setupFrame(instruction: resume.instruction)),
            recap: try GeminiAPILiveTransport.recapFrame(resume.recap))
        try await Self.probe(transport, route: "gemini-api")
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["BENTO_VOICE_HELPER_RUNTIME"] != nil, "set BENTO_VOICE_HELPER_RUNTIME"))
    func theVertexHelperAnswersFromTheRecap() async throws {
        let path = try #require(ProcessInfo.processInfo.environment["BENTO_VOICE_HELPER_RUNTIME"])
        let vertex = try VertexRuntimeConfig.load(from: URL(fileURLWithPath: path))
        let key = vertex.bifrostKey
        let transport = try GeminiHelperResumeTransport(
            socket: WebSocketTransport(apiKey: { key }, endpoint: vertex.conversationResumeEndpoint, requestTimeout: 120),
            recap: Self.recap)
        try await Self.probe(transport, route: "vertex-helper")
    }

    final class Events: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [(at: Date, event: [String: Any])] = []
        var ended: Error?
        var answeredTool: Date?
        func append(_ event: [String: Any]) { lock.withLock { items.append((Date(), event)) } }
        func all() -> [(at: Date, event: [String: Any])] { lock.withLock { items } }
    }

    /// Anything Gemini generates: audio, a transcript of its speech, a tool call or a finished turn.
    static func isOutput(_ event: [String: Any]) -> Bool {
        let content = event["serverContent"] as? [String: Any] ?? [:]
        return content["modelTurn"] != nil || content["outputTranscription"] != nil || content["turnComplete"] != nil
            || content["generationComplete"] != nil || event["toolCall"] != nil || event["outputTranscription"] != nil
    }

    static func spoken(_ text: String) throws -> Data {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("bento-probe-\(UUID().uuidString).wav")
        defer { try? FileManager.default.removeItem(at: url) }
        let say = Process()
        say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        say.arguments = ["-o", url.path, "--file-format=WAVE", "--data-format=LEI16@16000", text]
        try say.run(); say.waitUntilExit()
        let wav = try Data(contentsOf: url)
        let marker = Data("data".utf8)
        let range = try #require(wav.range(of: marker))
        return wav.subdata(in: (range.upperBound + 4)..<wav.count)
    }

    static func probe(_ transport: LiveTransport, route: String) async throws {
        // Asked not to use Hermes: its instructions send memory questions there, and Hermes isn't in this test.
        let speech = try spoken("Don't ask Hermes, just tell me yourself: what was the codeword I gave you earlier?")
        let events = Events()
        defer { transport.close() }
        try await transport.connect()
        let reader = Task {
            do {
                while !Task.isCancelled {
                    let data = try await transport.receive()
                    let event = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? ["unparsed": data.count]
                    events.append(event)
                    // Answer an ask_hermes call so the turn can finish; it says nothing about the codeword.
                    for call in (event["toolCall"] as? [String: Any])?["functionCalls"] as? [[String: Any]] ?? [] {
                        guard let id = call["id"] as? String else { continue }
                        let reply = GeminiLiveProtocol.response(id: id, message: "Not executed: Hermes is unavailable in this test.", executed: false)
                        try await transport.send(try JSONSerialization.data(withJSONObject: reply))
                        events.answeredTool = Date()
                    }
                }
            } catch { events.ended = error }
        }
        defer { reader.cancel() }
        func waitFor(_ seconds: Double, until done: () -> Bool) async {
            let end = Date().addingTimeInterval(seconds)
            while Date() < end, !done(), events.ended == nil { try? await Task.sleep(for: .milliseconds(100)) }
        }
        await waitFor(20) { events.all().contains { $0.event["setupComplete"] != nil } }
        _ = try #require(events.all().first { $0.event["setupComplete"] != nil }?.at,
                                   "No setupComplete: \(events.all().map { Array($0.event.keys) }), ended: \(String(describing: events.ended))")
        // Five quiet seconds after the recap: Gemini must not answer it.
        try await Task.sleep(for: .seconds(5))
        let early = events.all().filter { isOutput($0.event) }
        let audioAt = Date()
        // The question at real-time pace, then a second and a half of silence and the end of the stream.
        let chunk = 3200
        for offset in stride(from: 0, to: speech.count + 48000, by: chunk) {
            let pcm = offset < speech.count ? speech.subdata(in: offset..<min(offset + chunk, speech.count)) : Data(count: chunk)
            let event: [String: Any] = ["realtimeInput": ["audio": ["mimeType": "audio/pcm;rate=16000", "data": pcm.base64EncodedString()]]]
            try await transport.send(try JSONSerialization.data(withJSONObject: event))
            try await Task.sleep(for: .milliseconds(100))
        }
        try await transport.send(try JSONSerialization.data(withJSONObject: ["realtimeInput": ["audioStreamEnd": true]]))
        // Speech after the question (and after any tool call was answered), then the end of that turn.
        func answered() -> Bool {
            let since = max(audioAt, events.answeredTool ?? audioAt)
            guard let spoke = events.all().first(where: { $0.at > since && isOutput($0.event) && $0.event["toolCall"] == nil
                && ($0.event["serverContent"] as? [String: Any])?["turnComplete"] == nil
                && ($0.event["serverContent"] as? [String: Any])?["generationComplete"] == nil })?.at else { return false }
            return events.all().contains { $0.at >= spoke && ($0.event["serverContent"] as? [String: Any])?["turnComplete"] as? Bool == true }
        }
        await waitFor(45, until: answered)
        // A reply after a tool result can follow in a later turn.
        try await Task.sleep(for: .seconds(6))
        let after = events.all().filter { $0.at > audioAt }
        func text(_ key: String) -> String {
            after.compactMap { (($0.event["serverContent"] as? [String: Any])?[key] as? [String: Any])?["text"] as? String }.joined()
        }
        let heard = text("inputTranscription"), said = text("outputTranscription")
        let audioChunks = after.filter { (($0.event["serverContent"] as? [String: Any])?["modelTurn"]) != nil }.count
        let toolCalls = after.filter { $0.event["toolCall"] != nil }.count
        print("PROBE \(route): setupComplete after connect; early output events in 5 s: \(early.count) "
              + "\(early.map { Array($0.event.keys) }); after audio: \(after.count) events, \(audioChunks) audio, \(toolCalls) tool calls, "
              + "turnComplete: \(answered()); heard: \"\(heard)\"; said: \"\(said)\"; ended: \(events.ended.map { "\($0)" } ?? "no")")
        print("PROBE \(route) sequence: " + after.map { item in
            let content = (item.event["serverContent"] as? [String: Any]).map { "serverContent" + $0.keys.sorted().description } ?? ""
            return content.isEmpty ? item.event.keys.sorted().description : content
        }.joined(separator: " "))
        #expect(early.isEmpty, "Gemini answered the recap before any audio")
        #expect(answered(), "No finished reply to the spoken question")
        #expect(said.localizedCaseInsensitiveContains("marigold"), "The reply didn't use the recap")
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
