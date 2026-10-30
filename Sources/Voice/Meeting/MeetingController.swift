import AppKit
import BentoCore
import Combine
import VoiceCore

/// App-side glue for meeting recording: builds the recorder from the same
/// transport configuration dictation uses, keeps a dictation out of the
/// meeting's notes, and owns the widget, the notes windows and the library.
///
/// Deliberately beside `DictationController`, not inside it. The two share the
/// microphone and the pill and nothing else, so a meeting can record for an
/// hour while dictation and the assistant work exactly as they always have.
@MainActor
final class MeetingController: ObservableObject {
    /// The one instance, for the Meetings pane in the main window — which is
    /// built far from here and only needs to read.
    static weak var current: MeetingController?

    let recorder: MeetingRecorder
    /// Meetings whose capture is over but whose notes are still being finished.
    @Published private(set) var finishing: [MeetingProcessor] = []
    /// The meeting that just finished, until the widget has shown "Notes ready".
    @Published private(set) var justFinished: MeetingProcessor?
    @Published private(set) var library: [MeetingListItem] = []

    enum MenuState: Equatable {
        case idle
        case recording(paused: Bool)
    }

    var onNotice: ((String) -> Void)?
    var onMenuState: ((MenuState) -> Void)?

    private var widget: MeetingWidgetController?
    private var notesWindows: [UUID: MeetingNotesWindowController] = [:]
    /// Finished meetings opened from the library, so each has one processor.
    private var loaded: [UUID: MeetingProcessor] = [:]
    private let earcons = EarconPlayer.shared
    private var dictationCapturing = false
    private var assistantCallActive = false
    private var cancellables: Set<AnyCancellable> = []
    private var readyDismissal: Task<Void, Never>?

    /// `recorder` is injectable so the whole controller can be driven by fakes.
    init(coordinator: DictationCoordinator, recorder: MeetingRecorder? = nil) {
        self.recorder = recorder ?? MeetingRecorder(
            services: Self.makeServices(),
            makeAudioSource: { MeetingCapture(captureSystemAudio: SettingsStore().meetingCaptureSystemAudio) },
            makeLiveSession: Self.makeLiveSessionFactory()
        )
        self.recorder.onNotice = { [weak self] message in self?.onNotice?(message) }
        widget = MeetingWidgetController(controller: self)
        Self.current = self

        // Dictation and assistant speech are meant for a text field, not for
        // the record — and the meeting would otherwise transcribe them twice.
        coordinator.$state
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state in
                guard let self else { return }
                switch state {
                case .warming, .recording, .finalizing: self.dictationCapturing = true
                default: self.dictationCapturing = false
                }
                self.updateMicMute()
            }
            .store(in: &cancellables)

        self.recorder.$phase
            .removeDuplicates()
            .sink { [weak self] phase in self?.phaseChanged(phase) }
            .store(in: &cancellables)

        // A recording meeting saves about once a second; the list only shows
        // titles, durations and status, so a refresh every few seconds is plenty.
        NotificationCenter.default.publisher(for: .gtMeetingsDidChange)
            .throttle(for: .seconds(3), scheduler: RunLoop.main, latest: true)
            .sink { [weak self] _ in self?.reloadLibrary() }
            .store(in: &cancellables)

        // Closing the lid ends the room, not necessarily the meeting: pause, and
        // let the user resume or stop when they are back.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.willSleepNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.recorder.phase == .recording else { return }
                await self.recorder.pause()
                self.onNotice?("Meeting paused while your Mac sleeps")
            }
        }
        reloadLibrary()
    }

    /// A GPT-Live call is a conversation with the assistant, not the meeting —
    /// and its replies play through the speakers into the mic.
    func setAssistantCallActive(_ active: Bool) {
        assistantCallActive = active
        updateMicMute()
    }

    private func updateMicMute() {
        recorder.setMicMuted((dictationCapturing || assistantCallActive) && SettingsStore().meetingExcludesDictation)
    }

    // MARK: - Transport, mirroring DictationController

    private static func makeServices() -> MeetingServices {
        switch VertexRuntimeConfig.state() {
        case .configured(let config) where config.isDirect:
            let models = GeminiMeetingModels(client: GeminiClient(apiKey: { config.bifrostKey }))
            return MeetingServices(batch: models, text: models)
        case .configured(let config):
            // The verbatim Vertex route has no text model behind it: the notes
            // are the raw transcript with dictionary corrections, unsummarized.
            return MeetingServices(batch: VertexTranscriptionService(config: config), text: nil)
        case .invalid:
            return MeetingServices(batch: nil, text: nil)
        case .notConfigured:
            let models = GeminiMeetingModels(client: GeminiClient(apiKey: { APIKeyStore.loadAPIKey() }))
            return MeetingServices(batch: models, text: models)
        }
    }

    /// Live for meetings follows the transport, not the dictation Live toggle or
    /// its failure streak: a meeting without Live is transcribed from the
    /// recording every few minutes instead, which is slower but loses nothing.
    private static func makeLiveSessionFactory() -> (@MainActor () -> MeetingLiveSession?)? {
        let state = VertexRuntimeConfig.state()
        let vertex = state.config
        if state.isRequested, vertex?.isDirect != true { return nil }
        return {
            if SettingsStore().transcriptionEngine.helperModel != nil { return nil }
            if vertex == nil, SettingsStore().usesLegacyTranscribeEndpoint { return nil }
            guard let key = vertex?.bifrostKey ?? APIKeyStore.loadAPIKey(), !key.isEmpty else { return nil }
            let model = vertex?.isDirect == true ? "gemini-3.5-transcribe-live-preview" : "gemini-3.5-transcribe-live"
            return MeetingLiveSession(
                transport: WebSocketTransport(apiKey: { key },
                                              endpoint: vertex?.liveEndpoint ?? URL(string: WebSocketTransport.endpoint)!),
                setupFrame: MeetingLiveProtocol.setupFrame(model: model, vocabulary: DictionaryStore().sanitizedVocabulary())
            )
        }
    }

    // MARK: - Controls

    var isActive: Bool { recorder.phase != .idle }

    func toggle() {
        isActive ? stop() : start()
    }

    func start() {
        guard recorder.phase == .idle else { return }
        do {
            try recorder.start()
            earcons.play(.lock)
        } catch {
            Log.session.error("meeting failed to start: \(String(describing: error), privacy: .public)")
            onNotice?((error as? AudioCaptureEngine.CaptureError) == .noInputDevice
                ? "No microphone found — connect one to record a meeting"
                : "Couldn't start recording the meeting — check microphone access")
        }
    }

    func stop() {
        guard recorder.phase != .idle, let processor = recorder.processor else { return }
        earcons.play(.stop)
        track(processor) // the widget shows "Finishing notes…" from this moment
        Task { await recorder.stop() }
    }

    func pauseOrResume() {
        switch recorder.phase {
        case .recording:
            Task { await recorder.pause() }
        case .paused:
            do {
                try recorder.resume()
            } catch {
                onNotice?("Couldn't resume — check microphone access")
            }
        case .idle:
            break
        }
    }

    /// The active meeting's notes, or the most recent one's.
    func openNotes() {
        if let processor = recorder.processor ?? justFinished ?? finishing.last {
            openNotes(for: processor)
        } else if let latest = library.first {
            openNotes(for: processor(for: latest))
        }
    }

    func openNotes(for processor: MeetingProcessor) {
        let window = notesWindows[processor.id] ?? MeetingNotesWindowController(processor: processor, controller: self) { [weak self] id in
            self?.notesWindows[id] = nil
        }
        notesWindows[processor.id] = window
        window.present()
    }

    func isRecording(_ processor: MeetingProcessor) -> Bool {
        recorder.processor === processor && recorder.phase != .idle
    }

    func retry(_ processor: MeetingProcessor) {
        guard !finishing.contains(where: { $0 === processor }) else { return }
        finishing.append(processor)
        processor.onFinished = { [weak self, weak processor] in
            guard let self, let processor else { return }
            self.finishing.removeAll { $0 === processor }
        }
        Task { await processor.retry() }
    }

    func delete(_ item: MeetingListItem) {
        guard recorder.processor?.id != item.id, !finishing.contains(where: { $0.id == item.id }) else { return }
        notesWindows[item.id]?.close()
        loaded[item.id] = nil
        MeetingStore.delete(folder: item.folder)
    }

    /// Quit mid-meeting: the audio is already safe on disk; record where things
    /// stand so the next launch finishes the notes.
    func prepareForTermination() {
        recorder.prepareForTermination()
        for processor in finishing {
            processor.saveSynchronously()
        }
    }

    // MARK: - Finishing and recovery

    private func track(_ processor: MeetingProcessor, recovered: Bool = false) {
        finishing.append(processor)
        processor.onFinished = { [weak self, weak processor] in
            guard let self, let processor else { return }
            self.finishing.removeAll { $0 === processor }
            self.loaded[processor.id] = processor
            self.justFinished = processor
            let incomplete = processor.document.meta.pendingBatchCount + processor.document.meta.failedChunkCount > 0
            self.onNotice?(incomplete
                ? "Meeting notes saved — some audio still needs transcribing"
                : recovered ? "Recovered your meeting notes" : "Meeting notes ready")
            self.readyDismissal?.cancel()
            self.readyDismissal = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 6_000_000_000)
                guard !Task.isCancelled else { return }
                self?.justFinished = nil
                self?.refreshWidget()
            }
            self.refreshWidget()
        }
        refreshWidget()
    }

    /// Meetings the app died in the middle of, or that ended offline: finish
    /// them from disk in the background. Spans that failed permanently wait for
    /// a manual Retry rather than re-failing on every launch.
    func recoverAtLaunch() {
        // Retention runs here and every six hours, like dictation audio's.
        Timer.scheduledTimer(withTimeInterval: 6 * 3600, repeats: true) { _ in
            Task.detached(priority: .utility) { MeetingStore.purgeExpiredAudio() }
        }
        Task.detached(priority: .utility) {
            MeetingStore.purgeExpiredAudio()
            let candidates = MeetingStore.list().filter { entry in
                switch entry.meta.status {
                case .recording, .paused, .finishing, .interrupted: return true
                case .complete: return entry.meta.pendingBatchCount > 0
                }
            }
            let documents: [MeetingDocument] = candidates.compactMap { entry in
                guard let document = MeetingStore.load(folder: entry.folder) else { return nil }
                return MeetingProcessor.recovered(document) { part in
                    MeetingProcessor.framesOnDisk(folder: entry.folder, part: part)
                }
            }
            await MainActor.run { [weak self] in
                guard let self, !documents.isEmpty else { return }
                Log.session.info("finishing \(documents.count) interrupted meeting(s)")
                for document in documents {
                    // The library may already hold an idle copy; this one supersedes it.
                    self.loaded[document.meta.id] = nil
                    let processor = MeetingProcessor(document: document, services: Self.makeServices())
                    self.track(processor, recovered: true)
                    Task { await processor.finish() }
                }
            }
        }
    }

    // MARK: - Library

    func processor(for item: MeetingListItem) -> MeetingProcessor {
        if let active = recorder.processor, active.id == item.id { return active }
        if let busy = finishing.first(where: { $0.id == item.id }) { return busy }
        if let cached = loaded[item.id] { return cached }
        let document = MeetingStore.load(folder: item.folder)
            ?? MeetingDocument(folder: item.folder, meta: MeetingMeta(id: item.id, startedAt: item.startedAt),
                               transcript: MeetingTranscript())
        let processor = MeetingProcessor(document: document, services: Self.makeServices())
        loaded[item.id] = processor
        return processor
    }

    private func reloadLibrary() {
        Task.detached(priority: .utility) {
            let items = MeetingStore.list().map { MeetingListItem(folder: $0.folder, meta: $0.meta) }
            await MainActor.run { [weak self] in self?.library = items }
        }
    }

    // MARK: - State fan-out

    /// `phase` is the incoming value: `@Published` delivers in willSet, so
    /// `recorder.phase` still reads the old one here.
    private func phaseChanged(_ phase: MeetingRecorder.Phase) {
        switch phase {
        case .idle: onMenuState?(.idle)
        case .recording: onMenuState?(.recording(paused: false))
        case .paused: onMenuState?(.recording(paused: true))
        }
        refreshWidget(phase: phase)
    }

    private func refreshWidget(phase: MeetingRecorder.Phase? = nil) {
        let visible = (phase ?? recorder.phase) != .idle || !finishing.isEmpty || justFinished != nil
        visible ? widget?.show() : widget?.hide()
    }
}

/// One row of the Meetings list — just enough to draw it without loading the
/// transcript.
struct MeetingListItem: Identifiable, Equatable {
    let id: UUID
    let folder: URL
    let title: String
    let startedAt: Date
    let durationSeconds: Double
    let status: MeetingMeta.Status
    let needsAttention: Bool

    init(folder: URL, meta: MeetingMeta) {
        self.id = meta.id
        self.folder = folder
        self.title = MeetingDocument(folder: folder, meta: meta, transcript: MeetingTranscript()).displayTitle
        self.startedAt = meta.startedAt
        self.durationSeconds = meta.durationSeconds
        self.status = meta.status
        self.needsAttention = meta.failedChunkCount > 0 || meta.pendingBatchCount > 0
    }
}

/// The current Record Meeting shortcut, for hints (it can be rebound).
enum MeetingShortcut {
    static var display: String? { ActionRegistry.shared.shortcut(for: "meetings.toggle")?.displayString }

    static func sentence(_ rest: String) -> String {
        display.map { "\($0) \(rest)" } ?? "Record Meeting \(rest)"
    }
}
