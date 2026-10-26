// Copyright 2026 Google LLC
import Foundation
import Testing
@testable import VoiceCore

@Suite struct VertexRuntimeConfigTests {
    @Test func directConfigSelectsHelperAndLiveEndpoint() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try Data(#"{"transport":"direct","bifrost_base_url":"http://127.0.0.1:8767","bifrost_key":"local-secret","project":"p","location":"global","model":"gemini-3.5-transcribe-preview"}"#.utf8).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let config = try VertexRuntimeConfig.load(from: url)
        #expect(config.isDirect)
        #expect(config.liveEndpoint.absoluteString == "ws://127.0.0.1:8767/live")
        #expect(config.conversationEndpoint.absoluteString == "ws://127.0.0.1:8767/conversation")
    }

    @Test func unknownTransportFailsClosed() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try Data(#"{"transport":"unknown","bifrost_base_url":"http://127.0.0.1:8767","bifrost_key":"local-secret","project":"p","location":"global","model":"m"}"#.utf8).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        #expect(throws: (any Error).self) { try VertexRuntimeConfig.load(from: url) }
    }

    @Test func loadsExactDedicatedRuntimeConfig() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try Data(#"{"bifrost_base_url":"http://127.0.0.1:8080","bifrost_key":"secret","project":"example-project","location":"global","model":"gemini-3.5-transcribe-preview"}"#.utf8).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }

        let config = try VertexRuntimeConfig.load(from: url)
        #expect(config.bifrostBaseURL.absoluteString == "http://127.0.0.1:8080")
        #expect(config.bifrostKey == "secret")
        #expect(config.project == "example-project")
        #expect(config.location == "global")
        #expect(config.model == "gemini-3.5-transcribe-preview")
    }

    @Test func rejectsNonLoopbackAndMalformedConfigurations() throws {
        for json in [
            #"{"bifrost_base_url":"https://gateway.example","bifrost_key":"secret","project":"p","location":"global","model":"m"}"#,
            #"{"bifrost_base_url":"http://127.0.0.1:8080","project":"p","location":"global","model":"m"}"#,
            #"{"bifrost_base_url":"http://user:pass@127.0.0.1:8080","bifrost_key":"secret","project":"p","location":"global","model":"m"}"#
        ] {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try Data(json.utf8).write(to: url)
            defer { try? FileManager.default.removeItem(at: url) }
            #expect(throws: (any Error).self) { try VertexRuntimeConfig.load(from: url) }
        }
    }

    @Test func runtimeStateFailsClosedWhenPresentButInvalid() throws {
        let missing = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        #expect(VertexRuntimeConfig.state(at: missing) == .notConfigured)
        try Data("{}".utf8).write(to: missing)
        defer { try? FileManager.default.removeItem(at: missing) }
        guard case .invalid = VertexRuntimeConfig.state(at: missing) else {
            Issue.record("present malformed config must not fall back to public Gemini")
            return
        }
    }

    @Test func requiredApplicationModeFailsClosedWhenConfigIsMissing() {
        let missing = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        guard case .invalid = VertexRuntimeConfig.state(at: missing, required: true) else {
            Issue.record("enterprise build must not expose public Gemini when config is absent")
            return
        }
    }
}

extension SharedStateTests {
    @Suite struct VertexModeSettingsTests {
        private let state = SharedStateGuard()

        @Test func vertexModeForcesVerbatimAndDisablesPublicOnlyFeatures() {
            let settings = SettingsStore()
            let policy = settings.effectiveFormattingPolicy(vertexConfigured: true)
            #expect(policy == .init(nativeSmart: false, cleanupPass: false))
            #expect(!settings.liveTranscriptionActive(vertexConfigured: true))
        }
    }
}

/// Serialized: the stub's handler is static, shared by every test here.
@Suite(.serialized) final class VertexBifrostClientTests {
    private final class StubProtocol: URLProtocol, @unchecked Sendable {
        static let lock = NSLock()
        nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?
        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
        override func startLoading() {
            do {
                let result = try Self.handler!(request)
                client?.urlProtocol(self, didReceive: result.0, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: result.1)
                client?.urlProtocolDidFinishLoading(self)
            } catch { client?.urlProtocol(self, didFailWithError: error) }
        }
        override func stopLoading() {}
    }

    private func config() throws -> VertexRuntimeConfig {
        try VertexRuntimeConfig(
            bifrostBaseURL: #require(URL(string: "http://127.0.0.1:8080")),
            bifrostKey: "dedicated-secret", project: "example-project", location: "global",
            model: "gemini-3.5-transcribe-preview"
        )
    }

    private func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: configuration)
    }

    deinit {
        StubProtocol.lock.lock(); StubProtocol.handler = nil; StubProtocol.lock.unlock()
    }

    private static func requestJSON(_ request: URLRequest) throws -> [String: Any] {
        let object: Any
        if let body = request.httpBody {
            object = try JSONSerialization.jsonObject(with: body)
        } else {
            // URLSession may expose the body as a stream to URLProtocol.
            let stream = try #require(request.httpBodyStream)
            stream.open()
            defer { stream.close() }
            object = try JSONSerialization.jsonObject(with: stream)
        }
        return try #require(object as? [String: Any])
    }

    @Test func readsRequestJSONFromDataOrStream() throws {
        let payload = String(repeating: "audio-fixture", count: 1_000)
        let data = try JSONSerialization.data(withJSONObject: ["audio": payload])
        var request = URLRequest(url: try #require(URL(string: "http://127.0.0.1:8080/fixture")))
        request.httpBody = data
        #expect(try Self.requestJSON(request)["audio"] as? String == payload)

        request.httpBody = nil
        request.httpBodyStream = InputStream(data: data)
        #expect(try Self.requestJSON(request)["audio"] as? String == payload)
    }

    @Test func sendsOnlyNativeVertexRequestAndParsesStrictResponse() async throws {
        let expectedAudio = Data("flac-audio".utf8)
        // The handler runs on URLSession's thread: capture what was sent and
        // check it here, in the test.
        let sent = LockedBox<(request: URLRequest, json: [String: Any])?>(nil)
        StubProtocol.handler = { request in
            let json = try Self.requestJSON(request)
            sent.mutate { $0 = (request, json) }
            let body = Data(#"{"modelVersion":"gemini-3.5-transcribe-preview","responseId":"req-1","candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"Fixture transcript."}]}}]}"#.utf8)
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, body)
        }
        let result = try await VertexBifrostClient(config: config(), session: session())
            .transcribe(flacData: expectedAudio, customVocabulary: ["Kubernetes Operator"], deadline: 5)
        #expect(result.text == "Fixture transcript.")
        #expect(result.model == "gemini-3.5-transcribe-preview")
        #expect(result.requestID == "req-1")

        let (request, json) = try #require(sent.current)
        #expect(request.url?.absoluteString == "http://127.0.0.1:8080/genai_passthrough/v1/projects/example-project/locations/global/publishers/google/models/gemini-3.5-transcribe-preview:generateContent")
        #expect(request.value(forHTTPHeaderField: "x-bf-vk") == "dedicated-secret")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(request.value(forHTTPHeaderField: "x-goog-api-key") == nil)
        let contents = try #require(json["contents"] as? [[String: Any]])
        let parts = try #require(contents.first?["parts"] as? [[String: Any]])
        let inline = try #require(parts.first?["inlineData"] as? [String: String])
        #expect(inline["mimeType"] == "audio/flac")
        #expect(inline["data"] == expectedAudio.base64EncodedString())
        let generation = try #require(json["generationConfig"] as? [String: Any])
        let audioConfig = try #require(generation["audioTranscriptionConfig"] as? [String: Any])
        #expect(audioConfig["wordTimestamp"] as? Bool == true)
        #expect(audioConfig["diarization"] as? Bool == false)
        #expect(audioConfig["customVocabulary"] as? [String] == ["Kubernetes Operator"])
        #expect(audioConfig["mode"] == nil)
    }

    @Test func rejectsWrongModelNonStopAndEmptyText() async throws {
        let fixtures = [
            #"{"modelVersion":"other","responseId":"r","candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"text"}]}}]}"#,
            #"{"modelVersion":"gemini-3.5-transcribe-preview","responseId":"r","candidates":[{"finishReason":"MAX_TOKENS","content":{"parts":[{"text":"text"}]}}]}"#,
            #"{"modelVersion":"gemini-3.5-transcribe-preview","responseId":"r","candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"  "}]}}]}"#
        ]
        for fixture in fixtures {
            StubProtocol.handler = { request in
                (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(fixture.utf8))
            }
            await #expect(throws: (any Error).self, "strict response validation should reject fixture") {
                _ = try await VertexBifrostClient(config: self.config(), session: self.session())
                    .transcribe(flacData: Data([1]), deadline: 5)
            }
        }
    }

    @Test func preservesRepeatedTextPartsButDoesNotDuplicateAlternativeTranscription() throws {
        let body = Data(#"{"modelVersion":"gemini-3.5-transcribe-preview","responseId":"r","candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"again","audioTranscription":{"text":"again"}},{"text":"again"}]}}]}"#.utf8)
        let parsed = try VertexBifrostClient.parse(body, expectedModel: "gemini-3.5-transcribe-preview")
        #expect(parsed.text == "again\nagain")
    }

    @Test func redirectDelegateRefusesRedirectSoKeyCannotFollow() async throws {
        let delegate = NoRedirectDelegate()
        let original = try #require(URL(string: "http://127.0.0.1:8080/start"))
        let destination = try #require(URL(string: "https://attacker.example/collect"))
        let task = URLSession.shared.dataTask(with: original)
        let response = try #require(HTTPURLResponse(url: original, statusCode: 302, httpVersion: nil,
                                                     headerFields: ["Location": destination.absoluteString]))
        let request = URLRequest(url: destination)
        await confirmation("redirect decision") { completed in
            delegate.urlSession(URLSession.shared, task: task, willPerformHTTPRedirection: response,
                                newRequest: request) { followedRequest in
                #expect(followedRequest == nil)
                completed()
            }
        }
    }
}
