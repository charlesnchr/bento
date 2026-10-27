import Foundation
import Testing
@testable import VoiceCore

/// Which engine dictation runs when no cloud model can: Parakeet v3 on this
/// Mac, without overriding a choice that still works.
@Suite struct ResolveEngineTests {
    typealias Engine = SettingsStore.TranscriptionEngine
    private let direct: VertexRuntimeConfig.State = {
        var config = try! VertexRuntimeConfig(bifrostBaseURL: URL(string: "http://127.0.0.1:8767")!,
                                              bifrostKey: "k", project: "p", location: "global", model: "m")
        config.transport = "direct"
        return .configured(config)
    }()
    private let gateway = VertexRuntimeConfig.State.configured(
        try! VertexRuntimeConfig(bifrostBaseURL: URL(string: "http://127.0.0.1:8080")!,
                                 bifrostKey: "k", project: "p", location: "global", model: "m"))

    @Test func freshInstallWithoutAnyCredentialsDefaultsToParakeetV3() {
        #expect(SettingsStore.resolveEngine(stored: .gemini, runtime: .notConfigured, hasAPIKey: { false }) == .parakeetV3)
    }

    @Test func aGeminiKeyKeepsTheGeminiDefault() {
        #expect(SettingsStore.resolveEngine(stored: .gemini, runtime: .notConfigured, hasAPIKey: { true }) == .gemini)
    }

    @Test func anOnDeviceChoiceHoldsWithOrWithoutAKey() {
        for engine in [Engine.parakeetV3, .parakeetUltra] {
            var asked = false
            #expect(SettingsStore.resolveEngine(stored: engine, runtime: .notConfigured, hasAPIKey: { asked = true; return true }) == engine)
            #expect(!asked, "A local choice needs no Keychain read")
            #expect(SettingsStore.resolveEngine(stored: engine, runtime: .notConfigured, hasAPIKey: { false }) == engine)
        }
    }

    /// GPT, MAI and Dual review only exist behind the direct helper (a synced
    /// config.json can carry them to a Mac without it).
    @Test func helperOnlyChoicesFallBackToWhatThisMacCanRun() {
        for engine in [Engine.gpt, .mai, .dual] {
            #expect(SettingsStore.resolveEngine(stored: engine, runtime: .notConfigured, hasAPIKey: { true }) == .gemini)
            #expect(SettingsStore.resolveEngine(stored: engine, runtime: .notConfigured, hasAPIKey: { false }) == .parakeetV3)
        }
    }

    @Test func theDirectHelperKeepsEveryStoredChoice() {
        for engine in Engine.allCases {
            #expect(SettingsStore.resolveEngine(stored: engine, runtime: direct, hasAPIKey: { false }) == engine)
        }
    }

    /// The gateway transcribes Gemini only, and a broken runtime reports its
    /// own error rather than quietly switching to another engine.
    @Test func aGatewayOrBrokenRuntimeStaysOnGemini() {
        for runtime in [gateway, .invalid("runtime config is malformed")] {
            for engine in [Engine.gemini, .parakeetV3, .gpt] {
                #expect(SettingsStore.resolveEngine(stored: engine, runtime: runtime, hasAPIKey: { false }) == .gemini)
            }
        }
    }
}

extension SharedStateTests {
    /// The same rules through SettingsStore's saved state.
    @Suite struct LocalDefaultSettingsTests {
        private let state = SharedStateGuard()

        @Test func noKeyMeansParakeetV3WithoutSavingIt() {
            state.useAPIKey(false)
            let settings = SettingsStore()
            #expect(settings.transcriptionEngine == .parakeetV3)
            #expect(settings.localTranscriptionModel == "parakeet-v3")
            #expect(settings.usesLocalFallback)
            #expect(!settings.cloudTranscriptionAvailable)
            #expect(UserDefaults.standard.string(forKey: "transcriptionBackend") == nil, "The fallback is never written")

            state.useAPIKey(true)
            #expect(settings.transcriptionEngine == .gemini, "Adding a key brings Gemini back")
            #expect(!settings.usesLocalFallback)
            #expect(settings.cloudTranscriptionAvailable)
        }

        @Test func choosingParakeetIsKeptOnceAKeyArrives() {
            state.useAPIKey(false)
            let settings = SettingsStore()
            settings.setTranscriptionEngine(.parakeetV3)
            #expect(!settings.usesLocalFallback, "Chosen, not fallen back to")
            state.useAPIKey(true)
            #expect(settings.transcriptionEngine == .parakeetV3)
            settings.setTranscriptionEngine(.parakeetUltra)
            #expect(settings.transcriptionEngine == .parakeetUltra)
            settings.setTranscriptionEngine(.gemini)
            #expect(settings.transcriptionEngine == .gemini)
        }

        @Test func aRemovedKeyFallsBackFromGeminiButNotFromParakeetUltra() {
            let settings = SettingsStore()
            #expect(settings.transcriptionEngine == .gemini)
            state.useAPIKey(false)
            #expect(settings.transcriptionEngine == .parakeetV3)
            settings.setTranscriptionEngine(.parakeetUltra)
            #expect(settings.transcriptionEngine == .parakeetUltra)
        }

        /// With no key there is no cleanup model, so smart formatting can't ask for one.
        @Test func noKeyMeansNoCleanupCall() {
            state.useAPIKey(false)
            let settings = SettingsStore()
            settings.setSmartTranscription(true)
            settings.setSmartCleanupPass(true)
            #expect(settings.formattingPolicy.cleanupPass, "The saved preferences survive")
            #expect(settings.effectiveFormattingPolicy() == .init(nativeSmart: false, cleanupPass: false))
            state.useAPIKey(true)
            #expect(settings.effectiveFormattingPolicy().cleanupPass)
            #expect(!settings.liveTranscriptionActive, "Live is Gemini only")
        }

        @Test func selectableEnginesFollowTheRuntime() {
            #expect(SettingsStore().selectableEngines == [.gemini, .parakeetV3, .parakeetUltra])
            state.useRuntimeConfig(RuntimeConfigFixture.direct)
            #expect(SettingsStore().selectableEngines == SettingsStore.TranscriptionEngine.singles)
            state.useRuntimeConfig(#"{"bifrost_base_url":"http://127.0.0.1:8080","bifrost_key":"k","project":"p","location":"global","model":"m"}"#)
            #expect(SettingsStore().selectableEngines == [.gemini])
        }

        /// The direct helper always counts as having credentials: its keys stay with it.
        @Test func theDirectHelperNeverFallsBack() {
            state.useAPIKey(false)
            state.useRuntimeConfig(RuntimeConfigFixture.direct)
            let settings = SettingsStore()
            #expect(settings.transcriptionEngine == .gemini)
            #expect(!settings.usesLocalFallback)
            #expect(settings.cloudTranscriptionAvailable)
            #expect(SettingsStore(engine: .mai).transcriptionEngine == .mai, "Retry's one-off override still applies")
        }
    }
}
