import Foundation
import Testing
@testable import MenuBar

private func decode(_ json: String) throws -> MenuBarSettings {
    try JSONDecoder().decode(MenuBarSettings.self, from: Data(json.utf8))
}

@Test func emptySectionDecodesToDefaults() throws {
    let s = try decode("{}")
    var d = MenuBarSettings()
    d.version = MenuBarSettings.currentVersion
    #expect(s == d)
    #expect(s.bar == .whenCrowded)
    #expect(s.alwaysHiddenSection)
}

@Test func roundTripsEveryField() throws {
    var s = MenuBarSettings()
    s.revealOnHover = true
    s.rehideDelay = 42
    s.bar = .always
    s.layout = SavedLayout(visible: ["a/Item-0"], hidden: ["b/Item-0"], alwaysHidden: ["c/Item-1"])
    s.itemHotkeys = ["b/Item-0": "ctrl+opt+cmd+1"]
    s.showOnChange = ["b/Item-0"]
    s.appearance.enabled = true
    s.profiles = [LayoutProfile(name: "Work", layout: SavedLayout(hidden: ["a/Item-0"]))]
    let data = try JSONEncoder().encode(s)
    #expect(try JSONDecoder().decode(MenuBarSettings.self, from: data) == s)
}

@Test func wrongTypesFallBackOneByOne() throws {
    let s = try decode(#"{"revealOnHover": "yes", "rehideDelay": 5, "bar": "sometimes", "layout": {"hidden": ["x/Item-0"], "visible": 3}}"#)
    #expect(s.revealOnHover == false)
    #expect(s.rehideDelay == 5)
    #expect(s.bar == .whenCrowded)
    #expect(s.layout.hidden == ["x/Item-0"])
    #expect(s.layout.visible.isEmpty)
}

@Test func versionZeroSectionsMapMigrates() throws {
    // A hand-written file from before `layout`: a flat key → section map.
    let s = try decode(#"{"sections": {"b/Item-0": "hidden", "a/Item-0": "alwaysHidden", "c/Item-0": "visible"}}"#)
    #expect(s.version == MenuBarSettings.currentVersion)
    #expect(s.layout.hidden == ["b/Item-0"])
    #expect(s.layout.alwaysHidden == ["a/Item-0"])
    #expect(s.layout.visible == ["c/Item-0"])
    // The old key isn't written back.
    let json = String(decoding: try JSONEncoder().encode(s), as: UTF8.self)
    #expect(!json.contains("\"sections\""))
}

@Test func currentVersionIgnoresStaleSectionsKey() throws {
    let s = try decode(#"{"version": 1, "sections": {"b/Item-0": "hidden"}, "layout": {"visible": ["b/Item-0"]}}"#)
    #expect(s.layout.visible == ["b/Item-0"])
    #expect(s.layout.hidden.isEmpty)
}

@Test func migrationDeduplicatesAndDropsBlanks() throws {
    let s = try decode(#"""
    {"layout": {"visible": ["a/Item-0", " ", "b/Item-0"], "hidden": ["b/Item-0", "c/Item-0", "c/Item-0"]},
     "itemHotkeys": {"a/Item-0": "", "": "ctrl+opt+1", "c/Item-0": "ctrl+opt+cmd+2"},
     "showOnChange": ["c/Item-0", "c/Item-0", ""],
     "profiles": [{"name": "Desk", "layout": {"hidden": ["x", "x"]}}, 7]}
    """#)
    #expect(s.layout.visible == ["a/Item-0", "b/Item-0"])
    #expect(s.layout.hidden == ["c/Item-0"])
    #expect(s.itemHotkeys == ["c/Item-0": "ctrl+opt+cmd+2"])
    #expect(s.showOnChange == ["c/Item-0"])
    #expect(s.profiles.count == 1)
    #expect(s.profiles[0].layout.hidden == ["x"])
    #expect(!s.profiles[0].id.isEmpty)
}

@Test func clampedValuesStayInRange() {
    var s = MenuBarSettings()
    s.rehideDelay = .infinity
    s.hoverDelay = -4
    s.showOnChangeDuration = 1e9
    #expect(s.clampedRehideDelay == 15)
    #expect(s.clampedHoverDelay == 0)
    #expect(s.clampedShowOnChangeDuration == 60)
}

// MARK: - Saved layout

@Test func layoutUpdateFollowsCurrentPositions() {
    let saved = SavedLayout(visible: ["a", "b"], hidden: ["c"], alwaysHidden: [])
    let now: [MenuBarSection: [String]] = [.visible: ["b"], .hidden: ["a", "c"], .alwaysHidden: []]
    let updated = saved.updated(with: now)
    #expect(updated.visible == ["b"])
    #expect(updated.hidden == ["a", "c"])
}

@Test func layoutUpdateKeepsAbsentItemsInPlace() {
    // "gone" isn't running: it stays after "a", and "first" stays at the front.
    let saved = SavedLayout(visible: [], hidden: ["first", "a", "gone", "gone2", "b"], alwaysHidden: [])
    let now: [MenuBarSection: [String]] = [.visible: [], .hidden: ["b", "a"], .alwaysHidden: []]
    #expect(saved.updated(with: now).hidden == ["first", "b", "a", "gone", "gone2"])
    // The item it followed moved to another section: it goes to the end.
    let moved: [MenuBarSection: [String]] = [.visible: ["a"], .hidden: ["b"], .alwaysHidden: []]
    #expect(saved.updated(with: moved).hidden == ["first", "b", "gone", "gone2"])
    #expect(saved.updated(with: moved).visible == ["a"])
}

@Test func layoutMergeAndSectionLookup() {
    let mine = SavedLayout(visible: ["a"], hidden: ["b"])
    let other = SavedLayout(visible: ["b", "z"], hidden: [], alwaysHidden: ["a", "y"])
    let merged = mine.merged(over: other)
    #expect(merged.visible == ["a", "z"])
    #expect(merged.hidden == ["b"])
    #expect(merged.alwaysHidden == ["y"])
    #expect(merged.section(of: "y") == .alwaysHidden)
    #expect(merged.section(of: "nope") == nil)
}

@Test func layoutFromSectionsMapIsSorted() {
    let l = SavedLayout(sections: ["z": .hidden, "a": .hidden, "m": .visible])
    #expect(l.hidden == ["a", "z"])
    #expect(l.visible == ["m"])
}

// MARK: - Appearance

@Test func hexColours() {
    let c = MenuBarAppearance.rgba("#FF000080")
    #expect(c?.r == 1 && c?.g == 0 && c?.b == 0)
    #expect(abs((c?.a ?? 0) - 128.0 / 255) < 0.001)
    #expect(MenuBarAppearance.rgba("00FF00")?.a == 1)
    #expect(MenuBarAppearance.rgba("#12345") == nil)
    #expect(MenuBarAppearance.rgba("#GGGGGG") == nil)
    #expect(MenuBarAppearance.hex(r: 1, g: 0, b: 0.5, a: 1) == "#FF0080FF")
    #expect(MenuBarAppearance.hex(r: .nan, g: 2, b: -1, a: 0) == "#00FF0000")
}

@Test func versionZeroMigratesThroughConfigStoreDefaults() throws {
    // ConfigStore merges the defaults (version 1, empty layout) over the
    // stored section before decoding: the old map must still migrate.
    let s = try decode(#"{"version": 1, "layout": {"visible": [], "hidden": [], "alwaysHidden": []}, "sections": {"b/Item-0": "hidden"}}"#)
    #expect(s.layout.hidden == ["b/Item-0"])
}

@Test func actionIDsAreKebabCase() {
    #expect(MenuBarModule.itemActionID("com.google.Chrome/Item-0") == "menubar.click-com-google-chrome-item-0")
    #expect(MenuBarModule.slug("  Désk / Work  ") == "d-sk-work")
    var p = LayoutProfile(name: "")
    p.id = "ABC-123"
    #expect(MenuBarModule.profileActionID(p) == "menubar.profile-abc-123")
}
