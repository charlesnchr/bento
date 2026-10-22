import Foundation
import Network
import SystemConfiguration
import AppKit
import BentoCore

/// Sync settings (`todo.sync` in config.json). Same server and token as Notes.
struct TodoSyncSettings: Codable, Equatable {
    var enabled = true
    var server = "https://bento.radian.dk"
    var tokenFile = TodoSyncSettings.defaultTokenFile

    static let liveHost = "bento.radian.dk"

    /// `~/.config/bento/sync-token`; an isolated instance (BENTO_HOME) looks inside its own
    /// home instead, so a test instance can never pick up the real token by default.
    static var defaultTokenFile: String {
        if let home = ProcessInfo.processInfo.environment["BENTO_HOME"], !home.isEmpty {
            return (home as NSString).appendingPathComponent("config/sync-token")
        }
        return "~/.config/bento/sync-token"
    }

    /// Isolated instances (BENTO_HOME) must not sync with the live server, which holds the
    /// user's real notes and tasks, unless BENTO_ALLOW_LIVE_SYNC=1.
    static func isBlocked(serverHost: String?, environment: [String: String] = ProcessInfo.processInfo.environment) -> Bool {
        guard let home = environment["BENTO_HOME"], !home.isEmpty, environment["BENTO_ALLOW_LIVE_SYNC"] != "1" else { return false }
        return serverHost?.lowercased() == liveHost
    }

    /// Largest body the server accepts (bytes of UTF-8), see server/src/store.rs.
    static let maxBodyBytes = 1024 * 1024
    /// Largest WebSocket message / request the server accepts.
    static let maxMessageBytes = 3 * 1024 * 1024
}

/// Observable sync status for the footer and settings.
final class TodoSyncStatus: ObservableObject {
    enum State: Equatable {
        case disabled
        case noToken
        case connecting
        case connected        // WebSocket live
        case polling          // REST fallback
        case offline(String)  // waiting to retry
        case unauthorized
    }

    @Published var state: State = .disabled
    @Published var pending = 0
    /// Notes the server can't take (too large); they stay local until edited.
    @Published var blocked = 0
    @Published var lastSync: Date?
    @Published var lastError: String?

    var summary: String {
        if blocked > 0, state == .connected || state == .polling {
            return "\(blocked) task\(blocked == 1 ? "" : "s") can't sync"
        }
        switch state {
        case .disabled: return "Sync off"
        case .noToken: return "No sync token"
        case .connecting: return "Connecting…"
        case .connected: return pending > 0 ? "Syncing \(pending) change\(pending == 1 ? "" : "s")…" : "Synced"
        case .polling: return pending > 0 ? "Syncing (polling)…" : "Synced (polling)"
        case .offline(let why): return pending > 0 ? "Offline · \(pending) change\(pending == 1 ? "" : "s") pending" : "Offline (\(why))"
        case .unauthorized: return "Token rejected"
        }
    }

    var symbol: String {
        switch state {
        case .disabled: return "icloud.slash"
        case .noToken, .unauthorized: return "exclamationmark.icloud"
        case .connecting: return "arrow.clockwise.icloud"
        case .connected, .polling:
            if blocked > 0 { return "exclamationmark.icloud" }
            return pending > 0 ? "arrow.clockwise.icloud" : "checkmark.icloud"
        case .offline: return "icloud.slash"
        }
    }

    var isHealthy: Bool { (state == .connected || state == .polling) && blocked == 0 }
}

/// Transport for the `todos` collection of the sync protocol: WebSocket push with reconnect/backoff,
/// REST polling only as a fallback when the WebSocket upgrade keeps failing.
/// Main thread only.
final class TodoSyncClient: NSObject, URLSessionWebSocketDelegate {
    private let engine: TodoSyncEngine
    let status = TodoSyncStatus()
    private let log = BentoLog.make("todo.sync")

    private var settings = TodoSyncSettings()
    private var token: String?
    private lazy var session: URLSession = URLSession(configuration: {
        let c = URLSessionConfiguration.default
        c.waitsForConnectivity = false
        c.timeoutIntervalForRequest = 20
        c.httpAdditionalHeaders = ["User-Agent": "Bento-Todo/1"]
        return c
    }(), delegate: self, delegateQueue: .main)

    private var task: URLSessionWebSocketTask?
    private var helloDone = false
    private var generation = 0
    private var retryWork: DispatchWorkItem?
    private var sendWork: DispatchWorkItem?
    private var pollTimer: Timer?
    private var wsRetryTimer: Timer?
    private var backoff: TimeInterval = 1
    private var wsFailures = 0
    private var running = false
    private var pathMonitor: NWPathMonitor?
    private var lastPathSatisfied = true
    private var pathInitialized = false
    private var wakeObserver: NSObjectProtocol?
    private var pingCheck: DispatchWorkItem?
    /// Last successful REST poll (polling fallback): puts go out right after one.
    private var lastPoll: Date?
    /// The server said it has collections (`/v1/health`). An older one would file tasks
    /// under notes, so nothing is sent until it does.
    private var collectionsOK = false

    let device: String = {
        // SCDynamicStore is instant; Host.current() can block on name resolution at launch
        var name = (SCDynamicStoreCopyComputerName(nil, nil) as String?) ?? ProcessInfo.processInfo.hostName
        if ProcessInfo.processInfo.environment["BENTO_DEV"] != nil, let home = ProcessInfo.processInfo.environment["BENTO_HOME"] {
            name += " (dev \((home as NSString).lastPathComponent))"
        }
        return name
    }()

    init(engine: TodoSyncEngine) {
        self.engine = engine
        super.init()
        engine.device = device
    }

    // MARK: Lifecycle

    func configure(_ s: TodoSyncSettings) {
        let changed = s != settings
        settings = s
        if !s.enabled {
            stop()
            status.state = .disabled
            return
        }
        if changed || !running { restart() }
    }

    func start() {
        guard settings.enabled else { status.state = .disabled; return }
        guard !running else { return }
        running = true
        startMonitors()
        connect()
    }

    func stop() {
        running = false
        generation += 1
        retryWork?.cancel(); retryWork = nil
        sendWork?.cancel(); sendWork = nil
        debounceStart = nil
        pingCheck?.cancel(); pingCheck = nil
        ackWatch?.cancel(); ackWatch = nil
        pollTimer?.invalidate(); pollTimer = nil
        wsRetryTimer?.invalidate(); wsRetryTimer = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        helloDone = false
        engine.reset()
        pathMonitor?.cancel(); pathMonitor = nil
        pathInitialized = false
        if let o = wakeObserver { NSWorkspace.shared.notificationCenter.removeObserver(o) }
        wakeObserver = nil
    }

    func restart() {
        stop()
        collectionsOK = false
        backoff = 1
        wsFailures = 0
        start()
    }

    /// "Sync Now": reconnect immediately (or poll once in fallback mode).
    func syncNow() {
        if status.state == .polling {
            poll()
            flushSoon(delay: 0)
            connect() // maybe the WebSocket works again
            return
        }
        if status.state == .connected, task != nil {
            verifyConnection()
            flushSoon(delay: 0)
            return
        }
        restart()
    }

    /// A local task changed: send it after a short debounce (at most 2 s after the
    /// first unsent change, so continuous typing streams instead of waiting for a pause).
    func localChange() {
        updatePending()
        scheduleFlush()
    }

    private var debounceStart: Date?

    private func scheduleFlush() {
        let now = Date()
        if debounceStart == nil { debounceStart = now }
        let elapsed = now.timeIntervalSince(debounceStart ?? now)
        flushSoon(delay: min(0.4, max(0, 2 - elapsed)))
    }

    // MARK: Connection

    private var baseURL: URL? {
        var s = settings.server.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        if !s.contains("://") { s = "https://" + s }
        return URL(string: s)
    }

    private func loadToken() -> String? {
        let path = (settings.tokenFile as NSString).expandingTildeInPath
        guard let raw = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    private func connect() {
        guard running else { return }
        retryWork?.cancel()
        // never keep two sockets: drop an attempt that is still in flight
        if let old = task {
            task = nil
            old.cancel(with: .goingAway, reason: nil)
            engine.reset()
        }
        token = loadToken()
        guard let token else {
            status.state = .noToken
            scheduleRetry(maxDelay: 60, reason: "no token")
            return
        }
        guard let base = baseURL, var comps = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            status.state = .offline("bad server URL")
            return
        }
        if TodoSyncSettings.isBlocked(serverHost: comps.host) {
            log.error("Isolated instance (BENTO_HOME): not syncing with the live server")
            status.state = .offline("live server blocked in isolated instance")
            return
        }
        guard collectionsOK else { verifyCollections(); return }
        comps.scheme = comps.scheme == "http" ? "ws" : "wss"
        comps.path = (comps.path.isEmpty ? "" : comps.path) + "/v1/sync"
        guard let url = comps.url else { return }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 20
        if status.state != .polling { status.state = .connecting }
        generation += 1
        helloDone = false
        let t = session.webSocketTask(with: req)
        // The hello snapshot carries every changed task in one message.
        t.maximumMessageSize = 256 * 1024 * 1024
        task = t
        t.resume()
        receive(on: t, gen: generation)
        send(["type": "hello", "since": engine.repo.lastSeq, "device": device, "collections": [TodoWire.collection]])
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard webSocketTask === task else { return }
        log.info("WebSocket open")
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard webSocketTask === task else { return }
        log.info("WebSocket closed: \(closeCode.rawValue)")
        connectionLost(error: "closed (\(closeCode.rawValue))", wasUpgradeFailure: false)
    }

    private func receive(on t: URLSessionWebSocketTask, gen: Int) {
        t.receive { [weak self] result in
            guard let self, gen == self.generation, t === self.task else { return }
            switch result {
            case .success(let msg):
                switch msg {
                case .string(let s): self.handle(text: s)
                case .data(let d): self.handle(text: String(decoding: d, as: UTF8.self))
                @unknown default: break
                }
                self.receive(on: t, gen: gen)
            case .failure(let err):
                let http = (t.response as? HTTPURLResponse)?.statusCode
                if http == 401 {
                    self.unauthorized()
                    return
                }
                self.connectionLost(error: err.localizedDescription, wasUpgradeFailure: !self.helloDone)
            }
        }
    }

    private func handle(text: String) {
        lastReceive = Date()
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else { return }
        switch type {
        case "snapshot":
            let notes = (obj["notes"] as? [Any] ?? []).compactMap(TodoWire.decode)
            let seq = (obj["seq"] as? NSNumber)?.int64Value ?? 0
            if engine.applySnapshot(notes, seq: seq) {
                log.info("Server seq went backwards (\(seq)); resyncing from 0")
                task?.cancel(with: .normalClosure, reason: nil)
                connect()
                return
            }
            helloDone = true
            engine.clearFailed() // refused puts get another try on every connection
            backoff = 1
            wsFailures = 0
            pollTimer?.invalidate(); pollTimer = nil
            wsRetryTimer?.invalidate(); wsRetryTimer = nil
            status.state = .connected
            status.lastError = nil
            markSynced()
            flushSoon(delay: 0)
        case "ack":
            guard let id = obj["id"] as? String else { return }
            let accepted = obj["accepted"] as? Bool ?? false
            engine.ack(id: id, seq: (obj["seq"] as? NSNumber)?.int64Value, accepted: accepted, ordered: true)
            markSynced()
        case "note":
            if let n = TodoWire.decode(obj["note"]) {
                engine.applyRemote(n)
                markSynced()
            }
        case "pong":
            pingCheck?.cancel(); pingCheck = nil
        case "error":
            let msg = obj["message"] as? String ?? "error"
            log.error("Sync server error: \(msg, privacy: .public)")
            status.lastError = msg
            if let id = obj["id"] as? String { engine.putFailed(id: id) }
        default:
            break
        }
        if !engine.hasInflight { ackWatch?.cancel(); ackWatch = nil }
        // edits made while puts were in flight, merges to resend after a rejection: all go out with the normal debounce
        if helloDone, sendWork == nil, !engine.docsToSend().isEmpty { scheduleFlush() }
        updatePending()
    }

    /// Sends one message; false when it couldn't even be encoded/queued.
    @discardableResult
    private func send(_ obj: [String: Any]) -> Bool {
        guard let t = task, let data = try? JSONSerialization.data(withJSONObject: obj),
              let s = String(data: data, encoding: .utf8) else { return false }
        let gen = generation
        t.send(.string(s)) { [weak self] err in
            guard let err, let self else { return }
            DispatchQueue.main.async {
                guard gen == self.generation else { return }
                self.log.error("WebSocket send failed: \(err.localizedDescription, privacy: .public)")
            }
        }
        return true
    }

    /// A put whose ack doesn't come back means the socket is dead even if the OS hasn't
    /// noticed yet (server gone without a FIN, network switched): reconnect and resend.
    private var ackWatch: DispatchWorkItem?
    private var lastReceive = Date()

    private func watchAcks() {
        guard ackWatch == nil, let t = task else { return }
        let w = DispatchWorkItem { [weak self] in
            guard let self, t === self.task else { return }
            self.ackWatch = nil
            guard self.engine.hasInflight else { return }
            if Date().timeIntervalSince(self.lastReceive) >= 20 {
                self.log.info("No ack for 20 s; reconnecting")
                self.connectionLost(error: "timeout", wasUpgradeFailure: false)
            } else {
                self.watchAcks() // traffic is flowing (big snapshot, many acks): keep watching
            }
        }
        ackWatch = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: w)
    }

    private func connectionLost(error: String, wasUpgradeFailure: Bool) {
        guard running else { return }
        collectionsOK = false // the server may have been replaced (e.g. rolled back): check again
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        helloDone = false
        engine.reset()
        status.lastError = error
        let gen = generation
        guard wasUpgradeFailure else {
            status.state = .offline(shortReason(error))
            scheduleRetry(maxDelay: 60, reason: error)
            return
        }
        // Only a WebSocket-specific failure (REST reachable) counts towards the polling
        // fallback; a server that is simply down keeps the normal reconnect backoff.
        checkHealth { [weak self] reachable in
            guard let self, self.running, gen == self.generation, self.task == nil else { return }
            if reachable { self.wsFailures += 1 }
            if self.wsFailures >= 3 {
                self.enterPollingFallback()
            } else {
                if self.status.state != .polling { self.status.state = .offline(self.shortReason(error)) }
                self.scheduleRetry(maxDelay: 60, reason: error)
            }
        }
    }

    private func verifyCollections() {
        guard let base = baseURL, let url = URL(string: base.absoluteString + "/v1/health") else { return }
        if status.state != .polling { status.state = .connecting }
        var req = URLRequest(url: url)
        req.timeoutInterval = 10
        let gen = generation
        session.dataTask(with: req) { [weak self] data, resp, err in
            let obj = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let reachable = (resp as? HTTPURLResponse)?.statusCode == 200 && obj?["ok"] != nil
            let supported = obj?["collections"] as? Bool == true
            DispatchQueue.main.async {
                guard let self, self.running, gen == self.generation, self.task == nil else { return }
                if supported {
                    self.collectionsOK = true
                    self.connect()
                } else if reachable {
                    self.log.error("Sync server has no collections; not syncing tasks")
                    self.status.state = .offline("server needs an update")
                    self.status.lastError = "The sync server is too old for tasks (no collections); update bento-sync"
                    self.scheduleRetry(maxDelay: 300, reason: "server lacks collections", minDelay: 120)
                } else {
                    self.status.state = .offline(self.shortReason(err?.localizedDescription ?? "unreachable"))
                    self.status.lastError = err?.localizedDescription
                    self.scheduleRetry(maxDelay: 60, reason: err?.localizedDescription ?? "health failed")
                }
            }
        }.resume()
    }

    private func checkHealth(_ done: @escaping (Bool) -> Void) {
        guard let base = baseURL, let url = URL(string: base.absoluteString + "/v1/health") else { done(false); return }
        var req = URLRequest(url: url)
        req.timeoutInterval = 8
        session.dataTask(with: req) { data, resp, _ in
            let ok = (resp as? HTTPURLResponse)?.statusCode == 200 && data.map { String(decoding: $0, as: UTF8.self).contains("\"ok\"") } == true
            DispatchQueue.main.async { done(ok) }
        }.resume()
    }

    private func unauthorized() {
        collectionsOK = false
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        helloDone = false
        engine.reset()
        // The token may have been rotated: re-read the file and retry (slowly).
        let fresh = loadToken()
        if fresh != nil, fresh != token {
            token = fresh
            backoff = 1
            scheduleRetry(maxDelay: 1, reason: "token changed")
            return
        }
        status.state = .unauthorized
        status.lastError = "401 Unauthorized"
        scheduleRetry(maxDelay: 60, reason: "unauthorized", minDelay: 30)
    }

    private func scheduleRetry(maxDelay: TimeInterval, reason: String, minDelay: TimeInterval = 0) {
        retryWork?.cancel()
        let delay = max(minDelay, min(backoff, maxDelay)) * Double.random(in: 0.85...1.15)
        backoff = min(backoff * 2, 60)
        let w = DispatchWorkItem { [weak self] in self?.connect() }
        retryWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: w)
        log.info("Sync retry in \(delay, format: .fixed(precision: 1))s (\(reason, privacy: .public))")
    }

    private func shortReason(_ s: String) -> String {
        if s.lowercased().contains("offline") || s.lowercased().contains("not connected") { return "no network" }
        if s.count > 40 { return String(s.prefix(40)) + "…" }
        return s
    }

    /// After a wake or network change: make sure the socket is alive.
    private func verifyConnection() {
        guard let t = task, helloDone else { return }
        pingCheck?.cancel()
        let w = DispatchWorkItem { [weak self] in
            guard let self, t === self.task else { return }
            self.log.info("No pong; reconnecting")
            self.connectionLost(error: "timeout", wasUpgradeFailure: false)
        }
        pingCheck = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: w)
        send(["type": "ping"])
    }

    // MARK: Outgoing

    private func flushSoon(delay: TimeInterval) {
        sendWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.flush() }
        sendWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: w)
    }

    private func flush() {
        sendWork = nil
        debounceStart = nil
        let notes = engine.docsToSend().filter(sendable)
        guard !notes.isEmpty else { updatePending(); return }
        if status.state == .connected, task != nil, helloDone {
            for n in notes {
                if send(["type": "put", "note": TodoWire.encode(n, device: device)]) {
                    engine.markSent(n)
                } else {
                    engine.markUnsendable(n)
                    status.lastError = "“\(TodoSyncClient.label(n))” could not be encoded for sync"
                }
            }
            watchAcks()
        } else if status.state == .polling {
            // Fetch first so a REST put never overwrites a change we haven't seen yet.
            if let t = lastPoll, Date().timeIntervalSince(t) < 2 {
                for n in notes { restPut(n) }
            } else {
                poll()
            }
        }
        updatePending()
    }

    /// Notes over the server's limits would be refused (or drop the socket) on every
    /// reconnect: keep them local and say so instead of sending them.
    private func sendable(_ n: TodoDoc) -> Bool {
        let bytes = n.deleted ? 0 : n.body.utf8.count
        // JSON escaping can grow the body; leave room under the server's message cap.
        let fits = bytes <= TodoSyncSettings.maxBodyBytes
            && (bytes * 2 < TodoSyncSettings.maxMessageBytes - 64 * 1024 || encodedSize(n) < TodoSyncSettings.maxMessageBytes - 16 * 1024)
        if !fits {
            engine.markUnsendable(n)
            let mb = String(format: "%.1f", Double(bytes) / 1_048_576)
            status.lastError = "“\(TodoSyncClient.label(n))” is too large to sync (\(mb) MB, max 1 MB); it stays on this Mac"
            log.error("Task \(n.id, privacy: .public) too large to sync (\(bytes) bytes)")
        }
        return fits
    }

    private func encodedSize(_ n: TodoDoc) -> Int {
        (try? JSONSerialization.data(withJSONObject: ["type": "put", "note": TodoWire.encode(n, device: device)]))?.count ?? Int.max
    }

    private func updatePending() {
        let p = engine.pendingCount
        if status.pending != p { status.pending = p }
        let b = engine.blockedCount
        if status.blocked != b { status.blocked = b }
    }

    static func label(_ d: TodoDoc) -> String {
        let t = d.isProject ? d.name : d.title
        return t.isEmpty ? "Untitled" : String(t.prefix(40))
    }

    private func markSynced() {
        status.lastSync = Date()
    }

    // MARK: REST fallback

    private func enterPollingFallback() {
        log.info("WebSocket keeps failing; falling back to REST polling")
        status.state = .polling
        retryWork?.cancel()
        pollTimer?.invalidate()
        let t = Timer(timeInterval: 10, repeats: true) { [weak self] _ in self?.poll() }
        t.tolerance = 2
        RunLoop.main.add(t, forMode: .common)
        pollTimer = t
        poll()
        // try the WebSocket again now and then
        wsRetryTimer?.invalidate()
        let r = Timer(timeInterval: 300, repeats: true) { [weak self] _ in
            guard let self, self.status.state == .polling else { return }
            self.wsFailures = 2 // one more failure goes straight back to polling
            self.connect()
        }
        r.tolerance = 30
        RunLoop.main.add(r, forMode: .common)
        wsRetryTimer = r
    }

    private func request(_ path: String, method: String = "GET", body: Data? = nil) -> URLRequest? {
        guard let base = baseURL, let url = URL(string: base.absoluteString + path), let token else { return nil }
        var r = URLRequest(url: url)
        r.httpMethod = method
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            r.httpBody = body
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return r
    }

    private func poll() {
        guard var req = request("/v1/c/\(TodoWire.collection)?since=\(engine.repo.lastSeq)") else { return }
        req.timeoutInterval = 15
        session.dataTask(with: req) { [weak self] data, resp, err in
            DispatchQueue.main.async {
                guard let self, self.status.state == .polling else { return }
                if (resp as? HTTPURLResponse)?.statusCode == 401 { self.status.lastError = "401 Unauthorized"; return }
                guard err == nil, let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    self.status.lastError = err?.localizedDescription ?? "bad response"
                    return
                }
                let notes = (obj["docs"] as? [Any] ?? []).compactMap(TodoWire.decode)
                let seq = (obj["seq"] as? NSNumber)?.int64Value ?? 0
                if self.engine.applySnapshot(notes, seq: seq) {
                    self.poll() // resync from 0
                    return
                }
                self.lastPoll = Date()
                self.status.lastError = nil
                self.markSynced()
                self.flushSoon(delay: 0)
            }
        }.resume()
    }

    private func restPut(_ n: TodoDoc) {
        guard let body = try? JSONSerialization.data(withJSONObject: TodoWire.encode(n, device: device)),
              let id = n.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let req = request("/v1/c/\(TodoWire.collection)/\(id)", method: "PUT", body: body) else { return }
        engine.markSent(n)
        session.dataTask(with: req) { [weak self] data, resp, err in
            DispatchQueue.main.async {
                guard let self else { return }
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                guard err == nil, let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    self.engine.reset()
                    return
                }
                if code == 413 || code == 400 || code == 409 {
                    self.engine.putFailed(id: n.id, version: n.updatedAt)
                    self.status.lastError = obj["error"] as? String
                    self.updatePending()
                    return
                }
                guard code == 200 else { self.engine.reset(); self.status.lastError = obj["error"] as? String ?? "HTTP \(code)"; return }
                let stored = TodoWire.decode(obj["doc"])
                let accepted = obj["accepted"] as? Bool ?? false
                self.engine.ack(id: n.id, seq: accepted ? stored?.seq : nil, accepted: accepted, version: n.updatedAt)
                if !accepted, let stored { self.engine.applyRemote(stored, advanceCursor: false) }
                self.markSynced()
                self.updatePending()
            }
        }.resume()
    }

    // MARK: Network / wake monitoring (event driven, no polling)

    private func startMonitors() {
        if pathMonitor == nil {
            let m = NWPathMonitor()
            m.pathUpdateHandler = { [weak self] path in
                DispatchQueue.main.async { self?.pathChanged(path.status == .satisfied) }
            }
            m.start(queue: .global(qos: .utility))
            pathMonitor = m
        }
        if wakeObserver == nil {
            wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
                self?.verifyConnection()
                if case .offline = self?.status.state { self?.backoff = 1; self?.connect() }
            }
        }
    }

    private func pathChanged(_ satisfied: Bool) {
        // The monitor reports the current path once right after starting; ignore that.
        guard pathInitialized else { pathInitialized = true; lastPathSatisfied = satisfied; return }
        lastPathSatisfied = satisfied
        guard running, satisfied else { return }
        switch status.state {
        case .offline:
            backoff = 1
            connect()
        case .connected:
            verifyConnection() // interface changed (Wi-Fi switch, VPN): make sure the socket survived
        default:
            break
        }
    }
}
