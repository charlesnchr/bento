import Foundation

/// The `menubar` section of the config file. Every field has a default, so a
/// hand-edited file can stay minimal; a value of the wrong type falls back to
/// its default on its own.
///
/// Items are named by key, `<bundle id>/<item name>`: `com.google.Chrome/Item-0`,
/// `com.apple.controlcenter/WiFi`. The item name is the status item's autosave
/// name, which is stable across launches.
struct MenuBarSettings: Codable, Equatable {
    static let currentVersion = 1
    var version = MenuBarSettings.currentVersion

    // MARK: Sections
    /// A second separator; items left of it only show on request (⌥-click the chevron).
    var alwaysHiddenSection = true
    /// The chevron that shows and hides the hidden section. Without it, use the
    /// shortcut, Bento's menu or one of the reveal options below.
    var showChevron = true
    /// Where each item belongs, left to right per section. Kept up to date when
    /// items are arranged in Settings; used to put an item back where it belongs
    /// when its app relaunches (`keepItemsInPlace`).
    var layout = SavedLayout()
    /// Move items back to their section when their app relaunches and macOS
    /// puts them somewhere else (new items stay where macOS puts them).
    var keepItemsInPlace = true

    // MARK: Reveal
    /// Show hidden items while the pointer rests on an empty part of the menu bar.
    var revealOnHover = false
    var hoverDelay = 0.3
    /// Click an empty part of the menu bar to show or hide the hidden items.
    var revealOnEmptyClick = false
    /// Scroll or swipe down (or left) on the menu bar to show them, up to hide.
    var revealOnScroll = false

    // MARK: Hide again
    var autoRehide = true
    /// Seconds after which revealed items hide again (counted from the last
    /// time the pointer left the menu bar).
    var rehideDelay = 15.0
    /// Hide as soon as you click somewhere else, or the menu of a revealed item closes.
    var rehideOnClickOutside = true

    // MARK: Bento Bar
    /// Show hidden items in a bar below the menu bar instead of in the menu bar.
    var bar: BarMode = .whenCrowded

    // MARK: Per item
    /// Item key → shortcut that clicks the item (opens its menu).
    var itemHotkeys: [String: String] = [:]
    /// Hidden items that show for a few seconds when their icon changes.
    var showOnChange: [String] = []
    var showOnChangeDuration = 6.0

    // MARK: Look
    var appearance = MenuBarAppearance()

    // MARK: Profiles
    /// Named layouts; a profile can switch automatically per display or Focus.
    var profiles: [LayoutProfile] = []

    init() {}

    enum CodingKeys: String, CodingKey {
        case version, alwaysHiddenSection, showChevron, layout, keepItemsInPlace
        case revealOnHover, hoverDelay, revealOnEmptyClick, revealOnScroll
        case autoRehide, rehideDelay, rehideOnClickOutside, bar
        case itemHotkeys, showOnChange, showOnChangeDuration, appearance, profiles
        // Older spelling, read only.
        case sections
    }

    init(from decoder: Decoder) throws {
        let d = MenuBarSettings()
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func v<T: Decodable>(_ key: CodingKeys, _ fallback: T) -> T { (try? c.decode(T.self, forKey: key)) ?? fallback }
        version = v(.version, 0)
        alwaysHiddenSection = v(.alwaysHiddenSection, d.alwaysHiddenSection)
        showChevron = v(.showChevron, d.showChevron)
        layout = v(.layout, d.layout)
        keepItemsInPlace = v(.keepItemsInPlace, d.keepItemsInPlace)
        revealOnHover = v(.revealOnHover, d.revealOnHover)
        hoverDelay = v(.hoverDelay, d.hoverDelay)
        revealOnEmptyClick = v(.revealOnEmptyClick, d.revealOnEmptyClick)
        revealOnScroll = v(.revealOnScroll, d.revealOnScroll)
        autoRehide = v(.autoRehide, d.autoRehide)
        rehideDelay = v(.rehideDelay, d.rehideDelay)
        rehideOnClickOutside = v(.rehideOnClickOutside, d.rehideOnClickOutside)
        bar = v(.bar, d.bar)
        itemHotkeys = v(.itemHotkeys, d.itemHotkeys)
        showOnChange = v(.showOnChange, d.showOnChange)
        showOnChangeDuration = v(.showOnChangeDuration, d.showOnChangeDuration)
        appearance = v(.appearance, d.appearance)
        profiles = (try? c.decode([Lenient<LayoutProfile>].self, forKey: .profiles))?.compactMap(\.value) ?? d.profiles
        // Version 0 (hand-written files): a flat key → section map. The
        // config store fills in defaults (version, an empty layout) before
        // decoding, so an empty layout counts as not migrated yet too.
        if c.contains(.sections), version < 1 || layout.isEmpty,
           let flat = try? c.decode([String: MenuBarSection].self, forKey: .sections) {
            layout = SavedLayout(sections: flat).merged(over: layout)
        }
        self = migrated()
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(version, forKey: .version)
        try c.encode(alwaysHiddenSection, forKey: .alwaysHiddenSection)
        try c.encode(showChevron, forKey: .showChevron)
        try c.encode(layout, forKey: .layout)
        try c.encode(keepItemsInPlace, forKey: .keepItemsInPlace)
        try c.encode(revealOnHover, forKey: .revealOnHover)
        try c.encode(hoverDelay, forKey: .hoverDelay)
        try c.encode(revealOnEmptyClick, forKey: .revealOnEmptyClick)
        try c.encode(revealOnScroll, forKey: .revealOnScroll)
        try c.encode(autoRehide, forKey: .autoRehide)
        try c.encode(rehideDelay, forKey: .rehideDelay)
        try c.encode(rehideOnClickOutside, forKey: .rehideOnClickOutside)
        try c.encode(bar, forKey: .bar)
        try c.encode(itemHotkeys, forKey: .itemHotkeys)
        try c.encode(showOnChange, forKey: .showOnChange)
        try c.encode(showOnChangeDuration, forKey: .showOnChangeDuration)
        try c.encode(appearance, forKey: .appearance)
        try c.encode(profiles, forKey: .profiles)
    }

    /// Brings an older or hand-edited section up to the current version:
    /// an item listed in two sections keeps the first, blank keys and
    /// hotkeys go, and the version is stamped.
    func migrated() -> MenuBarSettings {
        var s = self
        s.layout = s.layout.normalized()
        s.itemHotkeys = s.itemHotkeys.filter { !$0.key.trimmingCharacters(in: .whitespaces).isEmpty && !$0.value.isEmpty }
        var seen = Set<String>()
        s.showOnChange = s.showOnChange.filter { !$0.isEmpty && seen.insert($0).inserted }
        s.profiles = s.profiles.map { var p = $0; p.layout = p.layout.normalized(); return p }
        s.version = MenuBarSettings.currentVersion
        return s
    }

    // MARK: Clamped values (the file is hand-editable)

    var clampedHoverDelay: TimeInterval { MenuBarSettings.finite(hoverDelay, in: 0...3, else: 0.3) }
    var clampedRehideDelay: TimeInterval { MenuBarSettings.finite(rehideDelay, in: 1...600, else: 15) }
    var clampedShowOnChangeDuration: TimeInterval { MenuBarSettings.finite(showOnChangeDuration, in: 1...60, else: 6) }

    static func finite(_ v: Double, in range: ClosedRange<Double>, else fallback: Double) -> Double {
        v.isFinite ? min(max(v, range.lowerBound), range.upperBound) : fallback
    }
}

enum BarMode: String, Codable, CaseIterable, Identifiable {
    /// Hidden items always show in the menu bar.
    case never
    /// In the Bento Bar when they wouldn't fit (notch, long app menus), else in the menu bar.
    case whenCrowded
    /// Always in the Bento Bar.
    case always

    var id: String { rawValue }

    var title: String {
        switch self {
        case .never: "In the menu bar"
        case .whenCrowded: "In the Bento Bar when they don’t fit"
        case .always: "In the Bento Bar"
        }
    }
}

/// Where items go, as item keys left to right in each section.
struct SavedLayout: Codable, Equatable {
    var visible: [String] = []
    var hidden: [String] = []
    var alwaysHidden: [String] = []

    init(visible: [String] = [], hidden: [String] = [], alwaysHidden: [String] = []) {
        self.visible = visible
        self.hidden = hidden
        self.alwaysHidden = alwaysHidden
    }

    /// From an unordered key → section map (sorted by key, for a stable result).
    init(sections: [String: MenuBarSection]) {
        for (key, section) in sections.sorted(by: { $0.key < $1.key }) {
            self[section].append(key)
        }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        visible = (try? c.decode([String].self, forKey: .visible)) ?? []
        hidden = (try? c.decode([String].self, forKey: .hidden)) ?? []
        alwaysHidden = (try? c.decode([String].self, forKey: .alwaysHidden)) ?? []
    }

    subscript(section: MenuBarSection) -> [String] {
        get {
            switch section {
            case .visible: visible
            case .hidden: hidden
            case .alwaysHidden: alwaysHidden
            }
        }
        set {
            switch section {
            case .visible: visible = newValue
            case .hidden: hidden = newValue
            case .alwaysHidden: alwaysHidden = newValue
            }
        }
    }

    var isEmpty: Bool { visible.isEmpty && hidden.isEmpty && alwaysHidden.isEmpty }

    func section(of key: String) -> MenuBarSection? {
        MenuBarSection.allCases.first { self[$0].contains(key) }
    }

    /// No blank keys, each key in one section only (the first one listed,
    /// checking Visible, Hidden, Always Hidden in that order).
    func normalized() -> SavedLayout {
        var seen = Set<String>()
        var out = SavedLayout()
        for s in MenuBarSection.allCases {
            out[s] = self[s].filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty && seen.insert($0).inserted }
        }
        return out
    }

    /// This layout's keys win; keys only in `other` are kept in their section.
    func merged(over other: SavedLayout) -> SavedLayout {
        var out = self
        let mine = Set(MenuBarSection.allCases.flatMap { self[$0] })
        for s in MenuBarSection.allCases { out[s] += other[s].filter { !mine.contains($0) } }
        return out.normalized()
    }

    /// Records where the items currently are: their keys move to the section
    /// they are in now, in the order they are in now. Items not in the menu bar
    /// (their app isn't running) keep their place, after the item they followed.
    func updated(with current: [MenuBarSection: [String]]) -> SavedLayout {
        let present = Set(current.values.flatMap { $0 })
        var out = SavedLayout()
        for s in MenuBarSection.allCases {
            var result = current[s] ?? []
            var after: String?
            var lastInserted: [String?: String] = [:]
            for key in self[s] {
                if present.contains(key) { after = key; continue }
                let base = lastInserted[after] ?? after
                let index: Int
                if let base { index = result.firstIndex(of: base).map { $0 + 1 } ?? result.count } else { index = 0 }
                result.insert(key, at: index)
                lastInserted[after] = key
            }
            out[s] = result
        }
        return out.normalized()
    }
}

/// A named layout. `displays` / `focusModes` switch to it automatically.
struct LayoutProfile: Codable, Equatable, Identifiable {
    var id = UUID().uuidString
    var name = "Profile"
    var layout = SavedLayout()
    /// Display names (NSScreen.localizedName) that activate this profile when
    /// they are the main display.
    var displays: [String] = []
    /// Focus mode names that activate this profile while on.
    var focusModes: [String] = []

    init(name: String = "Profile", layout: SavedLayout = SavedLayout()) {
        self.name = name
        self.layout = layout
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        name = (try? c.decode(String.self, forKey: .name)) ?? "Profile"
        layout = (try? c.decode(SavedLayout.self, forKey: .layout)) ?? SavedLayout()
        displays = (try? c.decode([String].self, forKey: .displays)) ?? []
        focusModes = (try? c.decode([String].self, forKey: .focusModes)) ?? []
    }
}

/// Optional decoration drawn behind the status items.
struct MenuBarAppearance: Codable, Equatable {
    var enabled = false
    /// Tint colour as hex (`#RRGGBB` or `#RRGGBBAA`).
    var tint = "#0A84FF33"
    var border = false
    var borderColor = "#FFFFFF40"
    var borderWidth = 1.0
    var shadow = false

    init() {}

    init(from decoder: Decoder) throws {
        let d = MenuBarAppearance()
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = (try? c.decode(Bool.self, forKey: .enabled)) ?? d.enabled
        tint = (try? c.decode(String.self, forKey: .tint)) ?? d.tint
        border = (try? c.decode(Bool.self, forKey: .border)) ?? d.border
        borderColor = (try? c.decode(String.self, forKey: .borderColor)) ?? d.borderColor
        borderWidth = (try? c.decode(Double.self, forKey: .borderWidth)) ?? d.borderWidth
        shadow = (try? c.decode(Bool.self, forKey: .shadow)) ?? d.shadow
    }

    /// RGBA components (0…1) of a `#RRGGBB[AA]` string, nil if malformed.
    static func rgba(_ hex: String) -> (r: Double, g: Double, b: Double, a: Double)? {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6 || s.count == 8, let v = UInt64(s, radix: 16) else { return nil }
        let full = s.count == 6 ? (v << 8) | 0xFF : v
        return (Double((full >> 24) & 0xFF) / 255, Double((full >> 16) & 0xFF) / 255,
                Double((full >> 8) & 0xFF) / 255, Double(full & 0xFF) / 255)
    }

    static func hex(r: Double, g: Double, b: Double, a: Double) -> String {
        func c(_ x: Double) -> Int { Int((min(max(x.isFinite ? x : 0, 0), 1) * 255).rounded()) }
        return String(format: "#%02X%02X%02X%02X", c(r), c(g), c(b), c(a))
    }
}

/// Decodes a value, or nil if it is malformed.
struct Lenient<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}
