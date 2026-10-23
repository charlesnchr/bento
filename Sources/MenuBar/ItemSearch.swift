import AppKit
import SwiftUI
import BentoCore

/// Quick search for menu bar items (`menubar.search`): type part of an item's
/// or app's name, ↑/↓ to pick, Return to open its menu (⇧Return right-clicks).
/// A non-activating panel, so the frontmost app stays active; torn down on close.
final class ItemSearch: NSObject, NSWindowDelegate {
    private unowned let controller: MenuBarController
    private var panel: KeyablePanel?
    private var model: SearchModel?
    private var keyMonitor: Any?

    static let size = NSSize(width: 520, height: 380)

    init(controller: MenuBarController) {
        self.controller = controller
    }

    var isOpen: Bool { panel != nil }

    func toggle() {
        if isOpen { close() } else { show() }
    }

    func show() {
        guard panel == nil else { return }
        let sections = controller.sections()
        let model = SearchModel()
        model.activate = { [weak self] item, right in
            guard let self else { return }
            self.close()
            // Let the panel go before the click, so focus returns first.
            DispatchQueue.main.async { self.controller.activate(item, right: right) }
        }
        self.model = model

        let p = KeyablePanel(contentRect: NSRect(origin: .zero, size: Self.size),
                             styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel], backing: .buffered, defer: true)
        p.title = "Search Menu Bar"
        p.titleVisibility = .hidden
        p.titlebarAppearsTransparent = true
        for b in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] { p.standardWindowButton(b)?.isHidden = true }
        p.isMovableByWindowBackground = true
        p.isFloatingPanel = true
        p.level = .floating
        p.hidesOnDeactivate = false
        p.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary, .transient, .ignoresCycle]
        p.isReleasedWhenClosed = false
        p.isOpaque = false
        p.backgroundColor = .clear
        p.delegate = self

        let effect = NSVisualEffectView()
        effect.material = .popover
        effect.blendingMode = .behindWindow
        effect.state = .active
        let host = NSHostingView(rootView: SearchView(model: model))
        host.sizingOptions = []
        host.translatesAutoresizingMaskIntoConstraints = false
        effect.addSubview(host)
        NSLayoutConstraint.activate([
            host.leadingAnchor.constraint(equalTo: effect.leadingAnchor),
            host.trailingAnchor.constraint(equalTo: effect.trailingAnchor),
            host.topAnchor.constraint(equalTo: effect.topAnchor),
            host.bottomAnchor.constraint(equalTo: effect.bottomAnchor),
        ])
        p.contentView = effect
        if let vf = (NSScreen.underMouse ?? NSScreen.main)?.visibleFrame {
            p.setFrameOrigin(NSPoint(x: (vf.midX - Self.size.width / 2).rounded(),
                                     y: (vf.minY + (vf.height - Self.size.height) * 0.7).rounded()))
        }
        panel = p
        p.makeKeyAndOrderFront(nil)
        p.orderFrontRegardless()

        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            guard let self, e.window === self.panel else { return e }
            return self.handleKey(e) ? nil : e
        }
        // Current items, then names, owners and images as they come in.
        model.set(items: controller.items, sections: sections)
        controller.refresh(details: true) { [weak self, weak model] in
            guard let self, let model, self.panel != nil else { return }
            let items = self.controller.items.filter { item in
                if case .control = item.role { return false }
                return true
            }
            model.set(items: items, sections: self.controller.sections())
            ItemImages.capture(items) { [weak model] images in model?.images = images }
        }
    }

    func close() {
        guard let p = panel else { return }
        panel = nil
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        keyMonitor = nil
        p.delegate = nil
        p.orderOut(nil)
        p.contentView = nil
        model = nil
    }

    func windowDidResignKey(_ notification: Notification) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let p = self.panel, !p.isKeyWindow else { return }
            self.close()
        }
    }

    private func handleKey(_ e: NSEvent) -> Bool {
        guard let model else { return false }
        let mods = e.modifierFlags.intersection([.command, .option, .control, .shift])
        switch (e.keyCode, mods) {
        case (125, []), (45, [.control]), (38, [.control]): model.move(1)     // ↓ ⌃N ⌃J
        case (126, []), (35, [.control]), (40, [.control]): model.move(-1)    // ↑ ⌃P ⌃K
        case (36, []), (76, []): model.activateSelected(right: false)
        case (36, [.shift]), (76, [.shift]): model.activateSelected(right: true)
        case (53, []): if model.query.isEmpty { close() } else { model.query = "" }
        case (13, [.command]): close()
        default: return false
        }
        return true
    }
}

/// Fuzzy matching of a query against an item's name, app and description.
enum ItemMatch {
    /// A score (higher is better), or nil when the item doesn't match.
    static func score(_ query: String, item: MenuBarItem) -> Int? {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return 0 }
        let fields: [(String, Int)] = [(item.name, 3), (item.appName, 2), (item.subtitle ?? "", 1), (item.bundleID ?? "", 0)]
        var best: Int?
        for (text, weight) in fields where !text.isEmpty {
            guard let s = score(q, in: text.lowercased()) else { continue }
            best = max(best ?? Int.min, s + weight * 10)
        }
        return best
    }

    /// Prefix > word start > substring > in-order letters.
    static func score(_ q: String, in text: String) -> Int? {
        if text.hasPrefix(q) { return 300 - text.count }
        if let r = text.range(of: q) {
            let atWord = r.lowerBound == text.startIndex || !text[text.index(before: r.lowerBound)].isLetter
            return (atWord ? 200 : 100) - text.count
        }
        var it = text.makeIterator()
        for c in q {
            var found = false
            while let t = it.next() { if t == c { found = true; break } }
            if !found { return nil }
        }
        return 10 - text.count
    }
}

final class SearchModel: ObservableObject {
    @Published var query = "" { didSet { filter() } }
    @Published private(set) var results: [MenuBarItem] = []
    @Published var selected = 0
    @Published var images: [CGWindowID: NSImage] = [:]
    private(set) var sections: [CGWindowID: MenuBarSection] = [:]
    private var all: [MenuBarItem] = []
    var activate: (MenuBarItem, Bool) -> Void = { _, _ in }

    func set(items: [MenuBarItem], sections: [CGWindowID: MenuBarSection]) {
        let selectedID = results.indices.contains(selected) ? results[selected].windowID : nil
        all = items.filter {
            if case .control = $0.role { return false }
            return true
        }
        self.sections = sections
        filter()
        if let selectedID, let i = results.firstIndex(where: { $0.windowID == selectedID }) { selected = i }
    }

    private func filter() {
        let order: [MenuBarSection] = [.hidden, .alwaysHidden, .visible]
        if query.trimmingCharacters(in: .whitespaces).isEmpty {
            // Hidden items first (that's what you can't see), each right to left.
            results = all.sorted {
                let a = order.firstIndex(of: sections[$0.windowID] ?? .visible) ?? 0
                let b = order.firstIndex(of: sections[$1.windowID] ?? .visible) ?? 0
                return a != b ? a < b : $0.frame.midX > $1.frame.midX
            }
        } else {
            results = all.compactMap { item in ItemMatch.score(query, item: item).map { (item, $0) } }
                .sorted { $0.1 != $1.1 ? $0.1 > $1.1 : $0.0.name < $1.0.name }
                .map(\.0)
        }
        selected = min(selected, max(0, results.count - 1))
        if query.isEmpty { selected = 0 }
    }

    func move(_ delta: Int) {
        guard !results.isEmpty else { return }
        selected = min(max(selected + delta, 0), results.count - 1)
    }

    func activateSelected(right: Bool) {
        guard results.indices.contains(selected) else { return }
        activate(results[selected], right)
    }
}

private struct SearchView: View {
    @ObservedObject var model: SearchModel
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary).font(.title3)
                TextField("Search menu bar items", text: $model.query)
                    .textFieldStyle(.plain)
                    .font(.title3)
                    .focused($focused)
                    .onSubmit { model.activateSelected(right: false) }
            }
            .padding(.horizontal, 16)
            .frame(height: 50)
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(Array(model.results.enumerated()), id: \.element.windowID) { index, item in
                            row(item, selected: index == model.selected)
                                .id(item.windowID)
                                .onTapGesture { model.selected = index; model.activateSelected(right: false) }
                        }
                    }
                    .padding(6)
                }
                .onChange(of: model.selected) { _, i in
                    if model.results.indices.contains(i) { proxy.scrollTo(model.results[i].windowID) }
                }
            }
            if model.results.isEmpty {
                Text(model.query.isEmpty ? "Reading the menu bar…" : "No matching items")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            Divider()
            HStack(spacing: 14) {
                hint("↩", "Open")
                hint("⇧↩", "Right-Click")
                hint("esc", "Close")
                Spacer()
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 14)
            .frame(height: 30)
        }
        .frame(width: ItemSearch.size.width, height: ItemSearch.size.height)
        .onAppear { focused = true }
    }

    private func hint(_ key: String, _ title: String) -> some View {
        HStack(spacing: 4) {
            Text(key).padding(.horizontal, 4).background(RoundedRectangle(cornerRadius: 3).fill(.quaternary))
            Text(title)
        }
    }

    private func row(_ item: MenuBarItem, selected: Bool) -> some View {
        HStack(spacing: 10) {
            ItemThumbnail(item: item, image: model.images[item.windowID], height: 22)
                .frame(width: 44)
            VStack(alignment: .leading, spacing: 1) {
                Text(item.name).lineLimit(1)
                Text([item.appName, item.subtitle].compactMap { $0 }.filter { !$0.isEmpty && $0 != item.name }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            let section = model.sections[item.windowID] ?? .visible
            Label(section.title, systemImage: section.symbol)
                .labelStyle(.titleAndIcon)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .frame(height: 38)
        .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(selected ? Color.accentColor.opacity(0.22) : .clear))
        .contentShape(Rectangle())
    }
}

/// An item's captured image on a menu-bar-like background (or its app icon).
struct ItemThumbnail: View {
    let item: MenuBarItem
    let image: NSImage?
    var height: CGFloat = 22

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .frame(height: height)
            } else if let icon = ItemImages.appIcon(for: item) {
                Image(nsImage: icon).resizable().frame(width: height * 0.8, height: height * 0.8)
            } else {
                Image(systemName: "menubar.rectangle").foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 2)
        .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(Color.primary.opacity(0.08)))
    }
}
