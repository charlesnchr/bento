import AppKit
import Quartz
import BentoCore

/// Capture history browser: thumbnail grid, newest first. ↩ / double-click
/// opens in the editor, ⌘C copies, ⌘⌫ moves to Trash, Space previews.
final class HistoryWindowController: NSObject, NSWindowDelegate, NSCollectionViewDataSource, NSCollectionViewDelegate,
    QLPreviewPanelDataSource, QLPreviewPanelDelegate {
    let window: NSWindow
    private let collection = HistoryCollectionView()
    private let emptyLabel = NSTextField(labelWithString: "No captures yet")
    private(set) var entries: [HistoryStore.Entry] = []
    private let thumbs = NSCache<NSString, NSImage>()
    var onClose: (() -> Void)?

    override init() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 620),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        super.init()
        window.title = "Capture History"
        window.isReleasedWhenClosed = false
        window.isRestorable = false
        window.delegate = self
        window.minSize = NSSize(width: 460, height: 320)
        window.tabbingMode = .disallowed
        window.toolbarStyle = .unified
        window.toolbar = NSToolbar(identifier: "BentoHistory")
        window.setFrameAutosaveName("BentoCaptureHistory")

        let layout = NSCollectionViewFlowLayout()
        layout.itemSize = NSSize(width: 204, height: 178)
        layout.minimumInteritemSpacing = 12
        layout.minimumLineSpacing = 12
        layout.sectionInset = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        collection.collectionViewLayout = layout
        collection.isSelectable = true
        collection.allowsMultipleSelection = true
        collection.backgroundColors = [.clear]
        collection.dataSource = self
        collection.delegate = self
        collection.controller = self
        collection.register(HistoryItem.self, forItemWithIdentifier: HistoryItem.id)

        let scroll = NSScrollView()
        scroll.documentView = collection
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        let effect = NSVisualEffectView()
        effect.material = .contentBackground
        effect.blendingMode = .behindWindow
        scroll.translatesAutoresizingMaskIntoConstraints = false
        effect.addSubview(scroll)
        emptyLabel.font = .systemFont(ofSize: 15)
        emptyLabel.textColor = .secondaryLabelColor
        emptyLabel.translatesAutoresizingMaskIntoConstraints = false
        effect.addSubview(emptyLabel)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: effect.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: effect.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: effect.safeAreaLayoutGuide.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: effect.bottomAnchor),
            emptyLabel.centerXAnchor.constraint(equalTo: effect.centerXAnchor),
            emptyLabel.centerYAnchor.constraint(equalTo: effect.centerYAnchor),
        ])
        window.contentView = effect
        reload()
    }

    func show() {
        AppActivation.activateSelf()
        if !window.isVisible { window.center() }
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        window.makeFirstResponder(collection)
        if collection.selectionIndexPaths.isEmpty, !entries.isEmpty {
            collection.selectionIndexPaths = [IndexPath(item: 0, section: 0)]
        }
    }

    func reload() {
        let selectedIDs = Set(selectedEntries.map(\.id))
        entries = HistoryStore.shared.entries()
        collection.reloadData()
        let keep = entries.indices.filter { selectedIDs.contains(entries[$0].id) }.map { IndexPath(item: $0, section: 0) }
        collection.selectionIndexPaths = Set(keep)
        emptyLabel.isHidden = !entries.isEmpty
        let days = EditorSettings.current.historyRetentionDays
        window.subtitle = "\(entries.count) capture\(entries.count == 1 ? "" : "s")" + (days > 0 ? " · kept for \(days) days" : "")
        if let panel = QLPreviewPanel.sharedPreviewPanelExists() ? QLPreviewPanel.shared() : nil, panel.isVisible { panel.reloadData() }
    }

    func windowWillClose(_ notification: Notification) {
        if QLPreviewPanel.sharedPreviewPanelExists(), QLPreviewPanel.shared().isVisible { QLPreviewPanel.shared().orderOut(nil) }
        thumbs.removeAllObjects()
        entries = []
        collection.reloadData()
        onClose?()
    }

    var selectedEntries: [HistoryStore.Entry] {
        collection.selectionIndexPaths.map(\.item).sorted().compactMap { entries.indices.contains($0) ? entries[$0] : nil }
    }

    // MARK: Commands

    func openSelected() {
        let sel = selectedEntries
        guard !sel.isEmpty else { return }
        for e in sel.prefix(5) { _ = ShotEditor.shared.reopen(entryID: e.id) }
    }

    func copySelected() {
        guard let e = selectedEntries.first, let img = flattened(e) else { return }
        Clipboard.copy(img, scale: e.doc.scale)
        Feedback.hud("Copied", symbol: "doc.on.doc")
    }

    func deleteSelected() {
        let sel = selectedEntries
        guard !sel.isEmpty else { return }
        let first = collection.selectionIndexPaths.map(\.item).min() ?? 0
        for e in sel { HistoryStore.shared.trash(e.id) }
        collection.selectionIndexPaths = []
        reload()
        if !entries.isEmpty { collection.selectionIndexPaths = [IndexPath(item: min(first, entries.count - 1), section: 0)] }
    }

    func pinSelected() {
        guard let e = selectedEntries.first, let img = flattened(e) else { return }
        ShotEditor.shared.pinImage(img, scale: e.doc.scale, entryID: e.id, rect: .zero)
    }

    func revealSelected() {
        NSWorkspace.shared.activateFileViewerSelecting(selectedEntries.map(\.imageURL))
    }

    func saveSelectedAs() {
        guard let e = selectedEntries.first else { return }
        let save = SaveSettings.current
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.png, .jpeg]
        panel.directoryURL = save.folderURL
        panel.nameFieldStringValue = FilenamePattern.expand(save.filenamePattern, date: e.doc.created, app: e.doc.sourceAppName,
                                                            kind: e.doc.kind, size: e.doc.canvasRect.size) + "." + save.format.ext
        panel.beginSheetModal(for: window) { [weak self] resp in
            guard resp == .OK, let url = panel.url, let img = self?.flattened(e) else { return }
            let format: EditorSettings.Format = ["jpg", "jpeg"].contains(url.pathExtension.lowercased()) ? .jpeg : .png
            try? ImageCodec.write(img, scale: e.doc.scale, format: format, quality: save.jpegQuality, to: url)
        }
    }

    private func flattened(_ e: HistoryStore.Entry) -> CGImage? {
        guard let image = HistoryStore.shared.loadImage(e) else { return nil }
        return Renderer.flatten(e.doc, image: image, effects: EffectCache())
    }

    func contextMenu() -> NSMenu {
        let m = NSMenu()
        func add(_ title: String, _ key: String = "", _ mods: NSEvent.ModifierFlags = [.command], _ handler: @escaping () -> Void) {
            let i = ClosureMenuItem(title: title, keyEquivalent: key, handler: handler)
            i.keyEquivalentModifierMask = mods
            m.addItem(i)
        }
        add("Open in Editor", "\r", []) { [weak self] in self?.openSelected() }
        add("Copy", "c") { [weak self] in self?.copySelected() }
        add("Pin to Screen") { [weak self] in self?.pinSelected() }
        add("Save As…") { [weak self] in self?.saveSelectedAs() }
        add("Show in Finder") { [weak self] in self?.revealSelected() }
        m.addItem(.separator())
        add("Move to Trash", "\u{8}") { [weak self] in self?.deleteSelected() }
        return m
    }

    // MARK: Data source

    func collectionView(_ collectionView: NSCollectionView, numberOfItemsInSection section: Int) -> Int { entries.count }

    func collectionView(_ collectionView: NSCollectionView, itemForRepresentedObjectAt indexPath: IndexPath) -> NSCollectionViewItem {
        let item = collectionView.makeItem(withIdentifier: HistoryItem.id, for: indexPath) as! HistoryItem
        let e = entries[indexPath.item]
        let key = "\(e.id)-\(e.doc.modified.timeIntervalSince1970)" as NSString
        var thumb = thumbs.object(forKey: key)
        if thumb == nil, let img = NSImage(contentsOf: e.thumbURL) {
            thumbs.setObject(img, forKey: key)
            thumb = img
        }
        item.configure(entry: e, thumbnail: thumb)
        return item
    }

    func collectionView(_ collectionView: NSCollectionView, didSelectItemsAt indexPaths: Set<IndexPath>) { refreshPreview() }
    func collectionView(_ collectionView: NSCollectionView, didDeselectItemsAt indexPaths: Set<IndexPath>) { refreshPreview() }

    private func refreshPreview() {
        if QLPreviewPanel.sharedPreviewPanelExists(), QLPreviewPanel.shared().isVisible { QLPreviewPanel.shared().reloadData() }
    }

    // MARK: Quick Look

    func togglePreview() {
        guard let panel = QLPreviewPanel.shared() else { return }
        if panel.isVisible { panel.orderOut(nil) } else { panel.makeKeyAndOrderFront(nil) }
    }

    func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int { min(selectedEntries.count, 1) }

    func previewPanel(_ panel: QLPreviewPanel!, previewItemAt index: Int) -> QLPreviewItem! {
        guard let e = selectedEntries.first else { return nil }
        if !e.doc.isEdited { return e.imageURL as NSURL }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("BentoPreview", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("\(e.id).png")
        if let img = flattened(e) { try? ImageCodec.write(img, scale: e.doc.scale, format: .png, to: url) }
        return url as NSURL
    }

    func previewPanel(_ panel: QLPreviewPanel!, handle event: NSEvent!) -> Bool {
        if event.type == .keyDown {
            collection.keyDown(with: event)
            return true
        }
        return false
    }
}

final class HistoryCollectionView: NSCollectionView {
    weak var controller: HistoryWindowController?

    override func keyDown(with e: NSEvent) {
        let mods = e.modifierFlags.intersection([.command, .shift, .option, .control])
        switch Int(e.keyCode) {
        case 36, 76: controller?.openSelected()
        case 49: controller?.togglePreview()
        case 51 where mods.contains(.command), 117 where mods.contains(.command): controller?.deleteSelected()
        case 53: window?.performClose(nil)
        default: super.keyDown(with: e)
        }
    }

    override func performKeyEquivalent(with e: NSEvent) -> Bool {
        let mods = e.modifierFlags.intersection([.command, .shift, .option, .control])
        guard mods == .command else { return super.performKeyEquivalent(with: e) }
        switch e.charactersIgnoringModifiers?.lowercased() {
        case "c": controller?.copySelected()
        case "w": window?.performClose(nil)
        default:
            if e.keyCode == 51 || e.keyCode == 117 { controller?.deleteSelected(); return true }
            return super.performKeyEquivalent(with: e)
        }
        return true
    }

    @objc func copy(_ sender: Any?) { controller?.copySelected() }

    override func mouseDown(with e: NSEvent) {
        super.mouseDown(with: e)
        if e.clickCount == 2 { controller?.openSelected() }
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let p = convert(event.locationInWindow, from: nil)
        if let ip = indexPathForItem(at: p), !selectionIndexPaths.contains(ip) { selectionIndexPaths = [ip] }
        return selectionIndexPaths.isEmpty ? nil : controller?.contextMenu()
    }

    override func acceptsPreviewPanelControl(_ panel: QLPreviewPanel!) -> Bool { true }

    override func beginPreviewPanelControl(_ panel: QLPreviewPanel!) {
        panel.dataSource = controller
        panel.delegate = controller
    }

    override func endPreviewPanelControl(_ panel: QLPreviewPanel!) {
        panel.dataSource = nil
        panel.delegate = nil
    }
}

final class HistoryItem: NSCollectionViewItem {
    static let id = NSUserInterfaceItemIdentifier("HistoryItem")
    private let thumb = NSImageView()
    private let titleLabel = NSTextField(labelWithString: "")
    private let detail = NSTextField(labelWithString: "")
    private let badge = NSImageView()

    override func loadView() {
        let v = NSView()
        v.wantsLayer = true
        v.layer?.cornerRadius = 10
        thumb.imageScaling = .scaleProportionallyUpOrDown
        thumb.wantsLayer = true
        thumb.layer?.cornerRadius = 4
        thumb.layer?.masksToBounds = true
        titleLabel.font = .systemFont(ofSize: 12, weight: .medium)
        titleLabel.lineBreakMode = .byTruncatingTail
        detail.font = .systemFont(ofSize: 11)
        detail.textColor = .secondaryLabelColor
        detail.lineBreakMode = .byTruncatingTail
        badge.image = NSImage(systemSymbolName: "pencil.tip.crop.circle", accessibilityDescription: "Edited")
        badge.contentTintColor = .secondaryLabelColor
        badge.toolTip = "Has annotations"
        for s in [thumb, titleLabel, detail, badge] {
            s.translatesAutoresizingMaskIntoConstraints = false
            v.addSubview(s)
        }
        NSLayoutConstraint.activate([
            thumb.leadingAnchor.constraint(equalTo: v.leadingAnchor, constant: 10),
            thumb.trailingAnchor.constraint(equalTo: v.trailingAnchor, constant: -10),
            thumb.topAnchor.constraint(equalTo: v.topAnchor, constant: 10),
            thumb.heightAnchor.constraint(equalToConstant: 122),
            titleLabel.leadingAnchor.constraint(equalTo: v.leadingAnchor, constant: 10),
            titleLabel.trailingAnchor.constraint(lessThanOrEqualTo: badge.leadingAnchor, constant: -4),
            titleLabel.topAnchor.constraint(equalTo: thumb.bottomAnchor, constant: 6),
            detail.leadingAnchor.constraint(equalTo: v.leadingAnchor, constant: 10),
            detail.trailingAnchor.constraint(equalTo: v.trailingAnchor, constant: -10),
            detail.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 1),
            badge.trailingAnchor.constraint(equalTo: v.trailingAnchor, constant: -10),
            badge.centerYAnchor.constraint(equalTo: titleLabel.centerYAnchor),
            badge.widthAnchor.constraint(equalToConstant: 14),
            badge.heightAnchor.constraint(equalToConstant: 14),
        ])
        view = v
    }

    override var isSelected: Bool { didSet { updateSelection() } }
    override var highlightState: NSCollectionViewItem.HighlightState { didSet { updateSelection() } }

    private func updateSelection() {
        let on = isSelected || highlightState == .forSelection
        view.layer?.backgroundColor = on ? NSColor.controlAccentColor.withAlphaComponent(0.28).cgColor : NSColor.clear.cgColor
        view.layer?.borderWidth = on ? 1.5 : 0
        view.layer?.borderColor = NSColor.controlAccentColor.cgColor
    }

    func configure(entry e: HistoryStore.Entry, thumbnail: NSImage?) {
        thumb.image = thumbnail ?? NSImage(systemSymbolName: "photo", accessibilityDescription: nil)
        titleLabel.stringValue = HistoryItem.relativeDate(e.doc.created)
        let size = e.doc.canvasRect.size
        var parts = ["\(Int(size.width))×\(Int(size.height))"]
        if let app = e.doc.sourceAppName, !app.isEmpty { parts.insert(app, at: 0) }
        detail.stringValue = parts.joined(separator: " · ")
        badge.isHidden = !e.doc.isEdited
        view.toolTip = "\(e.doc.kind.capitalized) capture, \(DateFormatter.localizedString(from: e.doc.created, dateStyle: .long, timeStyle: .medium))"
        updateSelection()
    }

    static func relativeDate(_ d: Date) -> String {
        let cal = Calendar.current
        let time = DateFormatter.localizedString(from: d, dateStyle: .none, timeStyle: .short)
        if cal.isDateInToday(d) { return "Today \(time)" }
        if cal.isDateInYesterday(d) { return "Yesterday \(time)" }
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate(cal.isDate(d, equalTo: Date(), toGranularity: .year) ? "EEE d MMM" : "d MMM yyyy")
        return "\(f.string(from: d)) \(time)"
    }
}
