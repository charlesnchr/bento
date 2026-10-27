import BentoCore
import Foundation
import Testing
@testable import VoiceCore

/// Two simulated Macs syncing their dictionaries and settings through a real bento-sync
/// with the real client, KVO and run loop. Opt in with a throwaway server (a fresh
/// database: settings from an earlier run would win the merge) whose token is in
/// `$BENTO_HOME/config/sync-token`:
///
///     BENTO_HOME=/tmp/voice-e2e BENTO_VOICE_SYNC_E2E=http://127.0.0.1:8787 scripts/test VoiceCoreTests
///
/// BENTO_HOME keeps ConfigStore away from the real config.json and the client on servers
/// on this Mac.
@Suite struct VoiceSyncEndToEndTests {
    static let server = ProcessInfo.processInfo.environment["BENTO_VOICE_SYNC_E2E"]
    static let optedIn = server != nil && ProcessInfo.processInfo.environment["BENTO_HOME"] != nil

    private struct NotesSection: Codable { var sync: SyncServerSettings }

    private func entries(_ defaults: UserDefaults) -> [DictionaryEntry] {
        defaults.data(forKey: "dictionaryEntries").flatMap { try? JSONDecoder().decode([DictionaryEntry].self, from: $0) } ?? []
    }

    private func terms(_ defaults: UserDefaults) -> [String] { entries(defaults).map(\.term).sorted() }

    @MainActor
    private func until(_ what: String, timeout: TimeInterval = 15, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            guard Date() < deadline else {
                Issue.record("timed out waiting until \(what)")
                return
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
    }

    @MainActor
    @Test(.enabled(if: VoiceSyncEndToEndTests.optedIn)) func twoMacsSyncThroughARealServer() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("voice-e2e-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        ConfigStore.shared.setSection("notes", NotesSection(sync: SyncServerSettings(enabled: true, server: Self.server ?? "")))
        let (a, b) = (PrivateDefaults("e2e-a"), PrivateDefaults("e2e-b"))

        a.defaults.set(try JSONEncoder().encode([DictionaryEntry(term: "Kubernetes", misspelling: "cooper netties")]), forKey: "dictionaryEntries")
        a.defaults.set("Write in lowercase.", forKey: "customInstructions")
        let macA = VoiceSync(url: dir.appendingPathComponent("a.sqlite"), defaults: a.defaults)
        macA.start()
        defer { macA.stop() }
        try await until("A has uploaded") { macA.status.state == .connected && macA.status.pending == 0 }

        b.defaults.set(try JSONEncoder().encode([DictionaryEntry(term: "Ammaar")]), forKey: "dictionaryEntries")
        b.defaults.set(false, forKey: "cleanupEnabled")
        let macB = VoiceSync(url: dir.appendingPathComponent("b.sqlite"), defaults: b.defaults)
        macB.start()
        defer { macB.stop() }
        try await until("both have both dictionaries and settings") {
            terms(a.defaults) == ["Ammaar", "Kubernetes"] && terms(b.defaults) == ["Ammaar", "Kubernetes"]
                && b.defaults.string(forKey: "customInstructions") == "Write in lowercase."
                && a.defaults.object(forKey: "cleanupEnabled") as? Bool == false
        }

        // Edits as the Dictionary pane makes them (UserDefaults, seen through KVO).
        var onB = entries(b.defaults)
        if let i = onB.firstIndex(where: { $0.term == "Kubernetes" }) { onB[i].starred = true }
        b.defaults.set(try JSONEncoder().encode(onB), forKey: "dictionaryEntries")
        try await until("A sees B's star") { entries(a.defaults).first { $0.term == "Kubernetes" }?.starred == true }
        a.defaults.set(try JSONEncoder().encode(entries(a.defaults).filter { $0.term != "Ammaar" }), forKey: "dictionaryEntries")
        a.defaults.set(true, forKey: "customInstructionsEnabled")
        try await until("B sees A's removal and setting") {
            terms(b.defaults) == ["Kubernetes"] && b.defaults.bool(forKey: "customInstructionsEnabled")
        }
        try await until("nothing left to send") { macA.status.pending == 0 && macB.status.pending == 0 }
        #expect(entries(b.defaults).first?.misspelling == "cooper netties")
        #expect(macA.status.isHealthy && macB.status.isHealthy)
    }
}
