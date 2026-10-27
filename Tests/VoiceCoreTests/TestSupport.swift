import Foundation
import Testing
@testable import VoiceCore

/// Suites that read or write process-wide state: `UserDefaults.standard`
/// (behind `SettingsStore` and `DictionaryStore`) and the `BENTO_VOICE_RUNTIME`
/// environment variable (behind `VertexRuntimeConfig.state()`, `CleanupModels`
/// and most of `SettingsStore`). Swift Testing runs tests in parallel, so every
/// suite touching either is nested in this serialized parent.
@Suite(.serialized) enum SharedStateTests {}

/// Snapshots the standard-defaults keys a test may change and the runtime
/// config variable, clears the keys so every test starts from the defaults, and
/// puts both back on deinit. Until a test picks a runtime config it points at a
/// file that doesn't exist: left unset, the code under test would read this
/// Mac's real `voice-runtime.json`. The Gemini API key reads as stored, never
/// from this Mac's Keychain; `useAPIKey(false)` is a fresh install.
final class SharedStateGuard {
    /// Every key `SettingsStore` and `DictionaryStore` read or write.
    static let settingsKeys = [
        "assistantLiveCall", "assistantLiveProvider", "audioRetentionDays", "cleanupEnabled",
        "cleanupModelOverride", "customInstructions", "customInstructionsEnabled", "dictionaryEntries",
        "doubleTapLock", "dualEngines", "dualTranscription", "endpointOverride", "experimentalNoiseHandling",
        "gateTrips", "gptTranscription", "hasCompletedOnboarding", "hotkeyKey", "legacyTranscribeEndpoint",
        "liveTranscription", "lowercaseProse", "meetingCaptureSystemAudio", "meetingExcludesDictation",
        "meetingSummaryEnabled", "retryEngine", "retryShortcut", "showIdleIndicator", "singleTapHandsFree",
        "smartCleanupPass", "smartTranscription", "soundsEnabled", "transcribeModelOverride",
        "transcriptionBackend", "useDictationComposer",
    ]

    private let keys: [String]
    private let saved: [Any?]
    private let savedRuntime: String?
    private var files: [URL] = []

    init(keys: [String] = SharedStateGuard.settingsKeys) {
        self.keys = keys
        saved = keys.map { UserDefaults.standard.object(forKey: $0) }
        for key in keys { UserDefaults.standard.removeObject(forKey: key) }
        savedRuntime = ProcessInfo.processInfo.environment["BENTO_VOICE_RUNTIME"]
        useRuntimeConfig(nil)
        useAPIKey(true)
    }

    /// Whether `SettingsStore` sees a Gemini API key in the Keychain.
    func useAPIKey(_ stored: Bool) {
        SettingsStore.hasGeminiAPIKey = { stored }
    }

    /// Points `BENTO_VOICE_RUNTIME` at a temp file holding `json`, or at a
    /// missing file when `json` is nil.
    func useRuntimeConfig(_ json: String?) {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("bento-voice-runtime-\(UUID().uuidString).json")
        if let json {
            FileManager.default.createFile(atPath: url.path, contents: Data(json.utf8))
            files.append(url)
        }
        setenv("BENTO_VOICE_RUNTIME", url.path, 1)
    }

    deinit {
        for (key, value) in zip(keys, saved) {
            if let value { UserDefaults.standard.set(value, forKey: key) } else { UserDefaults.standard.removeObject(forKey: key) }
        }
        if let savedRuntime { setenv("BENTO_VOICE_RUNTIME", savedRuntime, 1) } else { unsetenv("BENTO_VOICE_RUNTIME") }
        SettingsStore.hasGeminiAPIKey = { KeychainStore.loadAPIKey() != nil }
        for url in files { try? FileManager.default.removeItem(at: url) }
    }
}

/// Runtime configs for the direct Vertex helper.
enum RuntimeConfigFixture {
    static let direct = #"{"transport":"direct","bifrost_base_url":"http://127.0.0.1:8767","bifrost_key":"test","project":"p","location":"global","model":"gemini-3.5-transcribe-preview"}"#

    /// The helper relaying Claude Haiku and GPT Luna for cleanup, Haiku by default.
    static let directWithRelayedCleanup = #"{"transport":"direct","bifrost_base_url":"http://127.0.0.1:8767","bifrost_key":"test","project":"p","location":"global","model":"gemini-3.5-transcribe-preview","relayed_cleanup_models":[{"id":"claude-haiku-5-5","name":"Claude Haiku"},{"id":"gpt-6-luna","name":"GPT-6 Luna"}],"default_cleanup_model":"claude-haiku-5-5"}"#
}

/// A private UserDefaults suite, emptied on init and deinit. Named per process
/// rather than per test, since every suite name leaves a plist behind, so a
/// suite using one must run its tests one at a time.
final class PrivateDefaults {
    let suiteName: String
    let defaults: UserDefaults

    init(_ name: String) {
        suiteName = "bento-voice-tests.\(name).\(getpid())"
        defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
    }

    deinit { defaults.removePersistentDomain(forName: suiteName) }
}

/// Collects values from callbacks that may arrive on any thread.
final class LockedBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value

    init(_ value: Value) { self.value = value }

    var current: Value {
        lock.lock(); defer { lock.unlock() }
        return value
    }

    func mutate(_ body: (inout Value) -> Void) {
        lock.lock(); defer { lock.unlock() }
        body(&value)
    }
}

/// The live probes call the real Gemini API, so they need the network and a
/// real key and never run in a normal build. Opt in with
/// `BENTO_VOICE_LIVE_PROBE=1 GEMINI_API_KEY=... scripts/test VoiceCoreTests`.
enum LiveProbe {
    static var optedIn: Bool { ProcessInfo.processInfo.environment["BENTO_VOICE_LIVE_PROBE"] == "1" }
    static var key: String? { ProcessInfo.processInfo.environment["GEMINI_API_KEY"] }
    /// `BENTO_VOICE_PROBE_AUDIO`, when it names a file that exists.
    static var audioPath: String? {
        ProcessInfo.processInfo.environment["BENTO_VOICE_PROBE_AUDIO"].flatMap {
            FileManager.default.fileExists(atPath: $0) ? $0 : nil
        }
    }
}
