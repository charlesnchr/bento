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

/// Records a meeting: capture, the relay of Live sessions, and the hand-off of
/// everything they produce to a `MeetingProcessor`.
///
/// Independent of `DictationCoordinator` by design. It has its own capture
/// engine and its own sockets, so dictation and the assistant keep working
/// while a meeting records; the only coupling is `setMicMuted`, which keeps a
/// dictation out of the meeting's notes.
///
/// Never-lose-words carries over: audio is on disk before any socket sees it,
/// and every span a Live session did not finish cleanly — a dropped connection,
/// a stalled socket, a crash — is re-transcribed from that audio by the batch
/// path. Live only decides how soon the words appear.
@MainActor
public final class MeetingRecorder: ObservableObject {
    public enum Phase: Equatable, Sendable {
        case idle
        case recording
        case paused
    }

    public enum Connection: Equatable, Sendable {
        case connecting
        case live
        /// Live dropped; audio is being kept and the socket is being reopened.
        case reconnecting
        /// No Live transport is configured: the meeting is transcribed from the
        /// recording a few minutes at a time.
        case unavailable
    }

    public struct Timing: Sendable {
        /// Start looking for a pause to rotate the Live session in…
        public var softRotation: TimeInterval = 480
        /// …and rotate regardless here: the API caps a session at 10 minutes and
        /// the local helper at 590 seconds.
        public var hardRotation: TimeInterval = 555
        /// How long the server must have reported silence before a rotation.
        public var quietBeforeRotation: TimeInterval = 0.6
        /// With no session attached, cut the span for batch this often, so the
        /// notes keep up even when Live is down for a long stretch.
        public var bufferedChunkLimit: TimeInterval = 180
        public var reconnectBackoff: [TimeInterval] = [2, 5, 10, 20, 30, 60]

        public init() {}
    }

    @Published public private(set) var phase: Phase = .idle
    @Published public private(set) var connection: Connection = .unavailable
    @Published public private(set) var level: Float = 0
    /// The newest words heard, final or not, for the widget. Display only.
    @Published public private(set) var latestLine: String = ""
    /// The utterance in progress, cleared when its final lands. Display only.
    @Published public private(set) var interim: String = ""
    @Published public private(set) var elapsed: TimeInterval = 0
    @Published public private(set) var micMuted = false
    @Published public private(set) var systemAudioActive = false
    @Published public private(set) var processor: MeetingProcessor?

    /// Something worth telling the user (the mic dropped, the meeting paused).
    public var onNotice: ((String) -> Void)?

    private let services: MeetingServices
    private let makeAudioSource: @MainActor () -> MeetingAudioSource
    private let makeLiveSession: (@MainActor () -> MeetingLiveSession?)?
    private let timing: Timing

    /// One attached Live session and what it has said about the audio.
    private final class LiveLink {
        let session: MeetingLiveSession
        let chunk: Int
        /// Meeting seconds at the chunk's first frame — the server's offsets are
        /// relative to the audio this session received.
        let chunkStart: Double
        let startedAt = Date()
        var speechActive = false
        var quietSince: Date? = Date()
        var lastActivityStart: Double = 0
        var failed = false
        var events: Task<Void, Never>?

        init(session: MeetingLiveSession, chunk: Int, chunkStart: Double) {
            self.session = session
            self.chunk = chunk
            self.chunkStart = chunkStart
        }
    }

    private let mute = MeetingMuteSwitch()
    private var router = MeetingStreamRouter()
    private var audio: MeetingAudioSource?
    private var partIndex = 0
    /// True between a part's successful start and its end, so a part is never
    /// ended twice (a pause racing a mic restart would count its time twice).
    private var partOpen = false
    private var partStartedAt: Date?
    private var previousPartsSeconds: TimeInterval = 0
    private var currentChunk: Int?
    private var active: LiveLink?
    /// A session being opened to rotate into, or to reconnect with.
    private var candidate: MeetingLiveSession?
    /// Bumped whenever a part ends, so a candidate that finishes connecting
    /// afterwards knows it has nothing to attach to.
    private var generation = 0
    private var flushing: [Task<Void, Never>] = []
    private var nextConnectAt = Date.distantPast
    private var reconnectAttempts = 0
    private var goAwayPending = false
    private var transitioning = false
    private var ticker: Task<Void, Never>?
    private var lastPartSave = Date.distantPast

    public init(services: MeetingServices,
                makeAudioSource: @escaping @MainActor () -> MeetingAudioSource,
                makeLiveSession: (@MainActor () -> MeetingLiveSession?)?,
                timing: Timing = Timing()) {
        self.services = services
        self.makeAudioSource = makeAudioSource
        self.makeLiveSession = makeLiveSession
        self.timing = timing
    }

    // MARK: - Controls

    public func start() throws {
        guard phase == .idle, !transitioning else { return }
        let id = UUID()
        let now = Date()
        let folder = try MeetingStore.makeFolder(id: id, now: now)
        let processor = MeetingProcessor(
            document: MeetingDocument(folder: folder, meta: MeetingMeta(id: id, startedAt: now), transcript: MeetingTranscript()),
            services: services
        )
        self.processor = processor
        partIndex = 0
        previousPartsSeconds = 0
        latestLine = ""
        elapsed = 0
        do {
            try startPart()
        } catch {
            self.processor = nil
            try? FileManager.default.removeItem(at: folder)
            throw error
        }
        phase = .recording
        startTicking()
        Log.session.info("meeting started (\(id.uuidString.prefix(8), privacy: .public))")
    }

    public func pause() async {
        guard phase == .recording, !transitioning else { return }
        transitioning = true
        phase = .paused
        await endPart()
        processor?.setStatus(.paused)
        transitioning = false
    }

    public func resume() throws {
        guard phase == .paused, !transitioning else { return }
        try startPart()
        phase = .recording
        processor?.setStatus(.recording)
    }

    /// Ends capture and hands the meeting to its processor to finish. Returns
    /// that processor; finishing continues in the background.
    @discardableResult
    public func stop() async -> MeetingProcessor? {
        // A pause or mic restart in progress finishes first; refusing here would
        // strand a meeting the user has already been told is finishing.
        while transitioning { try? await Task.sleep(nanoseconds: 50_000_000) }
        guard phase != .idle, let processor else { return nil }
        transitioning = true
        let wasRecording = phase == .recording
        // Idle at once: capture is ending, and the last utterance's flush is
        // bookkeeping the user should not have to watch a timer for.
        phase = .idle
        ticker?.cancel()
        ticker = nil
        if wasRecording { await endPart() }
        for task in flushing { await task.value }
        flushing = []
        processor.setEndedAt(Date())
        connection = .unavailable
        level = 0
        self.processor = nil
        transitioning = false
        Log.session.info("meeting stopped after \(Int(processor.document.meta.durationSeconds))s of audio")
        Task { await processor.finish() }
        return processor
    }

    public func setMicMuted(_ muted: Bool) {
        mute.isMuted = muted
        micMuted = muted
    }

    /// Quit with a meeting in flight: nothing here can await, so record where
    /// things stand and let launch recovery finish the notes from disk.
    public func prepareForTermination() {
        guard let processor, phase != .idle else { return }
        generation += 1
        if let candidate { Task { await candidate.abort() } }
        if let active { Task { await active.session.abort() } }
        let frames = router.framesDelivered
        processor.updatePart(partIndex) { $0.frames = max($0.frames, frames) }
        processor.setStatus(.interrupted)
        processor.saveSynchronously()
    }

    // MARK: - Parts

    private func startPart() throws {
        guard let processor else { return }
        partIndex += 1
        let router = MeetingStreamRouter()
        self.router = router
        let part = MeetingPart(index: partIndex, startedAt: Date())
        processor.addPart(part)
        let source = makeAudioSource()
        source.onLevel = { [weak self] level in
            Task { @MainActor [weak self] in self?.level = level }
        }
        source.onDied = { [weak self] message in
            Task { @MainActor [weak self] in self?.captureDied(message) }
        }
        // Before capture starts: the first buffer can land the instant the
        // engine runs, and a buffer with no chunk to belong to is a lost word.
        let link = attachFirstSession()
        let system: Bool
        do {
            system = try source.start(folder: processor.document.folder, part: part, mute: mute,
                                      deliver: { [router] pcm in router.deliver(pcm) })
        } catch {
            router.attach(nil)
            if let link {
                active = nil
                Task { await link.session.abort() }
            }
            if let chunk = currentChunk {
                processor.updateChunk(chunk) { $0.endFrame = 0; $0.status = .batched }
            }
            currentChunk = nil
            processor.updatePart(part.index, save: true) { $0.ended = true }
            throw error
        }
        audio = source
        partOpen = true
        systemAudioActive = system
        processor.updatePart(part.index, save: true) { $0.hasSystemAudio = system }
        partStartedAt = Date()
        if let link { connect(link) }
    }

    /// The first session of a part attaches before its handshake: the ring
    /// holds the opening seconds, so the start of a meeting needs no batch call.
    private func attachFirstSession() -> LiveLink? {
        guard let processor else { return nil }
        guard let session = makeLiveSession?() else {
            currentChunk = processor.openChunk(part: partIndex, startFrame: router.framesDelivered, status: .buffering)
            connection = .unavailable
            return nil
        }
        let start = router.attach { pcm in session.enqueue(pcm) }
        let chunk = processor.openChunk(part: partIndex, startFrame: start, status: .streaming)
        let link = LiveLink(session: session, chunk: chunk,
                            chunkStart: processor.document.meta.meetingSeconds(part: partIndex, frame: start))
        active = link
        currentChunk = chunk
        connection = .connecting
        return link
    }

    private func connect(_ link: LiveLink) {
        listen(to: link)
        Task { [weak self] in
            do {
                try await link.session.start()
                guard let self, self.active === link else { return }
                self.connection = .live
                self.reconnectAttempts = 0
            } catch {
                self?.linkFailed(link, reason: "setup failed: \(error)")
            }
        }
    }

    private func endPart() async {
        guard let processor, partOpen else { return }
        partOpen = false
        generation += 1
        if let candidate {
            self.candidate = nil
            Task { await candidate.abort() }
        }
        let source = audio
        audio = nil
        // Stop first: the drain delivers the last buffers, and they belong to
        // this chunk and its session.
        let result = await source?.stop()
        let boundary = router.attach(nil)
        if let current = currentChunk {
            processor.updateChunk(current) { $0.endFrame = boundary }
            if let link = active {
                active = nil
                flush(link)
            } else {
                processor.updateChunk(current) { $0.status = boundary > $0.startFrame ? .awaitingBatch : .batched }
            }
        }
        currentChunk = nil
        processor.updatePart(partIndex, save: true) {
            $0.frames = boundary
            $0.mutedRanges = result?.mutedRanges ?? []
            $0.ended = true
        }
        previousPartsSeconds += MeetingAudio.seconds(boundary)
        partStartedAt = nil
        elapsed = previousPartsSeconds
        level = 0
        interim = ""
    }

    private func captureDied(_ message: String) {
        guard phase == .recording, !transitioning, audio != nil else { return }
        Log.audio.error("meeting capture died (\(message, privacy: .public)) — restarting")
        onNotice?("\(message) — reconnecting the meeting mic")
        transitioning = true
        Task { [weak self] in
            guard let self else { return }
            await self.endPart()
            self.transitioning = false
            for delay in [1.5, 3.0, 6.0] {
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                guard self.phase == .recording else { return }
                do {
                    try self.startPart()
                    return
                } catch {
                    Log.audio.error("meeting mic restart failed: \(String(describing: error), privacy: .public)")
                }
            }
            self.phase = .paused
            self.processor?.setStatus(.paused)
            self.onNotice?("Meeting paused — the microphone is unavailable")
        }
    }

    // MARK: - The Live relay

    private func listen(to link: LiveLink) {
        link.events = Task { [weak self, link] in
            for await event in link.session.events {
                self?.handle(event, from: link)
            }
        }
    }

    private func handle(_ event: MeetingLiveEvent, from link: LiveLink) {
        switch event {
        case .interim(let text):
            if link === active {
                latestLine = text
                interim = text
            }
        case .final(let text):
            processor?.appendFinal(chunk: link.chunk, text: text, start: link.chunkStart + link.lastActivityStart)
            latestLine = text
            interim = ""
        case .usage(let audioTokens, let textTokens):
            processor?.addUsage(audioTokens: audioTokens, textTokens: textTokens)
        case .activityStart(let offset):
            link.speechActive = true
            link.lastActivityStart = offset
        case .activityEnd:
            link.speechActive = false
            link.quietSince = Date()
        case .goAway:
            if link === active { goAwayPending = true }
        case .failed(let why):
            linkFailed(link, reason: why)
        case .setupComplete:
            break
        }
    }

    private func linkFailed(_ link: LiveLink, reason: String) {
        guard !link.failed else { return }
        link.failed = true
        Log.transcription.info("meeting live session failed: \(reason, privacy: .public)")
        guard link === active else { return } // a flushing session: its chunk goes to batch
        active = nil
        router.attach(nil)
        processor?.updateChunk(link.chunk) { $0.status = .buffering }
        connection = .reconnecting
        nextConnectAt = Date().addingTimeInterval(backoff(reconnectAttempts))
    }

    private func backoff(_ attempt: Int) -> TimeInterval {
        timing.reconnectBackoff[min(max(0, attempt), timing.reconnectBackoff.count - 1)]
    }

    /// Opens the next session while the current one keeps streaming; the switch
    /// happens only once it is ready, so a rotation never leaves a hole.
    private func beginHandoff() {
        guard candidate == nil, let session = makeLiveSession?() else { return }
        candidate = session
        let generation = self.generation
        if active == nil { connection = .reconnecting }
        Task { [weak self] in
            do {
                try await session.start()
            } catch {
                guard let self, self.generation == generation, self.candidate === session else { return }
                self.candidate = nil
                self.reconnectAttempts += 1
                self.nextConnectAt = Date().addingTimeInterval(self.backoff(self.reconnectAttempts - 1))
                Log.transcription.info("meeting live session did not open: \(String(describing: error), privacy: .public)")
                return
            }
            guard let self, self.generation == generation, self.phase == .recording, self.candidate === session else {
                await session.abort()
                return
            }
            self.candidate = nil
            self.adopt(session)
        }
    }

    private func adopt(_ session: MeetingLiveSession) {
        guard let processor else { return }
        let boundary = router.attach { pcm in session.enqueue(pcm) }
        let previous = active
        if let previousChunk = currentChunk {
            processor.updateChunk(previousChunk) { chunk in
                chunk.endFrame = boundary
                if previous == nil {
                    chunk.status = boundary > chunk.startFrame ? .awaitingBatch : .batched
                }
            }
        }
        let chunk = processor.openChunk(part: partIndex, startFrame: boundary, status: .streaming)
        let link = LiveLink(session: session, chunk: chunk,
                            chunkStart: processor.document.meta.meetingSeconds(part: partIndex, frame: boundary))
        active = link
        currentChunk = chunk
        connection = .live
        reconnectAttempts = 0
        goAwayPending = false
        listen(to: link)
        if let previous { flush(previous) }
    }

    /// Asks a detached session for its last utterance, then settles its chunk:
    /// clean means its finals stand; anything else sends the span to batch.
    private func flush(_ link: LiveLink) {
        guard let processor else { return }
        let task = Task { [processor] in
            let clean = await link.session.finish()
            processor.updateChunk(link.chunk) { $0.status = clean && !link.failed ? .complete : .awaitingBatch }
        }
        // A flush settles within seconds and rotations are minutes apart, so
        // only the latest few can still be running when stop() awaits them.
        if flushing.count >= 4 { flushing.removeFirst(flushing.count - 3) }
        flushing.append(task)
    }

    private func cutBufferedChunk() {
        guard let processor, let current = currentChunk else { return }
        let boundary = router.attach(nil)
        processor.updateChunk(current) { $0.endFrame = boundary; $0.status = .awaitingBatch }
        currentChunk = processor.openChunk(part: partIndex, startFrame: boundary, status: .buffering)
    }

    // MARK: - Tick

    private func startTicking() {
        ticker?.cancel()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 500_000_000)
                self?.tick()
            }
        }
    }

    private func tick() {
        guard let processor else { return }
        processor.pump()
        guard phase == .recording, !transitioning else { return }
        let now = Date()
        elapsed = previousPartsSeconds + (partStartedAt.map { now.timeIntervalSince($0) } ?? 0)
        if now.timeIntervalSince(lastPartSave) >= 5 {
            lastPartSave = now
            let frames = router.framesDelivered
            processor.updatePart(partIndex) { $0.frames = frames }
        }
        if let link = active {
            let age = now.timeIntervalSince(link.startedAt)
            let quiet = !link.speechActive
                && (link.quietSince.map { now.timeIntervalSince($0) >= timing.quietBeforeRotation } ?? true)
            if candidate == nil, now >= nextConnectAt,
               goAwayPending || age >= timing.hardRotation || (age >= timing.softRotation && quiet) {
                beginHandoff()
            }
        } else if let current = currentChunk, let chunk = processor.chunk(current) {
            if router.framesDelivered - chunk.startFrame >= MeetingAudio.frames(timing.bufferedChunkLimit) {
                cutBufferedChunk()
            }
            if makeLiveSession != nil, candidate == nil, now >= nextConnectAt {
                beginHandoff()
            }
        }
    }
}
