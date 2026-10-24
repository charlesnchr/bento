import AppKit
import SwiftUI
import ServiceManagement
import BentoCore

public struct GeneralSettings: Codable, Equatable {
    /// Module id -> enabled. Missing ids use the module's default.
    public var enabledModules: [String: Bool] = [:]
    public var showMenuBarIcon = true
    /// Look for a new release once a day (Homebrew installs install it from the menu).
    public var checkForUpdates = true
    public init() {}
}

/// Entry point shared by the real app and the single-module dev harnesses.
public enum BentoApp {
    /// Dev harness entry: isolates config/data under /tmp/bento-dev/<name>
    /// (override with BENTO_HOME) and accepts `scripts/perform <action-id>`.
    /// `modules` is an autoclosure so the environment is set before any module's init runs.
    public static func runDev(_ name: String, modules: @autoclosure () -> [BentoModule]) -> Never {
        if ProcessInfo.processInfo.environment["BENTO_HOME"] == nil {
            setenv("BENTO_HOME", "/tmp/bento-dev/\(name)", 1)
        }
        setenv("BENTO_DEV", "1", 1)
        run(modules: modules())
    }

    public static func run(modules: [BentoModule]) -> Never {
        let app = NSApplication.shared
        let delegate = AppDelegate(modules: modules)
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) { app.run() }
        exit(0)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate {
    let modules: [BentoModule]
    private var statusItem: NSStatusItem?
    fileprivate(set) var settingsWindow: NSWindow?
    private var running: Set<String> = []
    private var observers: [NSObjectProtocol] = []
    private let navigator = SettingsNavigator()
    /// App-level actions (the keyboard overview); not a module the user sees.
    private let appActions = AppActionsModule()
    private var signalSources: [DispatchSourceSignal] = []
    private var retryHotkeysWork: DispatchWorkItem?
    private var general: GeneralSettings { ConfigStore.shared.section("general", default: GeneralSettings()) }
    /// Number of times the settings window was created / torn down (diagnostics).
    private var settingsOpened = 0
    private var settingsClosed = 0
    private let launch = LaunchLifecycle()

    init(modules: [BentoModule]) {
        self.modules = modules
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(handleURL(_:reply:)),
                                                     forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if ProcessInfo.processInfo.environment["BENTO_SHOW_SETTINGS"] != nil {
            _ = launch.receive(.settings)
        }
        if exitIfAlreadyRunning() { return }
        // `kill`/logout/`pkill` send SIGTERM: quit through AppKit so modules stop
        // and pending saves (notes, config) are flushed instead of lost.
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            src.setEventHandler { NSApp.terminate(nil) }
            src.resume()
            signalSources.append(src)
        }
        installMainMenu()
        AXDefaults.install()
        LaunchAtLogin.restoreAfterMove()
        ConfigStore.shared.problemHandler = { HUD.show($0, symbol: "exclamationmark.triangle", duration: 4) }
        if let problem = ConfigStore.shared.lastProblem {
            HUD.show(problem, symbol: "exclamationmark.triangle", duration: 4)
        }
        ConfigStore.shared.materialize("general", default: GeneralSettings())

        ActionRegistry.shared.isModuleEnabled = { [weak self] id in
            id == AppActionsModule.moduleID || (self?.running.contains(id) ?? false)
        }
        // App-level actions last: a module's or the user's binding of the same keys wins.
        ActionRegistry.shared.setModules(modules + [appActions])
        observers.append(NotificationCenter.default.addObserver(
            forName: StatusItemSizing.didChange, object: StatusItemSizing.shared, queue: nil) { [weak self] _ in
            self?.updateStatusItem()
        })
        syncModules()
        KeyboardOverview.scheduleLaunchHint()

        observers.append(NotificationCenter.default.addObserver(forName: SettingsRouter.openRequest, object: nil, queue: .main) { [weak self] note in
            self?.showSettings(page: note.object as? String)
        })
        observers.append(ConfigStore.shared.observe("general") { [weak self] in
            self?.syncModules()
            self?.updateStatusItem()
            Updater.shared.setAutomatic(self?.general.checkForUpdates ?? true)
        })
        observers.append(NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
            if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
               app.processIdentifier != getpid() {
                AppActivation.previousApp = app
            }
        })
        // A shortcut that failed to register may be free once another app quits:
        // retry failed ones without a restart. (Most cross-app clashes don't fail
        // at all; macOS lets both apps register the same combination.)
        observers.append(NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
            guard !ActionRegistry.shared.failed.isEmpty else { return }
            self?.retryHotkeysWork?.cancel()
            let work = DispatchWorkItem { ActionRegistry.shared.reload() }
            self?.retryHotkeysWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: work)
        })
        AppActivation.previousApp = NSWorkspace.shared.frontmostApplication

        if ProcessInfo.processInfo.environment["BENTO_DEV"] != nil {
            // Dev only: `scripts/perform <action-id>` triggers actions without
            // hotkeys (which may be owned by other running apps).
            let dnc = DistributedNotificationCenter.default()
            observers.append(dnc.addObserver(forName: Notification.Name("com.charles.bento.dev.perform"), object: nil, queue: .main) { note in
                guard let id = note.object as? String else { return }
                if !ActionRegistry.shared.perform(id) { BentoLog.core.error("dev perform: unknown action \(id, privacy: .public)") }
            })
            // Dev only: any bento:// URL, addressed to one instance by its
            // BENTO_HOME (object), since `open bento://…` only reaches the
            // installed app: userInfo["url"] = "bento://debug/state".
            let home = ProcessInfo.processInfo.environment["BENTO_HOME"] ?? ""
            observers.append(dnc.addObserver(forName: Notification.Name("com.charles.bento.dev.url"), object: home, queue: .main) { [weak self] note in
                guard let s = note.userInfo?["url"] as? String, let url = URL(string: s) else { return }
                self?.open(url)
            })
        }

        updateStatusItem()
        Updater.shared.start(automatic: general.checkForUpdates)
        ApplicationsAlias.ensure()
        perform(launch.finishLaunching(showSettings: !Permissions.accessibility))
    }

    func applicationWillTerminate(_ notification: Notification) {
        for m in modules where running.contains(m.id) { m.stop() }
        ConfigStore.shared.flush()
    }

    /// AppKit calls this for a cold open-application event before didFinishLaunching.
    func applicationShouldOpenUntitledFile(_ sender: NSApplication) -> Bool {
        if let request = LaunchLifecycle.Request.applicationOpen(NSAppleEventManager.shared().currentAppleEvent,
                                                                background: CommandLine.arguments.contains("--background")) {
            perform(launch.receive(request))
        }
        return false
    }

    /// Reopening the app preserves the last selected Settings page.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if let request = LaunchLifecycle.Request.applicationOpen(NSAppleEventManager.shared().currentAppleEvent) {
            perform(launch.receive(request))
        }
        return false
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

    /// A second launch hands over to the running instance, unless that one is
    /// stale: an older version, or one whose app is gone (`brew upgrade` in a
    /// terminal deletes the old keg). Then this launch asks it to quit and takes over.
    private func exitIfAlreadyRunning() -> Bool {
        guard let bid = Bundle.main.bundleIdentifier else { return false }
        let peers = NSRunningApplication.runningApplications(withBundleIdentifier: bid).filter { !$0.isTerminated }
        let others = peers.filter { $0.processIdentifier != getpid() }
        let candidates = others + [NSRunningApplication.current]
        guard let owner = LaunchPeer.owner(in: candidates.map { LaunchPeer(pid: $0.processIdentifier, launched: $0.launchDate) }),
              owner != getpid(), let other = others.first(where: { $0.processIdentifier == owner }) else { return false }
        if others.count == 1, isStale(other), other.terminate() {
            // Block rather than spin the run loop, which would deliver the URL
            // event that launched us before anything is set up. Once it has
            // been asked to quit, never hand back (it would quit later and
            // leave nothing running): force it after 5 s. Hotkeys it still
            // holds are retried when it quits (didTerminateApplication).
            let pid = other.processIdentifier
            for _ in 0..<50 where kill(pid, 0) == 0 { usleep(100_000) }
            if kill(pid, 0) == 0 {
                other.forceTerminate()
                for _ in 0..<10 where kill(pid, 0) == 0 { usleep(100_000) }
            }
            BentoLog.core.info("Took over from an older running Bento")
            return false
        }
        do {
            try launch.handOff { request in
                let reply = try request.event(to: other.processIdentifier).sendEvent(options: [.waitForReply, .canInteract], timeout: 2)
                if let error = reply.paramDescriptor(forKeyword: keyErrorNumber)?.int32Value, error != 0 {
                    throw NSError(domain: NSOSStatusErrorDomain, code: Int(error))
                }
            }
        } catch {
            // Keep unaccepted requests here. Activation alone is not delivery.
            BentoLog.core.error("Could not hand off launch: \(String(describing: error), privacy: .public)")
            return false
        }
        NSApp.terminate(nil)
        return true
    }

    private func isStale(_ other: NSRunningApplication) -> Bool {
        guard let url = other.bundleURL, url.standardizedFileURL != Bundle.main.bundleURL.standardizedFileURL else { return false }
        guard let plist = NSDictionary(contentsOf: url.appendingPathComponent("Contents/Info.plist")) else { return true }
        return UpdateRules.isNewer(Updater.shared.currentVersion, than: plist["CFBundleShortVersionString"] as? String ?? "0")
    }

    // MARK: URL scheme: bento://action/<id>, bento://settings, bento://update[/install]

    @objc private func handleURL(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        guard let s = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue, let url = URL(string: s) else { return }
        perform(launch.receive(.url(url)))
    }

    private func perform(_ requests: [LaunchLifecycle.Request]) {
        for request in requests {
            switch request {
            case .settings: showSettings(nil)
            case .url(let url): open(url)
            }
        }
    }

    private func open(_ url: URL) {
        let path = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        switch url.host?.lowercased() {
        case "action":
            if !ActionRegistry.shared.perform(path) { HUD.show("Unknown action \(path)", symbol: "questionmark.circle") }
        case "debug":
            writeDiagnostics()
        case "settings":
            showSettings(page: Self.settingsPage(url))
        case "update":
            // bento://update checks; bento://update/install installs a found update.
            if path == "install", case .available = Updater.shared.state { Updater.shared.install() } else { Updater.shared.check(.url) }
        default:
            BentoLog.core.error("Unknown URL \(url.absoluteString, privacy: .public)")
        }
    }

    /// `bento://debug/state` → `<support>/diagnostics.json`, for end-to-end tests.
    private func writeDiagnostics() {
        let reg = ActionRegistry.shared
        let actions: [[String: Any]] = reg.allActions.map { a in
            ["id": a.id, "shortcut": reg.shortcut(for: a.id)?.configString ?? "", "failed": reg.failed.contains(a.id)]
        }
        var modulesInfo: [String: Any] = [:]
        for m in modules { modulesInfo[m.id] = ["running": running.contains(m.id), "state": m.diagnostics()] }
        let info: [String: Any] = [
            "pid": Int(getpid()),
            "bundle": Bundle.main.bundlePath,
            "version": Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "dev",
            "accessibility": Permissions.accessibility,
            "screenRecording": Permissions.screenRecording,
            "modules": modulesInfo,
            "actions": actions,
            "failed": Array(reg.failed).sorted(),
            "registry": reg.diagnostics(),
            "config": ["watching": ConfigStore.shared.isWatching, "pendingWrite": ConfigStore.shared.hasPendingWrite,
                       "problem": ConfigStore.shared.lastProblem ?? ""],
            "settingsWindow": ["open": settingsWindow != nil, "opened": settingsOpened, "closed": settingsClosed,
                               "page": navigator.page.map { String(describing: $0) } ?? ""],
            "keyboardOverview": KeyboardOverview.shared.diagnostics,
            "dockPresence": DockPresence.retainCount,
            "activationPolicy": NSApp.activationPolicy() == .regular ? "regular" : NSApp.activationPolicy() == .accessory ? "accessory" : "prohibited",
            "statusItem": statusItem != nil,
            "statusItemLength": statusItem.map { Double($0.length) } as Any,
            "launchAtLogin": LaunchAtLogin.statusDescription,
            "update": Updater.shared.diagnostics,
            "time": Date().timeIntervalSince1970,
        ]
        let url = AppPaths.supportDir.appendingPathComponent("diagnostics.json")
        // Module diagnostics are free-form: anything that isn't a JSON type
        // would make JSONSerialization raise, so normalise first.
        let safe = AppDelegate.jsonSafe(info)
        if JSONSerialization.isValidJSONObject(safe),
           let data = try? JSONSerialization.data(withJSONObject: safe, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: url, options: .atomic)
        }
    }

    /// Converts a value into JSON types: non-finite numbers become null and
    /// anything unknown its description.
    static func jsonSafe(_ value: Any) -> Any {
        switch value {
        case let d as [String: Any]: return d.mapValues(jsonSafe)
        case let d as [AnyHashable: Any]: return Dictionary(d.map { ("\($0.key)", jsonSafe($0.value)) }, uniquingKeysWith: { a, _ in a })
        case let a as [Any]: return a.map(jsonSafe)
        case let s as Set<String>: return s.sorted()
        case let s as String: return s
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return n }
            return n.doubleValue.isFinite ? n : NSNull()
        case is NSNull: return NSNull()
        default:
            let mirror = Mirror(reflecting: value)
            if mirror.displayStyle == .optional { return mirror.children.first.map { jsonSafe($0.value) } ?? NSNull() }
            return String(describing: value)
        }
    }

    // MARK: Menu bar

    private func updateStatusItem() {
        if general.showMenuBarIcon {
            let bar = NSStatusBar.system
            let sizing = StatusItemSizing.shared
            let length = sizing.shellLength(thickness: bar.thickness, fallback: NSStatusItem.squareLength)
            if statusItem == nil {
                let item = bar.statusItem(withLength: length)
                let menu = NSMenu()
                menu.delegate = self
                item.menu = menu
                statusItem = item
            }
            statusItem?.length = length
            statusItem?.button?.image = BentoIcon.menuBarImage(size: sizing.shellImageSize)
        } else if let item = statusItem {
            NSStatusBar.system.removeStatusItem(item)
            statusItem = nil
        }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        for m in modules where running.contains(m.id) {
            for item in m.menuItems() {
                // NSMenu raises if an item already belongs to another menu.
                guard item.menu == nil else {
                    BentoLog.core.error("Module \(m.id, privacy: .public) returned a menu item that is already in a menu")
                    continue
                }
                menu.addItem(item)
            }
        }
        if !menu.items.isEmpty { menu.addItem(.separator()) }
        Updater.shared.refreshInstalled()
        if let update = Updater.shared.menuItem(showSettings: { [weak self] in self?.showSettings(page: "general") }) {
            menu.addItem(update)
        }
        if !Permissions.accessibility || !Permissions.screenRecording {
            let warn = ClosureMenuItem(title: "Grant Permissions…") { [weak self] in self?.showSettings(nil) }
            warn.image = NSImage(systemSymbolName: "exclamationmark.triangle", accessibilityDescription: nil)
            menu.addItem(warn)
        }
        menu.addItem(KeyboardOverview.menuItem())
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

    /// The page of a bento://settings/<page> link. A Shortcuts filter keeps its
    /// own slashes (…/shortcuts/%2F filters to "/"), which `url.path` drops.
    static func settingsPage(_ url: URL) -> String? {
        let raw = String((URLComponents(url: url, resolvingAgainstBaseURL: false)?.path ?? "").drop { $0 == "/" })
        let page = raw.hasPrefix("shortcuts/") ? raw : raw.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return page.isEmpty ? nil : page
    }

    func showSettings(page: String?) {
        // Unknown pages (typos in bento://settings/<id>) fall back to General.
        // "shortcuts/<text>" is the Shortcuts page filtered to <text>.
        let known = page.map { p in
            ["general", "shortcuts"].contains(p) || p.hasPrefix("shortcuts/") || modules.contains { $0.id == p }
        } ?? true
        navigator.select(known ? page : nil)
        showSettings(nil)
    }

    @objc func showSettings(_ sender: Any?) {
        if settingsWindow == nil {
            let root = SettingsRootView(delegate: self, navigator: navigator)
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
            w.delegate = self
            settingsWindow = w
            settingsOpened += 1
            DockPresence.retain()
        }
        AppActivation.activateSelf()
        settingsWindow?.makeKeyAndOrderFront(nil)
        settingsWindow?.orderFrontRegardless()
    }
}

extension AppDelegate {
    /// Drop the settings UI entirely when closed so it costs nothing while idle.
    func windowWillClose(_ notification: Notification) {
        guard let w = notification.object as? NSWindow, w === settingsWindow else { return }
        // Forget the window now, so a settings request arriving before the
        // teardown below opens a fresh window instead of the closing one.
        settingsWindow = nil
        settingsClosed += 1
        w.delegate = nil
        w.setFrameAutosaveName("") // the frame is already saved; free the name for the next window
        DockPresence.release()
        DispatchQueue.main.async {
            w.contentViewController = nil
        }
    }
}

// MARK: - Launch at login

enum LaunchAtLogin {
    /// Only a real app bundle can be a login item; dev builds (raw binaries,
    /// BENTO_DEV) must never register one.
    static var isAvailable: Bool {
        Bundle.main.bundleIdentifier != nil && Bundle.main.bundlePath.hasSuffix(".app")
            && ProcessInfo.processInfo.environment["BENTO_DEV"] == nil
    }

    static var isEnabled: Bool { isAvailable && SMAppService.mainApp.status == .enabled }

    static var needsApproval: Bool { isAvailable && SMAppService.mainApp.status == .requiresApproval }

    static var statusDescription: String {
        guard isAvailable else { return "unavailable" }
        switch SMAppService.mainApp.status {
        case .enabled: return "enabled"
        case .requiresApproval: return "requiresApproval"
        case .notRegistered: return "notRegistered"
        case .notFound: return "notFound"
        @unknown default: return "unknown"
        }
    }

    /// The user's choice, kept apart from the system state: a Homebrew update
    /// moves the app to a new keg (…/Cellar/bento/<version>), and the login
    /// item has to be registered again from there.
    private static let wantedKey = "LaunchAtLoginWanted"

    /// Registers the login item again if it was wanted but this copy isn't
    /// registered (it moved). Leaves it alone when the user switched it off in
    /// System Settings (that reads as requiresApproval).
    static func restoreAfterMove() {
        guard isAvailable else { return }
        let defaults = UserDefaults.standard
        if defaults.object(forKey: wantedKey) == nil, isEnabled { defaults.set(true, forKey: wantedKey) }
        guard defaults.bool(forKey: wantedKey) else { return }
        switch SMAppService.mainApp.status {
        case .notRegistered, .notFound:
            do { try SMAppService.mainApp.register() } catch {
                BentoLog.core.error("Restoring launch at login failed: \(String(describing: error), privacy: .public)")
            }
        default: break
        }
    }

    /// Returns the resulting state (which may differ from `on` if the system refused).
    @discardableResult
    static func set(_ on: Bool) -> Bool {
        guard isAvailable else { return false }
        UserDefaults.standard.set(on, forKey: wantedKey)
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            BentoLog.core.error("Launch at login change failed: \(String(describing: error), privacy: .public)")
        }
        return isEnabled
    }
}
