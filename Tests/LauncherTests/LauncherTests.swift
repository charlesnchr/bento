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

@Test func malformedEntriesAreSkippedNotFatal() throws {
    let json = #"{"entries":[{"target":"Safari","shortcut":"hyper+s"},{"shortcut":"hyper+x"},42,{"target":"Notes","shortcut":7,"name":false,"kind":"bogus"}]}"#
    let s = try JSONDecoder().decode(LauncherSettings.self, from: Data(json.utf8))
    #expect(s.entries.map(\.target) == ["Safari", "Notes"])
    #expect(s.entries[1].shortcut == nil)   // wrong type -> missing, entry kept
    #expect(s.entries[1].kind == .app)
    let notAnArray = try JSONDecoder().decode(LauncherSettings.self, from: Data(#"{"entries":"oops"}"#.utf8))
    #expect(notAnArray.entries.isEmpty)
}

@Test func duplicateEntriesGetUniqueActionIDs() throws {
    let json = #"{"entries":[{"target":"Safari"},{"target":"safari"},{"target":"Safari"},{"key":"x","target":"A"},{"key":"x","target":"B"},{"target":""},{"target":"  "}]}"#
    let s = try JSONDecoder().decode(LauncherSettings.self, from: Data(json.utf8))
    let ids = s.entries.map(\.actionID)
    #expect(Set(ids).count == ids.count)
    #expect(ids[0] == "launcher.safari")
    #expect(ids[1] == "launcher.safari-2")
    #expect(ids[2] == "launcher.safari-3")
    #expect(ids[3] == "launcher.x")
    #expect(ids[4] == "launcher.x-2")
    // Stable across a save/load round trip.
    let again = try JSONDecoder().decode(LauncherSettings.self, from: JSONEncoder().encode(s))
    #expect(again.entries.map(\.actionID) == ids)
}

@Test func urlEntriesAcceptBareHostsAndSchemes() {
    #expect(Launcher.url(from: "github.com")?.absoluteString == "https://github.com")
    #expect(Launcher.url(from: "https://github.com/x")?.absoluteString == "https://github.com/x")
    #expect(Launcher.url(from: "localhost:3000")?.absoluteString == "https://localhost:3000")
    #expect(Launcher.url(from: "raycast://extensions")?.scheme == "raycast")
    #expect(Launcher.url(from: "mailto:a@b.c")?.scheme == "mailto")
    #expect(Launcher.url(from: "x-apple.systempreferences:com.apple.preference.security")?.scheme == "x-apple.systempreferences")
    #expect(Launcher.url(from: "") == nil)
    #expect(Launcher.url(from: "not a url") == nil)
    #expect(LauncherEntry(kind: .url, target: "github.com").displayName == "github.com")
}

@Test func missingAndRenamedAppsResolveSafely() throws {
    #expect(AppResolver.url(for: "") == nil)
    #expect(AppResolver.url(for: "   ") == nil)
    #expect(AppResolver.url(for: "/definitely/not/here.app") == nil)
    #expect(AppResolver.url(for: "com.example.does-not-exist") == nil)
    #expect(AppResolver.url(for: "Finder.app") != nil)
    // A path target whose app is moved away stops resolving (cache is checked).
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("bento-app-\(UUID().uuidString)")
    let app = dir.appendingPathComponent("Fake.app")
    try FileManager.default.createDirectory(at: app, withIntermediateDirectories: true)
    #expect(AppResolver.url(for: app.path) != nil)
    try FileManager.default.moveItem(at: app, to: dir.appendingPathComponent("Renamed.app"))
    #expect(AppResolver.url(for: app.path) == nil)
    let missing = LauncherEntry(target: "definitely-not-an-app-xyz")
    #expect(missing.displayName == "definitely-not-an-app-xyz")
    #expect(missing.actionTitle == "Open definitely-not-an-app-xyz")
}

@Test func entryWithEmptyTargetHasAUsableID() throws {
    let e = try JSONDecoder().decode(LauncherEntry.self, from: Data(#"{"target":""}"#.utf8))
    #expect(e.actionID == "launcher.entry")
}
