import AppKit
import SwiftUI
import BentoCore

struct WindowsSettingsView: View {
    let module: WindowsModule
    @StateObject private var model = ConfigSection("windows", default: WindowsSettings())
    @State private var newLayoutName = ""
    @State private var revision = 0
    @State private var axGranted = Permissions.accessibility

    var body: some View {
        Form {
            if !axGranted {
                Section {
                    HStack {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                        Text("Window management needs Accessibility permission.")
                        Spacer()
                        Button("Grant…") {
                            Permissions.requestAccessibility()
                            Permissions.open(.accessibility)
                        }
                    }
                }
            }
            importSection
            keyboardSection
            gapsSection
            snappingSection
            mouseSection
            layoutsSection
            launchSection
            stashSection
            shortcutSections
        }
        .formStyle(.grouped)
        .onReceive(NotificationCenter.default.publisher(for: ActionRegistry.didReload)) { _ in revision += 1 }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            axGranted = Permissions.accessibility
        }
    }

    // MARK: Import

    private var importSection: some View {
        let source = module.rectangleSource
        return Section {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(source.map { "Import from \($0.name)" } ?? "Import from Rectangle")
                    Text(source == nil ? "No Rectangle or Rectangle Pro settings on this Mac."
                                       : "Shortcuts, modifier-drag, gaps, snapping and repeat behaviour.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Import…") { module.importFromRectangle(interactive: true) }
                    .disabled(source == nil)
                Button("Choose File…") { module.importFromFile() }
                    .help("Import a Rectangle or Rectangle Pro preferences plist, or a JSON file exported from Rectangle")
            }
        }
    }

    // MARK: Keyboard

    private var keyboardSection: some View {
        Section("Keyboard") {
            Toggle("Repeating an action cycles sizes and positions", isOn: $model.value.cycleOnRepeat)
            if model.value.cycleOnRepeat {
                LabeledContent("Half and corner sizes") {
                    CycleSizePicker(selection: $model.value.cycleSizes)
                }
            }
            Toggle("Repeating Left or Right Half at the screen edge moves to the next display",
                   isOn: $model.value.moveToAdjacentDisplayOnRepeat)
            Stepper(value: $model.value.sizeStep, in: 5...200, step: 5) {
                LabeledContent("Make Larger / Smaller step", value: "\(WindowsSettings.points(model.value.sizeStep)) pt")
            }
            Stepper(value: $model.value.almostMaximizeWidth, in: 0.5...1, step: 0.05) {
                LabeledContent("Almost Maximize width", value: percent(model.value.almostMaximizeWidth))
            }
            Stepper(value: $model.value.almostMaximizeHeight, in: 0.5...1, step: 0.05) {
                LabeledContent("Almost Maximize height", value: percent(model.value.almostMaximizeHeight))
            }
            Toggle("Show the action name on screen", isOn: $model.value.showHUD)
        }
    }

    private func percent(_ v: Double) -> String { "\(WindowsSettings.points(v * 100)) %" }

    // MARK: Gaps

    private var gapsSection: some View {
        Section {
            pointSlider("Between windows", value: $model.value.windowGap)
            pointSlider("At screen edges", value: $model.value.screenMargin)
            Toggle("Apply to Maximize and Maximize Height", isOn: $model.value.gapsOnMaximize)
        } header: {
            Text("Gaps")
        } footer: {
            Text("Used by halves, corners, thirds and the other screen-slot actions, and by snapping.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func pointSlider(_ title: String, value: Binding<Double>) -> some View {
        LabeledContent(title) {
            HStack {
                Slider(value: Binding(get: { value.wrappedValue }, set: { value.wrappedValue = $0.rounded() }), in: 0...40)
                    .frame(maxWidth: 220)
                Text("\(WindowsSettings.points(value.wrappedValue)) pt").monospacedDigit().frame(width: 44, alignment: .trailing)
            }
        }
    }

    // MARK: Snapping

    private var snappingSection: some View {
        Section {
            Toggle("Snap windows by dragging them to a screen edge", isOn: $model.value.snapping)
            if model.value.snapping {
                Toggle("Top edge maximizes", isOn: $model.value.snapTopMaximizes)
                Toggle("Corners make quarters", isOn: $model.value.snapCorners)
                Toggle("Left and right edges make halves", isOn: $model.value.snapSides)
                Toggle("Near a corner, left and right edges make top / bottom halves", isOn: $model.value.snapSideCornerHalves)
                    .disabled(!model.value.snapSides)
                Toggle("Bottom edge makes thirds (drag along it for two thirds)", isOn: $model.value.snapBottomThirds)
                Toggle("Coming from a corner, top and bottom edges make sixths", isOn: $model.value.snapSixths)
                Toggle("Restore the size when dragging a snapped window away", isOn: $model.value.restoreSizeOnUnsnap)
                if NativeTiling.isEnabled {
                    HStack {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                        Text("macOS window tiling by dragging is on and will compete with snapping.")
                        Spacer()
                        Button("Open Settings…") { NativeTiling.openSettings() }
                    }
                    .font(.callout)
                }
            }
        } header: {
            Text("Snapping")
        }
    }

    // MARK: Mouse

    private var mouseSection: some View {
        Section {
            HStack {
                Toggle("Move by dragging anywhere in a window", isOn: $model.value.dragMove)
                Spacer()
                ModifierPicker(selection: $model.value.dragMoveModifiers).disabled(!model.value.dragMove)
            }
            HStack {
                Toggle("Resize from the nearest edge or corner", isOn: $model.value.dragResize)
                Spacer()
                ModifierPicker(selection: $model.value.dragResizeModifiers).disabled(!model.value.dragResize)
            }
            if model.value.dragMove && model.value.dragResize
                && Set(model.value.dragMoveModifiers) == Set(model.value.dragResizeModifiers) {
                Text("Move and resize use the same modifiers; resize wins.")
                    .font(.caption).foregroundStyle(.orange)
            }
            Toggle("Bring the window to the front", isOn: $model.value.dragFocusesWindow)
            Toggle("Snap when released at a screen edge", isOn: $model.value.dragSnaps)
                .disabled(!model.value.snapping)
        } header: {
            Text("Modifier Drag")
        } footer: {
            Text("Hold the modifiers, then press and drag anywhere in a window. The click doesn't reach the app.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    // MARK: Layouts

    private var layoutsSection: some View {
        Section {
            ForEach($model.value.layouts) { $layout in
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        TextField("Name", text: $layout.name).labelsHidden().textFieldStyle(.plain)
                        Text("\(layout.windows.count) windows · \(Set(layout.windows.map(\.bundleID)).count) apps")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    ShortcutRecorder(actionID: layout.actionID).id("\(layout.actionID)-\(revision)")
                    Menu {
                        Button("Restore") { module.restoreLayout(id: layout.id) }
                        Button("Update with Current Windows") { module.saveLayout(named: layout.name) }
                        Toggle("Launch Missing Apps", isOn: $layout.launchApps)
                        Divider()
                        Button("Delete", role: .destructive) { model.value.layouts.removeAll { $0.id == layout.id } }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                    Button("Restore") { module.restoreLayout(id: layout.id) }
                }
            }
            LabeledContent("Save the current windows as") {
                HStack {
                    TextField("Layout name", text: $newLayoutName, prompt: Text("Layout \(model.value.layouts.count + 1)"))
                        .labelsHidden()
                        .frame(width: 160)
                        .onSubmit(saveNewLayout)
                    Button("Save", action: saveNewLayout)
                }
            }
        } header: {
            Text("Layouts")
        } footer: {
            Text("A layout remembers where the windows of all visible apps are. Restore it from its shortcut or the menu bar.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func saveNewLayout() {
        module.saveLayout(named: newLayoutName)
        newLayoutName = ""
    }

    // MARK: Launch positions

    private static let launchCommands: [WindowCommand] = WindowCommand.allCases.filter {
        ($0.isPositional && $0.group != .more) || $0 == .center
    }

    private var launchSection: some View {
        Section {
            ForEach($model.value.launchRules) { $rule in
                HStack {
                    AppIcon(bundleID: rule.bundleID)
                    Text(rule.appName)
                    Spacer()
                    Picker("", selection: $rule.command) {
                        ForEach(Self.launchCommands, id: \.rawValue) { Text($0.title).tag($0.rawValue) }
                    }
                    .labelsHidden()
                    .frame(width: 190)
                    Button {
                        model.value.launchRules.removeAll { $0.id == rule.id }
                    } label: {
                        Image(systemName: "minus.circle")
                    }
                    .buttonStyle(.borderless)
                }
            }
            Button("Add App…", action: addLaunchRule)
        } header: {
            Text("Launch Positions")
        } footer: {
            Text("Moves an app's first window into place when the app launches.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func addLaunchRule() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.application]
        panel.directoryURL = URL(fileURLWithPath: "/Applications")
        panel.allowsMultipleSelection = true
        guard panel.runModal() == .OK else { return }
        for url in panel.urls {
            guard let bid = Bundle(url: url)?.bundleIdentifier,
                  !model.value.launchRules.contains(where: { $0.bundleID == bid }) else { continue }
            let name = FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "")
            model.value.launchRules.append(LaunchRule(bundleID: bid, appName: name, command: WindowCommand.leftHalf.rawValue))
        }
    }

    // MARK: Stash

    private var stashSection: some View {
        Section {
            Stepper(value: $model.value.stashSliver, in: 4...60, step: 2) {
                LabeledContent("Visible sliver", value: "\(WindowsSettings.points(model.value.stashSliver)) pt")
            }
            Toggle("Reveal when the pointer touches the sliver", isOn: $model.value.stashRevealOnHover)
        } header: {
            Text("Stash")
        } footer: {
            Text("Stash slides the focused window off a free left or right screen edge; it slides back out on hover or with Reveal, and hides again when the pointer leaves it.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    // MARK: Shortcuts

    private var shortcutSections: some View {
        let actions = module.actions
        let groups: [String] = WindowCommand.Group.allCases.map(\.rawValue) + ["Stash", "Other"]
        return ForEach(groups, id: \.self) { group in
            let items = actions.filter { $0.group == group }
            if !items.isEmpty {
                Section {
                    if group == WindowCommand.Group.more.rawValue {
                        DisclosureGroup("Ninths, eighths, two-thirds corners, vertical thirds, halve / double") {
                            ForEach(items) { WindowShortcutRow(action: $0, revision: revision) }
                        }
                    } else {
                        ForEach(items) { WindowShortcutRow(action: $0, revision: revision) }
                    }
                } header: {
                    Text(group == WindowCommand.Group.halves.rawValue ? "Shortcuts — Halves" : group)
                }
            }
        }
    }
}

private struct WindowShortcutRow: View {
    let action: BentoAction
    let revision: Int

    var body: some View {
        let reg = ActionRegistry.shared
        HStack {
            Text(action.title)
            if reg.failed.contains(action.id) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                    .help("Shortcut unavailable (used by another app or action)")
            }
            Spacer()
            if reg.shortcut(for: action.id) != action.defaultShortcut {
                Button {
                    reg.setShortcut(action.defaultShortcut, for: action.id)
                } label: {
                    Image(systemName: "arrow.uturn.backward")
                }
                .buttonStyle(.borderless)
                .help("Reset to default (\(action.defaultShortcut?.displayString ?? "none"))")
            }
            ShortcutRecorder(actionID: action.id).id("\(action.id)-\(revision)")
        }
    }
}

/// ⌃ ⌥ ⇧ ⌘ toggles, stored as ["ctrl", "opt", "shift", "cmd"] names.
struct ModifierPicker: View {
    @Binding var selection: [String]
    private static let all: [(String, String, String)] = [("ctrl", "⌃", "Control"), ("opt", "⌥", "Option"),
                                                          ("shift", "⇧", "Shift"), ("cmd", "⌘", "Command")]

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Self.all, id: \.0) { name, symbol, help in
                Toggle(isOn: Binding(
                    get: { selection.contains(name) },
                    set: { on in
                        var s = Set(selection)
                        if on { s.insert(name) } else if s.count > 1 { s.remove(name) }
                        selection = Self.all.map(\.0).filter(s.contains)
                    }
                )) {
                    Text(symbol).font(.system(size: 13, weight: .medium)).frame(width: 18)
                }
                .toggleStyle(.button)
                .help(help)
            }
        }
    }
}

struct CycleSizePicker: View {
    @Binding var selection: [String]

    var body: some View {
        HStack(spacing: 4) {
            ForEach(WindowsSettings.cycleChoices, id: \.0) { key, label in
                Toggle(isOn: Binding(
                    get: { selection.contains(key) },
                    set: { on in
                        var s = Set(selection)
                        if on { s.insert(key) } else if s.count > 1 { s.remove(key) }
                        selection = WindowsSettings.cycleChoices.map(\.0).filter(s.contains)
                    }
                )) {
                    Text(label).frame(width: 18)
                }
                .toggleStyle(.button)
            }
        }
    }
}

private struct AppIcon: View {
    let bundleID: String

    var body: some View {
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) {
            Image(nsImage: NSWorkspace.shared.icon(forFile: url.path)).resizable().frame(width: 20, height: 20)
        } else {
            Image(systemName: "app.dashed").frame(width: 20, height: 20)
        }
    }
}

/// macOS 15+ native window tiling, which fights with drag-to-snap.
enum NativeTiling {
    static var isEnabled: Bool {
        let d = UserDefaults(suiteName: "com.apple.WindowManager")
        let edge = d?.object(forKey: "EnableTilingByEdgeDrag") as? Bool ?? true
        let top = d?.object(forKey: "EnableTopTilingByEdgeDrag") as? Bool ?? true
        guard ProcessInfo.processInfo.isOperatingSystemAtLeast(OperatingSystemVersion(majorVersion: 15, minorVersion: 0, patchVersion: 0)) else { return false }
        return edge || top
    }

    static func openSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.Desktop-Settings.extension") {
            NSWorkspace.shared.open(url)
        }
    }
}
