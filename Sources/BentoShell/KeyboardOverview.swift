import AppKit
import Carbon.HIToolbox
import SwiftUI
import BentoCore

// MARK: - App-level actions

/// Actions that belong to the app rather than a feature module (the keyboard
/// overview). The shell registers it after the modules, so a module's or the
/// user's binding of the same keys keeps working. It can't be turned off and
/// has no settings page or menu submenu of its own.
final class AppActionsModule: BentoModule {
    static let moduleID = "bento"
    let id = AppActionsModule.moduleID
    let title = "Bento"
    let symbol = "keyboard"

    var actions: [BentoAction] {
        [BentoAction(KeyboardOverview.actionID, "Keyboard Shortcuts", shortcut: KeyboardOverview.defaultShortcut) {
            KeyboardOverview.shared.toggle()
        }]
    }

    func start() {}
    func stop() {}
}

// MARK: - Catalog (what the overview lists)

struct OverviewItem: Identifiable, Equatable {
    let id: String
    let title: String
    let group: String?
    let moduleTitle: String
    let shortcut: Shortcut?
    /// Why the shortcut isn't active (taken, used by macOS…).
    let problem: String?
    /// The app, file or folder whose icon the row shows.
    var icon: URL? = nil
    /// An installed app without an entry, offered by the search: ⌘E gives it one.
    var app: FoundApp? = nil

    /// "Open <app>", in the App Hotkeys section: titled like the entry it becomes.
    static func app(_ app: FoundApp, in section: OverviewSection) -> OverviewItem {
        OverviewItem(id: "app:\(app.id)", title: "Open \(app.name)", group: nil, moduleTitle: section.title,
                     shortcut: nil, problem: nil, icon: app.url, app: app)
    }

    /// Every token must match: the title, group, module, id or the shortcut
    /// ("left", "windows", "ctrl", "⌘⇧2" in any modifier order).
    func matches(_ tokens: [String]) -> Bool {
        tokens.allSatisfy(matches)
    }

    private func matches(_ token: String) -> Bool {
        if haystack.contains(token) { return true }
        guard let shortcut else { return false }
        var mods: NSEvent.ModifierFlags = []
        var rest = ""
        for ch in token {
            if let m = OverviewItem.glyphs[ch] { mods.insert(m) } else { rest.append(ch) }
        }
        guard !mods.isEmpty, shortcut.modifiers.isSuperset(of: mods) else { return false }
        return rest.isEmpty || Shortcut.keySymbol(for: shortcut.keyCode).lowercased() == rest
            || Shortcut.keyName(for: shortcut.keyCode) == rest
    }

    private static let glyphs: [Character: NSEvent.ModifierFlags] = ["⌃": .control, "⌥": .option, "⇧": .shift, "⌘": .command]

    private var haystack: String {
        var parts = [title, group ?? "", moduleTitle, id]
        if let shortcut {
            parts += [shortcut.displayString, shortcut.configString]
            // Spelled-out names, for people who don't know the symbols yet.
            if shortcut.modifiers.contains(.control) { parts.append("control") }
            if shortcut.modifiers.contains(.option) { parts += ["option", "alt"] }
            if shortcut.modifiers.contains(.command) { parts.append("command") }
            if shortcut.modifiers.contains(.shift) { parts.append("shift") }
        }
        return parts.joined(separator: " ").lowercased()
    }
}

struct OverviewSection: Identifiable, Equatable {
    /// The module id.
    let id: String
    let title: String
    let symbol: String
    /// Off modules are listed by name only, with a way to turn them on.
    let isEnabled: Bool
    var items: [OverviewItem]
}

enum OverviewCatalog {
    /// One section per module, in module order. Within a module, actions with
    /// a shortcut come first (otherwise in the module's order), so the
    /// shortcuts are what you see at a glance.
    static func build(modules: [BentoModule], isEnabled: (String) -> Bool, actions: [BentoAction],
                      shortcut: (String) -> Shortcut?, problem: (String) -> String?,
                      icon: (String) -> URL? = { _ in nil }) -> [OverviewSection] {
        let registered = Set(actions.map(\.id))
        var seen = Set<String>()
        return modules.map { m in
            guard isEnabled(m.id) else {
                return OverviewSection(id: m.id, title: m.title, symbol: m.symbol, isEnabled: false, items: [])
            }
            // The registry's list decides which actions are live (it drops duplicate ids).
            let items = m.actions.filter { registered.contains($0.id) && seen.insert($0.id).inserted }.map { a in
                OverviewItem(id: a.id, title: a.title, group: a.group, moduleTitle: m.title,
                             shortcut: shortcut(a.id), problem: problem(a.id), icon: icon(a.id))
            }
            return OverviewSection(id: m.id, title: m.title, symbol: m.symbol, isEnabled: true,
                                   items: items.filter { $0.shortcut != nil } + items.filter { $0.shortcut == nil })
        }
    }

    static func tokens(_ query: String) -> [String] {
        query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
    }

    /// Sections with matching actions. Off modules show while the query is
    /// empty or names them ("tiling" finds Tiling even while it's off).
    /// `keeping`: an action listed even when it doesn't match (the one whose
    /// shortcut was just changed, which may not match a key search any more).
    static func filter(_ sections: [OverviewSection], query: String, keeping: String? = nil) -> [OverviewSection] {
        let tokens = tokens(query)
        guard !tokens.isEmpty else { return sections }
        return sections.compactMap { s in
            guard s.isEnabled else {
                let title = s.title.lowercased()
                return tokens.allSatisfy(title.contains) ? s : nil
            }
            var s = s
            s.items = s.items.filter { $0.id == keeping || $0.matches(tokens) }
            return s.items.isEmpty ? nil : s
        }
    }

    /// Search results plus installed apps without an entry, listed after the
    /// matching entries of the App Hotkeys section (`sectionID`), which shows
    /// up for them even when no entry matched. Not while that module is off.
    static func adding(_ apps: [FoundApp], to filtered: [OverviewSection], from all: [OverviewSection],
                       in sectionID: String) -> [OverviewSection] {
        guard !apps.isEmpty, let base = all.first(where: { $0.id == sectionID && $0.isEnabled }) else { return filtered }
        var section = filtered.first { $0.id == sectionID } ?? OverviewSection(
            id: base.id, title: base.title, symbol: base.symbol, isEnabled: true, items: [])
        let listed = Set(section.items.map(\.id))
        section.items += apps.map { OverviewItem.app($0, in: base) }.filter { !listed.contains($0.id) }
        let order = all.map(\.id)
        return (filtered.filter { $0.id != sectionID } + [section])
            .sorted { (order.firstIndex(of: $0.id) ?? .max) < (order.firstIndex(of: $1.id) ?? .max) }
    }

    /// True when some shortcut holds all four modifiers (what the config calls "hyper").
    static func usesHyper(_ sections: [OverviewSection]) -> Bool {
        let hyper: NSEvent.ModifierFlags = [.control, .option, .shift, .command]
        return sections.contains { $0.items.contains { $0.shortcut?.modifiers.isSuperset(of: hyper) == true } }
    }

    /// Keycaps in menu order: ⌃ ⌥ ⇧ ⌘, then the key.
    static func keycaps(_ s: Shortcut) -> [String] {
        var out: [String] = []
        if s.modifiers.contains(.function) { out.append("fn") }
        if s.modifiers.contains(.control) { out.append("⌃") }
        if s.modifiers.contains(.option) { out.append("⌥") }
        if s.modifiers.contains(.shift) { out.append("⇧") }
        if s.modifiers.contains(.command) { out.append("⌘") }
        return out + [Shortcut.keySymbol(for: s.keyCode)]
    }

    /// Settings page for a section's Settings link.
    static func settingsPage(for moduleID: String) -> String {
        moduleID == AppActionsModule.moduleID ? "shortcuts" : moduleID
    }
}

// MARK: - Panel

/// The keyboard overview: every action grouped by module with its shortcut,
/// a search field, and the way into Settings. A non-activating panel like the
/// clipboard history, so an action run from it applies to the app the user
/// was in. Nothing exists until it opens; everything is released on close.
final class KeyboardOverview: NSObject, NSWindowDelegate {
    static let shared = KeyboardOverview()
    static let actionID = "bento.keyboard-overview"
    /// ⌥/: the "?" key (help in most apps) with one modifier. Free in every
    /// module's defaults and in macOS's own, and, registered by key position,
    /// never needs Shift (on layouts where "/" is ⇧7 it's the key left of the
    /// right Shift, which the footer points out). It types "÷" on a US layout,
    /// which a global hotkey takes. Users who never changed the old default
    /// (⌃⌥/) get it automatically: only shortcuts that differ from the default
    /// are stored.
    static let defaultShortcut = "opt+slash"
    static let size = NSSize(width: 680, height: 560)
    private static let hintKey = "KeyboardOverviewSeen"

    private var window: KeyablePanel?
    private var model: OverviewModel?
    /// Diagnostics: stays set until the closed panel's model is deallocated.
    private weak var lastModel: OverviewModel?
    private var keyMonitor: Any?
    private var observers: [NSObjectProtocol] = []
    /// Bento's own window that had focus when the panel opened.
    private weak var returnWindow: NSWindow?
    private var opened = 0
    private var closed = 0

    var isVisible: Bool { window?.isVisible == true }

    func toggle() {
        if isVisible { close() } else { show() }
    }

    // MARK: Show / close

    func show() {
        if let window, window.isVisible {
            window.makeKeyAndOrderFront(nil)
            return
        }
        UserDefaults.standard.set(true, forKey: Self.hintKey)
        returnWindow = NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid() ? NSApp.keyWindow : nil

        let model = OverviewModel()
        model.onRun = { [weak self] in self?.run($0) }
        model.onOpenSettings = { [weak self] in self?.openSettings($0) }
        model.onRecord = { [weak self] in self?.record($0) }
        // After the recorder has finished with the key that ended it.
        model.onRecordingEnded = { [weak self] in DispatchQueue.main.async { self?.focusSearch() } }
        model.reload()
        self.model = model
        lastModel = model

        let w = KeyablePanel(contentRect: NSRect(origin: .zero, size: Self.size),
                             styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel],
                             backing: .buffered, defer: true)
        w.title = "Keyboard Shortcuts" // not shown; for VoiceOver and window lists
        w.titleVisibility = .hidden
        w.titlebarAppearsTransparent = true
        for b in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] { w.standardWindowButton(b)?.isHidden = true }
        w.isMovableByWindowBackground = true
        w.isFloatingPanel = true
        w.level = .floating
        w.hidesOnDeactivate = false
        w.becomesKeyOnlyIfNeeded = false
        w.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary, .transient, .ignoresCycle]
        w.isReleasedWhenClosed = false
        w.animationBehavior = .utilityWindow
        w.isOpaque = false
        w.backgroundColor = .clear
        w.delegate = self
        if ProcessInfo.processInfo.environment["BENTO_DEV"] != nil,
           let a = ProcessInfo.processInfo.environment["BENTO_APPEARANCE"] {
            w.appearance = NSAppearance(named: a == "dark" ? .darkAqua : .aqua)
        }

        let host = NSHostingView(rootView: KeyboardOverviewView(model: model))
        host.sizingOptions = []
        w.contentView = ThemedBackgroundView(material: .popover, content: host)

        if let vf = (NSScreen.underMouse ?? NSScreen.main)?.visibleFrame {
            let x = vf.midX - Self.size.width / 2
            let y = vf.minY + (vf.height - Self.size.height) * 0.6
            w.setFrame(NSRect(x: x.rounded(), y: y.rounded(), width: Self.size.width, height: Self.size.height), display: false)
        }
        window = w
        opened += 1
        w.makeKeyAndOrderFront(nil)
        w.orderFrontRegardless()
        focusSearch()

        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            guard let self, let w = self.window, e.window === w else { return e }
            return self.handleKey(e) ? nil : e
        }
        // Shortcut edits, modules turned on/off, launcher entries: all reload the registry.
        observers.append(NotificationCenter.default.addObserver(forName: ActionRegistry.didReload, object: nil, queue: .main) { [weak self] _ in
            self?.model?.reload()
        })
    }

    /// `restoreFocus`: give focus back to the Bento window the panel was opened
    /// over (not when the user clicked somewhere else).
    func close(restoreFocus: Bool = true) {
        guard let w = window else { return }
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        keyMonitor = nil
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        window = nil
        model = nil
        closed += 1
        w.delegate = nil
        w.orderOut(nil)
        // After the current event: a button in the panel may have closed it.
        DispatchQueue.main.async { w.contentView = nil }
        if restoreFocus, let r = returnWindow, r.isVisible, !r.isKeyWindow { r.makeKey() }
        returnWindow = nil
    }

    private func focusSearch() {
        guard let w = window else { return }
        // The SwiftUI hierarchy creates the field during the first layout.
        w.contentView?.layoutSubtreeIfNeeded()
        if let f = model?.searchField { focus(f, in: w) }
        DispatchQueue.main.async { [weak self] in
            guard let self, let w = self.window, let f = self.model?.searchField, w.firstResponder !== f.currentEditor() else { return }
            self.focus(f, in: w)
        }
    }

    /// Caret after the query, so typing goes on with the search (back from recording).
    private func focus(_ field: NSTextField, in window: NSWindow) {
        window.makeFirstResponder(field)
        (field.currentEditor() as? NSTextView)?.moveToEndOfDocument(nil)
    }

    func windowDidResignKey(_ notification: Notification) {
        // Clicking elsewhere dismisses the panel, like Spotlight.
        DispatchQueue.main.async { [weak self] in
            guard let self, let w = self.window, !w.isKeyWindow else { return }
            self.close(restoreFocus: false)
        }
    }

    // MARK: Actions

    /// Closes first, so the action applies to the app the user was in.
    private func run(_ item: OverviewItem) {
        close()
        guard item.id != Self.actionID else { return }
        if let app = item.app {
            let config = NSWorkspace.OpenConfiguration()
            config.activates = true
            NSWorkspace.shared.openApplication(at: app.url, configuration: config) { _, error in
                if let error {
                    DispatchQueue.main.async { HUD.show("Couldn't open: \(error.localizedDescription)", symbol: "exclamationmark.triangle") }
                }
            }
            return
        }
        DispatchQueue.main.async { ActionRegistry.shared.perform(item.id) }
    }

    private func openSettings(_ page: String?) {
        close(restoreFocus: false)
        SettingsRouter.open(page)
    }

    /// Starts the recorder the selected row shows while it's being edited
    /// (the panel stays key, so the app underneath stays frontmost).
    private func record(_ id: String) {
        guard let window else { return }
        RecorderFocus.begin(id, in: window, attempts: 25, shouldContinue: { [weak self] in self?.model?.editingID == id })
        // A row that never showed up mustn't leave the panel waiting for a recording.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let model = self?.model, model.editingID == id, !model.isRecording else { return }
            model.recordingChanged(id, false)
        }
    }

    // MARK: Keyboard

    /// Returns true when the key was handled (otherwise it goes to the search field).
    private func handleKey(_ e: NSEvent) -> Bool {
        guard let model else { return false }
        // The row's recorder takes every key (Esc cancels it, not the panel).
        if model.isRecording { return false }
        // While an input method composes (dead keys, CJK), ↵ and the arrows are its keys.
        if let editor = model.searchField?.currentEditor() as? NSTextView, editor.hasMarkedText() { return false }
        let mods = e.modifierFlags.intersection([.command, .option, .control, .shift])
        switch (Int(e.keyCode), mods) {
        case (kVK_DownArrow, []), (kVK_ANSI_N, [.control]): model.move(1)
        case (kVK_UpArrow, []), (kVK_ANSI_P, [.control]): model.move(-1)
        case (kVK_PageDown, []): model.move(8)
        case (kVK_PageUp, []): model.move(-8)
        case (kVK_DownArrow, [.command]), (kVK_End, []): model.moveToEnd(true)
        case (kVK_UpArrow, [.command]), (kVK_Home, []): model.moveToEnd(false)
        case (kVK_Return, []), (kVK_ANSI_KeypadEnter, []):
            if let item = model.selectedItem { run(item) } else { NSSound.beep() }
        case (kVK_Escape, []):
            // ⌘E's recorder not started yet: Esc drops that, the panel stays.
            if model.cancelPendingEdit() { break }
            if model.query.isEmpty { close() } else { model.query = "" } // clears, then closes (Spotlight)
        case (kVK_ANSI_Comma, [.command]): openSettings(nil)
        case (kVK_ANSI_Comma, [.command, .shift]):
            openSettings(model.selectedSection.map { OverviewCatalog.settingsPage(for: $0.id) })
        case (kVK_ANSI_E, [.command]):
            if let item = model.selectedItem { model.editShortcut(item) } else { NSSound.beep() }
        case (kVK_Delete, [.command]) where model.selectedItem.map(model.canRemove) == true:
            model.selectedItem.map(model.remove)   // otherwise ⌘⌫ edits the search field
        case (kVK_ANSI_W, [.command]): close()
        default:
            // Its own shortcut closes it even when the global hotkey couldn't be registered.
            if let own = ActionRegistry.shared.shortcut(for: Self.actionID), own.matches(e) { close(); return true }
            return false
        }
        return true
    }

    // MARK: Menu, launch hint, diagnostics

    /// "Keyboard Shortcuts…" for the menu bar menu, showing the current shortcut.
    static func menuItem() -> NSMenuItem {
        let item = ClosureMenuItem(title: "Keyboard Shortcuts…") { KeyboardOverview.shared.show() }
        if let sc = ActionRegistry.shared.shortcut(for: actionID), let (key, mods) = sc.menuKeyEquivalent {
            item.keyEquivalent = key
            item.keyEquivalentModifierMask = mods
        }
        return item
    }

    /// Once: a hint at the overview shortly after launch, until it has been
    /// opened or the hint shown (new users, and existing ones after updating).
    static func scheduleLaunchHint() {
        guard !UserDefaults.standard.bool(forKey: hintKey) else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            guard !UserDefaults.standard.bool(forKey: hintKey) else { return }
            UserDefaults.standard.set(true, forKey: hintKey)
            let reg = ActionRegistry.shared
            if let sc = reg.shortcut(for: actionID), reg.failureReason(for: actionID) == nil {
                HUD.show("Press \(sc.displayString) to see all keyboard shortcuts", symbol: "keyboard", duration: 4)
            } else {
                HUD.show("All keyboard shortcuts: Bento menu → Keyboard Shortcuts…", symbol: "keyboard", duration: 4)
            }
        }
    }

    var diagnostics: [String: Any] {
        ["open": isVisible, "opened": opened, "closed": closed, "modelAlive": lastModel != nil,
         "query": model?.query ?? "", "selected": model?.selectedID ?? "", "listed": model?.items.map(\.id) ?? [],
         "editing": model?.editingID ?? "", "recording": model?.isRecording ?? false,
         "problems": model?.items.filter { $0.problem != nil }.map(\.id) ?? [],
         "apps": model?.items.filter { $0.app != nil }.map(\.id) ?? [],
         "hintSeen": UserDefaults.standard.bool(forKey: Self.hintKey)]
    }
}

// MARK: - Model

final class OverviewModel: ObservableObject {
    @Published var query = "" {
        didSet {
            guard query != oldValue else { return }
            pinnedID = nil
            if !isRecording { editingID = nil }   // typing drops an edit whose recorder hasn't started
            refilter(keepSelection: false)
        }
    }
    @Published private(set) var sections: [OverviewSection] = []
    @Published private(set) var selectedID: String?
    /// Bumped when the selection should scroll into view (keyboard, new results).
    @Published private(set) var scrollToken = 0
    @Published private(set) var usesHyper = false
    @Published private(set) var accessibility = true
    @Published private(set) var screenRecording = true
    @Published private(set) var ownShortcut: Shortcut?
    /// The action whose row shows a recorder (⌘E), until recording ends.
    @Published private(set) var editingID: String?
    /// True while that recorder records: it takes the keys.
    @Published private(set) var isRecording = false
    weak var searchField: NSTextField?
    var onRun: (OverviewItem) -> Void = { _ in }
    var onOpenSettings: (String?) -> Void = { _ in }
    /// Starts recording in the editing row once it's laid out.
    var onRecord: (String) -> Void = { _ in }
    var onRecordingEnded: () -> Void = {}
    private var all: [OverviewSection] = []
    /// The last edited action stays listed until the search changes.
    private var pinnedID: String?
    /// App Hotkeys, while it's on: finds installed apps and adds their entries.
    private var apps: (moduleID: String, provider: AppHotkeyProvider)?
    private var appSearch: AppSearch?
    /// Row icons, dropped with the panel.
    let icons = IconCache()
    static let appResults = 6

    /// Listed actions, in order.
    var items: [OverviewItem] { sections.flatMap(\.items) }
    var selectedItem: OverviewItem? { selectedID.flatMap { id in items.first { $0.id == id } } }
    var selectedSection: OverviewSection? { selectedID.flatMap { id in sections.first { $0.items.contains { $0.id == id } } } }

    func reload() {
        let reg = ActionRegistry.shared
        let module = reg.modules.first { $0 is AppHotkeyProvider && reg.isModuleEnabled($0.id) }
        apps = module.flatMap { m in (m as? AppHotkeyProvider).map { (m.id, $0) } }
        if let provider = apps?.provider {
            // Indexed once per panel; results come in while the user types.
            if appSearch == nil { appSearch = provider.makeAppSearch { [weak self] in self?.refilter(keepSelection: true) } }
        } else {
            appSearch = nil
        }
        all = OverviewCatalog.build(modules: reg.modules, isEnabled: reg.isModuleEnabled, actions: reg.allActions,
                                    shortcut: reg.shortcut(for:), problem: reg.failureReason(for:),
                                    icon: { [apps] id in apps?.provider.iconFile(for: id) })
        usesHyper = OverviewCatalog.usesHyper(all)
        ownShortcut = reg.shortcut(for: KeyboardOverview.actionID)
        // No notification exists for permission changes; the panel is short-lived.
        accessibility = Permissions.accessibility
        screenRecording = Permissions.screenRecording
        refilter(keepSelection: true)
    }

    private func refilter(keepSelection: Bool) {
        sections = OverviewCatalog.filter(all, query: query, keeping: pinnedID)
        if let apps, let appSearch {
            sections = OverviewCatalog.adding(appSearch.results(query, limit: Self.appResults), to: sections,
                                              from: all, in: apps.moduleID)
        }
        let ids = items.map(\.id)
        if !keepSelection || !(selectedID.map(ids.contains) ?? false) {
            selectedID = ids.first
            scrollToken &+= 1
        }
    }

    func select(_ id: String) { selectedID = id }

    func move(_ delta: Int) {
        let ids = items.map(\.id)
        guard !ids.isEmpty else { return }
        let i = selectedID.flatMap(ids.firstIndex(of:)) ?? (delta > 0 ? -1 : ids.count)
        selectedID = ids[(i + delta).clamped(0...(ids.count - 1))]
        scrollToken &+= 1
    }

    func moveToEnd(_ end: Bool) {
        selectedID = end ? items.last?.id : items.first?.id
        scrollToken &+= 1
    }

    func run(_ item: OverviewItem) { onRun(item) }

    /// Records the action's new shortcut in its row, stored and conflict-checked
    /// like a recording in Settings. An app found by the search gets its App
    /// Hotkeys entry first.
    func editShortcut(_ item: OverviewItem) {
        var id = item.id
        if let app = item.app {
            guard let provider = apps?.provider else { return }
            id = provider.addApp(app)
            reload()   // with the new entry
        }
        guard editingID != id || !isRecording else { return }
        editingID = id
        pinnedID = id
        refilter(keepSelection: true)
        guard items.contains(where: { $0.id == id }) else {
            editingID = nil
            NSSound.beep()
            return
        }
        selectedID = id
        scrollToken &+= 1
        onRecord(id)
    }

    /// Drops an edit whose recorder hasn't started yet (it starts after a
    /// layout pass). False when there's none, or it's already recording.
    func cancelPendingEdit() -> Bool {
        guard editingID != nil, !isRecording else { return false }
        editingID = nil
        return true
    }

    /// From the row's recorder. Ending (a shortcut typed, Esc, a click
    /// elsewhere) puts the keycaps back and the focus in the search field.
    func recordingChanged(_ id: String, _ recording: Bool) {
        guard editingID == id else { return }
        isRecording = recording
        guard !recording else { return }
        editingID = nil
        onRecordingEnded()
    }

    /// App Hotkeys entries can be removed from here.
    func canRemove(_ item: OverviewItem) -> Bool {
        item.app == nil && sections.contains { $0.id == apps?.moduleID && $0.items.contains { $0.id == item.id } }
    }

    func remove(_ item: OverviewItem) {
        guard canRemove(item) else { return }
        apps?.provider.removeEntry(item.id)   // the registry reloads, and this list with it
    }

    func openSettings(_ page: String? = nil) { onOpenSettings(page) }
}

// MARK: - Views

struct KeyboardOverviewView: View {
    @ObservedObject var model: OverviewModel

    var body: some View {
        VStack(spacing: 0) {
            OverviewHeader(model: model)
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(.secondary)
                OverviewSearchField(model: model)
            }
            .padding(.horizontal, 18)
            .frame(height: 44)
            Divider()
            OverviewList(model: model)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            OverviewFooter(model: model)
        }
        .frame(width: KeyboardOverview.size.width, height: KeyboardOverview.size.height)
        .ignoresSafeArea()
    }
}

struct OverviewHeader: View {
    @ObservedObject var model: OverviewModel

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: "keyboard")
                .font(.system(size: 24, weight: .regular))
                .foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 3) {
                Text("Keyboard Shortcuts")
                    .font(.system(size: 15, weight: .semibold))
                Text(legend)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 4) {
                HStack(spacing: 10) {
                    PermissionBadge(name: "Accessibility", granted: model.accessibility)
                    PermissionBadge(name: "Screen Recording", granted: model.screenRecording)
                }
                if !(model.accessibility && model.screenRecording) {
                    Button("Grant in Settings…") { model.openSettings("general") }
                        .controlSize(.small)
                        .help("Window management and pasting need Accessibility; screenshots need Screen Recording.")
                }
            }
        }
        .padding(.horizontal, 18)
        .padding(.top, 16)
        .padding(.bottom, 10)
    }

    private var legend: String {
        let keys = "⌃ Control   ⌥ Option   ⇧ Shift   ⌘ Command"
        return model.usesHyper ? keys + "   ·   ⌃⌥⇧⌘ together = Hyper" : keys
    }
}

struct PermissionBadge: View {
    let name: String
    let granted: Bool

    var body: some View {
        Label {
            Text(name)
        } icon: {
            Image(systemName: granted ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(granted ? .green : .orange)
        }
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(granted ? .secondary : .primary)
        .help(granted ? "\(name) is granted" : "\(name) is missing")
    }
}

/// AppKit text field so the panel can make it first responder reliably.
struct OverviewSearchField: NSViewRepresentable {
    @ObservedObject var model: OverviewModel

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeNSView(context: Context) -> NSTextField {
        let f = NSTextField()
        f.isBordered = false
        f.drawsBackground = false
        f.focusRingType = .none
        f.font = .systemFont(ofSize: 16)
        f.placeholderString = "Search actions, keys or apps"
        f.cell?.usesSingleLineMode = true
        f.cell?.lineBreakMode = .byTruncatingTail
        f.delegate = context.coordinator
        f.setContentHuggingPriority(.defaultLow, for: .horizontal)
        model.searchField = f
        return f
    }

    func updateNSView(_ f: NSTextField, context: Context) {
        if f.stringValue != model.query { f.stringValue = model.query }
    }

    final class Coordinator: NSObject, NSTextFieldDelegate {
        let model: OverviewModel
        init(model: OverviewModel) { self.model = model }

        func controlTextDidChange(_ note: Notification) {
            guard let f = note.object as? NSTextField else { return }
            model.query = f.stringValue
        }
    }
}

struct OverviewList: View {
    @ObservedObject var model: OverviewModel

    var body: some View {
        if model.sections.isEmpty {
            VStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 28, weight: .light))
                    .foregroundStyle(.tertiary)
                Text("No Matches").font(.system(size: 13, weight: .semibold))
                Text("Nothing matches “\(model.query)”. Try a module like “Windows”, keys like “⌘⇧” or an app.")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollViewReader { proxy in
                ScrollView(.vertical) {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        Color.clear.frame(height: 2).id("top")
                        ForEach(model.sections) { section in
                            OverviewSectionHeader(section: section, first: section.id == model.sections.first?.id) {
                                model.openSettings(OverviewCatalog.settingsPage(for: section.id))
                            }
                            ForEach(section.items) { item in
                                OverviewRow(item: item, selected: item.id == model.selectedID, icons: model.icons,
                                            editing: item.id == model.editingID,
                                            edit: { model.editShortcut(item) },
                                            recordingChanged: { model.recordingChanged(item.id, $0) },
                                            remove: model.canRemove(item) ? { model.remove(item) } : nil)
                                    .id(item.id)
                                    .contentShape(Rectangle())
                                    .onTapGesture(count: 2) {
                                        model.select(item.id)
                                        model.run(item)
                                    }
                                    .simultaneousGesture(TapGesture().onEnded { model.select(item.id) })
                            }
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.bottom, 8)
                }
                .onChange(of: model.scrollToken) { _, _ in
                    guard let id = model.selectedID else { return }
                    if id == model.items.first?.id { proxy.scrollTo("top", anchor: .top) } else { proxy.scrollTo(id) }
                }
            }
        }
    }
}

struct OverviewSectionHeader: View {
    let section: OverviewSection
    let first: Bool
    let openSettings: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Group {
                Image(systemName: section.symbol)
                    .font(.system(size: 11, weight: .semibold))
                    .frame(width: 16)
                Text(section.title)
                    .font(.system(size: 11, weight: .semibold))
                if !section.isEnabled {
                    Text("Off")
                        .font(.system(size: 10, weight: .medium))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(Color.primary.opacity(0.08)))
                }
            }
            .foregroundStyle(.secondary)
            Spacer()
            Button(linkTitle, action: openSettings)
                .buttonStyle(.link)
                .font(.system(size: 11))
                .help(section.isEnabled ? "\(linkTitle) (⇧⌘, for the selected action’s module)" : "Turn \(section.title) on")
        }
        .padding(.horizontal, 8)
        .padding(.top, first ? 6 : 14)
        .padding(.bottom, 4)
    }

    private var linkTitle: String {
        if !section.isEnabled { return "Turn On in Settings" }
        return section.id == AppActionsModule.moduleID ? "All Shortcuts in Settings" : "\(section.title) Settings"
    }
}

struct OverviewRow: View {
    let item: OverviewItem
    let selected: Bool
    let icons: IconCache
    /// Shows a recorder for the new shortcut instead of the keycaps.
    var editing = false
    let edit: () -> Void
    var recordingChanged: (Bool) -> Void = { _ in }
    /// Set for App Hotkeys entries.
    var remove: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: 8) {
            if let icon = item.icon {
                FileIcon(url: icon, side: 20, cache: icons)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(item.title)
                    .font(.system(size: 13))
                    .foregroundStyle(item.shortcut == nil && !selected ? .secondary : .primary)
                    .lineLimit(1)
                if let problem = item.problem {
                    Text(problem)
                        .font(.system(size: 11))
                        .foregroundStyle(.orange)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            if editing {
                ShortcutRecorder(actionID: item.id, placeholder: "No shortcut", onRecordingChange: recordingChanged)
            } else {
                shortcutAndButtons
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .frame(minHeight: 28)
        .background(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(selected ? Color.accentColor.opacity(0.22) : .clear)
        )
    }

    private var shortcutAndButtons: some View {
        Group {
            if selected, let remove {
                Button(action: remove) {
                    Image(systemName: "trash")
                        .font(.system(size: 11, weight: .medium))
                }
                .buttonStyle(.borderless)
                .help("Remove App Hotkey (⌘⌫)")
            }
            if selected {
                Button(action: edit) {
                    Image(systemName: "pencil")
                        .font(.system(size: 11, weight: .medium))
                }
                .buttonStyle(.borderless)
                .help(item.app == nil ? "Change Shortcut (⌘E)" : "Add Shortcut (⌘E)")
            }
            if let shortcut = item.shortcut {
                HStack(spacing: 3) {
                    ForEach(Array(OverviewCatalog.keycaps(shortcut).enumerated()), id: \.offset) { _, key in
                        OverviewKeyCap(key: key)
                    }
                }
                .opacity(item.problem == nil ? 1 : 0.55)
                .help(item.problem ?? shortcut.displayString)
            } else {
                Text("No shortcut")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
            }
        }
    }
}

struct OverviewKeyCap: View {
    let key: String

    var body: some View {
        Text(key)
            .font(.system(size: 11.5, weight: .medium, design: .rounded))
            .frame(minWidth: 20, minHeight: 20)
            .padding(.horizontal, key.count > 1 ? 5 : 0)
            .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(Color.primary.opacity(0.07)))
            .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(Color.primary.opacity(0.12), lineWidth: 0.5))
    }
}

struct OverviewFooter: View {
    @ObservedObject var model: OverviewModel

    var body: some View {
        HStack(spacing: 8) {
            Text(hint)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 6)
            OverviewFooterButton(title: "Run", keys: ["↩"]) { model.selectedItem.map(model.run) }
                .disabled(model.selectedItem == nil)
            OverviewFooterButton(title: model.selectedItem?.app == nil ? "Change Shortcut" : "Add Shortcut", keys: ["⌘", "E"]) { model.selectedItem.map(model.editShortcut) }
                .disabled(model.selectedItem == nil)
            Divider().frame(height: 16)
            OverviewFooterButton(title: "Settings", keys: ["⌘", ","]) { model.openSettings() }
        }
        .padding(.leading, 18)
        .padding(.trailing, 10)
        .frame(height: 44)
    }

    private var hint: String {
        if model.isRecording { return "Type the new shortcut. Esc cancels, ⌫ removes it." }
        guard let sc = model.ownShortcut else { return "Open this list from the Bento menu, or give it a shortcut." }
        var s = "\(sc.displayString) opens this list anywhere"
        // Shortcuts are key positions named after the US layout.
        if let typed = KeyboardLayout.character(for: sc.keyCode), typed.lowercased() != Shortcut.keySymbol(for: sc.keyCode).lowercased() {
            s += " (the “\(typed)” key on your keyboard)"
        }
        return s + "."
    }
}

struct OverviewFooterButton: View {
    let title: String
    let keys: [String]
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(title)
                    .font(.system(size: 12, weight: .medium))
                    .lineLimit(1)
                HStack(spacing: 3) {
                    ForEach(keys, id: \.self) { OverviewKeyCap(key: $0) }
                }
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
            .background(RoundedRectangle(cornerRadius: 6).fill(hover ? Color.primary.opacity(0.07) : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

// MARK: - Keyboard layout

enum KeyboardLayout {
    /// What a key types on the current layout without modifiers, for keys
    /// whose US name (used by shortcuts) differs: e.g. "-" for slash on German.
    static func character(for keyCode: UInt32) -> String? {
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
        let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
        var deadKeys: UInt32 = 0
        var chars = [UniChar](repeating: 0, count: 4)
        var length = 0
        let status = data.withUnsafeBytes { buf -> OSStatus in
            guard let layout = buf.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return OSStatus(paramErr) }
            return UCKeyTranslate(layout, UInt16(keyCode), UInt16(kUCKeyActionDisplay), 0, UInt32(LMGetKbdType()),
                                  OptionBits(kUCKeyTranslateNoDeadKeysBit), &deadKeys, chars.count, &length, &chars)
        }
        guard status == noErr, length > 0 else { return nil }
        let s = String(utf16CodeUnits: chars, count: length).trimmingCharacters(in: .whitespacesAndNewlines.union(.controlCharacters))
        return s.isEmpty ? nil : s
    }
}
