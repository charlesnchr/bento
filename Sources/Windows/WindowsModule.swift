import AppKit
import SwiftUI
import BentoCore

/// Windows module: Rectangle Pro replacement. Keyboard actions with Rectangle's
/// defaults, drag-to-snap, modifier-drag move/resize, layouts, launch
/// positions and stash. See docs/SPEC.md.
public final class WindowsModule: BentoModule {
    public let id = "windows"
    public let title = "Windows"
    public let symbol = "rectangle.split.2x1"

    let engine = WindowEngine()
    private(set) lazy var snapper = SnapController(engine: engine)
    private(set) lazy var drag = DragController(engine: engine, snapper: snapper)
    private(set) lazy var layouts = LayoutManager(engine: engine)
    let stash = StashManager()
    let spaces = SpaceMover()

    private var configObserver: NSObjectProtocol?
    private var activationObserver: NSObjectProtocol?
    private var layoutSignature: [String] = []
    private var pendingReload: DispatchWorkItem?
    private var started = false

    public init() {}

    var settings: WindowsSettings { ConfigStore.shared.section(id, default: WindowsSettings()) }

    // MARK: Actions

    public var actions: [BentoAction] {
        var out = WindowCommand.allCases.map { cmd in
            BentoAction(cmd.actionID, cmd.title, group: cmd.group.rawValue, shortcut: cmd.defaultShortcut,
                        hiddenFromMenu: !cmd.inMainMenu) { [weak self] in self?.engine.perform(cmd) }
        }
        out += [
            BentoAction("windows.stash-left", "Stash Left", group: "Stash", hiddenFromMenu: true) { [weak self] in self?.stash.toggle(.left) },
            BentoAction("windows.stash-right", "Stash Right", group: "Stash", hiddenFromMenu: true) { [weak self] in self?.stash.toggle(.right) },
            BentoAction("windows.stash-reveal", "Reveal Stashed Window", group: "Stash", hiddenFromMenu: true) { [weak self] in self?.stash.toggleReveal() },
            BentoAction("windows.stash-unstash-all", "Unstash All", group: "Stash", hiddenFromMenu: true) { [weak self] in self?.stash.unstashAll() },
            BentoAction("windows.save-layout", "Save Layout…", group: "Layouts", hiddenFromMenu: true) { [weak self] in self?.promptSaveLayout() },
            BentoAction(RectangleImport.nextSpaceID, "Next Space", group: WindowCommand.Group.display.rawValue, hiddenFromMenu: true) { [weak self] in
                self?.spaces.move(direction: 1)
            },
            BentoAction(RectangleImport.prevSpaceID, "Previous Space", group: WindowCommand.Group.display.rawValue, hiddenFromMenu: true) { [weak self] in
                self?.spaces.move(direction: -1)
            },
            BentoAction("windows.import-rectangle", "Import Rectangle Settings…", group: "Other", hiddenFromMenu: true) { [weak self] in
                self?.importFromRectangle(interactive: true)
            },
        ]
        for layout in settings.layouts {
            out.append(BentoAction(layout.actionID, "Restore “\(layout.name)”", group: "Layouts", hiddenFromMenu: true) { [weak self] in
                self?.restoreLayout(id: layout.id)
            })
        }
        return out
    }

    // MARK: Lifecycle

    public func start() {
        guard !started else { return }
        started = true
        ConfigStore.shared.materialize(id, default: WindowsSettings())
        layoutSignature = signature(settings)
        snapper.isSuspended = { [weak self] in (self?.drag.isDragging ?? false) || (self?.spaces.isBusy ?? false) }
        applySettings()
        configObserver = ConfigStore.shared.observe(id) { [weak self] in self?.settingsChanged() }
        if !settings.importedFromRectangle {
            // First start: adopt Rectangle's shortcuts only if it is in use right
            // now — a leftover preferences file from an app the user stopped
            // using months ago is not their current habit. Deferred so the
            // registry has registered our actions (setShortcut compares defaults).
            if RectangleImport.isRunning {
                DispatchQueue.main.async { [weak self] in self?.importFromRectangle(interactive: false) }
            } else {
                var s = settings
                s.importedFromRectangle = true
                ConfigStore.shared.setSection(id, s)
            }
        }
    }

    public func stop() {
        guard started else { return }
        started = false
        if let o = configObserver { NotificationCenter.default.removeObserver(o) }
        configObserver = nil
        pendingReload?.cancel()
        stopActivationObserver()
        snapper.stop()
        drag.stop()
        layouts.stop()
        stash.unstashAll()
    }

    private func settingsChanged() {
        applySettings()
        let sig = signature(settings)
        if sig != layoutSignature {
            layoutSignature = sig
            // Debounced: renaming a layout in settings changes the list on every keystroke.
            pendingReload?.cancel()
            let work = DispatchWorkItem { ActionRegistry.shared.reload() }
            pendingReload = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: work)
        }
    }

    public func diagnostics() -> [String: Any] {
        ["started": started, "dragTap": drag.isRunning, "snapMonitor": snapper.isRunning,
         "waitingForAccessibility": activationObserver != nil]
    }

    private func signature(_ s: WindowsSettings) -> [String] { s.layouts.map { "\($0.id)|\($0.name)" } }

    private func applySettings() {
        let s = settings
        engine.settings = s
        snapper.options = s.snap
        if s.snapping { snapper.start() } else { snapper.stop() }

        var cfg = DragController.Config()
        cfg.move = s.dragMove ? WindowsSettings.flags(s.dragMoveModifiers) : []
        cfg.resize = s.dragResize ? WindowsSettings.flags(s.dragResizeModifiers) : []
        cfg.focus = s.dragFocusesWindow
        cfg.snap = s.dragSnaps && s.snapping
        drag.update(cfg)
        let wantDrag = !cfg.move.isEmpty || !cfg.resize.isEmpty
        if wantDrag && Permissions.accessibility {
            drag.start()
            stopActivationObserver()
        } else {
            drag.stop()
            // Without Accessibility the tap can't exist; try again once the
            // user comes back from System Settings.
            if wantDrag { startActivationObserver() } else { stopActivationObserver() }
        }

        layouts.rules = s.launchRules
        stash.sliver = CGFloat(WindowsSettings.finite(s.stashSliver, in: 4...200, else: 12))
        stash.revealOnHover = s.stashRevealOnHover
    }

    private func startActivationObserver() {
        guard activationObserver == nil else { return }
        activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self, Permissions.accessibility else { return }
            self.applySettings()
        }
    }

    private func stopActivationObserver() {
        if let o = activationObserver { NSWorkspace.shared.notificationCenter.removeObserver(o) }
        activationObserver = nil
    }

    // MARK: Rectangle import

    var rectangleSource: RectangleImport.Source? { RectangleImport.locate() }

    /// Imports a Rectangle / Rectangle Pro preferences plist or exported JSON the user picks.
    func importFromFile() {
        guard started else { return }
        AppActivation.activateSelf()
        let panel = NSOpenPanel()
        panel.title = "Import Rectangle Settings"
        panel.message = "Choose a Rectangle or Rectangle Pro preferences file (.plist) or a JSON file exported from Rectangle."
        panel.allowedContentTypes = [.propertyList, .json]
        panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Preferences", isDirectory: true)
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        guard let prefs = RectangleImport.read(url) else {
            showAlert("Not a Rectangle settings file", "\(url.lastPathComponent) isn't a preferences plist or a Rectangle export.")
            return
        }
        importPrefs(prefs, from: RectangleImport.source(forFile: url, prefs: prefs), interactive: true)
    }

    func importFromRectangle(interactive: Bool) {
        guard started else { return }
        guard let src = RectangleImport.locate(), let prefs = RectangleImport.read(src.url) else {
            if interactive {
                showAlert("No Rectangle settings found",
                          "Looked for ~/Library/Preferences/com.knollsoft.Hookshot.plist (Rectangle Pro) and com.knollsoft.Rectangle.plist.")
            } else {
                var s = settings
                s.importedFromRectangle = true
                ConfigStore.shared.setSection(id, s)
            }
            return
        }
        importPrefs(prefs, from: src, interactive: interactive)
    }

    private func importPrefs(_ prefs: [String: Any], from src: RectangleImport.Source, interactive: Bool) {
        let reg = ActionRegistry.shared
        var current: [String: Shortcut] = [:]
        for a in actions { if let sc = reg.shortcut(for: a.id) { current[a.id] = sc } }
        let plan = RectangleImport.plan(prefs: prefs, sourceName: src.name, isPro: src.isPro, settings: settings,
                                        current: current, spaces: true)
        RectangleImport.apply(plan)
        if interactive {
            showAlert("Imported from \(src.name)", RectangleImport.summary(plan))
        } else {
            HUD.show("Imported \(src.name) shortcuts", symbol: "square.and.arrow.down", duration: 2)
        }
    }

    private func showAlert(_ title: String, _ text: String) {
        AppActivation.activateSelf()
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = text
        alert.runModal()
    }

    // MARK: Layouts

    func saveLayout(named name: String) {
        var s = settings
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        let layout = layouts.capture(name: trimmed.isEmpty ? "Layout \(s.layouts.count + 1)" : trimmed)
        if let i = s.layouts.firstIndex(where: { $0.name == layout.name }) {
            // Same name: update the positions, keep id (and shortcut).
            s.layouts[i].windows = layout.windows
        } else {
            s.layouts.append(layout)
        }
        ConfigStore.shared.setSection(id, s)
        HUD.show("Saved “\(layout.name)” (\(layout.windows.count) windows)", symbol: "square.and.arrow.down")
    }

    func restoreLayout(id layoutID: String) {
        guard let layout = settings.layouts.first(where: { $0.id == layoutID }) else { return }
        layouts.restore(layout)
        if settings.showHUD { HUD.show(layout.name, symbol: "rectangle.3.group") }
    }

    private func promptSaveLayout() {
        AppActivation.activateSelf()
        let alert = NSAlert()
        alert.messageText = "Save Layout"
        alert.informativeText = "Saves the position of every visible window. Using an existing name updates that layout."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24))
        field.placeholderString = "Layout \(settings.layouts.count + 1)"
        alert.accessoryView = field
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        let previous = AppActivation.previousApp
        let response = alert.runModal()
        previous?.activate()
        guard response == .alertFirstButtonReturn else { return }
        // Let the previous app come back to front so its windows are captured as they are.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            self?.saveLayout(named: field.stringValue)
        }
    }

    // MARK: Menu

    public func menuItems() -> [NSMenuItem] {
        let reg = ActionRegistry.shared
        let parent = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        parent.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        let menu = NSMenu()
        var lastGroup: WindowCommand.Group?
        for cmd in WindowCommand.allCases where cmd.inMainMenu {
            if let g = lastGroup, g != cmd.group { menu.addItem(.separator()) }
            lastGroup = cmd.group
            if let a = reg.action(cmd.actionID) { menu.addItem(reg.menuItem(for: a)) }
            if cmd == .displayRight {
                for sid in [RectangleImport.nextSpaceID, RectangleImport.prevSpaceID] {
                    if let a = reg.action(sid) { menu.addItem(reg.menuItem(for: a)) }
                }
            }
        }
        menu.addItem(.separator())
        for group in [WindowCommand.Group.fourths, .sixths, .move, .more, .multi] {
            let item = NSMenuItem(title: group.rawValue, action: nil, keyEquivalent: "")
            let sub = NSMenu()
            for cmd in WindowCommand.allCases where cmd.group == group {
                if let a = reg.action(cmd.actionID) { sub.addItem(reg.menuItem(for: a)) }
            }
            item.submenu = sub
            menu.addItem(item)
        }

        let stashItem = NSMenuItem(title: "Stash", action: nil, keyEquivalent: "")
        let stashMenu = NSMenu()
        for id in ["windows.stash-left", "windows.stash-right", "windows.stash-reveal", "windows.stash-unstash-all"] {
            if let a = reg.action(id) { stashMenu.addItem(reg.menuItem(for: a)) }
        }
        stashItem.submenu = stashMenu
        menu.addItem(stashItem)

        let layoutItem = NSMenuItem(title: "Layouts", action: nil, keyEquivalent: "")
        let layoutMenu = NSMenu()
        for layout in settings.layouts {
            if let a = reg.action(layout.actionID) {
                let mi = reg.menuItem(for: a)
                mi.title = layout.name
                layoutMenu.addItem(mi)
            }
        }
        if !layoutMenu.items.isEmpty { layoutMenu.addItem(.separator()) }
        if let a = reg.action("windows.save-layout") { layoutMenu.addItem(reg.menuItem(for: a)) }
        layoutItem.submenu = layoutMenu
        menu.addItem(layoutItem)

        parent.submenu = menu
        return [parent]
    }

    public func makeSettingsView() -> AnyView? {
        AnyView(WindowsSettingsView(module: self))
    }
}
