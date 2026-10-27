import AppKit
import Carbon.HIToolbox
import Foundation
import Testing
import BentoCore
@testable import BentoShell

private final class FakeModule: BentoModule {
    let id: String
    let title: String
    let symbol = "square"
    let actions: [BentoAction]
    init(_ id: String, _ title: String, _ actions: [BentoAction]) {
        self.id = id
        self.title = title
        self.actions = actions
    }
    func start() {}
    func stop() {}
}

private func action(_ id: String, _ title: String, group: String? = nil, _ shortcut: String? = nil) -> BentoAction {
    BentoAction(id, title, group: group, shortcut: shortcut) {}
}

private let shot = FakeModule("shot", "Capture", [
    action("shot.window", "Capture Window"),
    action("shot.area", "Capture Area", "cmd+shift+2"),
    action("shot.fullscreen", "Capture Fullscreen", "cmd+shift+1"),
])
private let windows = FakeModule("windows", "Windows", [
    action("windows.left-half", "Left Half", group: "Halves", "ctrl+opt+left"),
    action("windows.right-half", "Right Half", group: "Halves", "ctrl+opt+right"),
    action("windows.first-fourth", "First Fourth", group: "Fourths"),
    action("windows.center", "Center", group: "Size", "ctrl+opt+c"),
])
private let tiling = FakeModule("tiling", "Tiling", [action("tiling.move-left", "Move Left", "hyper+h")])
private let modules: [BentoModule] = [shot, windows, tiling, AppActionsModule()]

/// The catalog as the overview builds it from the registry, without
/// registering real hotkeys: Tiling off, one shortcut taken by another app.
private func catalog(enabled: Set<String> = ["shot", "windows", "bento"], overrides: [String: String?] = [:]) -> [OverviewSection] {
    let live = modules.filter { enabled.contains($0.id) }.flatMap(\.actions)
    let byID = Dictionary(modules.flatMap(\.actions).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    return OverviewCatalog.build(
        modules: modules, isEnabled: enabled.contains, actions: live,
        shortcut: { id in overrides[id].map { $0.flatMap(Shortcut.init) } ?? byID[id]?.defaultShortcut },
        problem: { $0 == "shot.fullscreen" ? "Couldn’t be registered" : nil })
}

private func ids(_ sections: [OverviewSection]) -> [String] { sections.flatMap(\.items).map(\.id) }

// MARK: - Grouping

@Test func groupsByModuleWithShortcutsFirst() {
    let sections = catalog()
    #expect(sections.map(\.id) == ["shot", "windows", "tiling", "bento"])
    #expect(sections.map(\.isEnabled) == [true, true, false, true])
    // Within a module: bound actions first (in module order), then the rest.
    #expect(sections[0].items.map(\.id) == ["shot.area", "shot.fullscreen", "shot.window"])
    #expect(sections[1].items.map(\.id) == ["windows.left-half", "windows.right-half", "windows.center", "windows.first-fourth"])
    // Off modules are listed by name only.
    #expect(sections[2].items.isEmpty)
    #expect(sections[3].items.map(\.id) == [KeyboardOverview.actionID])
    #expect(sections[3].items[0].shortcut == Shortcut("opt+slash"))
}

@Test func carriesCurrentShortcutsAndProblems() {
    let sections = catalog(overrides: ["windows.left-half": "hyper+left", "windows.center": nil])
    let items = Dictionary(uniqueKeysWithValues: sections.flatMap(\.items).map { ($0.id, $0) })
    #expect(items["windows.left-half"]?.shortcut == Shortcut("hyper+left"))
    #expect(items["windows.center"]?.shortcut == nil)
    #expect(items["shot.fullscreen"]?.problem == "Couldn’t be registered")
    #expect(items["shot.area"]?.problem == nil)
    #expect(items["windows.left-half"]?.moduleTitle == "Windows")
    // An action unbound by the user moves behind the bound ones.
    #expect(sections[1].items.last?.id == "windows.center")
}

@Test func onlyRegisteredActionsAreListedOnce() {
    // The registry drops duplicate ids (first declaration wins) and actions of off modules.
    let dup = FakeModule("dup", "Dup", [action("shot.area", "Again", "ctrl+opt+a"), action("dup.own", "Own")])
    let sections = OverviewCatalog.build(
        modules: [shot, dup], isEnabled: { _ in true }, actions: shot.actions + [dup.actions[1]],
        shortcut: { _ in nil }, problem: { _ in nil })
    #expect(ids(sections) == ["shot.window", "shot.area", "shot.fullscreen", "dup.own"])
}

@Test func hyperIsExplainedOnlyWhenUsed() {
    #expect(!OverviewCatalog.usesHyper(catalog()))
    #expect(OverviewCatalog.usesHyper(catalog(enabled: ["shot", "windows", "tiling"])))
    #expect(OverviewCatalog.usesHyper(catalog(overrides: ["shot.area": "ctrl+opt+cmd+shift+2"])))
}

@Test func keycapsFollowMenuOrder() {
    #expect(OverviewCatalog.keycaps(Shortcut("cmd+shift+2")!) == ["⇧", "⌘", "2"])
    #expect(OverviewCatalog.keycaps(Shortcut("hyper+h")!) == ["⌃", "⌥", "⇧", "⌘", "H"])
    #expect(OverviewCatalog.keycaps(Shortcut("ctrl+opt+slash")!) == ["⌃", "⌥", "/"])
    #expect(OverviewCatalog.keycaps(Shortcut("opt+slash")!) == ["⌥", "/"])
    #expect(OverviewCatalog.keycaps(Shortcut("ctrl+opt+space")!) == ["⌃", "⌥", "Space"])
}

// MARK: - Search

@Test func searchByTitle() {
    let left = OverviewCatalog.filter(catalog(), query: "left")
    #expect(ids(left) == ["windows.left-half"])
    #expect(left.map(\.id) == ["windows"])
    #expect(ids(OverviewCatalog.filter(catalog(), query: "  Capture   AREA ")) == ["shot.area"])
    #expect(ids(OverviewCatalog.filter(catalog(), query: "keyboard")) == [KeyboardOverview.actionID])
}

@Test func searchByModuleAndGroup() {
    #expect(ids(OverviewCatalog.filter(catalog(), query: "windows")) == ids([catalog()[1]]))
    #expect(ids(OverviewCatalog.filter(catalog(), query: "halves")) == ["windows.left-half", "windows.right-half"])
    // Tokens combine: module + title.
    #expect(ids(OverviewCatalog.filter(catalog(), query: "win half")) == ["windows.left-half", "windows.right-half"])
    #expect(ids(OverviewCatalog.filter(catalog(), query: "capture half")).isEmpty)
}

@Test func searchByKey() {
    let c = catalog()
    // Symbols in any modifier order, with or without the key.
    #expect(ids(OverviewCatalog.filter(c, query: "⌘⇧2")) == ["shot.area"])
    #expect(ids(OverviewCatalog.filter(c, query: "⇧⌘2")) == ["shot.area"])
    #expect(ids(OverviewCatalog.filter(c, query: "⌘⇧")) == ["shot.area", "shot.fullscreen"])
    #expect(ids(OverviewCatalog.filter(c, query: "⌃⌥c")) == ["windows.center"])
    #expect(ids(OverviewCatalog.filter(c, query: "⌥/")) == [KeyboardOverview.actionID])
    #expect(ids(OverviewCatalog.filter(c, query: "⌃⌥/")).isEmpty)
    // Config names and spelled-out modifiers.
    #expect(ids(OverviewCatalog.filter(c, query: "cmd+shift+1")) == ["shot.fullscreen"])
    #expect(ids(OverviewCatalog.filter(c, query: "command")) == ["shot.area", "shot.fullscreen"])
    #expect(ids(OverviewCatalog.filter(c, query: "control option")) == ["windows.left-half", "windows.right-half", "windows.center"])
    #expect(ids(OverviewCatalog.filter(c, query: "option")) == ["windows.left-half", "windows.right-half", "windows.center", KeyboardOverview.actionID])
    #expect(ids(OverviewCatalog.filter(c, query: "slash")) == [KeyboardOverview.actionID])
    // Unbound actions only match by name.
    #expect(ids(OverviewCatalog.filter(c, query: "⌘ fourth")).isEmpty)
}

@Test func searchKeepsTheEditedActionListed() {
    let c = catalog()
    // Capture Area changed away from ⌘⇧2 still shows in the "⌘⇧2" results it came from.
    let changed = catalog(overrides: ["shot.area": "cmd+shift+3"])
    #expect(ids(OverviewCatalog.filter(changed, query: "⌘⇧2")).isEmpty)
    #expect(ids(OverviewCatalog.filter(changed, query: "⌘⇧2", keeping: "shot.area")) == ["shot.area"])
    #expect(ids(OverviewCatalog.filter(c, query: "left", keeping: "shot.area")) == ["shot.area", "windows.left-half"])
    // Nothing to keep in an off module, and an empty search lists everything anyway.
    #expect(ids(OverviewCatalog.filter(c, query: "left", keeping: "tiling.move-left")) == ["windows.left-half"])
    #expect(OverviewCatalog.filter(c, query: "", keeping: "shot.area") == c)
}

@Test func searchShowsOffModulesByName() {
    #expect(OverviewCatalog.filter(catalog(), query: "").map(\.id) == ["shot", "windows", "tiling", "bento"])
    let t = OverviewCatalog.filter(catalog(), query: "tiling")
    #expect(t.map(\.id) == ["tiling"])
    #expect(t[0].isEnabled == false)
    #expect(OverviewCatalog.filter(catalog(), query: "move").isEmpty) // an off module's actions aren't searched
    #expect(OverviewCatalog.filter(catalog(), query: "zzz").isEmpty)
}

// MARK: - Apps from the search

private let hotkeys = FakeModule("launcher", "App Hotkeys", [
    action("launcher.safari", "Open Safari", group: "Apps", "hyper+s"),
    action("launcher.notes", "Open Notes", group: "Apps"),
])

private func found(_ name: String) -> FoundApp {
    FoundApp(id: "com.example.\(name.lowercased())", name: name, url: URL(fileURLWithPath: "/Applications/\(name).app"),
             bundleID: "com.example.\(name.lowercased())")
}

private func appCatalog(launcherOn: Bool = true) -> [OverviewSection] {
    let all: [BentoModule] = [shot, hotkeys, AppActionsModule()]
    let enabled: Set<String> = launcherOn ? ["shot", "launcher", "bento"] : ["shot", "bento"]
    return OverviewCatalog.build(
        modules: all, isEnabled: enabled.contains, actions: all.filter { enabled.contains($0.id) }.flatMap(\.actions),
        shortcut: { id in all.flatMap(\.actions).first { $0.id == id }?.defaultShortcut }, problem: { _ in nil },
        icon: { $0 == "launcher.safari" ? URL(fileURLWithPath: "/Applications/Safari.app") : nil })
}

@Test func entriesCarryTheirIcons() {
    let items = Dictionary(uniqueKeysWithValues: appCatalog().flatMap(\.items).map { ($0.id, $0) })
    #expect(items["launcher.safari"]?.icon?.path == "/Applications/Safari.app")
    #expect(items["launcher.notes"]?.icon == nil)
    #expect(items["shot.area"]?.icon == nil)
}

@Test func foundAppsFollowTheMatchingEntries() {
    let all = appCatalog()
    let filtered = OverviewCatalog.filter(all, query: "open")
    #expect(ids(filtered) == ["launcher.safari", "launcher.notes"])
    let sections = OverviewCatalog.adding([found("Opera"), found("OpenEmu")], to: filtered, from: all, in: "launcher")
    #expect(sections.map(\.id) == ["launcher"])
    #expect(ids(sections) == ["launcher.safari", "launcher.notes", "app:com.example.opera", "app:com.example.openemu"])
    let opera = sections[0].items[2]
    #expect(opera.title == "Open Opera")   // what the entry will be called
    #expect(opera.moduleTitle == "App Hotkeys")
    #expect(opera.shortcut == nil && opera.problem == nil)
    #expect(opera.icon?.path == "/Applications/Opera.app")
    #expect(opera.app == found("Opera"))
}

@Test func foundAppsBringBackTheirSectionInModuleOrder() {
    let all = appCatalog()
    // "capture" matches no entry: the section is added for the apps, after Capture.
    let filtered = OverviewCatalog.filter(all, query: "capture")
    let sections = OverviewCatalog.adding([found("Capture One")], to: filtered, from: all, in: "launcher")
    #expect(sections.map(\.id) == ["shot", "launcher"])
    #expect(sections[1].items.map(\.id) == ["app:com.example.capture one"])
    #expect(sections[1].title == "App Hotkeys" && sections[1].isEnabled)
    // Nothing found: unchanged.
    #expect(OverviewCatalog.adding([], to: filtered, from: all, in: "launcher") == filtered)
}

@Test func noAppsWhileAppHotkeysIsOff() {
    let all = appCatalog(launcherOn: false)
    let filtered = OverviewCatalog.filter(all, query: "capture")
    #expect(OverviewCatalog.adding([found("Capture One")], to: filtered, from: all, in: "launcher") == filtered)
}

@Test func foundAppsAreListedOnce() {
    let all = appCatalog()
    let once = OverviewCatalog.adding([found("Opera")], to: OverviewCatalog.filter(all, query: "op"), from: all, in: "launcher")
    let twice = OverviewCatalog.adding([found("Opera")], to: once, from: all, in: "launcher")
    #expect(ids(twice) == ids(once))
}

@Test func recordLinkFiltersToTheActionAndRecords() {
    let nav = SettingsNavigator()
    nav.actionTitle = { $0 == "launcher.ab12" ? "Open Opera" : nil }
    nav.select("record/launcher.ab12")
    #expect(nav.page == .shortcuts)
    #expect(nav.shortcutsFilter == "Open Opera")
    #expect(nav.recordRequest == "launcher.ab12")
    // An action the registry doesn't know yet is filtered by its id.
    nav.select("record/launcher.zz")
    #expect(nav.shortcutsFilter == "launcher.zz")
    nav.select("windows")
    #expect(nav.recordRequest == nil)   // never records on a later visit
}

@MainActor @Suite(.serialized) struct SettingsRecordingTests {
    private final class Button: NSView {
        var presses = 0
        override func accessibilityPerformPress() -> Bool { presses += 1; return true }
    }

    private func host() -> (NSWindow, Button, SettingsNavigator) {
        NSApplication.shared.setActivationPolicy(.prohibited)
        let window = NSWindow(contentRect: .zero, styleMask: [], backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false
        let button = Button()
        button.setAccessibilityIdentifier("recorder:launcher.test")
        window.contentView?.addSubview(button)
        let nav = SettingsNavigator()
        nav.actionTitle = { _ in "Open Test" }
        nav.select("record/launcher.test")
        return (window, button, nav)
    }

    @Test func waitsForActivationAndStartsOnce() async throws {
        let (window, button, nav) = host()
        defer { window.close() }
        var ready = false
        nav.record("launcher.test", in: window, ready: { _ in ready })
        #expect(button.presses == 0)
        ready = true
        try await Task.sleep(nanoseconds: 160_000_000)
        #expect(button.presses == 1)
    }

    @Test func timeoutNeverStartsInAnInactiveWindow() async throws {
        let (window, button, nav) = host()
        defer { window.close() }
        var checks = 0
        nav.record("launcher.test", in: window, attempts: 2, ready: { _ in checks += 1; return false })
        try await Task.sleep(nanoseconds: 160_000_000)
        #expect(checks == 3)
        #expect(button.presses == 0)
    }

    @Test func navigatingOrClosingCancelsActivationRetries() async throws {
        let (window, button, nav) = host()
        defer { window.close() }
        var ready = false
        nav.record("launcher.test", in: window, ready: { _ in ready })
        nav.select("shortcuts")
        ready = true
        try await Task.sleep(nanoseconds: 160_000_000)
        #expect(button.presses == 0)
        ready = false
        nav.record("launcher.test", in: window, ready: { _ in ready })
        nav.cancelRecordingRequest()   // ShortcutsPane disappearing, including window close
        ready = true
        try await Task.sleep(nanoseconds: 160_000_000)
        #expect(button.presses == 0)
    }

    @Test func aNewRequestCancelsOldLayoutRetries() async throws {
        let (window, button, nav) = host()
        defer { window.close() }
        button.removeFromSuperview()
        nav.record("launcher.test", in: window, ready: { _ in true })
        nav.select("record/launcher.other")
        window.contentView?.addSubview(button)
        try await Task.sleep(nanoseconds: 160_000_000)
        #expect(button.presses == 0)
    }

    @Test func oldPaneTeardownDoesNotCancelANewRequest() async throws {
        let (window, button, nav) = host()
        defer { window.close() }
        var ready = false
        let old = try #require(nav.record("launcher.test", in: window, ready: { _ in ready }))
        nav.select("record/launcher.test")
        nav.record("launcher.test", in: window, ready: { _ in ready })
        nav.cancelRecordingRequest(old)
        ready = true
        try await Task.sleep(nanoseconds: 160_000_000)
        #expect(button.presses == 1)
    }
}

// MARK: - Settings links

@Test func settingsLinks() {
    #expect(OverviewCatalog.settingsPage(for: "windows") == "windows")
    #expect(OverviewCatalog.settingsPage(for: AppActionsModule.moduleID) == "shortcuts")

    let nav = SettingsNavigator()
    nav.select("shortcuts/Left Half")
    #expect(nav.page == .shortcuts)
    #expect(nav.shortcutsFilter == "Left Half")
    nav.select("windows")
    #expect(nav.page == .module("windows"))
    #expect(nav.shortcutsFilter == nil)   // a filter not taken yet doesn't outlive other navigation
    nav.select("shortcuts")
    #expect(nav.page == .shortcuts)
    #expect(nav.shortcutsFilter == "")    // plain Shortcuts clears a filter from before
    nav.select(nil)
    #expect(nav.page == .general)
}

@Test func settingsLinksKeepTheFiltersSlashes() {
    func page(_ s: String) -> String? { AppDelegate.settingsPage(URL(string: s)!) }
    #expect(page("bento://settings") == nil)
    #expect(page("bento://settings/") == nil)
    #expect(page("bento://settings/windows") == "windows")
    #expect(page("bento://settings/windows/") == "windows")
    #expect(page("bento://settings/shortcuts/Left%20Half") == "shortcuts/Left Half")
    #expect(page("bento://settings/shortcuts/%2F") == "shortcuts//")
    #expect(page("bento://settings/shortcuts/Left%2F") == "shortcuts/Left/")
    #expect(page("bento://settings/shortcuts/") == "shortcuts/")
}

// MARK: - The default shortcut

private let overview = Shortcut(KeyboardOverview.defaultShortcut)!

@Test func defaultShortcutIsOptionSlash() {
    #expect(overview.modifiers == [.option])
    #expect(overview.keyCode == UInt32(kVK_ANSI_Slash))
    #expect(overview.isSafeGlobalHotkey)
    #expect(overview.displayString == "⌥/")
    // Registered by key position: never needs Shift, whatever the layout types there.
    #expect(!overview.modifiers.contains(.shift))
}

/// Every shortcut literal in Sources (module defaults, Rectangle/Spectacle
/// import tables, window-local keys): none may be ⌥/. Literals with an
/// interpolated key ("ctrl+opt+cmd+\(key)") count when their modifiers match.
@Test func defaultShortcutCollidesWithNoOtherShortcut() throws {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let sources = root.appendingPathComponent("Sources")
    let files = try #require(FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil))
        .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" && $0.lastPathComponent != "KeyboardOverview.swift" }
    #expect(files.count > 50)
    let literal = try NSRegularExpression(pattern: #""((?:(?:ctrl|control|ctl|⌃|opt|option|alt|⌥|cmd|command|⌘|super|win|shift|⇧|fn|function|hyper|meh)\+)+[^"\s]+)""#,
                                          options: .caseInsensitive)
    var seen = 0
    var collisions: [String] = []
    for file in files {
        let text = try String(contentsOf: file, encoding: .utf8)
        for m in literal.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            let s = String(text[Range(m.range(at: 1), in: text)!])
            if s.contains("\\(") {
                let mods = s.split(separator: "+").dropLast().joined(separator: "+")
                guard let probe = Shortcut(mods + "+a") else { continue }
                seen += 1
                if probe.modifiers == overview.modifiers { collisions.append("\(file.lastPathComponent): \(s)") }
            } else if let sc = Shortcut(s) {
                seen += 1
                if sc == overview { collisions.append("\(file.lastPathComponent): \(s)") }
            }
        }
    }
    #expect(seen > 40)
    #expect(collisions.isEmpty, "⌥/ is also used by: \(collisions)")
}

@Test func defaultShortcutIsNotAMacOSShortcut() {
    // macOS defaults on the slash key or near ⌃⌥: Help menu search, Spotlight,
    // input sources, Emoji & Symbols, zoom, invert colours, contrast.
    let macOS = ["cmd+shift+slash", "cmd+space", "opt+cmd+space", "ctrl+space", "ctrl+opt+space", "ctrl+cmd+space",
                 "opt+cmd+8", "ctrl+opt+cmd+8", "ctrl+opt+cmd+comma", "ctrl+opt+cmd+period"].compactMap(Shortcut.init)
    #expect(macOS.count == 10)
    #expect(!macOS.contains(overview))
    // The live list on this Mac (what the registry checks before registering).
    #expect(!SystemShortcuts.isReserved(overview))
}

/// macOS 15 refused some Option-only hotkeys in RegisterEventHotKey: the
/// default must register (non-exclusively, so another app holding it too
/// doesn't fail this).
@MainActor @Test func defaultShortcutRegistersAsAGlobalHotkey() throws {
    let token = try #require(HotkeyCenter.shared.register(overview) {})
    #expect(HotkeyCenter.shared.isActive(token))
    HotkeyCenter.shared.unregister(token)
}

// MARK: - Changing a shortcut in place (real registry, isolated config)

/// The registry uses ConfigStore.shared: point it at a temp dir first, and
/// refuse to run if anything already resolved the real config.
private let isolatedHome: Bool = {
    let home = FileManager.default.temporaryDirectory.appendingPathComponent("bento-overview-test-home-\(getpid())").path
    setenv("BENTO_HOME", home, 1)
    return AppPaths.configDir.path.hasPrefix(home)
}()

/// App Hotkeys stand-in: entries store their own binding, the search finds one app.
private final class FakeHotkeys: BentoModule, AppHotkeyProvider, AppSearch {
    let id = "fakehotkeys"
    let title = "App Hotkeys"
    let symbol = "app"
    var entries: [String: Shortcut?] = [:]
    var actions: [BentoAction] {
        entries.keys.sorted().map { id in
            BentoAction(id, "Open Opera", shortcut: entries[id]??.configString, bindingWriter: { [weak self] sc in
                self?.entries[id] = sc
                ActionRegistry.shared.reload()
            }) {}
        }
    }
    func start() {}
    func stop() {}
    func makeAppSearch(changed: @escaping () -> Void) -> AppSearch { self }
    func results(_ query: String, limit: Int) -> [FoundApp] { entries.isEmpty && !query.isEmpty ? [found("Opera")] : [] }
    func addApp(_ app: FoundApp) -> String {
        entries["fakehotkeys.opera"] = .some(nil)
        ActionRegistry.shared.reload()
        return "fakehotkeys.opera"
    }
    func removeEntry(_ actionID: String) -> Bool { entries.removeValue(forKey: actionID) != nil }
    func iconFile(for actionID: String) -> URL? { nil }
}

@MainActor @Suite(.serialized) struct OverviewEditingTests {
    // Unusual combinations, so the real registrations can't clash with anything.
    private let keyA = Shortcut("hyper+f13")!, keyB = Shortcut("hyper+f14")!, keyC = Shortcut("hyper+f15")!
    var reg: ActionRegistry { ActionRegistry.shared }

    init() throws {
        try #require(isolatedHome)
        _ = NSApplication.shared   // the conflict HUD is a panel
    }

    private func setUp(_ modules: [BentoModule]) -> OverviewModel {
        ConfigStore.shared.shortcutOverrides = [:]
        reg.isModuleEnabled = { _ in true }
        reg.setModules(modules)
        let model = OverviewModel()
        model.reload()
        return model
    }

    @Test func usersOnTheOldDefaultGetTheNewOneCustomisedShortcutsStay() throws {
        reg.isModuleEnabled = { _ in true }
        ConfigStore.shared.shortcutOverrides = [:]   // never changed: nothing is stored
        reg.setModules([AppActionsModule()])
        #expect(reg.shortcut(for: KeyboardOverview.actionID) == Shortcut("opt+slash"))
        #expect(reg.failureReason(for: KeyboardOverview.actionID) == nil)
        ConfigStore.shared.shortcutOverrides = [KeyboardOverview.actionID: keyA.configString]
        #expect(reg.shortcut(for: KeyboardOverview.actionID) == keyA)
        ConfigStore.shared.shortcutOverrides = [KeyboardOverview.actionID: ""]   // removed by the user
        #expect(reg.shortcut(for: KeyboardOverview.actionID) == nil)
        ConfigStore.shared.shortcutOverrides = [:]
        reg.setModules([])
    }

    @Test func editingRecordsInTheRowAndStoresLikeSettings() throws {
        let m = FakeModule("fakeov", "Fake", [action("fakeov.one", "First Thing", keyA.configString),
                                              action("fakeov.two", "Second Thing", keyB.configString)])
        let model = setUp([m, AppActionsModule()])
        var recorded: [String] = []
        var ended = 0
        model.onRecord = { recorded.append($0) }
        model.onRecordingEnded = { ended += 1 }
        var opened: [String?] = []
        model.onOpenSettings = { opened.append($0) }

        model.query = "second"
        let item = try #require(model.selectedItem)
        #expect(item.id == "fakeov.two")
        model.editShortcut(item)
        #expect(model.editingID == "fakeov.two" && recorded == ["fakeov.two"])
        #expect(opened.isEmpty)   // never Settings

        // The row's recorder starts, then stores a combination another action has:
        // it moves (as in Settings), through the same overrides Settings writes.
        model.recordingChanged("fakeov.two", true)
        #expect(model.isRecording)
        model.recordingChanged("fakeov.two", false)
        reg.assign(keyA, to: "fakeov.two")
        model.reload()
        #expect(!model.isRecording && model.editingID == nil && ended == 1)
        #expect(reg.shortcut(for: "fakeov.two") == keyA && reg.shortcut(for: "fakeov.one") == nil)
        #expect(ConfigStore.shared.shortcutOverrides["fakeov.two"] == keyA.configString)
        #expect(ConfigStore.shared.shortcutOverrides["fakeov.one"] == "")
        #expect(model.selectedID == "fakeov.two")
        #expect(model.items.first { $0.id == "fakeov.two" }?.shortcut == keyA)

        // Searching by the old keys: the edited action stays until the search changes.
        model.query = "⌃⌥⇧⌘f13"
        let byKeys = try #require(model.items.first { $0.id == "fakeov.two" })
        model.editShortcut(byKeys)
        model.recordingChanged("fakeov.two", true)
        model.recordingChanged("fakeov.two", false)
        reg.assign(keyC, to: "fakeov.two")
        model.reload()
        #expect(model.items.map(\.id).contains("fakeov.two"))
        model.query = "⌃⌥⇧⌘f13 "
        #expect(!model.items.map(\.id).contains("fakeov.two"))

        // Esc: recording ends with nothing stored.
        model.query = "second"
        model.editShortcut(try #require(model.selectedItem))
        model.recordingChanged("fakeov.two", true)
        model.recordingChanged("fakeov.two", false)
        #expect(model.editingID == nil && reg.shortcut(for: "fakeov.two") == keyC)
        // Another row's recorder can't end this one's editing.
        model.editShortcut(try #require(model.selectedItem))
        model.recordingChanged("fakeov.one", false)
        #expect(model.editingID == "fakeov.two")
        model.recordingChanged("fakeov.two", false)
        reg.setModules([])
        ConfigStore.shared.shortcutOverrides = [:]
    }

    @Test func anAppFromTheSearchGetsItsEntryAndRecordsInPlace() throws {
        let hotkeys = FakeHotkeys()
        let model = setUp([hotkeys, AppActionsModule()])
        var recorded: [String] = []
        var opened: [String?] = []
        model.onRecord = { recorded.append($0) }
        model.onOpenSettings = { opened.append($0) }
        // The search finds Opera by something its entry's title won't match.
        model.query = "browser"
        let app = try #require(model.selectedItem)
        #expect(app.id == "app:com.example.opera")
        model.editShortcut(app)
        #expect(hotkeys.entries.keys.sorted() == ["fakehotkeys.opera"])
        #expect(model.editingID == "fakehotkeys.opera" && model.selectedID == "fakehotkeys.opera")
        #expect(model.items.map(\.id) == ["fakehotkeys.opera"])   // listed while recording
        #expect(recorded == ["fakehotkeys.opera"] && opened.isEmpty)
        model.recordingChanged("fakehotkeys.opera", true)
        model.recordingChanged("fakehotkeys.opera", false)
        reg.assign(keyB, to: "fakehotkeys.opera")
        #expect(hotkeys.entries["fakehotkeys.opera"] == .some(keyB))   // stored by the entry itself
        #expect(ConfigStore.shared.shortcutOverrides["fakehotkeys.opera"] == nil)
        model.reload()
        #expect(model.items.first?.shortcut == keyB)
        reg.setModules([])
    }
}
