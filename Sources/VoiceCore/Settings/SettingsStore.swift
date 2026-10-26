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

public extension Notification.Name {
    /// Posted after any SettingsStore write and after Keychain API-key writes,
    /// with `object` = the key ("showIdleIndicator", "apiKey", …). Runtime
    /// surfaces that render a setting (pill, status line, hotkey engine) observe
    /// this so toggles take effect the moment they're flipped — never "on the
    /// next unrelated transition". (gateTrips bookkeeping is exempt: nothing
    /// renders it.)
    static let gtSettingDidChange = Notification.Name("com.charles.bento.voice.setting-changed")

    /// Posted when the gate auto-disables the opt-in tone pass (3 trips in 24h)
    /// so the app can tell the user instead of silently dropping it. Native smart
    /// transcription is unaffected — the user loses an extra, not their words.
    static let gtSmartFormattingAutoDegraded = Notification.Name("com.charles.bento.voice.auto-degraded")
}

/// UserDefaults-backed settings (M3 minimal; the Settings UI lands at M7).
/// Endpoint + model IDs are overridable because preview models get renamed.
public struct SettingsStore: Sendable {
    private static let defaults = UserDefaults.standard
    /// Set for one-off runs such as Retry Last Transcription: every engine-derived
    /// setting (models, policy, dual drafts) follows it instead of the saved choice.
    private var engineOverride: TranscriptionEngine?

    public init(engine: TranscriptionEngine) {
        self.init()
        engineOverride = engine
    }

    public init() {
        if Self.defaults.object(forKey: "lowercaseProse") != nil {
            if Self.defaults.string(forKey: "customInstructions") == nil,
               Self.defaults.bool(forKey: "lowercaseProse") {
                Self.defaults.set(Self.lowercaseInstructions, forKey: "customInstructions")
                Self.defaults.set(true, forKey: "customInstructionsEnabled")
            }
            Self.defaults.removeObject(forKey: "lowercaseProse")
        }
    }

    private static func set(_ value: Any?, forKey key: String) {
        defaults.set(value, forKey: key)
        NotificationCenter.default.post(name: .gtSettingDidChange, object: key)
    }

    /// Assistant shortcut/button starts and ends a call; legacy one-shot is opt-out.
    public var assistantLiveCall: Bool {
        Self.defaults.object(forKey: "assistantLiveCall") as? Bool ?? true
    }

    public func setAssistantLiveCall(_ enabled: Bool) {
        Self.set(enabled, forKey: "assistantLiveCall")
    }

    /// Which voice model answers a call. Gemini goes through the direct Vertex helper.
    public enum AssistantLiveProvider: String, CaseIterable, Sendable {
        case gpt
        case gemini

        public var displayName: String {
            switch self {
            case .gpt: return "Azure GPT-Live"
            case .gemini: return "Gemini 3.8 Live"
            }
        }
    }

    /// An unknown value (a newer Mac's synced config.json) keeps GPT-Live, the original call.
    public var assistantLiveProvider: AssistantLiveProvider {
        Self.defaults.string(forKey: "assistantLiveProvider").flatMap(AssistantLiveProvider.init(rawValue:)) ?? .gpt
    }

    public func setAssistantLiveProvider(_ provider: AssistantLiveProvider) {
        Self.set(provider.rawValue, forKey: "assistantLiveProvider")
    }

    /// Single source of truth for endpoint-override validity — the Settings UI
    /// warning and the effective config MUST use the same predicate, or one of
    /// them lies about which endpoint is in use.
    public static func usableEndpointURL(_ raw: String?) -> URL? {
        guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty,
              let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme) else {
            return nil
        }
        return url
    }

    /// True once the user finished onboarding — a deliberate "I'll add it later"
    /// must not re-trap them in the wizard every launch.
    public var hasCompletedOnboarding: Bool {
        Self.defaults.bool(forKey: "hasCompletedOnboarding")
    }

    public func setHasCompletedOnboarding(_ done: Bool) {
        Self.set(done, forKey: "hasCompletedOnboarding")
    }

    public var geminiConfig: GeminiConfig {
        if let vertex = VertexRuntimeConfig.state().config, vertex.isDirect {
            let override = Self.defaults.string(forKey: "cleanupModelOverride") ?? ""
            let cleanup = CleanupModels.available.contains { $0.id == override } ? override : CleanupModels.defaultModel
            return GeminiConfig(endpoint: vertex.bifrostBaseURL,
                                transcribeModel: transcriptionEngine.helperModel ?? vertex.model, cleanupModel: cleanup)
        }
        var config = GeminiConfig()
        if let url = Self.usableEndpointURL(Self.defaults.string(forKey: "endpointOverride")) {
            config.endpoint = url
        }
        if let model = Self.defaults.string(forKey: "transcribeModelOverride"), !model.isEmpty {
            config.transcribeModel = model
        }
        // The public Gemini API serves only Gemini models; relayed ones exist only
        // behind the direct helper, so an override left from it doesn't apply here.
        if let model = Self.defaults.string(forKey: "cleanupModelOverride"), model.hasPrefix("gemini-") {
            config.cleanupModel = model
        }
        return config
    }

    /// Which recogniser(s) dictation uses. Only the direct Vertex helper can reach
    /// Azure, so every other transport is Gemini whatever was stored.
    public enum TranscriptionEngine: String, CaseIterable, Sendable {
        case gemini
        case gpt
        /// Gemini and GPT transcribe the same recording in parallel, then 3.8
        /// Flash hears the audio and reconciles both drafts. Dictation only:
        /// meetings, the assistant and editing stay on Gemini.
        case dual
        /// Microsoft MAI-Transcribe-2 through OpenRouter, via the helper.
        case mai
        /// NVIDIA Parakeet on this Mac's Neural Engine (FluidAudio Core ML).
        /// Dictation only; meetings, the assistant and editing stay on Gemini.
        case parakeetV3 = "parakeet-v3"
        case parakeetUltra = "parakeet-ultra"

        /// Engines stored under `transcriptionBackend` rather than a bool of their own.
        static let backends: [TranscriptionEngine] = [.mai, .parakeetV3, .parakeetUltra]

        /// The helper model that replaces Gemini Transcribe for every request,
        /// meetings and the assistant included. Nil keeps Gemini.
        public var helperModel: String? {
            switch self {
            case .gpt: return "gpt-transcribe"
            case .mai: return "mai-transcribe-2"
            default: return nil
            }
        }

        /// Runs in-process; nothing leaves the Mac for the transcript itself.
        public var isLocal: Bool { self == .parakeetV3 || self == .parakeetUltra }

        /// No native smart mode: Bento's cleanup model removes fillers and applies
        /// self-corrections instead.
        public var isVerbatim: Bool { self != .gemini && self != .dual }

        /// Single recognisers, in menu order. Dual review pairs any two of them.
        public static let singles: [TranscriptionEngine] = [.gemini, .parakeetV3, .parakeetUltra, .mai, .gpt]

        /// Every pair except both Parakeets: one on-device model is loaded at a
        /// time, and two variants of one model add little a second opinion needs.
        public static let dualPairs: [[TranscriptionEngine]] = singles.indices.flatMap { i in
            singles[(i + 1)...].map { [singles[i], $0] }
        }.filter { !$0.allSatisfy(\.isLocal) }

        public var displayName: String {
            switch self {
            case .gemini: return "Gemini Transcribe"
            case .gpt: return "GPT Transcribe"
            case .dual: return "Dual review"
            case .mai: return "MAI-Transcribe-2"
            case .parakeetV3: return "Parakeet v3"
            case .parakeetUltra: return "Parakeet Ultra"
            }
        }

        public var shortName: String {
            switch self {
            case .gemini: return "Gemini"
            case .gpt: return "GPT"
            case .dual: return "Dual"
            case .mai: return "MAI"
            case .parakeetV3: return "Parakeet v3"
            case .parakeetUltra: return "Parakeet Ultra"
            }
        }

        public static func pairName(_ pair: [TranscriptionEngine]) -> String {
            pair.map(\.shortName).joined(separator: " + ")
        }
    }

    /// The two recognisers whose drafts Dual review reconciles.
    public var dualEngines: [TranscriptionEngine] {
        let stored = (Self.defaults.string(forKey: "dualEngines") ?? "").split(separator: "+")
            .compactMap { TranscriptionEngine(rawValue: String($0)) }
        return TranscriptionEngine.dualPairs.first { Set($0) == Set(stored) && stored.count == 2 } ?? [.gemini, .gpt]
    }

    public func setDualEngines(_ engines: [TranscriptionEngine]) {
        Self.set(engines.map(\.rawValue).joined(separator: "+"), forKey: "dualEngines")
    }

    /// The display name for an engine, naming the pair for Dual review.
    public func name(of engine: TranscriptionEngine) -> String {
        engine == .dual ? "Dual: " + TranscriptionEngine.pairName(dualEngines) : engine.displayName
    }

    /// What Retry Last Transcription re-runs the recording through.
    public var retryEngine: TranscriptionEngine {
        TranscriptionEngine(rawValue: Self.defaults.string(forKey: "retryEngine") ?? "") ?? .mai
    }

    public func setRetryEngine(_ engine: TranscriptionEngine) {
        Self.set(engine.rawValue, forKey: "retryEngine")
    }

    /// The retry hot key as the app stores it; nil means never set, "" means cleared.
    public var retryShortcutRaw: String? { Self.defaults.string(forKey: "retryShortcut") }

    public func setRetryShortcutRaw(_ raw: String) {
        Self.set(raw, forKey: "retryShortcut")
    }

    public var transcriptionEngine: TranscriptionEngine {
        guard VertexRuntimeConfig.state().config?.isDirect == true else { return .gemini }
        if let engineOverride { return engineOverride }
        if let backend = TranscriptionEngine(rawValue: Self.defaults.string(forKey: "transcriptionBackend") ?? ""),
           TranscriptionEngine.backends.contains(backend) {
            return backend
        }
        if Self.defaults.bool(forKey: "dualTranscription") { return .dual }
        return Self.defaults.bool(forKey: "gptTranscription") ? .gpt : .gemini
    }

    public func setTranscriptionEngine(_ engine: TranscriptionEngine) {
        // GPT Transcribe is word for word; Luna on the same Azure resource formats it, when relayed.
        if engine == .gpt, CleanupModels.isRelayed("gpt-6-luna") { setCleanupModelOverride("gpt-6-luna") }
        Self.set(TranscriptionEngine.backends.contains(engine) ? engine.rawValue : "", forKey: "transcriptionBackend")
        Self.set(engine == .dual, forKey: "dualTranscription")
        Self.set(engine == .gpt, forKey: "gptTranscription")
    }

    public var usesGPTTranscription: Bool { transcriptionEngine == .gpt }

    /// The on-device model for dictation, when one is selected.
    public var localTranscriptionModel: String? {
        let engine = transcriptionEngine
        return engine.isLocal ? engine.rawValue : nil
    }

    public var usesDualTranscription: Bool { transcriptionEngine == .dual }

    public func setGPTTranscription(_ enabled: Bool) {
        setTranscriptionEngine(enabled ? .gpt : .gemini)
    }

    /// Double-tap the dictation key to lock hands-free. OFF by default: firm taps
    /// routinely exceed the hold threshold, misreading tap-tap as hold→finalize
    /// (dogfood). The timing-free gesture is Space-while-holding.
    public var doubleTapLockEnabled: Bool {
        Self.defaults.object(forKey: "doubleTapLock") as? Bool ?? false
    }

    public func setDoubleTapLock(_ enabled: Bool) {
        Self.set(enabled, forKey: "doubleTapLock")
    }

    public var singleTapHandsFreeEnabled: Bool {
        Self.defaults.object(forKey: "singleTapHandsFree") as? Bool ?? true
    }

    public func setSingleTapHandsFree(_ enabled: Bool) {
        Self.set(enabled, forKey: "singleTapHandsFree")
    }

    /// Show the resting dot at the bottom of the screen when idle. Off = the pill
    /// only appears while dictating.
    public var showIdleIndicator: Bool {
        Self.defaults.object(forKey: "showIdleIndicator") as? Bool ?? true
    }

    public func setShowIdleIndicator(_ show: Bool) {
        Self.set(show, forKey: "showIdleIndicator")
    }

    public var soundsEnabled: Bool {
        Self.defaults.object(forKey: "soundsEnabled") as? Bool ?? true
    }

    public func setSoundsEnabled(_ enabled: Bool) {
        Self.set(enabled, forKey: "soundsEnabled")
    }

    public var hotkeyKey: HotkeyKey {
        (Self.defaults.string(forKey: "hotkeyKey")).flatMap(HotkeyKey.init(rawValue:)) ?? .fn
    }

    // MARK: - Formatting policy

    public static let lowercaseInstructions = """
    Write ordinary prose in lowercase, including sentence beginnings, the pronoun I, personal names, and ordinary acronyms. Preserve meaningful capitalization in code, case-sensitive identifiers, file names and paths, URLs, email addresses, command-line flags, and established mixed-case technical names such as NixOS, ChatGPT, and LiteLLM. Do not change the wording or meaning merely to apply this style.
    """

    public var customInstructions: String {
        Self.defaults.string(forKey: "customInstructions") ?? ""
    }

    public func setCustomInstructions(_ instructions: String) {
        Self.defaults.removeObject(forKey: "gateTrips")
        Self.set(instructions, forKey: "customInstructions")
    }

    public var customInstructionsEnabled: Bool {
        Self.defaults.bool(forKey: "customInstructionsEnabled")
    }

    public func setCustomInstructionsEnabled(_ enabled: Bool) {
        if enabled { Self.defaults.removeObject(forKey: "gateTrips") }
        Self.set(enabled, forKey: "customInstructionsEnabled")
    }

    public var activeCustomInstructions: String {
        customInstructionsEnabled ? customInstructions.trimmingCharacters(in: .whitespacesAndNewlines) : ""
    }

    /// How a dictation gets formatted. Two independent flags rather than a
    /// three-valued enum, because all four combinations are meaningful — in
    /// particular (nativeSmart: false, cleanupPass: true) is the exact pipeline
    /// Bento shipped before native smart existed, and that is the configuration you
    /// want reachable if smart mode ever regresses server-side.
    public struct FormattingPolicy: Equatable, Sendable {
        public var nativeSmart: Bool
        public var cleanupPass: Bool

        public init(nativeSmart: Bool, cleanupPass: Bool) {
            self.nativeSmart = nativeSmart
            self.cleanupPass = cleanupPass
        }

        public var mode: GeminiClient.TranscriptionMode { nativeSmart ? .smart : .verbatim }
        /// The gate only has a real reference to compare against when a second
        /// model actually rewrote the text.
        public var runsValidationGate: Bool { cleanupPass }
    }

    public var formattingPolicy: FormattingPolicy {
        FormattingPolicy(
            nativeSmart: !transcriptionEngine.isVerbatim && smartTranscriptionEnabled,
            cleanupPass: cleanupEnabled && cleanupRequested
        )
    }

    /// Whether anything asks for the cleanup model, before the master switch.
    public var cleanupRequested: Bool {
        smartCleanupPassEnabled || !activeCustomInstructions.isEmpty || (transcriptionEngine.isVerbatim && smartTranscriptionEnabled)
    }

    /// Master switch for the second model call over the transcript. Off means
    /// no cleanup call at all; tone, custom instructions and smart formatting on
    /// verbatim engines all depend on it. Their own settings survive, so turning
    /// it back on restores them.
    public var cleanupEnabled: Bool {
        Self.defaults.object(forKey: "cleanupEnabled") as? Bool ?? true
    }

    public func setCleanupEnabled(_ enabled: Bool) {
        if enabled { Self.defaults.removeObject(forKey: "gateTrips") }
        Self.set(enabled, forKey: "cleanupEnabled")
    }

    public func effectiveFormattingPolicy(vertexConfigured: Bool = VertexRuntimeConfig.state().isRequested) -> FormattingPolicy {
        vertexConfigured && VertexRuntimeConfig.state().config?.isDirect != true
            ? FormattingPolicy(nativeSmart: false, cleanupPass: false) : formattingPolicy
    }

    /// Native `mode: "smart"` — the default transcription path.
    public var smartTranscriptionEnabled: Bool {
        Self.defaults.object(forKey: "smartTranscription") as? Bool ?? true
    }

    public func setSmartTranscription(_ enabled: Bool) {
        if enabled && transcriptionEngine.isVerbatim { Self.defaults.removeObject(forKey: "gateTrips") }
        Self.set(enabled, forKey: "smartTranscription")
    }

    /// The opt-in second pass through the cleanup model — this is what carries
    /// per-app tone. Off by default: it costs a round trip and sends the
    /// transcript text a second time.
    public var smartCleanupPassEnabled: Bool {
        Self.defaults.object(forKey: "smartCleanupPass") as? Bool ?? false
    }

    public func setSmartCleanupPass(_ enabled: Bool) {
        if enabled {
            // A deliberate re-enable is a clean slate. This moved here with the
            // gate counter: auto-degrade now switches THIS flag off, so leaving
            // the clear on setSmartFormatting would resurrect the bug where one
            // stale trip inside the old 24h window instantly re-degrades.
            Self.defaults.removeObject(forKey: "gateTrips")
        }
        Self.set(enabled, forKey: "smartCleanupPass")
    }

    /// Escape hatch back to the pre-native-smart transport.
    ///
    /// `/v1beta/interactions` is days old. For the cost of one settings row, a
    /// server-side regression in smart mode becomes something a user can switch
    /// off rather than something that needs a hotfix release. Smart formatting is
    /// unavailable on the legacy endpoint (`mode` returns an empty transcript
    /// there), so this necessarily means verbatim + the optional tone pass.
    /// Remove once native smart has a clean dogfood run.
    public var usesLegacyTranscribeEndpoint: Bool {
        Self.defaults.bool(forKey: "legacyTranscribeEndpoint")
    }

    public func setLegacyTranscribeEndpoint(_ enabled: Bool) {
        Self.set(enabled, forKey: "legacyTranscribeEndpoint")
    }

    public func setHotkeyKey(_ key: HotkeyKey) {
        Self.set(key.rawValue, forKey: "hotkeyKey")
    }

    /// Experimental: judge speech RELATIVE to the room instead of against fixed
    /// thresholds that assume a quiet one, and (once probed) let macOS suppress
    /// background voices. Off by default until dogfood data earns the flip.
    ///
    /// One key gates every behaviour in the noise work, so there is exactly one
    /// thing to turn on, one thing to turn off, and one thing to flip when the
    /// numbers are in. The measurements it would act on are recorded either way —
    /// `NoiseFloorEstimator` runs unconditionally.
    public var experimentalNoiseHandling: Bool {
        Self.defaults.bool(forKey: "experimentalNoiseHandling")
    }

    public func setExperimentalNoiseHandling(_ enabled: Bool) {
        Self.set(enabled, forKey: "experimentalNoiseHandling")
    }

    /// Stream audio to the Live API over a WebSocket and show words as they are
    /// spoken, instead of uploading the clip at key-up.
    ///
    /// Experimental and off by default. It is a genuinely different transport
    /// with a genuinely different failure surface — a socket can die mid-sentence
    /// where an upload either succeeds or does not — so it earns its way on by
    /// dogfooding, not by being the new default.
    ///
    /// Turning this on never risks words. The CAF is written exactly as before,
    /// and a live stream that ends any way other than cleanly is discarded in
    /// favour of the batch upload over that file.
    public var liveTranscription: Bool {
        Self.defaults.bool(forKey: "liveTranscription")
    }

    public func setLiveTranscription(_ enabled: Bool) {
        Self.set(enabled, forKey: "liveTranscription")
    }

    /// Live needs the interactions-era transport; the legacy escape hatch is a
    /// different endpoint entirely. Rather than let the two contradict each other
    /// silently, the hatch wins and live stands down.
    public var liveTranscriptionActive: Bool {
        liveTranscriptionActive(vertexConfigured: VertexRuntimeConfig.state().isRequested)
    }

    public func liveTranscriptionActive(vertexConfigured: Bool) -> Bool {
        transcriptionEngine == .gemini && liveTranscription && (vertexConfigured
            ? VertexRuntimeConfig.state().config?.isDirect == true
            : !usesLegacyTranscribeEndpoint)
    }

    // MARK: - Meetings

    /// Mix what the Mac plays into meeting recordings, so the other side of a
    /// call is transcribed even through headphones. Needs macOS 14.2 and the
    /// one-time System Audio Recording permission.
    public var meetingCaptureSystemAudio: Bool {
        Self.defaults.object(forKey: "meetingCaptureSystemAudio") as? Bool ?? true
    }

    public func setMeetingCaptureSystemAudio(_ enabled: Bool) {
        Self.set(enabled, forKey: "meetingCaptureSystemAudio")
    }

    /// Title, summary, decisions and action items when a meeting ends — one
    /// extra text-model call over the cleaned transcript.
    public var meetingSummaryEnabled: Bool {
        Self.defaults.object(forKey: "meetingSummaryEnabled") as? Bool ?? true
    }

    public func setMeetingSummaryEnabled(_ enabled: Bool) {
        Self.set(enabled, forKey: "meetingSummaryEnabled")
    }

    /// Keep the mic out of the meeting while the user dictates or talks to the
    /// assistant: those words are meant for a text field, not the record.
    public var meetingExcludesDictation: Bool {
        Self.defaults.object(forKey: "meetingExcludesDictation") as? Bool ?? true
    }

    public func setMeetingExcludesDictation(_ enabled: Bool) {
        Self.set(enabled, forKey: "meetingExcludesDictation")
    }

    // Raw override values for the Settings UI — panes must not duplicate the
    // defaults keys (a rename would silently desync display from effect).
    public var endpointOverride: String? { Self.defaults.string(forKey: "endpointOverride") }
    public var transcribeModelOverride: String? { Self.defaults.string(forKey: "transcribeModelOverride") }
    public var cleanupModelOverride: String? { Self.defaults.string(forKey: "cleanupModelOverride") }
    public var useDictationComposer: Bool { Self.defaults.bool(forKey: "useDictationComposer") }
    public func setUseDictationComposer(_ enabled: Bool) { Self.set(enabled, forKey: "useDictationComposer") }

    public func setEndpointOverride(_ raw: String?) {
        Self.set(raw, forKey: "endpointOverride")
    }

    public func setTranscribeModelOverride(_ raw: String?) {
        Self.set(raw, forKey: "transcribeModelOverride")
    }

    public func setCleanupModelOverride(_ raw: String?) {
        Self.set(raw, forKey: "cleanupModelOverride")
    }

    /// Days to keep audio files (transcripts are kept until deleted). 0 = forever.
    public var audioRetentionDays: Int {
        Self.defaults.object(forKey: "audioRetentionDays") as? Int ?? 7
    }

    public func setAudioRetentionDays(_ days: Int) {
        Self.set(days, forKey: "audioRetentionDays")
    }

    /// Auto-degrade bookkeeping (F11): ≥3 gate trips in 24h ⇒ verbatim by default.
    public func recordGateTrip(now: Date = Date()) -> Int {
        var trips = (Self.defaults.array(forKey: "gateTrips") as? [Date]) ?? []
        trips = trips.filter { now.timeIntervalSince($0) < 86_400 }
        trips.append(now)
        Self.defaults.set(trips, forKey: "gateTrips")
        return trips.count
    }
}
