import Foundation
import Testing
@testable import Launcher

@Test func entryDecodesWithOnlyTarget() throws {
    let json = #"{"entries":[{"target":"Safari","shortcut":"ctrl+opt+cmd+1"},{"kind":"url","target":"https://github.com"}]}"#
    let s = try JSONDecoder().decode(LauncherSettings.self, from: Data(json.utf8))
    #expect(s.entries.count == 2)
    #expect(s.entries[0].kind == .app)
    #expect(s.entries[0].behavior == .toggle)
    #expect(s.entries[0].actionID == "launcher.safari")
    #expect(s.entries[1].kind == .url)
    #expect(s.entries[1].displayName == "github.com")
}

@Test func unknownBehaviorFallsBackToToggle() throws {
    let json = #"{"target":"Notes","behavior":"bogus"}"#
    let e = try JSONDecoder().decode(LauncherEntry.self, from: Data(json.utf8))
    #expect(e.behavior == .toggle)
}

@Test func resolvesSystemAppsByNameAndBundleID() {
    #expect(AppResolver.url(for: "Finder") != nil)
    #expect(AppResolver.url(for: "com.apple.finder") != nil)
    #expect(AppResolver.url(for: "definitely-not-an-app-xyz") == nil)
}

@Test func newEntriesGetStableKeys() {
    let e = LauncherEntry(target: "com.apple.Safari")
    #expect(e.key != nil)
    #expect(e.actionID.hasPrefix("launcher."))
}
