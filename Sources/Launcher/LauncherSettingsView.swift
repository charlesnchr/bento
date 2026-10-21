import AppKit
import SwiftUI
import UniformTypeIdentifiers
import BentoCore

struct LauncherSettingsView: View {
    @StateObject private var model = ConfigSection("launcher", default: LauncherSettings())
    @State private var adding: LauncherEntry.Kind?
    @State private var newTarget = ""
    @State private var revision = 0
    @State private var dropTargeted = false

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
                    ForEach($model.value.entries) { $entry in
                        EntryRow(entry: $entry, revision: revision) {
                            model.value.entries.removeAll { $0.id == entry.id }
                        }
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
                if !target.isEmpty { model.value.entries.append(LauncherEntry(kind: kind, target: target)) }
                adding = nil
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: ActionRegistry.didReload)) { _ in revision += 1 }
    }

    private var addMenu: some View {
        Menu {
            Button("Application…") { chooseApps() }
            Menu("Running App") {
                ForEach(runningApps(), id: \.processIdentifier) { app in
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
    }

    private func runningApps() -> [NSRunningApplication] {
        NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular && $0.bundleURL != nil && $0.processIdentifier != getpid() }
            .sorted { ($0.localizedName ?? "") < ($1.localizedName ?? "") }
    }

    private func add(url: URL) {
        if url.pathExtension == "app" {
            let target = AppResolver.bundleID(for: url) ?? url.path
            guard !model.value.entries.contains(where: { $0.target == target }) else { return }
            model.value.entries.append(LauncherEntry(kind: .app, target: target,
                                                     name: FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "")))
        } else {
            model.value.entries.append(LauncherEntry(kind: .path, target: url.path.replacingOccurrences(of: NSHomeDirectory(), with: "~")))
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
        if panel.runModal() == .OK, let url = panel.url {
            model.value.entries.append(LauncherEntry(kind: .path, target: url.path.replacingOccurrences(of: NSHomeDirectory(), with: "~")))
        }
    }
}

extension LauncherEntry.Kind: Identifiable {
    var id: String { rawValue }
}

private struct EntryRow: View {
    @Binding var entry: LauncherEntry
    let revision: Int
    let onDelete: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(nsImage: icon)
                .resizable()
                .frame(width: 24, height: 24)
            VStack(alignment: .leading, spacing: 1) {
                Text(entry.displayName).lineLimit(1)
                HStack(spacing: 4) {
                    Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    if ActionRegistry.shared.failed.contains(entry.actionID) {
                        Text("· shortcut unavailable").font(.caption).foregroundStyle(.orange)
                    }
                }
            }
            Spacer(minLength: 8)
            if entry.kind == .app {
                Picker("", selection: $entry.behavior) {
                    Text("Toggle").tag(LauncherEntry.Behavior.toggle)
                    Text("Focus").tag(LauncherEntry.Behavior.focus)
                    Text("Cycle Windows").tag(LauncherEntry.Behavior.cycle)
                }
                .labelsHidden()
                .fixedSize()
                .help("When the app is already frontmost: hide it, do nothing, or cycle its windows")
            }
            ShortcutRecorder(shortcut: Binding(
                get: { entry.shortcut.flatMap(Shortcut.init) },
                set: { entry.shortcut = $0?.configString }
            ))
            .id("\(entry.id)-\(revision)")
            Button(role: .destructive, action: onDelete) {
                Image(systemName: "minus.circle")
            }
            .buttonStyle(.borderless)
            .help("Remove")
        }
        .padding(.vertical, 2)
    }

    private var subtitle: String {
        switch entry.kind {
        case .app:
            if let url = AppResolver.url(for: entry.target) {
                return url.path.replacingOccurrences(of: NSHomeDirectory(), with: "~")
            }
            return "Not found: \(entry.target)"
        case .url: return entry.target
        case .path: return entry.target
        case .command: return "$ " + entry.target
        }
    }

    private var icon: NSImage {
        switch entry.kind {
        case .app:
            if let url = AppResolver.url(for: entry.target) { return NSWorkspace.shared.icon(forFile: url.path) }
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

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(kind == .url ? "Add URL" : "Add Shell Command").font(.headline)
            TextField(kind == .url ? "https://…" : "e.g. open -a Terminal ~/code", text: $text)
                .textFieldStyle(.roundedBorder)
                .font(kind == .command ? .system(.body, design: .monospaced) : .body)
                .frame(width: 380)
                .onSubmit { done(text.trimmingCharacters(in: .whitespaces)) }
            HStack {
                Spacer()
                Button("Cancel") { done("") }.keyboardShortcut(.cancelAction)
                Button("Add") { done(text.trimmingCharacters(in: .whitespaces)) }
                    .keyboardShortcut(.defaultAction)
                    .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(20)
    }
}
