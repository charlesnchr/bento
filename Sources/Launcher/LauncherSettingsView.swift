import AppKit
import SwiftUI
import UniformTypeIdentifiers
import BentoCore

struct LauncherSettingsView: View {
    @StateObject private var model = ConfigSection("launcher", default: LauncherSettings())
    /// Held, not observed: only the picker section re-renders as you type.
    @State private var picker = AppPickerModel()
    @State private var adding: LauncherEntry.Kind?
    @State private var revision = 0
    @State private var dropTargeted = false
    @State private var focusSearchRequest = 0
    /// Row briefly highlighted after it was added or picked again.
    @State private var flashed: String?
    /// Entry added from the sheet; its recorder starts once the sheet is gone.
    @State private var pendingFocus: String?
    @State private var searchAnchor = ViewAnchor()
    @State private var watcher = RecordingWatcher()

    var body: some View {
        ScrollViewReader { proxy in
            Form {
                AppPickerSection(model: picker, bound: BoundApps(model.value.entries), revision: revision,
                                 focusRequest: focusSearchRequest, anchor: searchAnchor,
                                 accessory: AnyView(addMenu(proxy).background {
                                     // ⌘F: back to the search field from anywhere in the pane.
                                     Button("Search Apps") { focusSearchRequest += 1 }
                                         .keyboardShortcut("f", modifiers: .command)
                                         .opacity(0).frame(width: 0, height: 0).accessibilityHidden(true)
                                 })) { app, fromKeyboard in
                    pick(app, proxy: proxy, fromKeyboard: fromKeyboard)
                }

                Section {
                    if model.value.entries.isEmpty {
                        VStack(spacing: 6) {
                            Image(systemName: "keyboard.badge.ellipsis").font(.largeTitle).foregroundStyle(.secondary)
                            Text("No app hotkeys yet").font(.headline)
                            Text("Pick an app above, then type a shortcut. Pressing it opens the app; pressing it again hides it.")
                                .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                    } else {
                        // Rows get values plus id-based updates (not array bindings),
                        // so an entry removed meanwhile (e.g. by editing the file)
                        // can never be written through a stale index.
                        ForEach(model.value.entries) { entry in
                            EntryRow(entry: entry, revision: revision, highlighted: flashed == entry.id,
                                     update: { change in update(entry.id, change) },
                                     onDelete: { model.value.entries.removeAll { $0.id == entry.id } })
                                .id(entry.id)
                        }
                        .onMove { model.value.entries.move(fromOffsets: $0, toOffset: $1) }
                    }
                } header: {
                    Text("Hotkeys")
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
                        DispatchQueue.main.async { _ = add(url: url) }
                    }
                }
                return true
            }
            .overlay {
                if dropTargeted {
                    RoundedRectangle(cornerRadius: 10).stroke(Color.accentColor, lineWidth: 2).padding(8)
                }
            }
            .sheet(item: $adding, onDismiss: {
                if let id = pendingFocus, let entry = model.value.entries.first(where: { $0.id == id }) {
                    focus(entry, proxy: proxy, returnToSearch: false)
                }
                pendingFocus = nil
            }) { kind in
                AddOtherSheet(kind: kind) { target in
                    if !target.isEmpty { pendingFocus = append(LauncherEntry(kind: kind, target: target)).id }
                    adding = nil
                }
            }
        }
        // Only while the pane is on screen: no observers, index or icons otherwise.
        .onAppear { picker.appear() }
        .onDisappear {
            picker.disappear()
            watcher.cancel()
        }
        .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didLaunchApplicationNotification)) { _ in picker.refreshRunning() }
        .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didTerminateApplicationNotification)) { _ in picker.refreshRunning() }
        .onReceive(NotificationCenter.default.publisher(for: ActionRegistry.didReload)) { _ in revision += 1 }
    }

    private func addMenu(_ proxy: ScrollViewProxy) -> some View {
        Menu {
            Button("Application…") { chooseApps(proxy) }
            Button("File or Folder…") { chooseFile() }
            Divider()
            Button("URL…") { adding = .url }
            Button("Shell Command…") { adding = .command }
        } label: {
            Label("Add Other", systemImage: "plus")
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("Add an app from anywhere on disk, a file or folder, a URL or a shell command")
        .accessibilityIdentifier("launcher.add")
    }

    /// Adds the app (or finds its entry) and starts recording its shortcut.
    private func pick(_ app: AppCandidate, proxy: ScrollViewProxy, fromKeyboard: Bool) {
        let entry = BoundApps(model.value.entries).entry(for: app)
            ?? append(appEntry(url: app.url, name: app.name, bundleID: app.bundleID))
        focus(entry, proxy: proxy, returnToSearch: fromKeyboard)
    }

    /// Shows the entry's row and records into it. From the keyboard, focus
    /// goes back to the search field once the shortcut is typed (or Esc).
    private func focus(_ entry: LauncherEntry, proxy: ScrollViewProxy, returnToSearch: Bool) {
        watcher.cancel()
        withAnimation(.easeOut(duration: 0.2)) {
            flashed = entry.id
            proxy.scrollTo(entry.id)
        }
        let id = entry.id
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
            if flashed == id { withAnimation(.easeOut(duration: 0.4)) { flashed = nil } }
        }
        let window = searchAnchor.view?.window
        RecorderFocus.begin(entry.actionID, in: window) { recorder in
            guard returnToSearch else { return }
            watcher.watch(recorder) {
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(AppPickerSection.scrollID) }
                focusSearchRequest += 1
            }
        }
    }

    private func update(_ id: String, _ change: (inout LauncherEntry) -> Void) {
        guard let i = model.value.entries.firstIndex(where: { $0.id == id }) else { return }
        change(&model.value.entries[i])
    }

    /// Appends and returns the entry as stored (its key made unique).
    @discardableResult
    private func append(_ entry: LauncherEntry) -> LauncherEntry {
        let entries = LauncherSettings.uniquingKeys(model.value.entries + [entry])
        model.value.entries = entries
        return entries[entries.count - 1]
    }

    private func appEntry(url: URL, name: String? = nil, bundleID: String? = nil) -> LauncherEntry {
        let display = name ?? FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "")
        return LauncherEntry(kind: .app, target: bundleID ?? AppResolver.bundleID(for: url) ?? url.path, name: display)
    }

    /// Adds an app, file or folder; returns the new entry (nil if it was already listed).
    private func add(url: URL) -> LauncherEntry? {
        if url.pathExtension.lowercased() == "app" {
            let candidate = AppCandidate(url: url, name: FileManager.default.displayName(atPath: url.path),
                                         bundleID: AppResolver.bundleID(for: url))
            if let existing = BoundApps(model.value.entries).entry(for: candidate) {
                HUD.show("\(existing.displayName) is already in the list", symbol: "info.circle")
                return nil
            }
            return append(appEntry(url: url, bundleID: candidate.bundleID))
        } else {
            let target = url.path.replacingOccurrences(of: NSHomeDirectory(), with: "~")
            if model.value.entries.contains(where: { $0.kind == .path && $0.target == target }) {
                HUD.show("\(url.lastPathComponent) is already in the list", symbol: "info.circle")
                return nil
            }
            return append(LauncherEntry(kind: .path, target: target))
        }
    }

    private func chooseApps(_ proxy: ScrollViewProxy) {
        let panel = NSOpenPanel()
        panel.directoryURL = URL(fileURLWithPath: "/Applications")
        panel.allowedContentTypes = [.application]
        panel.allowsMultipleSelection = true
        panel.prompt = "Add"
        guard panel.runModal() == .OK else { return }
        let added = panel.urls.compactMap(add)
        if added.count == 1 { focus(added[0], proxy: proxy, returnToSearch: false) }
    }

    private func chooseFile() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        panel.prompt = "Add"
        if panel.runModal() == .OK, let url = panel.url { _ = add(url: url) }
    }
}

extension LauncherEntry.Kind: Identifiable {
    var id: String { rawValue }
}

private struct EntryRow: View {
    let entry: LauncherEntry
    let revision: Int
    /// Just added or picked again in the grid.
    let highlighted: Bool
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
        .background {
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(Color.accentColor.opacity(highlighted ? 0.12 : 0))
                .padding(.horizontal, -6)
        }
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
