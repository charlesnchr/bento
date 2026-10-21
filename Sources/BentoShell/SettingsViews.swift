import AppKit
import SwiftUI
import BentoCore

enum SettingsPage: Hashable {
    case general, shortcuts, module(String)
}

/// Selected settings page, shared so deep links can switch it while open.
final class SettingsNavigator: ObservableObject {
    @Published var page: SettingsPage? = .general

    func select(_ id: String?) {
        switch id {
        case nil, "", "general": page = .general
        case "shortcuts": page = .shortcuts
        case let id?: page = .module(id)
        }
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
                    ShortcutsPane(modules: delegate.modules)
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
        }
    }

    private func isOn(_ m: BentoModule) -> Bool { general.value.enabledModules[m.id] ?? m.enabledByDefault }
}

// MARK: - General

struct GeneralPane: View {
    let delegate: AppDelegate
    @ObservedObject var general: ConfigSection<GeneralSettings>
    @State private var launchAtLogin = LaunchAtLogin.isEnabled

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
                }
            }

            Section("App") {
                Toggle("Launch at login", isOn: $launchAtLogin)
                    .onChange(of: launchAtLogin) { _, on in LaunchAtLogin.set(on) }
                Toggle("Show menu bar icon", isOn: $general.value.showMenuBarIcon)
                if !general.value.showMenuBarIcon {
                    Text("Open settings again by launching Bento from Finder or `open bento://settings`.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }

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

struct PermissionsView: View {
    @State private var ax = Permissions.accessibility
    @State private var screen = Permissions.screenRecording
    private let timer = Timer.publish(every: 1.5, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            row("Accessibility", granted: ax) {
                Permissions.requestAccessibility()
                Permissions.open(.accessibility)
            }
            row("Screen Recording", granted: screen) {
                Permissions.requestScreenRecording()
                Permissions.open(.screenRecording)
            }
        }
        .onReceive(timer) { _ in
            ax = Permissions.accessibility
            screen = Permissions.screenRecording
        }
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
    @State private var search = ""
    @State private var revision = 0

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
    }

    private func filtered(_ actions: [BentoAction]) -> [BentoAction] {
        guard !search.isEmpty else { return actions }
        let q = search.lowercased()
        return actions.filter {
            $0.title.lowercased().contains(q) || $0.id.contains(q)
                || (ActionRegistry.shared.shortcut(for: $0.id)?.displayString.lowercased().contains(q) ?? false)
        }
    }
}

struct ShortcutRow: View {
    let action: BentoAction
    let revision: Int

    var body: some View {
        let reg = ActionRegistry.shared
        let current = reg.shortcut(for: action.id)
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(action.title)
                if reg.failed.contains(action.id) {
                    Text("Shortcut unavailable (used by another app or action)")
                        .font(.caption).foregroundStyle(.orange)
                }
            }
            Spacer()
            if current != action.defaultShortcut {
                Button {
                    reg.setShortcut(action.defaultShortcut, for: action.id)
                } label: {
                    Image(systemName: "arrow.uturn.backward")
                }
                .buttonStyle(.borderless)
                .help("Reset to default (\(action.defaultShortcut?.displayString ?? "none"))")
            }
            ShortcutRecorder(actionID: action.id)
                .id("\(action.id)-\(revision)")
        }
    }
}

// MARK: - Module pane

struct ModulePane: View {
    let module: BentoModule
    @Binding var enabled: Bool

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
                        ForEach(module.actions) { ShortcutRow(action: $0, revision: 0) }
                    }
                }
                .formStyle(.grouped)
            }
        }
    }
}
