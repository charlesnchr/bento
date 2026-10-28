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

import AppKit
import ApplicationServices
import AVFoundation
import BentoCore
import Combine
import VoiceCore

/// App-side glue: EventTapEngine → DictationCoordinator → output. The pill and
/// earcons are PillPresenter's; history and recovery are HistoryServices'.
@MainActor
final class DictationController {
    let coordinator: DictationCoordinator
    /// Idle-time capture-graph prewarming — the key press pays only start().
    private let warmEngines = WarmEnginePool()
    private let engine = EventTapEngine(key: .fn)
    private let pill: PillPresenter
    private let history: HistoryServices
    private let transcriptionService: any TranscriptionServicing
    private let vertexState: VertexRuntimeConfig.State
    private var retrying = false
    /// The client behind direct Vertex dictation, reused for one-off retries.
    private var directClient: GeminiClient?
    private var cancellables: Set<AnyCancellable> = []
    private var observers: [NSObjectProtocol] = []
    private let composer: ComposerWindow
    private let assistant: AssistantController

    var onStatusChange: ((String) -> Void)?
    /// Opens the dictation history window (owned by VoiceApp).
    var onOpenHistory: (() -> Void)?
    /// Which of the three Bento modules are on. Dictation off: the dictation
    /// key passes through. Assistant off: ⌥F18 passes through and the window
    /// stays closed.
    private(set) var dictationEnabled = false
    private(set) var assistantEnabled = false
    /// The tap, pill and warm microphone are only wanted while one of them is on.
    private var wantsEngine: Bool { dictationEnabled || assistantEnabled }
    var onStatusItemState: ((VoiceIndicator) -> Void)? {
        didSet { pill.onStatusItemState = onStatusItemState }
    }

    /// Builds a live session, or nil — which is the normal answer, since live is
    /// experimental and off by default.
    ///
    /// It lives here rather than in JotCore because it is the one place that
    /// needs both the Keychain and the Dictionary, and the coordinator should
    /// know about neither.
    @MainActor
    private static func makeLiveSession(assistant: Bool = false) -> LiveTranscribing? {
        let settings = SettingsStore()
        let vertex = VertexRuntimeConfig.state().config
        guard !VertexRuntimeConfig.state().isRequested || vertex?.isDirect == true else { return nil }
        guard settings.liveTranscriptionActive else { return nil }
        // A live path that is reliably broken is worse than one that is off: every
        // attempt costs a handshake and then the full upload anyway, so the user
        // pays latency on every dictation for a feature that never delivers. Stop
        // trying after a run of failures; a single success clears the streak, so a
        // bad hotel wifi heals itself without anyone touching a setting.
        let stats = LiveStats()
        if stats.shouldStopTrying {
            Log.transcription.info(
                "live disabled for now after \(stats.consecutiveFailures) consecutive failures — uploading instead"
            )
            return nil
        }
        guard let key = vertex?.bifrostKey ?? KeychainStore.loadAPIKey(), !key.isEmpty else { return nil }
        let model = vertex?.isDirect == true ? "gemini-3.5-transcribe-live-preview" : "gemini-3.5-transcribe-live"
        let dictionary = DictionaryStore()
        let session = LiveTranscriptionSession(
            transport: WebSocketTransport(apiKey: { key }, endpoint: vertex?.liveEndpoint ?? URL(string: WebSocketTransport.endpoint)!),
            setup: LiveSetup(
                model: model,
                smart: assistant ? false : settings.smartTranscriptionEnabled,
                // The same terms the batch path biases with, so switching modes
                // does not quietly change how someone's name gets spelled.
                customVocabulary: dictionary.sanitizedVocabulary()
            )
        )
        return LiveTranscriber(
            session: session,
            modelID: model,
            replacementRules: { DictionaryStore().replacementRules() }
        )
    }

    init() {
        let state = VertexRuntimeConfig.state()
        vertexState = state
        let service: any TranscriptionServicing
        switch state {
        case .configured(let config):
            if config.isDirect {
                let client = GeminiClient(apiKey: { config.bifrostKey })
                directClient = client
                service = GeminiTranscriptionService(client: client)
            } else {
                service = VertexTranscriptionService(config: config)
            }
        case .invalid(let reason):
            service = UnavailableTranscriptionService(reason: "Invalid Vertex runtime config: \(reason)")
        case .notConfigured:
            service = GeminiTranscriptionService(client: GeminiClient(apiKey: { KeychainStore.loadAPIKey() }))
        }
        transcriptionService = service
        let composer = ComposerWindow()
        self.composer = composer
        let assistant = AssistantController()
        self.assistant = assistant
        coordinator = DictationCoordinator(
            audioFactory: { [warmEngines] in warmEngines.take() },
            transcription: service,
            insertion: VoiceOutputRouter(composer: composer, assistant: assistant),
            contextProvider: {
                let app = Self.dictationTargetApp()
                // Wake Electron/Chromium a11y NOW, while the user is still
                // speaking — doing it after the transcript exists put a
                // cross-process stall between their words and seeing them.
                AccessibilityWaker.wakeIfNeeded(
                    bundleID: app?.bundleIdentifier, pid: app?.processIdentifier
                )
                return DictationContext(
                    targetAppBundleID: app?.bundleIdentifier,
                    targetAppName: app?.localizedName,
                    targetPID: app?.processIdentifier
                )
            },
            makeLiveSession: { Self.makeLiveSession(assistant: assistant.isRecording) },
            finalizeContext: { [composer, assistant] in
                if $0.isAssistant { return assistant.finalizeContext() }
                if $0.captureToNote { return $0 }
                if $0.useComposer { return composer.finalizeContext($0) }
                // Resolve ordinary dictation at speech end. An edit stays bound
                // to the selected text's original app for replacement safety.
                if $0.editingSession != nil { return $0 }
                let app = Self.dictationTargetApp()
                return DictationContext(targetAppBundleID: app?.bundleIdentifier,
                    targetAppName: app?.localizedName, targetPID: app?.processIdentifier)
            }
        )
        pill = PillPresenter(coordinator: coordinator, vertexState: state)
        history = HistoryServices(transcription: service, coordinator: coordinator, pill: pill, vertexState: state)
        pill.isAssistantBusy = { [assistant] in assistant.isBusy }
        history.onEditInserted = { [composer] instruction, revision in
            composer.recordInstruction(instruction, revision: revision)
        }
        composer.onCancel = { [weak self] in self?.coordinator.handle(.cancel); self?.engine.resetGrammar() }
        composer.onNotice = { [weak self] message in self?.pill.showNotice(message, for: 3, sound: nil) }
        assistant.onBusyChange = { [weak self] busy in
            guard let self else { return }
            self.engine.setExternalSessionActive(busy)
            self.engine.setAssistantLiveCall(SettingsStore().assistantLiveCall || self.assistant.isLive)
            self.onAssistantLiveCall?(busy && self.assistant.isLive)
            self.onStatusItemState?(busy ? .processing : .idle)
            if !busy, self.coordinator.state == .idle || self.coordinator.state.isTerminal { self.pill.setPill(.idleDot) }
        }
        assistant.canStartLive = { [weak self] in
            guard let self else { return false }
            return self.coordinator.state == .idle || self.coordinator.state.isTerminal
        }
        assistant.beforeLiveStart = { [weak self] in await self?.warmEngines.suspend() }
        assistant.afterLiveEnd = { [weak self] in self?.warmEngines.resume() }
        assistant.onLegacyDictation = { [weak self] in self?.toggleAssistantRequest() }
    }

    func start() {
        applyHotkeySettings()
        // Intents flow through one AsyncStream consumed sequentially — independent
        // Task hops have no ordering guarantee under load (audit L35).
        let (intentStream, continuation) = AsyncStream.makeStream(of: HotkeyIntent.self)
        engine.onIntent = { intent in
            continuation.yield(intent)
        }
        Task { @MainActor [weak self] in
            for await intent in intentStream {
                guard let self else { break }
                let accepted = self.handleIntent(intent)
                if !accepted, intent == .begin || intent == .beginEditing {
                    // Refused begin (secure field / busy): the grammar armed a
                    // phantom session — snap it back or a Space-lock on it
                    // strands .locked and eats the next dictation.
                    self.engine.resetGrammar()
                }
            }
        }

        observeNotifications()
        bind()
        history.start()

        // The engine starts when a module switches it on (setEnabled).
        reportSetupIncomplete()

        if FnUsageAdvisor.karabinerIsPresent() {
            Log.hotkey.warning("Karabiner-Elements detected — fn capture may conflict")
        }
    }

    private func observe(_ name: Notification.Name, center: NotificationCenter = .default,
                         _ handler: @escaping @MainActor (DictationController, Notification) -> Void) {
        // A hop, not a direct call: settings notifications are posted from
        // inside SwiftUI bindings, which must not publish mid-update.
        observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
            Task { @MainActor [weak self] in
                guard let self else { return }
                handler(self, note)
            }
        })
    }

    private func observeNotifications() {
        observe(.pillStopTapped) { controller, _ in controller.coordinator.handle(.finalize) }
        observe(.pillDotTapped) { controller, _ in controller.startHandsFree() }
        // Settings must take effect the moment they're flipped — not on the next
        // unrelated pill transition (dogfood: resting-dot toggle "didn't work").
        observe(.gtSettingDidChange) { controller, note in
            controller.applySettingChange(key: note.object as? String)
        }
        observe(.voiceLocalModelDidChange) { controller, note in
            controller.localModelChanged(note.object as? String)
        }
        // Auto-degrade must never be silent: the user's next dictations arrive
        // verbatim, and they deserve to know why and where to turn it back on.
        observe(.gtSmartFormattingAutoDegraded) { controller, _ in
            // Deferred: this fires MID-SESSION (inside the cleanup call) and a
            // direct notice would be stomped by the session's own transitions.
            // Gemini's smart mode is in the transcription call, so it survives;
            // on verbatim engines it was the cleanup pass and is now off too.
            let settings = SettingsStore()
            let stillSmart = settings.smartTranscriptionEnabled && !settings.transcriptionEngine.isVerbatim
                && !settings.usesLegacyTranscribeEndpoint
            let tail = stillSmart
                ? "Smart transcription is still on. Turn it back on in Settings → Formatting."
                : "Turn it back on in Settings → Formatting."
            controller.pill.showBackgroundNotice("Turned off the cleanup pass — the second model kept misfiring. \(tail)", for: 5.0, sound: nil)
        }

        // A prewarmed graph is bound to the device it was built for — rebuild it
        // the moment the input moves, so the first dictation on new AirPods is
        // as fast as the last one on the old mic.
        // CoreAudio can stall while a device connects: never on the main thread.
        DispatchQueue.global(qos: .utility).async { AudioInputDevices.startMonitoringDefaultChanges() }
        observe(.voiceDefaultInputChanged) { controller, _ in
            Log.audio.info("default input changed — refreshing the warm capture graph")
            controller.warmEngines.refresh()
        }

        // F15: finalize gracefully when the Mac sleeps mid-recording (audit L1).
        let workspace = NSWorkspace.shared.notificationCenter
        observe(NSWorkspace.willSleepNotification, center: workspace) { controller, _ in
            if controller.assistant.isLive { controller.assistant.stop() }
            if case .recording = controller.coordinator.state {
                Log.session.info("system sleeping — finalizing active dictation")
                controller.coordinator.handle(.finalize)
            }
        }
        observe(NSWorkspace.sessionDidResignActiveNotification, center: workspace) { controller, _ in
            if controller.assistant.isLive { controller.assistant.stop() }
        }
    }

    /// True once engine.start() has succeeded — status-line rewrites must never
    /// paint "Ready" over an unstarted engine's attention message.
    private var engineActive = false

    private var readyStatus: String {
        let settings = SettingsStore()
        let engine = settings.transcriptionEngine
        let prefix = vertexState.config?.isDirect == true ? "Vertex"
            : vertexState.isRequested ? "Vertex verbatim"
            : engine.isLocal ? "\(engine.displayName) on this Mac" : "Ready"
        return "\(prefix) — hold \(settings.hotkeyKey.displayName) to dictate"
    }

    /// What stops a dictation before the key is even pressed, for the menu's
    /// status line; nil when it's ready.
    private var attentionStatus: String? {
        if case .invalid = vertexState {
            return "Vertex configuration is invalid — check \(VertexRuntimeConfig.defaultURL.path.replacingOccurrences(of: NSHomeDirectory(), with: "~"))"
        }
        let settings = SettingsStore()
        let engine = settings.transcriptionEngine
        guard engine.isLocal else { return nil }
        let models = ParakeetModels.shared
        switch models.status(engine) {
        case .ready:
            return nil
        case .downloading:
            return models.progressLine(engine)
        case .notDownloaded:
            // New-user path: no key, no runtime. Say exactly where to go.
            return settings.usesLocalFallback
                ? "Download Parakeet v3 or add a Gemini API key in Settings → Dictation"
                : "Download \(engine.displayName) in Settings → Dictation"
        case .failed:
            return "\(engine.displayName) download failed — retry in Settings → Dictation"
        }
    }

    /// Rewrites the status line after something it depends on changed. The
    /// indicator is left alone mid-session: it's showing listening or processing.
    private func refreshStatus() {
        guard engineActive else { return }
        let resting = (coordinator.state == .idle || coordinator.state.isTerminal) && !assistant.isBusy
        if let attention = attentionStatus {
            onStatusChange?(attention)
            if resting { onStatusItemState?(.attention) }
        } else {
            onStatusChange?(readyStatus)
            if resting { onStatusItemState?(.idle) }
            warmEngines.prewarmNext()
        }
    }

    private func activateEngine() {
        guard wantsEngine else { return }
        // Without Accessibility the tap can't exist; Settings → General asks for it.
        guard AXIsProcessTrusted(), engine.start() else {
            onStatusChange?("Grant Accessibility to enable the dictation key")
            onStatusItemState?(.attention)
            return
        }
        engineActive = true
        if let attention = attentionStatus {
            // The key still works: pressing it explains, or offers the download.
            onStatusChange?(attention)
            onStatusItemState?(.attention)
        } else {
            onStatusChange?(readyStatus)
            // Clear a lingering attention icon (auth failure, missing key).
            onStatusItemState?(.idle)
            warmEngines.prewarmNext()
            if assistantEnabled { assistant.prewarm() }
        }
        pill.show()
        announceSmartRestoredIfNeeded()
        // Idle time, not insert time: the one-time keyboard-layout
        // lookup otherwise lands between transcript-ready and ⌘V.
        Task { @MainActor in PasteInserter.warmKeyboardLayout() }
    }

    /// Names the first missing prerequisite — never leaves the construction
    /// placeholder ("Starting up…") in the menu.
    private func reportSetupIncomplete() {
        if !AXIsProcessTrusted() {
            onStatusChange?("Grant Accessibility to enable the dictation key")
        } else if !wantsEngine {
            onStatusChange?("Dictation is off")
            return
        } else if let attention = attentionStatus {
            onStatusChange?(attention)
        } else {
            onStatusChange?(vertexState.isRequested ? "Vertex configured — finish permission setup" : "Finish permission setup")
        }
        onStatusItemState?(.attention)
    }

    func applyHotkeySettings() {
        let settings = SettingsStore()
        engine.setKey(settings.hotkeyKey)
        engine.setDoubleTapLockEnabled(settings.doubleTapLockEnabled)
        engine.setSingleTapHandsFreeEnabled(settings.singleTapHandsFreeEnabled)
        engine.setAssistantLiveCall(settings.assistantLiveCall || assistant.isLive)
        engine.setClaimsAssistantWindowToggle(false)
    }

    private func applySettingChange(key: String?) {
        switch key {
        case "showIdleIndicator":
            // Re-apply only when resting — setPill maps idleDot ⇄ hidden by the
            // setting; never touch an active session's pill.
            pill.applyIdleIndicatorSetting()
        case "hotkeyKey", "doubleTapLock", "singleTapHandsFree", "assistantLiveCall":
            applyHotkeySettings()
            // The menu-bar status line names the key — keep it truthful, but
            // never overwrite an attention message ("Grant Accessibility…").
            if engineActive, attentionStatus == nil {
                onStatusChange?(readyStatus)
            }
        case "accessibility":
            // Granted after launch (Settings → General): wake the engine.
            if !engineActive {
                activateEngine()
            }
        case "apiKey":
            guard !vertexState.isRequested else { return }
            // A key arriving switches a Parakeet fallback back to Gemini; one
            // removed falls back to Parakeet. Either way the line must follow.
            // engine.start() is reentrant; hud.show() is idempotent.
            if engineActive { refreshStatus() } else { activateEngine() }
        case "transcriptionBackend", "dualTranscription", "gptTranscription":
            refreshStatus()
        default:
            break
        }
    }

    // MARK: - Windows

    /// What opening Bento's assistant shows: the chat window.
    func openMainWindow() { openAssistant() }

    func openHistory() { onOpenHistory?() }

    /// What the History window and the Privacy settings need.
    var historyPages: AppPages { history.pages }

    /// Settings live in Bento's settings window: one pane per module.
    func openSettings(section: String? = nil) {
        switch section {
        case "assistant": SettingsRouter.open("assistant")
        case "meetings": SettingsRouter.open("meetings")
        case "dictionary": openDictionary()
        default: SettingsRouter.open("dictation")
        }
    }

    func openDictionary() {
        DictationSettingsView.showDictionaryNext = true
        SettingsRouter.open("dictation")
        NotificationCenter.default.post(name: .voiceShowDictionary, object: nil)
    }

    func openComposer() {
        guard dictationEnabled else { return }
        composer.open()
    }

    func openAssistant() {
        guard assistantEnabled else { return }
        assistant.openChat()
    }

    func toggleAssistant() {
        guard assistantEnabled else { return }
        assistant.toggle()
    }

    func toggleAssistantCall() {
        guard assistantEnabled else { return }
        assistant.toggleLive()
    }

    func newAssistantChat() {
        guard assistantEnabled else { return }
        assistant.openChat()
        assistant.newChat()
    }

    var assistantIsLive: Bool { assistant.isLive }

    // MARK: - Dictate to Assistant

    /// Dictate to Assistant (⌃⌥F18 by default): what you say goes to the
    /// assistant as a request, never into the front app, whatever the Voice
    /// calls setting makes of ⌥F18. Hold to talk, or tap and press again.
    private var assistantShortcut = HoldOrTapShortcut()

    /// A request for the assistant is being recorded (not yet transcribing).
    var isRecordingAssistantRequest: Bool {
        guard assistant.isRecording else { return false }
        switch coordinator.state {
        case .warming, .recording: return true
        default: return false
        }
    }

    func assistantDictationKeyDown() {
        let recording = isRecordingAssistantRequest
        guard recording || assistantShortcutReady() else { return }
        switch assistantShortcut.keyDown(at: ProcessInfo.processInfo.systemUptime, recording: recording) {
        case .begin: if !beginAssistantRequest() { assistantShortcut.beginRefused() }
        case .finalize: coordinator.handle(.finalize)
        case .lockIn, nil: break
        }
    }

    func assistantDictationKeyUp() {
        switch assistantShortcut.keyUp(at: ProcessInfo.processInfo.systemUptime, recording: isRecordingAssistantRequest) {
        case .lockIn: coordinator.handle(.lockIn)
        case .finalize: coordinator.handle(.finalize)
        case .begin, nil: break
        }
    }

    /// The menu, keyboard overview and URLs: start hands-free, or send.
    func toggleAssistantDictation() {
        guard isRecordingAssistantRequest || assistantShortcutReady() else { return }
        toggleAssistantRequest()
    }

    /// No session without the pill (it needs the tap, so Accessibility): a
    /// hot microphone with nothing on screen, as for hands-free dictation.
    private func assistantShortcutReady() -> Bool {
        guard assistantEnabled else { return false }
        guard engineActive else {
            if !AXIsProcessTrusted() { SettingsRouter.open() } else { NSSound.beep() }
            return false
        }
        return true
    }

    /// Also the chat window's microphone button.
    private func toggleAssistantRequest() {
        for step in HoldOrTapShortcut.toggle(recording: isRecordingAssistantRequest) {
            switch step {
            case .begin: guard beginAssistantRequest() else { return }
            case .lockIn: coordinator.handle(.lockIn)
            case .finalize: coordinator.handle(.finalize)
            }
        }
    }

    /// Starts recording a request; the transcript goes to the assistant
    /// (`VoiceOutputRouter`). Refused during a call, a turn or another session.
    private func beginAssistantRequest() -> Bool {
        guard !assistant.isLive, !assistant.isBusy,
              coordinator.state == .idle || coordinator.state.isTerminal,
              microphoneReady(), let context = assistant.prepare() else { return false }
        let accepted = coordinator.handle(.begin, context: context)
        if !accepted { assistant.finishRecording() }
        return accepted
    }

    /// Dev harness hook: a transcript down the Capture Thought to Note output path.
    func devCapture(_ text: String) {
        var context = DictationContext()
        context.captureToNote = true
        let router = VoiceOutputRouter(composer: composer, assistant: assistant)
        Task { _ = await router.insert(text, context: context) }
    }

    /// Dev harness hooks (VoiceApp's BENTO_DEV observer).
    func devAssistant(_ command: String, _ info: [AnyHashable: Any]) -> [String: Any] {
        switch command {
        case "send": assistant.openChat(); assistant.send(info["text"] as? String ?? "", attachments: [])
        case "hide": assistant.hide()
        case "frame": if let value = info["frame"] as? String { assistant.devSetFrame(NSRectFromString(value)) }
        default: break
        }
        return assistant.devState()
    }

    /// Applies the module switches. All off: the tap stops, the pill goes and
    /// the prepared microphone graph is released, so nothing runs while idle.
    func setEnabled(dictation: Bool, assistant assistantOn: Bool) {
        let wasActive = dictationEnabled || assistantEnabled
        dictationEnabled = dictation
        assistantEnabled = assistantOn
        engine.setDictationKeyEnabled(dictation)
        engine.setAssistantKeysEnabled(assistantOn)
        if !assistantOn {
            // A voice request being recorded for the assistant goes nowhere now.
            if assistant.isRecording, case .recording = coordinator.state { coordinator.handle(.cancel) }
            assistant.stop()
            assistant.dismiss()
        } else if engineActive {
            assistant.prewarm()
        }
        if !dictation {
            if case .recording = coordinator.state { coordinator.handle(.finalize) }
            composer.dismiss()
        }
        let active = dictation || assistantOn
        if active, !wasActive {
            activateEngine()
            warmEngines.resume()
        } else if !active, wasActive {
            engine.stop()
            engineActive = false
            pill.hide()
            Task { await warmEngines.suspend() }
        }
        pill.showsRestingDot = dictation
        pill.applyIdleIndicatorSetting()
    }

    // MARK: - Meetings

    /// Meeting recording runs beside dictation and borrows only the hotkey tap
    /// (Shift-Option-F17) and the pill for its notices.
    func setMeetingToggle(_ handler: @escaping () -> Void) {
        engine.onMeetingToggle = handler
    }

    func showMeetingNotice(_ message: String) {
        pill.showBackgroundNotice(message, for: 4.0, sound: nil)
    }

    /// An Azure GPT-Live call captures the mic on its own engine, outside the
    /// coordinator, so a meeting learns about it here.
    var onAssistantLiveCall: ((Bool) -> Void)?

    // MARK: - Retry last transcription

    /// Re-runs the last dictation's recording through another backend and
    /// replaces the words it inserted. The replacement only lands on a verified
    /// selection of the old text; anything else goes to the clipboard.
    func retryLast(with choice: SettingsStore.TranscriptionEngine? = nil) {
        guard let client = directClient else {
            pill.showNotice("Retry needs the direct Vertex runtime", for: 3.0, sound: nil)
            return
        }
        guard !retrying else { return }
        guard coordinator.state == .idle || coordinator.state.isTerminal else { return }
        guard let last = coordinator.lastDictation else {
            pill.showNotice("Nothing to retry yet — dictate something first", for: 2.5, sound: nil)
            return
        }
        let audio = FileLayout.audioCAF(in: last.folder)
        guard FileManager.default.fileExists(atPath: audio.path) else {
            pill.showNotice("That recording is gone — keep audio in Settings to retry", for: 3.0, sound: nil)
            return
        }
        let settings = SettingsStore(engine: choice ?? SettingsStore().retryEngine)
        let name = settings.name(of: settings.transcriptionEngine)
        retrying = true
        pill.cancelDismiss()
        pill.setPill(.notice("Retrying with \(name)…"))
        Task { @MainActor [weak self] in
            defer { self?.retrying = false }
            var context = last.context
            context.editingSession = nil
            let duration = last.durationSeconds ?? FileLayout.estimatedDuration(ofCAF: audio) ?? 60
            let result: TranscriptionResult
            do {
                result = try await GeminiTranscriptionService(client: client, settings: settings)
                    .transcribe(audioURL: audio, durationSeconds: duration, context: context)
            } catch {
                Log.transcription.error("retry with \(name, privacy: .public) failed: \(String(describing: error), privacy: .public)")
                self?.pill.showError("Retry with \(name) failed")
                return
            }
            guard let self else { return }
            if var meta = SessionMeta.read(from: last.folder) {
                meta.rawTranscript = result.rawTranscript
                meta.cleanedTranscript = result.cleanedTranscript
                meta.modelID = result.modelID
                meta.write(to: last.folder)
                self.history.upsert(meta: meta, folder: last.folder)
            }
            let text = result.cleanedTranscript
            guard text != last.text else {
                self.pill.showNotice("\(name) heard the same thing", for: 2.5, sound: nil)
                return
            }
            let outcome = await self.replace(last.text, with: text, context: last.context)
            self.coordinator.noteRetried(text: text, inserted: outcome == .inserted)
            switch outcome {
            case .inserted:
                self.pill.showNotice("Replaced with \(name)", for: 2.5, sound: nil)
            case .fellBackToClipboard, .frontmostChanged:
                self.pill.showNotice("\(name)'s version copied — press ⌘V", for: 4.0, sound: nil)
            case .blockedSecureField:
                self.pill.showNotice("Secure input is on — retry is in History", for: 3.0, sound: nil)
            }
        }
    }

    private func replace(_ old: String, with new: String, context: DictationContext) async -> InsertionOutcome {
        var target = context
        // The inserter selects the old words only if they are still selected or
        // end at the caret; otherwise the new version goes to the clipboard.
        target.editingSession = EditingSession(seed: old)
        return await InsertionCoordinator().insert(new, context: target)
    }

    // MARK: - Intents

    /// UI-initiated hands-free session (idle-dot click, menu item). Note: the
    /// hotkey engine's grammar stays idle for these, so ending the session is via
    /// the pill's stop button or a press-and-release of the dictation key.
    func startHandsFree() {
        // No session without a visible pill and a working stop path: before the
        // engine is active there is no pill surface and no fn stop gesture — a
        // hot mic with zero UI (production pass 2).
        guard engineActive, dictationEnabled else {
            if !AXIsProcessTrusted() { SettingsRouter.open() } else { NSSound.beep() }
            return
        }
        if handleIntent(.begin) { coordinator.handle(.lockIn) }
    }

    /// Hands-free dictation into the capture note instead of the frontmost app; pressed
    /// again (or during any hands-free dictation) it stops, like Stop Dictation.
    func toggleCapture() {
        if case .recording = coordinator.state {
            coordinator.handle(.finalize)
            return
        }
        guard engineActive, dictationEnabled else {
            if !AXIsProcessTrusted() { SettingsRouter.open() } else { NSSound.beep() }
            return
        }
        guard !assistant.isBusy, coordinator.state == .idle || coordinator.state.isTerminal, microphoneReady(),
              localModelReady() else { return }
        var context = DictationContext()
        context.captureToNote = true
        if coordinator.handle(.begin, context: context) { coordinator.handle(.lockIn) }
    }

    private func handleIntent(_ intent: HotkeyIntent) -> Bool {
        if intent == .toggleAssistantCall { toggleAssistantCall(); return true }
        if intent == .toggleAssistant { toggleAssistant(); return true }
        if intent == .cancel, assistant.isBusy {
            if assistant.isLive { assistant.stop() } else { assistant.dismiss() }
            return true
        }
        if intent == .begin || intent == .beginEditing {
            guard !assistant.isBusy else { return false }
            guard microphoneReady() else { return false }
            // Editing and voice requests go to Gemini; only dictation uses Parakeet.
            if intent == .begin { guard localModelReady() else { return false } }
            if !SettingsStore().useDictationComposer {
                guard coordinator.state == .idle || coordinator.state.isTerminal else { return false }
                let app = Self.dictationTargetApp()
                var context = DictationContext(targetAppBundleID: app?.bundleIdentifier,
                    targetAppName: app?.localizedName, targetPID: app?.processIdentifier)
                if intent == .beginEditing {
                    if context.targetPID != ProcessInfo.processInfo.processIdentifier,
                       let chain = coordinator.recentEditingSession(for: context),
                       OutputSelection.isRecentOutput(chain.currentText, targetPID: context.targetPID,
                                                      atCaret: chain.editsAtCaret(at: Date())) {
                        context.editingSession = chain
                        return coordinator.handle(.beginEditing, context: context)
                    }
                    guard let assistantContext = assistant.prepare() else { return false }
                    let accepted = coordinator.handle(.begin, context: assistantContext)
                    if !accepted { assistant.finishRecording() }
                    return accepted
                }
                return coordinator.handle(.begin, context: context)
            }
            if intent == .beginEditing, !composer.hasDraft {
                guard coordinator.state == .idle || coordinator.state.isTerminal,
                      let context = assistant.prepare() else { return false }
                let accepted = coordinator.handle(.begin, context: context)
                if !accepted { assistant.finishRecording() }
                return accepted
            }
            guard coordinator.state == .idle || coordinator.state.isTerminal,
                  let context = composer.prepare(editing: intent == .beginEditing) else { return false }
            let accepted = coordinator.handle(intent, context: context)
            if !accepted { composer.finish() }
            return accepted
        }
        let accepted = coordinator.handle(intent)
        if intent == .cancel { composer.dismiss() }
        return accepted
    }

    /// The first dictation asks for the microphone (the only permission Bento
    /// adds for it); until it's granted, a key press explains instead of recording.
    private func microphoneReady() -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return true
        case .notDetermined:
            pill.showNotice("Allow Bento to use the microphone, then dictate again", for: 4.0, sound: nil)
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                Task { @MainActor [weak self] in
                    guard granted, let self else { return }
                    self.warmEngines.prewarmNext()
                    self.pill.showNotice("Microphone allowed — dictate away", for: 2.5, sound: nil)
                }
            }
            return false
        default:
            pill.showNotice("Bento can't use the microphone — allow it in System Settings → Privacy & Security", for: 5.0, sound: nil)
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") {
                NSWorkspace.shared.open(url)
            }
            return false
        }
    }

    /// An on-device model that isn't on this Mac yet can't transcribe, so a key
    /// press explains, or offers the download, instead of recording words that
    /// have nowhere to go.
    private func localModelReady() -> Bool {
        let engine = SettingsStore().transcriptionEngine
        guard engine.isLocal else { return true }
        let models = ParakeetModels.shared
        switch models.status(engine) {
        case .ready:
            return true
        case .downloading:
            pill.showNotice("\(models.progressLine(engine) ?? "Downloading \(engine.displayName)…") — dictate when it's ready",
                            for: 3.0, sound: nil)
        case .notDownloaded, .failed:
            // After this intent returns: the alert is modal, and the key's release
            // must reach a grammar that has already been reset.
            DispatchQueue.main.async { [weak self] in self?.offerDownload(engine) }
        }
        return false
    }

    private var offeringDownload = false

    private func offerDownload(_ engine: SettingsStore.TranscriptionEngine) {
        guard !offeringDownload else { return }
        offeringDownload = true
        defer { offeringDownload = false }
        let fallback = SettingsStore().usesLocalFallback
        let name = engine.displayName
        let alert = NSAlert()
        var details = (fallback ? "Bento has no transcription model yet. " : "")
            + "\(name) runs on this Mac, so what you say isn't uploaded. It's a one-time \(ParakeetModels.downloadSize(of: engine)) download."
        if case .failed(let reason) = ParakeetModels.shared.status(engine) {
            alert.messageText = "Try Downloading \(name) Again?"
            details += "\n\nThe last attempt failed: \(reason)"
        } else {
            alert.messageText = "Download \(name) to Dictate?"
        }
        if fallback { details += "\n\nTo use Gemini instead, add a Gemini API key in Settings → Dictation." }
        alert.informativeText = details
        alert.addButton(withTitle: "Download")
        alert.addButton(withTitle: "Open Settings")
        alert.addButton(withTitle: "Not Now")
        // The app being dictated into, to hand focus back to unless Settings opens.
        let frontmost = NSWorkspace.shared.frontmostApplication
        let previous = frontmost?.processIdentifier == getpid() ? AppActivation.previousApp : frontmost
        AppActivation.activateSelf()
        let choice = alert.runModal()
        if choice != .alertSecondButtonReturn, let previous, !previous.isTerminated, previous.processIdentifier != getpid() {
            previous.activate()
        }
        switch choice {
        case .alertFirstButtonReturn:
            ParakeetModels.shared.download(engine)
            pill.showNotice("Downloading \(name) — progress is in Bento's menu", for: 3.0, sound: nil)
        case .alertSecondButtonReturn:
            SettingsRouter.open("dictation")
        default:
            break
        }
    }

    /// Models whose download this run has watched, so finishing one is news
    /// while loading an already-downloaded model at launch is not.
    private var watchedDownloads: Set<SettingsStore.TranscriptionEngine> = []

    private func localModelChanged(_ raw: String?) {
        refreshStatus()
        guard let engine = raw.flatMap(SettingsStore.TranscriptionEngine.init(rawValue:)) else { return }
        switch ParakeetModels.shared.status(engine) {
        case .downloading:
            watchedDownloads.insert(engine)
        case .ready:
            guard watchedDownloads.remove(engine) != nil, engine == SettingsStore().transcriptionEngine else { return }
            pill.showBackgroundNotice("\(engine.displayName) is ready — hold \(SettingsStore().hotkeyKey.displayName) to dictate",
                                      for: 3.0, sound: nil)
        case .failed:
            guard watchedDownloads.remove(engine) != nil else { return }
            pill.showBackgroundNotice("\(engine.displayName) didn't download — retry in Settings → Dictation", for: 4.0, sound: nil)
        case .notDownloaded:
            watchedDownloads.remove(engine)
        }
    }

    /// Where dictation types: Bento itself while one of its windows has a text
    /// field focused (Notes, Todo, the assistant; Quick Add is a non-activating
    /// panel, so another app stays frontmost meanwhile), else the frontmost app.
    static func dictationTargetApp() -> NSRunningApplication? {
        if let key = NSApp.keyWindow, key.isVisible, let editor = key.firstResponder as? NSTextView, editor.isEditable {
            return NSRunningApplication.current
        }
        return NSWorkspace.shared.frontmostApplication
    }

    /// Cmd-Q mid-recording must not strand the words until next launch —
    /// finalize synchronously enough that the CAF is complete and meta says
    /// .recorded; next launch's RecoveryScanner picks the transcript up.
    func prepareForTermination() {
        assistant.stop()
        if case .recording = coordinator.state {
            Log.session.info("terminating — finalizing active dictation")
            coordinator.handle(.finalize)
        }
    }

    func pasteLastTranscript() {
        guard let text = coordinator.lastResult else {
            // A silent no-op reads as a broken menu item.
            pill.showNotice("Nothing to paste yet — dictate something first", for: 2.5, sound: nil)
            return
        }
        Task { @MainActor [weak self] in
            let app = Self.dictationTargetApp()
            let context = DictationContext(
                targetAppBundleID: app?.bundleIdentifier,
                targetAppName: app?.localizedName,
                targetPID: app?.processIdentifier
            )
            switch await InsertionCoordinator().insert(text, context: context) {
            case .inserted:
                break
            case .fellBackToClipboard, .frontmostChanged:
                self?.pill.showNotice("Copied — press ⌘V to paste", for: 3.0, sound: nil)
            case .blockedSecureField:
                self?.pill.showNotice("Secure input is on — can't paste here", for: 3.0, sound: nil)
            }
        }
    }

    // MARK: - State

    private func bind() {
        coordinator.$state
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state in
                self?.transition(to: state)
                if state.isTerminal, state == self?.coordinator.state {
                    self?.composer.finish()
                    self?.assistant.finishRecording()
                }
            }
            .store(in: &cancellables)
    }

    private func transition(to state: DictationState) {
        // Esc must reach us even when the grammar is idle: in-flight transcription
        // and UI-started hands-free are "externally active" (audit L8/L13).
        // NOT .inserting: cancel is rejected there by design (the text exists),
        // so consuming Esc would just eat the user's keystroke for ~1s.
        switch state {
        case .finalizing, .transcribing, .recording:
            engine.setExternalSessionActive(true)
        default:
            engine.setExternalSessionActive(assistant.isBusy)
        }
        pill.transition(to: state)
    }

    /// The migration flips formatting back on for users the OLD auto-degrade had
    /// switched off — they were degraded because the cleanup model was unreliable,
    /// and native smart transcription is a different mechanism entirely. Telling
    /// them is not optional: this codebase's rule is that auto-degrade must never
    /// be silent, and silently UN-degrading is the same rule broken in the other
    /// direction. Deferred, because it fires during launch.
    private func announceSmartRestoredIfNeeded() {
        let key = "shouldAnnounceSmartRestored"
        guard UserDefaults.standard.bool(forKey: key) else { return }
        UserDefaults.standard.removeObject(forKey: key)
        // showBackgroundNotice, not showNotice: bind() replays the coordinator's
        // current .idle state a moment after launch, which repaints the pill and
        // would stomp a directly-shown notice.
        pill.showBackgroundNotice(
            "Smart transcription is back on — the model does the formatting itself now.",
            for: 5.0, sound: nil
        )
    }
}
