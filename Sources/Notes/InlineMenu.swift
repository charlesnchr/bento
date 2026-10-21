import AppKit
import BentoCore

/// Small popup under the caret for Raycast's `/` formatting menu and `:` emoji picker.
/// It never takes key focus: the editor keeps typing (the text after the trigger is
/// the filter) and forwards ↑/↓/↩/⇥/⎋ while it is open.
final class InlineMenu: NSObject, NSTableViewDataSource, NSTableViewDelegate {
    struct Item {
        var title: String
        var symbol: String?
        var emoji: String?
        var shortcut: Shortcut?
        var apply: () -> Void
    }

    private let panel: NSPanel
    private let table = NSTableView()
    private let scroll = NSScrollView()
    private var items: [Item] = []
    private(set) var selected = 0
    private weak var parent: NSWindow?
    var isOpen: Bool { panel.isVisible }
    private let rowHeight: CGFloat = 28
    private let width: CGFloat = 240

    override init() {
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 240, height: 200), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        super.init()
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .floating
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .none
        let bg = NSVisualEffectView()
        bg.material = .popover
        bg.state = .active
        bg.blendingMode = .behindWindow
        bg.wantsLayer = true
        bg.layer?.cornerRadius = 8
        bg.layer?.masksToBounds = true
        bg.layer?.borderWidth = 0.5
        bg.layer?.borderColor = NSColor.separatorColor.cgColor
        panel.contentView = bg
        let col = NSTableColumn(identifier: .init("c"))
        table.addTableColumn(col)
        table.headerView = nil
        table.style = .plain
        table.backgroundColor = .clear
        table.intercellSpacing = .zero
        table.selectionHighlightStyle = .none
        table.rowHeight = rowHeight
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        col.resizingMask = .autoresizingMask
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.action = #selector(clicked)
        scroll.documentView = table
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.automaticallyAdjustsContentInsets = false
        scroll.contentInsets = NSEdgeInsets(top: 4, left: 0, bottom: 4, right: 0)
        scroll.translatesAutoresizingMaskIntoConstraints = false
        bg.addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: bg.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: bg.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: bg.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: bg.trailingAnchor),
        ])
    }

    /// Shows (or updates) the menu below `caretRect` (screen coordinates).
    func show(_ items: [Item], below caretRect: NSRect, parent: NSWindow) {
        self.items = items
        selected = min(selected, max(0, items.count - 1))
        table.reloadData()
        let visible = min(CGFloat(items.count), 8)
        let h = visible * rowHeight + 8
        var origin = NSPoint(x: caretRect.minX - 10, y: caretRect.minY - h - 4)
        if let vf = (parent.screen ?? NSScreen.main)?.visibleFrame {
            if origin.y < vf.minY { origin.y = caretRect.maxY + 4 } // no room below: open above
            origin.x = min(max(origin.x, vf.minX + 4), vf.maxX - width - 4)
        }
        panel.setFrame(NSRect(x: origin.x, y: origin.y, width: width, height: h), display: true)
        table.tableColumns.first?.width = width
        if self.parent !== parent || panel.parent == nil {
            self.parent?.removeChildWindow(panel)
            parent.addChildWindow(panel, ordered: .above)
            self.parent = parent
        }
        panel.orderFront(nil)
        updateRows()
    }

    func close() {
        guard panel.isVisible else { return }
        parent?.removeChildWindow(panel)
        panel.orderOut(nil)
        items = []
        selected = 0
    }

    func move(_ d: Int) {
        guard !items.isEmpty else { return }
        selected = (selected + d + items.count) % items.count
        updateRows()
        table.scrollRowToVisible(selected)
    }

    func applySelected() {
        guard selected < items.count else { return }
        let item = items[selected]
        close()
        item.apply()
    }

    @objc private func clicked() {
        let r = table.clickedRow
        guard r >= 0, r < items.count else { return }
        selected = r
        applySelected()
    }

    private func updateRows() {
        for r in 0..<items.count {
            (table.view(atColumn: 0, row: r, makeIfNecessary: false) as? InlineRow)?.isSelected = r == selected
        }
    }

    func numberOfRows(in tableView: NSTableView) -> Int { items.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let v = InlineRow()
        v.configure(items[row])
        v.isSelected = row == selected
        return v
    }

    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool { false }
}

private final class InlineRow: NSView {
    private let icon = NSImageView()
    private let emoji = NSTextField(labelWithString: "")
    private let title = NSTextField(labelWithString: "")
    private let keys = NSTextField(labelWithString: "")
    var isSelected = false { didSet { needsDisplay = true } }

    init() {
        super.init(frame: .zero)
        title.font = .systemFont(ofSize: 13)
        title.lineBreakMode = .byTruncatingTail
        keys.font = .systemFont(ofSize: 11)
        keys.textColor = .tertiaryLabelColor
        emoji.font = .systemFont(ofSize: 15)
        icon.symbolConfiguration = .init(pointSize: 12, weight: .regular)
        icon.contentTintColor = .secondaryLabelColor
        for v in [icon, emoji, title, keys] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            addSubview(v)
        }
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 18),
            emoji.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            emoji.centerYAnchor.constraint(equalTo: centerYAnchor),
            title.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 42),
            title.centerYAnchor.constraint(equalTo: centerYAnchor),
            title.trailingAnchor.constraint(lessThanOrEqualTo: keys.leadingAnchor, constant: -6),
            keys.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            keys.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(_ item: InlineMenu.Item) {
        title.stringValue = item.title
        if let e = item.emoji {
            emoji.stringValue = e
            emoji.isHidden = false
            icon.isHidden = true
        } else {
            emoji.isHidden = true
            icon.isHidden = item.symbol == nil
            icon.image = item.symbol.flatMap { NSImage(systemSymbolName: $0, accessibilityDescription: nil) }
        }
        keys.stringValue = item.shortcut?.displayString ?? ""
    }

    override func draw(_ dirtyRect: NSRect) {
        guard isSelected else { return }
        NSColor.labelColor.withAlphaComponent(0.09).setFill()
        NSBezierPath(roundedRect: bounds.insetBy(dx: 5, dy: 1), xRadius: 6, yRadius: 6).fill()
    }
}

/// Emoji names from Unicode scalar properties (no bundled data).
enum EmojiIndex {
    struct Entry { let emoji: String; let name: String }

    static let all: [Entry] = {
        var out: [Entry] = []
        let ranges: [ClosedRange<UInt32>] = [0x1F300...0x1F5FF, 0x1F600...0x1F64F, 0x1F680...0x1F6FF, 0x1F900...0x1F9FF,
                                              0x1FA70...0x1FAFF, 0x2600...0x26FF, 0x2700...0x27BF, 0x2B00...0x2BFF, 0x1F1E6...0x1F1FF]
        for r in ranges {
            for v in r {
                guard let s = Unicode.Scalar(v), s.properties.isEmojiPresentation, let name = s.properties.name else { continue }
                if (0x1F1E6...0x1F1FF).contains(v) { continue } // regional indicators alone aren't useful
                out.append(Entry(emoji: String(s), name: name.lowercased()))
            }
        }
        return out
    }()

    /// Common shortcodes (Slack/GitHub style) so the usual queries rank like other pickers.
    static let aliases: [(String, String)] = [
        ("smile", "😄"), ("smiley", "😃"), ("slightly smiling", "🙂"), ("grin", "😁"), ("laughing", "😆"), ("joy", "😂"),
        ("rofl", "🤣"), ("sweat smile", "😅"), ("wink", "😉"), ("blush", "😊"), ("heart eyes", "😍"), ("kiss", "😘"),
        ("thinking", "🤔"), ("sunglasses", "😎"), ("party", "🥳"), ("sob", "😭"), ("cry", "😢"), ("angry", "😠"),
        ("heart", "❤️"), ("thumbsup", "👍"), ("+1", "👍"), ("thumbsdown", "👎"), ("-1", "👎"), ("clap", "👏"),
        ("pray", "🙏"), ("ok hand", "👌"), ("muscle", "💪"), ("wave", "👋"), ("raised hands", "🙌"), ("point right", "👉"),
        ("eyes", "👀"), ("fire", "🔥"), ("tada", "🎉"), ("rocket", "🚀"), ("sparkles", "✨"), ("star", "⭐"), ("100", "💯"),
        ("check", "✅"), ("white check mark", "✅"), ("heavy check mark", "✔️"), ("x", "❌"), ("warning", "⚠️"),
        ("question", "❓"), ("exclamation", "❗"), ("zap", "⚡"), ("bulb", "💡"), ("memo", "📝"), ("pencil", "✏️"),
        ("pin", "📌"), ("pushpin", "📌"), ("link", "🔗"), ("lock", "🔒"), ("key", "🔑"), ("calendar", "📅"),
        ("clipboard", "📋"), ("books", "📚"), ("folder", "📁"), ("paperclip", "📎"), ("hourglass", "⏳"),
        ("construction", "🚧"), ("bug", "🐛"), ("gear", "⚙️"), ("hammer", "🔨"), ("wrench", "🔧"), ("robot", "🤖"),
        ("computer", "💻"), ("phone", "📱"), ("mail", "📧"), ("bell", "🔔"), ("chart", "📈"), ("money", "💰"),
        ("trophy", "🏆"), ("dart", "🎯"), ("gem", "💎"), ("gift", "🎁"), ("cake", "🎂"), ("coffee", "☕"),
        ("beer", "🍺"), ("pizza", "🍕"), ("house", "🏠"), ("car", "🚗"), ("airplane", "✈️"), ("sun", "☀️"),
        ("moon", "🌙"), ("cloud", "☁️"), ("snowflake", "❄️"), ("rainbow", "🌈"), ("poop", "💩"), ("ghost", "👻"),
        ("skull", "💀"), ("see no evil", "🙈"), ("unicorn", "🦄"), ("dog", "🐶"), ("cat", "🐱"), ("brain", "🧠"),
    ]

    /// Best matches for a query like "smil" or "thumbs up".
    static func search(_ q: String, limit: Int = 30) -> [Entry] {
        let words = q.lowercased().replacingOccurrences(of: "_", with: " ").split(separator: " ").map(String.init)
        guard !words.isEmpty else { return [] }
        var scored: [(Entry, Int)] = []
        let joined = words.joined(separator: " ")
        var seen = Set<String>()
        for (alias, emoji) in aliases where alias.hasPrefix(joined) || alias.replacingOccurrences(of: " ", with: "").hasPrefix(joined) {
            let name = all.first { $0.emoji == emoji }?.name ?? alias
            scored.append((Entry(emoji: emoji, name: name), 1_000_000 - alias.count * 10 - aliases.firstIndex { $0.0 == alias }!))
            seen.insert(emoji)
        }
        for e in all where !seen.contains(e.emoji) {
            let nameWords = e.name.split(separator: " ")
            var score = 0
            var ok = true
            for w in words {
                if let i = nameWords.firstIndex(where: { $0.hasPrefix(w) }) {
                    score += nameWords[i].count == w.count ? 30 : 20
                    if i == 0 { score += 5 }
                } else if e.name.contains(w) {
                    score += 5
                } else { ok = false; break }
            }
            if ok { scored.append((e, score * 100 - e.name.count)) }
        }
        return scored.sorted { $0.1 > $1.1 }.prefix(limit).map(\.0)
    }
}
