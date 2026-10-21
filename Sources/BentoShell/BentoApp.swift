import AppKit
import SwiftUI
import ServiceManagement
import BentoCore

public struct GeneralSettings: Codable, Equatable {
    /// Module id -> enabled. Missing ids use the module's default.
    public var enabledModules: [String: Bool] = [:]
    public var showMenuBarIcon = true
    public init() {}
}

/// Entry point shared by the real app and the single-module dev harnesses.
public enum BentoApp {
    public static func run(modules: [BentoModule]) -> Never {
        let app = NSApplication.shared
        let delegate = AppDelegate(modules: modules)
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) { app.run() }
        exit(0)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let modules: [BentoModule]
    private var statusItem: NSStatusItem?
    private var settingsWindow: NSWindow?
    private var running: Set<String> = []
    private var observers: [NSObjectProtocol] = []
    private var general: GeneralSettings { ConfigStore.shared.section("general", default: GeneralSettings()) }

    init(modules: [BentoModule]) {
        self.modules = modules
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(handleURL(_:reply:)),
                                                     forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if exitIfAlreadyRunning() { return }
        installMainMenu()
        ConfigStore.shared.materialize("general", default: GeneralSettings())

        ActionRegistry.shared.isModuleEnabled = { [weak self] id in self?.running.contains(id) ?? false }
        ActionRegistry.shared.setModules(modules)
        syncModules()

        observers.append(ConfigStore.shared.observe("general") { [weak self] in
            self?.syncModules()
            self?.updateStatusItem()
        })
        observers.append(NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
            if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
               app.processIdentifier != getpid() {
                AppActivation.previousApp = app
            }
        })
        AppActivation.previousApp = NSWorkspace.shared.frontmostApplication

        updateStatusItem()
        if !Permissions.accessibility || ProcessInfo.processInfo.environment["BENTO_SHOW_SETTINGS"] != nil {
            showSettings(nil)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        for m in modules where running.contains(m.id) { m.stop() }
        ConfigStore.shared.flush()
    }

    /// Reopening the app (e.g. double-clicking it in Finder) opens settings.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showSettings(nil)
        return true
    }

    // MARK: Modules

    func isEnabled(_ m: BentoModule) -> Bool { general.enabledModules[m.id] ?? m.enabledByDefault }

    private func syncModules() {
        var changed = false
        for m in modules {
            let want = isEnabled(m)
            if want && !running.contains(m.id) {
                running.insert(m.id)
                m.start()
                changed = true
            } else if !want && running.contains(m.id) {
                running.remove(m.id)
                m.stop()
                changed = true
            }
        }
        if changed { ActionRegistry.shared.reload() }
    }

    func setEnabled(_ m: BentoModule, _ on: Bool) {
        var g = general
        g.enabledModules[m.id] = on
        ConfigStore.shared.setSection("general", g)
    }

    // MARK: Single instance

    private func exitIfAlreadyRunning() -> Bool {
        guard let bid = Bundle.main.bundleIdentifier else { return false }
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: bid).filter { $0.processIdentifier != getpid() }
        guard let other = others.first else { return false }
        other.activate()
        NSApp.terminate(nil)
        return true
    }

    // MARK: URL scheme: bento://action/<id>, bento://settings

    @objc private func handleURL(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        guard let s = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue, let url = URL(string: s) else { return }
        switch url.host {
        case "action":
            let id = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            if !ActionRegistry.shared.perform(id) { HUD.show("Unknown action \(id)", symbol: "questionmark.circle") }
        case "settings":
            showSettings(nil)
        default:
            break
        }
    }

    // MARK: Menu bar

    private func updateStatusItem() {
        if general.showMenuBarIcon {
            if statusItem == nil {
                let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
                item.button?.image = BentoIcon.menuBarImage()
                let menu = NSMenu()
                menu.delegate = self
                item.menu = menu
                statusItem = item
            }
        } else if let item = statusItem {
            NSStatusBar.system.removeStatusItem(item)
            statusItem = nil
        }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        for m in modules where running.contains(m.id) {
            m.menuItems().forEach(menu.addItem)
        }
        if !menu.items.isEmpty { menu.addItem(.separator()) }
        if !Permissions.accessibility || !Permissions.screenRecording {
            let warn = ClosureMenuItem(title: "Grant Permissions…") { [weak self] in self?.showSettings(nil) }
            warn.image = NSImage(systemSymbolName: "exclamationmark.triangle", accessibilityDescription: nil)
            menu.addItem(warn)
        }
        let settings = ClosureMenuItem(title: "Settings…", keyEquivalent: ",") { [weak self] in self?.showSettings(nil) }
        menu.addItem(settings)
        menu.addItem(ClosureMenuItem(title: "Open Config File") { NSWorkspace.shared.open(ConfigStore.shared.url) })
        menu.addItem(.separator())
        menu.addItem(ClosureMenuItem(title: "Quit Bento", keyEquivalent: "q") { NSApp.terminate(nil) })
    }

    /// Accessory apps have no main menu by default, which breaks ⌘C/⌘V/⌘Z in
    /// text fields. Install a minimal one.
    private func installMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Settings…", action: #selector(showSettings(_:)), keyEquivalent: ",")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Bento", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Bento", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        let pasteMatch = edit.addItem(withTitle: "Paste and Match Style", action: #selector(NSTextView.pasteAsPlainText(_:)), keyEquivalent: "v")
        pasteMatch.keyEquivalentModifierMask = [.command, .option, .shift]
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Find…", action: #selector(NSTextView.performFindPanelAction(_:)), keyEquivalent: "f").tag = Int(NSFindPanelAction.showFindPanel.rawValue)
        editItem.submenu = edit
        main.addItem(editItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)
        NSApp.mainMenu = main
    }

    // MARK: Settings window

    @objc func showSettings(_ sender: Any?) {
        if settingsWindow == nil {
            let root = SettingsRootView(delegate: self)
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 880, height: 600),
                             styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                             backing: .buffered, defer: false)
            w.title = "Bento Settings"
            w.titlebarAppearsTransparent = true
            w.toolbarStyle = .unified
            w.contentViewController = NSHostingController(rootView: root)
            w.setContentSize(NSSize(width: 880, height: 600))
            w.minSize = NSSize(width: 760, height: 480)
            w.isReleasedWhenClosed = false
            w.center()
            w.setFrameAutosaveName("BentoSettings")
            settingsWindow = w
        }
        AppActivation.activateSelf()
        settingsWindow?.makeKeyAndOrderFront(nil)
    }
}

// MARK: - Launch at login

enum LaunchAtLogin {
    static var isEnabled: Bool { SMAppService.mainApp.status == .enabled }

    static func set(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            BentoLog.core.error("Launch at login change failed: \(String(describing: error), privacy: .public)")
        }
    }
}
