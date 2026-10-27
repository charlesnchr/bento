// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import Foundation

/// The real socket.
///
/// The credential goes in the `x-goog-api-key` HEADER, never `?key=`. Every
/// published example for this endpoint uses the query form, and it does work —
/// but a TLS-terminating proxy logs the request line, query string included, so
/// `?key=` writes the user's long-lived API key into whatever keeps those logs.
/// The header form was verified against the live service by
/// `LiveWebSocketAuthProbeTests`: both arms return `setupComplete`, so there is
/// no reason to accept the worse one. This matches `GeminiClient`'s rule for
/// every other call the app makes.
public final class WebSocketTransport: LiveTransport, @unchecked Sendable {

    public static let endpoint =
        "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"

    private let apiKey: @Sendable () -> String
    private let session: URLSession
    private let endpointURL: URL
    private var task: URLSessionWebSocketTask?
    private let lock = NSLock()

    /// `requestTimeout` also bounds a quiet socket; a voice call outlives the dictation default.
    public init(apiKey: @escaping @Sendable () -> String, endpoint: URL = URL(string: WebSocketTransport.endpoint)!,
                requestTimeout: TimeInterval = 30) {
        self.apiKey = apiKey
        self.endpointURL = endpoint
        let config = URLSessionConfiguration.ephemeral
        // Fail fast rather than parking. `waitsForConnectivity` would leave an
        // offline dictation holding an unresolved connection for its whole
        // duration while the ring quietly fills and drops — the batch fallback
        // can only run once this admits defeat. Matches GeminiClient.
        config.waitsForConnectivity = false
        config.timeoutIntervalForRequest = requestTimeout
        self.session = URLSession(configuration: config, delegate: NoRedirectDelegate(), delegateQueue: nil)
    }

    public func connect() async throws {
        var request = URLRequest(url: endpointURL)
        request.setValue(apiKey(), forHTTPHeaderField: "x-goog-api-key")
        let task = session.webSocketTask(with: request)
        lock.lock(); self.task = task; lock.unlock()
        task.resume()
    }

    public func send(_ data: Data) async throws {
        lock.lock(); let task = self.task; lock.unlock()
        guard let task else { throw LiveError.setupTimedOut }
        try await task.send(.data(data))
    }

    public func receive() async throws -> Data {
        lock.lock(); let task = self.task; lock.unlock()
        guard let task else { throw LiveError.setupTimedOut }
        switch try await task.receive() {
        case .data(let data):
            return data
        case .string(let text):
            return Data(text.utf8)
        @unknown default:
            return Data()
        }
    }

    public func close() {
        lock.lock(); let task = self.task; self.task = nil; lock.unlock()
        task?.cancel(with: .goingAway, reason: nil)
    }

    /// How the socket ended, read after `receive` throws and before `close`: the
    /// status of a refused upgrade and the server's close frame. Nil when unknown.
    public var ending: LiveSocketEnding {
        lock.lock(); let task = self.task; lock.unlock()
        guard let task else { return LiveSocketEnding() }
        let status = (task.response as? HTTPURLResponse)?.statusCode
        let code = task.closeCode == .invalid ? nil : task.closeCode.rawValue
        return LiveSocketEnding(httpStatus: status == 101 ? nil : status, closeCode: code,
                                closeReason: task.closeReason.flatMap { String(data: $0, encoding: .utf8) })
    }
}

/// The parts of a socket's end a caller may act on. The reason is the server's own
/// text: match on it, never log or show it.
public struct LiveSocketEnding: Equatable, Sendable {
    public var httpStatus: Int?
    public var closeCode: Int?
    public var closeReason: String?

    public init(httpStatus: Int? = nil, closeCode: Int? = nil, closeReason: String? = nil) {
        self.httpStatus = httpStatus
        self.closeCode = closeCode
        self.closeReason = closeReason
    }
}
