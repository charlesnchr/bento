import Foundation
import Testing
@testable import VoiceCore

extension SharedStateTests {
    @Suite struct GPTTranscriptionSettingsTests {
        private let state = SharedStateGuard()

        /// Luna and Haiku are relayed cleanup models named by the runtime config
        /// (`relayed_cleanup_models`), which also makes Haiku the default.
        @Test func gptChoiceDisablesLiveAndUsesLunaForSmartCleanup() {
            state.useRuntimeConfig(RuntimeConfigFixture.directWithRelayedCleanup)
            let settings = SettingsStore()
            settings.setLiveTranscription(true)
            settings.setSmartTranscription(true)
            settings.setSmartCleanupPass(false)
            settings.setCustomInstructionsEnabled(false)
            settings.setGPTTranscription(true)
            #expect(settings.geminiConfig.transcribeModel == "gpt-transcribe")
            #expect(settings.geminiConfig.cleanupModel == "gpt-6-luna")
            #expect(!settings.liveTranscriptionActive)
            #expect(!settings.formattingPolicy.nativeSmart)
            #expect(settings.formattingPolicy.cleanupPass)
            settings.setSmartTranscription(false)
            #expect(!settings.formattingPolicy.cleanupPass)
            _ = settings.recordGateTrip()
            _ = settings.recordGateTrip()
            #expect(settings.recordGateTrip() == 3)
            settings.setSmartTranscription(true)
            #expect(settings.recordGateTrip() == 1, "Re-enabling GPT cleanup clears earlier gate failures")
            settings.setGPTTranscription(false)
            #expect(settings.geminiConfig.transcribeModel == "gemini-3.5-transcribe-preview")
            settings.setCleanupModelOverride(nil)
            #expect(settings.geminiConfig.cleanupModel == "claude-haiku-5-5",
                    "Direct cleanup defaults to the runtime's default, Haiku")
            settings.setCleanupModelOverride("gemini-3.5-flash-lite")
            #expect(settings.geminiConfig.cleanupModel == "gemini-3.5-flash-lite", "Flash-Lite stays selectable")
            #expect(settings.liveTranscriptionActive)
        }

        /// Without relayed models, choosing GPT can't switch cleanup to Luna,
        /// and the direct default is Flash-Lite.
        @Test func gptChoiceWithoutRelayedModelsKeepsFlashLite() {
            state.useRuntimeConfig(RuntimeConfigFixture.direct)
            let settings = SettingsStore()
            settings.setGPTTranscription(true)
            #expect(settings.geminiConfig.transcribeModel == "gpt-transcribe")
            #expect(settings.cleanupModelOverride == nil)
            #expect(settings.geminiConfig.cleanupModel == "gemini-3.5-flash-lite")
        }
    }

    /// The cleanup models the settings offer, read from the runtime config
    /// (they replaced Jot's compiled-in Haiku and relayed-model constants).
    @Suite struct CleanupModelsTests {
        private let state = SharedStateGuard()

        @Test func relayedModelsComeFromTheRuntimeConfig() {
            #expect(CleanupModels.relayed.isEmpty, "No runtime config, nothing relayed")
            #expect(CleanupModels.available == CleanupModels.builtIn)
            #expect(CleanupModels.defaultModel == "gemini-3.5-flash-lite")

            state.useRuntimeConfig(RuntimeConfigFixture.directWithRelayedCleanup)
            #expect(CleanupModels.relayed.map(\.id) == ["claude-haiku-5-5", "gpt-6-luna"])
            #expect(CleanupModels.available.map(\.id) == ["claude-haiku-5-5", "gpt-6-luna",
                                                          "gemini-3.5-flash-lite", "gemini-3.8-flash"],
                    "Relayed models first, then the built-in Gemini ones")
            #expect(CleanupModels.isRelayed("gpt-6-luna"))
            #expect(!CleanupModels.isRelayed("gemini-3.5-flash-lite"))
            #expect(CleanupModels.defaultModel == "claude-haiku-5-5")
        }

        @Test func defaultFallsBackToFlashLiteWhenItNamesAnUnknownModel() {
            state.useRuntimeConfig(#"{"transport":"direct","bifrost_base_url":"http://127.0.0.1:8767","bifrost_key":"test","project":"p","location":"global","model":"m","relayed_cleanup_models":[{"id":"gemini-3.8-flash","name":"Duplicate"}],"default_cleanup_model":"retired-model"}"#)
            #expect(CleanupModels.defaultModel == "gemini-3.5-flash-lite")
            #expect(CleanupModels.available.map(\.id) == ["gemini-3.8-flash", "gemini-3.5-flash-lite"],
                    "A relayed model with a built-in id is listed once")
        }
    }
}
