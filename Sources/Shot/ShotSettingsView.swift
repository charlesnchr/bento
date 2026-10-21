import AppKit
import SwiftUI
import ShotEditor
import BentoCore

struct ShotSettingsView: View {
    let actions: [BentoAction]
    @StateObject private var model = ConfigSection("shot", default: ShotSettings())
    @State private var revision = 0

    private var s: Binding<ShotSettings> { $model.value }

    var body: some View {
        Form {
            Section("After Capture") {
                Picker("After capture", selection: s.afterCapture) {
                    ForEach(ShotSettings.AfterCapture.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                Toggle("Play sound", isOn: s.playSound)
            }

            Section {
                LabeledContent("Folder") {
                    HStack(spacing: 8) {
                        Text(abbreviated(model.value.saveFolder))
                            .lineLimit(1).truncationMode(.middle)
                            .foregroundStyle(.secondary)
                        Button("Choose…", action: chooseFolder)
                    }
                }
                TextField("File name", text: s.filenamePattern)
                Picker("Format", selection: s.format) {
                    ForEach(ShotSettings.ImageFormat.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                if model.value.format == .jpeg {
                    LabeledContent("JPEG quality") {
                        Slider(value: s.jpegQuality, in: 0.5...1, step: 0.05) { EmptyView() }
                            .frame(maxWidth: 200)
                        Text("\(Int(model.value.jpegQuality * 100))%").monospacedDigit().frame(width: 40, alignment: .trailing)
                    }
                }
                Toggle("Save Retina captures at 1x", isOn: s.downscaleRetina)
            } header: {
                Text("Saving")
            } footer: {
                Text("Example: \(example).\(model.value.format.fileExtension) — tokens: {app} {kind} {w} {h}, or a date format like {yyyy-MM-dd}.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Area & Fullscreen") {
                Toggle("Show magnifier", isOn: s.showMagnifier)
                Toggle("Adjust selection before capturing (Return captures)", isOn: s.adjustSelectionBeforeCapture)
                Toggle("Fullscreen captures all displays", isOn: s.fullscreenAllDisplays)
                Toggle("Include the pointer", isOn: s.includeCursor)
            }

            Section("Window Capture") {
                Toggle("Window shadow", isOn: s.windowShadow)
                Picker("Background", selection: s.windowBackground) {
                    ForEach(ShotSettings.WindowBackground.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                if model.value.windowBackground == .solid {
                    ColorPicker("Background colour", selection: colorBinding, supportsOpacity: false)
                }
                Stepper(value: s.windowPadding, in: 0...200, step: 8) {
                    HStack {
                        Text("Padding")
                        Spacer()
                        Text("\(model.value.windowPadding) pt").monospacedDigit().foregroundStyle(.secondary)
                    }
                }
            }

            Section("Delayed Capture") {
                Picker("Delay", selection: s.delaySeconds) {
                    ForEach([3, 5, 10], id: \.self) { Text("\($0) seconds").tag($0) }
                }
                Picker("Then capture", selection: s.delayedTarget) {
                    ForEach(ShotSettings.DelayedTarget.allCases, id: \.self) { Text($0.title).tag($0) }
                }
            }

            Section {
                Picker("Mode", selection: s.scrollMode) {
                    ForEach(ShotSettings.ScrollMode.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                Picker("Speed", selection: s.scrollSpeed) {
                    ForEach(ShotSettings.ScrollSpeed.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                .disabled(model.value.scrollMode == .manual)
                Picker("Maximum height", selection: s.scrollMaxHeight) {
                    ForEach(maxHeights, id: \.self) { Text("\($0.formatted()) px").tag($0) }
                }
                Toggle("Reverse scroll direction", isOn: s.scrollReverse)
            } header: {
                Text("Scrolling Capture")
            } footer: {
                Text("Select the scrollable area, then don't touch anything while it scrolls. Manual mode works with apps that scroll in a non-native way (Terminal, VS Code). Reverse direction helps with Mos, Scroll Reverser and similar tools. Wide regions stop earlier: one capture is limited to about 80 megapixels.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Text & Colour") {
                Toggle("Keep line breaks in recognized text", isOn: s.ocrKeepLineBreaks)
                Picker("Text language", selection: s.ocrLanguage) {
                    Text("Automatic").tag("")
                    ForEach(ocrLanguages, id: \.self) { code in
                        Text(Locale.current.localizedString(forIdentifier: code) ?? code).tag(code)
                    }
                }
                Picker("Colour format", selection: s.colorFormat) {
                    ForEach(ColorFormat.allCases, id: \.self) { Text($0.title).tag($0) }
                }
            }

            Section {
                ForEach(actions) { a in
                    HStack {
                        Text(a.title)
                        Spacer()
                        if ActionRegistry.shared.failed.contains(a.id) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(.orange)
                                .help("This shortcut is used by another app or action")
                        }
                        ShortcutRecorder(actionID: a.id)
                    }
                }
                .id(revision)
            } header: {
                Text("Shortcuts")
            } footer: {
                Text("In the overlay: drag to select (Shift square, Option from centre, Space+drag moves), Space toggles window mode, arrows nudge the pointer (Shift ×10), Return starts/ends a keyboard selection, Tab copies the colour under the pointer (Shift+Tab text colour), hold Option for the ruler, Esc cancels.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            if let editor = ShotEditor.shared.makeSettingsView() {
                Section("Editor") { editor }
            }
        }
        .formStyle(.grouped)
        .onReceive(NotificationCenter.default.publisher(for: ActionRegistry.didReload)) { _ in revision += 1 }
    }

    @State private var ocrLanguages: [String] = {
        let list = OCRText.supportedLanguages
        return list
    }()

    private var maxHeights: [Int] {
        var list = [10_000, 20_000, 50_000, ScrollStitcher.heightLimit]
        if !list.contains(model.value.scrollMaxHeight) { list.append(model.value.scrollMaxHeight); list.sort() }
        return list
    }

    private var example: String {
        CaptureOutput.filename(pattern: model.value.filenamePattern, date: Date(), app: "Safari", kind: "area", size: CGSize(width: 800, height: 600))
    }

    private func abbreviated(_ path: String) -> String {
        (path as NSString).abbreviatingWithTildeInPath
    }

    private var colorBinding: Binding<Color> {
        Binding(
            get: {
                let c = ColorFormat.parseHex(model.value.windowBackgroundColor) ?? RGB8(r: 255, g: 255, b: 255)
                return Color(.sRGB, red: Double(c.r) / 255, green: Double(c.g) / 255, blue: Double(c.b) / 255)
            },
            set: { color in
                guard let ns = NSColor(color).usingColorSpace(.sRGB) else { return }
                let c = RGB8(r: UInt8((ns.redComponent * 255).rounded().clamped(0...255)),
                             g: UInt8((ns.greenComponent * 255).rounded().clamped(0...255)),
                             b: UInt8((ns.blueComponent * 255).rounded().clamped(0...255)))
                model.value.windowBackgroundColor = ColorFormat.hex.string(c)
            }
        )
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = CaptureOutput.folderURL(model.value)
        panel.prompt = "Choose"
        if panel.runModal() == .OK, let url = panel.url {
            model.value.saveFolder = (url.path as NSString).abbreviatingWithTildeInPath
        }
    }
}
