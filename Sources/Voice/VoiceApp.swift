import AppKit
import AVFoundation
import BentoCore
import CoreAudio
import SwiftUI
import VoiceCore

/// What the menu bar glyph used to show; now the menu's status line and the
/// dictation pill carry it.
enum VoiceIndicator: Equatable {
    case idle
    case listening
    case processing
    case attention
}

enum VoiceFeature: String, CaseIterable {
    case dictation, meetings, assistant
}

extension Notification.Name {
    /// Asks an open Dictation settings pane to show the Dictionary.
    static let voiceShowDictionary = Notification.Name("BentoVoiceShowDictionary")
}

/// Builds and wires dictation, meetings, the assistant and on-device speech:
/// one instance behind the Dictation, Meetings and Assistant modules, created
/// when the first of them starts. The modules switch their parts on and off.
@MainActor
final class VoiceApp {
    private static var instance: VoiceApp?

    /// The running instance, created on first use.
    static var shared: VoiceApp {
        if let instance { return instance }
        let app = VoiceApp()
        instance = app
        app.start()
        return app
    }

    /// The running instance, without creating one (menus, diagnostics).
    static var current: VoiceApp? { instance }

    let dictation: DictationController
    private(set) var meetings: MeetingController?
    private let settingsSync = SettingsSync()
    private(set) var statusLine = "Starting up…"
    private(set) var indicator: VoiceIndicator = .idle
    private(set) var meetingState: MeetingController.MenuState = .idle
    private(set) var enabled: Set<VoiceFeature> = []
    private var historyWindow: VoiceWindowController?
    private var meetingsWindow: VoiceWindowController?
    private var observers: [NSObjectProtocol] = []
    private var accessibilityGranted = AXIsProcessTrusted()
    private let recognizer = ParakeetRecognizer()

    private init() {
        // Before anything reads settings: Bento's config.json may change them.
        settingsSync.start()
        FontLoader.registerBundledFonts()
        dictation = DictationController()
        dictation.onStatusChange = { [weak self] status in self?.statusLine = status }
        dictation.onStatusItemState = { [weak self] state in self?.indicator = state }
        dictation.onOpenHistory = { [weak self] in self?.openHistory() }
    }

    private func start() {
        dictation.start()
        startMeetings()
        startLocalSpeech()
        if ProcessInfo.processInfo.environment["BENTO_DEV"] != nil { observeDevCommands() }
        // Accessibility granted in Settings → General after launch: start the tap.
        observers.append(NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.checkAccessibility() }
        })
    }

    /// Meetings record beside dictation: their own capture and sockets, and
    /// the pill for notices.
    private func startMeetings() {
        let meetings = MeetingController(coordinator: dictation.coordinator)
        meetings.onNotice = { [weak dictation] message in dictation?.showMeetingNotice(message) }
        meetings.onMenuState = { [weak self] state in self?.meetingState = state }
        dictation.onAssistantLiveCall = { [weak meetings] active in meetings?.setAssistantCallActive(active) }
        self.meetings = meetings
    }

    /// Installs the on-device recogniser. The selected model loads ahead of the
    /// first dictation (when Dictation switches on), again whenever the selection changes.
    private func startLocalSpeech() {
        LocalSpeech.recognizer = recognizer
        observers.append(NotificationCenter.default.addObserver(forName: .gtSettingDidChange, object: nil, queue: .main) { [weak self] note in
            guard ["transcriptionBackend", "dualTranscription", "dualEngines"].contains(note.object as? String ?? "") else { return }
            MainActor.assumeIsolated { self?.prepareLocalSpeech() }
        })
    }

    /// Only the dictation engine is preloaded; one model stays in memory, so a
    /// Parakeet retry or dual draft loads on demand.
    private func prepareLocalSpeech() {
        guard enabled.contains(.dictation) else { return }
        let settings = SettingsStore()
        let engine = settings.transcriptionEngine
        guard let model = engine == .dual ? settings.dualEngines.first(where: \.isLocal)?.rawValue : settings.localTranscriptionModel else { return }
        let recognizer = recognizer
        Task.detached(priority: .utility) { try? await recognizer.prepare(model: model) }
    }

    private func checkAccessibility() {
        let granted = AXIsProcessTrusted()
        guard granted != accessibilityGranted else { return }
        accessibilityGranted = granted
        if granted { NotificationCenter.default.post(name: .gtSettingDidChange, object: "accessibility") }
    }

    // MARK: Modules

    func setEnabled(_ feature: VoiceFeature, _ on: Bool) {
        let was = enabled
        if on { enabled.insert(feature) } else { enabled.remove(feature) }
        guard enabled != was else { return }
        if feature == .meetings {
            if on, !meetingsRecovered {
                // Finish the notes of meetings a quit or crash interrupted, once.
                meetings?.recoverAtLaunch()
                meetingsRecovered = true
            } else if !on {
                // Save where things stand, as at quit, then stop the recording; its
                // notes finish in the background (at quit they finish at next launch).
                meetings?.prepareForTermination()
                meetings?.stop()
                meetingsWindow?.close()
            }
        }
        if feature == .dictation { if on { prepareLocalSpeech() } else { historyWindow?.close() } }
        dictation.setEnabled(dictation: enabled.contains(.dictation), assistant: enabled.contains(.assistant))
        if enabled.isEmpty { settingsSync.flush() }
    }

    private var meetingsRecovered = false

    // MARK: Windows

    func openHistory() {
        guard enabled.contains(.dictation) else { return }
        if historyWindow == nil {
            let pages = dictation.historyPages
            historyWindow = VoiceWindowController(title: "Dictation History", autosaveName: "BentoDictationHistory",
                                                  size: NSSize(width: 720, height: 640)) {
                AnyView(HistoryWindowContent(pages: pages))
            } onClose: { [weak self] in self?.historyWindow = nil }
        }
        historyWindow?.present()
    }

    func openMeetings() {
        guard enabled.contains(.meetings), let meetings else { return }
        if meetingsWindow == nil {
            meetingsWindow = VoiceWindowController(title: "Meetings", autosaveName: "BentoMeetings",
                                                   size: NSSize(width: 860, height: 640)) {
                AnyView(MeetingsPane(controller: meetings, recorder: meetings.recorder))
            } onClose: { [weak self] in self?.meetingsWindow = nil }
        }
        meetingsWindow?.present()
    }

    /// Dev harness only: `com.charles.bento.dev.voice` with object = BENTO_HOME and
    /// userInfo {command, …} drives the assistant headlessly; the result goes to
    /// <support>/voice-dev.json.
    private func observeDevCommands() {
        let home = ProcessInfo.processInfo.environment["BENTO_HOME"] ?? ""
        observers.append(DistributedNotificationCenter.default().addObserver(
            forName: Notification.Name("com.charles.bento.dev.voice"), object: home, queue: .main) { [weak self] note in
            MainActor.assumeIsolated {
                guard let self, let info = note.userInfo, let command = info["command"] as? String else { return }
                var state = self.diagnostics()
                if command.hasPrefix("assistant.") {
                    state["assistant"] = self.dictation.devAssistant(String(command.dropFirst("assistant.".count)), info)
                }
                if command == "capture" { self.dictation.devCapture(info["text"] as? String ?? "") }
                if let data = try? JSONSerialization.data(withJSONObject: state, options: [.prettyPrinted, .sortedKeys]) {
                    try? data.write(to: AppPaths.supportDir.appendingPathComponent("voice-dev.json"), options: .atomic)
                }
            }
        })
    }

    func diagnostics() -> [String: Any] {
        [
            "status": statusLine,
            "indicator": String(describing: indicator),
            "enabled": enabled.map(\.rawValue).sorted(),
            "meeting": String(describing: meetingState),
            "microphone": AVCaptureDevice.authorizationStatus(for: .audio).rawValue,
            "runtime": VertexRuntimeConfig.state().isRequested,
        ]
    }
}

// MARK: - Menus

extension VoiceApp {
    /// The Dictation submenu: what Jot's own menu offered, minus what Bento's menu already has.
    func dictationMenu(_ action: (String) -> NSMenuItem) -> NSMenu {
        let menu = NSMenu()
        let status = NSMenuItem(title: statusLine, action: nil, keyEquivalent: "")
        status.isEnabled = false
        menu.addItem(status)
        menu.addItem(.separator())
        menu.addItem(action("dictation.hands-free"))
        menu.addItem(action("dictation.capture-note"))
        menu.addItem(action("dictation.compose"))
        menu.addItem(.separator())
        menu.addItem(action("dictation.paste-last"))

        let settings = SettingsStore()
        let direct = VertexRuntimeConfig.state().config?.isDirect == true
        if direct {
            let retry = action("dictation.retry-last")
            retry.title = "Retry Last with \(settings.name(of: settings.retryEngine))"
            retry.image = NSImage(systemSymbolName: "arrow.uturn.backward", accessibilityDescription: nil)
            menu.addItem(retry)
            let retryWith = NSMenuItem(title: "Retry Last With", action: nil, keyEquivalent: "")
            let retryMenu = NSMenu()
            for engine in SettingsStore.TranscriptionEngine.singles + [.dual] {
                retryMenu.addItem(ClosureMenuItem(title: settings.name(of: engine)) { [weak self] in
                    self?.dictation.retryLast(with: engine)
                })
            }
            retryWith.submenu = retryMenu
            menu.addItem(retryWith)

            // One-click backend switching. Only the direct runtime can reach more than Gemini.
            menu.addItem(.separator())
            menu.addItem(NSMenuItem.sectionHeader(title: "Transcription"))
            let current = settings.transcriptionEngine
            for engine in SettingsStore.TranscriptionEngine.singles {
                let item = ClosureMenuItem(title: engine.displayName) { SettingsStore().setTranscriptionEngine(engine) }
                item.image = NSImage(systemSymbolName: engine.isLocal ? "laptopcomputer" : "cloud", accessibilityDescription: nil)
                item.state = engine == current ? .on : .off
                menu.addItem(item)
            }
            let dual = NSMenuItem(title: current == .dual ? settings.name(of: .dual) : "Dual Review", action: nil, keyEquivalent: "")
            dual.image = NSImage(systemSymbolName: "square.on.square", accessibilityDescription: nil)
            dual.state = current == .dual ? .on : .off
            let pairs = NSMenu()
            let selectedPair = settings.dualEngines
            for pair in SettingsStore.TranscriptionEngine.dualPairs {
                let item = ClosureMenuItem(title: SettingsStore.TranscriptionEngine.pairName(pair)) {
                    let settings = SettingsStore()
                    settings.setDualEngines(pair)
                    settings.setTranscriptionEngine(.dual)
                }
                item.state = current == .dual && Set(pair) == Set(selectedPair) ? .on : .off
                pairs.addItem(item)
            }
            dual.submenu = pairs
            menu.addItem(dual)
        }

        menu.addItem(.separator())
        menu.addItem(microphoneItem())
        menu.addItem(action("dictation.history"))
        menu.addItem(ClosureMenuItem(title: "Dictation Settings…") { SettingsRouter.open("dictation") })
        return menu
    }

    /// Which mic Bento hears through: moves the system default input, exactly
    /// like Control Center, so AirPods vs built-in is one click. Filled when the
    /// submenu opens: CoreAudio can stall while a device connects, and that
    /// mustn't hold up Bento's whole menu.
    private func microphoneItem() -> NSMenuItem {
        let item = NSMenuItem(title: "Microphone", action: nil, keyEquivalent: "")
        let menu = NSMenu()
        menu.delegate = MicrophoneMenu.shared
        menu.addItem(NSMenuItem(title: "…", action: nil, keyEquivalent: ""))
        item.submenu = menu
        return item
    }

    func meetingsMenu(_ action: (String) -> NSMenuItem) -> NSMenu {
        let menu = NSMenu()
        let toggle = action("meetings.toggle")
        switch meetingState {
        case .idle:
            toggle.title = "Record Meeting"
            toggle.image = NSImage(systemSymbolName: "record.circle", accessibilityDescription: nil)
            menu.addItem(toggle)
        case .recording(let paused):
            toggle.title = "Stop Meeting Recording"
            toggle.image = NSImage(systemSymbolName: "stop.circle", accessibilityDescription: nil)
            menu.addItem(toggle)
            let pause = action("meetings.pause")
            pause.title = paused ? "Resume Meeting Recording" : "Pause Meeting Recording"
            menu.addItem(pause)
            menu.addItem(action("meetings.notes"))
        }
        menu.addItem(.separator())
        menu.addItem(action("meetings.show"))
        menu.addItem(ClosureMenuItem(title: "Meeting Settings…") { SettingsRouter.open("meetings") })
        return menu
    }

    func assistantMenu(_ action: (String) -> NSMenuItem) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false // the call item is off while calls are off
        menu.addItem(action("assistant.toggle"))
        let call = action("assistant.voice-call")
        let settings = SettingsStore()
        if dictation.assistantIsLive {
            call.title = "End Voice Call"
        } else if settings.assistantLiveCall {
            call.title = "Start \(settings.assistantLiveProvider.displayName) Call"
        }
        call.isEnabled = settings.assistantLiveCall || dictation.assistantIsLive
        menu.addItem(call)
        menu.addItem(action("assistant.new"))
        menu.addItem(.separator())
        menu.addItem(ClosureMenuItem(title: "Assistant Settings…") { SettingsRouter.open("assistant") })
        return menu
    }
}

/// Lists input devices when the Microphone submenu opens.
private final class MicrophoneMenu: NSObject, NSMenuDelegate {
    static let shared = MicrophoneMenu()

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let current = AudioInputDevices.currentDefaultID()
        let devices = AudioInputDevices.list()
        if devices.isEmpty {
            let none = NSMenuItem(title: "No microphones found", action: nil, keyEquivalent: "")
            none.isEnabled = false
            menu.addItem(none)
            return
        }
        for device in devices {
            let row = ClosureMenuItem(title: device.name) { _ = AudioInputDevices.setDefault(id: device.id) }
            row.state = device.id == current ? .on : .off
            menu.addItem(row)
        }
        menu.addItem(.separator())
        let note = NSMenuItem(title: "Sets your Mac's input device", action: nil, keyEquivalent: "")
        note.isEnabled = false
        menu.addItem(note)
    }
}
