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
import Testing
@testable import VoiceCore

extension SharedStateTests {
    /// The settings live-audit contract: every write announces itself, so runtime
    /// surfaces can re-render the moment a toggle flips (dogfood: "I turned the
    /// resting indicator on and off and it didn't work").
    @Suite struct SettingsLiveUpdateTests {
        private let state = SharedStateGuard()
        private let settings = SettingsStore()

        /// Notifications are posted synchronously, so the setter must have posted
        /// its key exactly once by the time it returns.
        private func expectChange(forKey key: String, sourceLocation: SourceLocation = #_sourceLocation,
                                  during action: () -> Void) async {
            await confirmation("gtSettingDidChange(\(key))", sourceLocation: sourceLocation) { posted in
                let observer = NotificationCenter.default.addObserver(
                    forName: .gtSettingDidChange, object: nil, queue: nil
                ) { note in
                    if note.object as? String == key {
                        posted()
                    }
                }
                action()
                NotificationCenter.default.removeObserver(observer)
            }
        }

        @Test func everySetterPostsItsKey() async {
            await expectChange(forKey: "showIdleIndicator") { settings.setShowIdleIndicator(false) }
            await expectChange(forKey: "soundsEnabled") { settings.setSoundsEnabled(false) }
            await expectChange(forKey: "smartTranscription") { settings.setSmartTranscription(false) }
            await expectChange(forKey: "smartCleanupPass") { settings.setSmartCleanupPass(false) }
            await expectChange(forKey: "legacyTranscribeEndpoint") { settings.setLegacyTranscribeEndpoint(true) }
            await expectChange(forKey: "doubleTapLock") { settings.setDoubleTapLock(true) }
            await expectChange(forKey: "singleTapHandsFree") { settings.setSingleTapHandsFree(true) }
            await expectChange(forKey: "assistantLiveCall") { settings.setAssistantLiveCall(false) }
            await expectChange(forKey: "assistantLiveProvider") { settings.setAssistantLiveProvider(.gemini) }
            await expectChange(forKey: "hotkeyKey") { settings.setHotkeyKey(.fn) }
            await expectChange(forKey: "audioRetentionDays") { settings.setAudioRetentionDays(7) }
            await expectChange(forKey: "experimentalNoiseHandling") { settings.setExperimentalNoiseHandling(true) }
        }

        @Test func assistantCallsDefaultOnAndPersistOptOut() {
            UserDefaults.standard.removeObject(forKey: "assistantLiveCall")
            #expect(settings.assistantLiveCall)
            settings.setAssistantLiveCall(false)
            #expect(!SettingsStore().assistantLiveCall)
            settings.setAssistantLiveCall(true)
            #expect(SettingsStore().assistantLiveCall)
        }

        @Test func assistantCallProviderDefaultsToGPTLiveAndPersistsGemini() {
            UserDefaults.standard.removeObject(forKey: "assistantLiveProvider")
            #expect(settings.assistantLiveProvider == .gpt, "Existing installs keep GPT-Live")
            settings.setAssistantLiveProvider(.gemini)
            #expect(SettingsStore().assistantLiveProvider == .gemini)
            #expect(UserDefaults.standard.string(forKey: "assistantLiveProvider") == "gemini")
            #expect(SettingsStore().assistantLiveCall, "Choosing a provider doesn't turn calls off")
            settings.setAssistantLiveProvider(.gpt)
            #expect(SettingsStore().assistantLiveProvider == .gpt)
            UserDefaults.standard.set("gemini-9-live", forKey: "assistantLiveProvider")
            #expect(SettingsStore().assistantLiveProvider == .gpt, "An unknown synced value falls back to GPT-Live")
            #expect(SettingsStore.AssistantLiveProvider.allCases.map(\.displayName) == ["Azure GPT-Live", "Gemini 3.8 Live"])
        }

        @Test func manualReEnableClearsGateTrips() {
            // Three trips inside the window = degraded.
            _ = settings.recordGateTrip()
            _ = settings.recordGateTrip()
            #expect(settings.recordGateTrip() == 3)
            // The user deliberately re-enables the tone pass: the slate must be clean,
            // or a single further trip instantly re-degrades and their choice loses.
            // (This clear moved from setSmartFormatting when auto-degrade re-pointed
            // at the opt-in pass — if it had not moved, this test would still pass on
            // the old key while the real behaviour silently regressed.)
            settings.setSmartCleanupPass(true)
            #expect(settings.recordGateTrip() == 1)
        }
    }

    @Suite struct DictionaryImportTests {
        /// Starts with no "dictionaryEntries" and puts the old value back afterwards.
        private let state = SharedStateGuard()
        private let store = DictionaryStore()

        @Test func headerRowIsDropped() {
            #expect(store.importCSV("term,misspelling\nKubernetes,cooper netties") == 1)
            #expect(store.entries().map(\.term) == ["Kubernetes"])
        }

        @Test func headerlessFirstRowStartingWithTermIsKept() {
            // "terminal" hasPrefix("term") — the old sniff ate this real entry.
            #expect(store.importCSV("terminal,termie\nKubernetes,") == 2)
            #expect(store.entries().map(\.term) == ["terminal", "Kubernetes"])
        }

        @Test func importDedupesAgainstExistingAndItself() {
            _ = store.add(term: "Gemini")
            let count = store.importCSV("gemini,\nGemini,\nVeo,\nveo,")
            #expect(count == 1)
            #expect(store.entries().map(\.term) == ["Gemini", "Veo"])
        }

        @Test func spellingsPrioritizeStarred() throws {
            for i in 0..<12 {
                _ = store.add(term: "term\(i)", misspelling: "wrong\(i)")
            }
            // Star the OLDEST entry — insertion order would leave it last.
            let oldest = try #require(store.entries().first)
            store.toggleStar(id: oldest.id)
            let spellings = store.spellings()
            #expect(spellings.count == 10)
            #expect(spellings.first?.right == oldest.term, "starred entries must lead the prompt's spelling hints")
        }
    }
}
