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
    /// Return fresh items on every call (an item can only be in one menu).
    func menuItems() -> [NSMenuItem]
    /// Runtime state for `bento://debug/state` (event taps, observers, …).
    /// Values must be JSON types: strings, numbers, bools, arrays, dictionaries.
    func diagnostics() -> [String: Any]
}

public extension BentoModule {
    var enabledByDefault: Bool { true }
    func makeSettingsView() -> AnyView? { nil }
    func menuItems() -> [NSMenuItem] { ActionRegistry.shared.defaultMenuItems(for: self) }
    func diagnostics() -> [String: Any] { [:] }
}

/// Owns the mapping from actions to global hotkeys.
/// All calls must happen on the main thread.
public final class ActionRegistry {
    public static let shared = ActionRegistry()

    public static let didReload = Notification.Name("BentoActionRegistryDidReload")

    public private(set) var modules: [BentoModule] = []
    private var actionsByID: [String: BentoAction] = [:]
    private var orderedIDs: [String] = []
    /// Live hotkey registrations by action id.
    private var registered: [String: (shortcut: Shortcut, token: HotkeyCenter.Token)] = [:]
    /// Shortcuts that failed to register (taken by another app or another action), by action id.
    public private(set) var failed: Set<String> = []
    /// Failed ids that lost a conflict inside Bento -> the id that owns the shortcut.
    private var conflicts: [String: String] = [:]
    /// Failed ids whose shortcut has no ⌘/⌥/⌃ (would block typing), not registered.
    private var unsafe: Set<String> = []
    /// Failed ids whose shortcut macOS itself uses (Spotlight, Mission Control…).
    private var systemReserved: Set<String> = []
    /// Ids declared more than once (the first declaration wins).
    public private(set) var duplicateIDs: Set<String> = []
    private var batchDepth = 0
    private var reloadDeferred = false
    /// Number of reloads performed (diagnostics / tests).
    public private(set) var reloadCount = 0
    /// Actions of disabled modules (for settings rows), rebuilt lazily.
    private var inactiveActions: [String: BentoAction]?
    private var observers: [NSObjectProtocol] = []
    public var isModuleEnabled: (String) -> Bool = { _ in true } { didSet { inactiveActions = nil } }

    private init() {
        observers.append(ConfigStore.shared.observe("shortcuts") { [weak self] in self?.reload() })
        // Disabled modules may compute actions from config (launcher entries).
        observers.append(NotificationCenter.default.addObserver(forName: ConfigStore.didChange, object: nil, queue: .main) { [weak self] _ in
            self?.inactiveActions = nil
        })
        observers.append(NotificationCenter.default.addObserver(forName: HotkeyCenter.didResume, object: nil, queue: .main) { [weak self] _ in
            self?.dropDeadRegistrations()
        })
    }

    public func setModules(_ modules: [BentoModule]) {
        self.modules = modules
        reload()
    }

    /// Runs `body` with reloads coalesced into one at the end. Use it when
    /// changing many shortcuts at once (e.g. importing another app's settings):
    ///
    ///     ActionRegistry.shared.performBatch { for (id, sc) in map { reg.setShortcut(sc, for: id) } }
    public func performBatch(_ body: () -> Void) {
        batchDepth += 1
        defer {
            batchDepth -= 1
            if batchDepth == 0, reloadDeferred {
                reloadDeferred = false
                reload()
            }
        }
        body()
    }

    /// Sets several bindings with a single reload (nil = unbound).
    public func setShortcuts(_ shortcuts: [String: Shortcut?]) {
        performBatch {
            for id in shortcuts.keys.sorted() { setShortcut(shortcuts[id] ?? nil, for: id) }
        }
    }

    /// Re-collects actions from enabled modules and re-registers hotkeys.
    /// Modules call this when their dynamic action list changes. Bindings that
    /// didn't change keep their system registration (only handlers are swapped).
    public func reload() {
        if batchDepth > 0 { reloadDeferred = true; return }
        reloadCount += 1
        inactiveActions = nil
        var byID: [String: BentoAction] = [:]
        var order: [String] = []
        var duplicates = Set<String>()
        for m in modules where isModuleEnabled(m.id) {
            for a in m.actions {
                if byID[a.id] != nil { duplicates.insert(a.id); continue }
                order.append(a.id)
                byID[a.id] = a
            }
        }
        if !duplicates.isEmpty, duplicates != duplicateIDs {
            BentoLog.core.error("Duplicate action ids (first one wins): \(duplicates.sorted().joined(separator: ", "), privacy: .public)")
        }
        actionsByID = byID
        orderedIDs = order
        duplicateIDs = duplicates

        // Who gets which shortcut: the first action in order claims it.
        var wanted: [String: Shortcut] = [:]
        var claimed: [Shortcut: String] = [:]
        var newFailed = Set<String>()
        var newConflicts: [String: String] = [:]
        var newUnsafe = Set<String>()
        var newSystem = Set<String>()
        for id in order {
            guard let sc = shortcut(for: id) else { continue }
            guard sc.isSafeGlobalHotkey else {
                BentoLog.core.error("Not registering \(sc.configString, privacy: .public) for \(id, privacy: .public): it would block typing")
                newFailed.insert(id)
                newUnsafe.insert(id)
                continue
            }
            if SystemShortcuts.isReserved(sc) {
                // macOS handles its own shortcuts first, so this one will most
                // likely never fire: report it (still registered, in case the
                // user turns the macOS one off later).
                newFailed.insert(id)
                newSystem.insert(id)
            }
            if let other = claimed[sc] {
                BentoLog.core.error("Shortcut \(sc.configString, privacy: .public) of \(id, privacy: .public) already used by \(other, privacy: .public)")
                newFailed.insert(id)
                newConflicts[id] = other
                continue
            }
            claimed[sc] = id
            wanted[id] = sc
        }

        // Release everything that changed first, so a shortcut moving between
        // two actions is free when its new owner registers it.
        for (id, reg) in registered where wanted[id] != reg.shortcut || !HotkeyCenter.shared.isActive(reg.token) {
            HotkeyCenter.shared.unregister(reg.token)
            registered.removeValue(forKey: id)
        }
        for id in order {
            guard let sc = wanted[id], let action = byID[id] else { continue }
            if let reg = registered[id] {
                HotkeyCenter.shared.setHandlers(reg.token, onPress: action.handler)
            } else if let t = HotkeyCenter.shared.register(sc, onPress: action.handler) {
                registered[id] = (sc, t)
            } else {
                newFailed.insert(id)
            }
        }
        failed = newFailed
        conflicts = newConflicts
        unsafe = newUnsafe
        systemReserved = newSystem
        NotificationCenter.default.post(name: ActionRegistry.didReload, object: self)
    }

    /// After a suspension ends, keys another app grabbed meanwhile can't be
    /// restored: report them as failed (the next reload retries them).
    private func dropDeadRegistrations() {
        let dead = registered.filter { !HotkeyCenter.shared.isActive($0.value.token) }
        guard !dead.isEmpty else { return }
        for (id, reg) in dead {
            HotkeyCenter.shared.unregister(reg.token)
            registered.removeValue(forKey: id)
            failed.insert(id)
        }
        NotificationCenter.default.post(name: ActionRegistry.didReload, object: self)
    }

    // MARK: Queries

    public var allActions: [BentoAction] { orderedIDs.compactMap { actionsByID[$0] } }

    public func action(_ id: String) -> BentoAction? { actionsByID[id] }

    /// An action of any module, enabled or not.
    private func anyAction(_ id: String) -> BentoAction? {
        if let a = actionsByID[id] { return a }
        if inactiveActions == nil {
            var all: [String: BentoAction] = [:]
            for m in modules where !isModuleEnabled(m.id) {
                for a in m.actions where all[a.id] == nil { all[a.id] = a }
            }
            inactiveActions = all
        }
        return inactiveActions?[id]
    }

    /// Runs an action by id. Returns false if unknown or its module is disabled.
    @discardableResult
    public func perform(_ id: String) -> Bool {
        guard let a = actionsByID[id] else { return false }
        a.handler()
        return true
    }

    /// The effective shortcut: user override, else the action's default.
    public func shortcut(for id: String) -> Shortcut? {
        let action = anyAction(id)
        if let action, action.bindingWriter != nil { return action.defaultShortcut }
        if let override = ConfigStore.shared.shortcutOverrides[id] {
            return override.isEmpty || override == "none" ? nil : Shortcut(override)
        }
        return action?.defaultShortcut
    }

    /// Why an action's shortcut isn't active (nil when it is, or is unbound).
    public func failureReason(for id: String) -> String? {
        guard failed.contains(id) else { return nil }
        if let other = conflicts[id] { return "Also assigned to “\(actionsByID[other]?.title ?? other)”" }
        if unsafe.contains(id) { return "Needs ⌘, ⌥ or ⌃ (it would block typing)" }
        if systemReserved.contains(id) { return "Used by macOS (System Settings → Keyboard → Keyboard Shortcuts)" }
        return "Couldn’t be registered"
    }

    /// Stores a user override (nil = unbound). Passing the default clears the
    /// override. Works for actions of disabled modules too.
    public func setShortcut(_ shortcut: Shortcut?, for id: String) {
        let action = anyAction(id)
        if let writer = action?.bindingWriter {
            writer(shortcut)
            return
        }
        var overrides = ConfigStore.shared.shortcutOverrides
        if shortcut == action?.defaultShortcut {
            overrides.removeValue(forKey: id)
        } else {
            overrides[id] = shortcut?.configString ?? ""
        }
        ConfigStore.shared.shortcutOverrides = overrides // triggers reload via observer
    }

    /// Binds `shortcut` to `id`, first unbinding any other action that uses it
    /// (with a HUD saying so), so a recorded combination never ends up dead.
    public func assign(_ shortcut: Shortcut?, to id: String) {
        performBatch {
            if let shortcut, let other = actionUsing(shortcut), other.id != id {
                setShortcut(nil, for: other.id)
                HUD.show("Removed from “\(other.title)”", symbol: "arrow.triangle.swap", duration: 1.6)
            }
            setShortcut(shortcut, for: id)
        }
    }

    /// Which action (if any) already uses a shortcut.
    public func actionUsing(_ shortcut: Shortcut) -> BentoAction? {
        allActions.first { self.shortcut(for: $0.id) == shortcut }
    }

    /// Runtime state for `bento://debug/state`.
    public func diagnostics() -> [String: Any] {
        ["registered": registered.count, "failed": failed.sorted(), "duplicates": duplicateIDs.sorted(),
         "reloads": reloadCount, "hotkeyEntries": HotkeyCenter.shared.registrationCount,
         "hotkeysSuspended": HotkeyCenter.shared.isSuspended]
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

/// Cross-module notifications (modules never import each other).
public enum BentoEvents {
    /// Posted by the Windows module after a command or snap placed a window
    /// (not during live drags). userInfo["window"] is the `AXWindow`.
    /// Tiling uses it to float a window the user placed explicitly.
    public static let windowPlaced = Notification.Name("BentoWindowPlaced")
}

/// An installed app found by an `AppSearch`.
public struct FoundApp: Identifiable, Equatable {
    /// The bundle id when known, else the path.
    public let id: String
    public let name: String
    public let url: URL
    public let bundleID: String?

    public init(id: String, name: String, url: URL, bundleID: String?) {
        self.id = id
        self.name = name
        self.url = url
        self.bundleID = bundleID
    }
}

/// Implemented by the module that binds shortcuts to apps (App Hotkeys), so
/// the keyboard overview can find installed apps and give them a shortcut
/// without importing it. The entries it adds are ordinary actions of that
/// module: registered, conflict-checked and stored like the others.
public protocol AppHotkeyProvider: AnyObject {
    /// An installed-app index that lives as long as the returned search.
    /// `changed` runs on the main queue whenever more apps were found.
    func makeAppSearch(changed: @escaping () -> Void) -> AppSearch
    /// The action that opens `app`: its entry, or a new one without a shortcut.
    func addApp(_ app: FoundApp) -> String
    /// Removes an action's entry. False when the action isn't an entry.
    @discardableResult
    func removeEntry(_ actionID: String) -> Bool
    /// The app, file or folder an entry opens, for its icon.
    func iconFile(for actionID: String) -> URL?
}

public protocol AppSearch: AnyObject {
    /// Best matches first, without the apps that already have an entry.
    func results(_ query: String, limit: Int) -> [FoundApp]
}

/// Opens the settings window, optionally on a module's page.
public enum SettingsRouter {
    public static let openRequest = Notification.Name("BentoOpenSettings")

    /// `moduleID` nil = General, "shortcuts" = the Shortcuts page.
    public static func open(_ moduleID: String? = nil) {
        NotificationCenter.default.post(name: openRequest, object: moduleID)
    }
}
