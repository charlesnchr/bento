import AppKit
import VoiceCore
import Darwin

@MainActor
final class ACPClient {
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
    private var process: Process?
    private var input: FileHandle?
    private var output: FileHandle?
    private var reader: Task<Void, Never>?
    private var pipeReader: PipeLineReader?
    private var pending: [Int: CheckedContinuation<[String: Any], Error>] = [:]
    private var nextID = 0
    private var generation = UUID()
    private(set) var sessionID: String?
    private var replayID: String?
    private var replay: [[String: Any]] = []
    private var clock = AssistantSessionClock()
    private var setup: Task<Void, Error>?
    private(set) var launches = 0
    var onUpdate: (([String: Any]) -> Void)?
    // Session-level metadata for any session, including ones not yet bound to sessionID.
    var onSession: ((String, [String: Any]) -> Void)?
    var onRequest: ((String, [String: Any]) async -> [String: Any])?
    var onFreshSession: (() -> Void)?

    func prewarm() {
        guard setup == nil else { return }
        setup = Task { try await ensureSession() }
    }

    private func launch() throws {
        let python = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".hermes/hermes-agent/venv/bin/python")
        guard let script = VoiceResources.url("hermes-acp", "py") else {
            throw Failure(message: "The Hermes ACP launcher is missing from Bento.")
        }
        let child = Process()
        child.executableURL = python
        child.arguments = [script.path]
        let cwd = FileLayout.appSupportRoot.appendingPathComponent("Assistant", isDirectory: true)
        try FileManager.default.createDirectory(at: cwd, withIntermediateDirectories: true)
        child.currentDirectoryURL = cwd
        var environment = ProcessInfo.processInfo.environment
        environment["PYTHONUNBUFFERED"] = "1"
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        child.environment = environment
        let incoming = Pipe(), outgoing = Pipe()
        child.standardInput = incoming
        child.standardOutput = outgoing
        // Hermes redacts this stream. Do not put transcripts or screen content in a new log.
        child.standardError = FileHandle.nullDevice
        let lines = try PipeLineReader(outgoing.fileHandleForReading)
        do { try child.run() } catch { lines.cancel(); throw error }
        process = child
        launches += 1
        input = incoming.fileHandleForWriting
        output = outgoing.fileHandleForReading
        pipeReader = lines
        let token = generation
        reader = Task.detached { [weak self] in
            do {
                try await lines.readLines { [weak self] line in
                    await self?.receive(line, generation: token)
                }
            } catch { }
            await self?.disconnected(generation: token)
        }
    }

    private func ensureSession() async throws {
        if process == nil {
            // A prewarm cancelled before it got here (the Assistant was switched off) must not spawn Hermes.
            try Task.checkCancellation()
            try launch()
            _ = try await request("initialize", ["protocolVersion": 1, "clientCapabilities": [:],
                "clientInfo": ["name": "Bento", "version": "1"]])
        }
        let now = ProcessInfo.processInfo.systemUptime
        if sessionID == nil || clock.needsFreshSession(at: now) {
            let result = try await request("session/new", ["cwd": process!.currentDirectoryURL!.path, "mcpServers": []])
            guard let id = result["sessionId"] as? String else { throw Failure(message: "Hermes returned no session ID.") }
            sessionID = id
            clock.touch(at: ProcessInfo.processInfo.systemUptime)
            onFreshSession?()
        }
    }

    func prompt(_ text: String) async throws {
        _ = try await prompt(blocks: [["type": "text", "text": text]])
    }

    @discardableResult
    func prompt(blocks: [[String: Any]]) async throws -> [String: Any] {
        try await ready()
        try Task.checkCancellation()
        guard let sessionID else { throw Failure(message: "No Hermes session.") }
        clock.touch(at: ProcessInfo.processInfo.systemUptime)
        defer { clock.touch(at: ProcessInfo.processInfo.systemUptime) }
        let result = try await request("session/prompt", ["sessionId": sessionID, "prompt": blocks], timeout: 180)
        if result["stopReason"] as? String == "cancelled" { throw CancellationError() }
        return result
    }

    /// Asks Hermes to end the active turn; the pending prompt then returns `cancelled`.
    func cancel() {
        guard let sessionID else { return }
        try? send(["jsonrpc": "2.0", "method": "session/cancel", "params": ["sessionId": sessionID]])
    }

    /// The next prompt starts a new conversation in the running backend.
    func detach() {
        sessionID = nil
        clock.reset()
    }

    func adopt(_ id: String) {
        sessionID = id
        clock.touch(at: ProcessInfo.processInfo.systemUptime)
    }

    func fork(_ id: String) async throws -> String {
        try await ready()
        let result = try await request("session/fork", ["sessionId": id,
            "cwd": process!.currentDirectoryURL!.path, "mcpServers": []])
        guard let fork = result["sessionId"] as? String else { throw Failure(message: "Hermes returned no branch ID.") }
        return fork
    }

    /// Bento's launcher methods (`_bento/...`). Errors in the result become failures.
    func ext(_ method: String, _ params: [String: Any] = [:]) async throws -> [String: Any] {
        try await ready()
        let result = try await request("_bento/" + method, params)
        if let error = result["error"] as? String { throw Failure(message: error) }
        return result
    }

    func ready() async throws {
        if let setup {
            do { try await setup.value } catch { self.setup = nil; throw error }
            self.setup = nil
        }
        try await ensureSession()
    }

    func history() async throws -> [[String: Any]] {
        try await ready()
        var rows: [[String: Any]] = []
        var cursor: String?
        repeat {
            var params: [String: Any] = ["cwd": process!.currentDirectoryURL!.path]
            if let cursor { params["cursor"] = cursor }
            let page = try await request("session/list", params)
            rows += page["sessions"] as? [[String: Any]] ?? []
            cursor = page["nextCursor"] as? String
        } while cursor != nil && rows.count < 500
        return rows
    }

    func restore(_ id: String) async throws -> [[String: Any]] {
        try await ready()
        replayID = id
        replay = []
        defer { replayID = nil; replay = [] }
        _ = try await request("session/load", ["sessionId": id,
            "cwd": process!.currentDirectoryURL!.path, "mcpServers": []])
        sessionID = id
        clock.touch(at: ProcessInfo.processInfo.systemUptime)
        return replay
    }

    private func request(_ method: String, _ params: [String: Any], timeout: Double = 60) async throws -> [String: Any] {
        nextID += 1
        let id = nextID
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            do { try send(["jsonrpc": "2.0", "id": id, "method": method, "params": params]) }
            catch { pending.removeValue(forKey: id)?.resume(throwing: error); return }
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(timeout))
                guard let self, self.pending[id] != nil else { return }
                self.stop(reason: "Hermes timed out. The request was not retried.")
            }
        }
    }

    private func send(_ value: [String: Any]) throws {
        guard let input else { throw Failure(message: "Hermes is not connected.") }
        var data = try JSONSerialization.data(withJSONObject: value)
        data.append(10)
        guard fcntl(input.fileDescriptor, F_SETNOSIGPIPE, 1) != -1 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        try input.write(contentsOf: data)
    }

    private func receive(_ line: String, generation token: UUID) {
        guard token == generation, let data = line.data(using: .utf8),
              let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        if let method = message["method"] as? String {
            let params = message["params"] as? [String: Any] ?? [:]
            if let id = message["id"] {
                Task { [weak self] in
                    guard let self else { return }
                    let result = await self.onRequest?(method, params) ?? ["outcome": ["outcome": "cancelled"]]
                    guard self.generation == token else { return }
                    try? self.send(["jsonrpc": "2.0", "id": id, "result": result])
                }
            } else if method == "session/update", let update = params["update"] as? [String: Any] {
                if let id = params["sessionId"] as? String, Self.metadata.contains(update["sessionUpdate"] as? String ?? "") {
                    onSession?(id, update)
                } else if let replayID, params["sessionId"] as? String == replayID { replay.append(update) }
                else if params["sessionId"] as? String == sessionID { onUpdate?(update) }
            }
        } else if let id = message["id"] as? Int, let continuation = pending.removeValue(forKey: id) {
            if let error = message["error"] as? [String: Any] {
                continuation.resume(throwing: Failure(message: error["message"] as? String ?? "Hermes request failed."))
            } else { continuation.resume(returning: message["result"] as? [String: Any] ?? [:]) }
        }
    }

    private static let metadata: Set<String> = ["available_commands_update", "usage_update", "session_info_update",
                                                "current_mode_update", "config_option_update"]

    private func disconnected(generation token: UUID) {
        guard generation == token else { return }
        stop(reason: "Hermes disconnected. Try a new voice turn.")
    }

    func stop(reason: String = "Stopped. Any actions already completed were not undone.") {
        if let sessionID { try? send(["jsonrpc": "2.0", "method": "session/cancel", "params": ["sessionId": sessionID]]) }
        generation = UUID()
        setup?.cancel(); setup = nil
        reader?.cancel(); reader = nil
        pipeReader?.cancel(); pipeReader = nil
        let child = process; process = nil
        if let child, child.isRunning { child.terminate() }
        try? input?.close(); input = nil
        try? output?.close(); output = nil
        sessionID = nil
        clock.reset()
        let requests = pending.values
        pending.removeAll()
        for request in requests { request.resume(throwing: Failure(message: reason)) }
    }
}
