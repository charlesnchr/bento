import AppKit
import Testing
@testable import BentoCore

// MARK: - Helpers

private func tempConfig(_ json: String? = nil) throws -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("bento-cfg-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let url = dir.appendingPathComponent("config.json")
    if let json { try Data(json.utf8).write(to: url) }
    return url
}

private func fileObject(_ url: URL) throws -> [String: Any] {
    try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
}

/// Spins the main queue (file watcher callbacks, debounced writes).
@MainActor private func settle(_ seconds: Double = 0.8) async throws {
    try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
}

private struct Mod: Codable, Equatable {
    var enabled = true
    var count = 3
    var name = "x"
    var nested = Nested()
    var list: [Int] = [1]
    struct Nested: Codable, Equatable { var a = 1; var b = "b" }
}

// MARK: - ConfigStore

@Test func invalidShortcutValuesDontDropOtherOverrides() throws {
    let url = try tempConfig(#"{"shortcuts":{"a.one":"cmd+1","a.two":null,"a.three":false,"a.four":7}}"#)
    let store = ConfigStore(url: url)
    let o = store.shortcutOverrides
    #expect(o["a.one"] == "cmd+1")
    #expect(o["a.two"] == "")      // null = unbound
    #expect(o["a.three"] == "")    // false = unbound
    #expect(o["a.four"] == nil)    // nonsense ignored
    var changed = o
    changed["a.five"] = "cmd+5"
    store.shortcutOverrides = changed
    store.flush()
    let written = try #require(try fileObject(url)["shortcuts"] as? [String: String])
    #expect(written["a.one"] == "cmd+1")
    #expect(written["a.five"] == "cmd+5")
}

@Test func settingIdenticalOverridesDoesNotPost() throws {
    let store = ConfigStore(url: try tempConfig(#"{"shortcuts":{"a":"cmd+1"}}"#))
    var posts = 0
    let token = NotificationCenter.default.addObserver(forName: ConfigStore.didChange, object: store, queue: nil) { _ in posts += 1 }
    defer { NotificationCenter.default.removeObserver(token) }
    store.shortcutOverrides = ["a": "cmd+1"]
    #expect(posts == 0)
    #expect(!store.hasPendingWrite)
}

@Test func wrongTypesFallBackPerKey() throws {
    let url = try tempConfig(#"{"mod":{"count":"seven","name":"kept","nested":{"a":"bad","b":"also kept"},"list":[1,"x",3],"enabled":false}}"#)
    let store = ConfigStore(url: url)
    var problems: [String] = []
    store.problemHandler = { problems.append($0) }
    let s = store.section("mod", default: Mod())
    #expect(s.count == 3)              // default, "seven" isn't an Int
    #expect(s.name == "kept")
    #expect(s.enabled == false)
    #expect(s.nested == Mod.Nested(a: 1, b: "also kept"))
    #expect(s.list == [1, 3])          // the bad element is dropped
    #expect(problems.count == 1)
    _ = store.section("mod", default: Mod())
    #expect(problems.count == 1)       // reported once
}

@Test func sectionOfWrongTypeUsesDefaults() throws {
    let store = ConfigStore(url: try tempConfig(#"{"mod":"oops"}"#))
    #expect(store.section("mod", default: Mod()) == Mod())
}

@Test func materializeOnlyAddsMissingKeysAndKeepsBadValues() throws {
    let url = try tempConfig(#"{"mod":{"count":"seven","extra":"user note"}}"#)
    let store = ConfigStore(url: url)
    store.materialize("mod", default: Mod())
    store.flush()
    let mod = try #require(try fileObject(url)["mod"] as? [String: Any])
    #expect(mod["count"] as? String == "seven") // the typo is kept for the user to fix
    #expect(mod["extra"] as? String == "user note")
    #expect(mod["name"] as? String == "x")      // missing options are added
    #expect((mod["nested"] as? [String: Any])?["b"] as? String == "b")
}

@Test func materializeIsANoOpWhenComplete() throws {
    let url = try tempConfig()
    let first = ConfigStore(url: url)
    first.materialize("mod", default: Mod())
    first.flush()
    let before = try Data(contentsOf: url)
    let second = ConfigStore(url: url)
    var posts = 0
    let token = NotificationCenter.default.addObserver(forName: ConfigStore.didChange, object: second, queue: nil) { _ in posts += 1 }
    defer { NotificationCenter.default.removeObserver(token) }
    second.materialize("mod", default: Mod())
    #expect(posts == 0)
    #expect(!second.hasPendingWrite)
    second.flush()
    #expect(try Data(contentsOf: url) == before)
}

@Test func invalidJSONOnDiskIsNeverOverwritten() throws {
    let broken = #"{"mod": {"count": 9}"#  // missing brace
    let url = try tempConfig(broken)
    let store = ConfigStore(url: url)
    #expect(store.lastProblem?.contains("not valid JSON") == true)
    store.materialize("mod", default: Mod())
    store.setSection("other", ["k": 1])
    store.flush()
    #expect(String(decoding: try Data(contentsOf: url), as: UTF8.self) == broken)
}

@Test func hugeFilesAreRefused() throws {
    let url = try tempConfig()
    let big = "{\"pad\":\"" + String(repeating: "x", count: ConfigStore.maxFileSize + 10) + "\"}"
    try Data(big.utf8).write(to: url)
    let store = ConfigStore(url: url)
    #expect(store.rawSection("pad") == nil)
    #expect(store.lastProblem?.contains("too large") == true)
    store.setSection("mod", Mod())
    store.flush()
    #expect(try Data(contentsOf: url).count > ConfigStore.maxFileSize) // left alone
}

@Test func symlinkedConfigIsWrittenThrough() throws {
    let real = try tempConfig(#"{"mod":{"count":1}}"#)
    let linkDir = FileManager.default.temporaryDirectory.appendingPathComponent("bento-link-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: linkDir, withIntermediateDirectories: true)
    let link = linkDir.appendingPathComponent("config.json")
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
    let store = ConfigStore(url: link)
    store.setSection("mod", Mod(count: 5))
    store.flush()
    let attrs = try FileManager.default.attributesOfItem(atPath: link.path)
    #expect(attrs[.type] as? FileAttributeType == .typeSymbolicLink)
    #expect((try fileObject(real)["mod"] as? [String: Any])?["count"] as? Int == 5)
}

@Test func pendingWriteDoesNotClobberExternalEdit() throws {
    let url = try tempConfig(#"{"a":{"v":1},"b":{"v":1}}"#)
    let store = ConfigStore(url: url)
    store.setSection("a", ["v": 2])                         // pending, not yet written
    try Data(#"{"a":{"v":1},"b":{"v":7}}"#.utf8).write(to: url, options: .atomic) // editor saves b
    store.flush()
    let obj = try fileObject(url)
    #expect((obj["a"] as? [String: Int])?["v"] == 2)       // ours
    #expect((obj["b"] as? [String: Int])?["v"] == 7)       // theirs
}

@Test func externalEditOfSameSectionWins() throws {
    let url = try tempConfig(#"{"a":{"v":1}}"#)
    let store = ConfigStore(url: url)
    store.setSection("a", ["v": 2])
    try Data(#"{"a":{"v":9}}"#.utf8).write(to: url, options: .atomic)
    store.flush()
    #expect((try fileObject(url)["a"] as? [String: Int])?["v"] == 9)
}

@MainActor @Test func watcherFollowsAtomicSavesAndRecoversFromInvalidJSON() async throws {
    let url = try tempConfig(#"{"a":{"v":1}}"#)
    let store = ConfigStore(url: url)
    var changes: [Set<String>] = []
    let token = NotificationCenter.default.addObserver(forName: ConfigStore.didChange, object: store, queue: .main) { note in
        changes.append(note.userInfo?[ConfigStore.changedSectionsKey] as? Set<String> ?? [])
    }
    defer { NotificationCenter.default.removeObserver(token) }

    // Atomic save (rename over the watched inode), twice: the watcher must re-attach.
    try Data(#"{"a":{"v":2}}"#.utf8).write(to: url, options: .atomic)
    try await settle()
    #expect((store.rawSection("a") as? [String: Int])?["v"] == 2)
    try Data(#"{"a":{"v":3}}"#.utf8).write(to: url, options: .atomic)
    try await settle()
    #expect((store.rawSection("a") as? [String: Int])?["v"] == 3)

    // Invalid JSON is ignored (values kept), then picked up once fixed.
    try Data(#"{"a":{"v":4},"#.utf8).write(to: url, options: .atomic)
    try await settle()
    #expect((store.rawSection("a") as? [String: Int])?["v"] == 3)
    #expect(store.lastProblem != nil)
    try Data(#"{"a":{"v":5}}"#.utf8).write(to: url, options: .atomic)
    try await settle()
    #expect((store.rawSection("a") as? [String: Int])?["v"] == 5)
    #expect(store.lastProblem == nil)

    // Delete, then create later (editors that unlink first): directory watch.
    try FileManager.default.removeItem(at: url)
    try await settle(0.5)
    try Data(#"{"a":{"v":6}}"#.utf8).write(to: url)
    try await settle()
    #expect((store.rawSection("a") as? [String: Int])?["v"] == 6)
    #expect(store.isWatching)
    #expect(changes.filter { $0.contains("a") }.count == 4)

    // In-place write (no rename) on the re-attached watcher.
    let h = try FileHandle(forWritingTo: url)
    h.truncateFile(atOffset: 0)
    h.write(Data(#"{"a":{"v":7}}"#.utf8))
    try h.close()
    try await settle()
    #expect((store.rawSection("a") as? [String: Int])?["v"] == 7)
}

@MainActor @Test func changesMadeWhileFileInvalidAreWrittenOnceFixed() async throws {
    let url = try tempConfig(#"{"a":{"v":1}}"#)
    let store = ConfigStore(url: url)
    try Data("{oops".utf8).write(to: url, options: .atomic)
    try await settle(0.5)
    store.setSection("b", ["v": 2])
    try await settle()                                   // debounced write is held back
    #expect(String(decoding: try Data(contentsOf: url), as: UTF8.self) == "{oops")
    try Data(#"{"a":{"v":1}}"#.utf8).write(to: url, options: .atomic)
    try await settle(1.2)
    let obj = try fileObject(url)
    #expect((obj["b"] as? [String: Int])?["v"] == 2)
    #expect((obj["a"] as? [String: Int])?["v"] == 1)
}

// MARK: - HotkeyCenter

/// Obscure combinations nobody uses, so the momentary system registration
/// in tests can't collide with real apps.
private let testKeys = ["hyper+f17", "hyper+f18", "hyper+f19", "ctrl+opt+shift+f16"].compactMap(Shortcut.init)

@MainActor @Suite(.serialized) struct HotkeyCenterTests {
    @Test func suspendNestsAndBalances() throws {
        let hc = HotkeyCenter.shared
        #expect(!hc.isSuspended)
        let t = try #require(hc.register(testKeys[0]) {})
        hc.suspend()
        hc.suspend()
        #expect(hc.isSuspended)
        #expect(hc.isActive(t))
        hc.resume()
        #expect(hc.isSuspended)        // still one outstanding suspend
        hc.resume()
        #expect(!hc.isSuspended)
        #expect(hc.isActive(t))
        hc.resume()                    // unbalanced resume is ignored
        #expect(!hc.isSuspended)
        hc.unregister(t)
        #expect(!hc.isActive(t))
    }

    @Test func duplicatesAreRefusedEvenWhileSuspended() throws {
        let hc = HotkeyCenter.shared
        let t = try #require(hc.register(testKeys[1]) {})
        defer { hc.unregister(t) }
        #expect(hc.register(testKeys[1]) {} == nil)   // Carbon refuses
        hc.suspend()
        #expect(hc.register(testKeys[1]) {} == nil)   // checked while suspended too
        let t2 = try #require(hc.register(testKeys[2]) {})
        hc.resume()
        #expect(hc.isActive(t2))
        hc.unregister(t2)
    }
}

// MARK: - ActionRegistry

private final class FakeModule: BentoModule {
    let id: String
    let title = "Fake"
    let symbol = "star"
    var defs: [(String, String?)]
    var fired: [String] = []
    init(_ id: String, _ defs: [(String, String?)]) { self.id = id; self.defs = defs }
    var actions: [BentoAction] { defs.map { d in BentoAction(d.0, d.0, shortcut: d.1) { [weak self] in self?.fired.append(d.0) } } }
    func start() {}
    func stop() {}
}

/// The registry uses ConfigStore.shared: point it at a temp dir first, and
/// refuse to run if anything already resolved the real config.
private let isolatedHome: Bool = {
    let home = FileManager.default.temporaryDirectory.appendingPathComponent("bento-test-home-\(getpid())").path
    setenv("BENTO_HOME", home, 1)
    let ok = AppPaths.configDir.path.hasPrefix(home)
    if !ok { print("isolatedHome: configDir=\(AppPaths.configDir.path) home=\(home)") }
    return ok
}()

@MainActor @Suite(.serialized) struct ActionRegistryTests {
    // Isolation must be checked before anything touches ActionRegistry.shared
    // (which creates ConfigStore.shared): never write the user's real config.
    init() throws { try #require(isolatedHome) }
    var reg: ActionRegistry { ActionRegistry.shared }

    @Test func batchCoalescesReloadsAndDiffKeepsRegistrations() throws {
        try #require(isolatedHome)
        let m = FakeModule("fakea", [("fakea.one", nil), ("fakea.two", nil), ("fakea.three", nil)])
        reg.isModuleEnabled = { _ in true }
        reg.setModules([m])
        let before = reg.reloadCount
        reg.setShortcuts(["fakea.one": testKeys[0], "fakea.two": testKeys[1], "fakea.three": nil])
        #expect(reg.reloadCount == before + 1)
        #expect(reg.failed.isEmpty)
        let entries = HotkeyCenter.shared.registrationCount
        reg.reload()
        reg.reload()
        #expect(HotkeyCenter.shared.registrationCount == entries) // no leaked registrations
        // Swap two shortcuts in one batch: both must stay live.
        reg.setShortcuts(["fakea.one": testKeys[1], "fakea.two": testKeys[0]])
        #expect(reg.failed.isEmpty)
        #expect(reg.shortcut(for: "fakea.one") == testKeys[1])
        reg.setShortcuts(["fakea.one": nil, "fakea.two": nil])
        #expect(HotkeyCenter.shared.registrationCount == entries - 2)
        reg.setModules([])
    }

    @Test func conflictsAndDuplicatesAreReported() throws {
        try #require(isolatedHome)
        let m = FakeModule("fakeb", [("fakeb.one", testKeys[2].configString), ("fakeb.two", testKeys[2].configString), ("fakeb.one", nil)])
        reg.isModuleEnabled = { _ in true }
        reg.setModules([m])
        #expect(reg.duplicateIDs == ["fakeb.one"])
        #expect(reg.failed == ["fakeb.two"])
        #expect(reg.failureReason(for: "fakeb.two")?.contains("fakeb.one") == true)
        #expect(reg.perform("fakeb.one"))
        #expect(m.fired == ["fakeb.one"])
        reg.setModules([])
        #expect(reg.failed.isEmpty)
    }

    @Test func disabledModuleShortcutsCanBeClearedAndReset() throws {
        try #require(isolatedHome)
        let m = FakeModule("fakec", [("fakec.one", testKeys[3].configString)])
        reg.isModuleEnabled = { _ in false }
        reg.setModules([m])
        #expect(reg.shortcut(for: "fakec.one") == testKeys[3])
        reg.setShortcut(nil, for: "fakec.one")                    // unbinding sticks...
        #expect(reg.shortcut(for: "fakec.one") == nil)
        reg.setShortcut(testKeys[3], for: "fakec.one")            // ...and the default clears the override
        #expect(ConfigStore.shared.shortcutOverrides["fakec.one"] == nil)
        reg.isModuleEnabled = { _ in true }
        reg.setModules([])
    }
}

// MARK: - ShortcutRecorder

@MainActor @Suite(.serialized) struct RecorderTests {
    private func hostedRecorder() -> (NSWindow, RecorderView) {
        // Never let the test process activate itself (it would take focus from the user).
        NSApplication.shared.setActivationPolicy(.prohibited)
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 200, height: 40), styleMask: [.titled], backing: .buffered, defer: true)
        w.isReleasedWhenClosed = false
        let v = RecorderView(frame: NSRect(x: 0, y: 0, width: 150, height: 24))
        w.contentView?.addSubview(v)
        return (w, v)
    }

    @Test func removingARecordingRecorderResumesHotkeys() {
        let (w, v) = hostedRecorder()
        #expect(v.accessibilityPerformPress())
        #expect(v.isRecording)
        #expect(HotkeyCenter.shared.isSuspended)
        v.removeFromSuperview()
        #expect(!v.isRecording)
        #expect(!HotkeyCenter.shared.isSuspended)
        w.close()
    }

    @Test func recorderTornDownWhileRecordingIsReleased() async throws {
        let (w, _) = hostedRecorder()
        weak var weakView: RecorderView?
        autoreleasepool {
            let v = RecorderView(frame: .zero)
            w.contentView?.addSubview(v)
            _ = v.accessibilityPerformPress()
            #expect(HotkeyCenter.shared.isSuspended)
            weakView = v
            w.contentView = NSView() // the settings window dropping its content
        }
        #expect(!HotkeyCenter.shared.isSuspended)
        try await settle(0.3)        // let AppKit drop deferred references
        #expect(weakView == nil)     // no retain cycle through the event monitor/observers
        #expect(!HotkeyCenter.shared.isSuspended)
        w.close()
    }

    @Test func twoRecordersAndDisablingKeepBalance() {
        let (w, a) = hostedRecorder()
        let b = RecorderView(frame: NSRect(x: 0, y: 0, width: 150, height: 24))
        w.contentView?.addSubview(b)
        _ = a.accessibilityPerformPress()
        _ = b.accessibilityPerformPress()         // starting b ends a: one recorder at a time
        #expect(!a.isRecording)
        #expect(b.isRecording)
        #expect(HotkeyCenter.shared.isSuspended)
        b.isEnabled = false                       // disabling cancels recording
        #expect(!b.isRecording)
        #expect(!HotkeyCenter.shared.isSuspended)
        #expect(!b.accessibilityPerformPress())   // disabled recorders don't start
        _ = a.accessibilityPerformPress()
        _ = a.accessibilityPerformPress()          // toggles off
        #expect(!HotkeyCenter.shared.isSuspended)
        w.close()
    }

    @Test func closingTheWindowEndsRecording() {
        let (w, v) = hostedRecorder()
        _ = v.accessibilityPerformPress()
        #expect(HotkeyCenter.shared.isSuspended)
        NotificationCenter.default.post(name: NSWindow.willCloseNotification, object: w)
        #expect(!v.isRecording)
        #expect(!HotkeyCenter.shared.isSuspended)
        w.close()
    }

    @Test func validatesEveryKeyAndModifierCombination() {
        let combos: [NSEvent.ModifierFlags] = [[], [.shift], [.command], [.option], [.control], [.command, .shift],
                                               [.control, .option, .command, .shift], [.function], [.capsLock, .command]]
        for code in UInt32(0)...UInt32(0xFFFF) where code < 256 || code % 4099 == 0 {
            for m in combos { _ = RecorderView.shortcut(keyCode: code, modifiers: m) }
        }
        #expect(RecorderView.shortcut(keyCode: 0, modifiers: [.capsLock]) == nil)
        #expect(RecorderView.shortcut(keyCode: 0, modifiers: [.capsLock, .option]) == Shortcut("opt+a"))
        #expect(RecorderView.shortcut(keyCode: 123, modifiers: [.function, .control]) == Shortcut("ctrl+left")) // arrows carry fn
        #expect(RecorderView.shortcut(keyCode: 59, modifiers: [.control]) == nil)  // bare Control
        #expect(RecorderView.shortcut(keyCode: 63, modifiers: [.function]) == nil) // Fn key
        #expect(RecorderView.shortcut(keyCode: 0xFFFF, modifiers: [.command]) == nil)
    }
}

// MARK: - Shortcut parsing edge cases

@Test func shortcutParsingNeverTraps() {
    for s in ["", "+", "++", "cmd+", "+a", "cmd++", "hyper", "key", "key99999999999", "key4294967295", "f99", "cmd+shift",
              "⌘+a", "CMD+A", " cmd + a ", "fn+f1", "meh+hyper+x", String(repeating: "cmd+", count: 500) + "a"] {
        if let sc = Shortcut(s) {
            _ = sc.displayString
            _ = sc.configString
            _ = sc.menuKeyEquivalent
            #expect(Shortcut(sc.configString) == sc)
        }
    }
    for code in UInt32(0)...UInt32(300) {
        let sc = Shortcut(keyCode: code, modifiers: [.command])
        #expect(Shortcut(sc.configString) == sc)
        _ = sc.displayString
        _ = sc.menuKeyEquivalent
    }
}
