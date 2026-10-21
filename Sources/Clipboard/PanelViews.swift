import AppKit
import SwiftUI
import UniformTypeIdentifiers
import BentoCore

// MARK: - Root

struct ClipboardPanelView: View {
    @ObservedObject var model: PanelModel

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(.secondary)
                SearchField(model: model)
                FilterPicker(model: model)
            }
            .padding(.leading, 18)
            .padding(.trailing, 12)
            .frame(height: 54)

            Divider()

            HStack(spacing: 0) {
                ClipListView(model: model)
                    .frame(width: 320)
                Divider()
                PreviewPane(model: model)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

            Divider()

            FooterView(model: model, state: model.state)
        }
        .frame(width: ClipboardPanel.size.width, height: ClipboardPanel.size.height)
        .ignoresSafeArea()
    }
}

// MARK: - Search

/// AppKit text field so the panel can make it first responder reliably.
struct SearchField: NSViewRepresentable {
    @ObservedObject var model: PanelModel

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeNSView(context: Context) -> NSTextField {
        let f = NSTextField()
        f.isBordered = false
        f.drawsBackground = false
        f.focusRingType = .none
        f.font = .systemFont(ofSize: 18)
        f.placeholderString = "Search clipboard history…"
        f.cell?.usesSingleLineMode = true
        f.cell?.lineBreakMode = .byTruncatingTail
        f.delegate = context.coordinator
        f.setContentHuggingPriority(.defaultLow, for: .horizontal)
        model.searchField = f
        return f
    }

    func updateNSView(_ f: NSTextField, context: Context) {
        if f.stringValue != model.query { f.stringValue = model.query }
    }

    final class Coordinator: NSObject, NSTextFieldDelegate {
        let model: PanelModel
        init(model: PanelModel) { self.model = model }

        func controlTextDidChange(_ note: Notification) {
            guard let f = note.object as? NSTextField else { return }
            model.query = f.stringValue
        }
    }
}

struct FilterPicker: View {
    @ObservedObject var model: PanelModel

    var body: some View {
        Picker("Type", selection: Binding(
            get: { model.filter },
            set: { model.filter = $0; refocus() }
        )) {
            ForEach(ClipFilter.allCases) { f in
                Label(f.title, systemImage: f.symbol).tag(f)
                if f == .all { Divider() }
            }
        }
        .pickerStyle(.menu)
        .labelsHidden()
        .fixedSize()
        .help("Filter by type (⌘P)")
    }

    private func refocus() {
        DispatchQueue.main.async {
            if let f = model.searchField { f.window?.makeFirstResponder(f) }
        }
    }
}

// MARK: - List

struct ClipListView: View {
    @ObservedObject var model: PanelModel

    var body: some View {
        if model.rows.isEmpty {
            EmptyListView(model: model, paused: model.state.paused)
        } else {
            ScrollViewReader { proxy in
                ScrollView(.vertical) {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        Color.clear.frame(height: 4).id("top")
                        ForEach(model.listItems) { item in
                            switch item {
                            case .header(_, let title, let first):
                                Text(title)
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(.secondary)
                                    .padding(.horizontal, 8)
                                    .padding(.top, first ? 2 : 10)
                                    .padding(.bottom, 3)
                            case .row(let index, let row):
                                ClipRowView(row: row, index: index, selected: row.id == model.selectedID)
                                    .contentShape(Rectangle())
                                    .onTapGesture(count: 2) {
                                        model.select(row.id)
                                        model.perform(.primary)
                                    }
                                    .simultaneousGesture(TapGesture().onEnded { model.select(row.id) })
                                    .onAppear { model.loadMoreIfNeeded(row) }
                            }
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.bottom, 6)
                }
                .scrollIndicators(.automatic)
                .onChange(of: model.scrollToken) { _, _ in
                    guard let id = model.selectedID else { return }
                    if model.selectedIndex == 0 {
                        proxy.scrollTo("top", anchor: .top)
                    } else {
                        proxy.scrollTo(PanelModel.ListItem.rowID(id))
                    }
                }
            }
        }
    }
}

struct EmptyListView: View {
    @ObservedObject var model: PanelModel
    let paused: Bool

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: symbol)
                .font(.system(size: 30, weight: .light))
                .foregroundStyle(.tertiary)
            Text(title).font(.system(size: 13, weight: .semibold))
            Text(subtitle)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var searching: Bool { !model.query.isEmpty || model.filter != .all }
    private var symbol: String { searching ? "magnifyingglass" : paused ? "pause.circle" : "doc.on.clipboard" }
    private var title: String { searching ? "No Matches" : paused ? "Monitoring Paused" : "No Clipboard History" }
    private var subtitle: String {
        if searching { return "Nothing matches “\(model.query)”" + (model.filter != .all ? " in \(model.filter.title)." : ".") }
        return paused ? "Resume from the actions menu (⌘K)." : "Copied text, images, files, links and colours appear here."
    }
}

struct ClipRowView: View {
    let row: ClipRow
    let index: Int
    let selected: Bool

    var body: some View {
        HStack(spacing: 10) {
            RowIcon(row: row)
                .frame(width: 32, height: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .font(row.kind == .color ? .system(size: 13, design: .monospaced) : .system(size: 13))
                    .lineLimit(1)
                    .truncationMode(.tail)
                HStack(spacing: 4) {
                    if let icon = ImageCache.shared.appIcon(row.sourceBundleID) {
                        Image(nsImage: icon)
                            .resizable()
                            .interpolation(.high)
                            .frame(width: 13, height: 13)
                    }
                    Text(subtitle)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            if index < 9 {
                Text("⌘\(index + 1)")
                    .font(.system(size: 11))
                    .foregroundStyle(selected ? .secondary : .tertiary)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(selected ? Color.accentColor.opacity(0.22) : .clear)
        )
    }

    private var subtitle: String {
        let time = RelativeTime.short(row.lastCopied)
        switch row.kind {
        case .link:
            if let url = ContentDetection.linkURL(row.snippet), let d = ContentDetection.domain(of: url) { return "\(d) · \(time)" }
        case .file:
            let paths = row.snippet.split(separator: "\n")
            if paths.count == 1 {
                let dir = (String(paths[0]) as NSString).deletingLastPathComponent
                return "\((dir as NSString).abbreviatingWithTildeInPath) · \(time)"
            }
        default:
            break
        }
        return time
    }
}

/// Thumbnail, file icon, colour swatch or type symbol.
struct RowIcon: View {
    let row: ClipRow

    var body: some View {
        switch row.kind {
        case .image:
            CachedImage(key: "thumb:\(row.thumbFile ?? "")", load: { [thumb = row.thumbFile] in
                ImageCache.loadThumb(thumb)
            }) { img in
                Image(nsImage: img)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fill)
                    .frame(width: 30, height: 30)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Color.primary.opacity(0.12), lineWidth: 0.5))
            } placeholder: {
                SymbolTile(symbol: "photo")
            }
        case .file:
            let first = row.snippet.split(separator: "\n").first.map(String.init) ?? ""
            Image(nsImage: ImageCache.shared.fileIcon(first))
                .resizable()
                .interpolation(.high)
                .frame(width: 30, height: 30)
        case .color:
            let c = ContentDetection.parseColor(row.snippet)
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(Color(nsColor: c?.nsColor ?? .clear))
                .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(Color.primary.opacity(0.15), lineWidth: 0.5))
                .frame(width: 24, height: 24)
        case .link:
            SymbolTile(symbol: "link", tint: .accentColor)
        case .text:
            SymbolTile(symbol: ContentDetection.looksLikeCode(row.snippet) ? "chevron.left.forwardslash.chevron.right"
                       : row.isRich ? "doc.richtext" : "text.alignleft")
        }
    }
}

struct SymbolTile: View {
    let symbol: String
    var tint: Color = .secondary

    var body: some View {
        RoundedRectangle(cornerRadius: 7, style: .continuous)
            .fill(Color.primary.opacity(0.06))
            .overlay(
                Image(systemName: symbol)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(tint)
            )
            .frame(width: 30, height: 30)
    }
}

// MARK: - Footer

struct FooterView: View {
    @ObservedObject var model: PanelModel
    @ObservedObject var state: ClipboardState

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "doc.on.clipboard")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
            Text("Clipboard History")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
            if state.paused {
                Label("Paused", systemImage: "pause.circle.fill")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.orange)
            }
            Spacer()
            FooterButton(title: model.primaryTitle, keys: ["↵"],
                         icon: model.primaryIsPaste ? model.targetApp?.icon : nil) { model.perform(.primary) }
                .disabled(model.selectedID == nil)
            Divider().frame(height: 16)
            FooterButton(title: "Actions", keys: ["⌘", "K"]) { model.perform(.actionsMenu) }
        }
        .padding(.leading, 16)
        .padding(.trailing, 10)
        .frame(height: 40)
    }
}

struct FooterButton: View {
    let title: String
    let keys: [String]
    var icon: NSImage?
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let icon {
                    Image(nsImage: icon).resizable().frame(width: 14, height: 14)
                }
                Text(title)
                    .font(.system(size: 12, weight: .medium))
                    .lineLimit(1)
                HStack(spacing: 3) {
                    ForEach(keys, id: \.self) { KeyCap(key: $0) }
                }
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
            .background(RoundedRectangle(cornerRadius: 6).fill(hover ? Color.primary.opacity(0.07) : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

struct KeyCap: View {
    let key: String

    var body: some View {
        Text(key)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(.secondary)
            .frame(minWidth: 20, minHeight: 20)
            .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(Color.primary.opacity(0.08)))
    }
}

// MARK: - Images

/// Small, panel-lifetime cache for thumbnails, icons and previews. Purged
/// when the panel closes so nothing image-sized lingers while hidden.
final class ImageCache {
    static let shared = ImageCache()
    private let cache = NSCache<NSString, NSImage>()
    private var store: ClipStore? { ImageCache.storeRef }
    static weak var storeRef: ClipStore?

    private init() { cache.countLimit = 300 }

    func purge() { cache.removeAllObjects() }

    func get(_ key: String) -> NSImage? { cache.object(forKey: key as NSString) }
    func set(_ key: String, _ image: NSImage) { cache.setObject(image, forKey: key as NSString) }

    func appIcon(_ bundleID: String?) -> NSImage? {
        guard let bundleID else { return nil }
        let key = "app:\(bundleID)"
        if let img = get(key) { return img }
        var icon: NSImage?
        if bundleID == ClipboardModule.selfBundleID {
            icon = NSApp.applicationIconImage
        } else if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) {
            icon = NSWorkspace.shared.icon(forFile: url.path)
        }
        guard let icon else { return nil }
        set(key, icon)
        return icon
    }

    func fileIcon(_ path: String) -> NSImage {
        let key = "file:\(path)"
        if let img = get(key) { return img }
        let icon: NSImage
        if FileManager.default.fileExists(atPath: path) {
            icon = NSWorkspace.shared.icon(forFile: path)
        } else {
            let ext = (path as NSString).pathExtension
            icon = NSWorkspace.shared.icon(for: UTType(filenameExtension: ext) ?? .data)
        }
        set(key, icon)
        return icon
    }

    static func loadThumb(_ name: String?) -> NSImage? {
        guard let url = storeRef?.thumbURL(name) else { return nil }
        return NSImage(contentsOf: url)
    }
}

/// Loads an image off the main thread once, through `ImageCache`.
struct CachedImage<Content: View, Placeholder: View>: View {
    let key: String
    let load: () -> NSImage?
    @ViewBuilder let content: (NSImage) -> Content
    @ViewBuilder let placeholder: () -> Placeholder
    @State private var image: NSImage?

    var body: some View {
        Group {
            if let img = image ?? ImageCache.shared.get(key) {
                content(img)
            } else {
                placeholder()
            }
        }
        .task(id: key) {
            guard image == nil, ImageCache.shared.get(key) == nil else { return }
            let loader = load
            let loaded = await Task.detached(priority: .userInitiated) { loader() }.value
            if let loaded {
                ImageCache.shared.set(key, loaded)
                image = loaded
            }
        }
    }
}

// MARK: - Formatting

enum RelativeTime {
    static func short(_ date: Date, now: Date = Date()) -> String {
        let s = now.timeIntervalSince(date)
        let cal = Calendar.current
        if s < 60 { return "Just now" }
        if s < 3600 { return "\(Int(s / 60))m ago" }
        if cal.isDateInToday(date) { return "\(Int(s / 3600))h ago" }
        if cal.isDateInYesterday(date) { return "Yesterday" }
        if s < 7 * 86_400 { return "\(max(2, Int(s / 86_400)))d ago" }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }

    static let long: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        f.doesRelativeDateFormatting = true
        return f
    }()
}
