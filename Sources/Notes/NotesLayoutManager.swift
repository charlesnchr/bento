import AppKit

/// TextKit 1 layout manager that hides markdown markers (null glyphs) and draws the
/// block decorations: bullets, numbers, checkboxes, quote bars, rules, code boxes,
/// heading fold chevrons and inline-code pills.
final class NotesLayoutManager: NSLayoutManager, NSLayoutManagerDelegate {
    var theme = NotesTheme()
    /// Line start of the heading under the mouse: its fold chevron shows while open.
    var hoveredHeading: Int?
    /// A note image by hash, nil while it isn't here (fetching it); and whether it's coming.
    var image: (String) -> NSImage? = { _ in nil }
    var imageLoading: (String) -> Bool = { _ in false }

    override init() {
        super.init()
        delegate = self
        allowsNonContiguousLayout = true
    }

    required init?(coder: NSCoder) { fatalError() }

    // MARK: Hidden glyphs

    func layoutManager(_ layoutManager: NSLayoutManager, shouldGenerateGlyphs glyphs: UnsafePointer<CGGlyph>,
                       properties props: UnsafePointer<NSLayoutManager.GlyphProperty>, characterIndexes charIndexes: UnsafePointer<Int>,
                       font aFont: NSFont, forGlyphRange glyphRange: NSRange) -> Int {
        guard let ts = textStorage, glyphRange.length > 0 else { return 0 }
        let first = charIndexes[0], last = charIndexes[glyphRange.length - 1]
        let charRange = NSRange(location: first, length: last - first + 1)
        var anyHidden = false
        ts.enumerateAttribute(.notesHidden, in: charRange, options: [.longestEffectiveRangeNotRequired]) { v, _, stop in
            if v != nil { anyHidden = true; stop.pointee = true }
        }
        guard anyHidden else { return 0 }
        var newProps = Array(UnsafeBufferPointer(start: props, count: glyphRange.length))
        // Zero-advancement control glyphs (not .null): they stay in their own line
        // fragment, so decorations can find the line of a fully hidden prefix.
        for i in 0..<glyphRange.length where ts.attribute(.notesHidden, at: charIndexes[i], effectiveRange: nil) != nil {
            newProps[i] = .controlCharacter
        }
        newProps.withUnsafeBufferPointer { p in
            setGlyphs(glyphs, properties: p.baseAddress!, characterIndexes: charIndexes, font: aFont, forGlyphRange: glyphRange)
        }
        return glyphRange.length
    }

    func layoutManager(_ layoutManager: NSLayoutManager, shouldUse action: NSLayoutManager.ControlCharacterAction,
                       forControlCharacterAt charIndex: Int) -> NSLayoutManager.ControlCharacterAction {
        if let ts = textStorage, charIndex < ts.length, ts.attribute(.notesHidden, at: charIndex, effectiveRange: nil) != nil {
            return .zeroAdvancement
        }
        return action
    }

    // MARK: Geometry helpers

    /// Rect of the first line fragment of the paragraph starting at `charIndex`, and the
    /// baseline (both in container coordinates).
    func firstLine(ofParagraphAt charIndex: Int) -> (rect: NSRect, used: NSRect, baseline: CGFloat)? {
        guard let ts = textStorage, charIndex <= ts.length, numberOfGlyphs > 0 || ts.length == 0 else { return nil }
        if charIndex >= ts.length {
            // extra line fragment (empty last line)
            let r = extraLineFragmentRect
            guard r != .zero else { return nil }
            return (r, extraLineFragmentUsedRect, r.minY + (r.height * 0.75))
        }
        let g = glyphIndexForCharacter(at: charIndex)
        guard g < numberOfGlyphs else { return nil }
        var effective = NSRange()
        let rect = lineFragmentRect(forGlyphAt: g, effectiveRange: &effective, withoutAdditionalLayout: true)
        let used = lineFragmentUsedRect(forGlyphAt: g, effectiveRange: nil, withoutAdditionalLayout: true)
        // baseline of the first *visible* glyph on the line
        var bg = g
        while bg < NSMaxRange(effective), propertyForGlyph(at: bg) == .controlCharacter || propertyForGlyph(at: bg) == .null { bg += 1 }
        if bg >= NSMaxRange(effective) { bg = g }
        let loc = location(forGlyphAt: bg)
        return (rect, used, rect.minY + loc.y)
    }

    /// Union of the line fragments of a character range (container coordinates).
    func fragmentsRect(for charRange: NSRange) -> NSRect? {
        guard let ts = textStorage, ts.length > 0, charRange.location < ts.length else { return nil }
        let gr = glyphRange(forCharacterRange: charRange, actualCharacterRange: nil)
        guard gr.length > 0 else { return firstLine(ofParagraphAt: charRange.location)?.rect }
        var union = NSRect.null
        var g = gr.location
        while g < NSMaxRange(gr) {
            var eff = NSRange()
            let r = lineFragmentRect(forGlyphAt: g, effectiveRange: &eff, withoutAdditionalLayout: true)
            union = union.union(r)
            g = max(NSMaxRange(eff), g + 1)
        }
        return union.isNull ? nil : union
    }

    // MARK: Drawing

    override func drawBackground(forGlyphRange glyphsToShow: NSRange, at origin: NSPoint) {
        if let ts = textStorage, ts.length > 0 {
            let chars = characterRange(forGlyphRange: glyphsToShow, actualGlyphRange: nil)
            drawCodeBlocks(in: chars, origin: origin, ts: ts)
            drawInlineCode(in: chars, origin: origin, ts: ts)
        }
        super.drawBackground(forGlyphRange: glyphsToShow, at: origin)
    }

    override func drawGlyphs(forGlyphRange glyphsToShow: NSRange, at origin: NSPoint) {
        super.drawGlyphs(forGlyphRange: glyphsToShow, at: origin)
        guard let ts = textStorage, ts.length > 0 else { return }
        let chars = characterRange(forGlyphRange: glyphsToShow, actualGlyphRange: nil)
        let text = ts.string as NSString
        let paras = text.paragraphRange(for: chars)
        var loc = paras.location
        while loc < NSMaxRange(paras) {
            let p = text.paragraphRange(for: NSRange(location: loc, length: 0))
            if let d = ts.attribute(.notesBlock, at: loc, effectiveRange: nil) as? BlockDecoration {
                drawDecoration(d, paragraph: p, origin: origin, ts: ts)
            }
            if p.length == 0 { break }
            loc = NSMaxRange(p)
        }
    }

    private var containerWidth: CGFloat { textContainers.first?.size.width ?? 0 }

    private func drawDecoration(_ d: BlockDecoration, paragraph p: NSRange, origin: NSPoint, ts: NSTextStorage) {
        let t = theme
        switch d.kind {
        case .bullet(let level):
            guard let line = firstLine(ofParagraphAt: p.location) else { return }
            let glyph = ["•", "◦", "▪"][min(level, 2)]
            let size: CGFloat = level == 2 ? t.base * 0.8 : t.base + 2
            let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: size), .foregroundColor: t.bullet]
            let str = glyph as NSString
            let sz = str.size(withAttributes: attrs)
            let contentX = t.listIndent * CGFloat(level + 1)
            let font = NSFont.systemFont(ofSize: size)
            let baselineY = line.baseline
            str.draw(at: NSPoint(x: origin.x + contentX - 7 - sz.width, y: origin.y + baselineY - font.ascender + (level == 2 ? -t.base * 0.08 : 0) - (sz.height - font.ascender + font.descender) * 0 ), withAttributes: attrs)
        case .ordered(let level, let number):
            guard let line = firstLine(ofParagraphAt: p.location) else { return }
            let font = NSFont.monospacedDigitSystemFont(ofSize: t.base, weight: .regular)
            let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: t.accent]
            let str = "\(number)." as NSString
            let sz = str.size(withAttributes: attrs)
            let contentX = t.listIndent * CGFloat(level + 1)
            str.draw(at: NSPoint(x: origin.x + contentX - 5 - sz.width, y: origin.y + line.baseline - font.ascender), withAttributes: attrs)
        case .task(let level, let checked):
            guard let rect = checkboxRect(paragraphStart: p.location, level: level) else { return }
            let box = rect.offsetBy(dx: origin.x, dy: origin.y)
            let path = NSBezierPath(roundedRect: box.insetBy(dx: 0.75, dy: 0.75), xRadius: 4.5, yRadius: 4.5)
            path.lineWidth = 1.5
            t.accent.withAlphaComponent(checked ? 0.7 : 1).setStroke()
            path.stroke()
            if checked {
                t.accent.withAlphaComponent(0.7).setFill()
                NSBezierPath(roundedRect: box.insetBy(dx: 3, dy: 3), xRadius: 2.5, yRadius: 2.5).fill()
            }
        case .quote(let depth):
            guard let r = fragmentsRect(for: NSRange(location: p.location, length: max(1, p.length - 1))) else { return }
            let ps = ts.attribute(.paragraphStyle, at: p.location, effectiveRange: nil) as? NSParagraphStyle
            var top = r.minY
            // connect with a quote line directly above, otherwise start at the text
            let prevIsQuote: Bool = {
                guard p.location > 0, let pd = ts.attribute(.notesBlock, at: p.location - 1, effectiveRange: nil) as? BlockDecoration else { return false }
                if case .quote = pd.kind { return true }
                return false
            }()
            if !prevIsQuote { top += ps?.paragraphSpacingBefore ?? 0 }
            let bottom = r.maxY - (ps?.lineSpacing ?? 0) * 0.5
            t.accent.setFill()
            for i in 0..<depth {
                let x = origin.x + t.listIndent * CGFloat(i) + 7
                NSBezierPath(roundedRect: NSRect(x: x, y: origin.y + top, width: 2, height: bottom - top), xRadius: 1, yRadius: 1).fill()
            }
        case .rule(let revealed):
            guard !revealed, let line = firstLine(ofParagraphAt: p.location) else { return }
            let ps = ts.attribute(.paragraphStyle, at: p.location, effectiveRange: nil) as? NSParagraphStyle
            let top = line.rect.minY + (ps?.paragraphSpacingBefore ?? 0)
            let bottom = line.rect.maxY - (ps?.lineSpacing ?? 0)
            let y = ((top + bottom) / 2).rounded() - 1
            t.separator.setFill()
            NSBezierPath(roundedRect: NSRect(x: origin.x, y: origin.y + y, width: containerWidth, height: 2), xRadius: 1, yRadius: 1).fill()
        case .image(let hash, let w, let h, _):
            guard let line = firstLine(ofParagraphAt: p.location) else { return }
            let ps = ts.attribute(.paragraphStyle, at: p.location, effectiveRange: nil) as? NSParagraphStyle
            let height = MarkdownStyler.imageHeight(h)
            let top = line.rect.minY + (ps?.paragraphSpacingBefore ?? 0) - height - 6
            let width = min(CGFloat(w), containerWidth)
            let box = NSRect(x: origin.x, y: origin.y + top, width: width, height: h > 0 ? height * width / CGFloat(w) : height)
            drawImage(hash, in: box)
        default:
            break
        }
    }

    private func drawImage(_ hash: String, in box: NSRect) {
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        let clip = NSBezierPath(roundedRect: box, xRadius: 6, yRadius: 6)
        if let img = image(hash) {
            clip.addClip()
            img.draw(in: box, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: [.interpolation: NSImageInterpolation.high])
            return
        }
        theme.codeBackground.setFill()
        clip.fill()
        let label = imageLoading(hash) ? "Loading image…" : "Image not available"
        let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: theme.base * 0.85), .foregroundColor: theme.marker]
        let sz = (label as NSString).size(withAttributes: attrs)
        (label as NSString).draw(at: NSPoint(x: box.midX - sz.width / 2, y: box.midY - sz.height / 2), withAttributes: attrs)
    }

    /// Fold chevrons of the headings in `rect` (view coordinates; `origin`: the text
    /// container's origin): collapsed ones always, an open one while hovered. Drawn by the
    /// text view, since they sit in the margin left of the text container.
    func drawHeadingChevrons(in rect: NSRect, origin: NSPoint) {
        guard let ts = textStorage, ts.length > 0, let tc = textContainers.first else { return }
        // the lines at the rect's height (the rect may be just the margin, left of every line)
        let band = NSRect(x: 0, y: rect.minY - origin.y, width: max(1, tc.size.width), height: rect.height)
        let glyphs = glyphRange(forBoundingRectWithoutAdditionalLayout: band, in: tc)
        let chars = characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
        let text = ts.string as NSString
        let paras = text.paragraphRange(for: chars)
        var loc = paras.location
        let config = NSImage.SymbolConfiguration(pointSize: (theme.base * 0.75).rounded(), weight: .semibold)
            .applying(NSImage.SymbolConfiguration(paletteColors: [theme.bullet]))
        while loc < NSMaxRange(paras), loc < ts.length {
            let p = text.paragraphRange(for: NSRange(location: loc, length: 0))
            if let d = ts.attribute(.notesBlock, at: loc, effectiveRange: nil) as? BlockDecoration, let collapsed = d.collapsed,
               collapsed || hoveredHeading == p.location, let box = chevronRect(paragraphStart: p.location),
               let image = NSImage(systemSymbolName: collapsed ? "chevron.right" : "chevron.down", accessibilityDescription: nil)?
                .withSymbolConfiguration(config) {
                let r = box.offsetBy(dx: origin.x, dy: origin.y)
                let size = image.size
                image.draw(in: NSRect(x: r.midX - size.width / 2, y: r.midY - size.height / 2, width: size.width, height: size.height),
                           from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            }
            if p.length == 0 { break }
            loc = NSMaxRange(p)
        }
    }

    /// Fold chevron rect (container coordinates) of a heading line: in the margin left of
    /// the text.
    func chevronRect(paragraphStart: Int) -> NSRect? {
        guard let line = firstLine(ofParagraphAt: paragraphStart) else { return nil }
        let side: CGFloat = 14
        let font = textStorage.flatMap { paragraphStart < $0.length ? $0.attribute(.font, at: paragraphStart, effectiveRange: nil) as? NSFont : nil } ?? theme.bodyFont
        let centerY = line.baseline - (font.xHeight / 2) - 0.5
        let padding = textContainers.first?.lineFragmentPadding ?? 0
        return NSRect(x: padding - side - 4, y: (centerY - side / 2).rounded(), width: side, height: side)
    }

    /// Where a click toggles a heading's fold (container coordinates): the whole margin left
    /// of the text (`margin` wide), from the top of the heading's text to the bottom of its
    /// first line, and at least a few points around the chevron.
    func chevronTarget(paragraphStart: Int, margin: CGFloat) -> NSRect? {
        guard let box = chevronRect(paragraphStart: paragraphStart), let line = firstLine(ofParagraphAt: paragraphStart) else { return nil }
        let ps = textStorage.flatMap { paragraphStart < $0.length ? $0.attribute(.paragraphStyle, at: paragraphStart, effectiveRange: nil) as? NSParagraphStyle : nil }
        let top = min(box.minY - 5, line.rect.minY + (ps?.paragraphSpacingBefore ?? 0))
        let bottom = max(box.maxY + 5, line.rect.maxY)
        return NSRect(x: -margin, y: top, width: margin + 2, height: bottom - top)
    }

    /// Checkbox rect (container coordinates) of a task paragraph.
    func checkboxRect(paragraphStart: Int, level: Int) -> NSRect? {
        guard let line = firstLine(ofParagraphAt: paragraphStart) else { return nil }
        let t = theme
        let side: CGFloat = 14
        let contentX = t.listIndent * CGFloat(level + 1)
        // vertically centre on the text's x-height band of the first line
        let font = t.bodyFont
        let centerY = line.baseline - (font.xHeight / 2) - 0.5
        return NSRect(x: contentX - 22, y: (centerY - side / 2).rounded(), width: side, height: side)
    }

    private func drawCodeBlocks(in chars: NSRange, origin: NSPoint, ts: NSTextStorage) {
        let text = ts.string as NSString
        let paras = text.paragraphRange(for: chars)
        var done = Set<Int>()
        ts.enumerateAttribute(.notesCodeBlock, in: paras, options: []) { v, range, _ in
            guard v != nil else { return }
            var block = NSRange()
            _ = ts.attribute(.notesCodeBlock, at: range.location, longestEffectiveRange: &block, in: NSRange(location: 0, length: ts.length))
            guard !done.contains(block.location) else { return }
            done.insert(block.location)
            guard var r = fragmentsRect(for: block) else { return }
            let ps = ts.attribute(.paragraphStyle, at: block.location, effectiveRange: nil) as? NSParagraphStyle
            r.origin.y += (ps?.paragraphSpacingBefore ?? 0) - 2
            r.size.height -= (ps?.paragraphSpacingBefore ?? 0) - 2
            // if the block ends at the document end without a newline the extra fragment is excluded
            let box = NSRect(x: origin.x, y: origin.y + r.minY, width: containerWidth, height: r.height)
            theme.codeBackground.setFill()
            NSBezierPath(roundedRect: box, xRadius: 6, yRadius: 6).fill()
        }
    }

    private func drawInlineCode(in chars: NSRange, origin: NSPoint, ts: NSTextStorage) {
        guard let container = textContainers.first else { return }
        ts.enumerateAttribute(.notesInlineCode, in: chars, options: []) { v, range, _ in
            guard v != nil else { return }
            let gr = glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            guard gr.length > 0 else { return }
            let font = (ts.attribute(.font, at: range.location, effectiveRange: nil) as? NSFont) ?? theme.mono(theme.base * 0.9)
            // per line fragment, so wrapped spans get one pill per line
            var g = gr.location
            while g < NSMaxRange(gr) {
                var eff = NSRange()
                let frag = lineFragmentRect(forGlyphAt: g, effectiveRange: &eff, withoutAdditionalLayout: true)
                let sub = NSIntersectionRange(eff, gr)
                guard sub.length > 0 else { break }
                let bounds = boundingRect(forGlyphRange: sub, in: container)
                let baseline = frag.minY + location(forGlyphAt: sub.location).y
                let top = baseline - font.ascender - 1.5
                let bottom = baseline - font.descender + 1.5
                let pill = NSRect(x: origin.x + bounds.minX, y: origin.y + top, width: bounds.width, height: bottom - top)
                theme.codeBackground.setFill()
                NSBezierPath(roundedRect: pill, xRadius: 5, yRadius: 5).fill()
                g = NSMaxRange(sub)
            }
        }
    }
}
