import AppKit
import SwiftUI
import BentoCore

struct TilingSettingsView: View {
    let actions: [BentoAction]
    @StateObject private var model = ConfigSection("tiling", default: TilingSettings())

    var body: some View {
        Form {
            Section {
                Toggle(isOn: $model.value.managerOn) {
                    Text("Tile windows automatically")
                    Text("Keeps the windows of each display tiled. Turning it off leaves windows where they are.")
                }
                if !Permissions.accessibility {
                    HStack {
                        Label("Accessibility permission is required.", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                        Spacer()
                        Button("Grant…") { Permissions.requestAccessibility() }
                    }
                }
            }

            Section("Layout") {
                Picker("Default layout", selection: $model.value.defaultLayout) {
                    ForEach(LayoutKind.allCases) { kind in
                        Label(kind.title, systemImage: kind.symbol).tag(kind)
                    }
                }
                Picker("New windows", selection: $model.value.newWindowPlacement) {
                    ForEach(Placement.allCases) { Text($0.title).tag($0) }
                }
                LabeledContent("Master width") {
                    HStack {
                        Slider(value: $model.value.masterRatio, in: 0.2...0.8, step: 0.05)
                            .frame(maxWidth: 220)
                        Text(model.value.masterRatio, format: .percent.precision(.fractionLength(0)))
                            .monospacedDigit()
                            .frame(width: 44, alignment: .trailing)
                    }
                }
                LabeledContent("Resize step") {
                    HStack {
                        Slider(value: $model.value.resizeStep, in: 0.02...0.2, step: 0.01)
                            .frame(maxWidth: 220)
                        Text(model.value.resizeStep, format: .percent.precision(.fractionLength(0)))
                            .monospacedDigit()
                            .frame(width: 44, alignment: .trailing)
                    }
                }
                Toggle(isOn: $model.value.mouseSupport) {
                    Text("Mouse support")
                    Text("Drop a window onto another to swap them; resizing a window adjusts its split.")
                }
            }

            Section("Gaps") {
                gapRow("Between windows", value: $model.value.innerGap)
                gapRow("Screen edges", value: $model.value.outerGap)
            }

            Section {
                BundleListEditor(ids: $model.value.floatingApps)
            } header: {
                Text("Always Float")
            } footer: {
                Text("Dialogs, sheets and fixed-size windows always float. Toggle Float changes a single window.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section {
                BundleListEditor(ids: $model.value.onlyApps)
            } header: {
                Text("Only Tile These Apps")
            } footer: {
                Text("Leave empty to tile every app. Handy for trying tiling with a few apps first.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Shortcuts") {
                ForEach(actions) { a in
                    HStack {
                        Text(a.title)
                        Spacer()
                        ShortcutRecorder(actionID: a.id)
                    }
                }
            }
        }
        .formStyle(.grouped)
    }

    private func gapRow(_ title: String, value: Binding<Double>) -> some View {
        Stepper(value: value, in: 0...40, step: 2) {
            HStack {
                Text(title)
                Spacer()
                Text("\(Int(value.wrappedValue)) pt").monospacedDigit().foregroundStyle(.secondary)
            }
        }
    }
}

/// Editable list of bundle ids, shown with app icons and names.
struct BundleListEditor: View {
    @Binding var ids: [String]
    @State private var newID = ""

    var body: some View {
        ForEach(ids, id: \.self) { bid in
            HStack(spacing: 8) {
                AppIcon(bundleID: bid)
                VStack(alignment: .leading, spacing: 1) {
                    Text(AppInfo.name(bid) ?? bid)
                    if AppInfo.name(bid) != nil {
                        Text(bid).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Button {
                    ids.removeAll { $0 == bid }
                } label: {
                    Image(systemName: "minus.circle.fill").foregroundStyle(.secondary)
                }
                .buttonStyle(.borderless)
                .help("Remove")
            }
        }
        HStack {
            TextField("Bundle identifier", text: $newID, prompt: Text("com.example.App"))
                .labelsHidden()
                .onSubmit(addTyped)
            Button("Add", action: addTyped)
                .disabled(newID.trimmingCharacters(in: .whitespaces).isEmpty)
            Menu("Running App") {
                ForEach(runningApps, id: \.bundleIdentifier) { app in
                    Button(app.localizedName ?? app.bundleIdentifier ?? "?") {
                        if let bid = app.bundleIdentifier, !ids.contains(bid) { ids.append(bid) }
                    }
                }
            }
            .fixedSize()
        }
    }

    private var runningApps: [NSRunningApplication] {
        NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular && $0.bundleIdentifier != nil && !ids.contains($0.bundleIdentifier!) }
            .sorted { ($0.localizedName ?? "") < ($1.localizedName ?? "") }
    }

    private func addTyped() {
        let bid = newID.trimmingCharacters(in: .whitespaces)
        guard !bid.isEmpty, !ids.contains(bid) else { return }
        ids.append(bid)
        newID = ""
    }
}

private enum AppInfo {
    static func url(_ bid: String) -> URL? { NSWorkspace.shared.urlForApplication(withBundleIdentifier: bid) }

    static func name(_ bid: String) -> String? {
        guard let url = url(bid) else { return nil }
        return FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "")
    }
}

private struct AppIcon: View {
    let bundleID: String

    var body: some View {
        if let url = AppInfo.url(bundleID) {
            Image(nsImage: NSWorkspace.shared.icon(forFile: url.path))
                .resizable()
                .frame(width: 20, height: 20)
        } else {
            Image(systemName: "app.dashed")
                .frame(width: 20, height: 20)
                .foregroundStyle(.secondary)
        }
    }
}
