import AppKit
import SwiftUI
import UniformTypeIdentifiers
import BentoCore

struct LauncherSettingsView: View {
    @StateObject private var model = ConfigSection("launcher", default: LauncherSettings())
    @State private var adding: LauncherEntry.Kind?
    @State private var revision = 0
    @State private var dropTargeted = false
    @State private var runningApps: [NSRunningApplication] = []

    var body: some View {
        Form {
            Section {
                if model.value.entries.isEmpty {
                    VStack(spacing: 6) {
                        Image(systemName: "keyboard.badge.ellipsis").font(.largeTitle).foregroundStyle(.secondary)
                        Text("No app hotkeys yet").font(.headline)
                        Text("Add an app, then record a shortcut. Pressing it opens the app; pressing it again hides it.")
                            .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                } else {
                    // Rows get values plus id-based updates (not array bindings),
                    // so an entry removed meanwhile (e.g. by editing the file)
                    // can never be written through a stale index.
                    ForEach(model.value.entries) { entry in
                        EntryRow(entry: entry, revision: revision,
                                 update: { change in update(entry.id, change) },
                                 onDelete: { model.value.entries.removeAll { $0.id == entry.id } })
                    }
                    .onMove { model.value.entries.move(fromOffsets: $0, toOffset: $1) }
                }
            } header: {
                HStack {
                    Text("Hotkeys")
                    Spacer()
                    addMenu
                }
            } footer: {
                Text("Drop apps from Finder here. Entries are stored in the `launcher` section of the config file; `target` can be an app name, bundle id or path.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .onDrop(of: [.fileURL], isTargeted: $dropTargeted) { providers in
            for p in providers {
                _ = p.loadObject(ofClass: URL.self) { url, _ in
                    guard let url else { return }
                    DispatchQueue.main.async { add(url: url) }
                }
            }
            return true
        }
        .overlay {
            if dropTargeted {
                RoundedRectangle(cornerRadius: 10).stroke(Color.accentColor, lineWidth: 2).padding(8)
            }
        }
        .sheet(item: $adding) { kind in
            AddOtherSheet(kind: kind) { target in
                if !target.isEmpty { append(LauncherEntry(kind: kind, target: target)) }
                adding = nil
            }
        }
        .onAppear(perform: refreshRunningApps)
        .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didLaunchApplicationNotification)) { _ in refreshRunningApps() }
        .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didTerminateApplicationNotification)) { _ in refreshRunningApps() }
        .onReceive(NotificationCenter.default.publisher(for: ActionRegistry.didReload)) { _ in revision += 1 }
    }

    private var addMenu: some View {
        Menu {
            Button("Application…") { chooseApps() }
            Menu("Running App") {
                ForEach(runningApps, id: \.processIdentifier) { app in
                    Button {
                        if let url = app.bundleURL { add(url: url) }
                    } label: {
                        Text(app.localizedName ?? app.bundleIdentifier ?? "App")
                    }
                }
            }
            Divider()
            Button("URL…") { adding = .url }
            Button("File or Folder…") { chooseFile() }
            Button("Shell Command…") { adding = .command }
        } label: {
            Label("Add", systemImage: "plus")
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .accessibilityIdentifier("launcher.add")
    }

    private func refreshRunningApps() {
        runningApps = NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular && $0.bundleURL != nil && $0.processIdentifier != getpid() }
            .sorted { ($0.localizedName ?? "").localizedCaseInsensitiveCompare($1.localizedName ?? "") == .orderedAscending }
    }

    private func update(_ id: String, _ change: (inout LauncherEntry) -> Void) {
        guard let i = model.value.entries.firstIndex(where: { $0.id == id }) else { return }
        change(&model.value.entries[i])
    }

    private func append(_ entry: LauncherEntry) {
        model.value.entries = LauncherSettings.uniquingKeys(model.value.entries + [entry])
    }

    private func add(url: URL) {
        if url.pathExtension.lowercased() == "app" {
            let target = AppResolver.bundleID(for: url) ?? url.path
            let resolved = url.standardizedFileURL
            if let existing = model.value.entries.first(where: {
                $0.kind == .app && ($0.target == target || AppResolver.url(for: $0.target)?.standardizedFileURL == resolved)
            }) {
                HUD.show("\(existing.displayName) is already in the list", symbol: "info.circle")
                return
            }
            append(LauncherEntry(kind: .app, target: target,
                                 name: FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "")))
        } else {
            let target = url.path.replacingOccurrences(of: NSHomeDirectory(), with: "~")
            if model.value.entries.contains(where: { $0.kind == .path && $0.target == target }) {
                HUD.show("\(url.lastPathComponent) is already in the list", symbol: "info.circle")
                return
            }
            append(LauncherEntry(kind: .path, target: target))
        }
    }

    private func chooseApps() {
        let panel = NSOpenPanel()
        panel.directoryURL = URL(fileURLWithPath: "/Applications")
        panel.allowedContentTypes = [.application]
        panel.allowsMultipleSelection = true
        panel.prompt = "Add"
        if panel.runModal() == .OK { panel.urls.forEach(add) }
    }

    private func chooseFile() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        panel.prompt = "Add"
        if panel.runModal() == .OK, let url = panel.url { add(url: url) }
    }
}

extension LauncherEntry.Kind: Identifiable {
    var id: String { rawValue }
}

private struct EntryRow: View {
    let entry: LauncherEntry
    let revision: Int
    let update: ((inout LauncherEntry) -> Void) -> Void
    let onDelete: () -> Void

    var body: some View {
        let appURL = entry.kind == .app ? AppResolver.url(for: entry.target) : nil
        HStack(spacing: 10) {
            Image(nsImage: icon(appURL))
                .resizable()
                .frame(width: 24, height: 24)
            VStack(alignment: .leading, spacing: 1) {
                Text(entry.displayName).lineLimit(1)
                HStack(spacing: 4) {
                    Text(subtitle(appURL)).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    if ActionRegistry.shared.failed.contains(entry.actionID) {
                        Text("· shortcut unavailable").font(.caption).foregroundStyle(.orange)
                    }
                }
            }
            Spacer(minLength: 8)
            if entry.kind == .app {
                Picker("", selection: Binding(get: { entry.behavior }, set: { b in update { $0.behavior = b } })) {
                    Text("Toggle").tag(LauncherEntry.Behavior.toggle)
                    Text("Focus").tag(LauncherEntry.Behavior.focus)
                    Text("Cycle Windows").tag(LauncherEntry.Behavior.cycle)
                }
                .labelsHidden()
                .fixedSize()
                .help("When the app is already frontmost: hide it, do nothing, or cycle its windows")
            }
            // Through the registry: a combination another action uses moves
            // here (with a HUD), and the row shows when it's taken by another app.
            ShortcutRecorder(actionID: entry.actionID)
            Button(role: .destructive, action: onDelete) {
                Image(systemName: "minus.circle")
            }
            .buttonStyle(.borderless)
            .help("Remove")
            .accessibilityIdentifier("remove:\(entry.actionID)")
        }
        .padding(.vertical, 2)
    }

    private func subtitle(_ appURL: URL?) -> String {
        switch entry.kind {
        case .app:
            if let appURL { return appURL.path.replacingOccurrences(of: NSHomeDirectory(), with: "~") }
            return "Not found: \(entry.target)"
        case .url: return entry.target
        case .path:
            let exists = FileManager.default.fileExists(atPath: (entry.target as NSString).expandingTildeInPath)
            return exists ? entry.target : "Not found: \(entry.target)"
        case .command: return "$ " + entry.target
        }
    }

    private func icon(_ appURL: URL?) -> NSImage {
        switch entry.kind {
        case .app:
            if let appURL { return NSWorkspace.shared.icon(forFile: appURL.path) }
            return NSImage(systemSymbolName: "questionmark.app", accessibilityDescription: nil) ?? NSImage()
        case .path:
            return NSWorkspace.shared.icon(forFile: (entry.target as NSString).expandingTildeInPath)
        case .url:
            return NSImage(systemSymbolName: "link", accessibilityDescription: nil) ?? NSImage()
        case .command:
            return NSImage(systemSymbolName: "terminal", accessibilityDescription: nil) ?? NSImage()
        }
    }
}

private struct AddOtherSheet: View {
    let kind: LauncherEntry.Kind
    let done: (String) -> Void
    @State private var text = ""

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(kind == .url ? "Add URL" : "Add Shell Command").font(.headline)
            TextField(kind == .url ? "https://…" : "e.g. open -a Terminal ~/code", text: $text)
                .textFieldStyle(.roundedBorder)
                .font(kind == .command ? .system(.body, design: .monospaced) : .body)
                .frame(width: 380)
                .onSubmit { if isValid { done(trimmed) } }
            if kind == .url, !trimmed.isEmpty, !isValid {
                Text("Not a valid URL").font(.caption).foregroundStyle(.orange)
            }
            HStack {
                Spacer()
                Button("Cancel") { done("") }.keyboardShortcut(.cancelAction)
                Button("Add") { done(trimmed) }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!isValid)
            }
        }
        .padding(20)
    }

    private var isValid: Bool {
        guard !trimmed.isEmpty else { return false }
        return kind != .url || Launcher.url(from: trimmed) != nil
    }
}
