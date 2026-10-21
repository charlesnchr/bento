import AppKit
import SwiftUI
import UniformTypeIdentifiers
import BentoCore

/// Owns the notes data (store + sync) and implements every notes command.
/// The window is created on first use.
final class NotesController {
    let store: NoteStore
    let engine: SyncEngine
    let sync: SyncClient
    private(set) var settings: NotesSettings
    private var windowController: NotesWindowController?
    private let log = BentoLog.make("notes")

    private(set) var currentID: String?
    private var pendingSave: DispatchWorkItem?
    private var hasPending = false
    private var backStack: [String] = []
    private var forwardStack: [String] = []
    private var selections: [String: NSRange] = [:]
    private var countCache: [String: (Int64, Int, Int)] = [:]
    private var observers: [NSObjectProtocol] = []
    private var statusItem: NSStatusItem?
    private var running = false
    private var paletteRefreshQueued = false

    init(store: NoteStore = NoteStore()) {
        self.store = store
        engine = SyncEngine(repo: store)
        sync = SyncClient(engine: engine)
        settings = ConfigStore.shared.section("notes", default: NotesSettings())
        backStack = store.kvJSON("nav.back", as: [String].self) ?? []
        forwardStack = store.kvJSON("nav.forward", as: [String].self) ?? []
        currentID = store.kv("lastNoteID")
        engine.beforeApply = { [weak self] id in
            if id == self?.currentID { self?.flushPendingSave() }
        }
        engine.onRemoteChange = { [weak self] note, _ in self?.remoteChanged(note) }
        engine.onConflictCopy = { [weak self] copy, _ in
            self?.countCache.removeValue(forKey: copy.id)
            // only tell someone who is looking at notes; the copy tops the list either way
            if self?.windowController?.isVisible == true { HUD.show("Conflicting Edit Kept as a Copy", symbol: "doc.on.doc") }
        }
    }

    // MARK: Lifecycle

    func start() {
        guard !running else { return }
        running = true
        ConfigStore.shared.materialize("notes", default: NotesSettings())
        settings = ConfigStore.shared.section("notes", default: NotesSettings())
        observers.append(ConfigStore.shared.observe("notes") { [weak self] in self?.reloadSettings() })
        observers.append(NotificationCenter.default.addObserver(forName: NoteStore.didChange, object: store, queue: .main) { [weak self] _ in
            // a snapshot applies hundreds of notes in one go: rebuild the open list once
            guard let self, self.windowController?.palette.isOpen == true, !self.paletteRefreshQueued else { return }
            self.paletteRefreshQueued = true
            DispatchQueue.main.async {
                self.paletteRefreshQueued = false
                self.windowController?.palette.refresh()
            }
        })
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            self?.flushPendingSave()
        })
        purgeOldTrash()
        sync.configure(settings.sync)
        sync.start()
        updateStatusItem()
    }

    func stop() {
        guard running else { return }
        running = false
        flushPendingSave()
        syncConfigWork?.cancel()
        syncConfigWork = nil
        sync.stop()
        windowController?.hide()
        windowController = nil
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers = []
        if let s = statusItem { NSStatusBar.system.removeStatusItem(s) }
        statusItem = nil
    }

    private func reloadSettings() {
        let old = settings
        settings = ConfigStore.shared.section("notes", default: NotesSettings())
        windowController?.applySettings(settings)
        if old.sync != settings.sync {
            // debounce: the server/token fields write the config on every keystroke
            syncConfigWork?.cancel()
            let w = DispatchWorkItem { [weak self] in
                guard let self else { return }
                self.sync.configure(self.settings.sync)
            }
            syncConfigWork = w
            DispatchQueue.main.asyncAfter(deadline: .now() + (old.sync.enabled != settings.sync.enabled ? 0 : 1.2), execute: w)
        }
        if old.showMenuBarButton != settings.showMenuBarButton { updateStatusItem() }
    }

    private var syncConfigWork: DispatchWorkItem?

    func updateSettings(_ mutate: (inout NotesSettings) -> Void) {
        var s = settings
        mutate(&s)
        guard s != settings else { return }
        settings = s
        ConfigStore.shared.setSection("notes", s)
        windowController?.applySettings(s)
    }

    private var window: NotesWindowController {
        if let w = windowController { return w }
        let w = NotesWindowController(controller: self, settings: settings)
        windowController = w
        return w
    }

    // MARK: Global actions

    /// Raycast's "Raycast Notes" command: show → focus → hide.
    func toggle() {
        let w = window
        if !w.isVisible {
            openWindow()
        } else if !(NSApp.isActive && w.isKey) {
            w.show(focus: true)
        } else {
            hideWindow()
        }
    }

    func openWindow() {
        let w = window
        if w.noteID == nil || w.noteID != currentID || store.note(currentID ?? "")?.isLive != true {
            let id = (currentID.flatMap { store.note($0)?.isLive == true ? $0 : nil }) ?? store.liveNotes.first?.id
            if let id { open(id, recordHistory: false) } else { createNote(body: "") }
        }
        w.show(focus: true)
        warnIfNotPersistent()
    }

    private var warnedNotPersistent = false

    /// The database couldn't be opened (permissions, disk, corruption): say so instead of
    /// letting the user type into notes that vanish on quit.
    private func warnIfNotPersistent() {
        guard !store.isPersistent, !warnedNotPersistent, let w = windowController else { return }
        warnedNotPersistent = true
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "Notes Can't Be Saved"
        alert.informativeText = "The notes database at \(NoteStore.defaultURL?.path ?? "?") couldn't be opened. "
            + "Changes are kept in memory\(settings.sync.enabled ? " and synced" : "") until Bento quits. See Console (category notes) for details."
        alert.beginSheetModal(for: w.panel) { _ in }
    }

    func hideWindow() {
        guard let w = windowController, w.isVisible else { return }
        let wasActive = NSApp.isActive && (w.isKey || NSApp.keyWindow == nil)
        w.hide()
        if wasActive, NSApp.windows.filter({ $0.isVisible && $0.canBecomeKey && !($0 is NSPanel) }).isEmpty {
            if let prev = AppActivation.previousApp, prev.processIdentifier != getpid() { prev.activate() } else { NSApp.hide(nil) }
        }
    }

    /// "Create Note" command.
    func newNoteFromAnywhere() {
        openWindow()
        createNote(body: "")
    }

    /// "Search Notes" command.
    func searchFromAnywhere() {
        openWindow()
        showBrowse()
    }

    func escapePressed() {
        if settings.escapeKey == "unfocus" { window.unfocus() } else { hideWindow() }
    }

    // MARK: Commands

    func perform(_ cmd: NotesCommand) {
        let w = window
        switch cmd {
        case .newNote: createNote(body: "")
        case .browse: showBrowse()
        case .actions: showActions()
        case .togglePin: if let id = currentID { togglePin(id) }
        case .duplicate: duplicateCurrent()
        case .copyAs: showActions(start: .copyAs)
        case .format: showActions(start: .format)
        case .export: showActions(start: .export)
        case .toggleFormatBar: updateSettings { $0.showFormatBar.toggle() }
        case .find: w.showFind()
        case .zoomIn: zoom(+1)
        case .zoomOut: zoom(-1)
        case .resetZoom: updateSettings { $0.textSize = NotesTheme.TextSize.medium.rawValue }
        case .toggleAutoResize: setAutoResize(!settings.autoResize)
        case .toggleFloat: updateSettings { $0.floatOnTop.toggle() }
        case .toggleScreenSharing:
            updateSettings { $0.hideWhileScreenSharing.toggle() }
            HUD.show(settings.hideWhileScreenSharing ? "Hidden While Screen Sharing" : "Shown While Screen Sharing", symbol: "video.slash")
        case .recentlyDeleted: showRecentlyDeleted()
        case .settings: openSettings()
        case .deleteNote: if let id = currentID { confirmDelete(id) }
        case .deleteAll: confirmDeleteAll()
        case .back: navigate(back: true)
        case .forward: navigate(back: false)
        case .close: hideWindow()
        default:
            if cmd.isFormatting { w.runFormatting(cmd) }
        }
    }

    func setAutoResize(_ on: Bool) {
        updateSettings { $0.autoResize = on }
        if on { windowController?.autoResize() }
    }

    func toggleStatusText() {
        updateSettings { $0.statusText = $0.statusText == "characters" ? "words" : "characters" }
    }

    private func zoom(_ step: Int) {
        let all = NotesTheme.TextSize.allCases
        let cur = all.firstIndex(of: NotesTheme.TextSize(rawValue: settings.textSize) ?? .medium) ?? 1
        let next = max(0, min(all.count - 1, cur + step))
        guard next != cur else { NSSound.beep(); return }
        updateSettings { $0.textSize = all[next].rawValue }
    }

    private func openSettings() {
        windowController?.hide() // without handing focus back: the settings window takes it
        SettingsRouter.open("notes")
    }

    // MARK: Notes

    var currentNote: Note? { currentID.flatMap { store.note($0) } }

    @discardableResult
    func createNote(body: String) -> Note {
        flushPendingSave()
        if body.isEmpty, let cur = currentNote, cur.isLive, cur.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           windowController?.noteID == cur.id {
            window.show(focus: true)
            return cur
        }
        var n = Note()
        n.body = body
        n.openedAt = Note.now()
        n.device = sync.device
        n.dirty = !body.isEmpty
        store.save(n)
        if n.dirty { sync.localChange() }
        open(n.id, recordHistory: true)
        return n
    }

    func open(_ id: String, recordHistory: Bool = true, selection: NSRange? = nil) {
        guard let note = store.note(id), !note.deleted else { return }
        flushPendingSave()
        let w = window
        if let cur = currentID, cur != id {
            selections[cur] = w.noteID == cur ? w.selectedRange : selections[cur]
            if recordHistory {
                backStack.append(cur)
                if backStack.count > 50 { backStack.removeFirst(backStack.count - 50) }
                forwardStack.removeAll()
                saveNav()
            }
            discardIfEmpty(cur)
        }
        currentID = id
        store.setKV("lastNoteID", id)
        store.markOpened(id)
        w.load(note, selection: selection ?? selections[id])
    }

    /// Never-synced empty notes disappear when you leave them (like a fresh page).
    private func discardIfEmpty(_ id: String) {
        guard let n = store.note(id), n.seq == nil, !n.dirty || n.body.isEmpty,
              n.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, store.liveNotes.count > 1 else { return }
        if n.dirty {
            // It had text that may already be on the server (ack not seen yet): delete it
            // there too instead of forgetting it locally.
            mutate(id) { $0.deleted = true; $0.body = "" }
        } else {
            store.remove(id)
        }
        window.forgetUndo(id)
        backStack.removeAll { $0 == id }
        forwardStack.removeAll { $0 == id }
    }

    private func navigate(back: Bool) {
        var from = back ? backStack : forwardStack
        while let id = from.popLast() {
            guard store.note(id)?.isLive == true, id != currentID else { continue }
            if let cur = currentID {
                if back { forwardStack.append(cur) } else { backStack.append(cur) }
            }
            if back { backStack = from } else { forwardStack = from }
            saveNav()
            open(id, recordHistory: false)
            return
        }
        if back { backStack = from } else { forwardStack = from }
        NSSound.beep()
    }

    private func saveNav() {
        store.setKVJSON("nav.back", backStack)
        store.setKVJSON("nav.forward", forwardStack)
    }

    func openPinned(_ n: Int) {
        let pinned = store.liveNotes.filter(\.pinned)
        guard n >= 1, n <= pinned.count else { NSSound.beep(); return }
        open(pinned[n - 1].id)
    }

    // MARK: Editing / saving

    func editorChanged(_ body: String) {
        guard let id = currentID, var n = store.note(id) else { return }
        n.body = body
        n.updatedAt = Note.nextUpdate(after: n.updatedAt)
        n.dirty = true
        // keep in memory immediately (sync reads the store), write to disk debounced
        pendingNote = n
        // Debounced write, but never later than 1.5 s after the first unsaved keystroke,
        // so continuous typing still reaches disk and the other Macs.
        let now = Date()
        if !hasPending { pendingSince = now }
        hasPending = true
        pendingSave?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.flushPendingSave() }
        pendingSave = w
        let delay = min(0.3, max(0, 1.5 - now.timeIntervalSince(pendingSince)))
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: w)
    }

    private var pendingNote: Note?
    private var pendingSince = Date()

    func flushPendingSave() {
        pendingSave?.cancel()
        pendingSave = nil
        guard hasPending, let n = pendingNote else { return }
        hasPending = false
        pendingNote = nil
        guard let stored = store.note(n.id) else {
            // removed underneath (shouldn't happen): never drop typed text
            var lost = n
            lost.id = UUID().uuidString
            lost.seq = nil
            lost.baseHash = nil
            store.save(lost)
            sync.localChange()
            return
        }
        if stored.deleted || (stored.updatedAt > n.updatedAt && !stored.dirty) {
            // Replaced remotely before this edit reached the store (sync flushes first, so
            // this is a safety net): keep the text as a conflicted copy instead of dropping it.
            if n.body != stored.body { engine.preserve(body: n.body, of: stored) }
            sync.localChange()
            return
        }
        var toSave = n
        toSave.meta = stored.meta
        toSave.seq = stored.seq
        toSave.openedAt = stored.openedAt
        toSave.baseHash = stored.baseHash
        if stored.updatedAt >= n.updatedAt, stored.body != n.body { toSave.updatedAt = Note.nextUpdate(after: stored.updatedAt) }
        store.save(toSave)
        sync.localChange()
    }

    func selectionChanged(_ r: NSRange) {
        if let id = currentID { selections[id] = r }
    }

    private func mutate(_ id: String, _ change: (inout Note) -> Void) {
        flushPendingSave()
        guard var n = store.note(id) else { return }
        change(&n)
        n.updatedAt = Note.nextUpdate(after: n.updatedAt)
        n.dirty = true
        store.save(n)
        sync.localChange()
    }

    private func remoteChanged(_ note: Note) {
        countCache.removeValue(forKey: note.id)
        // A kept undo history refers to ranges of the old text: undoing it on the new text
        // would corrupt it or raise. (The open note's history is cleared by applyExternalBody.)
        if note.id != windowController?.noteID { windowController?.forgetUndo(note.id) }
        guard note.id == currentID, let w = windowController else { return }
        if !note.isLive {
            // deleted or trashed elsewhere: move on
            if let next = store.liveNotes.first(where: { $0.id != note.id }) { open(next.id, recordHistory: false) } else { createNote(body: "") }
            return
        }
        if w.noteID == note.id { w.applyExternalBody(note.body) }
    }

    // MARK: Pin, duplicate, delete

    func togglePin(_ id: String) {
        let maxOrder = store.liveNotes.filter(\.pinned).map(\.pinOrder).max() ?? 0
        var nowPinned = false
        mutate(id) { n in
            n.pinned.toggle()
            nowPinned = n.pinned
            if n.pinned { n.pinOrder = maxOrder + 1 }
        }
        HUD.show(nowPinned ? "Pinned Note" : "Unpinned Note", symbol: nowPinned ? "pin.fill" : "pin.slash")
    }

    func movePinned(_ id: String, up: Bool) {
        let pinned = store.liveNotes.filter(\.pinned)
        guard let i = pinned.firstIndex(where: { $0.id == id }) else { return }
        let j = up ? i - 1 : i + 1
        guard j >= 0, j < pinned.count else { return }
        let a = pinned[i], b = pinned[j]
        let ao = a.pinOrder, bo = b.pinOrder == ao ? ao + (up ? -1 : 1) : b.pinOrder
        mutate(a.id) { $0.pinOrder = bo }
        mutate(b.id) { $0.pinOrder = ao }
    }

    private func duplicateCurrent() {
        flushPendingSave()
        guard let cur = currentNote else { return }
        createNote(body: cur.body)
        HUD.show("Duplicated Note", symbol: "plus.square.on.square")
    }

    func confirmDelete(_ id: String) {
        guard let n = store.note(id) else { return }
        // From the Browse list: the sheet must not hide behind the palette; reopen the list afterwards.
        let fromPalette = windowController?.palette.isOpen == true
        if fromPalette { windowController?.palette.close() }
        let doDelete = { [weak self] in
            self?.trash(id)
            if fromPalette { self?.showBrowse() }
        }
        if !settings.confirmDelete || n.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            doDelete()
            return
        }
        let alert = NSAlert()
        alert.messageText = "Delete Note?"
        alert.informativeText = "“\(NoteText.displayTitle(of: n.body))” will move to Recently Deleted. You can recover it from the actions panel within 60 days."
        alert.addButton(withTitle: "Delete") // default (↩), like Raycast's ⌃X then ↩
        alert.addButton(withTitle: "Cancel")
        alert.showsSuppressionButton = true
        alert.suppressionButton?.title = "Don't ask again"
        let w = window
        w.show(focus: true)
        alert.beginSheetModal(for: w.panel) { [weak self] resp in
            if alert.suppressionButton?.state == .on { self?.updateSettings { $0.confirmDelete = false } }
            if resp == .alertFirstButtonReturn { doDelete() } else if fromPalette { self?.showBrowse() }
        }
    }

    private func trash(_ id: String) {
        mutate(id) { $0.trashedAt = Note.now() }
        if id == currentID {
            if let next = nextNote(after: id) { open(next, recordHistory: false) } else { createNote(body: "") }
        }
        HUD.show("Note Deleted", symbol: "trash")
    }

    private func nextNote(after id: String) -> String? {
        if let b = backStack.last(where: { $0 != id && store.note($0)?.isLive == true }) { return b }
        return store.liveNotes.first { $0.id != id }?.id
    }

    private func confirmDeleteAll() {
        let live = store.liveNotes
        guard !live.isEmpty else { return }
        let alert = NSAlert()
        alert.messageText = "Delete All Notes?"
        alert.informativeText = "All \(live.count) notes will move to Recently Deleted for 60 days."
        alert.addButton(withTitle: "Delete All")
        alert.addButton(withTitle: "Cancel")
        let w = window
        alert.beginSheetModal(for: w.panel) { [weak self] resp in
            guard let self, resp == .alertFirstButtonReturn else { return }
            let now = Note.now()
            for n in live { self.mutate(n.id) { $0.trashedAt = now } }
            self.backStack.removeAll()
            self.forwardStack.removeAll()
            self.saveNav()
            self.currentID = nil
            self.createNote(body: "")
        }
    }

    func restore(_ id: String) {
        mutate(id) { $0.trashedAt = nil }
        open(id)
    }

    func deletePermanently(_ id: String) {
        let fromPalette = windowController?.palette.isOpen == true
        if fromPalette { windowController?.palette.close() }
        let alert = NSAlert()
        alert.messageText = "Permanently Delete Note “\(NoteText.displayTitle(of: store.note(id)?.body ?? ""))”?"
        alert.informativeText = "This can't be undone."
        alert.addButton(withTitle: "Delete Permanently")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window.panel) { [weak self] resp in
            guard let self else { return }
            if resp == .alertFirstButtonReturn {
                self.mutate(id) { n in
                    n.deleted = true
                    n.body = ""
                }
            }
            if fromPalette { self.showRecentlyDeleted() }
        }
    }

    /// Recently Deleted keeps notes for 60 days.
    private func purgeOldTrash() {
        let cutoff = Note.now() - 60 * 24 * 3600 * 1000
        for n in store.trashedNotes where (n.trashedAt ?? 0) < cutoff {
            mutate(n.id) { $0.deleted = true; $0.body = "" }
        }
    }

    // MARK: Copy / export

    enum ExportFormat { case markdown, plain, html }

    private func content(selectionOnly: Bool) -> String {
        flushPendingSave()
        let body = windowController?.currentText ?? currentNote?.body ?? ""
        if selectionOnly, let w = windowController, w.selectedRange.length > 0 {
            return (body as NSString).substring(with: w.selectedRange)
        }
        return body
    }

    func copy(_ f: ExportFormat, selectionOnly: Bool) {
        let md = content(selectionOnly: selectionOnly)
        let pb = NSPasteboard.general
        pb.clearContents()
        switch f {
        case .markdown:
            pb.setString(md, forType: .string)
        case .plain:
            pb.setString(MarkdownExport.plainText(md), forType: .string)
        case .html:
            let html = MarkdownExport.html(md, standalone: false)
            pb.declareTypes([.html, .string], owner: nil)
            pb.setString(html, forType: .html)
            pb.setString(MarkdownExport.plainText(md), forType: .string)
        }
        let name = f == .markdown ? "Markdown" : f == .plain ? "Plain Text" : "HTML"
        HUD.show("Copied as \(name)", symbol: "doc.on.clipboard")
    }

    func export(_ f: ExportFormat) {
        let md = content(selectionOnly: false)
        let title = NoteText.displayTitle(of: md)
        let panel = NSSavePanel()
        let (ext, data): (String, String) = {
            switch f {
            case .markdown: return ("md", md)
            case .plain: return ("txt", MarkdownExport.plainText(md))
            case .html: return ("html", MarkdownExport.html(md, standalone: true, title: title))
            }
        }()
        panel.nameFieldStringValue = title.replacingOccurrences(of: "/", with: "-") + "." + ext
        if let t = UTType(filenameExtension: ext) { panel.allowedContentTypes = [t] }
        panel.canCreateDirectories = true
        let w = window
        w.show(focus: true)
        panel.beginSheetModal(for: w.panel) { resp in
            guard resp == .OK, let url = panel.url else { return }
            do { try data.write(to: url, atomically: true, encoding: .utf8) } catch {
                NSAlert(error: error).runModal()
            }
        }
    }

    func share() {
        let md = content(selectionOnly: false)
        let w = window
        let picker = NSSharingServicePicker(items: [md])
        let view = w.panel.contentView!
        picker.show(relativeTo: NSRect(x: view.bounds.maxX - 60, y: view.bounds.maxY - 30, width: 20, height: 20), of: view, preferredEdge: .minY)
    }

    // MARK: Palettes

    private func words(_ n: Note) -> (chars: Int, words: Int) {
        if let c = countCache[n.id], c.0 == n.updatedAt { return (c.1, c.2) }
        let r = (NoteText.characterCount(of: n.body), NoteText.wordCount(of: n.body))
        countCache[n.id] = (n.updatedAt, r.0, r.1)
        return r
    }

    private func countText(_ n: Note) -> String {
        let c = words(n)
        if settings.statusText == "characters" { return "\(c.chars) Character\(c.chars == 1 ? "" : "s")" }
        return "\(c.words) Word\(c.words == 1 ? "" : "s")"
    }

    func showBrowse() {
        flushPendingSave()
        let content = PaletteContent(
            placeholder: "Search for notes…",
            provider: { [weak self] q in self?.browseSections(q) ?? [] },
            keyHandler: { [weak self] e, item in self?.browseKey(e, item) ?? false },
            rowHeight: 50,
            emptyText: "No Notes")
        window.show(focus: true)
        window.showPalette(content)
    }

    private func browseSections(_ q: String) -> [PaletteSection] {
        let live = store.liveNotes
        var scored: [(Note, Int)] = []
        for n in live {
            let title = NoteText.displayTitle(of: n.body)
            if let s = FuzzyMatch.noteScore(q, title: title, body: n.body) { scored.append((n, s)) }
        }
        if !q.trimmingCharacters(in: .whitespaces).isEmpty {
            scored.sort { $0.1 != $1.1 ? $0.1 > $1.1 : NoteStore.listOrder($0.0, $1.0) }
        }
        let items: [(Note, PaletteItem)] = scored.map { (n, _) in (n, noteItem(n)) }
        let pinned = items.filter { $0.0.pinned }.map(\.1)
        let others = items.filter { !$0.0.pinned }.map(\.1)
        if items.isEmpty {
            let query = q.trimmingCharacters(in: .whitespaces)
            let item = PaletteItem(id: "create", title: query.isEmpty ? "Create New Note" : "Create Note “\(query)”", symbol: "plus",
                                   shortcut: Shortcut("cmd+n"), action: { [weak self] in self?.createNote(body: query) })
            return [PaletteSection(title: nil, items: [item])]
        }
        var sections: [PaletteSection] = []
        if !pinned.isEmpty { sections.append(PaletteSection(title: "Pinned", items: pinned)) }
        if !others.isEmpty {
            let count = live.count
            sections.append(PaletteSection(title: "Notes", accessory: "\(count) Note\(count == 1 ? "" : "s")", items: others))
        }
        return sections
    }

    private func noteItem(_ n: Note) -> PaletteItem {
        let isCurrent = n.id == currentID
        let when = isCurrent ? "Current" : "Opened \(RelativeDate.short(max(n.openedAt, n.createdAt)))"
        let id = n.id
        return PaletteItem(
            id: n.id,
            title: NoteText.displayTitle(of: n.body),
            lazySubtitle: { [weak self] in "\(when)  •  \(self?.countText(n) ?? "")" },
            subtitleDot: isCurrent ? styledAccent : nil,
            buttons: [
                PaletteButton(symbol: n.pinned ? "pin.slash" : "pin", help: n.pinned ? "Unpin Note  ⌘." : "Pin Note  ⌘.") { [weak self] in self?.togglePin(id) },
                PaletteButton(symbol: "trash", help: "Delete Note  ⌃X") { [weak self] in self?.confirmDelete(id) },
            ],
            action: { [weak self] in self?.open(id) })
    }

    private var styledAccent: NSColor { settings.theme.accent }

    private func browseKey(_ e: NSEvent, _ item: PaletteItem?) -> Bool {
        if Shortcut("cmd+n")!.matches(e) {
            window.palette.close()
            createNote(body: "")
            return true
        }
        guard let item, item.id != "create" else { return false }
        if Shortcut("cmd+period")!.matches(e) || Shortcut("cmd+shift+p")!.matches(e) { togglePin(item.id); return true }
        if Shortcut("ctrl+x")!.matches(e) { confirmDelete(item.id); return true }
        if Shortcut("cmd+shift+up")!.matches(e) { movePinned(item.id, up: true); return true }
        if Shortcut("cmd+shift+down")!.matches(e) { movePinned(item.id, up: false); return true }
        return false
    }

    func showRecentlyDeleted() {
        let content = PaletteContent(
            placeholder: "Search for deleted notes…",
            provider: { [weak self] q in
                guard let self else { return [] }
                let items = self.store.trashedNotes.filter { FuzzyMatch.noteScore(q, title: NoteText.displayTitle(of: $0.body), body: $0.body) != nil }.map { n -> PaletteItem in
                    let id = n.id
                    return PaletteItem(id: id, title: NoteText.displayTitle(of: n.body),
                                       lazySubtitle: { [weak self] in "Deleted \(RelativeDate.short(n.trashedAt ?? n.updatedAt))  •  \(self?.countText(n) ?? "")" },
                                       buttons: [
                                           PaletteButton(symbol: "arrow.uturn.backward", help: "Restore Note  ↩") { [weak self] in self?.window.palette.close(); self?.restore(id) },
                                           PaletteButton(symbol: "trash", help: "Delete Permanently  ⌃X") { [weak self] in self?.deletePermanently(id) },
                                       ],
                                       action: { [weak self] in self?.restore(id) })
                }
                return [PaletteSection(title: "Recently Deleted", accessory: "Kept for 60 days", items: items)]
            },
            keyHandler: { [weak self] e, item in
                guard let item else { return false }
                if Shortcut("ctrl+x")!.matches(e) { self?.deletePermanently(item.id); return true }
                return false
            },
            rowHeight: 50,
            emptyText: "No Recently Deleted Notes")
        window.show(focus: true)
        window.showPalette(content)
    }

    private func item(_ c: NotesCommand, title: String? = nil, destructive: Bool = false, checked: Bool = false) -> PaletteItem {
        PaletteItem(id: c.rawValue, title: title ?? c.title, symbol: c.symbol, shortcut: c.shortcut, destructive: destructive,
                    action: { [weak self] in self?.perform(c) }, checked: checked)
    }

    func showActions(start: NotesCommand? = nil) {
        flushPendingSave()
        let hasSelection = (windowController?.selectedRange.length ?? 0) > 0
        let pinned = currentNote?.pinned ?? false
        let copyTitle = hasSelection ? "Copy Selected Text As…" : "Copy Note As…"

        let copyMenu: () -> PaletteContent = { [weak self] in
            PaletteContent(placeholder: copyTitle, provider: { q in
                let items = [
                    PaletteItem(id: "md", title: "Markdown", symbol: "number", action: { self?.copy(.markdown, selectionOnly: hasSelection) }),
                    PaletteItem(id: "txt", title: "Plain Text", symbol: "text.alignleft", action: { self?.copy(.plain, selectionOnly: hasSelection) }),
                    PaletteItem(id: "html", title: "HTML", symbol: "chevron.left.forwardslash.chevron.right", action: { self?.copy(.html, selectionOnly: hasSelection) }),
                ]
                return [PaletteSection(title: nil, items: NotesController.filter(items, q))]
            })
        }
        let formatMenu: () -> PaletteContent = { [weak self] in
            PaletteContent(placeholder: "Search formats…", provider: { q in
                let items = NotesCommand.formatMenu.compactMap { self?.item($0) }
                return [PaletteSection(title: nil, items: NotesController.filter(items, q))]
            })
        }
        let exportMenu: () -> PaletteContent = { [weak self] in
            PaletteContent(placeholder: "Export…", provider: { q in
                let items = [
                    PaletteItem(id: "emd", title: "Save Markdown File…", symbol: "arrow.down.doc", action: { self?.export(.markdown) }),
                    PaletteItem(id: "etxt", title: "Save Plain Text File…", symbol: "doc.plaintext", action: { self?.export(.plain) }),
                    PaletteItem(id: "ehtml", title: "Save HTML File…", symbol: "safari", action: { self?.export(.html) }),
                    PaletteItem(id: "share", title: "Share…", symbol: "square.and.arrow.up", action: { self?.share() }),
                ]
                return [PaletteSection(title: nil, items: NotesController.filter(items, q))]
            })
        }
        if let start {
            let c: PaletteContent = start == .copyAs ? copyMenu() : start == .format ? formatMenu() : exportMenu()
            window.show(focus: true)
            window.showPalette(c)
            return
        }

        let s = settings
        let content = PaletteContent(placeholder: "Search for actions…", provider: { [weak self] q in
            guard let self else { return [] }
            var copy = PaletteItem(id: "copyAs", title: copyTitle, symbol: NotesCommand.copyAs.symbol, shortcut: NotesCommand.copyAs.shortcut)
            copy.submenu = copyMenu
            var format = PaletteItem(id: "format", title: "Format…", symbol: NotesCommand.format.symbol, shortcut: NotesCommand.format.shortcut)
            format.submenu = formatMenu
            var export = PaletteItem(id: "export", title: "Export…", symbol: NotesCommand.export.symbol, shortcut: NotesCommand.export.shortcut)
            export.submenu = exportMenu
            let primary = [
                self.item(.newNote), self.item(.browse),
                self.item(.togglePin, title: pinned ? "Unpin Note" : "Pin Note"),
                self.item(.duplicate), copy, format,
            ]
            let secondary = [
                self.item(.toggleFormatBar, title: s.showFormatBar ? "Hide Format Bar" : "Show Format Bar"),
                self.item(.find), self.item(.zoomIn), self.item(.zoomOut), self.item(.resetZoom),
                self.item(.toggleAutoResize, title: s.autoResize ? "Disable Window Auto-sizing" : "Enable Window Auto-sizing"),
                self.item(.toggleFloat, title: "Float on Top", checked: s.floatOnTop),
                self.item(.toggleScreenSharing, title: s.hideWhileScreenSharing ? "Show While Screen Sharing" : "Hide While Screen Sharing"),
                export, self.item(.recentlyDeleted), self.item(.settings),
            ]
            let danger = [self.item(.deleteNote, destructive: true), self.item(.deleteAll, destructive: true)]
            if !q.isEmpty {
                // searching also finds formats
                let all = primary + secondary + danger + NotesCommand.formatMenu.map { self.item($0) }
                return [PaletteSection(title: nil, items: NotesController.filter(all, q))]
            }
            return [PaletteSection(title: nil, items: primary), PaletteSection(title: nil, items: secondary), PaletteSection(title: nil, items: danger)]
        }, keyHandler: { [weak self] e, _ in
            // ⌘K again closes the panel
            if Shortcut("cmd+k")!.matches(e) { self?.window.palette.close(); return true }
            return false
        })
        window.show(focus: true)
        window.showPalette(content)
    }

    static func filter(_ items: [PaletteItem], _ q: String) -> [PaletteItem] {
        guard !q.trimmingCharacters(in: .whitespaces).isEmpty else { return items }
        return items.compactMap { i in FuzzyMatch.score(q, i.title).map { (i, $0) } }.sorted { $0.1 > $1.1 }.map(\.0)
    }

    // MARK: Menu bar button

    private func updateStatusItem() {
        if settings.showMenuBarButton && running {
            guard statusItem == nil else { return }
            let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
            item.button?.image = NSImage(systemSymbolName: "note.text", accessibilityDescription: "Notes")
            item.button?.target = self
            item.button?.action = #selector(statusClicked)
            item.button?.toolTip = "Notes (⌥-click: new note)"
            statusItem = item
        } else if let s = statusItem {
            NSStatusBar.system.removeStatusItem(s)
            statusItem = nil
        }
    }

    @objc private func statusClicked() {
        if NSApp.currentEvent?.modifierFlags.contains(.option) == true { newNoteFromAnywhere() } else { toggle() }
    }

    // MARK: Settings view

    func makeSettingsView(actions: [BentoAction]) -> AnyView {
        AnyView(NotesSettingsView(status: sync.status, actions: actions, syncNow: { [weak self] in self?.sync.syncNow() }))
    }

    // MARK: Debug hooks (dev harness only)

    var debugWindow: NotesWindowController? { windowController }

    /// A local edit by id, like typing (the editor is updated if the note is open).
    func debugPut(id: String, body: String) {
        if let w = windowController, w.noteID == id, currentID == id {
            let len = (w.textView.string as NSString).length
            w.textView.apply(EditResult(edits: [TextEdit(range: NSRange(location: 0, length: len), replacement: body)],
                                        selection: NSRange(location: (body as NSString).length, length: 0)))
            return
        }
        if store.note(id) != nil {
            mutate(id) { $0.body = body; $0.deleted = false }
            return
        }
        var n = Note(id: id, body: body)
        n.device = sync.device
        n.dirty = true
        store.save(n)
        sync.localChange()
    }

    func debugMutate(_ id: String, _ change: (inout Note) -> Void) {
        guard store.note(id) != nil else { return }
        mutate(id, change)
        if let n = store.note(id), id == currentID, !n.isLive { remoteChanged(n) }
    }
}
