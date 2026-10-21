import AppKit
import UniformTypeIdentifiers
import BentoCore

/// One editor window: a capture, its annotations, tools, undo, export.
final class EditorController: NSObject, NSWindowDelegate {
    private var dockRetained = false
    struct EditState: Equatable {
        var annotations: [Annotation]
        var crop: CGRect?
    }

    enum Axis { case horizontal, vertical }

    private(set) var doc: ShotDocument
    private(set) var image: CGImage
    private(set) var sampler: PixelSampler
    let effects = EffectCache()
    let undo = UndoManager()
    var settings = EditorSettings.current

    let window: EditorWindow
    let scrollView = NSScrollView()
    let canvas = CanvasView()
    private(set) var toolbar: EditorToolbar!
    let statusBar = StatusBar()

    var onClose: ((EditorController) -> Void)?

    // Interaction state (read by the canvas views)
    private(set) var tool: EditorTool = .select
    var selectedID: UUID? { didSet { if selectedID != oldValue { selectionChanged() } } }
    var region: CGRect? { didSet { canvas.annotationView.needsDisplay = true; updateStatus() } }
    var draft: Annotation? { didSet { canvas.annotationView.needsDisplay = true } }
    var measureAxis: Axis? { didSet { canvas.annotationView.liveMeasure = nil; canvas.annotationView.needsDisplay = true; updateHint() } }
    private(set) var editingTextID: UUID?
    private var textEditStart: EditState?
    private var textEditIsNew = false
    var color: String
    private var dirty = false
    private var thumbDirty = false
    private var autosave: DispatchWorkItem?
    private var closed = false
    var isClosed: Bool { closed }
    private var counterTyping: (id: UUID, time: Date, text: String)?

    var state: EditState {
        get { EditState(annotations: doc.annotations, crop: doc.crop) }
        set {
            let cropChanged = newValue.crop != doc.crop
            doc.annotations = newValue.annotations
            doc.crop = newValue.crop
            if let id = selectedID, !doc.annotations.contains(where: { $0.id == id }) { selectedID = nil }
            if cropChanged { applyCanvasGeometry(refit: true) }
            canvas.annotationView.needsDisplay = true
            markDirty()
        }
    }

    var magnification: CGFloat { scrollView.magnification }
    var selected: Annotation? { selectedID.flatMap { id in doc.annotations.first { $0.id == id } } }

    init(doc: ShotDocument, image: CGImage) {
        self.doc = doc
        self.image = image
        self.sampler = PixelSampler(image: image, scale: doc.scale)
        self.color = settings.defaultColor
        window = EditorWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 600),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        super.init()
        tool = EditorTool(rawValue: settings.defaultTool) ?? .select
        buildWindow()
    }

    // MARK: Window

    private func buildWindow() {
        window.editor = self
        window.appearance = NSAppearance(named: .darkAqua)
        window.isReleasedWhenClosed = false
        window.isRestorable = false
        window.delegate = self
        window.tabbingMode = .disallowed
        window.titleVisibility = .hidden
        window.title = windowTitle
        window.toolbarStyle = .unifiedCompact
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.minSize = NSSize(width: 880, height: 320)

        toolbar = EditorToolbar(editor: self)
        window.toolbar = toolbar.toolbar

        let content = NSView()
        content.wantsLayer = true
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        statusBar.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(scrollView)
        content.addSubview(statusBar)
        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: content.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: statusBar.topAnchor),
            statusBar.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            statusBar.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            statusBar.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            statusBar.heightAnchor.constraint(equalToConstant: 26),
        ])

        let clip = CenteringClipView()
        clip.drawsBackground = false
        scrollView.contentView = clip
        scrollView.drawsBackground = true
        scrollView.backgroundColor = NSColor(white: 0.115, alpha: 1)
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.scrollerStyle = .overlay
        scrollView.allowsMagnification = true
        scrollView.minMagnification = 0.05
        scrollView.maxMagnification = 32
        scrollView.documentView = canvas
        canvas.editor = self
        canvas.setImage(image)
        applyCanvasGeometry(refit: false)

        window.contentView = content
        window.initialFirstResponder = canvas.annotationView
        NotificationCenter.default.addObserver(self, selector: #selector(magnificationChanged),
                                               name: NSScrollView.didEndLiveMagnifyNotification, object: scrollView)
        statusBar.onSizeClick = { [weak self] in self?.copySizeToClipboard() }
        statusBar.onColorClick = { [weak self] in
            guard let self, let hex = self.statusBar.lastHex else { return }
            Clipboard.copyText(hex)
            Feedback.hud("Copied \(hex)", symbol: "eyedropper")
        }
        toolbar.update()
        updateStatus()
        updateHint()
    }

    private var windowTitle: String {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        return "Screenshot \(f.string(from: doc.created))" + (doc.sourceAppName.map { " — \($0)" } ?? "")
    }

    func show(near captureRect: CGRect) {
        let screen = captureRect == .zero ? (NSScreen.underMouse ?? NSScreen.main) : NSScreen.containing(axRect: captureRect)
        let vf = (screen ?? NSScreen.main)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let canvasSize = doc.canvasRect.size
        let chromeH: CGFloat = 26 + 40 // status bar + compact toolbar/titlebar
        let maxW = vf.width * 0.94, maxH = vf.height * 0.94 - chromeH
        let zoom = min(1, maxW / max(1, canvasSize.width), maxH / max(1, canvasSize.height))
        let contentW = max(window.minSize.width, ceil(canvasSize.width * zoom) + 2)
        let contentH = max(260, ceil(canvasSize.height * zoom) + 2) + 26
        window.setContentSize(NSSize(width: min(contentW, vf.width), height: min(contentH, vf.height - 40)))
        var frame = window.frame
        frame.origin = NSPoint(x: vf.midX - frame.width / 2, y: vf.midY - frame.height / 2)
        frame.origin.x = frame.origin.x.clamped(vf.minX...max(vf.minX, vf.maxX - frame.width))
        frame.origin.y = frame.origin.y.clamped(vf.minY...max(vf.minY, vf.maxY - frame.height))
        window.setFrame(frame, display: false)
        window.layoutIfNeeded()
        scrollView.magnification = zoom
        centerCanvas()
        if !dockRetained { DockPresence.retain(); dockRetained = true }
        AppActivation.activateSelf()
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        window.makeFirstResponder(canvas.annotationView)
        magnificationChanged()
    }

    func applyCanvasGeometry(refit: Bool) {
        let rect = doc.canvasRect
        canvas.layoutCanvas(canvasRect: rect, imageBounds: doc.imageBounds)
        if refit { zoomToFit(maxZoom: 1) }
        updateStatus()
    }

    private func centerCanvas() {
        let clip = scrollView.contentView
        let doc = canvas.frame
        let b = clip.bounds
        clip.scroll(to: NSPoint(x: doc.midX - b.width / 2, y: doc.midY - b.height / 2))
        scrollView.reflectScrolledClipView(clip)
    }

    @objc func magnificationChanged() {
        canvas.magnificationChanged(scrollView.magnification)
        updateStatus()
    }

    // MARK: Close

    func windowWillClose(_ notification: Notification) {
        guard !closed else { return }
        closed = true
        settleForUndo()
        persist(final: true)
        NotificationCenter.default.removeObserver(self)
        undo.removeAllActions()
        effects.removeAll()
        canvas.releaseImage()
        window.toolbar = nil
        onClose?(self)
        restoreFocusIfNeeded()
        if dockRetained { DockPresence.release(); dockRetained = false }
    }

    func windowWillReturnUndoManager(_ window: NSWindow) -> UndoManager? { undo }

    /// After the last Bento window closes, give focus back to the app the user came from.
    private func restoreFocusIfNeeded() {
        let others = NSApp.windows.filter { $0 !== window && $0.isVisible && $0.canBecomeMain && !($0 is NSPanel) }
        guard others.isEmpty else { return }
        if let prev = AppActivation.previousApp, !prev.isTerminated, prev.processIdentifier != getpid() {
            prev.activate()
        }
    }

    func close() { window.close() }

    // MARK: Persistence

    private func markDirty(thumbnail: Bool = true) {
        dirty = true
        if thumbnail { thumbDirty = true }
        autosave?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.persist(final: false) }
        autosave = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: work)
    }

    /// Writes the document (and on close a fresh thumbnail) to history.
    func persist(final: Bool) {
        autosave?.cancel()
        autosave = nil
        guard dirty || (final && thumbDirty) else { return }
        dirty = false
        doc.modified = Date()
        var flat: CGImage?
        if final && thumbDirty {
            flat = flattened()
            thumbDirty = false
        }
        HistoryStore.shared.update(doc, flattened: flat)
    }

    // MARK: Edits & undo

    /// Registers an undoable change from `before` to the current state.
    func commit(_ name: String, from before: EditState) {
        let after = state
        guard before != after else { return }
        registerUndo(name, restoring: before, redo: after)
        markDirty()
        canvas.annotationView.needsDisplay = true
        toolbar.update()
    }

    private func registerUndo(_ name: String, restoring before: EditState, redo after: EditState) {
        undo.registerUndo(withTarget: self) { target in
            target.state = before
            target.registerUndo(name, restoring: after, redo: before)
            target.toolbar.update()
        }
        undo.setActionName(name)
    }

    /// Applies a change to the document and records it for undo.
    func mutate(_ name: String, _ change: (inout EditState) -> Void) {
        finishStyleEdit()
        let before = state
        var s = before
        change(&s)
        guard s != before else { return }
        state = s
        commit(name, from: before)
    }

    func updateAnnotation(_ id: UUID, _ change: (inout Annotation) -> Void) {
        guard let i = doc.annotations.firstIndex(where: { $0.id == id }) else { return }
        change(&doc.annotations[i])
        canvas.annotationView.needsDisplay = true
    }

    /// Replaces annotations without registering undo (used during drags; the
    /// caller commits once at the end).
    func setAnnotationsLive(_ anns: [Annotation]) {
        doc.annotations = anns
        canvas.annotationView.needsDisplay = true
    }

    func performUndo() {
        settleForUndo()
        if undo.canUndo { undo.undo() } else { Feedback.beep() }
    }

    func performRedo() {
        settleForUndo()
        if undo.canRedo { undo.redo() } else { Feedback.beep() }
    }

    /// Finishes whatever is in progress (text editing, a size-slider drag, a
    /// mouse drag) so undo/redo acts on a committed state; a drag still running
    /// would otherwise write its stale snapshot back over the undone state.
    private func settleForUndo() {
        _ = canvas.annotationView.cancelDrag()
        if editingTextID != nil { endTextEditing() }
        finishStyleEdit()
    }

    // MARK: Tools & style

    func setTool(_ t: EditorTool) {
        if editingTextID != nil { endTextEditing() }
        if t == tool, let kind = t.kind {
            // Pressing the tool key again cycles its style (Shottr-like variants).
            let styles = Annotation.styles(for: kind)
            if styles.count > 1 { setStyle((currentStyle(for: kind) + 1) % styles.count) }
            return
        }
        tool = t
        measureAxis = nil
        if t != .select { region = nil }
        if let sel = selected, sel.kind != t.kind, t != .select { selectedID = nil }
        canvas.annotationView.updateCursor()
        toolbar.update()
        updateHint()
    }

    /// Kind whose style the toolbar shows: the selected annotation, else the tool.
    var styleKind: Annotation.Kind? { selected?.kind ?? tool.kind }

    func currentSize(for kind: Annotation.Kind) -> Double { ToolMemory.size(for: kind) }
    func currentStyle(for kind: Annotation.Kind) -> Int { ToolMemory.style(for: kind) }

    private var styleEditBase: EditState?

    func setSize(_ v: Double, final: Bool) {
        if let kind = styleKind { ToolMemory.setSize(v, for: kind) }
        guard let id = selectedID else { return }
        if editingTextID == id {
            // Part of the text edit: committed with it when editing ends.
            updateAnnotation(id) { $0.size = v }
            canvas.annotationView.syncTextEditor()
            return
        }
        if styleEditBase == nil { styleEditBase = state }
        updateAnnotation(id) { $0.size = v }
        if final { finishStyleEdit() }
    }

    /// Commits a size change made with the slider (one undo step per drag).
    /// Also called before any other edit, selection change or undo, so a drag
    /// whose final event never arrived can't leave a stale base behind.
    private func finishStyleEdit() {
        guard let base = styleEditBase else { return }
        styleEditBase = nil
        commit("Size", from: base)
    }

    func setStyle(_ s: Int) {
        guard let kind = styleKind else { return }
        ToolMemory.setStyle(s, for: kind)
        if let id = selectedID {
            if editingTextID == id {
                updateAnnotation(id) { $0.style = s }
                canvas.annotationView.syncTextEditor()
            } else {
                mutate("Style") { st in
                    if let i = st.annotations.firstIndex(where: { $0.id == id }) { st.annotations[i].style = s }
                }
            }
        }
        toolbar.update()
    }

    func setColor(_ hex: String) {
        color = hex
        if let id = selectedID {
            if editingTextID == id {
                updateAnnotation(id) { $0.color = hex }
                canvas.annotationView.syncTextEditor()
            } else {
                mutate("Colour") { st in
                    if let i = st.annotations.firstIndex(where: { $0.id == id }) { st.annotations[i].color = hex }
                }
            }
        }
        toolbar.update()
    }

    private func selectionChanged() {
        finishStyleEdit()
        if let sel = selected { color = sel.color }
        toolbar?.update()
        canvas.annotationView.needsDisplay = true
        counterTyping = nil
    }

    /// New annotation of `kind` with the current colour/size/style.
    func makeAnnotation(_ kind: Annotation.Kind, at p: CGPoint) -> Annotation {
        var a = Annotation(kind: kind, p1: p, p2: p, color: color, size: currentSize(for: kind), style: currentStyle(for: kind))
        switch kind {
        case .counter: a.number = doc.nextCounterNumber
        case .spotlight: a.dim = Metrics.spotlightDim
        case .freehand, .highlight: a.path = [p]
        case .text: a.text = ""
        default: break
        }
        return a
    }

    // MARK: Text editing

    func beginTextEditing(_ id: UUID, isNew: Bool) {
        if editingTextID != nil { endTextEditing() }
        guard doc.annotations.contains(where: { $0.id == id }) else { return }
        textEditStart = isNew ? nil : state
        textEditIsNew = isNew
        editingTextID = id
        selectedID = id
        canvas.annotationView.beginTextEditor(for: id)
    }

    func textChanged(_ text: String) {
        guard let id = editingTextID else { return }
        updateAnnotation(id) { $0.text = text }
    }

    func endTextEditing() {
        guard let id = editingTextID else { return }
        canvas.annotationView.endTextEditor()
        editingTextID = nil
        let text = doc.annotations.first { $0.id == id }?.text ?? ""
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let before = textEditStart
            doc.annotations.removeAll { $0.id == id }
            selectedID = nil
            if let before { commit("Delete Text", from: before) }
        } else if textEditIsNew {
            var before = state
            before.annotations.removeAll { $0.id == id }
            commit("Text", from: before)
        } else if let before = textEditStart {
            commit("Edit Text", from: before)
        }
        textEditStart = nil
        canvas.annotationView.needsDisplay = true
        window.makeFirstResponder(canvas.annotationView)
    }

    // MARK: Commands

    func escape() {
        settings = EditorSettings.current
        if editingTextID != nil { endTextEditing(); return }
        if canvas.annotationView.cancelDrag() { return }
        if measureAxis != nil { measureAxis = nil; return }
        if region != nil { region = nil; return }
        switch settings.escAction {
        case .close: close()
        case .copyAndClose: copyImage(); close()
        case .saveAndClose: if save(showHUD: true) { close() }
        case .copySaveAndClose: copyImage(hud: false); if save(showHUD: true) { close() }
        }
    }

    /// Flattened output. `region` limits to a part of the image; `forExport`
    /// applies the "save Retina captures at 1x" option.
    func flattened(region: CGRect? = nil, forExport: Bool = false) -> CGImage? {
        let scale: CGFloat? = forExport && SaveSettings.current.downscaleRetina && doc.scale > 1 ? 1 : nil
        return Renderer.flatten(doc, image: image, effects: effects, region: region, outputScale: scale)
    }

    private var exportScale: CGFloat { SaveSettings.current.downscaleRetina && doc.scale > 1 ? 1 : doc.scale }

    func copyImage(hud: Bool = true) {
        if editingTextID != nil { endTextEditing() }
        let area = region
        guard let img = flattened(region: area, forExport: true) else { return }
        Clipboard.copy(img, scale: exportScale)
        if hud { HUD.show(area == nil ? "Copied" : "Copied selection", symbol: "doc.on.doc") }
    }

    private func suggestedName(_ save: SaveSettings) -> String {
        FilenamePattern.expand(save.filenamePattern, date: doc.created, app: doc.sourceAppName, kind: doc.kind,
                               size: doc.canvasRect.size)
    }

    @discardableResult
    func save(showHUD: Bool) -> Bool {
        if editingTextID != nil { endTextEditing() }
        let save = SaveSettings.current
        let folder = save.folderURL
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let url = FilenamePattern.uniqueURL(in: folder, name: suggestedName(save), ext: save.format.ext)
            guard let img = flattened(forExport: true) else { return false }
            try ImageCodec.write(img, scale: exportScale, format: save.format, quality: save.jpegQuality, to: url)
            if showHUD { Feedback.hud("Saved \(url.lastPathComponent)", symbol: "square.and.arrow.down") }
            return true
        } catch {
            presentError("Couldn't save the image", error)
            return false
        }
    }

    func saveCommand() {
        settings = EditorSettings.current
        if save(showHUD: true), settings.closeAfterSave { close() }
    }

    func saveAs() {
        if editingTextID != nil { endTextEditing() }
        let save = SaveSettings.current
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.png, .jpeg]
        panel.canCreateDirectories = true
        panel.directoryURL = save.folderURL
        panel.nameFieldStringValue = suggestedName(save) + "." + save.format.ext
        panel.isExtensionHidden = false
        panel.beginSheetModal(for: window) { [weak self] resp in
            guard let self, resp == .OK, let url = panel.url else { return }
            let format: EditorSettings.Format = ["jpg", "jpeg"].contains(url.pathExtension.lowercased()) ? .jpeg : .png
            guard let img = self.flattened(forExport: true) else { return }
            do {
                try ImageCodec.write(img, scale: self.exportScale, format: format, quality: save.jpegQuality, to: url)
                Feedback.hud("Saved \(url.lastPathComponent)", symbol: "square.and.arrow.down")
            } catch {
                self.presentError("Couldn't save the image", error)
            }
        }
    }

    /// Writes the flattened image to a temporary file for dragging out.
    func writeDragFile() -> URL? {
        if editingTextID != nil { endTextEditing() }
        let save = SaveSettings.current
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("BentoDrag", isDirectory: true)
        // Drop files from earlier drags (receivers have long finished reading them).
        if let old = try? fm.contentsOfDirectory(at: base, includingPropertiesForKeys: [.contentModificationDateKey]) {
            for u in old {
                let d = (try? u.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
                if d < Date().addingTimeInterval(-3600) { try? fm.removeItem(at: u) }
            }
        }
        let dir = base.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            let url = dir.appendingPathComponent(suggestedName(save)).appendingPathExtension(save.format.ext)
            guard let img = flattened(forExport: true) else { return nil }
            try ImageCodec.write(img, scale: exportScale, format: save.format, quality: save.jpegQuality, to: url)
            return url
        } catch {
            return nil
        }
    }

    func pin() {
        if editingTextID != nil { endTextEditing() }
        guard let img = flattened() else { return }
        var rect = doc.captureRect
        if rect != .zero {
            let c = doc.canvasRect
            rect = CGRect(x: rect.minX + c.minX, y: rect.minY + c.minY, width: c.width, height: c.height)
        }
        ShotEditor.shared.pinImage(img, scale: doc.scale, entryID: doc.id, rect: rect)
        close()
    }

    func recognizeText() {
        if editingTextID != nil { endTextEditing() }
        guard let img = flattened(region: region) else { return }
        Feedback.hud("Recognising text…", symbol: "text.viewfinder", duration: 5)
        Task { @MainActor in
            let text = (try? await TextRecognizer.recognize(img)) ?? ""
            let codes = text.isEmpty ? await Task.detached(priority: .userInitiated) { TextRecognizer.barcodes(img) }.value : []
            let result = text.isEmpty ? codes.joined(separator: "\n") : text
            if result.isEmpty {
                Feedback.hud("No text found", symbol: "text.viewfinder")
            } else {
                Clipboard.copyText(result)
                let lines = result.split(separator: "\n").count
                Feedback.hud(codes.isEmpty ? "Copied \(lines) line\(lines == 1 ? "" : "s") of text" : "Copied QR code", symbol: "text.viewfinder")
            }
        }
    }

    func cropToRegion() {
        guard let r = region?.intersection(doc.imageBounds), r.width >= 1, r.height >= 1 else { return }
        let snapped = CGRect(x: (r.minX * doc.scale).rounded() / doc.scale, y: (r.minY * doc.scale).rounded() / doc.scale,
                             width: (r.width * doc.scale).rounded() / doc.scale, height: (r.height * doc.scale).rounded() / doc.scale)
        region = nil
        mutate("Crop") { $0.crop = snapped }
    }

    func resetCrop() {
        guard doc.crop != nil else { return }
        mutate("Reset Crop") { $0.crop = nil }
    }

    /// Blur / erase the current selection area (Shottr: select, then B or ⌫).
    func obfuscateRegion(_ kind: Annotation.Kind) {
        guard let r = region, r.width >= 2, r.height >= 2 else { return }
        var a = makeAnnotation(kind, at: r.origin)
        a.p2 = CGPoint(x: r.maxX, y: r.maxY)
        region = nil
        mutate(kind == .erase ? "Erase" : "Blur") { $0.annotations.append(a) }
        selectedID = a.id
    }

    func deleteSelection() {
        if let id = selectedID {
            mutate("Delete") { $0.annotations.removeAll { $0.id == id } }
            selectedID = nil
        } else if region != nil {
            obfuscateRegion(.erase)
        }
    }

    func duplicateSelection() {
        guard var a = selected else { return }
        a.id = UUID()
        a.offset(by: CGVector(dx: 12, dy: 12))
        if a.kind == .counter { a.number = doc.nextCounterNumber }
        mutate("Duplicate") { $0.annotations.append(a) }
        selectedID = a.id
    }

    func nudge(dx: CGFloat, dy: CGFloat, resize: Bool) {
        if let id = selectedID {
            mutate("Move") { st in
                if let i = st.annotations.firstIndex(where: { $0.id == id }) { st.annotations[i].offset(by: CGVector(dx: dx, dy: dy)) }
            }
        } else if var r = region {
            if resize {
                r.size.width = max(1, r.width + dx)
                r.size.height = max(1, r.height + dy)
            } else {
                r = r.offsetBy(dx: dx, dy: dy)
            }
            region = r
        }
    }

    /// Shrinks the selection to the content inside it (A with a selection).
    func autoAdjustRegion() {
        guard let r = region, let adjusted = sampler.contentBounds(in: r) else { Feedback.beep(); return }
        region = adjusted
    }

    /// Selects the uniform-colour object under the pointer (⌘-click).
    func selectMonotone(at p: CGPoint) {
        guard let r = sampler.monotoneRegion(at: p, within: doc.canvasRect) else { return }
        if tool != .select { setTool(.select) }
        selectedID = nil
        region = r
    }

    /// Zooms in on a corner of the selection for precise adjustment (Q / W).
    func zoomToRegionCorner(bottomRight: Bool) {
        guard let r = region else { return }
        let c = doc.canvasRect
        let p = bottomRight ? CGPoint(x: r.maxX - c.minX, y: r.maxY - c.minY) : CGPoint(x: r.minX - c.minX, y: r.minY - c.minY)
        scrollView.setMagnification(max(scrollView.magnification, 8).clamped(scrollView.minMagnification...scrollView.maxMagnification), centeredAt: p)
        magnificationChanged()
    }

    /// Enlarges the selection on every side ([ / ]).
    func growRegion(_ d: CGFloat) {
        guard let r = region else { return }
        let g = r.insetBy(dx: -d, dy: -d)
        if g.width >= 1, g.height >= 1 { region = g }
    }

    func typeDigit(_ d: Int) {
        guard let sel = selected else { return }
        if sel.kind == .spotlight, d > 0 {
            mutate("Spotlight") { st in
                if let i = st.annotations.firstIndex(where: { $0.id == sel.id }) { st.annotations[i].dim = Double(d) / 10 }
            }
        } else if sel.kind == .counter {
            var text = "\(d)"
            if let t = counterTyping, t.id == sel.id, Date().timeIntervalSince(t.time) < 1.2, t.text.count < 2 { text = t.text + text }
            counterTyping = (sel.id, Date(), text)
            let n = Int(text) ?? d
            mutate("Renumber") { st in
                if let i = st.annotations.firstIndex(where: { $0.id == sel.id }) { st.annotations[i].number = n }
            }
        }
    }

    // MARK: Colour picking

    func pickColor(at p: CGPoint, darkest: Bool, setAsColor: Bool) {
        guard let c = darkest ? sampler.darkest(around: p) : sampler.color(at: p) else { return }
        let hex = HexColor.hex(r: c.r, g: c.g, b: c.b)
        Clipboard.copyText(hex)
        Feedback.hud("Copied \(hex)", symbol: "eyedropper")
        if setAsColor { setColor(hex) }
    }

    /// Copies the average colour of the selection (Shottr: select, then C).
    func copyAverageColor() {
        guard let r = region, let c = sampler.averageColor(in: r) else { Feedback.beep(); return }
        let hex = HexColor.hex(r: c.r, g: c.g, b: c.b)
        Clipboard.copyText(hex)
        Feedback.hud("Copied average \(hex)", symbol: "eyedropper")
    }

    func copySizeToClipboard() {
        let r = region ?? doc.canvasRect
        let s = "\(Int(r.width.rounded())) × \(Int(r.height.rounded()))"
        Clipboard.copyText(s)
        Feedback.hud("Copied \(s)", symbol: "ruler")
    }

    // MARK: Zoom

    func zoom(by factor: CGFloat) {
        setZoom(scrollView.magnification * factor)
    }

    func setZoom(_ z: CGFloat, centeredAt p: NSPoint? = nil) {
        guard z.isFinite, z > 0 else { return }
        let clip = scrollView.contentView
        let center = p ?? NSPoint(x: clip.bounds.midX, y: clip.bounds.midY)
        scrollView.setMagnification(z.clamped(scrollView.minMagnification...scrollView.maxMagnification), centeredAt: center)
        magnificationChanged()
    }

    func zoomToFit(maxZoom: CGFloat = .greatestFiniteMagnitude) {
        let size = canvas.frame.size
        let avail = scrollView.contentSize
        guard size.width > 0, size.height > 0 else { return }
        let z = min(min(avail.width / size.width, avail.height / size.height) * 0.98, maxZoom)
        scrollView.magnification = z.clamped(scrollView.minMagnification...scrollView.maxMagnification)
        centerCanvas()
        magnificationChanged()
    }

    func zoomActual() {
        setZoom(1)
    }

    func zoomToSelection() {
        guard let r = region ?? selected.map(Renderer.bounds) else { zoomToFit(); return }
        let c = doc.canvasRect
        let viewRect = r.offsetBy(dx: -c.minX, dy: -c.minY).insetBy(dx: -8, dy: -8)
        scrollView.magnify(toFit: viewRect)
        magnificationChanged()
    }

    // MARK: Status

    func updateStatus() {
        let r = region ?? doc.canvasRect
        statusBar.setSize(width: r.width, height: r.height, scale: doc.scale, isSelection: region != nil)
        statusBar.setZoom(scrollView.magnification)
    }

    func updateHint() {
        if measureAxis != nil {
            statusBar.setHint("Measuring \(measureAxis == .vertical ? "vertically" : "horizontally") · click to imprint · Esc to stop")
        } else {
            statusBar.setHint(tool.hint)
        }
    }

    func pointerMoved(to p: CGPoint?) {
        guard let p, let c = sampler.color(at: p) else { statusBar.setPointer(nil, hex: nil); return }
        statusBar.setPointer(p, hex: HexColor.hex(r: c.r, g: c.g, b: c.b))
    }

    private func presentError(_ title: String, _ error: Error) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = error.localizedDescription
        alert.beginSheetModal(for: window)
    }

    // MARK: Key equivalents (⌘ shortcuts work with or without a main menu)

    func handleKeyEquivalent(_ e: NSEvent) -> Bool {
        let mods = e.modifierFlags.intersection([.command, .shift, .option, .control])
        guard mods.contains(.command), !mods.contains(.control) else { return false }
        let key = e.charactersIgnoringModifiers?.lowercased() ?? ""
        let shift = mods.contains(.shift)
        let editingText = editingTextID != nil
        if editingText, !shift, ["c", "v", "x", "a"].contains(key) { return false }
        switch (key, shift) {
        case ("c", _): copyImage()
        case ("s", false): saveCommand()
        case ("s", true): saveAs()
        case ("p", false): pin()
        case ("w", false): close()
        case ("z", false): performUndo()
        case ("z", true): performRedo()
        case ("d", false): duplicateSelection()
        case ("t", true): recognizeText()
        case ("r", true): resetCrop()
        case ("=", _), ("+", _): zoom(by: 1.25)
        case ("-", _), ("_", _): zoom(by: 0.8)
        case ("0", false): zoomActual()
        case ("1", false): zoomToFit()
        case ("2", false): zoomToSelection()
        case ("y", false): ShotEditor.shared.showHistory()
        case ("o", true): ShotEditor.shared.openFilePanel()
        case ("v", true): ShotEditor.shared.openClipboardImage()
        default: return false
        }
        return true
    }
}

/// Editor window: routes ⌘ shortcuts to the controller before the main menu.
final class EditorWindow: NSWindow {
    weak var editor: EditorController?

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if let editor, editor.handleKeyEquivalent(event) { return true }
        return super.performKeyEquivalent(with: event)
    }

    override func cancelOperation(_ sender: Any?) { editor?.escape() }
}

/// Keeps the document centred when it is smaller than the visible area.
final class CenteringClipView: NSClipView {
    override func constrainBoundsRect(_ proposedBounds: NSRect) -> NSRect {
        var r = super.constrainBoundsRect(proposedBounds)
        guard let doc = documentView else { return r }
        let f = doc.frame
        if r.width > f.width { r.origin.x = f.midX - r.width / 2 }
        if r.height > f.height { r.origin.y = f.midY - r.height / 2 }
        return r
    }
}
