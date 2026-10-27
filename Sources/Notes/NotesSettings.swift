import SwiftUI
import BentoCore

/// `notes` section of config.json. Defaults follow Raycast (and the user's Raycast prefs).
struct NotesSettings: Codable, Equatable {
    /// Keep the notes window above other windows.
    var floatOnTop = true
    /// "system", "rounded", "serif", "mono" or an installed font name.
    var fontFamily = "system"
    /// "small", "medium", "large", "xLarge", "xxLarge" (⌘= / ⌘- step through these).
    var textSize = "medium"
    /// "raycast" (red), "system" (macOS accent colour) or "#RRGGBB".
    var accentColor = "raycast"
    /// Format bar at the bottom of the window (⌥⌘,).
    var showFormatBar = false
    /// Footer counter: "words" or "characters" (click the footer to switch).
    var statusText = "words"
    /// Window height follows the note's content.
    var autoResize = false
    /// Escape: "close" hides the window, "unfocus" returns focus to the previous app.
    var escapeKey = "close"
    /// Exclude the window from screen sharing and recordings.
    var hideWhileScreenSharing = false
    /// Ask before deleting a note.
    var confirmDelete = true
    /// Extra menu bar button that toggles the notes window (⌥-click: new note).
    var showMenuBarButton = false
    /// Note that Dictation's Capture Thought to Note appends to ("": a new "Thoughts" note,
    /// created on the first capture).
    var captureNoteID = ""
    var sync = SyncSettings()

    var theme: NotesTheme {
        var t = NotesTheme()
        t.size = NotesTheme.TextSize(rawValue: textSize) ?? .medium
        t.family = fontFamily
        t.accent = NotesSettings.color(accentColor)
        return t
    }

    static func color(_ s: String) -> NSColor {
        switch s.lowercased() {
        case "system": return .controlAccentColor
        case "raycast", "": return NotesTheme.raycastRed
        default:
            var hex = s.trimmingCharacters(in: .whitespaces)
            if hex.hasPrefix("#") { hex.removeFirst() }
            guard hex.count == 6, let v = UInt32(hex, radix: 16) else { return NotesTheme.raycastRed }
            return NSColor(srgbRed: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: 1)
        }
    }
}

struct NotesSettingsView: View {
    @StateObject private var model = ConfigSection("notes", default: NotesSettings())
    @ObservedObject var status: SyncStatus
    let actions: [BentoAction]
    let store: NoteStore
    @State private var notes: [NoteChoice] = []
    let syncNow: () -> Void

    struct NoteChoice: Identifiable {
        let id: String
        let title: String
    }
    @State private var now = Date()

    var body: some View {
        Form {
            Section("Window") {
                Toggle("Float on top of other windows", isOn: $model.value.floatOnTop)
                Toggle("Auto-size window height to the note", isOn: $model.value.autoResize)
                Toggle("Hide while screen sharing", isOn: $model.value.hideWhileScreenSharing)
                Picker("Escape key", selection: $model.value.escapeKey) {
                    Text("Closes the window").tag("close")
                    Text("Returns focus to the previous app").tag("unfocus")
                }
                Toggle("Show notes button in the menu bar", isOn: $model.value.showMenuBarButton)
            }

            Section("Editor") {
                Picker("Font", selection: $model.value.fontFamily) {
                    Text("System").tag("system")
                    Text("Rounded").tag("rounded")
                    Text("Serif").tag("serif")
                    Text("Monospaced").tag("mono")
                    if !["system", "rounded", "serif", "mono"].contains(model.value.fontFamily) {
                        Text(model.value.fontFamily).tag(model.value.fontFamily)
                    }
                }
                Picker("Text size", selection: $model.value.textSize) {
                    ForEach(NotesTheme.TextSize.allCases, id: \.rawValue) { Text($0.title).tag($0.rawValue) }
                }
                Picker("Accent colour", selection: $model.value.accentColor) {
                    Text("Raycast red").tag("raycast")
                    Text("System accent").tag("system")
                    if !["raycast", "system"].contains(model.value.accentColor) {
                        Text(model.value.accentColor).tag(model.value.accentColor)
                    }
                }
                Toggle("Show format bar", isOn: $model.value.showFormatBar)
                Picker("Footer shows", selection: $model.value.statusText) {
                    Text("Word count").tag("words")
                    Text("Character count").tag("characters")
                }
                Toggle("Confirm before deleting a note", isOn: $model.value.confirmDelete)
            }

            Section {
                Picker("Capture note", selection: $model.value.captureNoteID) {
                    Text("New “Thoughts” note").tag("")
                    ForEach(notes) { Text($0.title).tag($0.id) }
                    if !model.value.captureNoteID.isEmpty, !notes.contains(where: { $0.id == model.value.captureNoteID }) {
                        Text("Deleted note").tag(model.value.captureNoteID)
                    }
                }
            } header: {
                Text("Thought capture")
            } footer: {
                Text("Dictation's Capture Thought to Note shortcut appends what you say to this note as a collapsed entry headed by the date, time and first words. ⌘↩ or the chevron opens an entry.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section {
                Toggle("Sync notes", isOn: $model.value.sync.enabled)
                TextField("Server", text: $model.value.sync.server, prompt: Text("https://sync.example.com"))
                    .textFieldStyle(.roundedBorder)
                TextField("Token file", text: $model.value.sync.tokenFile)
                    .textFieldStyle(.roundedBorder)
                LabeledContent("Status") {
                    HStack(spacing: 8) {
                        Image(systemName: status.symbol)
                            .foregroundStyle(status.isHealthy ? Color.secondary : Color.orange)
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(status.summary)
                            if let last = status.lastSync {
                                Text("Last sync \(last.formatted(.relative(presentation: .named)))")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            if let err = status.lastError, !status.isHealthy {
                                Text(err).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            }
                        }
                        Button("Sync Now", action: syncNow)
                            .disabled(!model.value.sync.enabled)
                    }
                }
                LabeledContent("Android phone") { PairPhoneButton() }
            } header: {
                Text("Sync")
            } footer: {
                Text("Notes sync in real time through the Bento sync server, and so do dictation's dictionary and instructions. The token file holds only the bearer token (mode 600).")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section {
                ForEach(actions) { a in
                    HStack {
                        Text(a.title)
                        Spacer()
                        ShortcutRecorder(actionID: a.id)
                    }
                }
            } header: {
                Text("Shortcuts")
            }

            Section {
                ForEach(NotesCommand.allCases.filter { $0.shortcut != nil && $0 != .close }, id: \.rawValue) { c in
                    HStack {
                        Label(c.title, systemImage: c.symbol)
                        Spacer()
                        Text(c.shortcut!.displayString).foregroundStyle(.secondary).monospaced()
                    }
                }
            } header: {
                Text("In the notes window")
            } footer: {
                Text("These follow Raycast Notes. ⌘1–⌘9 open pinned notes. Markdown shortcuts like # , - , [] , 1. , > and ``` format as you type.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .onAppear { refreshNotes() }
        .onReceive(NotificationCenter.default.publisher(for: NoteStore.didChange, object: store).receive(on: RunLoop.main)) { _ in refreshNotes() }
    }

    private func refreshNotes() {
        notes = store.liveNotes.map { NoteChoice(id: $0.id, title: NoteText.displayTitle(of: $0.body)) }
    }
}
