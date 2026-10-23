import AppKit
import SwiftUI
import UniformTypeIdentifiers
import BentoCore

struct MenuBarSettingsView: View {
    let module: MenuBarModule
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
            profilesSection
            spacingSection
            appearanceSection
            shortcutsSection
        }
        .formStyle(.grouped)
        .onAppear { arrange.attach(module.controller) }
        .onDisappear { arrange.detach() }
        .onReceive(NotificationCenter.default.publisher(for: ActionRegistry.didReload)) { _ in revision += 1 }
    }

    // MARK: Items

    @ViewBuilder private var itemsSection: some View {
        Section {
            if module.controller == nil {
                Text("Turn the module on to arrange menu bar items.").foregroundStyle(.secondary)
            } else {
                if !Permissions.accessibility || !Permissions.screenRecording {
                    HStack(spacing: 8) {
                        Label("Arranging needs Accessibility (to move items) and Screen Recording (for their names and images).",
                              systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
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
                        ProgressView().controlSize(.small)
                        Text("Moving items…").foregroundStyle(.secondary)
                    } else if let message = arrange.message {
                        Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                    } else if !arrange.overflow.isEmpty {
                        Label(arrange.overflow.count == 1 ? "1 item doesn’t fit beside the notch; it’s in the Bento Bar."
                              : "\(arrange.overflow.count) items don’t fit beside the notch; they’re in the Bento Bar.",
                              systemImage: "rectangle.topthird.inset.filled")
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Refresh") { arrange.load() }
                        .disabled(arrange.arranging)
                }
                .font(.callout)
            }
        } header: {
            Text("Items")
        } footer: {
            Text("Drag items between sections, or pick a section from an item’s menu. Bento moves the real items by ⌘-dragging them, as you would; the pointer is put back afterwards. ⌘-dragging items in the menu bar yourself works too.")
                .font(.caption).foregroundStyle(.secondary)
        }
        if module.controller != nil, !arrange.allItems.isEmpty {
            Section("Item Shortcuts and Alerts") {
                ForEach(arrange.allItems.filter { $0.hasStableKey && $0.role == .regular }) { item in
                    ItemRow(item: item, image: arrange.images[item.windowID], section: arrange.section(of: item),
                            settings: $model.value, module: module, revision: revision) { section in
                        arrange.move(item, to: section)
                    }
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
                Text("Items left of the dashed separator only show with Show All Items or ⌥-click.")
            }
            Toggle(isOn: $model.value.keepItemsInPlace) {
                Text("Keep items in their sections")
                Text("When an app restarts and macOS puts its item somewhere else, move it back.")
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
            Text("The Bento Bar is a strip below the menu bar. Click an item there to open its menu in the menu bar. On a MacBook with a notch, items that don’t fit beside it show up there too.")
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

    // MARK: Profiles

    private var profilesSection: some View {
        Section {
            ForEach($model.value.profiles) { $profile in
                ProfileRow(profile: $profile, module: module) {
                    model.value.profiles.removeAll { $0.id == profile.id }
                }
            }
            HStack {
                Button("Save Current Layout as Profile") {
                    module.controller?.learnLayout()
                    let layout = ConfigStore.shared.section("menubar", default: MenuBarSettings()).layout
                    var p = LayoutProfile(name: "Profile \(model.value.profiles.count + 1)", layout: layout)
                    p.layout = layout
                    model.value.profiles.append(p)
                }
                .disabled(module.controller == nil)
                Spacer()
            }
        } header: {
            Text("Profiles")
        } footer: {
            Text("A profile is a saved arrangement. Apply it from Bento’s menu, a shortcut, `open bento://action/<id>`, or a Focus automation in Shortcuts (Open URL). A profile tied to a display applies when that display becomes the main one.")
                .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
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
    @Published var message: String?
    @Published private(set) var overflow: Set<CGWindowID> = []
    private weak var controller: MenuBarController?
    private var observer: NSObjectProtocol?

    var allItems: [MenuBarItem] { MenuBarSection.allCases.flatMap { sections[$0] ?? [] } }

    func attach(_ controller: MenuBarController?) {
        guard let controller else { return }
        self.controller = controller
        if observer == nil {
            observer = NotificationCenter.default.addObserver(forName: MenuBarController.didChange, object: controller, queue: .main) { [weak self] _ in
                self?.reload()
            }
        }
        load()
    }

    /// Settings closed or switched page: drop the images.
    func detach() {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        images = [:]
        sections = [:]
    }

    func load() {
        controller?.refresh(details: true) { [weak self] in
            guard let self else { return }
            self.controller?.learnLayout()
            self.reload()
            self.captureImages()
        }
    }

    func reload() {
        guard let controller else { return }
        sections = controller.arrangement()
        overflow = Set(controller.overflowItems().map(\.windowID))
        arranging = controller.isArranging
    }

    private func captureImages() {
        ItemImages.capture(allItems) { [weak self] images in
            guard let self, self.observer != nil else { return }
            self.images.merge(images) { _, new in new }
        }
    }

    func section(of item: MenuBarItem) -> MenuBarSection {
        MenuBarSection.allCases.first { sections[$0]?.contains { $0.windowID == item.windowID } == true } ?? .visible
    }

    func move(_ item: MenuBarItem, to section: MenuBarSection, before: CGWindowID? = nil) {
        guard let controller, !controller.isArranging, item.isMovable else { return }
        if item.role == .bentoIcon && section != .visible {
            message = "Bento’s own icon stays in the visible section."
            return
        }
        message = nil
        arranging = true
        controller.move(item, to: section, before: before) { [weak self] result in
            guard let self else { return }
            self.arranging = false
            if case .failure(let f) = result { self.message = f.description }
            self.reload()
            self.captureImages()
        }
    }

    func item(_ id: CGWindowID) -> MenuBarItem? { allItems.first { $0.windowID == id } }

    deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }
}

/// One section as a strip of item images, laid out like the menu bar.
private struct SectionStrip: View {
    let section: MenuBarSection
    @ObservedObject var arrange: ArrangeModel
    @State private var targeted = false

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
                        ItemChip(item: item, image: arrange.images[item.windowID], overflow: arrange.overflow.contains(item.windowID),
                                 arrange: arrange)
                            .dropDestination(for: String.self) { ids, _ in
                                drop(ids, before: item.windowID)
                            }
                    }
                    if items.isEmpty {
                        Text("Drop items here").font(.callout).foregroundStyle(.secondary).padding(.horizontal, 10)
                    }
                    Spacer(minLength: 40)
                }
                .padding(.horizontal, 4)
                .frame(minHeight: 34)
            }
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(MenuBarLook.barBackground))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(Color.accentColor.opacity(targeted ? 0.9 : 0), lineWidth: 2))
            .dropDestination(for: String.self) { ids, _ in drop(ids, before: nil) } isTargeted: { targeted = $0 }
            .environment(\.colorScheme, MenuBarLook.isDark ? .dark : .light)
        }
        .padding(.vertical, 2)
    }

    private func drop(_ ids: [String], before: CGWindowID?) -> Bool {
        guard let raw = ids.first, let id = CGWindowID(raw), let item = arrange.item(id) else { return false }
        if before == id { return false }
        arrange.move(item, to: section, before: before)
        return true
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
            .modifier(Draggable(item: item))
            .contextMenu {
                ForEach(MenuBarSection.allCases) { s in
                    Button("Move to \(s.title)") { arrange.move(item, to: s) }
                        .disabled(!item.isMovable || arrange.section(of: item) == s || (item.role == .bentoIcon && s != .visible))
                }
                Divider()
                Button("Open") { arrange.open(item) }
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

private struct Draggable: ViewModifier {
    let item: MenuBarItem

    func body(content: Content) -> some View {
        if item.isMovable && item.role != .bentoIcon {
            content.draggable(String(item.windowID))
        } else {
            content
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
    let module: MenuBarModule
    let revision: Int
    let move: (MenuBarSection) -> Void

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
            Picker("Section", selection: Binding(get: { section }, set: { move($0) })) {
                ForEach(MenuBarSection.allCases.filter { $0 != .alwaysHidden || settings.alwaysHiddenSection }) { Text($0.title).tag($0) }
            }
            .labelsHidden()
            .frame(width: 130)
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
            ), placeholder: "Click Shortcut")
        }
    }
}

private struct ProfileRow: View {
    @Binding var profile: LayoutProfile
    let module: MenuBarModule
    let delete: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                TextField("Name", text: $profile.name).textFieldStyle(.roundedBorder).frame(maxWidth: 220)
                Spacer()
                Button("Apply") { module.applyProfile(profile) }
                Menu("Display") {
                    ForEach(NSScreen.screens.map(\.localizedName), id: \.self) { name in
                        Toggle(name, isOn: Binding(
                            get: { profile.displays.contains(name) },
                            set: { on in
                                if on { profile.displays.append(name) } else { profile.displays.removeAll { $0 == name } }
                            }
                        ))
                    }
                }
                .fixedSize()
                Button(role: .destructive, action: delete) { Image(systemName: "trash") }
                    .buttonStyle(.borderless)
                    .help("Delete profile")
            }
            HStack(spacing: 12) {
                Text("\(profile.layout.hidden.count) hidden, \(profile.layout.alwaysHidden.count) always hidden")
                if !profile.displays.isEmpty { Text("On \(profile.displays.joined(separator: ", "))") }
                Spacer()
                Text("bento://action/\(MenuBarModule.profileActionID(profile))").textSelection(.enabled)
            }
            .font(.caption).foregroundStyle(.secondary)
        }
    }
}
