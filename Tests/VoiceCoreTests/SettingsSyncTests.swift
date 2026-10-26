import Foundation
import Testing
@testable import VoiceCore

/// `SettingsSyncStore` in memory. Saves go through `JSONValue` and JSON, as
/// `ConfigSectionStore` does on the way into config.json, so only JSON values
/// come back out.
final class MemorySettingsStore: SettingsSyncStore {
    /// The stored section; nil when missing.
    private(set) var raw: Any?
    private(set) var saveCount = 0
    private var observers: [() -> Void] = []

    init(_ raw: Any? = nil) {
        self.raw = raw.map(Self.jsonRoundTrip)
    }

    var object: [String: Any] { raw as? [String: Any] ?? [:] }

    func load() -> Result<[String: Any], SettingsSync.Invalid>? {
        guard let raw, !(raw is NSNull) else { return nil }
        guard let object = raw as? [String: Any] else { return .failure(.init(reason: "dictation is not an object")) }
        return .success(object)
    }

    func save(_ root: [String: Any]) {
        guard let value = JSONValue(root), let data = try? JSONEncoder().encode(value),
              let object = try? JSONSerialization.jsonObject(with: data) else {
            Issue.record("SettingsSync saved something that isn't JSON: \(root)")
            return
        }
        saveCount += 1
        raw = object
    }

    func observe(_ changed: @escaping () -> Void) {
        observers.append(changed)
    }

    /// An edit from outside the app (a hand edit, a dotfiles pull), announced
    /// the way `ConfigStore` announces a changed section.
    func edit(_ raw: Any?) {
        self.raw = raw.map(Self.jsonRoundTrip)
        for observer in observers { observer() }
    }

    static func jsonRoundTrip(_ value: Any) -> Any {
        let data = try! JSONSerialization.data(withJSONObject: [value])
        return (try! JSONSerialization.jsonObject(with: data) as! [Any])[0]
    }
}

extension SharedStateTests {
    /// The portable dictation settings mirrored into config.json's `dictation`
    /// section. Jot's `SettingsFile` tests, against `SettingsSync` and an
    /// in-memory store. Nested under `SharedStateTests` because applying the
    /// section posts `gtSettingDidChange` on the default center; main actor
    /// because `SettingsSync` is main-thread only.
    @MainActor
    @Suite struct SettingsSyncTests {
        private let suite = PrivateDefaults("settings-sync")
        private var defaults: UserDefaults { suite.defaults }

        private func entries() throws -> [DictionaryEntry] {
            try JSONDecoder().decode([DictionaryEntry].self, from: #require(defaults.data(forKey: "dictionaryEntries")))
        }

        @Test func missingSectionIsCreatedFromPortableSettingsOnly() throws {
            defaults.set(true, forKey: "dualTranscription")
            defaults.set("optionF17", forKey: "hotkeyKey")
            defaults.set(0, forKey: "audioRetentionDays")
            defaults.set(true, forKey: "hasCompletedOnboarding")
            defaults.set(42, forKey: "liveAttempts")
            defaults.set("http://127.0.0.1:9", forKey: "endpointOverride")
            defaults.set(try JSONEncoder().encode([DictionaryEntry(term: "Kubernetes", misspelling: "cooper netties")]),
                         forKey: "dictionaryEntries")
            let store = MemorySettingsStore()

            SettingsSync(store: store, defaults: defaults).sync()

            let section = store.object
            #expect(store.saveCount == 1)
            #expect(section["dualTranscription"] as? Bool == true)
            #expect(section["hotkeyKey"] as? String == "optionF17")
            #expect(section["audioRetentionDays"] as? Int == 0)
            #expect(section["hasCompletedOnboarding"] == nil)
            #expect(section["liveAttempts"] == nil)
            #expect(section["endpointOverride"] == nil)
            let entry = try #require((section["dictionary"] as? [[String: Any]])?.first)
            #expect(entry["term"] as? String == "Kubernetes")
            #expect(entry["misspelling"] as? String == "cooper netties")
            #expect((entry["createdAt"] as? String)?.hasSuffix("Z") == true, "Dates are readable ISO 8601")
        }

        @Test func storedSectionWinsAndKeysItLeavesOutResetToDefaults() throws {
            defaults.set(true, forKey: "gptTranscription")
            defaults.set(false, forKey: "soundsEnabled")
            defaults.set(try JSONEncoder().encode([DictionaryEntry(term: "Local")]), forKey: "dictionaryEntries")
            let store = MemorySettingsStore(["dualTranscription": true, "hotkeyKey": "optionF17",
                                             "customInstructions": "British spelling."])

            let notified = LockedBox<[String]>([])
            let token = NotificationCenter.default.addObserver(forName: .gtSettingDidChange, object: nil, queue: nil) { note in
                if let key = note.object as? String { notified.mutate { $0.append(key) } }
            }
            defer { NotificationCenter.default.removeObserver(token) }
            SettingsSync(store: store, defaults: defaults).sync()

            #expect(defaults.bool(forKey: "dualTranscription"))
            #expect(defaults.string(forKey: "hotkeyKey") == "optionF17")
            #expect(defaults.string(forKey: "customInstructions") == "British spelling.")
            #expect(defaults.object(forKey: "gptTranscription") == nil)
            #expect(defaults.object(forKey: "soundsEnabled") == nil)
            #expect(defaults.object(forKey: "dictionaryEntries") == nil)
            #expect(Set(notified.current).isSuperset(of: ["dualTranscription", "hotkeyKey", "gptTranscription", "dictionaryEntries"]),
                    "Runtime surfaces hear about synced changes")
            #expect(store.object["gptTranscription"] == nil, "Applying the section doesn't write the old value back")
            #expect(store.saveCount == 0, "Nothing to write back")
        }

        @Test func localChangesAreWrittenBackKeepingUnknownAndMistypedValues() {
            let store = MemorySettingsStore(["smartTranscription": "yes", "futureSetting": 3, "liveTranscription": true])
            defaults.set(false, forKey: "smartTranscription")
            let sync = SettingsSync(store: store, defaults: defaults)
            sync.sync()
            #expect(defaults.object(forKey: "smartTranscription") as? Bool == false, "A mistyped value keeps this Mac's setting")

            defaults.set(false, forKey: "liveTranscription")
            defaults.set(true, forKey: "doubleTapLock")
            sync.sync()

            let written = store.object
            #expect(written["liveTranscription"] as? Bool == false)
            #expect(written["doubleTapLock"] as? Bool == true)
            #expect(written["smartTranscription"] as? String == "yes", "Left for the user to fix")
            #expect(written["futureSetting"] as? Int == 3)
        }

        @Test func voiceCallProviderSyncsBothWays() {
            defaults.set("gemini", forKey: "assistantLiveProvider")
            let store = MemorySettingsStore()
            let sync = SettingsSync(store: store, defaults: defaults)
            sync.sync()
            #expect(store.object["assistantLiveProvider"] as? String == "gemini")

            store.edit(["assistantLiveProvider": "gpt", "assistantLiveCall": true])
            sync.sync()
            #expect(defaults.string(forKey: "assistantLiveProvider") == "gpt")
            #expect(defaults.object(forKey: "assistantLiveCall") as? Bool == true)

            store.edit(["assistantLiveCall": true])
            sync.sync()
            #expect(defaults.object(forKey: "assistantLiveProvider") == nil, "Left out means the default, GPT-Live")
        }

        /// config.json itself failing to parse is `ConfigStore`'s business; what
        /// reaches `SettingsSync` is a section that isn't an object.
        @Test func invalidSectionIsNeverOverwritten() throws {
            let invalid: [Any] = ["{\"hotkeyKey\": ", ["hotkeyKey", "optionF17"], 42, true]
            for value in invalid {
                let store = MemorySettingsStore(value)
                let before = try JSONSerialization.data(withJSONObject: [store.raw!])
                defaults.set(true, forKey: "doubleTapLock")
                let sync = SettingsSync(store: store, defaults: defaults)
                sync.sync()
                sync.flush()
                #expect(store.saveCount == 0, "\(value)")
                #expect(try JSONSerialization.data(withJSONObject: [store.raw!]) == before)
                #expect(defaults.bool(forKey: "doubleTapLock"))
            }
        }

        @Test func missingSectionIsCreatedAndRecreated() {
            defaults.set(true, forKey: "doubleTapLock")
            let store = MemorySettingsStore()
            let sync = SettingsSync(store: store, defaults: defaults)
            sync.sync()
            #expect(store.object["doubleTapLock"] as? Bool == true)

            store.edit(nil)
            sync.sync()
            #expect(store.object["doubleTapLock"] as? Bool == true, "Removing the section doesn't reset this Mac")
            #expect(defaults.bool(forKey: "doubleTapLock"))

            store.edit(NSNull())
            sync.sync()
            #expect(store.object["doubleTapLock"] as? Bool == true, "A null section counts as missing")
        }

        @Test func nullResetsAndNumbersAreChecked() {
            defaults.set("optionF17", forKey: "hotkeyKey")
            defaults.set(7, forKey: "audioRetentionDays")
            defaults.set(true, forKey: "doubleTapLock")
            let store = MemorySettingsStore(["hotkeyKey": NSNull(), "audioRetentionDays": 1e30, "doubleTapLock": 0])
            SettingsSync(store: store, defaults: defaults).sync()

            #expect(defaults.object(forKey: "hotkeyKey") == nil, "null means left out: back to the default")
            #expect(defaults.integer(forKey: "audioRetentionDays") == 7, "An out-of-range number keeps this Mac's value")
            #expect(defaults.object(forKey: "doubleTapLock") as? Bool == false)
            #expect(!store.object.keys.contains("hotkeyKey"))
            #expect(store.object["audioRetentionDays"] as? Double == 1e30, "Stays as written")
            #expect(SettingsSync.normalized(true, .int) == nil)
            #expect(SettingsSync.normalized(3.9, .int) == nil)
        }

        /// Applying the section and writing it back must be a fixed point, or
        /// every pull rewrites the dictionary.
        @Test func dictionaryDatesRoundTripExactly() throws {
            for seconds in [810388761.130484, 810388761.129, 0.0005, 1e9 + 0.9996, -1.25] {
                let date = Date(timeIntervalSinceReferenceDate: seconds)
                let text = SettingsSync.timestamp(date)
                #expect(SettingsSync.timestamp(try #require(SettingsSync.date(timestamp: text))) == text)
            }
            #expect(SettingsSync.timestamp(Date(timeIntervalSince1970: 1_757_159_961.1299)) == "2025-09-06T11:59:21.130Z")
            #expect(SettingsSync.date(timestamp: "2026-09-06T11:59:21Z") != nil)

            var entry = DictionaryEntry(term: "Bifrost")
            entry.createdAt = Date(timeIntervalSinceReferenceDate: 810388761.130484)
            defaults.set(try JSONEncoder().encode([entry]), forKey: "dictionaryEntries")
            let store = MemorySettingsStore()
            SettingsSync(store: store, defaults: defaults).sync()
            let written = try #require(store.raw as? NSDictionary)
            for _ in 0..<3 {
                store.edit(store.raw) // an outside rewrite
                SettingsSync(store: store, defaults: defaults).sync() // and a fresh launch applying it
            }
            #expect(store.raw as? NSDictionary == written)
            #expect(store.saveCount == 1, "Only the first sync had anything to write")
        }

        @Test func handAddedDictionaryEntriesAreCompletedAndKept() throws {
            let store = MemorySettingsStore(["dictionary": [["term": "Kubernetes"], ["term": "  "], ["term": "kubernetes"],
                                                            ["term": String(repeating: "x", count: 61)]]])
            SettingsSync(store: store, defaults: defaults).sync()

            let stored = try entries()
            #expect(stored.map(\.term) == ["Kubernetes"])
            let entry = try #require((store.object["dictionary"] as? [[String: Any]])?.first)
            #expect(entry["id"] as? String == stored[0].id.uuidString, "The generated id is written back")
            #expect(entry["createdAt"] != nil)
        }

        @Test func mistypedDictionaryKeepsThisMacsEntries() throws {
            defaults.set(try JSONEncoder().encode([DictionaryEntry(term: "Local")]), forKey: "dictionaryEntries")
            let store = MemorySettingsStore(["dictionary": "Kubernetes"])
            SettingsSync(store: store, defaults: defaults).sync()
            #expect(try entries().map(\.term) == ["Local"])
            #expect(store.object["dictionary"] as? String == "Kubernetes", "Left for the user to fix")
        }

        @Test func startAppliesOutsideEditsAndWritesLocalChanges() async throws {
            let store = MemorySettingsStore()
            let sync = SettingsSync(store: store, defaults: defaults)
            sync.start()
            #expect(store.saveCount == 1, "start syncs once, creating the missing section")

            store.edit(["hotkeyKey": "optionF17"])
            #expect(defaults.string(forKey: "hotkeyKey") == "optionF17", "An outside edit is applied as it's announced")

            defaults.set(true, forKey: "doubleTapLock")
            let deadline = Date().addingTimeInterval(5)
            while store.object["doubleTapLock"] as? Bool != true, Date() < deadline {
                try await Task.sleep(nanoseconds: 20_000_000)
            }
            #expect(store.object["doubleTapLock"] as? Bool == true, "A local change is written back shortly after")
            #expect(store.object["hotkeyKey"] as? String == "optionF17")

            defaults.set(false, forKey: "soundsEnabled")
            sync.flush()
            #expect(store.object["soundsEnabled"] as? Bool == false, "flush writes a pending change at once")
        }
    }
}
