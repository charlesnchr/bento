import AppKit
import SwiftUI
import UniformTypeIdentifiers
import BentoCore

struct ClipboardSettingsView: View {
    let module: ClipboardModule
    @StateObject private var config = ConfigSection("clipboard", default: ClipboardSettings())
    @State private var stats = (count: 0, bytes: 0, pinned: 0)
    @State private var revision = 0

    var body: some View {
        Form {
            historySection
            captureSection
            pasteSection
            ignoredAppsSection
            shortcutsSection
            panelKeysSection
        }
        .formStyle(.grouped)
        .onAppear(perform: refreshStats)
        .onReceive(NotificationCenter.default.publisher(for: ClipStore.didChange)) { _ in refreshStats() }
        .onReceive(NotificationCenter.default.publisher(for: ActionRegistry.didReload)) { _ in revision += 1 }
    }

    // MARK: History

    private var historySection: some View {
        Section {
            Picker("Keep items for", selection: $config.value.retentionDays) {
                ForEach(options([1, 7, 14, 30, 90, 180, 365, 0], current: config.value.retentionDays), id: \.self) { d in
                    Text(d == 0 ? "Forever" : d == 1 ? "1 day" : d == 365 ? "1 year" : "\(d) days").tag(d)
                }
            }
            Picker("Maximum items", selection: $config.value.maxItems) {
                ForEach(options([200, 500, 1000, 2000, 5000, 10000, 0], current: config.value.maxItems), id: \.self) { n in
                    Text(n == 0 ? "Unlimited" : n.formatted()).tag(n)
                }
            }
            Picker("Maximum storage", selection: $config.value.maxStorageMB) {
                ForEach(options([100, 250, 500, 1024, 2048, 5120, 0], current: config.value.maxStorageMB), id: \.self) { mb in
                    Text(mb == 0 ? "Unlimited" : ByteCountFormatter.string(fromByteCount: Int64(mb) * 1024 * 1024, countStyle: .memory)).tag(mb)
                }
            }
            LabeledContent("Current history") {
                Text("\(stats.count.formatted()) item\(stats.count == 1 ? "" : "s")"
                     + (stats.pinned > 0 ? " (\(stats.pinned) pinned)" : "")
                     + " · " + ByteCountFormatter.string(fromByteCount: Int64(stats.bytes), countStyle: .file))
                    .foregroundStyle(.secondary)
            }
            PauseRow(module: module, state: module.state)
        } header: {
            Text("History")
        } footer: {
            Text("Pinned items are never removed automatically. Old items are pruned at launch and once a day.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    // MARK: Capture

    private var captureSection: some View {
        Section {
            Toggle("Text, links and colours", isOn: $config.value.captureText)
            Toggle("Keep formatting (RTF, HTML and app-specific data)", isOn: $config.value.captureRichText)
                .disabled(!config.value.captureText)
            Toggle("Images", isOn: $config.value.captureImages)
            Toggle("Files copied in Finder", isOn: $config.value.captureFiles)
            Toggle("Recognise text in images (searchable)", isOn: $config.value.recognizeTextInImages)
                .disabled(!config.value.captureImages)
            Picker("Skip images larger than", selection: $config.value.maxImageMB) {
                ForEach(options([10, 25, 50, 100, 250], current: config.value.maxImageMB), id: \.self) { Text("\($0) MB").tag($0) }
            }
            .disabled(!config.value.captureImages)
        } header: {
            Text("Capture")
        } footer: {
            Text("Copies that apps mark as concealed or transient (password managers, one-time codes) are never recorded. Text recognition runs on-device at low priority.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    // MARK: Paste

    private var pasteSection: some View {
        Section {
            Picker("Return key", selection: $config.value.returnAction) {
                Text("Pastes into the active app").tag(ClipboardSettings.ReturnAction.paste)
                Text("Copies to the clipboard").tag(ClipboardSettings.ReturnAction.copy)
            }
            Toggle("Paste text without formatting by default", isOn: $config.value.pastePlainTextByDefault)
            AccessibilityRow()
        } header: {
            Text("Paste")
        } footer: {
            Text("⌘↵ does the other action. ⇧↵ pastes as plain text (or with formatting when plain text is the default).")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    // MARK: Ignored apps

    private var ignoredAppsSection: some View {
        Section {
            if config.value.ignoredApps.isEmpty {
                Text("No ignored apps").foregroundStyle(.secondary)
            }
            ForEach(config.value.ignoredApps, id: \.self) { bid in
                HStack(spacing: 8) {
                    Image(nsImage: AppInfo.icon(bid))
                        .resizable()
                        .frame(width: 20, height: 20)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(AppInfo.name(bid) ?? bid)
                        if AppInfo.name(bid) != nil {
                            Text(bid).font(.caption).foregroundStyle(.secondary)
                        } else {
                            Text("Not installed").font(.caption).foregroundStyle(.tertiary)
                        }
                    }
                    Spacer()
                    Button {
                        config.value.ignoredApps.removeAll { $0 == bid }
                    } label: {
                        Image(systemName: "minus.circle.fill").foregroundStyle(.secondary)
                    }
                    .buttonStyle(.borderless)
                    .help("Stop ignoring")
                }
            }
            HStack {
                Menu("Add Running App") {
                    ForEach(runningApps, id: \.bundleIdentifier) { app in
                        Button {
                            add(app.bundleIdentifier)
                        } label: {
                            Label {
                                Text(app.localizedName ?? app.bundleIdentifier ?? "")
                            } icon: {
                                Image(nsImage: AppInfo.small(app.icon))
                            }
                        }
                    }
                }
                .fixedSize()
                Button("Choose App…", action: chooseApp)
                Spacer()
                Button("Restore Defaults") {
                    var list = config.value.ignoredApps
                    for d in ClipboardSettings.defaultIgnoredApps where !list.contains(d) { list.append(d) }
                    config.value.ignoredApps = list
                }
                .disabled(Set(ClipboardSettings.defaultIgnoredApps).isSubset(of: config.value.ignoredApps))
            }
        } header: {
            Text("Ignored Apps")
        } footer: {
            Text("Nothing copied while one of these apps is frontmost is recorded.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private var runningApps: [NSRunningApplication] {
        NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular && $0.bundleIdentifier != nil
                && !config.value.ignoredApps.contains($0.bundleIdentifier!) && $0.processIdentifier != getpid() }
            .sorted { ($0.localizedName ?? "").localizedCaseInsensitiveCompare($1.localizedName ?? "") == .orderedAscending }
    }

    private func add(_ bid: String?) {
        guard let bid, !config.value.ignoredApps.contains(bid) else { return }
        config.value.ignoredApps.append(bid)
    }

    private func chooseApp() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.application]
        panel.directoryURL = URL(fileURLWithPath: "/Applications")
        panel.allowsMultipleSelection = true
        panel.prompt = "Ignore"
        guard panel.runModal() == .OK else { return }
        for url in panel.urls { add(Bundle(url: url)?.bundleIdentifier) }
    }

    // MARK: Shortcuts

    private var shortcutsSection: some View {
        Section("Shortcuts") {
            ForEach(module.actions) { a in
                HStack {
                    Text(a.title)
                    Spacer()
                    ShortcutRecorder(actionID: a.id)
                        .id("\(a.id)-\(revision)")
                }
            }
        }
    }

    private var panelKeysSection: some View {
        Section("In the History Panel") {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 5) {
                keyRow("↑ ↓  ⌃N ⌃P", "Move selection")
                keyRow("↵", config.value.returnAction == .paste ? "Paste into the active app" : "Copy to the clipboard")
                keyRow("⌘↵", config.value.returnAction == .paste ? "Copy to the clipboard" : "Paste into the active app")
                keyRow("⇧↵", config.value.pastePlainTextByDefault ? "Paste with formatting" : "Paste as plain text")
                keyRow("⌘1 … ⌘9", "Paste item 1–9")
                keyRow("⌘⇧P", "Pin / unpin")
                keyRow("⌃X  ⌘⌫", "Delete item (⌘⌫ edits the search while it has text)")
                keyRow("⌘P", "Cycle type filter")
                keyRow("⌘K", "More actions (open, reveal, copy text from image…)")
                keyRow("Esc", "Clear the search, then close")
            }
            .font(.callout)
        }
    }

    private func keyRow(_ keys: String, _ what: String) -> some View {
        GridRow {
            Text(keys).font(.system(.callout, design: .rounded).weight(.medium)).foregroundStyle(.secondary)
            Text(what)
        }
    }

    // MARK: Helpers

    private func options(_ base: [Int], current: Int) -> [Int] {
        base.contains(current) ? base : (base + [current]).sorted { ($0 == 0 ? Int.max : $0) < ($1 == 0 ? Int.max : $1) }
    }

    private func refreshStats() {
        if let s = module.store?.stats() { stats = s }
    }
}

private struct PauseRow: View {
    let module: ClipboardModule
    @ObservedObject var state: ClipboardState

    var body: some View {
        HStack {
            Toggle("Pause monitoring", isOn: Binding(get: { state.paused }, set: { if $0 != state.paused { module.togglePause() } }))
            Spacer()
            Button("Clear History…") { module.confirmClear() }
        }
    }
}

private struct AccessibilityRow: View {
    @State private var trusted = Permissions.accessibility

    var body: some View {
        if !trusted {
            HStack {
                Label("Pasting into other apps needs Accessibility access.", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                Spacer()
                Button("Grant…") {
                    Permissions.requestAccessibility()
                    Permissions.open(.accessibility)
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
                trusted = Permissions.accessibility
            }
        }
    }
}

enum AppInfo {
    static func url(_ bid: String) -> URL? { NSWorkspace.shared.urlForApplication(withBundleIdentifier: bid) }

    static func name(_ bid: String) -> String? {
        guard let url = url(bid) else { return nil }
        return FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "")
    }

    static func icon(_ bid: String) -> NSImage {
        if let url = url(bid) { return NSWorkspace.shared.icon(forFile: url.path) }
        return NSWorkspace.shared.icon(for: .application)
    }

    /// 16-pt copy for menus (menu items show images at their natural size).
    static func small(_ image: NSImage?) -> NSImage {
        let img = (image ?? NSWorkspace.shared.icon(for: .application)).copy() as! NSImage
        img.size = NSSize(width: 16, height: 16)
        return img
    }
}
