import AppKit
import SwiftUI
import BentoCore

/// Bartender-style menu bar management: Visible, Hidden and Always Hidden
/// sections made by separator items, revealed by the chevron, a shortcut or
/// the mouse, hidden again automatically. Items are arranged in Settings
/// (Bento ⌘-drags the real items), clicked from the Bento Bar or quick search,
/// or bound to their own shortcuts. On notched displays, items that don't fit
/// are offered in the Bento Bar.
///
/// While the items are hidden nothing runs except optional event monitors
/// for the reveal options that are switched on.
public final class MenuBarModule: BentoModule {
    public let id = "menubar"
    public let title = "Menu Bar"
    public let symbol = "menubar.rectangle"
    /// Off until switched on: it adds items to the menu bar.
    public let enabledByDefault = false

    private(set) var controller: MenuBarController?
    private(set) var search: ItemSearch?
    private var configToken: NSObjectProtocol?
    private var overlay: MenuBarOverlay?
    private var screenObserver: NSObjectProtocol?
    private var appliedProfileDisplay: String?
    private var writingSettings = false

    public init() {}

    var settings: MenuBarSettings { ConfigStore.shared.section(id, default: MenuBarSettings()) }

    // MARK: Lifecycle

    public func start() {
        guard controller == nil else { return }
        ConfigStore.shared.materialize(id, default: MenuBarSettings())
        let s = settings
        // Write a migrated section back once (drops the old `sections` key).
        if let raw = ConfigStore.shared.rawSection(id) as? [String: Any],
           raw["sections"] != nil || (raw["version"] as? Int) != MenuBarSettings.currentVersion {
            ConfigStore.shared.setSection(id, s)
        }
        let c = MenuBarController(settings: s)
        c.onSettingsChange = { [weak self] new in self?.write(new) }
        controller = c
        search = ItemSearch(controller: c)
        c.start()
        configToken = ConfigStore.shared.observe(id) { [weak self] in self?.configChanged() }
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            self?.overlay?.layout()
            self?.applyDisplayProfile()
        }
        syncOverlay(s)
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.applyDisplayProfile() }
    }

    public func stop() {
        if let configToken { NotificationCenter.default.removeObserver(configToken) }
        configToken = nil
        if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
        screenObserver = nil
        search?.close()
        search = nil
        controller?.stop()
        controller = nil
        overlay?.close()
        overlay = nil
    }

    private func configChanged() {
        guard !writingSettings else { return }
        let s = settings
        controller?.update(settings: s)
        syncOverlay(s)
        ActionRegistry.shared.reload() // per-item and profile actions
    }

    private func write(_ s: MenuBarSettings) {
        writingSettings = true
        ConfigStore.shared.setSection(id, s)
        writingSettings = false
    }

    private func syncOverlay(_ s: MenuBarSettings) {
        if s.appearance.enabled {
            if overlay == nil { overlay = MenuBarOverlay() }
            overlay?.update(s.appearance)
        } else {
            overlay?.close()
            overlay = nil
        }
    }

    // MARK: Profiles

    /// Applies a profile tied to the main display when displays change.
    private func applyDisplayProfile() {
        guard let controller, let name = NSScreen.screens.first?.localizedName else { return }
        guard let profile = settings.profiles.first(where: { $0.displays.contains(name) }) else {
            appliedProfileDisplay = nil
            return
        }
        guard appliedProfileDisplay != name else { return }
        appliedProfileDisplay = name
        controller.apply(profile.layout) { _ in }
    }

    func applyProfile(_ profile: LayoutProfile) {
        guard let controller else { return }
        HUD.show("Menu Bar: \(profile.name)", symbol: symbol)
        controller.apply(profile.layout) { result in
            if case .failure(let f) = result { HUD.show(f.description, symbol: "exclamationmark.triangle") }
        }
    }

    // MARK: Actions

    public var actions: [BentoAction] {
        let s = settings
        var list: [BentoAction] = [
            BentoAction("menubar.toggle-hidden", "Show Hidden Items", shortcut: "ctrl+opt+cmd+m") { [weak self] in
                self?.withController { $0.toggle(all: false) }
            },
            BentoAction("menubar.show-all", "Show All Items") { [weak self] in
                self?.withController { $0.toggle(all: true) }
            },
            BentoAction("menubar.bar", "Bento Bar") { [weak self] in
                self?.withController { c in c.bar.isOpen ? c.bar.close() : c.bar.show(all: false) }
            },
            BentoAction("menubar.search", "Search Menu Bar Items", shortcut: "ctrl+opt+cmd+s") { [weak self] in
                self?.withController { _ in self?.search?.toggle() }
            },
        ]
        for (key, shortcut) in s.itemHotkeys.sorted(by: { $0.key < $1.key }) {
            let actionID = MenuBarModule.itemActionID(key)
            list.append(BentoAction(actionID, "Click \(MenuBarModule.itemTitle(key))", group: "Items", shortcut: shortcut,
                                    hiddenFromMenu: true, bindingWriter: { [weak self] sc in self?.setItemHotkey(sc, for: key) }) { [weak self] in
                self?.withController { $0.activate(key: key) }
            })
        }
        for profile in s.profiles {
            list.append(BentoAction(MenuBarModule.profileActionID(profile), "Profile: \(profile.name)", group: "Profiles",
                                    hiddenFromMenu: true) { [weak self] in
                guard let p = self?.settings.profiles.first(where: { $0.id == profile.id }) else { return }
                self?.applyProfile(p)
            })
        }
        return list
    }

    private func withController(_ body: (MenuBarController) -> Void) {
        if let controller { body(controller) }
    }

    static func itemActionID(_ key: String) -> String { "menubar.click-" + slug(key) }

    static func profileActionID(_ profile: LayoutProfile) -> String {
        "menubar.profile-" + slug(profile.name.isEmpty ? profile.id : profile.name)
    }

    /// Lowercase letters, digits and dashes.
    static func slug(_ s: String) -> String {
        var out = ""
        for ch in s.lowercased() {
            if ch.isASCII && (ch.isLetter || ch.isNumber) { out.append(ch) } else if !out.hasSuffix("-") { out.append("-") }
        }
        return out.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }

    /// "com.google.Chrome/Item-0" → "Google Chrome" (or the bundle id when not installed).
    static func itemTitle(_ key: String) -> String {
        let parts = key.split(separator: "/", maxSplits: 1).map(String.init)
        guard let ns = parts.first else { return key }
        let name = parts.count > 1 ? parts[1] : ""
        if let system = MenuBarItem.systemNames[name] { return system }
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: ns) {
            let app = FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "")
            return name.hasPrefix("Item-") && name != "Item-0" ? "\(app) (\(name))" : app
        }
        return ns
    }

    func setItemHotkey(_ shortcut: Shortcut?, for key: String) {
        var s = settings
        if let shortcut { s.itemHotkeys[key] = shortcut.configString } else { s.itemHotkeys.removeValue(forKey: key) }
        ConfigStore.shared.setSection(id, s)
    }

    // MARK: Menu

    public func menuItems() -> [NSMenuItem] {
        let reg = ActionRegistry.shared
        let parent = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        parent.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        let sub = NSMenu()
        for id in ["menubar.toggle-hidden", "menubar.show-all", "menubar.bar", "menubar.search"] {
            guard let a = reg.action(id) else { continue }
            let item = reg.menuItem(for: a)
            if id == "menubar.toggle-hidden", let c = controller, c.visibility != .hidden { item.title = "Hide Items" }
            sub.addItem(item)
        }
        let profiles = settings.profiles
        if !profiles.isEmpty {
            sub.addItem(.separator())
            for p in profiles {
                sub.addItem(ClosureMenuItem(title: p.name) { [weak self] in self?.applyProfile(p) })
            }
        }
        sub.addItem(.separator())
        sub.addItem(ClosureMenuItem(title: "Arrange Items…") { SettingsRouter.open("menubar") })
        parent.submenu = sub
        return [parent]
    }

    // MARK: Settings

    public func makeSettingsView() -> AnyView? {
        AnyView(MenuBarSettingsView(module: self))
    }

    public func diagnostics() -> [String: Any] {
        var d = controller?.diagnostics() ?? ["started": false]
        d["searchOpen"] = search?.isOpen ?? false
        d["overlay"] = overlay != nil
        return d
    }
}
