import AppKit
import SwiftUI
import BentoCore

/// State of the app grid: running apps (refreshed through NSWorkspace
/// notifications while the picker is visible), the installed-app index, the
/// query and the keyboard selection. Everything is dropped when it goes away.
final class AppPickerModel: ObservableObject {
    /// Search results shown at most (best matches first).
    static let searchLimit = 28

    @Published var query = "" {
        didSet { if query != oldValue { refilter(resetSelection: true) } }
    }
    @Published private(set) var results: [AppCandidate] = []
    @Published private(set) var selectedID: String?
    /// Columns the grid lays out, for Up/Down.
    @Published private(set) var columns = 1

    private var running: [AppCandidate] = []
    private var installed: [AppCandidate] = []
    private var index: InstalledAppIndex?
    /// Tile and row icons, while the pane is open.
    let icons = IconCache()
    private(set) var isVisible = false

    deinit { index?.cancel() }

    var isSearching: Bool { !AppPicker.normalize(query).isEmpty }
    var selected: AppCandidate? { results.first { $0.id == selectedID } }

    func appear() {
        guard !isVisible else { return }
        isVisible = true
        refreshRunning()
        let index = InstalledAppIndex()
        self.index = index
        index.build { [weak self] apps in
            guard let self, self.isVisible else { return }
            self.installed = apps
            self.refilter(resetSelection: false)
        }
    }

    func disappear() {
        isVisible = false
        index?.cancel()
        index = nil
        running = []
        installed = []
        icons.removeAll()
        results = []
    }

    func refreshRunning() {
        guard isVisible else { return }
        let me = getpid()
        let own = Bundle.main.bundleIdentifier
        running = NSWorkspace.shared.runningApplications.compactMap { app in
            guard app.activationPolicy == .regular, app.processIdentifier != me, !app.isTerminated,
                  let url = app.bundleURL, own == nil || app.bundleIdentifier != own else { return nil }
            let name = app.localizedName ?? FileManager.default.displayName(atPath: url.path)
            return AppCandidate(url: url, name: name, bundleID: app.bundleIdentifier, isRunning: true)
        }
        refilter(resetSelection: false)
    }

    func setWidth(_ width: CGFloat) {
        let c = GridNavigation.columns(width: width, minTile: AppGrid.minTile, spacing: AppGrid.spacing)
        if c != columns { columns = c }
    }

    func move(_ m: GridMove) {
        let current = results.firstIndex { $0.id == selectedID }
        guard let i = GridNavigation.move(current, m, count: results.count, columns: columns) else { return }
        selectedID = results[i].id
    }

    func select(_ app: AppCandidate) { selectedID = app.id }

    private func refilter(resetSelection: Bool) {
        let fresh = AppPicker.results(AppPicker.merge(running: running, installed: installed),
                                      query: query, limit: Self.searchLimit)
        if fresh != results { results = fresh }
        if resetSelection || !results.contains(where: { $0.id == selectedID }) {
            selectedID = results.first?.id
        }
    }
}

// MARK: - Section

/// Search field, the Add Other menu and the grid. Its own view observing the
/// model, so typing and arrow keys re-render the grid, not the hotkey rows.
struct AppPickerSection: View {
    static let scrollID = "launcher.picker"

    @ObservedObject var model: AppPickerModel
    let bound: BoundApps
    let revision: Int
    /// Bump to focus the search field.
    let focusRequest: Int
    let anchor: ViewAnchor
    let accessory: AnyView
    let onPick: (AppCandidate, _ fromKeyboard: Bool) -> Void
    @State private var searchFocused = false

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    PickerSearchField(text: $model.query, placeholder: "Search apps", focusRequest: focusRequest,
                                      anchor: anchor, onFocusChange: { searchFocused = $0 }, onCommand: command)
                    accessory
                }
                AppGrid(model: model, bound: bound, revision: revision, keyboardActive: searchFocused) { onPick($0, false) }
            }
            .padding(.vertical, 4)
            .id(Self.scrollID)
        } header: {
            Text(model.isSearching ? "Apps" : "Running Apps")
        } footer: {
            Text("Click an app, or press Return, then type its shortcut. Type to search every installed app; arrow keys move between them.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func command(_ command: PickerSearchField.Command) -> Bool {
        switch command {
        case .move(let m):
            guard !model.results.isEmpty else { return false }
            model.move(m)   // the tiles animate their own highlight
            return true
        case .submit:
            guard let app = model.selected else {
                NSSound.beep()
                return true
            }
            onPick(app, true)
            return true
        }
    }
}

// MARK: - Grid

struct AppGrid: View {
    static let minTile: CGFloat = 80
    static let spacing: CGFloat = 8

    @ObservedObject var model: AppPickerModel
    let bound: BoundApps
    /// Bumped on registry reloads so badges re-read their shortcuts.
    let revision: Int
    /// The search field has focus: arrows and Return act on the selection, so show it.
    let keyboardActive: Bool
    let onPick: (AppCandidate) -> Void

    var body: some View {
        let _ = revision
        Group {
            if model.results.isEmpty {
                empty
            } else {
                // Adaptive lays out as many columns as fit; the model computes
                // the same count from the width for Up/Down.
                LazyVGrid(columns: [GridItem(.adaptive(minimum: Self.minTile), spacing: Self.spacing)], spacing: Self.spacing) {
                    ForEach(model.results) { app in
                        AppTile(app: app, icons: model.icons, entry: bound.entry(for: app),
                                selected: keyboardActive && app.id == model.selectedID,
                                showsRunning: model.isSearching) {
                            model.select(app)
                            onPick(app)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { model.setWidth($0) }
        // No transition on the results: they change as you type, like Spotlight.
    }

    private var empty: some View {
        VStack(spacing: 4) {
            Image(systemName: model.isSearching ? "magnifyingglass" : "app.dashed")
                .font(.title2).foregroundStyle(.tertiary)
            Text(model.isSearching ? "No apps match “\(model.query.trimmingCharacters(in: .whitespaces))”"
                                   : "No other apps are running")
                .font(.callout).foregroundStyle(.secondary)
            Text(model.isSearching ? "Use Add Other → Application… to choose one anywhere on disk."
                                   : "Type to search installed apps.")
                .font(.caption).foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
    }
}

private struct AppTile: View {
    static let iconSide: CGFloat = 48

    let app: AppCandidate
    let icons: IconCache
    /// The entry that already opens this app.
    let entry: LauncherEntry?
    let selected: Bool
    /// Mark running apps (search results mix running and installed ones).
    let showsRunning: Bool
    let action: () -> Void
    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let shortcut = entry.flatMap { ActionRegistry.shared.shortcut(for: $0.actionID) }
        let failed = entry.map { ActionRegistry.shared.failed.contains($0.actionID) } ?? false
        Button(action: action) {
            VStack(spacing: 4) {
                FileIcon(url: app.url, side: Self.iconSide, cache: icons)
                    .overlay(alignment: .bottom) {
                        if showsRunning && app.isRunning {
                            Circle().fill(.secondary).frame(width: 4, height: 4).offset(y: 5)
                        }
                    }
                    .padding(.bottom, 2)
                Text(app.name)
                    .font(.system(size: 11))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .foregroundStyle(.primary)
                badge(shortcut, failed: failed)
                    .frame(height: 16)
            }
            .padding(.top, 8)
            .padding(.bottom, 6)
            .padding(.horizontal, 4)
            .frame(maxWidth: .infinity)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(fill))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(Color.accentColor.opacity(selected ? 0.9 : 0), lineWidth: 1.5))
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: selected)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: hovering)
        .help(help(shortcut))
        .accessibilityLabel(app.name)
        .accessibilityValue(shortcut?.displayString ?? (entry == nil ? "" : "No shortcut"))
        .accessibilityHint(entry == nil ? "Adds the app and records its shortcut" : "Records a new shortcut")
        .accessibilityIdentifier("launcher.tile:\(app.id)")
    }

    private var fill: Color {
        if selected { return Color.accentColor.opacity(0.16) }
        if hovering { return Color.primary.opacity(0.06) }
        return .clear
    }

    @ViewBuilder private func badge(_ shortcut: Shortcut?, failed: Bool) -> some View {
        if let shortcut {
            Text(shortcut.displayString)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(failed ? Color.orange : Color.accentColor)
                .padding(.horizontal, 6)
                .padding(.vertical, 1)
                .background(Capsule().fill((failed ? Color.orange : Color.accentColor).opacity(0.15)))
                .lineLimit(1)
        } else if entry != nil {
            Text("No shortcut").font(.system(size: 10)).foregroundStyle(.secondary)
        } else {
            Color.clear   // keeps every tile the same height
        }
    }

    private func help(_ shortcut: Shortcut?) -> String {
        let place = app.url.path.replacingOccurrences(of: NSHomeDirectory(), with: "~")
        guard let entry else { return "\(app.name) — \(place)\nClick to add it and record a shortcut" }
        let current = shortcut.map { "Opens with \($0.displayString)" } ?? "No shortcut yet"
        return "\(entry.displayName) — \(current)\nClick to record a new one"
    }
}

// MARK: - Search field

/// Native search field that keeps typing in the field while arrows, Return
/// and Esc drive the grid (like Raycast's grid views).
struct PickerSearchField: NSViewRepresentable {
    enum Command { case move(GridMove), submit }

    @Binding var text: String
    var placeholder: String
    /// Bump to focus the field and select its text.
    var focusRequest: Int
    let anchor: ViewAnchor
    let onFocusChange: (Bool) -> Void
    /// Returns whether the command was handled.
    let onCommand: (Command) -> Bool
    @Environment(\.isEnabled) private var isEnabled

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> FocusReportingSearchField {
        let field = FocusReportingSearchField()
        field.placeholderString = placeholder
        field.delegate = context.coordinator
        field.sendsSearchStringImmediately = true
        field.sendsWholeSearchString = false
        field.controlSize = .large
        field.setAccessibilityIdentifier("launcher.search")
        field.onFocusChange = { context.coordinator.parent.onFocusChange($0) }
        anchor.view = field
        context.coordinator.lastFocusRequest = focusRequest
        return field
    }

    func updateNSView(_ field: FocusReportingSearchField, context: Context) {
        context.coordinator.parent = self
        field.isEnabled = isEnabled   // the pane is disabled with its module
        if field.stringValue != text { field.stringValue = text }
        if context.coordinator.lastFocusRequest != focusRequest {
            context.coordinator.lastFocusRequest = focusRequest
            DispatchQueue.main.async {
                guard let window = field.window else { return }
                window.makeFirstResponder(field)
                field.currentEditor()?.selectAll(nil)
            }
        }
    }

    final class Coordinator: NSObject, NSSearchFieldDelegate {
        var parent: PickerSearchField
        var lastFocusRequest = 0

        init(_ parent: PickerSearchField) { self.parent = parent }

        func controlTextDidChange(_ note: Notification) {
            guard let field = note.object as? NSSearchField else { return }
            parent.text = field.stringValue
        }

        func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            switch selector {
            case #selector(NSResponder.moveUp(_:)): return parent.onCommand(.move(.up))
            case #selector(NSResponder.moveDown(_:)): return parent.onCommand(.move(.down))
            case #selector(NSResponder.moveLeft(_:)): return parent.onCommand(.move(.left))
            case #selector(NSResponder.moveRight(_:)): return parent.onCommand(.move(.right))
            case #selector(NSResponder.insertNewline(_:)): return parent.onCommand(.submit)
            case #selector(NSResponder.cancelOperation(_:)):
                // Esc clears the query, then leaves the field.
                if !textView.string.isEmpty {
                    textView.string = ""
                    parent.text = ""
                } else {
                    control.window?.makeFirstResponder(nil)
                }
                return true
            default:
                return false
            }
        }
    }
}

/// Reports when it gains or loses keyboard focus (its field editor counts).
final class FocusReportingSearchField: NSSearchField {
    var onFocusChange: ((Bool) -> Void)?
    private var observation: NSKeyValueObservation?
    private var focused = false

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        // The field editor takes over from the field in the same change and
        // gets wired up afterwards: look on the next turn.
        observation = window?.observe(\.firstResponder, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.update() }
        }
        update()
    }

    private func update() {
        let responder = window?.firstResponder
        let now = responder != nil && (responder === self || currentEditor() === responder)
        if now != focused {
            focused = now
            onFocusChange?(now)
        }
    }
}

/// A weak handle on an AppKit view inside SwiftUI (for its window).
final class ViewAnchor {
    weak var view: NSView?
}

// MARK: - Returning to the search field

/// Calls back once a recording started from the keyboard ends with a key
/// (the shortcut itself, Esc, ⌫), so focus can return to the search field for
/// the next app. A click hands control to the mouse and disarms it. Armed only
/// between those two moments; the recorder consumes the key-downs itself.
final class RecordingWatcher {
    private var monitor: Any?

    deinit { cancel() }

    func watch(_ recorder: NSView, ended: @escaping () -> Void) {
        cancel()
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyUp, .leftMouseDown, .rightMouseDown]) { [weak self, weak recorder] event in
            guard let self else { return event }
            if event.type != .keyUp {
                self.cancel()
                return event
            }
            DispatchQueue.main.async {
                guard self.monitor != nil else { return }
                if recorder.map(RecorderFocus.isRecording) != true {
                    self.cancel()
                    ended()
                }
            }
            return event
        }
    }

    func cancel() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }
}
