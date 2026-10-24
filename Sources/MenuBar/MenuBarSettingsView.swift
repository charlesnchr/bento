import AppKit
import SwiftUI
import BentoCore

struct MenuBarSettingsView: View {
    @ObservedObject var module: MenuBarModule
    @StateObject private var model = ConfigSection("menubar", default: MenuBarSettings())
    @StateObject private var arrange = ArrangeModel()
    @State private var revision = 0
    @State private var spacing = ItemSpacing.read()
    @State private var spacingApplied = false

    var body: some View {
        Form {
            itemsSection
            sectionsSection
            revealSection
            rehideSection
            barSection
            changeSection
            spacingSection
            appearanceSection
            shortcutsSection
        }
        .formStyle(.grouped)
        .onAppear { arrange.attach(module.controller) }
        .onDisappear { arrange.detach() }
        .onChange(of: module.controller.map(ObjectIdentifier.init)) { _, _ in arrange.attach(module.controller) }
        .onReceive(NotificationCenter.default.publisher(for: ActionRegistry.didReload)) { _ in revision += 1 }
    }

    // MARK: Items

    @ViewBuilder private var itemsSection: some View {
        Section {
            if module.controller == nil {
                Text("Turn the module on to arrange menu bar items.").foregroundStyle(.secondary)
            } else {
                HStack {
                    if arrange.arranging {
                        Text("Hold ⌘ and drag items in the native menu bar.")
                        Spacer()
                        Button("Done") { arrange.finish() }.keyboardShortcut(.defaultAction)
                    } else {
                        Button("Arrange in Menu Bar") { arrange.begin() }
                    }
                }
                Text("Visible: right of the solid separator. Hidden: left of the solid separator, up to the dashed separator. Always Hidden: left of the dashed separator, when enabled. Keep the dashed separator left of the solid one; you can Command-drag the separators too.")
                    .font(.caption).foregroundStyle(.secondary)
                if !Permissions.accessibility || !Permissions.screenRecording {
                    HStack(spacing: 8) {
                        Text("Accessibility enables opening items from search or shortcuts; Screen Recording supplies item names and images. Manual Command-drag needs neither.")
                            .font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        if !Permissions.accessibility {
                            Button("Grant Accessibility…") { Permissions.grant(.accessibility) }
                        }
                        if !Permissions.screenRecording {
                            Button("Grant Screen Recording…") { Permissions.grant(.screenRecording) }
                        }
                    }
                }
                ForEach(MenuBarSection.allCases) { section in
                    if section != .alwaysHidden || model.value.alwaysHiddenSection {
                        SectionStrip(section: section, arrange: arrange)
                    }
                }
                HStack(spacing: 8) {
                    if arrange.arranging {
                        Text("Sections stay revealed until Done or you leave this page.").foregroundStyle(.secondary)
                    } else if let message = arrange.message {
                        Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                    } else if !arrange.overflow.isEmpty {
                        Label(arrange.overflow.count == 1 ? "1 item doesn’t fit in the menu bar. Make space or reposition it manually."
                              : "\(arrange.overflow.count) items don’t fit in the menu bar. Make space or reposition them manually.",
                              systemImage: "rectangle.topthird.inset.filled")
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Refresh") { arrange.load() }
                }
                .font(.callout)
            }
        } header: {
            Text("Items")
        } footer: {
            Text("Bento only shows and hides sections. Arrange items yourself with macOS Command-drag. A crowded or notched menu bar may not have room to reveal every item; Bento cannot bring overflow items into view for a click.")
                .font(.caption).foregroundStyle(.secondary)
        }
        if module.controller != nil, !arrange.allItems.isEmpty {
            Section("Item Shortcuts and Alerts") {
                ForEach(arrange.allItems.filter { $0.hasStableKey && $0.role == .regular }) { item in
                    ItemRow(item: item, image: arrange.images[item.windowID], section: arrange.section(of: item),
                            settings: $model.value, revision: revision)
                }
            }
        }
    }

    // MARK: Options

    private var sectionsSection: some View {
        Section {
            Toggle(isOn: $model.value.showChevron) {
                Text("Show the chevron")
                Text("Click it to show or hide the hidden items, ⌥-click to include the always hidden ones, right-click for more.")
            }
            Toggle(isOn: $model.value.alwaysHiddenSection) {
                Text("Always Hidden section")
                Text("Items left of the dashed separator show with Show All Items, ⌥-click or Arrange in Menu Bar.")
            }
        } header: {
            Text("Sections")
        }
    }

    private var revealSection: some View {
        Section("Show Hidden Items") {
            Toggle("When the pointer rests on empty menu bar space", isOn: $model.value.revealOnHover)
            if model.value.revealOnHover {
                LabeledContent("Delay") {
                    HStack {
                        Slider(value: $model.value.hoverDelay, in: 0...1.5, step: 0.1).frame(maxWidth: 200)
                        Text(String(format: "%.1f s", model.value.clampedHoverDelay)).monospacedDigit().frame(width: 44, alignment: .trailing)
                    }
                }
            }
            Toggle("When clicking empty menu bar space", isOn: $model.value.revealOnEmptyClick)
            Toggle("When scrolling or swiping on the menu bar", isOn: $model.value.revealOnScroll)
        }
    }

    private var rehideSection: some View {
        Section("Hide Again") {
            Toggle("Automatically", isOn: $model.value.autoRehide)
            if model.value.autoRehide {
                LabeledContent("After") {
                    HStack {
                        Slider(value: $model.value.rehideDelay, in: 3...60, step: 1).frame(maxWidth: 200)
                        Text("\(Int(model.value.clampedRehideDelay)) s").monospacedDigit().frame(width: 44, alignment: .trailing)
                    }
                }
            }
            Toggle(isOn: $model.value.rehideOnClickOutside) {
                Text("When clicking elsewhere")
                Text("Also when the menu of a shown item closes.")
            }
        }
    }

    private var barSection: some View {
        Section {
            Picker("Show hidden items", selection: $model.value.bar) {
                ForEach(BarMode.allCases) { Text($0.title).tag($0) }
            }
            Button("Open the Bento Bar") { module.controller?.bar.show(all: false) }
                .disabled(module.controller == nil)
        } header: {
            Text("Bento Bar")
        } footer: {
            Text("The Bento Bar lists hidden and overflow items. Opening reveals an item in place and uses Accessibility when available. If it cannot open, click or reposition it manually in the menu bar; the strip does not provide extra menu bar space.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private var changeSection: some View {
        Section {
            if model.value.showOnChange.isEmpty {
                Text("None. Turn it on for an item in Item Shortcuts and Alerts.").foregroundStyle(.secondary)
            } else {
                ForEach(model.value.showOnChange, id: \.self) { key in
                    HStack {
                        Text(MenuBarModule.itemTitle(key))
                        Spacer()
                        Button { model.value.showOnChange.removeAll { $0 == key } } label: {
                            Image(systemName: "minus.circle.fill").foregroundStyle(.secondary)
                        }
                        .buttonStyle(.borderless)
                        .help("Stop watching")
                    }
                }
                LabeledContent("Show for") {
                    HStack {
                        Slider(value: $model.value.showOnChangeDuration, in: 2...30, step: 1).frame(maxWidth: 200)
                        Text("\(Int(model.value.clampedShowOnChangeDuration)) s").monospacedDigit().frame(width: 44, alignment: .trailing)
                    }
                }
            }
        } header: {
            Text("Show When the Icon Changes")
        } footer: {
            Text("A watched hidden item shows for a few seconds when its icon changes. Watched items are looked at every 2 seconds while hidden.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    // MARK: Spacing

    private var spacingSection: some View {
        Section {
            spacingRow("Item spacing", value: $spacing.spacing, fallback: ItemSpacing.defaultSpacing)
            spacingRow("Selection padding", value: $spacing.padding, fallback: ItemSpacing.defaultPadding)
            HStack {
                Button("Apply") {
                    ItemSpacing.write(spacing)
                    spacingApplied = true
                }
                .disabled(spacing == ItemSpacing.read())
                Button("Restore Defaults") {
                    spacing = ItemSpacing.Values()
                    ItemSpacing.write(spacing)
                    spacingApplied = true
                }
                .disabled(ItemSpacing.read() == ItemSpacing.Values())
                Spacer()
            }
            if spacingApplied {
                Text("Saved. Each app picks it up when it restarts; log out and back in to apply it everywhere.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        } header: {
            Text("Spacing")
        } footer: {
            Text("Smaller values fit more items beside the notch. Same as `\(ItemSpacing.commands(spacing)[0])`.")
                .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
        }
    }

    private func spacingRow(_ title: String, value: Binding<Int?>, fallback: Int) -> some View {
        Stepper(value: Binding(get: { value.wrappedValue ?? fallback }, set: { value.wrappedValue = $0 == fallback ? nil : $0 }),
                in: ItemSpacing.range) {
            HStack {
                Text(title)
                Spacer()
                Text("\(value.wrappedValue ?? fallback) pt\(value.wrappedValue == nil ? " (default)" : "")")
                    .monospacedDigit().foregroundStyle(.secondary)
            }
        }
    }

    // MARK: Appearance

    private var appearanceSection: some View {
        Section("Appearance") {
            Toggle("Tint the menu bar", isOn: $model.value.appearance.enabled)
            if model.value.appearance.enabled {
                ColorPicker("Tint", selection: hexBinding(\.tint), supportsOpacity: true)
                Toggle("Border", isOn: $model.value.appearance.border)
                if model.value.appearance.border {
                    ColorPicker("Border colour", selection: hexBinding(\.borderColor), supportsOpacity: true)
                }
                Toggle("Shadow", isOn: $model.value.appearance.shadow)
            }
        }
    }

    private func hexBinding(_ path: WritableKeyPath<MenuBarAppearance, String>) -> Binding<Color> {
        Binding(
            get: {
                let c = MenuBarAppearance.rgba(model.value.appearance[keyPath: path]) ?? (0, 0, 0, 0.2)
                return Color(.sRGB, red: c.r, green: c.g, blue: c.b, opacity: c.a)
            },
            set: { color in
                guard let c = NSColor(color).usingColorSpace(.sRGB) else { return }
                model.value.appearance[keyPath: path] = MenuBarAppearance.hex(r: c.redComponent, g: c.greenComponent,
                                                                               b: c.blueComponent, a: c.alphaComponent)
            }
        )
    }

    // MARK: Shortcuts

    private var shortcutsSection: some View {
        Section("Shortcuts") {
            let _ = revision
            ForEach(module.actions.filter { !$0.id.hasPrefix("menubar.click-") }) { a in
                HStack {
                    Text(a.title)
                    Spacer()
                    ShortcutRecorder(actionID: a.id)
                }
            }
        }
    }
}

// MARK: - Arranging

final class ArrangeModel: ObservableObject {
    @Published private(set) var sections: [MenuBarSection: [MenuBarItem]] = [:]
    @Published var images: [CGWindowID: NSImage] = [:]
    @Published private(set) var arranging = false
    @Published private(set) var message: String?
    @Published private(set) var overflow: Set<CGWindowID> = []
    private weak var controller: MenuBarController?
    private var observer: NSObjectProtocol?

    var allItems: [MenuBarItem] { MenuBarSection.allCases.flatMap { sections[$0] ?? [] } }

    private let capture: ([MenuBarItem], @escaping ([CGWindowID: NSImage]) -> Void) -> Void

    init(capture: @escaping ([MenuBarItem], @escaping ([CGWindowID: NSImage]) -> Void) -> Void = ItemImages.capture) {
        self.capture = capture
    }

    func attach(_ controller: MenuBarController?) {
        guard self.controller !== controller else { return }
        detach()
        guard let controller else { return }
        self.controller = controller
        observer = NotificationCenter.default.addObserver(forName: MenuBarController.didChange, object: nil, queue: .main) { [weak self, weak controller] note in
            guard let controller, note.object as? MenuBarController === controller else { return }
            self?.reload()
        }
        load()
    }

    /// Leaving Settings finishes manual arrangement and releases item images.
    func detach() {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        controller?.finishArrangement()
        controller = nil
        images = [:]
        sections = [:]
        overflow = []
        arranging = false
        message = nil
    }

    func begin() { controller?.beginArrangement() }
    func finish() { controller?.finishArrangement(); load() }

    func load() {
        guard let controller else { return }
        controller.refresh(details: true) { [weak self, weak controller] in
            guard let self, let controller, self.controller === controller else { return }
            self.reload()
            self.capture(self.allItems) { [weak self, weak controller] images in
                guard let self, let controller, self.controller === controller else { return }
                self.images = images
            }
        }
    }

    func reload() {
        guard let controller else { return }
        sections = controller.arrangement()
        overflow = Set(controller.overflowItems().map(\.windowID))
        arranging = controller.isArranging
        message = controller.lastError
    }

    func section(of item: MenuBarItem) -> MenuBarSection {
        MenuBarSection.allCases.first { sections[$0]?.contains { $0.windowID == item.windowID } == true } ?? .visible
    }

    deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }
}

/// Read-only snapshot of each section; arrangement happens in the native menu bar.
private struct SectionStrip: View {
    let section: MenuBarSection
    @ObservedObject var arrange: ArrangeModel

    var body: some View {
        let items = arrange.sections[section] ?? []
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label(section.title, systemImage: section.symbol)
                Text("\(items.count)").foregroundStyle(.secondary).monospacedDigit()
                Spacer()
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    ForEach(items) { item in
                        ItemChip(item: item, image: arrange.images[item.windowID], overflow: arrange.overflow.contains(item.windowID), arrange: arrange)
                    }
                    if items.isEmpty {
                        Text("No items").font(.callout).foregroundStyle(.secondary).padding(.horizontal, 10)
                    }
                    Spacer(minLength: 40)
                }
                .padding(.horizontal, 4)
                .frame(minHeight: 34)
            }
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(MenuBarLook.barBackground))
            .environment(\.colorScheme, MenuBarLook.isDark ? .dark : .light)
        }
        .padding(.vertical, 2)
    }
}

/// Colours that match the live menu bar, so captured images read well.
enum MenuBarLook {
    /// One of Bento's status item buttons: its appearance is the menu bar's
    /// (which follows the wallpaper on macOS 26, not the system setting).
    static weak var button: NSStatusBarButton?

    static var isDark: Bool {
        let appearance = button?.effectiveAppearance ?? NSApp.effectiveAppearance
        return appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    }

    static var barBackground: Color { isDark ? Color.black.opacity(0.62) : Color.white.opacity(0.8) }
}

private struct ItemChip: View {
    let item: MenuBarItem
    let image: NSImage?
    let overflow: Bool
    @ObservedObject var arrange: ArrangeModel
    @State private var hovering = false

    var body: some View {
        chip
            .padding(.horizontal, 2)
            .frame(height: 28)
            .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Color.primary.opacity(hovering ? 0.15 : 0)))
            .overlay(alignment: .topTrailing) {
                if overflow {
                    Image(systemName: "rectangle.topthird.inset.filled").font(.system(size: 8)).foregroundStyle(.orange).offset(x: 2, y: -2)
                }
            }
            .opacity(item.isMovable ? 1 : 0.55)
            .onHover { hovering = $0 }
            .help(help)
            .contextMenu {
                Button("Open") { arrange.open(item) }.disabled(arrange.arranging)
            }
            .accessibilityElement()
            .accessibilityLabel(item.name)
    }

    private var help: String {
        var parts = [item.name]
        if !item.appName.isEmpty, item.appName != item.name { parts.append(item.appName) }
        if let s = item.subtitle { parts.append(s) }
        if !item.isMovable { parts.append("macOS keeps this item in place") }
        if overflow { parts.append("Doesn’t fit beside the notch") }
        return parts.joined(separator: "\n")
    }

    @ViewBuilder private var chip: some View {
        if let image {
            Image(nsImage: image)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .frame(width: image.size.width * 26 / max(image.size.height, 1), height: 26)
        } else {
            HStack(spacing: 4) {
                if let icon = ItemImages.appIcon(for: item) {
                    Image(nsImage: icon).resizable().frame(width: 16, height: 16)
                }
                Text(item.name).font(.caption).lineLimit(1)
            }
            .padding(.horizontal, 6)
        }
    }
}

extension ArrangeModel {
    func open(_ item: MenuBarItem) {
        controller?.activate(item)
    }
}

/// An item with its section, shortcut and "show when the icon changes".
private struct ItemRow: View {
    let item: MenuBarItem
    let image: NSImage?
    let section: MenuBarSection
    @Binding var settings: MenuBarSettings
    let revision: Int

    var body: some View {
        let _ = revision
        HStack(spacing: 10) {
            ItemThumbnail(item: item, image: image, height: 20)
                .frame(width: 48, alignment: .leading)
                .environment(\.colorScheme, MenuBarLook.isDark ? .dark : .light)
            VStack(alignment: .leading, spacing: 1) {
                Text(item.name).lineLimit(1)
                if let sub = item.subtitle ?? (item.appName != item.name ? item.appName : nil) {
                    Text(sub).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                if let reason = ActionRegistry.shared.failureReason(for: MenuBarModule.itemActionID(item.key)) {
                    Text("Shortcut unavailable: \(reason)").font(.caption).foregroundStyle(.orange)
                }
            }
            Spacer()
            Text(section.title).foregroundStyle(.secondary).frame(width: 130)
            Toggle(isOn: Binding(
                get: { settings.showOnChange.contains(item.key) },
                set: { on in
                    if on { if !settings.showOnChange.contains(item.key) { settings.showOnChange.append(item.key) } }
                    else { settings.showOnChange.removeAll { $0 == item.key } }
                }
            )) {
                Image(systemName: "bell.badge")
            }
            .toggleStyle(.button)
            .help("Show for a few seconds when its icon changes")
            ShortcutRecorder(shortcut: Binding(
                get: { settings.itemHotkeys[item.key].flatMap(Shortcut.init) },
                set: { sc in
                    if let sc { settings.itemHotkeys[item.key] = sc.configString } else { settings.itemHotkeys.removeValue(forKey: item.key) }
                }
            ), placeholder: "Open Shortcut")
        }
    }
}
