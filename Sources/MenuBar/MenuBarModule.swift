import AppKit
import SwiftUI
import BentoCore

/// Menu bar sections arranged with macOS native Command-drag. Bento controls
/// visibility and offers search/shortcuts using Accessibility press in place.
public final class MenuBarModule: BentoModule, ObservableObject {
    public let id = "menubar"
    public let title = "Menu Bar"
    public let symbol = "menubar.rectangle"
    /// Off until switched on: it adds items to the menu bar.
    public let enabledByDefault = false

    @Published private(set) var controller: MenuBarController?
    private(set) var search: ItemSearch?
    private var configToken: NSObjectProtocol?
    private var overlay: MenuBarOverlay?
    private var screenObserver: NSObjectProtocol?

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
        controller = c
        search = ItemSearch(controller: c)
        c.start()
        configToken = ConfigStore.shared.observe(id) { [weak self] in self?.configChanged() }
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            self?.overlay?.layout()
        }
        syncOverlay(s)
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
        let s = settings
        controller?.update(settings: s)
        syncOverlay(s)
        ActionRegistry.shared.reload() // per-item shortcuts
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
            list.append(BentoAction(actionID, "Open \(MenuBarModule.itemTitle(key))", group: "Items", shortcut: shortcut,
                                    hiddenFromMenu: true, bindingWriter: { [weak self] sc in self?.setItemHotkey(sc, for: key) }) { [weak self] in
                self?.withController { $0.activate(key: key) }
            })
        }
        return list
    }

    private func withController(_ body: (MenuBarController) -> Void) {
        if let controller { body(controller) }
    }

    static func itemActionID(_ key: String) -> String { "menubar.click-" + slug(key) }

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
        sub.addItem(.separator())
        sub.addItem(ClosureMenuItem(title: "Menu Bar Settings…") { SettingsRouter.open("menubar") })
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
        d["search"] = search?.diagnostics ?? ["open": false]
        d["overlay"] = overlay != nil
        return d
    }
}
