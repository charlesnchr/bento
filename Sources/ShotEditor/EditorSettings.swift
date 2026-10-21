import AppKit
import SwiftUI
import BentoCore

/// Editor options, stored under the `editor` section of the config file.
public struct EditorSettings: Codable, Equatable {
    public enum EscAction: String, Codable, CaseIterable {
        case copyAndClose = "copy", close, saveAndClose = "save", copySaveAndClose = "copy+save"
        var title: String {
            switch self {
            case .copyAndClose: return "Copy image and close"
            case .close: return "Close without copying"
            case .saveAndClose: return "Save image and close"
            case .copySaveAndClose: return "Copy, save and close"
            }
        }
    }

    public enum Format: String, Codable, CaseIterable {
        case png, jpeg
        var ext: String { self == .png ? "png" : "jpg" }
        var title: String { self == .png ? "PNG" : "JPEG" }
    }

    /// What Esc does when nothing is being edited (Shottr: "copy on Esc").
    public var escAction: EscAction = .copyAndClose
    public var closeAfterSave = false
    /// Tool selected when the editor opens (`select`, `arrow`, `rect`, ...).
    public var defaultTool = "select"
    public var defaultColor = "#FFDC2C"
    /// Days to keep captures in history; 0 keeps them forever.
    public var historyRetentionDays = 30

    public init() {}

    static let section = "editor"
    static var current: EditorSettings { ConfigStore.shared.section(section, default: EditorSettings()) }
}

/// Where and how ⌘S saves. These options live in the capture module's
/// `shot` section ("Saving" in Capture settings) so after-capture saving and
/// editor saving share one folder / pattern / format. Keys must match.
struct SaveSettings: Codable, Equatable {
    var saveFolder = "~/Desktop"
    /// `{app}` `{kind}` `{w}` `{h}`, anything else in braces is a date format (`{yyyy-MM-dd}`).
    var filenamePattern = "Screenshot {yyyy-MM-dd} at {HH.mm.ss}"
    var format: EditorSettings.Format = .png
    var jpegQuality = 0.9
    var downscaleRetina = false

    static var current: SaveSettings { ConfigStore.shared.section("shot", default: SaveSettings()) }

    var folderURL: URL {
        let path = ((saveFolder.isEmpty ? "~/Desktop" : saveFolder) as NSString).expandingTildeInPath
        return URL(fileURLWithPath: path, isDirectory: true)
    }
}

// MARK: - Settings pane

/// Rows for the "Editor" section of the Capture settings pane (embedded
/// inside a `Section`, so no Form / Section here).
struct EditorSettingsView: View {
    @StateObject private var model = ConfigSection(EditorSettings.section, default: EditorSettings())
    @State private var storage = ""

    var body: some View {
        Group {
            Picker("Esc key", selection: $model.value.escAction) {
                ForEach(EditorSettings.EscAction.allCases, id: \.self) { Text($0.title).tag($0) }
            }
            Picker("Default tool", selection: $model.value.defaultTool) {
                ForEach(EditorTool.allCases, id: \.self) { t in
                    Text("\(t.title) (\(t.keyHint))").tag(t.rawValue)
                }
            }
            ColorPicker("Default colour", selection: Binding(
                get: { Color(nsColor: HexColor.color(model.value.defaultColor)) },
                set: { model.value.defaultColor = HexColor.hex(NSColor($0)) }
            ), supportsOpacity: false)
            Toggle("Close editor after saving (⌘S)", isOn: $model.value.closeAfterSave)
            Picker("Keep capture history", selection: $model.value.historyRetentionDays) {
                Text("1 week").tag(7)
                Text("2 weeks").tag(14)
                Text("30 days").tag(30)
                Text("90 days").tag(90)
                Text("1 year").tag(365)
                Text("Forever").tag(0)
                if ![7, 14, 30, 90, 365, 0].contains(model.value.historyRetentionDays) {
                    Text("\(model.value.historyRetentionDays) days").tag(model.value.historyRetentionDays)
                }
            }
            LabeledContent("History") {
                HStack {
                    Text(storage).foregroundStyle(.secondary)
                    Button("Show…") { ShotEditor.shared.showHistory() }
                    Button("Reveal") { NSWorkspace.shared.activateFileViewerSelecting([HistoryStore.shared.root]) }
                }
            }
            DisclosureGroup("Editor keys") {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(EditorTool.allCases, id: \.self) { t in keyRow(t.title, t.keyHint) }
                    Divider()
                    keyRow("Copy image and close", "Esc")
                    keyRow("Copy (selection) / Save / Save As", "⌘C  ⌘S  ⇧⌘S")
                    keyRow("Pin / Close", "⌘P  ⌘W")
                    keyRow("Recognise text (OCR)", "⇧⌘T")
                    keyRow("Crop to selection / Reset crop", "↩  ⇧⌘R")
                    keyRow("Zoom in / out / fit / 100% / selection", "⌘+  ⌘−  ⌘1  ⌘0  ⌘2")
                    keyRow("Measure the gap under the pointer", "←→  ↑↓")
                    keyRow("Copy colour under pointer (darkest nearby)", "Tab  ⇧Tab")
                    keyRow("Pan", "Space-drag · scroll · right-drag")
                    keyRow("Duplicate / delete annotation", "⌘D ⌥-drag · ⌫")
                    keyRow("Blur / erase the selection", "B · E or ⌫")
                    keyRow("Select object / fit selection to content", "⌘-click · A")
                    keyRow("Zoom on selection corners / click-zoom", "Q W · Z")
                    keyRow("History / open file / open clipboard", "⌘Y  ⇧⌘O  ⇧⌘V")
                }
                .padding(.vertical, 4)
            }
        }
        .onAppear { storage = HistoryStore.shared.sizeDescription() }
    }

    private func keyRow(_ title: String, _ keys: String) -> some View {
        HStack {
            Text(title)
            Spacer()
            Text(keys).font(.body.monospaced()).foregroundStyle(.secondary)
        }
    }
}
