import AppKit

/// Applies live markdown formatting to an NSTextStorage, line by line.
///
/// The text stays plain markdown. Block markers (`# `, `- `, `1. `, `- [ ] `, `> `)
/// are hidden and drawn as decorations by `NotesLayoutManager`; inline markers are
/// hidden unless the selection touches their span; code fences are hidden unless the
/// selection is inside the code block. Restyling is incremental: only edited lines,
/// plus following lines whose decoration changes (fences, list numbering).
final class MarkdownStyler {
    var theme = NotesTheme() { didSet { styleCache.removeAll(); lineHeights.removeAll() } }
    /// Selection used to decide which markers are revealed.
    private(set) var selection = NSRange(location: 0, length: 0)
    private var revealedRegion: NSRange?
    private var revealSignature: [NSRange] = []

    private var styleCache: [String: NSParagraphStyle] = [:]
    private var lineHeights: [CGFloat: CGFloat] = [:]
    private let measure = NSLayoutManager()

    // MARK: Entry points

    /// Styles the whole document.
    func styleAll(_ s: NSTextStorage) {
        s.beginEditing()
        styleLines(s, from: 0, minEnd: s.length, inCode: false, force: true)
        s.endEditing()
        revealedRegion = revealRegion(for: selection, in: s)
        revealSignature = signature(for: selection, in: s)
    }

    /// Call from `textStorage(_:didProcessEditing:...)` after character edits.
    func didEdit(_ s: NSTextStorage, editedRange: NSRange) {
        selection = NSRange(location: min(NSMaxRange(editedRange), s.length), length: 0)
        let text = s.mutableString
        let start = text.lineRange(for: NSRange(location: min(editedRange.location, text.length), length: 0)).location
        let end = NSMaxRange(text.lineRange(for: NSRange(location: min(NSMaxRange(editedRange), text.length), length: 0)))
        restyle(s, start: start, end: end)
        revealedRegion = revealRegion(for: selection, in: s)
        revealSignature = signature(for: selection, in: s)
    }

    /// Call when the selection changes; re-reveals markers around the new selection.
    func selectionChanged(_ s: NSTextStorage, to sel: NSRange) {
        guard sel != selection else { return }
        selection = sel
        let newRegion = revealRegion(for: sel, in: s)
        let newSig = signature(for: sel, in: s)
        guard newRegion != revealedRegion || newSig != revealSignature else { return }
        let old = revealedRegion
        revealedRegion = newRegion
        revealSignature = newSig
        s.beginEditing()
        if let old, NSMaxRange(old) <= s.length { restyle(s, start: old.location, end: NSMaxRange(old)) }
        if let newRegion { restyle(s, start: newRegion.location, end: NSMaxRange(newRegion)) }
        s.endEditing()
    }

    // MARK: Core

    private func restyle(_ s: NSTextStorage, start: Int, end: Int) {
        let text = s.mutableString
        var from = min(start, text.length)
        // Back up to the start of a list so numbering is right.
        while from > 0 {
            let prev = text.lineRange(for: NSRange(location: from - 1, length: 0))
            guard let d = decoration(s, at: prev.location), d.listLevel != nil else { break }
            from = prev.location
        }
        let inCode: Bool
        if from == 0 {
            inCode = false
        } else if let d = decoration(s, at: text.lineRange(for: NSRange(location: from - 1, length: 0)).location) {
            inCode = d.inCodeAfter
        } else {
            inCode = MarkdownParser.isInCode(text, lineStart: from)
        }
        styleLines(s, from: from, minEnd: end, inCode: inCode, force: false)
    }

    private func decoration(_ s: NSTextStorage, at loc: Int) -> BlockDecoration? {
        guard loc < s.length else { return nil }
        return s.attribute(.notesBlock, at: loc, effectiveRange: nil) as? BlockDecoration
    }

    private func styleLines(_ s: NSTextStorage, from: Int, minEnd: Int, inCode startInCode: Bool, force: Bool) {
        let text = s.mutableString
        let length = text.length
        var loc = from
        var inCode = startInCode
        var counters: [Int: Int] = [:]
        var prevDeco: BlockDecoration? = from > 0 ? decoration(s, at: text.lineRange(for: NSRange(location: from - 1, length: 0)).location) : nil
        // Fence reveal: the code block containing the selection.
        let selBlock = codeBlockRange(containing: selection, in: s)

        while loc <= length {
            let full = text.lineRange(for: NSRange(location: loc, length: 0))
            var contentEnd = NSMaxRange(full)
            if contentEnd > full.location, text.character(at: contentEnd - 1) == 10 { contentEnd -= 1 }
            let r = NSRange(location: full.location, length: contentEnd - full.location)
            let p = MarkdownParser.parseLine(MarkdownParser.utf16(text, r), inCode: inCode)
            var inCodeAfter = inCode
            if case .fence(let opening, _) = p.kind { inCodeAfter = opening }

            let kind = decorationKind(p, line: r, counters: &counters, prev: prevDeco, selBlock: selBlock, text: text)
            let deco = BlockDecoration(kind, inCodeAfter: inCodeAfter, first: r.location == 0)

            if full.length == 0 { break } // empty last line: nothing to style
            if !force, loc >= minEnd, let old = decoration(s, at: loc), old == deco { break }
            apply(s, line: r, full: full, parsed: p, deco: deco, text: text)

            prevDeco = deco
            inCode = inCodeAfter
            loc = NSMaxRange(full)
            if loc >= length { break }
        }
    }

    private func decorationKind(_ p: ParsedLine, line r: NSRange, counters: inout [Int: Int], prev: BlockDecoration?,
                                selBlock: NSRange?, text: NSMutableString) -> BlockDecoration.Kind {
        switch p.kind {
        case .paragraph:
            counters.removeAll()
            return .paragraph(empty: r.length == 0 || text.substring(with: r).trimmingCharacters(in: .whitespaces).isEmpty)
        case .heading(let l):
            counters.removeAll()
            var spaced = false
            if let prev, r.location > 0 {
                switch prev.kind {
                case .paragraph(let empty): spaced = !empty
                case .rule: spaced = false
                default: spaced = true
                }
            }
            return .heading(level: min(l, 3), spaced: spaced)
        case .bullet:
            counters = counters.filter { $0.key < p.level }
            return .bullet(level: p.level)
        case .task(let checked):
            counters = counters.filter { $0.key < p.level }
            return .task(level: p.level, checked: checked)
        case .ordered(let n):
            counters = counters.filter { $0.key <= p.level }
            let number = counters[p.level].map { $0 + 1 } ?? n
            counters[p.level] = number
            return .ordered(level: p.level, number: number)
        case .quote(let d):
            counters.removeAll()
            return .quote(depth: d)
        case .rule:
            counters.removeAll()
            return .rule(revealed: selectionTouches(r))
        case .fence(let opening, _):
            counters.removeAll()
            let revealed = selBlock.map { NSIntersectionRange($0, r).length > 0 || NSLocationInRange(r.location, $0) } ?? false
            return .fence(opening: opening, revealed: revealed)
        case .code:
            return .code
        }
    }

    private func selectionTouches(_ r: NSRange) -> Bool {
        selection.location <= NSMaxRange(r) && NSMaxRange(selection) >= r.location
    }

    // MARK: Attributes

    private func apply(_ s: NSTextStorage, line r: NSRange, full: NSRange, parsed p: ParsedLine, deco: BlockDecoration, text: NSMutableString) {
        let t = theme
        var font = t.bodyFont
        var color = t.paragraph
        var indent: CGFloat = 0
        var before: CGFloat = deco.first ? 0 : 8
        var tail: CGFloat = 0

        switch deco.kind {
        case .paragraph:
            break
        case .heading(let level, let spaced):
            font = t.headingFont(level)
            color = t.heading
            if !deco.first { before = spaced ? [30, 18, 18][level - 1] : 8 }
        case .bullet(let l), .ordered(let l, _):
            indent = t.listIndent * CGFloat(l + 1)
        case .task(let l, let checked):
            indent = t.listIndent * CGFloat(l + 1)
            if checked { color = t.checked }
        case .quote(let d):
            indent = t.listIndent * CGFloat(d)
        case .rule:
            color = t.marker
        case .fence:
            font = t.mono(max(6, (t.base * 0.6).rounded()))
            color = t.marker
            indent = t.base
            tail = -t.base
            if case .fence(true, _) = deco.kind, !deco.first { before = 8 } else { before = 0 }
        case .code:
            font = t.mono((t.base * 0.9).rounded())
            color = t.codeText
            indent = t.base
            tail = -t.base
            before = 0
        }

        let lineSpacing: CGFloat
        switch deco.kind {
        case .heading: lineSpacing = max(0, (font.pointSize * 1.25).rounded() - lineHeight(font))
        case .fence: lineSpacing = 0
        case .code: lineSpacing = max(0, (t.base * t.size.lineHeight).rounded() - lineHeight(font)) * 0.6
        default: lineSpacing = max(0, (t.base * t.size.lineHeight).rounded() - lineHeight(t.bodyFont))
        }
        let ps = paragraphStyle(indent: indent, before: before, spacing: lineSpacing, tail: tail)

        var attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color, .paragraphStyle: ps, .notesBlock: deco]
        if deco.isCode { attrs[.notesCodeBlock] = true }
        s.setAttributes(attrs, range: full)

        // Block prefix: hidden, remembered for caret snapping.
        switch deco.kind {
        case .heading, .bullet, .ordered, .task, .quote:
            if p.prefixRange.length > 0 {
                let pr = NSRange(location: r.location + p.prefixRange.location, length: p.prefixRange.length)
                s.addAttributes([.notesHidden: true, .notesPrefixLen: p.prefixRange.length], range: pr)
            }
        case .rule(let revealed):
            if !revealed, r.length > 0 { s.addAttribute(.notesHidden, value: true, range: r) }
        case .fence(_, let revealed):
            if !revealed, r.length > 0 { s.addAttribute(.notesHidden, value: true, range: r) }
            return
        case .code:
            return
        default:
            break
        }
        if case .rule = deco.kind { return }

        let content = NSRange(location: r.location + p.contentRange.location, length: p.contentRange.length)
        guard content.length > 0 else { return }
        styleInline(s, content: content, text: text, baseFont: font, baseColor: color, deco: deco)
    }

    private struct Flags: OptionSet, Hashable {
        let rawValue: UInt8
        static let bold = Flags(rawValue: 1), italic = Flags(rawValue: 2), strike = Flags(rawValue: 4)
        static let underline = Flags(rawValue: 8), code = Flags(rawValue: 16), link = Flags(rawValue: 32)
    }

    private func styleInline(_ s: NSTextStorage, content: NSRange, text: NSMutableString, baseFont: NSFont, baseColor: NSColor, deco: BlockDecoration) {
        let spans = MarkdownParser.inlineSpans(text, in: content)
        guard !spans.isEmpty else { return }
        let t = theme
        var flags = [Flags](repeating: [], count: content.length)
        var links: [(NSRange, String)] = []
        func mark(_ r: NSRange, _ f: Flags) {
            let a = max(r.location, content.location) - content.location
            let b = min(NSMaxRange(r), NSMaxRange(content)) - content.location
            guard b > a else { return }
            for i in a..<b { flags[i].insert(f) }
        }
        for sp in spans {
            switch sp.kind {
            case .bold: mark(sp.contentRange, .bold)
            case .italic: mark(sp.contentRange, .italic)
            case .boldItalic: mark(sp.contentRange, [.bold, .italic])
            case .strike: mark(sp.contentRange, .strike)
            case .underline: mark(sp.contentRange, .underline)
            case .code: mark(sp.range, .code)
            case .link(let url), .autolink(let url):
                mark(sp.contentRange, .link)
                links.append((sp.contentRange, url))
            }
        }
        // Runs of equal flags.
        let baseWeight = (baseFont.fontDescriptor.object(forKey: .traits) as? [NSFontDescriptor.TraitKey: Any])?[.weight] as? CGFloat ?? 0
        let isHeading: Bool = { if case .heading = deco.kind { return true }; return false }()
        var i = 0
        while i < flags.count {
            var j = i + 1
            while j < flags.count, flags[j] == flags[i] { j += 1 }
            let f = flags[i]
            let range = NSRange(location: content.location + i, length: j - i)
            if !f.isEmpty {
                var attrs: [NSAttributedString.Key: Any] = [:]
                if f.contains(.code) {
                    attrs[.font] = t.mono((baseFont.pointSize * 0.9).rounded(), weight: isHeading ? .semibold : .regular)
                    attrs[.foregroundColor] = t.codeText
                    attrs[.notesInlineCode] = true
                } else if f.contains(.bold) || f.contains(.italic) {
                    let w = f.contains(.bold) ? NSFont.Weight(max(baseWeight + 0.2, NSFont.Weight.semibold.rawValue)) : NSFont.Weight(baseWeight)
                    attrs[.font] = t.font(baseFont.pointSize, weight: w, italic: f.contains(.italic))
                }
                if f.contains(.strike) { attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
                if f.contains(.underline) || f.contains(.link) { attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue }
                if f.contains(.link) {
                    let checked: Bool = { if case .task(_, true) = deco.kind { return true }; return false }()
                    attrs[.foregroundColor] = checked ? t.accent.withAlphaComponent(0.7) : t.accent
                    attrs[.underlineColor] = t.accent.withAlphaComponent(0.6)
                }
                s.addAttributes(attrs, range: range)
            }
            i = j
        }
        for (r, url) in links {
            s.addAttributes([.notesLink: url, .toolTip: "\(url)\n⌘-click to open"], range: r)
        }
        // Markers: hidden unless the selection touches the span.
        for sp in spans where !sp.markers.isEmpty {
            let revealed = selectionTouches(sp.range)
            for m in sp.markers {
                if sp.kind == .code {
                    // backticks stay as thin transparent padding inside the pill
                    if revealed {
                        s.addAttributes([.foregroundColor: t.marker], range: m)
                    } else {
                        s.addAttributes([.foregroundColor: NSColor.clear, .font: t.mono(max(4, (baseFont.pointSize * 0.45).rounded()))], range: m)
                    }
                } else if revealed {
                    s.addAttributes([.foregroundColor: t.marker], range: m)
                    s.removeAttribute(.underlineStyle, range: m)
                } else {
                    s.addAttribute(.notesHidden, value: true, range: m)
                }
            }
        }
    }

    private func paragraphStyle(indent: CGFloat, before: CGFloat, spacing: CGFloat, tail: CGFloat) -> NSParagraphStyle {
        let key = "\(indent)|\(before)|\(spacing)|\(tail)"
        if let p = styleCache[key] { return p }
        let p = NSMutableParagraphStyle()
        p.firstLineHeadIndent = indent
        p.headIndent = indent
        p.tailIndent = tail
        p.paragraphSpacingBefore = before
        p.lineSpacing = spacing
        p.lineBreakMode = .byWordWrapping
        styleCache[key] = p
        return p
    }

    private func lineHeight(_ f: NSFont) -> CGFloat {
        if let h = lineHeights[f.pointSize * (f.isFixedPitch ? -1 : 1)] { return h }
        let h = measure.defaultLineHeight(for: f)
        lineHeights[f.pointSize * (f.isFixedPitch ? -1 : 1)] = h
        return h
    }

    // MARK: Reveal regions

    /// Lines whose styling depends on the selection.
    private func revealRegion(for sel: NSRange, in s: NSTextStorage) -> NSRange? {
        let text = s.mutableString
        guard text.length > 0 else { return nil }
        let a = text.lineRange(for: NSRange(location: min(sel.location, text.length), length: 0))
        let b = text.lineRange(for: NSRange(location: min(NSMaxRange(sel), text.length), length: 0))
        var region = NSUnionRange(a, b)
        if let block = codeBlockRange(containing: sel, in: s) { region = NSUnionRange(region, block) }
        return region
    }

    private func signature(for sel: NSRange, in s: NSTextStorage) -> [NSRange] {
        // spans touched by the selection on its lines + rule lines touched
        let text = s.mutableString
        guard text.length > 0 else { return [] }
        let region = NSUnionRange(text.lineRange(for: NSRange(location: min(sel.location, text.length), length: 0)),
                                  text.lineRange(for: NSRange(location: min(NSMaxRange(sel), text.length), length: 0)))
        guard region.length < 20_000 else { return [] }
        return MarkdownParser.inlineSpans(text, in: region).filter { selectionTouchesRange(sel, $0.range) && !$0.markers.isEmpty }.map(\.range)
    }

    private func selectionTouchesRange(_ sel: NSRange, _ r: NSRange) -> Bool {
        sel.location <= NSMaxRange(r) && NSMaxRange(sel) >= r.location
    }

    /// The fenced code block (fence lines included) containing the selection start.
    private func codeBlockRange(containing sel: NSRange, in s: NSTextStorage) -> NSRange? {
        let text = s.mutableString
        guard text.length > 0 else { return nil }
        let loc = min(sel.location, text.length - 1)
        guard s.attribute(.notesCodeBlock, at: loc, effectiveRange: nil) != nil else {
            // caret at the very end of a closing fence line without newline
            if sel.location == text.length, sel.location > 0, s.attribute(.notesCodeBlock, at: sel.location - 1, effectiveRange: nil) != nil {
                var r = NSRange()
                _ = s.attribute(.notesCodeBlock, at: sel.location - 1, longestEffectiveRange: &r, in: NSRange(location: 0, length: text.length))
                return r
            }
            return nil
        }
        var r = NSRange()
        _ = s.attribute(.notesCodeBlock, at: loc, longestEffectiveRange: &r, in: NSRange(location: 0, length: text.length))
        return r
    }
}
