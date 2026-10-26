// Copyright 2026 Google LLC
import BentoCore
import Foundation
import os

public struct VertexRuntimeConfig: Codable, Equatable, Sendable {
    public var transport: String? = nil
    public var isDirect: Bool { transport == "direct" }
    public var liveEndpoint: URL { socketURL("live") }
    /// The helper's Gemini Live voice call route.
    public var conversationEndpoint: URL { socketURL("conversation") }
    private func socketURL(_ path: String) -> URL {
        var components = URLComponents(url: bifrostBaseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        return components.url!
    }
    public let bifrostBaseURL: URL
    public let bifrostKey: String
    public let project: String
    public let location: String
    public let model: String
    /// Text-only cleanup models the helper relays to another provider (a local
    /// gateway, Azure), offered beside the built-in Gemini ones.
    public var relayedCleanupModels: [CleanupModel] = []
    /// The cleanup model when the user hasn't picked one.
    public var defaultCleanupModel: String? = nil

    enum CodingKeys: String, CodingKey {
        case bifrostBaseURL = "bifrost_base_url"
        case bifrostKey = "bifrost_key"
        case project, location, model
        case transport
        case relayedCleanupModels = "relayed_cleanup_models"
        case defaultCleanupModel = "default_cleanup_model"
    }

    public enum State: Equatable, Sendable {
        case notConfigured
        case configured(VertexRuntimeConfig)
        case invalid(String)

        public var isRequested: Bool {
            if case .notConfigured = self { return false }
            return true
        }

        public var config: VertexRuntimeConfig? {
            if case .configured(let config) = self { return config }
            return nil
        }
    }

    public enum ConfigError: Error, Equatable, Sendable, CustomStringConvertible {
        case unreadable
        case malformed
        case missing(String)
        case nonLoopbackGateway

        public var description: String {
            switch self {
            case .unreadable: return "runtime config could not be read"
            case .malformed: return "runtime config is malformed"
            case .missing(let field): return "runtime config is missing \(field)"
            case .nonLoopbackGateway: return "Bifrost gateway must be a loopback URL"
            }
        }
    }

    /// `~/.config/bento/voice-runtime.json`, next to Bento's config.json but
    /// private to this Mac (it holds the helper's key): never link it into dotfiles.
    public static var defaultURL: URL {
        if let path = ProcessInfo.processInfo.environment["BENTO_VOICE_RUNTIME"] {
            return URL(fileURLWithPath: path)
        }
        return AppPaths.configDir.appendingPathComponent("voice-runtime.json")
    }

    public init(bifrostBaseURL: URL, bifrostKey: String, project: String, location: String, model: String) throws {
        guard Self.isLoopbackGateway(bifrostBaseURL) else { throw ConfigError.nonLoopbackGateway }
        let values = ["bifrost_key": bifrostKey, "project": project, "location": location, "model": model]
        for (name, value) in values where value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw ConfigError.missing(name)
        }
        self.bifrostBaseURL = bifrostBaseURL
        self.bifrostKey = bifrostKey.trimmingCharacters(in: .whitespacesAndNewlines)
        self.project = project.trimmingCharacters(in: .whitespacesAndNewlines)
        self.location = location.trimmingCharacters(in: .whitespacesAndNewlines)
        self.model = model.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public static func load(from url: URL = defaultURL) throws -> VertexRuntimeConfig {
        let data: Data
        do { data = try Data(contentsOf: url) } catch { throw ConfigError.unreadable }
        struct Raw: Decodable {
            let bifrost_base_url: String?
            let bifrost_key: String?
            let project: String?
            let location: String?
            let model: String?
            let transport: String?
            let relayed_cleanup_models: [Lenient<CleanupModel>]?
            let default_cleanup_model: String?
        }
        /// A malformed optional entry is skipped, not a reason to drop the runtime.
        struct Lenient<T: Decodable>: Decodable {
            let value: T?
            init(from decoder: Decoder) throws { value = try? T(from: decoder) }
        }
        guard let raw = try? JSONDecoder().decode(Raw.self, from: data) else { throw ConfigError.malformed }
        func required(_ value: String?, _ name: String) throws -> String {
            guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw ConfigError.missing(name)
            }
            return value
        }
        let base = try required(raw.bifrost_base_url, "bifrost_base_url")
        guard let url = URL(string: base) else { throw ConfigError.malformed }
        var config = try VertexRuntimeConfig(
            bifrostBaseURL: url,
            bifrostKey: required(raw.bifrost_key, "bifrost_key"),
            project: required(raw.project, "project"),
            location: required(raw.location, "location"),
            model: required(raw.model, "model")
        )
        guard raw.transport == nil || raw.transport == "direct" else { throw ConfigError.malformed }
        config.transport = raw.transport
        config.relayedCleanupModels = raw.relayed_cleanup_models?.compactMap(\.value) ?? []
        config.defaultCleanupModel = raw.default_cleanup_model
        return config
    }

    /// Bento runs with or without the helper: no runtime file means the
    /// Gemini API with the user's own key.
    public static var isRequiredByApplication: Bool { false }

    public static func state(at url: URL = defaultURL, required: Bool? = nil) -> State {
        guard FileManager.default.fileExists(atPath: url.path) else {
            return (required ?? isRequiredByApplication)
                ? .invalid("required runtime config is missing")
                : .notConfigured
        }
        do { return .configured(try load(from: url)) }
        catch { return .invalid(String(describing: error)) }
    }

    private static func isLoopbackGateway(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = url.host?.lowercased(), url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil else { return false }
        if host == "localhost" || host == "::1" { return true }
        let octets = host.split(separator: ".")
        return octets.count == 4 && octets.first == "127" && octets.allSatisfy { UInt8($0) != nil }
    }

    public var endpoint: URL {
        var url = bifrostBaseURL
        for component in ["genai_passthrough", "v1", "projects", project, "locations", location,
                          "publishers", "google", "models", "\(model):generateContent"] {
            url.appendPathComponent(component)
        }
        return url
    }
}

public struct VertexTranscriptionResponse: Equatable, Sendable {
    public let text: String
    public let model: String
    public let requestID: String?
    public let latencyMilliseconds: Double
}

final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

public actor VertexBifrostClient {
    private let config: VertexRuntimeConfig
    private let session: URLSession

    public init(config: VertexRuntimeConfig) {
        let sessionConfig = URLSessionConfiguration.ephemeral
        sessionConfig.waitsForConnectivity = false
        sessionConfig.timeoutIntervalForResource = 600
        sessionConfig.httpShouldSetCookies = false
        sessionConfig.httpCookieStorage = nil
        self.config = config
        self.session = URLSession(configuration: sessionConfig, delegate: NoRedirectDelegate(), delegateQueue: nil)
    }

    init(config: VertexRuntimeConfig, session: URLSession) {
        self.config = config
        self.session = session
    }

    public func transcribe(flacData: Data, customVocabulary: [String] = [], deadline: TimeInterval) async throws -> VertexTranscriptionResponse {
        var audioConfig: [String: Any] = ["wordTimestamp": true, "diarization": false]
        if !customVocabulary.isEmpty { audioConfig["customVocabulary"] = customVocabulary }
        let body: [String: Any] = [
            "contents": [["role": "user", "parts": [["inlineData": [
                "mimeType": "audio/flac", "data": flacData.base64EncodedString()
            ]]]]],
            "generationConfig": ["audioTranscriptionConfig": audioConfig]
        ]
        var request = URLRequest(url: config.endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = deadline
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(config.bifrostKey, forHTTPHeaderField: "x-bf-vk")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let started = ContinuousClock.now
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await GeminiClient.withDeadline(seconds: deadline) { [session, request] in
                try await session.data(for: request)
            }
        } catch is GeminiClient.DeadlineExceeded {
            throw TranscriptionError.timeout
        } catch let error as URLError {
            switch error.code {
            case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff:
                throw TranscriptionError.offline
            case .timedOut: throw TranscriptionError.timeout
            default: throw TranscriptionError.network("gateway_unreachable")
            }
        }
        guard let http = response as? HTTPURLResponse, http.url == config.endpoint else {
            throw TranscriptionError.network("redirect_or_non_http_response")
        }
        switch http.statusCode {
        case 200: break
        case 401, 403: throw TranscriptionError.auth
        case 404: throw TranscriptionError.modelUnavailable(model: config.model, detail: nil)
        case 429: throw TranscriptionError.rateLimitedTransient
        case 400: throw TranscriptionError.badRequest("vertex_request_rejected")
        case 500...599: throw TranscriptionError.network("gateway_http_\(http.statusCode)")
        default: throw TranscriptionError.network("gateway_http_\(http.statusCode)")
        }

        let parsed = try Self.parse(data, expectedModel: config.model)
        let latency = Double(started.duration(to: .now).components.attoseconds) / 1e15
            + Double(started.duration(to: .now).components.seconds) * 1000
        Log.transcription.info("Vertex transcription request_id=\(parsed.requestID ?? "missing", privacy: .public) model=\(parsed.model, privacy: .public) latency_ms=\(latency, format: .fixed(precision: 1))")
        return VertexTranscriptionResponse(text: parsed.text, model: parsed.model,
                                           requestID: parsed.requestID, latencyMilliseconds: latency)
    }

    static func parse(_ data: Data, expectedModel: String) throws -> (text: String, model: String, requestID: String?) {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let model = root["modelVersion"] as? String, model == expectedModel,
              let candidates = root["candidates"] as? [[String: Any]], !candidates.isEmpty,
              candidates.allSatisfy({ ($0["finishReason"] as? String) == "STOP" }) else {
            throw TranscriptionError.network("invalid_vertex_response")
        }
        var texts: [String] = []
        for candidate in candidates {
            let parts = (candidate["content"] as? [String: Any])?["parts"] as? [[String: Any]] ?? []
            for part in parts {
                // The two fields are alternate renderings of one part. Prefer its
                // direct text, but preserve repeated words across distinct parts.
                let direct = (part["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                let camel = ((part["audioTranscription"] as? [String: Any])?["text"] as? String)?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                let snake = ((part["audio_transcription"] as? [String: Any])?["text"] as? String)?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if let value = [direct, camel, snake].compactMap({ $0 }).first(where: { !$0.isEmpty }) {
                    texts.append(value)
                }
            }
        }
        guard !texts.isEmpty else { throw TranscriptionError.emptyTranscript }
        return (texts.joined(separator: "\n"), model, root["responseId"] as? String)
    }
}

public struct VertexTranscriptionService: TranscriptionServicing {
    private let client: VertexBifrostClient

    public init(config: VertexRuntimeConfig) { self.client = VertexBifrostClient(config: config) }
    init(client: VertexBifrostClient) { self.client = client }

    public func transcribeFLAC(data: Data, durationSeconds: Double, customVocabulary: [String] = []) async throws -> VertexTranscriptionResponse {
        try await client.transcribe(flacData: data, customVocabulary: customVocabulary,
                                    deadline: TimeoutPolicy.overallDeadline(audioDuration: durationSeconds))
    }

    public func transcribe(audioURL: URL, durationSeconds: Double, context: DictationContext) async throws -> TranscriptionResult {
        let flacURL = audioURL.deletingLastPathComponent().appendingPathComponent("audio.flac")
        let encoded = try FLACEncoder.encode(cafURL: audioURL, flacURL: flacURL)
        let data = try Data(contentsOf: encoded.url)
        try? FileManager.default.removeItem(at: encoded.url)
        let response = try await transcribeFLAC(data: data, durationSeconds: durationSeconds,
                                                customVocabulary: DictionaryStore().sanitizedVocabulary())
        let text = ReplacementEngine.apply(DictionaryStore().replacementRules(), to: response.text)
        return TranscriptionResult(rawTranscript: response.text, cleanedTranscript: text,
                                   modelID: "\(response.model)/verbatim")
    }
}

public struct UnavailableTranscriptionService: TranscriptionServicing {
    private let reason: String
    public init(reason: String) { self.reason = reason }
    public func transcribe(audioURL: URL, durationSeconds: Double, context: DictationContext) async throws -> TranscriptionResult {
        throw TranscriptionError.badRequest(reason)
    }
}
