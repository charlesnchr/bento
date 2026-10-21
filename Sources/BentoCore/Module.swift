import AppKit
import SwiftUI

/// Something the user can trigger: from a global shortcut, the menu bar, or a
/// `bento://action/<id>` URL (e.g. from Karabiner or a script).
public struct BentoAction: Identifiable {
    /// Stable, namespaced id used as the config key: `"shot.area"`, `"windows.left-half"`.
    public let id: String
    public let title: String
    /// Group heading in the Shortcuts settings and the menu (defaults to module title).
    public let group: String?
    public let defaultShortcut: Shortcut?
    /// Hidden from the menu bar menu (still bindable and listed in settings).
    public let hiddenFromMenu: Bool
    public let handler: () -> Void
    /// When set, the action stores its own binding (e.g. launcher entries keep
    /// shortcuts in their config section): `defaultShortcut` is the current
    /// binding and edits are passed here instead of the global overrides map.
    public let bindingWriter: ((Shortcut?) -> Void)?

    public init(_ id: String, _ title: String, group: String? = nil, shortcut: String? = nil,
                hiddenFromMenu: Bool = false, bindingWriter: ((Shortcut?) -> Void)? = nil,
                handler: @escaping () -> Void) {
        self.id = id
        self.title = title
        self.group = group
        self.defaultShortcut = shortcut.flatMap(Shortcut.init)
        self.hiddenFromMenu = hiddenFromMenu
        self.bindingWriter = bindingWriter
        self.handler = handler
    }
}

/// One feature area of Bento. Modules are created once at launch; `start()` and
/// `stop()` follow the per-module enabled switch in General settings.
///
/// Modules must stay cheap while idle: no polling where an event exists, no
/// windows created until first use, event taps/observers only while needed.
public protocol BentoModule: AnyObject {
    /// Stable id, also the module's config section name: `"shot"`, `"clipboard"`, ...
    var id: String { get }
    var title: String { get }
    /// SF Symbol name for settings sidebar and menu.
    var symbol: String { get }
    /// Actions exposed to shortcuts/menu/URLs. Re-read whenever the registry
    /// reloads, so it may be computed from config (e.g. launcher entries).
    var actions: [BentoAction] { get }
    /// Whether the module is on when no preference exists yet.
    var enabledByDefault: Bool { get }

    func start()
    func stop()
    /// Settings pane shown in the settings window (nil = no pane).
    func makeSettingsView() -> AnyView?
    /// Items for the menu bar menu. Default: a submenu with all visible actions.
    func menuItems() -> [NSMenuItem]
}

public extension BentoModule {
    var enabledByDefault: Bool { true }
    func makeSettingsView() -> AnyView? { nil }
    func menuItems() -> [NSMenuItem] { ActionRegistry.shared.defaultMenuItems(for: self) }
}

/// Owns the mapping from actions to global hotkeys.
public final class ActionRegistry {
    public static let shared = ActionRegistry()

    public static let didReload = Notification.Name("BentoActionRegistryDidReload")

    public private(set) var modules: [BentoModule] = []
    private var actionsByID: [String: BentoAction] = [:]
    private var orderedIDs: [String] = []
    private var tokens: [HotkeyCenter.Token] = []
    /// Shortcuts that failed to register (taken by another app), by action id.
    public private(set) var failed: Set<String> = []
    private var configObserver: NSObjectProtocol?
    public var isModuleEnabled: (String) -> Bool = { _ in true }

    private init() {
        configObserver = ConfigStore.shared.observe("shortcuts") { [weak self] in self?.reload() }
    }

    public func setModules(_ modules: [BentoModule]) {
        self.modules = modules
        reload()
    }

    /// Re-collects actions from enabled modules and re-registers every hotkey.
    /// Modules call this when their dynamic action list changes.
    public func reload() {
        HotkeyCenter.shared.unregister(tokens)
        tokens = []
        actionsByID = [:]
        orderedIDs = []
        failed = []
        for m in modules where isModuleEnabled(m.id) {
            for a in m.actions {
                if actionsByID[a.id] == nil { orderedIDs.append(a.id) }
                actionsByID[a.id] = a
            }
        }
        var claimed: [Shortcut: String] = [:]
        for id in orderedIDs {
            guard let action = actionsByID[id], let sc = shortcut(for: id) else { continue }
            if let other = claimed[sc] {
                BentoLog.core.error("Shortcut \(sc.configString, privacy: .public) of \(id, privacy: .public) already used by \(other, privacy: .public)")
                failed.insert(id)
                continue
            }
            if let t = HotkeyCenter.shared.register(sc, onPress: action.handler) {
                tokens.append(t)
                claimed[sc] = id
            } else {
                failed.insert(id)
            }
        }
        NotificationCenter.default.post(name: ActionRegistry.didReload, object: self)
    }

    // MARK: Queries

    public var allActions: [BentoAction] { orderedIDs.compactMap { actionsByID[$0] } }

    public func action(_ id: String) -> BentoAction? { actionsByID[id] }

    /// Runs an action by id. Returns false if unknown or its module is disabled.
    @discardableResult
    public func perform(_ id: String) -> Bool {
        guard let a = actionsByID[id] else { return false }
        a.handler()
        return true
    }

    /// The effective shortcut: user override, else the action's default.
    public func shortcut(for id: String) -> Shortcut? {
        if let a = actionsByID[id], a.bindingWriter != nil { return a.defaultShortcut }
        if let override = ConfigStore.shared.shortcutOverrides[id] {
            return override.isEmpty || override == "none" ? nil : Shortcut(override)
        }
        return actionsByID[id]?.defaultShortcut ?? modules.lazy.flatMap(\.actions).first { $0.id == id }?.defaultShortcut
    }

    /// Stores a user override (nil = unbound). Passing the default clears the override.
    public func setShortcut(_ shortcut: Shortcut?, for id: String) {
        if let writer = actionsByID[id]?.bindingWriter {
            writer(shortcut)
            return
        }
        var overrides = ConfigStore.shared.shortcutOverrides
        let def = actionsByID[id]?.defaultShortcut
        if shortcut == def {
            overrides.removeValue(forKey: id)
        } else {
            overrides[id] = shortcut?.configString ?? ""
        }
        ConfigStore.shared.shortcutOverrides = overrides // triggers reload via observer
    }

    /// Which action (if any) already uses a shortcut.
    public func actionUsing(_ shortcut: Shortcut) -> BentoAction? {
        allActions.first { self.shortcut(for: $0.id) == shortcut }
    }

    // MARK: Menu helpers

    public func menuItem(for action: BentoAction) -> NSMenuItem {
        let item = ClosureMenuItem(title: action.title, handler: action.handler)
        if let sc = shortcut(for: action.id), let (key, mods) = sc.menuKeyEquivalent {
            item.keyEquivalent = key.lowercased() == key ? key : key.lowercased()
            item.keyEquivalentModifierMask = mods
        }
        return item
    }

    public func defaultMenuItems(for module: BentoModule) -> [NSMenuItem] {
        let visible = module.actions.filter { !$0.hiddenFromMenu }
        guard !visible.isEmpty else { return [] }
        let parent = NSMenuItem(title: module.title, action: nil, keyEquivalent: "")
        parent.image = NSImage(systemSymbolName: module.symbol, accessibilityDescription: nil)
        let sub = NSMenu()
        var lastGroup: String?
        for a in visible {
            if let g = a.group, g != lastGroup, lastGroup != nil { sub.addItem(.separator()) }
            lastGroup = a.group ?? lastGroup
            sub.addItem(menuItem(for: a))
        }
        parent.submenu = sub
        return [parent]
    }
}

/// NSMenuItem that runs a closure.
public final class ClosureMenuItem: NSMenuItem {
    private let handler: () -> Void

    public init(title: String, keyEquivalent: String = "", handler: @escaping () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(run), keyEquivalent: keyEquivalent)
        target = self
    }

    required init(coder: NSCoder) { fatalError() }

    @objc private func run() { handler() }
}
