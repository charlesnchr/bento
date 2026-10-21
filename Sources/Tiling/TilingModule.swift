import AppKit
import SwiftUI
import BentoCore

/// Optional AeroSpace-like tiling manager (simpler): per-display BSP tree with
/// tiles / master-stack / columns / rows / monocle layouts, directional focus
/// and moves, mouse drag-to-swap and resize, automatic floating for dialogs.
///
/// While the manager is off nothing runs except a config observer.
public final class TilingModule: BentoModule {
    public let id = "tiling"
    public let title = "Tiling"
    public let symbol = "square.grid.2x2"
    public let enabledByDefault = false

    private var settings = TilingSettings()
    private var manager: TilingManager?
    private var configToken: NSObjectProtocol?

    public init() {}

    // MARK: Lifecycle

    public func start() {
        ConfigStore.shared.materialize(id, default: TilingSettings())
        settings = ConfigStore.shared.section(id, default: TilingSettings())
        configToken = ConfigStore.shared.observe(id) { [weak self] in self?.configChanged() }
        syncManager()
    }

    public func stop() {
        if let configToken { NotificationCenter.default.removeObserver(configToken) }
        configToken = nil
        manager?.stop()
        manager = nil
    }

    private func configChanged() {
        settings = ConfigStore.shared.section(id, default: TilingSettings())
        manager?.update(settings: settings)
        syncManager()
    }

    private func syncManager() {
        if settings.managerOn && manager == nil && Permissions.accessibility {
            let m = TilingManager(settings: settings)
            manager = m
            m.start()
        } else if !settings.managerOn, let m = manager {
            m.stop()
            manager = nil
        }
    }

    private func toggle() {
        var s = settings
        s.managerOn.toggle()
        if s.managerOn && !Permissions.accessibility {
            Permissions.requestAccessibility()
            HUD.show("Tiling needs Accessibility permission", symbol: "lock")
            return
        }
        settings = s
        ConfigStore.shared.setSection(id, s)
        syncManager()
        HUD.show(s.managerOn ? "Tiling On" : "Tiling Off", symbol: s.managerOn ? "square.grid.2x2.fill" : "square.grid.2x2")
    }

    /// Runs `body` with the manager, or explains how to turn it on.
    private func withManager(_ body: (TilingManager) -> Void) {
        if let manager {
            body(manager)
        } else {
            let hint = ActionRegistry.shared.shortcut(for: "tiling.toggle").map { " (\($0.displayString))" } ?? ""
            HUD.show("Tiling is off\(hint)", symbol: "square.grid.2x2")
        }
    }

    // MARK: Actions

    public var actions: [BentoAction] {
        let manage = "Tiling"
        let nav = "Focus & Move"
        let size = "Size & Layout"
        var list: [BentoAction] = [
            BentoAction("tiling.toggle", "Toggle Tiling", group: manage, shortcut: "ctrl+opt+cmd+t") { [weak self] in self?.toggle() },
            BentoAction("tiling.retile", "Retile Now", group: manage, shortcut: "ctrl+opt+cmd+r") { [weak self] in
                self?.withManager { $0.retile() }
            },
            BentoAction("tiling.toggle-float", "Toggle Float", group: manage, shortcut: "ctrl+opt+cmd+f") { [weak self] in
                self?.withManager { $0.toggleFloat() }
            },
        ]
        let keys: [(Direction, String, String)] = [(.left, "h", "Left"), (.down, "j", "Down"), (.up, "k", "Up"), (.right, "l", "Right")]
        for (dir, key, name) in keys {
            list.append(BentoAction("tiling.focus-\(dir.rawValue)", "Focus \(name)", group: nav, shortcut: "ctrl+opt+cmd+\(key)",
                                    hiddenFromMenu: true) { [weak self] in
                if let m = self?.manager { m.focus(dir) } else { TilingManager.focusUnmanaged(dir) }
            })
        }
        for (dir, key, name) in keys {
            list.append(BentoAction("tiling.move-\(dir.rawValue)", "Move \(name)", group: nav, shortcut: "hyper+\(key)",
                                    hiddenFromMenu: true) { [weak self] in
                self?.withManager { $0.move(dir) }
            })
        }
        list += [
            BentoAction("tiling.promote", "Promote to Master", group: nav, shortcut: "ctrl+opt+cmd+return") { [weak self] in
                self?.withManager { $0.promote() }
            },
            BentoAction("tiling.next-display", "Move to Next Display", group: nav, shortcut: "ctrl+opt+cmd+n") { [weak self] in
                self?.withManager { $0.moveToNextDisplay() }
            },
            BentoAction("tiling.cycle-layout", "Cycle Layout", group: size, shortcut: "ctrl+opt+cmd+space") { [weak self] in
                self?.withManager { $0.cycleLayout() }
            },
            BentoAction("tiling.grow", "Grow", group: size, shortcut: "ctrl+opt+cmd+equal", hiddenFromMenu: true) { [weak self] in
                self?.withManager { $0.resize(grow: true) }
            },
            BentoAction("tiling.shrink", "Shrink", group: size, shortcut: "ctrl+opt+cmd+minus", hiddenFromMenu: true) { [weak self] in
                self?.withManager { $0.resize(grow: false) }
            },
            BentoAction("tiling.balance", "Balance", group: size, shortcut: "ctrl+opt+cmd+b") { [weak self] in
                self?.withManager { $0.balance() }
            },
            BentoAction("tiling.toggle-split", "Toggle Split Direction", group: size, shortcut: "ctrl+opt+cmd+e") { [weak self] in
                self?.withManager { $0.toggleSplit() }
            },
        ]
        for kind in LayoutKind.allCases {
            list.append(BentoAction("tiling.layout-\(kind.actionSuffix)", "\(kind.title) Layout", group: size, hiddenFromMenu: true) { [weak self] in
                self?.withManager { $0.setLayout(kind) }
            })
        }
        if ProcessInfo.processInfo.environment["BENTO_DEV"] != nil {
            list.append(BentoAction("tiling.debug-dump", "Dump State", group: manage, hiddenFromMenu: true) { [weak self] in
                let text = self?.manager?.debugDescription() ?? "manager off, live app observers: \(AppObserver.live)"
                let url = AppPaths.support("tiling").appendingPathComponent("state.txt")
                try? text.write(to: url, atomically: true, encoding: .utf8)
            })
        }
        return list
    }

    public func diagnostics() -> [String: Any] {
        ["managerOn": settings.managerOn, "liveAppObservers": AppObserver.live, "manager": manager?.diagnostics ?? [:]]
    }

    // MARK: Menu

    public func menuItems() -> [NSMenuItem] {
        let reg = ActionRegistry.shared
        let parent = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        parent.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        let sub = NSMenu()
        func add(_ id: String, title: String? = nil, state: Bool? = nil, enabled: Bool = true) {
            guard let a = reg.action(id) else { return }
            let item = reg.menuItem(for: a)
            if let title { item.title = title }
            if let state { item.state = state ? .on : .off }
            if !enabled { item.action = nil }
            sub.addItem(item)
        }
        let on = manager != nil
        add("tiling.toggle", title: "Tiling Manager", state: on)
        sub.addItem(.separator())
        let current = manager?.currentLayout
        for kind in LayoutKind.allCases {
            add("tiling.layout-\(kind.actionSuffix)", title: kind.title, state: current == kind, enabled: on)
        }
        sub.addItem(.separator())
        for id in ["tiling.retile", "tiling.balance", "tiling.toggle-float", "tiling.promote", "tiling.next-display"] {
            add(id, enabled: on)
        }
        parent.submenu = sub
        return [parent]
    }

    // MARK: Settings

    public func makeSettingsView() -> AnyView? {
        AnyView(TilingSettingsView(actions: actions.filter { $0.id != "tiling.debug-dump" }))
    }
}

extension LayoutKind {
    var actionSuffix: String {
        switch self {
        case .masterStack: "master-stack"
        default: rawValue
        }
    }
}
