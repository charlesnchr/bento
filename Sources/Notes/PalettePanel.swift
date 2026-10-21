import AppKit
import BentoCore

/// A row in a palette.
struct PaletteItem {
    var id: String
    var title: String
    var subtitle: String?
    /// Computed only when the row is shown (word counts of hundreds of notes are not free).
    var lazySubtitle: (() -> String)?
    /// Small coloured dot before the subtitle (Raycast's red "Current" dot).
    var subtitleDot: NSColor?
    var symbol: String?
    var image: NSImage?
    /// Shortcut shown as keycaps on the right and runnable while the palette is open.
    var shortcut: Shortcut?
    var destructive = false
    /// Buttons shown on the selected/hovered row (e.g. pin and delete in Browse Notes).
    var buttons: [PaletteButton] = []
    var action: () -> Void = {}
    /// Opens a nested list instead of running an action.
    var submenu: (() -> PaletteContent)?
    /// Checkmark for toggles.
    var checked = false
}

struct PaletteButton {
    var symbol: String
    var help: String
    var action: () -> Void
}

struct PaletteSection {
    var title: String?
    var accessory: String?
    var items: [PaletteItem]
}

/// What a palette shows: placeholder and a provider called on every query change.
struct PaletteContent {
    var placeholder: String
    var provider: (String) -> [PaletteSection]
    /// Extra key handling for the selected item (return true if handled).
    var keyHandler: ((NSEvent, PaletteItem?) -> Bool)?
    var rowHeight: CGFloat = 32
    var emptyText = "No Results"
}

/// Raycast-style floating list with a search field, attached to a parent window.
final class PalettePanel: NSObject, NSTableViewDataSource, NSTableViewDelegate, NSTextFieldDelegate, NSWindowDelegate {
    private final class Panel: KeyablePanelBase {
        override var canBecomeMain: Bool { false }
    }

    private enum Row {
        case header(String, String?)
        case separator
        case item(PaletteItem)
    }

    private let panel: Panel
    private let search = NSTextField()
    private let table = NSTableView()
    private let scroll = NSScrollView()
    private let emptyLabel = NSTextField(labelWithString: "")
    private var stack: [PaletteContent] = []
    private var rows: [Row] = []
    private var selected: Int?
    private var hovered: Int?
    private weak var parent: NSWindow?
    private var keyMonitor: Any?
    var onClose: (() -> Void)?
    var accent: NSColor = .controlAccentColor
    private(set) var isOpen = false

    private let maxHeight: CGFloat = 400
    private let searchHeight: CGFloat = 46

    override init() {
        panel = Panel(contentRect: NSRect(x: 0, y: 0, width: 380, height: 300), styleMask: [.borderless], backing: .buffered, defer: true)
        super.init()
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isReleasedWhenClosed = false
        panel.level = .floating
        panel.delegate = self
        panel.animationBehavior = .none

        let bg = NSVisualEffectView()
        bg.material = .popover
        bg.state = .active
        bg.blendingMode = .behindWindow
        bg.wantsLayer = true
        bg.layer?.cornerRadius = 10
        bg.layer?.masksToBounds = true
        bg.layer?.borderWidth = 0.5
        bg.layer?.borderColor = NSColor.separatorColor.cgColor
        panel.contentView = bg

        search.isBordered = false
        search.drawsBackground = false
        search.focusRingType = .none
        search.font = .systemFont(ofSize: 15)
        search.delegate = self
        search.cell?.usesSingleLineMode = true
        search.cell?.wraps = false
        search.cell?.isScrollable = true
        bg.addSubview(search)

        let sep = NSBox()
        sep.boxType = .separator
        bg.addSubview(sep)

        let col = NSTableColumn(identifier: .init("c"))
        col.resizingMask = .autoresizingMask
        table.addTableColumn(col)
        table.headerView = nil
        table.backgroundColor = .clear
        table.intercellSpacing = .zero
        table.selectionHighlightStyle = .none
        table.style = .plain
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.action = #selector(clicked)
        table.usesAutomaticRowHeights = false
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        scroll.documentView = table
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.contentInsets = NSEdgeInsets(top: 4, left: 0, bottom: 6, right: 0)
        scroll.automaticallyAdjustsContentInsets = false
        bg.addSubview(scroll)

        emptyLabel.textColor = .secondaryLabelColor
        emptyLabel.font = .systemFont(ofSize: 13)
        emptyLabel.alignment = .center
        emptyLabel.isHidden = true
        bg.addSubview(emptyLabel)

        for v in [search, sep, scroll, emptyLabel] as [NSView] { v.translatesAutoresizingMaskIntoConstraints = false }
        NSLayoutConstraint.activate([
            search.leadingAnchor.constraint(equalTo: bg.leadingAnchor, constant: 16),
            search.trailingAnchor.constraint(equalTo: bg.trailingAnchor, constant: -16),
            search.centerYAnchor.constraint(equalTo: bg.topAnchor, constant: searchHeight / 2),
            sep.topAnchor.constraint(equalTo: bg.topAnchor, constant: searchHeight),
            sep.leadingAnchor.constraint(equalTo: bg.leadingAnchor),
            sep.trailingAnchor.constraint(equalTo: bg.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: sep.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: bg.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: bg.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: bg.bottomAnchor),
            emptyLabel.centerXAnchor.constraint(equalTo: scroll.centerXAnchor),
            emptyLabel.centerYAnchor.constraint(equalTo: scroll.centerYAnchor),
        ])

        let tracking = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        table.addTrackingArea(tracking)
    }

    // MARK: Showing

    func show(_ content: PaletteContent, attachedTo parent: NSWindow, topInset: CGFloat) {
        self.parent = parent
        stack = [content]
        search.stringValue = ""
        reload()
        layout(attachedTo: parent, topInset: topInset)
        if panel.parent == nil { parent.addChildWindow(panel, ordered: .above) }
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(search)
        (search.currentEditor() as? NSTextView)?.insertionPointColor = accent
        isOpen = true
        installMonitor()
    }

    func close() {
        guard isOpen else { return }
        isOpen = false
        removeMonitor()
        parent?.removeChildWindow(panel)
        panel.orderOut(nil)
        stack = []
        rows = []
        table.reloadData()
        onClose?()
    }

    /// Re-runs the provider (e.g. after the underlying notes changed).
    func refresh() {
        guard isOpen else { return }
        reload(keepSelection: true)
    }

    private var currentTopInset: CGFloat = 40

    private func layout(attachedTo parent: NSWindow, topInset: CGFloat) {
        currentTopInset = topInset
        let pf = parent.frame
        let width = min(max(pf.width - 28, 320), 560)
        let rowsHeight = rows.reduce(CGFloat(0)) { $0 + self.height(of: $1) } + 12
        let panelHeight = min(maxHeight, searchHeight + max(rowsHeight, rows.isEmpty ? 80 : 0))
        var frame = NSRect(x: pf.midX - width / 2, y: pf.maxY - topInset - panelHeight, width: width, height: panelHeight)
        if let screen = parent.screen ?? NSScreen.main {
            let vf = screen.visibleFrame
            frame.origin.y = max(frame.origin.y, vf.minY + 8)
            frame.origin.x = min(max(frame.origin.x, vf.minX + 8), vf.maxX - width - 8)
        }
        panel.setFrame(frame, display: true)
        table.tableColumns.first?.width = width
    }

    // MARK: Data

    private func reload(keepSelection: Bool = false) {
        guard let content = stack.last else { return }
        search.placeholderString = content.placeholder
        let previousID: String? = keepSelection ? selectedItem?.id : nil
        rows = []
        for s in content.provider(search.stringValue) where !s.items.isEmpty {
            if let t = s.title { rows.append(.header(t, s.accessory)) } else if !rows.isEmpty { rows.append(.separator) }
            rows.append(contentsOf: s.items.map { Row.item($0) })
        }
        table.reloadData()
        selected = nil
        if let previousID, let i = rows.firstIndex(where: { if case .item(let it) = $0 { return it.id == previousID }; return false }) {
            selected = i
        } else {
            selected = rows.firstIndex { if case .item = $0 { return true }; return false }
        }
        hovered = nil
        emptyLabel.stringValue = content.emptyText
        emptyLabel.isHidden = !rows.isEmpty
        if let parent, isOpen || panel.isVisible { layout(attachedTo: parent, topInset: currentTopInset) }
        updateSelectionDisplay()
    }

    private var selectedItem: PaletteItem? {
        guard let s = selected, s < rows.count, case .item(let it) = rows[s] else { return nil }
        return it
    }

    private func height(of row: Row) -> CGFloat {
        switch row {
        case .header: return 28
        case .separator: return 9
        case .item: return stack.last?.rowHeight ?? 32
        }
    }

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat { height(of: rows[row]) }

    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool { false }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        switch rows[row] {
        case .header(let title, let acc):
            let v = PaletteHeaderView()
            v.configure(title: title, accessory: acc)
            return v
        case .separator:
            let v = NSView()
            let line = HairlineView()
            line.translatesAutoresizingMaskIntoConstraints = false
            v.addSubview(line)
            NSLayoutConstraint.activate([
                line.leadingAnchor.constraint(equalTo: v.leadingAnchor),
                line.trailingAnchor.constraint(equalTo: v.trailingAnchor),
                line.centerYAnchor.constraint(equalTo: v.centerYAnchor),
                line.heightAnchor.constraint(equalToConstant: 1),
            ])
            return v
        case .item(let item):
            let v = PaletteRowView()
            v.configure(item, twoLine: (stack.last?.rowHeight ?? 32) > 40, selected: row == selected, hovered: row == hovered)
            return v
        }
    }

    private func updateSelectionDisplay() {
        for r in 0..<rows.count {
            if let v = table.view(atColumn: 0, row: r, makeIfNecessary: false) as? PaletteRowView {
                v.setState(selected: r == selected, hovered: r == hovered)
            }
        }
        if let s = selected { table.scrollRowToVisible(s) }
    }

    // MARK: Actions

    @objc private func clicked() {
        let r = table.clickedRow
        guard r >= 0, r < rows.count, case .item = rows[r] else { return }
        // clicks on row buttons are handled by the buttons themselves
        selected = r
        activate()
    }

    private func activate() {
        guard let item = selectedItem else {
            return
        }
        if let sub = item.submenu {
            stack.append(sub())
            search.stringValue = ""
            reload()
            return
        }
        close()
        item.action()
    }

    private func isItem(_ i: Int) -> Bool {
        if case .item = rows[i] { return true }
        return false
    }

    private func move(_ delta: Int) {
        guard !rows.isEmpty else { return }
        var i = selected ?? (delta > 0 ? -1 : rows.count)
        while true {
            i += delta
            if i < 0 || i >= rows.count { return }
            if isItem(i) { break }
        }
        selected = i
        updateSelectionDisplay()
    }

    func controlTextDidChange(_ obj: Notification) { reload() }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        switch sel {
        case #selector(NSResponder.moveUp(_:)): move(-1); return true
        case #selector(NSResponder.moveDown(_:)): move(1); return true
        case #selector(NSResponder.insertNewline(_:)): activate(); return true
        case #selector(NSResponder.cancelOperation(_:)): back(); return true
        case #selector(NSResponder.deleteBackward(_:)):
            if search.stringValue.isEmpty, stack.count > 1 { back(); return true }
            return false
        default: return false
        }
    }

    private func back() {
        if stack.count > 1 {
            stack.removeLast()
            search.stringValue = ""
            reload()
        } else {
            close()
        }
    }

    // MARK: Keys (shortcuts of the selected item, Ctrl-N/P navigation)

    private func installMonitor() {
        removeMonitor()
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            guard let self, self.isOpen, e.window === self.panel else { return e }
            let mods = e.modifierFlags.intersection([.command, .control, .option, .shift])
            if mods == .control, let c = e.charactersIgnoringModifiers?.lowercased() {
                if c == "n" || c == "j" { self.move(1); return nil }
                if c == "p" || c == "k" { self.move(-1); return nil }
            }
            if let h = self.stack.last?.keyHandler, h(e, self.selectedItem) { return nil }
            // run an item by its displayed shortcut
            if !mods.isEmpty, let item = self.itemMatching(e) {
                self.close()
                item.action()
                return nil
            }
            return e
        }
    }

    private func itemMatching(_ e: NSEvent) -> PaletteItem? {
        for r in rows {
            guard case .item(let it) = r, let sc = it.shortcut, it.submenu == nil else { continue }
            if sc.matches(e) { return it }
        }
        return nil
    }

    private func removeMonitor() {
        if let m = keyMonitor { NSEvent.removeMonitor(m) }
        keyMonitor = nil
    }

    func windowDidResignKey(_ notification: Notification) {
        // Clicking elsewhere closes the palette (but not while an alert sheet is up).
        DispatchQueue.main.async { [weak self] in
            guard let self, self.isOpen, !self.panel.isKeyWindow, self.panel.attachedSheet == nil,
                  self.parent?.attachedSheet == nil else { return }
            self.close()
        }
    }

    // MARK: Debug (dev harness)

    func debugSetQuery(_ q: String) {
        search.stringValue = q
        reload()
    }

    func debugActivate() { activate() }
    var debugRowCount: Int { rows.count }
    func debugAppearance(_ a: NSAppearance?) { panel.appearance = a }
    func debugMove(_ d: Int) { move(d) }

    // MARK: Hover

    @objc func mouseMoved(with event: NSEvent) {
        let p = table.convert(event.locationInWindow, from: nil)
        let r = table.row(at: p)
        let newHover = (r >= 0 && r < rows.count && isItem(r)) ? r : nil
        if newHover != hovered {
            hovered = newHover
            if let h = newHover { selected = h }
            updateSelectionDisplay()
        }
    }

    @objc func mouseExited(with event: NSEvent) {
        hovered = nil
        updateSelectionDisplay()
    }
}

/// NSPanel that can become key while borderless.
class KeyablePanelBase: NSPanel {
    override var canBecomeKey: Bool { true }
}

// MARK: - Row views

private final class PaletteHeaderView: NSView {
    private let title = NSTextField(labelWithString: "")
    private let acc = NSTextField(labelWithString: "")

    init() {
        super.init(frame: .zero)
        for l in [title, acc] {
            l.font = .systemFont(ofSize: 12, weight: .medium)
            l.textColor = .secondaryLabelColor
            l.translatesAutoresizingMaskIntoConstraints = false
            addSubview(l)
        }
        NSLayoutConstraint.activate([
            title.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            title.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -5),
            acc.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            acc.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -5),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(title t: String, accessory: String?) {
        title.stringValue = t
        acc.stringValue = accessory ?? ""
    }
}

private final class PaletteRowView: NSView {
    private let icon = NSImageView()
    private let title = NSTextField(labelWithString: "")
    private let subtitle = NSTextField(labelWithString: "")
    private let dot = NSView()
    private let keysStack = NSStackView()
    private let buttonsStack = NSStackView()
    private let check = NSImageView()
    private var isSelected = false
    private var isHovered = false
    private var item: PaletteItem?

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        title.font = .systemFont(ofSize: 13.5)
        title.lineBreakMode = .byTruncatingTail
        title.cell?.truncatesLastVisibleLine = true
        subtitle.font = .systemFont(ofSize: 12)
        subtitle.textColor = .secondaryLabelColor
        subtitle.lineBreakMode = .byTruncatingTail
        icon.symbolConfiguration = .init(pointSize: 13, weight: .regular)
        icon.contentTintColor = .secondaryLabelColor
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 3
        keysStack.orientation = .horizontal
        keysStack.spacing = 4
        keysStack.setHuggingPriority(.required, for: .horizontal)
        buttonsStack.orientation = .horizontal
        buttonsStack.spacing = 6
        buttonsStack.setHuggingPriority(.required, for: .horizontal)
        check.image = NSImage(systemSymbolName: "checkmark", accessibilityDescription: nil)
        check.symbolConfiguration = .init(pointSize: 11, weight: .semibold)
        check.contentTintColor = .secondaryLabelColor
        for v in [icon, title, subtitle, dot, keysStack, buttonsStack, check] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            addSubview(v)
        }
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(_ item: PaletteItem, twoLine: Bool, selected: Bool, hovered: Bool) {
        self.item = item
        title.stringValue = item.title
        title.textColor = item.destructive ? .systemRed : .labelColor
        let hasIcon = item.symbol != nil || item.image != nil
        if let img = item.image {
            icon.image = img
        } else if let s = item.symbol {
            icon.image = NSImage(systemSymbolName: s, accessibilityDescription: nil)
        }
        icon.contentTintColor = item.destructive ? .systemRed : .secondaryLabelColor
        icon.isHidden = !hasIcon
        let sub = item.subtitle ?? (twoLine ? item.lazySubtitle?() : nil)
        subtitle.stringValue = sub ?? ""
        subtitle.isHidden = !twoLine || sub == nil
        dot.isHidden = subtitle.isHidden || item.subtitleDot == nil
        dot.layer?.backgroundColor = item.subtitleDot?.cgColor
        check.isHidden = !item.checked

        keysStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for k in item.shortcut.map(Keycap.keys) ?? [] { keysStack.addArrangedSubview(Keycap(k)) }
        if item.submenu != nil, item.shortcut == nil {
            let chev = NSImageView(image: NSImage(systemSymbolName: "chevron.right", accessibilityDescription: nil)!)
            chev.symbolConfiguration = .init(pointSize: 10, weight: .semibold)
            chev.contentTintColor = .tertiaryLabelColor
            keysStack.addArrangedSubview(chev)
        }
        buttonsStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for b in item.buttons {
            let btn = ClosureButton(symbol: b.symbol, help: b.help, action: b.action)
            buttonsStack.addArrangedSubview(btn)
        }

        var cs: [NSLayoutConstraint] = []
        let leading: NSLayoutXAxisAnchor = hasIcon ? icon.trailingAnchor : leadingAnchor
        let leadConst: CGFloat = hasIcon ? 10 : 18
        if hasIcon {
            cs += [icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 18),
                   icon.centerYAnchor.constraint(equalTo: centerYAnchor),
                   icon.widthAnchor.constraint(equalToConstant: 16)]
        }
        if twoLine && !subtitle.isHidden {
            cs += [title.leadingAnchor.constraint(equalTo: leading, constant: leadConst),
                   title.bottomAnchor.constraint(equalTo: centerYAnchor, constant: 0),
                   subtitle.topAnchor.constraint(equalTo: centerYAnchor, constant: 2)]
            if dot.isHidden {
                cs.append(subtitle.leadingAnchor.constraint(equalTo: title.leadingAnchor))
            } else {
                cs += [dot.leadingAnchor.constraint(equalTo: title.leadingAnchor, constant: 1),
                       dot.centerYAnchor.constraint(equalTo: subtitle.centerYAnchor),
                       dot.widthAnchor.constraint(equalToConstant: 6), dot.heightAnchor.constraint(equalToConstant: 6),
                       subtitle.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 5)]
            }
        } else {
            cs += [title.leadingAnchor.constraint(equalTo: leading, constant: leadConst),
                   title.centerYAnchor.constraint(equalTo: centerYAnchor)]
        }
        cs += [keysStack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -18),
               keysStack.centerYAnchor.constraint(equalTo: centerYAnchor),
               buttonsStack.trailingAnchor.constraint(equalTo: keysStack.leadingAnchor, constant: item.shortcut == nil ? 0 : -8),
               buttonsStack.centerYAnchor.constraint(equalTo: centerYAnchor),
               check.trailingAnchor.constraint(equalTo: buttonsStack.leadingAnchor, constant: -8),
               check.centerYAnchor.constraint(equalTo: centerYAnchor),
               title.trailingAnchor.constraint(lessThanOrEqualTo: check.leadingAnchor, constant: -8),
               subtitle.trailingAnchor.constraint(lessThanOrEqualTo: buttonsStack.leadingAnchor, constant: -8)]
        NSLayoutConstraint.activate(cs)
        setState(selected: selected, hovered: hovered)
    }

    func setState(selected: Bool, hovered: Bool) {
        isSelected = selected
        isHovered = hovered
        buttonsStack.isHidden = !(selected || hovered)
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard isSelected else { return }
        let r = bounds.insetBy(dx: 8, dy: 1)
        NSColor.labelColor.withAlphaComponent(0.09).setFill()
        NSBezierPath(roundedRect: r, xRadius: 8, yRadius: 8).fill()
    }
}

/// Small rounded key label ("⌘", "K").
final class Keycap: NSView {
    /// "⇧⌘P" -> ["⇧", "⌘", "P"]
    static func keys(_ sc: Shortcut) -> [String] {
        var out: [String] = []
        let mods: [(NSEvent.ModifierFlags, String)] = [(.control, "⌃"), (.option, "⌥"), (.shift, "⇧"), (.command, "⌘")]
        for (m, s) in mods where sc.modifiers.contains(m) { out.append(s) }
        out.append(Shortcut.keySymbol(for: sc.keyCode))
        return out
    }

    private let label: NSTextField

    init(_ text: String, fontSize: CGFloat = 11) {
        label = NSTextField(labelWithString: text)
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 4
        label.font = .systemFont(ofSize: fontSize, weight: .medium)
        label.textColor = .secondaryLabelColor
        label.alignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        translatesAutoresizingMaskIntoConstraints = false
        let w = max(20, ceil(label.intrinsicContentSize.width) + 10)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: centerXAnchor),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            heightAnchor.constraint(equalToConstant: 20),
            widthAnchor.constraint(equalToConstant: w),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    override func updateLayer() {
        layer?.backgroundColor = NSColor.labelColor.withAlphaComponent(0.08).cgColor
    }

    override var wantsUpdateLayer: Bool { true }
}

/// Borderless SF Symbol button running a closure.
final class ClosureButton: NSButton {
    private var handler: () -> Void

    init(symbol: String, help: String, pointSize: CGFloat = 13, weight: NSFont.Weight = .regular, action: @escaping () -> Void) {
        handler = action
        super.init(frame: .zero)
        image = NSImage(systemSymbolName: symbol, accessibilityDescription: help)
        symbolConfiguration = .init(pointSize: pointSize, weight: weight)
        isBordered = false
        bezelStyle = .regularSquare
        imagePosition = .imageOnly
        contentTintColor = .secondaryLabelColor
        toolTip = help
        target = self
        self.action = #selector(run)
        setButtonType(.momentaryChange)
    }

    required init?(coder: NSCoder) { fatalError() }

    func setHandler(_ h: @escaping () -> Void) { handler = h }

    @objc private func run() { handler() }
}
