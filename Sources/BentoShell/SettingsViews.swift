import AppKit
import SwiftUI
import BentoCore

enum SettingsPage: Hashable {
    case general, shortcuts, module(String)
}

/// Selected settings page, shared so deep links can switch it while open.
final class SettingsNavigator: ObservableObject {
    @Published var page: SettingsPage? = .general
    /// Filter for the Shortcuts page from a "shortcuts/<text>" link (the
    /// keyboard overview's Change Shortcut); the page takes it once. Plain
    /// "shortcuts" clears a filter left from before.
    @Published var shortcutsFilter: String?
    /// Action whose shortcut the Shortcuts page starts recording, from a
    /// "record/<action id>" link (⌘E on an app found in the overview).
    @Published var recordRequest: String?
    /// The filter for a recording request (the action's title).
    var actionTitle: (String) -> String? = { ActionRegistry.shared.action($0)?.title }
    private var recordingRevision = 0

    func select(_ id: String?) {
        cancelRecordingRequest()
        shortcutsFilter = nil
        recordRequest = nil
        switch id {
        case nil, "", "general": page = .general
        case "shortcuts":
            shortcutsFilter = ""
            page = .shortcuts
        case let id? where id.hasPrefix("shortcuts/"):
            shortcutsFilter = String(id.dropFirst("shortcuts/".count))
            page = .shortcuts
        case let id? where id.hasPrefix("record/"):
            let actionID = String(id.dropFirst("record/".count))
            shortcutsFilter = actionTitle(actionID) ?? actionID
            recordRequest = actionID
            page = .shortcuts
        case let id?: page = .module(id)
        }
    }

    func cancelRecordingRequest(_ revision: Int? = nil) {
        if let revision, revision != recordingRevision { return }
        recordingRevision &+= 1
        recordRequest = nil
    }

    /// Keep activation and layout retries tied to this request and window.
    @discardableResult
    func record(_ id: String, in window: NSWindow?, attempts: Int = 50,
                ready: @escaping (NSWindow) -> Bool = { NSApp.isActive && $0.isVisible && $0.isKeyWindow }) -> Int? {
        guard let window else { return nil }
        let revision = recordingRevision
        let current = { [weak self] in
            self?.recordingRevision == revision && self?.page == .shortcuts
        }
        func wait(_ remaining: Int) {
            guard current() else { return }
            if ready(window) {
                RecorderFocus.begin(id, in: window, shouldContinue: { current() && ready(window) })
            } else if remaining > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.04) { wait(remaining - 1) }
            }
        }
        wait(attempts)
        return revision
    }
}

struct SettingsRootView: View {
    let delegate: AppDelegate
    @ObservedObject var navigator: SettingsNavigator
    private var page: Binding<SettingsPage?> { $navigator.page }
    @StateObject private var general = ConfigSection("general", default: GeneralSettings())

    var body: some View {
        NavigationSplitView {
            List(selection: page) {
                Section {
                    Label("General", systemImage: "gearshape").tag(SettingsPage.general)
                    Label("Shortcuts", systemImage: "command").tag(SettingsPage.shortcuts)
                }
                Section("Modules") {
                    ForEach(delegate.modules, id: \.id) { m in
                        Label(m.title, systemImage: m.symbol)
                            .foregroundStyle(isOn(m) ? .primary : .secondary)
                            .tag(SettingsPage.module(m.id))
                    }
                }
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 190, ideal: 200, max: 240)
        } detail: {
            Group {
                switch navigator.page ?? .general {
                case .general:
                    GeneralPane(delegate: delegate, general: general)
                case .shortcuts:
                    // The registry's modules: the feature modules plus app-level actions.
                    ShortcutsPane(modules: ActionRegistry.shared.modules, navigator: navigator) { delegate.settingsWindow }
                case .module(let id):
                    if let m = delegate.modules.first(where: { $0.id == id }) {
                        ModulePane(module: m, enabled: Binding(
                            get: { isOn(m) },
                            set: { delegate.setEnabled(m, $0) }
                        ))
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .themedScrollBackground()
        }
        .background(ThemeBackdrop().ignoresSafeArea())
    }

    private func isOn(_ m: BentoModule) -> Bool { general.value.enabledModules[m.id] ?? m.enabledByDefault }
}

// MARK: - General

struct GeneralPane: View {
    let delegate: AppDelegate
    @ObservedObject var general: ConfigSection<GeneralSettings>
    @State private var launchAtLogin = LaunchAtLogin.isEnabled
    @State private var loginNeedsApproval = LaunchAtLogin.needsApproval

    var body: some View {
        Form {
            Section {
                PermissionsView()
            } header: {
                Text("Permissions")
            } footer: {
                Text("Window management, modifier-drag and pasting need Accessibility. Screenshots need Screen Recording.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Modules") {
                ForEach(delegate.modules, id: \.id) { m in
                    Toggle(isOn: Binding(
                        get: { general.value.enabledModules[m.id] ?? m.enabledByDefault },
                        set: { delegate.setEnabled(m, $0) }
                    )) {
                        Label(m.title, systemImage: m.symbol)
                    }
                    .accessibilityIdentifier("module-toggle:\(m.id)")
                }
            }

            Section("App") {
                Toggle("Launch at login", isOn: Binding(
                    get: { launchAtLogin },
                    set: { on in
                        // Show what the system actually did, not what was asked.
                        launchAtLogin = LaunchAtLogin.set(on)
                        loginNeedsApproval = LaunchAtLogin.needsApproval
                    }
                ))
                .disabled(!LaunchAtLogin.isAvailable)
                .accessibilityIdentifier("launch-at-login")
                if !LaunchAtLogin.isAvailable {
                    Text("Only available in the installed app.")
                        .font(.caption).foregroundStyle(.secondary)
                } else if loginNeedsApproval {
                    Text("Allow Bento in System Settings → General → Login Items.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Toggle("Show menu bar icon", isOn: $general.value.showMenuBarIcon)
                    .accessibilityIdentifier("show-menu-bar-icon")
                if !general.value.showMenuBarIcon {
                    Text("Open settings again by launching Bento from Finder or `open bento://settings`.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }

            AppearanceSection(general: general)

            UpdatesSection(general: general)

            Section {
                LabeledContent("Config file") {
                    HStack {
                        Text(ConfigStore.shared.url.path.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                            .font(.system(.body, design: .monospaced)).textSelection(.enabled)
                        Button("Open") { NSWorkspace.shared.open(ConfigStore.shared.url) }
                        Button("Reveal") { NSWorkspace.shared.activateFileViewerSelecting([ConfigStore.shared.url]) }
                    }
                }
            } footer: {
                Text("Every setting and shortcut lives in this JSON file. Edits are applied as soon as you save.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}

struct AppearanceSection: View {
    @ObservedObject var general: ConfigSection<GeneralSettings>
    @ObservedObject private var themes = ThemeCenter.shared

    var body: some View {
        Section {
            Picker("Theme", selection: $general.value.theme) {
                ForEach(Theme.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("theme")
        } header: {
            Text("Appearance")
        } footer: {
            Group {
                if themes.reduceTransparency, general.value.theme != .standard {
                    Text("Reduce Transparency is on in System Settings → Accessibility → Display, so Bento's windows use the standard look.")
                } else {
                    Text("Glass lets the desktop show through Settings, Keyboard Shortcuts, Clipboard, Todo, Notes, menu bar search and Capture History. Aero adds your accent colour and a gloss.")
                }
            }
            .font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct UpdatesSection: View {
    @ObservedObject var general: ConfigSection<GeneralSettings>
    @ObservedObject private var updater = Updater.shared

    var body: some View {
        Section {
            LabeledContent("Version") {
                Text(updater.versionDescription).textSelection(.enabled)
            }
            Toggle("Check for updates automatically", isOn: $general.value.checkForUpdates)
                .accessibilityIdentifier("check-for-updates")
            HStack {
                status
                Spacer()
                actions
            }
            .disabled(!updater.isAvailable)
        } header: {
            Text("Updates")
        } footer: {
            Group {
                if !updater.isAvailable {
                    Text("Only available in the installed app.")
                } else if updater.isHomebrew {
                    Text("Updates are installed with Homebrew (`brew upgrade \(Updater.formula)`) and keep the permission grants.")
                } else {
                    Text("This copy is a local build. Install it with `brew install \(Updater.formula)` to update from here.")
                }
            }
            .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
        }
        .onAppear { updater.refreshInstalled() }
    }

    @ViewBuilder private var status: some View {
        switch updater.state {
        case .idle:
            if let last = updater.lastChecked {
                Text("Last checked \(last.formatted(.relative(presentation: .named)))").foregroundStyle(.secondary)
            }
        case .checking:
            HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Checking…") }
        case .upToDate:
            Text("Bento is up to date.").foregroundStyle(.secondary)
        case .available(let v):
            Text("Bento \(v) is available.")
        case .installing(let v):
            HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Installing \(v) with Homebrew…") }
        case .restartNeeded(let v):
            Text("Bento \(v) is installed.")
        case .failed(let message):
            Text(message).foregroundStyle(.orange).lineLimit(3).textSelection(.enabled)
        }
    }

    @ViewBuilder private var actions: some View {
        switch updater.state {
        case .available(let v):
            Button("Release Notes") { NSWorkspace.shared.open(Updater.releaseURL(v)) }
            if updater.isHomebrew {
                Button("Install and Restart") { updater.install() }
                    .accessibilityIdentifier("install-update")
            }
        case .restartNeeded:
            Button("Restart") { updater.restart() }
        case .checking, .installing:
            EmptyView()
        case .failed:
            if FileManager.default.fileExists(atPath: updater.logURL.path) {
                Button("Show Log") { NSWorkspace.shared.open(updater.logURL) }
            }
            Button("Check Again") { updater.check(.settings) }
        default:
            Button("Check Now") { updater.check(.settings) }
                .accessibilityIdentifier("check-for-updates-now")
        }
    }
}

struct PermissionsView: View {
    @State private var ax = Permissions.accessibility
    @State private var screen = Permissions.screenRecording

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            row("Accessibility", granted: ax) { Permissions.grant(.accessibility) }
            row("Screen Recording", granted: screen) { Permissions.grant(.screenRecording) }
            if !(ax && screen) {
                HStack(alignment: .firstTextBaseline) {
                    Text("Bento not in the list? Drag it in from Finder, or click + and pick Bento in the Applications folder in your home folder.")
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Button("Show Bento in Finder") {
                        NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])
                    }
                    .controlSize(.small)
                }
            }
        }
        // No notification exists for permission changes: poll, but only while
        // something is missing and this pane is visible.
        .task {
            while !Task.isCancelled, !(ax && screen) {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                refresh()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in refresh() }
    }

    private func refresh() {
        ax = Permissions.accessibility
        screen = Permissions.screenRecording
    }

    private func row(_ name: String, granted: Bool, grant: @escaping () -> Void) -> some View {
        HStack {
            Image(systemName: granted ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                .foregroundStyle(granted ? .green : .orange)
            Text(name)
            Spacer()
            if !granted { Button("Grant…", action: grant) }
            else { Text("Granted").foregroundStyle(.secondary) }
        }
    }
}

// MARK: - Shortcuts

struct ShortcutsPane: View {
    let modules: [BentoModule]
    @ObservedObject var navigator: SettingsNavigator
    /// For a recording request: the window its recorder is in.
    let window: () -> NSWindow?
    @State private var search = ""
    @State private var revision = 0
    @State private var recordingRevision: Int?

    var body: some View {
        Form {
            ForEach(modules, id: \.id) { m in
                let actions = filtered(m.actions)
                if !actions.isEmpty {
                    Section {
                        ForEach(actions) { a in
                            ShortcutRow(action: a, revision: revision)
                        }
                    } header: {
                        Label(m.title, systemImage: m.symbol)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .searchable(text: $search, placement: .toolbar, prompt: "Filter actions")
        .onReceive(NotificationCenter.default.publisher(for: ActionRegistry.didReload)) { _ in revision += 1 }
        .onAppear(perform: takeFilter)
        .onChange(of: navigator.shortcutsFilter) { _, _ in takeFilter() }
        .onDisappear {
            if let recordingRevision { navigator.cancelRecordingRequest(recordingRevision) }
        }
    }

    private func takeFilter() {
        guard let filter = navigator.shortcutsFilter else { return }
        search = filter
        navigator.shortcutsFilter = nil
        if let id = navigator.recordRequest {
            navigator.recordRequest = nil
            recordingRevision = navigator.record(id, in: window())
        }
    }

    private func filtered(_ actions: [BentoAction]) -> [BentoAction] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return actions }
        return actions.filter {
            $0.title.lowercased().contains(q) || $0.id.lowercased().contains(q)
                || ($0.group?.lowercased().contains(q) ?? false)
                || (ActionRegistry.shared.shortcut(for: $0.id).map { $0.displayString.lowercased().contains(q) || $0.configString.contains(q) } ?? false)
        }
    }
}

struct ShortcutRow: View {
    let action: BentoAction
    /// Bumped on registry reloads so the row re-reads its state.
    let revision: Int

    var body: some View {
        let reg = ActionRegistry.shared
        let current = reg.shortcut(for: action.id)
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(action.title)
                if let reason = reg.failureReason(for: action.id) {
                    Text("Shortcut unavailable: \(reason.prefix(1).lowercased() + reason.dropFirst())")
                        .font(.caption).foregroundStyle(.orange)
                }
            }
            Spacer()
            // Launcher-style actions store their own binding: no default to reset to.
            if action.bindingWriter == nil, current != action.defaultShortcut {
                Button {
                    // Like recording it: the default moves here from any action using it now.
                    reg.assign(action.defaultShortcut, to: action.id)
                } label: {
                    Image(systemName: "arrow.uturn.backward")
                }
                .buttonStyle(.borderless)
                .help("Reset to default (\(action.defaultShortcut?.displayString ?? "none"))")
                .accessibilityIdentifier("reset:\(action.id)")
            }
            ShortcutRecorder(actionID: action.id)
        }
    }
}

// MARK: - Module pane

struct ModulePane: View {
    let module: BentoModule
    @Binding var enabled: Bool
    @State private var revision = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: module.symbol).font(.title2).foregroundStyle(.tint)
                Text(module.title).font(.title2.weight(.semibold))
                Spacer()
                Toggle("Enabled", isOn: $enabled).toggleStyle(.switch).labelsHidden()
            }
            .padding(.horizontal, 20)
            .padding(.top, 16)
            .padding(.bottom, 8)
            if let view = module.makeSettingsView() {
                view
                    .disabled(!enabled)
                    .opacity(enabled ? 1 : 0.55)
            } else {
                Form {
                    Section("Shortcuts") {
                        ForEach(module.actions) { ShortcutRow(action: $0, revision: revision) }
                    }
                }
                .formStyle(.grouped)
                .disabled(!enabled)
                .onReceive(NotificationCenter.default.publisher(for: ActionRegistry.didReload)) { _ in revision += 1 }
            }
        }
    }
}
