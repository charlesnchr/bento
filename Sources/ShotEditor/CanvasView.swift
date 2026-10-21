import AppKit

/// Scroll view document: the image (a layer, pixel-sharp when zoomed in) with
/// the annotation overlay on top. Sized to the visible (cropped) canvas.
final class CanvasView: NSView {
    weak var editor: EditorController? { didSet { annotationView.editor = editor } }
    let imageView = ImageLayerView()
    let annotationView = AnnotationView()

    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        clipsToBounds = true
        addSubview(imageView)
        addSubview(annotationView)
    }

    required init?(coder: NSCoder) { fatalError() }

    func setImage(_ image: CGImage) { imageView.image = image }

    func releaseImage() {
        imageView.image = nil
        annotationView.editor = nil
    }

    func layoutCanvas(canvasRect: CGRect, imageBounds: CGRect) {
        setFrameSize(canvasRect.size)
        imageView.frame = imageBounds.offsetBy(dx: -canvasRect.minX, dy: -canvasRect.minY)
        annotationView.frame = bounds
        annotationView.needsDisplay = true
    }

    func magnificationChanged(_ m: CGFloat) {
        imageView.magnificationChanged(m)
        annotationView.needsDisplay = true
        annotationView.updateCursor()
    }
}

final class ImageLayerView: NSView {
    var image: CGImage? { didSet { needsDisplay = true } }

    override var isFlipped: Bool { true }
    override var wantsUpdateLayer: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay
    }

    required init?(coder: NSCoder) { fatalError() }

    override func updateLayer() {
        guard let layer else { return }
        layer.contents = image
        layer.contentsGravity = .resize
        layer.magnificationFilter = .nearest
        layer.minificationFilter = .trilinear
    }

    func magnificationChanged(_ m: CGFloat) {
        // Sharp pixels when zoomed in, smooth when at 1:1 on fractional zooms.
        layer?.magnificationFilter = m >= 1.5 ? .nearest : .linear
    }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// Draws annotations, selection handles, the selection marquee and live
/// measurements; handles all pointer / keyboard interaction on the canvas.
final class AnnotationView: NSView {
    weak var editor: EditorController?

    private enum Drag {
        case creating(Annotation)
        case moving(UUID, start: CGPoint, original: [Annotation], duplicated: Bool)
        case handle(UUID, index: Int, original: Annotation)
        case region(start: CGPoint)
        case regionMove(start: CGPoint, original: CGRect)
        case regionHandle(index: Int, original: CGRect)
        case pan(start: NSPoint, origin: NSPoint)
    }

    private var drag: Drag?
    private var dragBefore: EditorController.EditState?
    private var spaceDown = false
    private var trackingArea: NSTrackingArea?
    private var textView: TextEditView?
    var liveMeasure: (CGPoint, CGPoint)? { didSet { needsDisplay = true } }
    private var lastPointer: CGPoint?
    /// Z then click zooms in on that spot (⌥-click zooms out), like Shottr.
    private var zoomClickArmed = false

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay
        autoresizingMask = [.width, .height]
    }

    required init?(coder: NSCoder) { fatalError() }

    private var mag: CGFloat { editor?.magnification ?? 1 }
    private var canvasOrigin: CGPoint { editor?.doc.canvasRect.origin ?? .zero }

    private func docPoint(_ e: NSEvent) -> CGPoint {
        let v = convert(e.locationInWindow, from: nil)
        return CGPoint(x: v.x + canvasOrigin.x, y: v.y + canvasOrigin.y)
    }

    private func viewRect(_ r: CGRect) -> CGRect { r.offsetBy(dx: -canvasOrigin.x, dy: -canvasOrigin.y) }

    // MARK: Drawing

    override func draw(_ dirtyRect: NSRect) {
        guard let editor, let cg = NSGraphicsContext.current?.cgContext else { return }
        let doc = editor.doc
        cg.saveGState()
        cg.translateBy(x: -canvasOrigin.x, y: -canvasOrigin.y)
        var anns = doc.annotations
        if let d = editor.draft { anns.append(d) }
        let rc = RenderContext(image: editor.image, scale: doc.scale, canvas: doc.canvasRect, effects: editor.effects,
                               shadowScale: mag * (window?.backingScaleFactor ?? 2) / 2, editingTextID: editor.editingTextID)
        Renderer.drawAll(anns, rc: rc, cg: cg)

        let accent = NSColor.controlAccentColor
        if let sel = editor.selected {
            drawSelection(sel, cg: cg, accent: accent)
        }
        if let r = editor.region {
            drawRegion(r, cg: cg, canvas: doc.canvasRect)
        }
        if let (a, b) = liveMeasure {
            let label = Renderer.rulerLabel(Annotation(kind: .ruler, p1: a, p2: b, color: "#FF2D78", size: 3))
            Renderer.drawMeasurement(from: a, to: b, label: label, color: NSColor(srgbRed: 1, green: 0.18, blue: 0.47, alpha: 1), cg: cg, unit: 1 / mag)
        }
        cg.restoreGState()
    }

    private func handlePoints(_ a: Annotation) -> [CGPoint] {
        if a.isTwoPointKind { return [a.p1, a.p2] }
        if a.isBoxKind { return a.rect.handlePoints }
        if a.kind == .magnifier { return [a.p2] }
        return []
    }

    private func drawSelection(_ a: Annotation, cg: CGContext, accent: NSColor) {
        let u = 1 / mag
        if !a.isTwoPointKind && !a.isBoxKind {
            let b = Renderer.bounds(of: a).insetBy(dx: -3 * u, dy: -3 * u)
            cg.setStrokeColor(accent.cgColor)
            cg.setLineWidth(1 * u)
            cg.setLineDash(phase: 0, lengths: [4 * u, 3 * u])
            cg.stroke(b)
            cg.setLineDash(phase: 0, lengths: [])
        } else if a.isBoxKind {
            cg.setStrokeColor(accent.withAlphaComponent(0.8).cgColor)
            cg.setLineWidth(1 * u)
            cg.stroke(a.rect)
        }
        for p in handlePoints(a) { drawHandle(p, cg: cg, accent: accent) }
    }

    private func drawHandle(_ p: CGPoint, cg: CGContext, accent: NSColor) {
        let u = 1 / mag
        let r = CGRect(x: p.x - 4.5 * u, y: p.y - 4.5 * u, width: 9 * u, height: 9 * u)
        cg.setShadow(offset: .zero, blur: 2, color: NSColor.black.withAlphaComponent(0.5).cgColor)
        cg.setFillColor(NSColor.white.cgColor)
        cg.fillEllipse(in: r)
        cg.setShadow(offset: .zero, blur: 0, color: nil)
        cg.setStrokeColor(accent.cgColor)
        cg.setLineWidth(1.5 * u)
        cg.strokeEllipse(in: r)
    }

    private func drawRegion(_ r: CGRect, cg: CGContext, canvas: CGRect) {
        let u = 1 / mag
        // Dim outside the selection slightly, Shottr-style marquee.
        let path = CGMutablePath()
        path.addRect(canvas)
        path.addRect(r)
        cg.addPath(path)
        cg.setFillColor(NSColor.black.withAlphaComponent(0.25).cgColor)
        cg.fillPath(using: .evenOdd)
        cg.setLineWidth(1 * u)
        cg.setStrokeColor(NSColor.black.withAlphaComponent(0.8).cgColor)
        cg.stroke(r)
        cg.setStrokeColor(NSColor.white.cgColor)
        cg.setLineDash(phase: 0, lengths: [4 * u, 4 * u])
        cg.stroke(r)
        cg.setLineDash(phase: 0, lengths: [])
        for p in r.handlePoints { drawHandle(p, cg: cg, accent: .controlAccentColor) }
        // Size label above the marquee.
        let label = "\(Int(r.width.rounded())) × \(Int(r.height.rounded()))"
        let font = NSFont.monospacedDigitSystemFont(ofSize: 11 * u, weight: .medium)
        let s = NSAttributedString(string: label, attributes: [.font: font, .foregroundColor: NSColor.white])
        let size = s.size()
        var pill = CGRect(x: r.minX, y: r.minY - size.height - 8 * u, width: size.width + 10 * u, height: size.height + 4 * u)
        if pill.minY < canvas.minY { pill.origin.y = r.minY + 4 * u; pill.origin.x += 4 * u }
        cg.addPath(CGPath(roundedRect: pill, cornerWidth: 4 * u, cornerHeight: 4 * u, transform: nil))
        cg.setFillColor(NSColor(white: 0.1, alpha: 0.85).cgColor)
        cg.fillPath()
        Renderer.withNSContext(cg) { s.draw(at: CGPoint(x: pill.minX + 5 * u, y: pill.minY + 2 * u)) }
    }

    // MARK: Hit testing

    private var tolerance: CGFloat { 6 / mag }

    private func handleIndex(_ a: Annotation, at p: CGPoint) -> Int? {
        let pts = handlePoints(a)
        let t = 7 / mag
        return pts.indices.first { pts[$0].distance(to: p) <= t }
    }

    private func annotation(at p: CGPoint) -> Annotation? {
        guard let editor else { return nil }
        // Selected first, then topmost.
        if let sel = editor.selected, Renderer.hitTest(sel, p, tolerance: tolerance) { return sel }
        return editor.doc.annotations.reversed().first { Renderer.hitTest($0, p, tolerance: tolerance) }
    }

    // MARK: Mouse

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let t = trackingArea { removeTrackingArea(t) }
        let t = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect, .cursorUpdate],
                               owner: self, userInfo: nil)
        addTrackingArea(t)
        trackingArea = t
    }

    override func mouseMoved(with e: NSEvent) {
        guard let editor else { return }
        let p = docPoint(e)
        lastPointer = p
        editor.pointerMoved(to: p)
        if let axis = editor.measureAxis ?? (editor.tool == .ruler ? .horizontal : nil) {
            if editor.measureAxis != nil || editor.tool == .ruler {
                liveMeasure = editor.sampler.measure(at: p, vertical: axis == .vertical)
            }
        }
        updateCursor(at: p)
    }

    override func mouseExited(with event: NSEvent) {
        editor?.pointerMoved(to: nil)
        lastPointer = nil
        if editor?.measureAxis == nil { liveMeasure = nil }
    }

    override func cursorUpdate(with event: NSEvent) { updateCursor(at: docPoint(event)) }

    func updateCursor(at p: CGPoint? = nil) {
        guard let editor, let p = p ?? lastPointer else { return }
        if spaceDown { NSCursor.openHand.set(); return }
        if zoomClickArmed { return }
        if let sel = editor.selected, handleIndex(sel, at: p) != nil { NSCursor.crosshair.set(); return }
        if editor.tool == .select, let r = editor.region {
            if r.handlePoints.contains(where: { $0.distance(to: p) <= 7 / mag }) { NSCursor.crosshair.set(); return }
            if r.contains(p) { NSCursor.openHand.set(); return }
        }
        if editor.tool != .eyedropper, annotation(at: p) != nil { NSCursor.openHand.set(); return }
        switch editor.tool {
        case .select: NSCursor.arrow.set()
        case .text: NSCursor.iBeam.set()
        default: NSCursor.crosshair.set()
        }
    }

    override func rightMouseDown(with e: NSEvent) {
        beginPan(e)
    }

    override func rightMouseDragged(with e: NSEvent) { continuePan(e) }
    override func rightMouseUp(with e: NSEvent) { drag = nil; updateCursor() }

    private func beginPan(_ e: NSEvent) {
        guard let clip = enclosingScrollView?.contentView else { return }
        drag = .pan(start: e.locationInWindow, origin: clip.bounds.origin)
        NSCursor.closedHand.set()
    }

    private func continuePan(_ e: NSEvent) {
        guard case let .pan(start, origin) = drag, let sv = enclosingScrollView else { return }
        let d = NSPoint(x: e.locationInWindow.x - start.x, y: e.locationInWindow.y - start.y)
        let m = sv.magnification
        sv.contentView.scroll(to: NSPoint(x: origin.x - d.x / m, y: origin.y + d.y / m))
        sv.reflectScrolledClipView(sv.contentView)
    }

    override func mouseDown(with e: NSEvent) {
        guard let editor else { return }
        if editor.editingTextID != nil {
            // Clicking inside the text being edited is handled by the text view.
            editor.endTextEditing()
        }
        window?.makeFirstResponder(self)
        if spaceDown { beginPan(e); return }
        let p = docPoint(e)
        dragBefore = editor.state

        // Imprint a live measurement.
        if let axis = editor.measureAxis, editor.tool != .ruler {
            if let (a, b) = editor.sampler.measure(at: p, vertical: axis == .vertical) {
                let ann = Annotation(kind: .ruler, p1: a, p2: b, color: editor.color, size: editor.currentSize(for: .ruler))
                editor.mutate("Measure") { $0.annotations.append(ann) }
            }
            editor.measureAxis = nil
            return
        }

        if e.modifierFlags.contains(.command), editor.tool == .select {
            editor.selectMonotone(at: p)
            return
        }

        if zoomClickArmed {
            zoomClickArmed = false
            editor.setZoom(editor.magnification * (e.modifierFlags.contains(.option) ? 0.5 : 2), centeredAt: convert(e.locationInWindow, from: nil))
            updateCursor()
            return
        }

        if editor.tool == .eyedropper {
            editor.pickColor(at: p, darkest: e.modifierFlags.contains(.shift), setAsColor: true)
            return
        }

        // Handles of the selected annotation.
        if let sel = editor.selected, let h = handleIndex(sel, at: p) {
            drag = .handle(sel.id, index: h, original: sel)
            return
        }

        // Selection marquee handles / move.
        if editor.tool == .select, let r = editor.region {
            if let h = r.handlePoints.indices.first(where: { r.handlePoints[$0].distance(to: p) <= 7 / mag }) {
                drag = .regionHandle(index: h, original: r)
                return
            }
            if r.contains(p) && annotation(at: p) == nil {
                drag = .regionMove(start: p, original: r)
                return
            }
        }

        // Existing annotation: select / move / duplicate / edit text.
        if let hit = annotation(at: p) {
            editor.region = nil
            if hit.kind == .text, e.clickCount == 2 || editor.tool == .text {
                editor.beginTextEditing(hit.id, isNew: false)
                return
            }
            var anns = editor.doc.annotations
            var id = hit.id
            var duplicated = false
            if e.modifierFlags.contains(.option) {
                var copy = hit
                copy.id = UUID()
                if copy.kind == .counter { copy.number = editor.doc.nextCounterNumber }
                anns.append(copy)
                editor.setAnnotationsLive(anns)
                id = copy.id
                duplicated = true
            }
            editor.selectedID = id
            drag = .moving(id, start: p, original: anns, duplicated: duplicated)
            return
        }

        editor.selectedID = nil
        switch editor.tool {
        case .select:
            editor.region = nil
            drag = .region(start: p)
        case .text:
            var a = editor.makeAnnotation(.text, at: p)
            let layout = Renderer.textLayout(a)
            a.p1 = CGPoint(x: p.x - layout.padding.width, y: p.y - layout.frame.height / 2)
            var anns = editor.doc.annotations
            anns.append(a)
            editor.setAnnotationsLive(anns)
            editor.beginTextEditing(a.id, isNew: true)
        case .counter:
            let a = editor.makeAnnotation(.counter, at: p)
            editor.mutate("Counter") { $0.annotations.append(a) }
            editor.selectedID = a.id
        case .eyedropper:
            break
        default:
            guard let kind = editor.tool.kind else { return }
            var a = editor.makeAnnotation(kind, at: p)
            if kind == .magnifier { a.p2 = CGPoint(x: p.x + 60, y: p.y) }
            editor.draft = a
            drag = .creating(a)
        }
    }

    override func mouseDragged(with e: NSEvent) {
        guard let editor, let d = drag else { return }
        if case .pan = d { continuePan(e); return }
        autoscroll(with: e)
        var p = docPoint(e)
        let shift = e.modifierFlags.contains(.shift)
        switch d {
        case .creating(var a):
            switch a.kind {
            case .arrow, .line, .ruler:
                a.p2 = shift ? p.snapped45(from: a.p1) : p
            case .freehand:
                if let last = a.path?.last, last.distance(to: p) >= 1 / mag { a.path?.append(p) }
                a.p2 = p
            case .highlight:
                if shift, let first = a.path?.first {
                    p.y = first.y
                    a.path = [first, p]
                } else if let last = a.path?.last, last.distance(to: p) >= 1 / mag {
                    a.path?.append(p)
                }
                a.p2 = p
            case .magnifier:
                a.p2 = p.distance(to: a.p1) < 12 ? CGPoint(x: a.p1.x + 60, y: a.p1.y) : p
            default:
                a.p2 = shift ? p.squared(from: a.p1) : p
            }
            drag = .creating(a)
            editor.draft = a

        case let .moving(id, start, original, _):
            let delta = CGVector(dx: p.x - start.x, dy: p.y - start.y)
            editor.setAnnotationsLive(original.map { a in
                guard a.id == id else { return a }
                var m = a
                m.offset(by: delta)
                return m
            })

        case let .handle(id, index, original):
            var a = original
            if a.isTwoPointKind {
                let anchor = index == 0 ? a.p2 : a.p1
                let q = shift ? p.snapped45(from: anchor) : p
                if index == 0 { a.p1 = q } else { a.p2 = q }
            } else if a.isBoxKind {
                var r = original.rect.resized(handle: index, to: p)
                if shift, index < 4 {
                    let anchor = original.rect.handlePoints[(index + 2) % 4]
                    r = CGRect(p1: anchor, p2: p.squared(from: anchor))
                }
                a.p1 = r.origin
                a.p2 = CGPoint(x: r.maxX, y: r.maxY)
            } else if a.kind == .magnifier {
                a.p2 = p
            }
            editor.updateAnnotation(id) { $0 = a }

        case let .region(start):
            let q = shift ? p.squared(from: start) : p
            editor.region = CGRect(p1: start, p2: q).intersection(editor.doc.canvasRect)

        case let .regionMove(start, original):
            editor.region = original.offsetBy(dx: p.x - start.x, dy: p.y - start.y)

        case let .regionHandle(index, original):
            editor.region = original.resized(handle: index, to: p)

        case .pan:
            break
        }
        editor.pointerMoved(to: p)
    }

    override func mouseUp(with e: NSEvent) {
        guard let editor, let d = drag else { return }
        drag = nil
        let before = dragBefore ?? editor.state
        dragBefore = nil
        switch d {
        case .creating(var a):
            editor.draft = nil
            let tiny = 3 / mag
            var keep = true
            switch a.kind {
            case .arrow, .line:
                keep = a.p1.distance(to: a.p2) >= tiny * 2
            case .ruler:
                if a.p1.distance(to: a.p2) < tiny * 2 {
                    // Click: imprint the auto-measured gap under the pointer.
                    if let (m1, m2) = editor.sampler.measure(at: a.p1, vertical: editor.measureAxis == .vertical) {
                        a.p1 = m1
                        a.p2 = m2
                    } else { keep = false }
                }
            case .freehand, .highlight, .magnifier:
                keep = true
            default:
                keep = a.rect.width >= tiny && a.rect.height >= tiny
            }
            if keep {
                editor.mutate(a.kind.rawValue.capitalized) { $0.annotations.append(a) }
                if a.kind != .ruler { editor.selectedID = a.id }
            }
        case .moving(_, _, _, let duplicated):
            editor.commit(duplicated ? "Duplicate" : "Move", from: before)
        case .handle:
            editor.commit("Resize", from: before)
        case .region:
            if let r = editor.region, r.width < 2 || r.height < 2 { editor.region = nil }
        case .regionMove, .regionHandle, .pan:
            break
        }
        updateCursor()
    }

    /// Cancels an in-progress drag (Esc while dragging). Returns whether there was one.
    func cancelDrag() -> Bool {
        guard let editor, let d = drag else { return false }
        drag = nil
        switch d {
        case .creating: editor.draft = nil
        case .moving, .handle: if let b = dragBefore { editor.state = b }
        case .region, .regionMove, .regionHandle: editor.region = nil
        case .pan: break
        }
        dragBefore = nil
        return true
    }

    override func scrollWheel(with e: NSEvent) {
        // ⌘-scroll zooms; plain scroll pans (handled by the scroll view).
        if e.modifierFlags.contains(.command), let editor {
            let factor = 1 + (e.hasPreciseScrollingDeltas ? e.scrollingDeltaY * 0.01 : e.scrollingDeltaY * 0.1)
            editor.setZoom(editor.magnification * factor, centeredAt: convert(e.locationInWindow, from: nil))
            return
        }
        super.scrollWheel(with: e)
    }

    // MARK: Keyboard

    override func keyDown(with e: NSEvent) {
        guard let editor else { return }
        let mods = e.modifierFlags.intersection([.command, .option, .control, .shift])
        let shift = mods.contains(.shift)
        let step: CGFloat = shift ? 10 : 1
        switch Int(e.keyCode) {
        case 53: editor.escape(); return
        case 36, 76:
            if editor.region != nil { editor.cropToRegion() }
            else if let sel = editor.selected, sel.kind == .text { editor.beginTextEditing(sel.id, isNew: false) }
            return
        case 51, 117: editor.deleteSelection(); return
        case 48:
            if let p = lastPointer { editor.pickColor(at: p, darkest: shift, setAsColor: false) }
            return
        case 49:
            if !spaceDown { spaceDown = true; NSCursor.openHand.set() }
            return
        case 123, 124, 125, 126:
            let dx: CGFloat = e.keyCode == 123 ? -step : (e.keyCode == 124 ? step : 0)
            let dy: CGFloat = e.keyCode == 126 ? -step : (e.keyCode == 125 ? step : 0)
            if editor.selectedID != nil || editor.region != nil {
                editor.nudge(dx: dx, dy: dy, resize: mods.contains(.command))
            } else {
                let axis: EditorController.Axis = (e.keyCode == 123 || e.keyCode == 124) ? .horizontal : .vertical
                editor.measureAxis = editor.measureAxis == axis ? nil : axis
                if let p = lastPointer, let a = editor.measureAxis { liveMeasure = editor.sampler.measure(at: p, vertical: a == .vertical) }
            }
            return
        default: break
        }
        guard !mods.contains(.command), !mods.contains(.control), let chars = e.charactersIgnoringModifiers?.lowercased(),
              let c = chars.first else {
            super.keyDown(with: e)
            return
        }
        if let d = c.wholeNumberValue, editor.selected?.kind == .counter || editor.selected?.kind == .spotlight {
            editor.typeDigit(d)
            return
        }
        // By key code: with ⇧ the characters are "{" / "}" (and differ per layout).
        if e.keyCode == 33 || e.keyCode == 30 {
            editor.growRegion((e.keyCode == 30 ? 1 : -1) * step)
            return
        }
        if c == "z" { zoomClickArmed = true; NSCursor(image: NSImage(systemSymbolName: "plus.magnifyingglass", accessibilityDescription: nil) ?? NSImage(), hotSpot: NSPoint(x: 8, y: 8)).set(); return }
        if editor.region != nil, c == "q" { editor.zoomToRegionCorner(bottomRight: false); return }
        if editor.region != nil, c == "w" { editor.zoomToRegionCorner(bottomRight: true); return }
        if editor.region != nil, c == "a" { editor.autoAdjustRegion(); return }
        if editor.region != nil, c == "b" { editor.obfuscateRegion(.blur); return }
        if editor.region != nil, c == "e" { editor.obfuscateRegion(.erase); return }
        if editor.region != nil, c == "c" { editor.copyAverageColor(); return }
        if let tool = EditorTool.forKey(c) {
            editor.setTool(tool)
            return
        }
        super.keyDown(with: e)
    }

    override func keyUp(with e: NSEvent) {
        if e.keyCode == 49 {
            spaceDown = false
            if case .pan = drag { drag = nil }
            updateCursor()
            return
        }
        super.keyUp(with: e)
    }

    override func flagsChanged(with event: NSEvent) {
        super.flagsChanged(with: event)
    }

    // MARK: In-place text editing

    func beginTextEditor(for id: UUID) {
        guard let editor, let a = editor.doc.annotations.first(where: { $0.id == id }) else { return }
        let tv = TextEditView(frame: .zero)
        tv.onChange = { [weak self] text in
            self?.editor?.textChanged(text)
            self?.syncTextEditor()
        }
        tv.onFinish = { [weak self] in self?.editor?.endTextEditing() }
        tv.string = a.text ?? ""
        textView = tv
        addSubview(tv)
        syncTextEditor()
        window?.makeFirstResponder(tv)
        tv.selectAll(nil)
        needsDisplay = true
    }

    /// Matches the text view to the annotation's current font, colours and frame.
    func syncTextEditor() {
        guard let editor, let tv = textView, let id = editor.editingTextID,
              let a = editor.doc.annotations.first(where: { $0.id == id }) else { return }
        let layout = Renderer.textLayout(a)
        tv.font = layout.font
        tv.textColor = layout.foreground
        tv.insertionPointColor = layout.foreground
        tv.textContainerInset = layout.padding
        tv.typingAttributes = [.font: layout.font, .foregroundColor: layout.foreground]
        let f = viewRect(layout.frame)
        tv.frame = CGRect(x: f.minX, y: f.minY, width: f.width + layout.font.pointSize, height: f.height)
        needsDisplay = true
    }

    func endTextEditor() {
        textView?.onChange = nil
        textView?.onFinish = nil
        textView?.removeFromSuperview()
        textView = nil
        needsDisplay = true
    }
}

/// Plain-text editor overlaid on a text annotation while typing.
final class TextEditView: NSTextView {
    var onChange: ((String) -> Void)?
    var onFinish: (() -> Void)?

    override init(frame: NSRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        setup()
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setup()
    }

    required init?(coder: NSCoder) { fatalError() }

    private func setup() {
        drawsBackground = false
        isRichText = false
        allowsUndo = false
        isAutomaticQuoteSubstitutionEnabled = false
        isAutomaticDashSubstitutionEnabled = false
        isAutomaticTextReplacementEnabled = false
        isAutomaticSpellingCorrectionEnabled = false
        isContinuousSpellCheckingEnabled = false
        isHorizontallyResizable = false
        isVerticallyResizable = false
        textContainer?.lineFragmentPadding = 0
        textContainer?.widthTracksTextView = false
        textContainer?.containerSize = NSSize(width: 100_000, height: 100_000)
        focusRingType = .none
    }

    override func didChangeText() {
        super.didChangeText()
        onChange?(string)
    }

    override func keyDown(with e: NSEvent) {
        if e.keyCode == 53 { onFinish?(); return }
        if (e.keyCode == 36 || e.keyCode == 76) && e.modifierFlags.contains(.command) { onFinish?(); return }
        super.keyDown(with: e)
    }

    override func cancelOperation(_ sender: Any?) { onFinish?() }
}
