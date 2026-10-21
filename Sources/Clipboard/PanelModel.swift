import AppKit
import Combine
import BentoCore

/// State of one open history panel. Created when the panel opens, released
/// when it closes.
final class PanelModel: ObservableObject {
    enum Action {
        case primary, paste(plain: Bool), copy, pasteIndex(Int), delete, togglePin, open, reveal, ocrCopy, actionsMenu, clearAll, close
    }

    @Published var query = "" {
        didSet { if query != oldValue { reload(resetSelection: true) } }
    }
    @Published var filter: ClipFilter = .all {
        didSet { if filter != oldValue { reload(resetSelection: true) } }
    }
    @Published private(set) var rows: [ClipRow] = []
    @Published private(set) var selectedID: Int64?
    @Published private(set) var detail: ClipDetail?
    /// Bumped when keyboard navigation should scroll the selection into view.
    @Published private(set) var scrollToken = 0

    let store: ClipStore
    let settings: ClipboardSettings
    let targetApp: NSRunningApplication?
    let state: ClipboardState
    var perform: (Action) -> Void = { _ in }
    weak var searchField: NSTextField?

    private let pageSize = 120
    private var limit = 120
    private var exhausted = false

    init(store: ClipStore, settings: ClipboardSettings, targetApp: NSRunningApplication?, state: ClipboardState) {
        self.store = store
        self.settings = settings
        self.targetApp = targetApp
        self.state = state
        reload(resetSelection: true)
    }

    // MARK: Loading

    func reload(resetSelection: Bool = false, preferIndex: Int? = nil) {
        if resetSelection { limit = pageSize }
        let fresh = store.rows(filter: filter, query: query, limit: limit)
        exhausted = fresh.count < limit
        let oldIndex = selectedIndex
        rows = fresh
        if resetSelection {
            select(fresh.first?.id, scroll: true)
        } else if let id = selectedID, fresh.contains(where: { $0.id == id }) {
            refreshDetail()
        } else {
            let i = (preferIndex ?? oldIndex ?? 0).clamped(0...max(fresh.count - 1, 0))
            select(fresh.indices.contains(i) ? fresh[i].id : nil, scroll: true)
        }
    }

    func loadMoreIfNeeded(_ row: ClipRow) {
        guard !exhausted, row.id == rows.last?.id else { return }
        limit += pageSize
        reload()
    }

    private func refreshDetail() {
        guard let id = selectedID else { detail = nil; return }
        detail = store.detail(id)
    }

    // MARK: Selection

    var selectedIndex: Int? { selectedID.flatMap { id in rows.firstIndex { $0.id == id } } }
    var selectedRow: ClipRow? { selectedIndex.map { rows[$0] } }

    func select(_ id: Int64?, scroll: Bool = false) {
        if id != selectedID {
            selectedID = id
            refreshDetail()
        }
        if scroll { scrollToken &+= 1 }
    }

    func move(_ delta: Int) {
        guard !rows.isEmpty else { return }
        let i = ((selectedIndex ?? -1) + delta).clamped(0...(rows.count - 1))
        if delta > 0, i >= rows.count - 5, !exhausted {
            limit += pageSize
            reload()
        }
        select(rows[i].id, scroll: true)
    }

    func moveToEnd(_ last: Bool) {
        guard !rows.isEmpty else { return }
        select(last ? rows[rows.count - 1].id : rows[0].id, scroll: true)
    }

    func cycleFilter() { filter = filter.next }

    // MARK: Sections

    struct Section: Identifiable {
        let id: String
        let title: String
        let rows: [(index: Int, row: ClipRow)]
    }

    /// Pinned on top, then Today / Yesterday / Earlier.
    var sections: [Section] {
        var pinned: [(Int, ClipRow)] = [], today: [(Int, ClipRow)] = [], yesterday: [(Int, ClipRow)] = [], earlier: [(Int, ClipRow)] = []
        let cal = Calendar.current
        for (i, r) in rows.enumerated() {
            if r.pinned { pinned.append((i, r)) }
            else if cal.isDateInToday(r.lastCopied) { today.append((i, r)) }
            else if cal.isDateInYesterday(r.lastCopied) { yesterday.append((i, r)) }
            else { earlier.append((i, r)) }
        }
        return [("pinned", "Pinned", pinned), ("today", "Today", today), ("yesterday", "Yesterday", yesterday), ("earlier", "Earlier", earlier)]
            .filter { !$0.2.isEmpty }
            .map { Section(id: $0.0, title: $0.1, rows: $0.2.map { (index: $0.0, row: $0.1) }) }
    }

    /// Flat list (headers + rows) for one ForEach, so a row that moves
    /// between sections (pin/unpin) is the same view and updates correctly.
    enum ListItem: Identifiable {
        case header(String, title: String, first: Bool)
        case row(index: Int, row: ClipRow)

        var id: String {
            switch self {
            case .header(let id, _, _): return "h-\(id)"
            case .row(_, let row): return Self.rowID(row.id)
            }
        }

        static func rowID(_ id: Int64) -> String { "r-\(id)" }
    }

    var listItems: [ListItem] {
        var out: [ListItem] = []
        for (i, s) in sections.enumerated() {
            out.append(.header(s.id, title: s.title, first: i == 0))
            out += s.rows.map { .row(index: $0.index, row: $0.row) }
        }
        return out
    }

    // MARK: Labels

    var primaryIsPaste: Bool { settings.returnAction == .paste }

    var targetName: String { targetApp?.localizedName ?? "Active App" }

    var primaryTitle: String { primaryIsPaste ? "Paste to \(targetName)" : "Copy to Clipboard" }
}
