import AppKit
import AVFoundation
import BentoCore
import SwiftUI
import VoiceCore

// Settings panes for Dictation, Meetings and the Assistant. Controls read
// SettingsStore on every render and write through its setters; the change
// notification re-renders, so a config.json edit never leaves a stale toggle.

/// Re-renders whenever a dictation setting changes, wherever it changed.
private final class SettingsRevision: ObservableObject {
    @Published var value = 0
    private var observers: [NSObjectProtocol] = []

    init() {
        for name in [Notification.Name.gtSettingDidChange, ActionRegistry.didReload] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.value += 1
            })
        }
    }

    deinit { observers.forEach(NotificationCenter.default.removeObserver) }
}

private func binding<T>(_ get: @escaping () -> T, _ set: @escaping (T) -> Void) -> Binding<T> {
    Binding(get: get, set: set)
}

private struct Footnote: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }
}

/// One row per action of the module, like every Bento pane.
private struct ModuleShortcuts: View {
    let moduleID: String
    let revision: Int

    var body: some View {
        let actions = ActionRegistry.shared.modules.first { $0.id == moduleID }?.actions ?? []
        ForEach(actions) { action in
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(action.title)
                    if let reason = ActionRegistry.shared.failureReason(for: action.id) {
                        Text(reason).font(.caption).foregroundStyle(.orange)
                    }
                }
                Spacer()
                ShortcutRecorder(actionID: action.id)
                    .id("\(action.id)-\(revision)")
            }
        }
    }
}

/// Microphone access: asked for on first use, shown here with a way to fix a denial.
struct MicrophoneRow: View {
    @State private var status = AVCaptureDevice.authorizationStatus(for: .audio)

    var body: some View {
        HStack {
            Image(systemName: status == .authorized ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                .foregroundStyle(status == .authorized ? .green : .orange)
            Text("Microphone")
            Spacer()
            switch status {
            case .authorized:
                Text("Granted").foregroundStyle(.secondary)
            case .notDetermined:
                Button("Allow…") {
                    AppActivation.activateSelf()
                    AVCaptureDevice.requestAccess(for: .audio) { _ in
                        DispatchQueue.main.async { status = AVCaptureDevice.authorizationStatus(for: .audio) }
                    }
                }
            default:
                Button("Open System Settings") {
                    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") {
                        NSWorkspace.shared.open(url)
                    }
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            status = AVCaptureDevice.authorizationStatus(for: .audio)
        }
    }
}

// MARK: - Dictation

struct DictationSettingsView: View {
    enum Tab: String, CaseIterable { case settings = "Settings", dictionary = "Dictionary" }
    /// Set before opening Settings when the Dictionary was asked for: the pane
    /// may not exist yet to hear `.voiceShowDictionary`.
    @MainActor static var showDictionaryNext = false
    @State private var tab = Tab.settings

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $tab) {
                ForEach(Tab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            .padding(.top, 4)
            .padding(.bottom, 8)
            switch tab {
            case .settings: DictationSettingsForm()
            case .dictionary: DictionaryView().padding(.horizontal, 12)
            }
        }
        .onAppear {
            if Self.showDictionaryNext { tab = .dictionary; Self.showDictionaryNext = false }
        }
        .onReceive(NotificationCenter.default.publisher(for: .voiceShowDictionary)) { _ in
            tab = .dictionary
            Self.showDictionaryNext = false
        }
    }
}

private struct DictationSettingsForm: View {
    typealias Engine = SettingsStore.TranscriptionEngine
    @StateObject private var revision = SettingsRevision()
    @State private var confirmingDelete = false

    private var settings: SettingsStore { SettingsStore() }
    private var runtime: VertexRuntimeConfig.State { VertexRuntimeConfig.state() }
    private var isDirect: Bool { runtime.config?.isDirect == true }
    /// The Bifrost transport is verbatim Gemini only: formatting has nowhere to run.
    private var verbatimOnly: Bool { runtime.isRequested && !isDirect }
    /// No runtime and no Gemini API key: Parakeet transcribes, and there is no
    /// cleanup model to format with.
    private var noCloud: Bool { !settings.cloudTranscriptionAvailable }

    var body: some View {
        let _ = revision.value
        Form {
            permissions
            keys
            transcription
            formatting
            sync
            feedback
            privacy
            advanced
            Section("Shortcuts") {
                ModuleShortcuts(moduleID: "dictation", revision: revision.value)
            }
            Section {
                EmptyView()
            } footer: {
                HStack(spacing: 4) {
                    Footnote("Dictation is based on Jot by Ammaar Reshi, Apache License 2.0.")
                    Link("Source", destination: VoiceLinks.repository).font(.caption)
                }
            }
        }
        .formStyle(.grouped)
    }

    // MARK: Permissions

    private var permissions: some View {
        Section {
            MicrophoneRow()
        } header: {
            Text("Permissions")
        } footer: {
            Footnote("Bento asks for the microphone the first time you dictate. Typing into other apps uses Accessibility, granted in General.")
        }
    }

    // MARK: Keys

    private var keys: some View {
        Section {
            Picker("Dictation key", selection: binding({ settings.hotkeyKey }, { settings.setHotkeyKey($0) })) {
                ForEach(HotkeyKey.allCases, id: \.self) { Text($0.displayName).tag($0) }
            }
            Toggle("Single tap for hands-free", isOn: binding({ settings.singleTapHandsFreeEnabled }, { settings.setSingleTapHandsFree($0) }))
            if !settings.singleTapHandsFreeEnabled {
                Toggle("Double-tap to lock hands-free", isOn: binding({ settings.doubleTapLockEnabled }, { settings.setDoubleTapLock($0) }))
            }
            Toggle("Dictation composer", isOn: binding({ settings.useDictationComposer }, { settings.setUseDictationComposer($0) }))
        } header: {
            Text("Dictation")
        } footer: {
            Footnote((settings.singleTapHandsFreeEnabled
                ? "Tap once for hands-free; tap again to stop. Hold for push-to-talk. Esc cancels."
                : "Hold to talk. Tap Space while holding to go hands-free. Esc cancels.")
                + " With ⌥F17 as the key, ⌥F18 edits your last dictation when you select it, or for 30 seconds while the caret is still after it; otherwise it talks to the assistant. The composer collects dictations in a floating draft before inserting.")
        }
    }

    // MARK: Transcription

    @ViewBuilder
    private var transcription: some View {
        if isDirect {
            Section {
                Picker("Transcribe with", selection: binding({ settings.transcriptionEngine }, { settings.setTranscriptionEngine($0) })) {
                    ForEach(Engine.singles, id: \.self) { Text($0.displayName).tag($0) }
                    Divider()
                    Text("Dual review").tag(Engine.dual)
                }
                Text(engineCaption(settings.transcriptionEngine)).font(.caption).foregroundStyle(.secondary)
                if settings.transcriptionEngine == .dual {
                    Picker("Pair", selection: binding({ settings.dualEngines }, { settings.setDualEngines($0) })) {
                        ForEach(Engine.dualPairs, id: \.self) { Text(Engine.pairName($0)).tag($0) }
                    }
                }
                localModelRow
                Picker("Retry with", selection: binding({ settings.retryEngine }, { settings.setRetryEngine($0) })) {
                    ForEach(Engine.singles, id: \.self) { Text($0.displayName).tag($0) }
                    Divider()
                    Text(settings.name(of: .dual)).tag(Engine.dual)
                }
            } header: {
                Text("Transcription")
            } footer: {
                Footnote("Switch quickly from Bento's menu. Meetings and the assistant follow GPT and MAI; with the others they stay on Gemini. Retry Last Transcription re-runs your last recording and replaces the text it inserted while the caret is still after it (or the text is selected); otherwise the new version goes to the clipboard.")
            }
        } else if !runtime.isRequested {
            Section {
                Picker("Transcribe with", selection: binding({ settings.transcriptionEngine }, { settings.setTranscriptionEngine($0) })) {
                    ForEach(settings.selectableEngines, id: \.self) { engine in
                        Text(engine.isLocal || !noCloud ? engine.displayName : "\(engine.displayName) (needs an API key)")
                            .tag(engine)
                            .selectionDisabled(!engine.isLocal && noCloud)
                    }
                }
                Text(engineCaption(settings.transcriptionEngine)).font(.caption).foregroundStyle(.secondary)
                localModelRow
            } header: {
                Text("Transcription")
            } footer: {
                Footnote((noCloud
                    ? "No Gemini API key yet, so dictation runs Parakeet v3 on this Mac. Add a key under Advanced to use Gemini."
                    : "Gemini through your API key, or Parakeet on this Mac. With Parakeet, meetings, voice editing and the assistant stay on Gemini.")
                    + " GPT, MAI, Dual review and retry need the local Vertex helper (see helper/README.md).")
            }
        } else {
            Section {
                LabeledContent("Backend") { Text("Gemini Transcribe").foregroundStyle(.secondary) }
            } header: {
                Text("Transcription")
            } footer: {
                if case .invalid = runtime {
                    Footnote("The helper runtime config is invalid, so dictation can't run until it's fixed; see Advanced.")
                } else {
                    Footnote("Vertex through the gateway transcribes word for word with Gemini. Other backends and retry need the direct helper runtime.")
                }
            }
        }
    }

    /// Download state for the on-device model dictation uses, either half of a dual pair included.
    @ViewBuilder
    private var localModelRow: some View {
        let engine = settings.transcriptionEngine
        if let local = engine == .dual ? settings.dualEngines.first(where: \.isLocal) : (engine.isLocal ? engine : nil) {
            ParakeetDownloadRow(engine: local)
        }
    }

    private func engineCaption(_ engine: Engine) -> String {
        switch engine {
        case .gemini: return isDirect ? "Vertex AI. Live previews; smart formatting in the same call."
            : "The Gemini API with your key. Smart formatting in the same call."
        case .parakeetV3: return "On this Mac. Fastest, nothing uploaded. A one-time \(ParakeetModels.downloadSize(of: engine)) download."
        case .parakeetUltra: return "On this Mac. Larger than v3 and usually cleaner. A one-time \(ParakeetModels.downloadSize(of: engine)) download."
        case .mai: return "OpenRouter. Most accurate in testing; dictionary terms go as hints."
        case .gpt: return "Azure. Word for word; the cleanup model formats."
        case .dual: return "Two recognisers, then Gemini 3.8 Flash listens and decides. Slower."
        }
    }

    // MARK: Formatting

    private var formatting: some View {
        let engine = settings.transcriptionEngine
        let cleanup = settings.cleanupEnabled
        return Section {
            Toggle(isOn: binding({ settings.smartTranscriptionEnabled }, { settings.setSmartTranscription($0) })) {
                Text("Smart transcription")
                Text(engine.isVerbatim
                     ? "Removes filler words and applies self-corrections. \(engine.shortName) is word for word, so this uses the cleanup pass."
                     : "Removes filler words and applies self-corrections in the transcription call itself.")
            }
            .disabled(verbatimOnly || noCloud || (engine.isVerbatim && !cleanup))
            Toggle(isOn: binding({ settings.cleanupEnabled }, { settings.setCleanupEnabled($0) })) {
                Text("Cleanup pass")
                Text("A second model over the transcript text. Off means no second call, whatever is below.")
            }
            .disabled(verbatimOnly || noCloud)
            Group {
                if isDirect {
                    Picker("Cleanup model", selection: binding({ settings.geminiConfig.cleanupModel }, { settings.setCleanupModelOverride($0) })) {
                        ForEach(CleanupModels.available, id: \.id) { Text($0.name).tag($0.id) }
                    }
                }
                Toggle(isOn: binding({ settings.smartCleanupPassEnabled }, { settings.setSmartCleanupPass($0) })) {
                    Text("Match tone to the app")
                    Text("Email reads like email, chat like chat.")
                }
                Toggle("Use custom instructions", isOn: binding({ settings.customInstructionsEnabled }, { settings.setCustomInstructionsEnabled($0) }))
                if settings.customInstructionsEnabled {
                    TextEditor(text: binding({ settings.customInstructions }, { settings.setCustomInstructions($0) }))
                        .font(.system(size: 12))
                        .frame(minHeight: 90, maxHeight: 160)
                        .accessibilityLabel("Custom instructions text")
                }
            }
            .disabled(verbatimOnly || noCloud || !cleanup)
        } header: {
            Text("Formatting")
        } footer: {
            Footnote(formattingFooter)
        }
    }

    /// Says whether the cleanup call actually happens.
    private var formattingFooter: String {
        if verbatimOnly { return "Formatting is unavailable on this transport." }
        if noCloud { return "Formatting runs on a cloud model, which needs a Gemini API key (Advanced). Until then Parakeet's words go in as heard." }
        let engine = settings.transcriptionEngine
        if !settings.cleanupEnabled { return "No cleanup call is made. Tone and instructions keep their settings for when you turn it back on." }
        if engine == .dual { return "Dual review applies smart formatting, tone and instructions in its review call; there is no separate cleanup call." }
        if settings.formattingPolicy.cleanupPass { return "Each dictation's text goes to the cleanup model after transcribing, adding about a second." }
        return "Nothing needs the cleanup pass right now, so no call is made."
    }

    // MARK: Sync

    private var sync: some View {
        Section {
            Toggle("Sync dictionary and instructions", isOn: binding({ settings.syncDictionary }, { settings.setSyncDictionary($0) }))
            VoiceSyncStatusRow(wanted: settings.syncDictionary)
        } header: {
            Text("Sync")
        } footer: {
            Footnote("The dictionary, custom instructions and the cleanup pass switch sync with your other Macs and the Bento Android app, through the Notes sync server and token (Settings → Notes).")
        }
    }

    // MARK: Feedback

    private var feedback: some View {
        Section {
            Toggle("Sounds", isOn: binding({ settings.soundsEnabled }, { settings.setSoundsEnabled($0) }))
            Toggle(isOn: binding({ settings.showIdleIndicator }, { settings.setShowIdleIndicator($0) })) {
                Text("Resting indicator")
                Text("A dot at the bottom of the screen that grows into a Dictate button on hover.")
            }
            LabeledContent {
                Button("Reset Position") { NotificationCenter.default.post(name: .pillPositionReset, object: nil) }
            } label: {
                Text("Indicator position")
                Text("Drag the indicator to move it; it stays where you leave it.")
            }
        } header: {
            Text("Feedback")
        }
    }

    // MARK: Privacy

    private var audioDestination: String {
        switch settings.transcriptionEngine {
        case .gpt: return "Azure GPT Transcribe"
        case .mai: return "MAI-Transcribe-2 through OpenRouter"
        case .parakeetV3, .parakeetUltra: return "Nowhere: Parakeet runs on this Mac"
        case .dual:
            let pair = settings.dualEngines
            let cloud = pair.filter { !$0.isLocal }.map { $0 == .gemini ? "Vertex AI" : $0.displayName }.joined(separator: " and ")
            return pair.allSatisfy(\.isLocal) ? "Nowhere for drafts; Gemini 3.8 Flash hears it for review"
                : cloud + ", and Gemini 3.8 Flash for review"
        case .gemini: return runtime.isRequested ? "Vertex AI, through the local helper" : "The Gemini API with your key"
        }
    }

    private var privacy: some View {
        Section {
            Picker(selection: binding({ settings.audioRetentionDays }, { days in
                settings.setAudioRetentionDays(days)
                Task.detached(priority: .utility) { RetentionPolicy(audioRetentionDays: days).purgeExpiredAudio() }
            })) {
                Text("Never").tag(-1)
                Text("24 hours").tag(1)
                Text("7 days").tag(7)
                Text("30 days").tag(30)
                Text("Forever").tag(0)
            } label: {
                Text("Keep recordings")
                Text("Retry needs the recording.")
            }
            LabeledContent("Audio goes to") { Text(audioDestination).foregroundStyle(.secondary).multilineTextAlignment(.trailing) }
            HStack {
                Button("Dictation History…") { VoiceApp.current?.openHistory() }
                Spacer()
                Button("Delete All History…", role: .destructive) { confirmingDelete = true }
                    .confirmationDialog("Delete all dictation history? Audio and transcripts will be removed from this Mac.",
                                        isPresented: $confirmingDelete) {
                        Button("Delete Everything", role: .destructive) {
                            VoiceApp.current?.dictation.historyPages.onDeleteAllHistory()
                        }
                    }
            }
        } header: {
            Text("Privacy & storage")
        } footer: {
            Footnote("Transcripts stay in History until you delete them. Recordings and the index live in \(FileLayout.appSupportRoot.path.replacingOccurrences(of: NSHomeDirectory(), with: "~")). The OpenRouter and Azure keys stay with the local helper.")
        }
    }

    // MARK: Advanced

    private var advanced: some View {
        Section {
            Toggle(isOn: binding({ settings.liveTranscriptionActive }, { enabled in
                settings.setLiveTranscription(enabled)
                if enabled { LiveStats().clearStreak() }
            })) {
                Text("Live transcription")
                Text(liveCaption)
            }
            .disabled(verbatimOnly || settings.transcriptionEngine != .gemini
                      || (settings.usesLegacyTranscribeEndpoint && !isDirect))
            Toggle(isOn: binding({ settings.experimentalNoiseHandling }, { settings.setExperimentalNoiseHandling($0) })) {
                Text("Better hearing in loud rooms")
                Text("Judges your voice against the room's actual noise.")
            }
            switch runtime {
            case .configured(let config):
                LabeledContent("Runtime") {
                    Text(config.isDirect ? "Local Vertex helper" : "Vertex through a gateway").foregroundStyle(.secondary)
                }
                LabeledContent("Project") {
                    Text("\(config.project) · \(config.location)").font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
                }
            case .invalid(let reason):
                LabeledContent("Runtime") {
                    VStack(alignment: .trailing) {
                        Text("Invalid").foregroundStyle(.red)
                        Text(reason).font(.caption).foregroundStyle(.secondary)
                    }
                }
            case .notConfigured:
                GeminiKeyRows()
            }
        } header: {
            Text("Advanced")
        } footer: {
            Footnote("The helper runtime is \(VertexRuntimeConfig.defaultURL.path.replacingOccurrences(of: NSHomeDirectory(), with: "~")); without it Bento uses the Gemini API with your own key.")
        }
    }

    private var liveCaption: String {
        if settings.transcriptionEngine != .gemini { return "Gemini only: streams while you speak." }
        if let summary = LiveStats().summary { return "Streams while you speak and falls back to upload if it stumbles. \(summary)" }
        return "Streams while you speak and falls back to upload if it stumbles."
    }
}

/// Where the voice documents' sync stands, like the Notes and Todo status rows.
private struct VoiceSyncStatusRow: View {
    let wanted: Bool

    var body: some View {
        if let sync = VoiceApp.current?.voiceSync {
            Row(sync: sync, status: sync.status, wanted: wanted)
        } else {
            LabeledContent("Status") { Text("Dictation is off").foregroundStyle(.secondary) }
        }
    }

    private struct Row: View {
        let sync: VoiceSync
        @ObservedObject var status: FieldSyncStatus
        let wanted: Bool

        var body: some View {
            let notes = VoiceSync.notesSync
            LabeledContent("Status") {
                HStack(spacing: 8) {
                    if !wanted {
                        Text("Off").foregroundStyle(.secondary)
                    } else if !notes.enabled || !notes.hasServer {
                        Text("Turn on sync in Settings → Notes").foregroundStyle(.secondary)
                    } else {
                        Image(systemName: status.symbol)
                            .foregroundStyle(status.isHealthy ? Color.secondary : Color.orange)
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(status.summary)
                            if let last = status.lastSync {
                                Text("Last sync \(last.formatted(.relative(presentation: .named)))")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            if let err = status.lastError, !status.isHealthy {
                                Text(err).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            }
                        }
                        Button("Sync Now") { sync.syncNow() }
                    }
                }
            }
        }
    }
}

/// Whether a Parakeet model is on this Mac, with the button that fetches it.
private struct ParakeetDownloadRow: View {
    let engine: SettingsStore.TranscriptionEngine
    @ObservedObject private var models = ParakeetModels.shared

    var body: some View {
        HStack(spacing: 8) {
            switch models.status(engine) {
            case .ready:
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                Text("\(engine.displayName) is downloaded")
                Spacer()
                Button("Show in Finder") {
                    NSWorkspace.shared.activateFileViewerSelecting([ParakeetModels.cacheDirectory(of: engine)])
                }
            case .notDownloaded:
                Image(systemName: "arrow.down.circle").foregroundStyle(.orange)
                Text("Not downloaded yet")
                Spacer()
                Button("Download \(engine.displayName) (~\(ParakeetModels.downloadSize(of: engine)))") { models.download(engine) }
                    .buttonStyle(.borderedProminent)
            case .downloading(let fraction):
                VStack(alignment: .leading, spacing: 4) {
                    Text(models.progressLine(engine) ?? "")
                    if let fraction { ProgressView(value: fraction) } else { ProgressView().progressViewStyle(.linear) }
                }
            case .failed(let reason):
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Download failed")
                    Text(reason).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                Spacer()
                Button("Retry") { models.download(engine) }
            }
        }
    }
}

/// The public Gemini API key, only for installs without the helper runtime.
private struct GeminiKeyRows: View {
    @State private var apiKey = ""
    @State private var status = APIKeyStore.loadAPIKey() == nil ? "No key stored" : "Key stored"
    @State private var checking = false
    @State private var model = SettingsStore().transcribeModelOverride ?? ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Gemini API key")
            HStack {
                SecureField("Paste your key", text: $apiKey).textFieldStyle(.roundedBorder).font(.system(size: 12, design: .monospaced))
                Button("Save") { save() }.disabled(checking || apiKey.trimmingCharacters(in: .whitespaces).isEmpty)
                if APIKeyStore.loadAPIKey() != nil {
                    Button("Remove", role: .destructive) {
                        APIKeyStore.deleteAPIKey()
                        status = "No key stored"
                    }
                }
            }
            HStack {
                Text(checking ? "Checking…" : status).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Link("Get a key", destination: URL(string: "https://aistudio.google.com/apikey")!).font(.caption)
            }
            TextField("Transcription model", text: $model, prompt: Text(GeminiConfig().transcribeModel))
                .textFieldStyle(.roundedBorder).font(.system(size: 12, design: .monospaced))
                .onChange(of: model) { _, value in
                    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                    SettingsStore().setTranscribeModelOverride(trimmed.isEmpty ? nil : trimmed)
                }
            Text("Preview models get renamed; override here if one 404s.").font(.caption).foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }

    private func save() {
        let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        checking = true
        Task {
            let check = await GeminiClient(apiKey: { key }).validateKey(endpoint: SettingsStore().geminiConfig.endpoint)
            checking = false
            switch check {
            case .valid, .unreachable:
                if APIKeyStore.saveAPIKey(key) {
                    apiKey = ""
                    status = check == .valid ? "Key saved and valid" : "Key saved; it will be checked on your first dictation"
                } else {
                    status = "Couldn't save the key. Try again."
                }
            case .rejected:
                status = "That key didn't work; your saved key is unchanged."
            }
        }
    }
}

// MARK: - Meetings

struct MeetingsSettingsView: View {
    @StateObject private var revision = SettingsRevision()
    private var settings: SettingsStore { SettingsStore() }

    var body: some View {
        let _ = revision.value
        Form {
            Section {
                MicrophoneRow()
            } header: {
                Text("Permissions")
            } footer: {
                Footnote("Including system audio asks once for System Audio Recording (System Settings → Privacy & Security → Screen & System Audio Recording). Without it, meetings record the microphone only.")
            }
            Section {
                Toggle(isOn: binding({ settings.meetingCaptureSystemAudio }, { settings.setMeetingCaptureSystemAudio($0) })) {
                    Text("Include system audio")
                    Text("The other side of calls, through headphones too. Bento's own sounds are left out.")
                }
                Toggle("Summarize when a meeting ends", isOn: binding({ settings.meetingSummaryEnabled }, { settings.setMeetingSummaryEnabled($0) }))
                Toggle(isOn: binding({ settings.meetingExcludesDictation }, { settings.setMeetingExcludesDictation($0) })) {
                    Text("Keep dictation out of meeting notes")
                    Text("Dictation, voice requests and assistant calls silence the microphone part of the mix.")
                }
            } header: {
                Text("Recording")
            } footer: {
                Footnote("A small capsule shows while a meeting records: hover it for the latest line, Notes, Pause and Stop. Sleep pauses a meeting; quitting finishes the notes at the next launch.")
            }
            Section {
                HStack {
                    Button("Meetings…") { VoiceApp.current?.openMeetings() }
                    Button(VoiceApp.current?.meetings?.isActive == true ? "Stop Recording" : "Record Meeting") {
                        VoiceApp.current?.meetings?.toggle()
                    }
                    Spacer()
                    Button("Show in Finder") {
                        NSWorkspace.shared.activateFileViewerSelecting([MeetingStore.root])
                    }
                }
            } footer: {
                Footnote("Notes, transcripts and audio are in \(MeetingStore.root.path.replacingOccurrences(of: NSHomeDirectory(), with: "~")).")
            }
            Section("Shortcuts") {
                ModuleShortcuts(moduleID: "meetings", revision: revision.value)
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - Assistant

struct AssistantSettingsView: View {
    @StateObject private var revision = SettingsRevision()
    private var settings: SettingsStore { SettingsStore() }

    private var hermesPython: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".hermes/hermes-agent/venv/bin/python")
    }

    var body: some View {
        let _ = revision.value
        let provider = settings.assistantLiveProvider
        let geminiRoute = settings.geminiLiveRoute
        Form {
            Section {
                Picker(selection: binding({ settings.assistantLiveCall ? provider.rawValue : "off" }, { choice in
                    // Off keeps the provider, so turning calls back on returns to it.
                    if let chosen = SettingsStore.AssistantLiveProvider(rawValue: choice) { settings.setAssistantLiveProvider(chosen) }
                    settings.setAssistantLiveCall(choice != "off")
                })) {
                    Text("Off").tag("off")
                    Divider()
                    ForEach(SettingsStore.AssistantLiveProvider.allCases, id: \.self) { Text($0.displayName).tag($0.rawValue) }
                } label: {
                    Text("Voice calls")
                    if provider == .gemini, settings.assistantLiveCall, case .unavailable(let reason) = geminiRoute {
                        Text(reason)
                    } else {
                        Text("Off gives ⌥F18 back to voice editing and one-shot requests.")
                    }
                }
                if provider == .gemini, settings.assistantLiveCall {
                    Picker(selection: binding({ settings.assistantLiveStandbySeconds }, { settings.setAssistantLiveStandbySeconds($0) })) {
                        Text("Never").tag(0)
                        ForEach([10, 20, 30, 60, 120], id: \.self) { seconds in
                            Text(seconds < 60 ? "After \(seconds) s" : "After \(seconds / 60) min").tag(seconds)
                        }
                    } label: {
                        Text("Pause Gemini while Hermes works")
                        Text("A call waiting on Hermes with nobody speaking leaves Gemini, which bills by the second, and comes back to speak the answer.")
                    }
                }
                MicrophoneRow()
            } header: {
                Text("Voice")
            } footer: {
                Footnote("⌥F18 starts or ends a call (or dictates a request when calls are off). \(dictateHint) Calls stream your microphone to \(callDestination(provider, geminiRoute)) until you end them, and the assistant runs tools without asking. Use headphones: there is no echo cancellation. Gemini Live uses dictation's Google connection, the Gemini API with your key or Vertex AI through the local helper; GPT-Live is Azure either way.")
            }
            Section {
                LabeledContent("Hermes") {
                    let found = FileManager.default.isExecutableFile(atPath: hermesPython.path)
                    Text(found ? "~/.hermes/hermes-agent" : "Not found in ~/.hermes/hermes-agent")
                        .foregroundStyle(found ? Color.secondary : Color.orange)
                }
                HStack {
                    Button("Open Assistant") { VoiceApp.current?.dictation.openAssistant() }
                    Button("New Conversation") { VoiceApp.current?.dictation.newAssistantChat() }
                }
            } header: {
                Text("Chat")
            } footer: {
                Footnote("The assistant is Hermes over ACP. Its model, effort and model list come from the bento_voice section of ~/.hermes/config.yaml (jot_voice is read too); the chat window's pickers apply to Bento's Hermes process only. In the window, ⌘K opens the palette and ⌘/ lists every shortcut.")
            }
            Section {
                Toggle(isOn: binding({ settings.assistantKeepOnTop }, { settings.setAssistantKeepOnTop($0) })) {
                    Text("Keep on top (picture in picture)")
                    Text("Off, the window floats over the Space it opened on and stays behind when you switch Spaces.")
                }
            } header: {
                Text("Window")
            } footer: {
                Footnote("The chat window stays above every app, on every Space and over full-screen apps, until you hide it (⇧⌥F18 or Esc). Typing in it doesn't switch away from the app in front. VoiceOver works best with this off.")
            }
            Section("Shortcuts") {
                ModuleShortcuts(moduleID: "assistant", revision: revision.value)
            }
        }
        .formStyle(.grouped)
    }

    /// The Dictate to Assistant shortcut as bound now (it's rebindable below).
    private var dictateHint: String {
        let key = ActionRegistry.shared.shortcut(for: AssistantModule.dictateID).map { " (\($0.displayString))" } ?? ""
        return "Dictate to Assistant\(key) always sends what you say as a request, calls or not: hold to talk, or tap, speak and press again."
    }

    private func callDestination(_ provider: SettingsStore.AssistantLiveProvider, _ route: SettingsStore.GeminiLiveRoute) -> String {
        guard provider == .gemini else { return "Azure" }
        switch route {
        case .vertexHelper: return "Vertex AI"
        case .geminiAPI: return "the Gemini API"
        // Where calls would go once they can start: a gateway or broken runtime file is Vertex.
        case .unavailable: return VertexRuntimeConfig.state().isRequested ? "Vertex AI" : "the Gemini API"
        }
    }
}
