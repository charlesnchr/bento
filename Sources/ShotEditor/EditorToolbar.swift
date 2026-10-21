import AppKit
import BentoCore

private extension NSToolbarItem.Identifier {
    static let tools = NSToolbarItem.Identifier("bento.editor.tools")
    static let style = NSToolbarItem.Identifier("bento.editor.style")
    static let actions = NSToolbarItem.Identifier("bento.editor.actions")
}

/// Compact dark toolbar: tools on the left, colour / size / variant next to
/// them, export actions on the right (Shottr layout).
final class EditorToolbar: NSObject, NSToolbarDelegate {
    let toolbar: NSToolbar
    private weak var editor: EditorController?
    private var toolButtons: [EditorTool: ToolButton] = [:]
    private let colorButton = ColorSwatchButton()
    private let sizeSlider = NSSlider(value: 4, minValue: 1, maxValue: 10, target: nil, action: nil)
    private let styleControl = NSSegmentedControl()
    private var styleKindShown: Annotation.Kind?
    private var colorPanelTarget: ColorPanelRelay?

    init(editor: EditorController) {
        self.editor = editor
        toolbar = NSToolbar(identifier: "BentoShotEditor")
        super.init()
        toolbar.delegate = self
        toolbar.displayMode = .iconOnly
        toolbar.allowsUserCustomization = false
        toolbar.showsBaselineSeparator = false
    }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.tools, .style, .flexibleSpace, .actions]
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        toolbarDefaultItemIdentifiers(toolbar)
    }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        let item = NSToolbarItem(itemIdentifier: id)
        switch id {
        case .tools:
            item.view = makeTools()
            item.label = "Tools"
        case .style:
            item.view = makeStyle()
            item.label = "Style"
        case .actions:
            item.view = makeActions()
            item.label = "Actions"
        default:
            return nil
        }
        return item
    }

    // MARK: Views

    private func makeTools() -> NSView {
        let stack = NSStackView()
        stack.orientation = .horizontal
        stack.spacing = 1
        for t in EditorTool.allCases {
            let b = ToolButton(symbol: t.symbol, tip: "\(t.title) (\(t.keyHint))")
            b.target = self
            b.action = #selector(toolClicked(_:))
            b.tag = EditorTool.allCases.firstIndex(of: t)!
            toolButtons[t] = b
            stack.addArrangedSubview(b)
        }
        return stack
    }

    private func makeStyle() -> NSView {
        colorButton.target = self
        colorButton.action = #selector(colorClicked(_:))
        colorButton.toolTip = "Colour"

        sizeSlider.target = self
        sizeSlider.action = #selector(sizeChanged(_:))
        sizeSlider.isContinuous = true
        sizeSlider.controlSize = .small
        sizeSlider.numberOfTickMarks = 10
        sizeSlider.allowsTickMarkValuesOnly = true
        sizeSlider.refusesFirstResponder = true
        sizeSlider.toolTip = "Size"
        sizeSlider.translatesAutoresizingMaskIntoConstraints = false
        sizeSlider.widthAnchor.constraint(equalToConstant: 72).isActive = true

        styleControl.segmentStyle = .separated
        styleControl.trackingMode = .selectOne
        styleControl.controlSize = .small
        styleControl.target = self
        styleControl.action = #selector(styleChanged(_:))
        styleControl.refusesFirstResponder = true

        let stack = NSStackView(views: [colorButton, sizeSlider, styleControl])
        stack.orientation = .horizontal
        stack.spacing = 8
        return stack
    }

    private func makeActions() -> NSView {
        func button(_ symbol: String, _ tip: String, _ action: Selector) -> NSButton {
            let b = ToolButton(symbol: symbol, tip: tip)
            b.target = self
            b.action = action
            return b
        }
        let menu = NSMenu()
        func add(_ title: String, _ key: String, _ mods: NSEvent.ModifierFlags, _ action: Selector) {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            i.target = self
            menu.addItem(i)
        }
        add("Save As…", "s", [.command, .shift], #selector(saveAs))
        add("Recognise Text", "t", [.command, .shift], #selector(ocr))
        add("Reset Crop", "r", [.command, .shift], #selector(resetCrop))
        menu.addItem(.separator())
        add("Zoom to Fit", "1", [.command], #selector(zoomFit))
        add("Actual Size", "0", [.command], #selector(zoomActual))
        menu.addItem(.separator())
        add("Capture History…", "y", [.command], #selector(history))
        add("Open Image File…", "o", [.command, .shift], #selector(openFile))
        add("Open Clipboard Image", "v", [.command, .shift], #selector(openClipboard))
        moreMenu = menu
        let more = button("ellipsis.circle", "More", #selector(showMore(_:)))

        let drag = DragHandleView()
        drag.editor = editor
        let stack = NSStackView(views: [
            button("text.viewfinder", "Recognise text, copy it (⇧⌘T)", #selector(ocr)),
            button("pin", "Pin to screen (⌘P)", #selector(pin)),
            button("square.and.arrow.down", "Save (⌘S)", #selector(save)),
            button("doc.on.doc", "Copy (⌘C) — Esc copies and closes", #selector(copyImage)),
            drag, more,
        ])
        stack.orientation = .horizontal
        stack.spacing = 1
        return stack
    }

    // MARK: State

    func update() {
        guard let editor else { return }
        for (t, b) in toolButtons { b.isSelectedTool = t == editor.tool }
        colorButton.color = HexColor.color(editor.selected?.color ?? editor.color)
        let kind = editor.styleKind
        let sizeKinds: Set<Annotation.Kind> = [.erase, .spotlight]
        sizeSlider.isEnabled = kind != nil && !sizeKinds.contains(kind!)
        if let kind {
            sizeSlider.doubleValue = editor.selected?.size ?? editor.currentSize(for: kind)
        }
        let styles = kind.map { Annotation.styles(for: $0) } ?? []
        if kind != styleKindShown {
            styleKindShown = kind
            styleControl.segmentCount = styles.count
            for (i, s) in styles.enumerated() {
                styleControl.setImage(NSImage(systemSymbolName: s.symbol, accessibilityDescription: s.name), forSegment: i)
                styleControl.setToolTip(s.name, forSegment: i)
                styleControl.setWidth(24, forSegment: i)
            }
            styleControl.isHidden = styles.count < 2
        }
        if let kind, styles.count > 1 {
            styleControl.selectedSegment = (editor.selected?.style ?? editor.currentStyle(for: kind)).clamped(0...(styles.count - 1))
        }
        colorButton.isEnabled = kind != .blur && kind != .erase && kind != .spotlight
    }

    // MARK: Actions

    @objc private func toolClicked(_ sender: NSButton) {
        editor?.setTool(EditorTool.allCases[sender.tag])
        editor?.window.makeFirstResponder(editor?.canvas.annotationView)
    }

    @objc private func sizeChanged(_ sender: NSSlider) {
        let t = NSApp.currentEvent?.type
        let final = t != .leftMouseDown && t != .leftMouseDragged
        editor?.setSize(sender.doubleValue.rounded(), final: final)
    }

    @objc private func styleChanged(_ sender: NSSegmentedControl) {
        editor?.setStyle(sender.selectedSegment)
    }

    @objc private func colorClicked(_ sender: NSButton) {
        let menu = NSMenu()
        for (name, hex) in HexColor.palette {
            let item = NSMenuItem(title: name, action: #selector(paletteChosen(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = hex
            item.image = ColorSwatchButton.swatch(HexColor.color(hex), size: 14)
            if hex == editor?.color { item.state = .on }
            menu.addItem(item)
        }
        menu.addItem(.separator())
        let custom = NSMenuItem(title: "Custom…", action: #selector(customColor), keyEquivalent: "")
        custom.target = self
        menu.addItem(custom)
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 4), in: sender)
    }

    @objc private func paletteChosen(_ sender: NSMenuItem) {
        guard let hex = sender.representedObject as? String else { return }
        editor?.setColor(hex)
    }

    @objc private func customColor() {
        guard let editor else { return }
        let relay = ColorPanelRelay { [weak editor] c in editor?.setColor(HexColor.hex(c)) }
        colorPanelTarget = relay
        let panel = NSColorPanel.shared
        panel.showsAlpha = false
        panel.color = HexColor.color(editor.color)
        panel.setTarget(relay)
        panel.setAction(#selector(ColorPanelRelay.changed(_:)))
        panel.isContinuous = false
        panel.orderFront(nil)
    }

    private var moreMenu: NSMenu?

    @objc private func showMore(_ sender: NSButton) {
        moreMenu?.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 4), in: sender)
    }

    @objc private func ocr() { editor?.recognizeText() }
    @objc private func pin() { editor?.pin() }
    @objc private func save() { editor?.saveCommand() }
    @objc private func saveAs() { editor?.saveAs() }
    @objc private func copyImage() { editor?.copyImage() }
    @objc private func resetCrop() { editor?.resetCrop() }
    @objc private func zoomFit() { editor?.zoomToFit() }
    @objc private func zoomActual() { editor?.zoomActual() }
    @objc private func history() { ShotEditor.shared.showHistory() }
    @objc private func openFile() { ShotEditor.shared.openFilePanel() }
    @objc private func openClipboard() { ShotEditor.shared.openClipboardImage() }
}

private final class ColorPanelRelay: NSObject {
    let handler: (NSColor) -> Void
    init(_ handler: @escaping (NSColor) -> Void) { self.handler = handler }
    @objc func changed(_ sender: NSColorPanel) { handler(sender.color) }
}

/// Borderless icon button with Shottr-style filled highlight when selected.
final class ToolButton: NSButton {
    var isSelectedTool = false { didSet { if isSelectedTool != oldValue { needsDisplay = true; refreshTint() } } }

    init(symbol: String, tip: String) {
        super.init(frame: NSRect(x: 0, y: 0, width: 26, height: 24))
        let cfg = NSImage.SymbolConfiguration(pointSize: 14, weight: .regular)
        image = NSImage(systemSymbolName: symbol, accessibilityDescription: tip)?.withSymbolConfiguration(cfg)
        imagePosition = .imageOnly
        isBordered = false
        bezelStyle = .regularSquare
        toolTip = tip
        refusesFirstResponder = true
        wantsLayer = true
        layer?.cornerRadius = 6
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: 26).isActive = true
        heightAnchor.constraint(equalToConstant: 24).isActive = true
        refreshTint()
    }

    required init?(coder: NSCoder) { fatalError() }

    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        layer?.backgroundColor = isSelectedTool ? NSColor.controlAccentColor.cgColor : NSColor.clear.cgColor
    }

    private func refreshTint() {
        contentTintColor = isSelectedTool ? .white : NSColor(white: 0.86, alpha: 1)
    }
}

/// Round colour swatch that opens the palette.
final class ColorSwatchButton: NSButton {
    var color: NSColor = .systemRed { didSet { image = ColorSwatchButton.swatch(color, size: 16) } }

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: 24, height: 24))
        isBordered = false
        imagePosition = .imageOnly
        refusesFirstResponder = true
        image = ColorSwatchButton.swatch(color, size: 16)
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: 24).isActive = true
        heightAnchor.constraint(equalToConstant: 24).isActive = true
    }

    required init?(coder: NSCoder) { fatalError() }

    static func swatch(_ color: NSColor, size: CGFloat) -> NSImage {
        NSImage(size: NSSize(width: size, height: size), flipped: false) { r in
            let path = NSBezierPath(ovalIn: r.insetBy(dx: 1, dy: 1))
            color.setFill()
            path.fill()
            NSColor(white: 1, alpha: 0.55).setStroke()
            path.lineWidth = 1
            path.stroke()
            return true
        }
    }
}

/// Drag the flattened image out of the editor as a PNG file (Finder, Slack, …).
final class DragHandleView: NSView, NSDraggingSource {
    weak var editor: EditorController?
    private let icon = NSImageView()

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: 26, height: 24))
        let cfg = NSImage.SymbolConfiguration(pointSize: 14, weight: .regular)
        icon.image = NSImage(systemSymbolName: "arrow.up.forward.app", accessibilityDescription: "Drag image")?.withSymbolConfiguration(cfg)
        icon.contentTintColor = NSColor(white: 0.86, alpha: 1)
        icon.frame = bounds
        icon.autoresizingMask = [.width, .height]
        addSubview(icon)
        toolTip = "Drag the image into another app"
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: 26).isActive = true
        heightAnchor.constraint(equalToConstant: 24).isActive = true
    }

    required init?(coder: NSCoder) { fatalError() }

    override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }
    override func hitTest(_ point: NSPoint) -> NSView? { frame.contains(point) ? self : nil }
    override var mouseDownCanMoveWindow: Bool { false }

    override func mouseDown(with event: NSEvent) {}

    override func mouseDragged(with event: NSEvent) {
        guard let editor, let url = editor.writeDragFile() else { return }
        let item = NSDraggingItem(pasteboardWriter: url as NSURL)
        let preview = NSImage(contentsOf: url) ?? NSImage()
        let maxSide: CGFloat = 160
        let s = preview.size.width > 0 ? min(1, maxSide / max(preview.size.width, preview.size.height)) : 1
        let size = NSSize(width: max(20, preview.size.width * s), height: max(20, preview.size.height * s))
        let p = convert(event.locationInWindow, from: nil)
        item.setDraggingFrame(NSRect(x: p.x - size.width / 2, y: p.y - size.height / 2, width: size.width, height: size.height), contents: preview)
        beginDraggingSession(with: [item], event: event, source: self)
    }

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        context == .outsideApplication ? [.copy] : []
    }
}

/// Bottom bar: size, pointer position and colour, hint, zoom.
final class StatusBar: NSView {
    var onSizeClick: (() -> Void)?
    var onColorClick: (() -> Void)?
    private(set) var lastHex: String?

    private let sizeButton = NSButton(title: "", target: nil, action: nil)
    private let swatch = NSView()
    private let colorButton = NSButton(title: "", target: nil, action: nil)
    private let posLabel = NSTextField(labelWithString: "")
    private let hintLabel = NSTextField(labelWithString: "")
    private let zoomLabel = NSTextField(labelWithString: "")

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor(white: 0.16, alpha: 1).cgColor
        let font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        for b in [sizeButton, colorButton] {
            b.isBordered = false
            b.font = font
            b.contentTintColor = .secondaryLabelColor
            b.refusesFirstResponder = true
            b.target = self
        }
        sizeButton.action = #selector(sizeClicked)
        sizeButton.toolTip = "Click to copy the size"
        colorButton.action = #selector(colorClicked)
        colorButton.toolTip = "Colour under the pointer — click or press Tab to copy"
        swatch.wantsLayer = true
        swatch.layer?.cornerRadius = 3
        swatch.layer?.borderWidth = 0.5
        swatch.layer?.borderColor = NSColor(white: 1, alpha: 0.3).cgColor
        swatch.translatesAutoresizingMaskIntoConstraints = false
        swatch.widthAnchor.constraint(equalToConstant: 12).isActive = true
        swatch.heightAnchor.constraint(equalToConstant: 12).isActive = true
        swatch.isHidden = true
        for l in [posLabel, hintLabel, zoomLabel] {
            l.font = font
            l.textColor = .secondaryLabelColor
            l.lineBreakMode = .byTruncatingTail
        }
        hintLabel.font = .systemFont(ofSize: 11)
        hintLabel.textColor = .tertiaryLabelColor
        hintLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        posLabel.setContentHuggingPriority(.required, for: .horizontal)
        let left = NSStackView(views: [sizeButton, swatch, colorButton, posLabel])
        left.spacing = 8
        let stack = NSStackView(views: [left, NSView(), hintLabel, zoomLabel])
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 0, left: 12, bottom: 0, right: 12)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        let line = NSBox()
        line.boxType = .separator
        line.translatesAutoresizingMaskIntoConstraints = false
        addSubview(line)
        NSLayoutConstraint.activate([
            line.leadingAnchor.constraint(equalTo: leadingAnchor),
            line.trailingAnchor.constraint(equalTo: trailingAnchor),
            line.topAnchor.constraint(equalTo: topAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    func setSize(width: CGFloat, height: CGFloat, scale: CGFloat, isSelection: Bool) {
        let w = Int(width.rounded()), h = Int(height.rounded())
        var s = "\(w) × \(h)"
        if scale != 1 { s += "  (\(Int((width * scale).rounded())) × \(Int((height * scale).rounded())) px)" }
        sizeButton.title = (isSelection ? "Selection " : "") + s
    }

    func setZoom(_ z: CGFloat) { zoomLabel.stringValue = "\(Int((z * 100).rounded()))%" }
    func setHint(_ s: String) { hintLabel.stringValue = s }

    func setPointer(_ p: CGPoint?, hex: String?) {
        lastHex = hex
        swatch.isHidden = hex == nil
        colorButton.title = hex ?? ""
        if let hex { swatch.layer?.backgroundColor = HexColor.color(hex).cgColor }
        posLabel.stringValue = p.map { "\(Int($0.x)), \(Int($0.y))" } ?? ""
    }

    @objc private func sizeClicked() { onSizeClick?() }
    @objc private func colorClicked() { onColorClick?() }
}
