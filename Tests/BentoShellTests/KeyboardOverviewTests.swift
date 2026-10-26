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
    #expect(sections[3].items[0].shortcut == Shortcut("ctrl+opt+slash"))
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
    #expect(ids(OverviewCatalog.filter(c, query: "⌃⌥/")) == [KeyboardOverview.actionID])
    // Config names and spelled-out modifiers.
    #expect(ids(OverviewCatalog.filter(c, query: "cmd+shift+1")) == ["shot.fullscreen"])
    #expect(ids(OverviewCatalog.filter(c, query: "command")) == ["shot.area", "shot.fullscreen"])
    #expect(ids(OverviewCatalog.filter(c, query: "control option")) == ["windows.left-half", "windows.right-half", "windows.center", KeyboardOverview.actionID])
    #expect(ids(OverviewCatalog.filter(c, query: "slash")) == [KeyboardOverview.actionID])
    // Unbound actions only match by name.
    #expect(ids(OverviewCatalog.filter(c, query: "⌘ fourth")).isEmpty)
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
    #expect(OverviewCatalog.recordPage(for: "launcher.ab12") == "record/launcher.ab12")
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

// MARK: - Settings links

@Test func settingsLinks() {
    #expect(OverviewCatalog.settingsPage(for: "windows") == "windows")
    #expect(OverviewCatalog.settingsPage(for: AppActionsModule.moduleID) == "shortcuts")
    let item = catalog()[1].items[0]
    #expect(OverviewCatalog.shortcutsPage(for: item) == "shortcuts/Left Half")

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

@Test func defaultShortcutIsPlainControlOptionSlash() {
    #expect(overview.modifiers == [.control, .option])
    #expect(overview.keyCode == UInt32(kVK_ANSI_Slash))
    #expect(overview.isSafeGlobalHotkey)
    #expect(overview.displayString == "⌃⌥/")
    // Registered by key position: never needs Shift, whatever the layout types there.
    #expect(!overview.modifiers.contains(.shift))
}

/// Every shortcut literal in Sources (module defaults, Rectangle/Spectacle
/// import tables, window-local keys): none may be ⌃⌥/. Literals with an
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
    #expect(collisions.isEmpty, "⌃⌥/ is also used by: \(collisions)")
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
