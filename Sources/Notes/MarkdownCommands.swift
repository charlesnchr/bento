import Foundation

/// One replacement in original-text coordinates.
struct TextEdit: Equatable {
    var range: NSRange
    var replacement: String
}

/// A set of non-overlapping edits plus the selection to set afterwards (final coordinates).
struct EditResult: Equatable {
    var edits: [TextEdit]
    var selection: NSRange

    /// Applies the edits to a string (used by tests and non-view callers).
    func apply(to text: String) -> String {
        let m = NSMutableString(string: text)
        for e in edits.sorted(by: { $0.range.location > $1.range.location }) {
            m.replaceCharacters(in: e.range, with: e.replacement)
        }
        return m as String
    }
}

enum BlockFormat: Equatable {
    case paragraph, heading(Int), bullet, ordered, task, quote, codeBlock
}

enum InlineFormat: String, CaseIterable {
    case bold, italic, strike, code, underline

    var open: String {
        switch self {
        case .bold: return "**"
        case .italic: return "*"
        case .strike: return "~~"
        case .code: return "`"
        case .underline: return "<u>"
        }
    }

    var close: String { self == .underline ? "</u>" : open }

    func matches(_ k: InlineKind) -> Bool {
        switch (self, k) {
        case (.bold, .bold), (.bold, .boldItalic), (.italic, .italic), (.italic, .boldItalic),
             (.strike, .strike), (.code, .code), (.underline, .underline): return true
        default: return false
        }
    }
}

/// Pure markdown editing operations on (text, selection). Every function returns the
/// edits to apply or nil when the default text-view behaviour should run.
enum MarkdownCommands {
    struct Line {
        var range: NSRange        // without terminator
        var full: NSRange         // with terminator
        var parsed: ParsedLine    // ranges relative to `range`
        var inCode: Bool          // fence state before the line

        var contentStart: Int { range.location + parsed.contentRange.location }
        var end: Int { NSMaxRange(range) }
        func text(_ t: NSString) -> String { t.substring(with: range) }
    }

    static func line(at loc: Int, in text: NSString) -> Line {
        let full = text.lineRange(for: NSRange(location: min(loc, text.length), length: 0))
        var end = NSMaxRange(full)
        if end > full.location, text.character(at: end - 1) == 10 { end -= 1 }
        if end > full.location, text.character(at: end - 1) == 13 { end -= 1 }
        let r = NSRange(location: full.location, length: end - full.location)
        let inCode = MarkdownParser.isInCode(text, lineStart: full.location)
        return Line(range: r, full: full, parsed: MarkdownParser.parseLine(MarkdownParser.utf16(text, r), inCode: inCode), inCode: inCode)
    }

    /// Lines touched by a selection (a selection ending right after a newline does not
    /// include the next line).
    static func lines(in sel: NSRange, of text: NSString) -> [Line] {
        let first = line(at: sel.location, in: text)
        var lastLoc = NSMaxRange(sel)
        if sel.length > 0, text.character(at: lastLoc - 1) == 10 { lastLoc -= 1 }
        var out = [first]
        var inCode = first.inCode
        if case .fence(let opening, _) = first.parsed.kind { inCode = opening }
        var cur = first
        // Continue while the selection reaches the next line and the current line has a terminator.
        while NSMaxRange(cur.full) <= lastLoc, cur.full.length > cur.range.length {
            let full = text.lineRange(for: NSRange(location: NSMaxRange(cur.full), length: 0))
            var end = NSMaxRange(full)
            if end > full.location, text.character(at: end - 1) == 10 { end -= 1 }
            let r = NSRange(location: full.location, length: end - full.location)
            let p = MarkdownParser.parseLine(MarkdownParser.utf16(text, r), inCode: inCode)
            cur = Line(range: r, full: full, parsed: p, inCode: inCode)
            out.append(cur)
            if case .fence(let opening, _) = p.kind { inCode = opening }
        }
        return out
    }

    // MARK: Return

    static func newline(_ text: NSString, selection sel: NSRange) -> EditResult? {
        let l = line(at: sel.location, in: text)
        let rel = sel.location - l.range.location
        switch l.parsed.kind {
        case .code:
            let ws = leadingWhitespace(text, l.range, upTo: rel)
            return EditResult(edits: [TextEdit(range: sel, replacement: "\n" + ws)],
                              selection: NSRange(location: sel.location + 1 + (ws as NSString).length, length: 0))
        case .fence(opening: true, _):
            guard sel.length == 0, rel == l.range.length, !hasClosingFence(text, after: l) else { return nil }
            let fence = fenceChars(text, l.range)
            return EditResult(edits: [TextEdit(range: sel, replacement: "\n\n" + fence)],
                              selection: NSRange(location: sel.location + 1, length: 0))
        case .details:
            // Return at the end of an unclosed expander's summary closes it, like a code fence
            guard sel.length == 0, rel == l.range.length, MarkdownParser.expanderEnd(after: l.full, in: text) == nil else { return nil }
            return EditResult(edits: [TextEdit(range: sel, replacement: "\n\n:::")],
                              selection: NSRange(location: sel.location + 1, length: 0))
        case .bullet, .ordered, .task, .quote:
            let p = l.parsed
            let content = (text.substring(with: NSRange(location: l.contentStart, length: l.end - l.contentStart)))
            if sel.length == 0, content.trimmingCharacters(in: .whitespaces).isEmpty {
                if p.kind.isList, p.level > 0 {
                    let removed = outdentLength(text, l.range)
                    return EditResult(edits: [TextEdit(range: NSRange(location: l.range.location, length: removed), replacement: "")],
                                      selection: NSRange(location: sel.location - removed, length: 0))
                }
                return EditResult(edits: [TextEdit(range: NSRange(location: l.range.location, length: l.range.length), replacement: "")],
                                  selection: NSRange(location: l.range.location, length: 0))
            }
            var target = sel
            if target.location < l.contentStart {
                target = NSRange(location: l.contentStart, length: max(0, NSMaxRange(sel) - l.contentStart))
            }
            let prefix = continuationPrefix(text, l)
            return EditResult(edits: [TextEdit(range: target, replacement: "\n" + prefix)],
                              selection: NSRange(location: target.location + 1 + (prefix as NSString).length, length: 0))
        default:
            return nil
        }
    }

    /// The prefix a new item after `l` gets.
    static func continuationPrefix(_ text: NSString, _ l: Line) -> String {
        let p = l.parsed
        let indent = leadingWhitespace(text, l.range, upTo: p.markerRange.map { $0.location } ?? 0)
        switch p.kind {
        case .bullet: return indent + "\(p.bulletChar) "
        case .ordered(let n): return indent + "\(n + 1)\(p.bulletChar) "
        case .task: return indent + "\(p.bulletChar) [ ] "
        case .quote(let depth): return String(repeating: "> ", count: depth)
        default: return ""
        }
    }

    static func hasClosingFence(_ text: NSString, after l: Line) -> Bool {
        var loc = NSMaxRange(l.full)
        while loc < text.length {
            let full = text.lineRange(for: NSRange(location: loc, length: 0))
            var end = NSMaxRange(full)
            if end > full.location, text.character(at: end - 1) == 10 { end -= 1 }
            let u = MarkdownParser.utf16(text, NSRange(location: full.location, length: end - full.location))
            if let f = MarkdownParser.isFence(u), f.lang.isEmpty { return true }
            if full.length == 0 { break }
            loc = NSMaxRange(full)
        }
        return false
    }

    private static func fenceChars(_ text: NSString, _ r: NSRange) -> String {
        let s = text.substring(with: r).trimmingCharacters(in: .whitespaces)
        let c = s.first ?? "`"
        return String(s.prefix { $0 == c })
    }

    static func leadingWhitespace(_ text: NSString, _ r: NSRange, upTo rel: Int) -> String {
        var i = 0
        while i < min(rel, r.length) {
            let c = text.character(at: r.location + i)
            if c != 32 && c != 9 { break }
            i += 1
        }
        return text.substring(with: NSRange(location: r.location, length: i))
    }

    /// Characters removed from the start of a line to outdent it one level.
    static func outdentLength(_ text: NSString, _ r: NSRange) -> Int {
        var i = 0, cols = 0
        while i < r.length, cols < 4 {
            let c = text.character(at: r.location + i)
            if c == 9 { if cols == 0 { i += 1 }; break }
            if c != 32 { break }
            cols += 1
            i += 1
        }
        return i
    }

    // MARK: Tab / Shift-Tab

    static func indent(_ text: NSString, selection sel: NSRange, outdent: Bool) -> EditResult? {
        let ls = lines(in: sel, of: text).filter { $0.parsed.kind.isList && !$0.inCode }
        guard !ls.isEmpty else { return nil }
        var edits: [TextEdit] = []
        for l in ls {
            if outdent {
                let n = outdentLength(text, l.range)
                if n > 0 { edits.append(TextEdit(range: NSRange(location: l.range.location, length: n), replacement: "")) }
            } else {
                edits.append(TextEdit(range: NSRange(location: l.range.location, length: 0), replacement: MarkdownParser.indentUnit))
            }
        }
        if edits.isEmpty { return EditResult(edits: [], selection: sel) }
        return EditResult(edits: edits, selection: map(sel, through: edits))
    }

    // MARK: Inline formats

    static func toggleInline(_ text: NSString, selection sel: NSRange, format f: InlineFormat) -> EditResult {
        let open = f.open, close = f.close
        let ol = (open as NSString).length, cl = (close as NSString).length
        if sel.length == 0 {
            let l = line(at: sel.location, in: text)
            let spans = MarkdownParser.inlineSpans(text, in: NSRange(location: l.contentStart, length: l.end - l.contentStart))
            if !l.inCode, let s = spans.first(where: { f.matches($0.kind) && $0.contentRange.location <= sel.location && sel.location <= NSMaxRange($0.contentRange) }) {
                // At the end of the span: step out of it (typing continues unformatted).
                if sel.location == NSMaxRange(s.contentRange), let closeMarker = s.markers.last {
                    return EditResult(edits: [], selection: NSRange(location: NSMaxRange(closeMarker), length: 0))
                }
                return unwrap(s, format: f, selection: sel)
            }
            let w = wordRange(text, at: sel.location, within: l.range)
            if w.length > 0 {
                let edits = [TextEdit(range: NSRange(location: w.location, length: 0), replacement: open),
                             TextEdit(range: NSRange(location: NSMaxRange(w), length: 0), replacement: close)]
                return EditResult(edits: edits, selection: NSRange(location: sel.location + ol, length: 0))
            }
            return EditResult(edits: [TextEdit(range: sel, replacement: open + close)], selection: NSRange(location: sel.location + ol, length: 0))
        }

        let s = text.substring(with: sel) as NSString
        // Selection includes the markers: **text**
        if s.length >= ol + cl, s.hasPrefix(open), s.hasSuffix(close), !(f == .italic && s.hasPrefix("**") && !s.hasPrefix("***")) {
            let inner = s.substring(with: NSRange(location: ol, length: s.length - ol - cl))
            return EditResult(edits: [TextEdit(range: sel, replacement: inner)], selection: NSRange(location: sel.location, length: (inner as NSString).length))
        }
        // Markers right outside the selection: **[text]**
        if sel.location >= ol, NSMaxRange(sel) + cl <= text.length,
           text.substring(with: NSRange(location: sel.location - ol, length: ol)) == open,
           text.substring(with: NSRange(location: NSMaxRange(sel), length: cl)) == close,
           !(f == .italic && isStarRun(text, at: sel.location - ol)) {
            let edits = [TextEdit(range: NSRange(location: sel.location - ol, length: ol), replacement: ""),
                         TextEdit(range: NSRange(location: NSMaxRange(sel), length: cl), replacement: "")]
            return EditResult(edits: edits, selection: NSRange(location: sel.location - ol, length: sel.length))
        }
        // Selection inside an existing span of this kind.
        let l = line(at: sel.location, in: text)
        if NSMaxRange(sel) <= NSMaxRange(l.full) {
            let spans = MarkdownParser.inlineSpans(text, in: NSRange(location: l.contentStart, length: l.end - l.contentStart))
            if let sp = spans.first(where: { f.matches($0.kind) && NSLocationInRange(sel.location, $0.range) && NSMaxRange(sel) <= NSMaxRange($0.range) }) {
                return unwrap(sp, format: f, selection: sel)
            }
        }
        // Wrap (per line, trimming whitespace and skipping block prefixes).
        var edits: [TextEdit] = []
        for ln in lines(in: sel, of: text) {
            let start = max(sel.location, ln.inCode ? ln.range.location : ln.contentStart)
            let end = min(NSMaxRange(sel), ln.end)
            guard end > start else { continue }
            var a = start, b = end
            while a < b, isSpace(text.character(at: a)) { a += 1 }
            while b > a, isSpace(text.character(at: b - 1)) { b -= 1 }
            guard b > a else { continue }
            edits.append(TextEdit(range: NSRange(location: a, length: 0), replacement: open))
            edits.append(TextEdit(range: NSRange(location: b, length: 0), replacement: close))
        }
        guard !edits.isEmpty else { return EditResult(edits: [], selection: sel) }
        // Select the inner text: from after the first opening marker to before the last closing one.
        var delta = 0, selStart = 0, selEnd = 0
        for (i, e) in edits.enumerated() {
            if i == 0 { selStart = e.range.location + delta + ol }
            if i == edits.count - 1 { selEnd = e.range.location + delta }
            delta += (e.replacement as NSString).length
        }
        _ = cl
        return EditResult(edits: edits, selection: NSRange(location: selStart, length: max(0, selEnd - selStart)))
    }

    private static func unwrap(_ s: InlineSpan, format f: InlineFormat, selection sel: NSRange) -> EditResult {
        // boldItalic toggled by one format: replace *** with the other's marker.
        var edits: [TextEdit]
        if s.kind == .boldItalic {
            let keep = f == .bold ? "*" : "**"
            edits = [TextEdit(range: s.markers[0], replacement: keep), TextEdit(range: s.markers[1], replacement: keep)]
        } else {
            edits = s.markers.map { TextEdit(range: $0, replacement: "") }
        }
        return EditResult(edits: edits, selection: map(sel, through: edits))
    }

    private static func isStarRun(_ text: NSString, at loc: Int) -> Bool {
        loc > 0 && text.character(at: loc - 1) == 42
    }

    private static func isSpace(_ c: UInt16) -> Bool { c == 32 || c == 9 || c == 10 }

    private static func isWordChar(_ c: UInt16) -> Bool {
        guard let s = UnicodeScalar(c) else { return true } // surrogates: treat as word
        return CharacterSet.alphanumerics.contains(s) || c == 39 /* ' */
    }

    /// The word around `loc` (only when loc is inside or at the edge of a word).
    static func wordRange(_ text: NSString, at loc: Int, within r: NSRange) -> NSRange {
        var a = loc, b = loc
        while a > r.location, isWordChar(text.character(at: a - 1)) { a -= 1 }
        while b < NSMaxRange(r), isWordChar(text.character(at: b)) { b += 1 }
        // caret must be strictly inside the word
        guard a < loc, loc < b else { return NSRange(location: loc, length: 0) }
        return NSRange(location: a, length: b - a)
    }

    // MARK: Block formats

    static func setBlock(_ text: NSString, selection sel: NSRange, format: BlockFormat) -> EditResult? {
        let ls = lines(in: sel, of: text)
        if format == .codeBlock { return toggleCodeBlock(text, selection: sel, lines: ls) }
        let editable = ls.filter { l in
            if l.inCode { return false }
            switch l.parsed.kind {
            case .fence, .code, .rule, .details, .detailsEnd: return false
            default: return true
            }
        }
        guard !editable.isEmpty else { return nil }
        func matches(_ k: BlockKind) -> Bool {
            switch (format, k) {
            case (.heading(let a), .heading(let b)): return a == b
            case (.bullet, .bullet), (.ordered, .ordered), (.task, .task), (.quote, .quote): return true
            case (.paragraph, .paragraph): return true
            default: return false
            }
        }
        let allSame = editable.allSatisfy { matches($0.parsed.kind) }
        var edits: [TextEdit] = []
        var number = 1
        for l in editable {
            let p = l.parsed
            let keepIndent = p.kind.isList ? leadingWhitespace(text, l.range, upTo: p.markerRange?.location ?? 0) : ""
            var prefix: String
            if allSame || format == .paragraph {
                prefix = ""
            } else {
                switch format {
                case .heading(let n): prefix = String(repeating: "#", count: n) + " "
                case .bullet: prefix = keepIndent + "- "
                case .ordered: prefix = keepIndent + "\(number). "; number += 1
                case .task:
                    if case .task(let checked) = p.kind { prefix = keepIndent + "- [\(checked ? "x" : " ")] " } else { prefix = keepIndent + "- [ ] " }
                case .quote: prefix = "> "
                default: prefix = ""
                }
            }
            let old = NSRange(location: l.range.location, length: p.prefixRange.length)
            if text.substring(with: old) != prefix {
                edits.append(TextEdit(range: old, replacement: prefix))
            }
        }
        guard !edits.isEmpty else { return EditResult(edits: [], selection: sel) }
        return EditResult(edits: edits, selection: map(sel, through: edits, prefixAware: true))
    }

    private static func toggleCodeBlock(_ text: NSString, selection sel: NSRange, lines ls: [Line]) -> EditResult? {
        guard let first = ls.first, let last = ls.last else { return nil }
        let insideFirst: Bool = {
            if first.inCode { return true }
            if case .fence(true, _) = first.parsed.kind { return true }
            return false
        }()
        if insideFirst {
            // Remove the enclosing fences.
            let all = MarkdownParser.parseLines(text)
            guard let idx = all.firstIndex(where: { NSLocationInRange(first.range.location, $0.range) || $0.range.location == first.range.location }) else { return nil }
            var openIdx: Int? = nil
            var i = idx
            while i >= 0 {
                if case .fence(true, _) = all[i].line.kind { openIdx = i; break }
                i -= 1
            }
            guard let o = openIdx else { return nil }
            var closeIdx: Int? = nil
            var j = o + 1
            while j < all.count {
                if case .fence(false, _) = all[j].line.kind { closeIdx = j; break }
                j += 1
            }
            let openFull = text.lineRange(for: NSRange(location: all[o].range.location, length: 0))
            var edits = [TextEdit(range: openFull, replacement: "")]
            if let c = closeIdx {
                let cr = all[c].range
                if cr.location <= NSMaxRange(openFull) {
                    // empty block: the fences are adjacent, remove both lines in one edit
                    let closeFull = text.lineRange(for: NSRange(location: cr.location, length: 0))
                    edits = [TextEdit(range: NSRange(location: openFull.location, length: NSMaxRange(closeFull) - openFull.location), replacement: "")]
                } else {
                    // remove the closing line including the newline before it
                    edits.append(TextEdit(range: NSRange(location: cr.location - 1, length: cr.length + 1), replacement: ""))
                }
            }
            return EditResult(edits: edits, selection: map(sel, through: edits))
        }
        let edits = [TextEdit(range: NSRange(location: first.range.location, length: 0), replacement: "```\n"),
                     TextEdit(range: NSRange(location: last.end, length: 0), replacement: "\n```")]
        return EditResult(edits: edits, selection: NSRange(location: sel.location + 4, length: sel.length))
    }

    // MARK: Tasks

    /// Flips the checkbox of every task line touched by the selection. With `cascade`,
    /// nested tasks below a single toggled task follow its new state.
    static func toggleTasks(_ text: NSString, selection sel: NSRange, cascade: Bool = false) -> EditResult? {
        let ls = lines(in: sel, of: text).filter { if case .task = $0.parsed.kind, !$0.inCode { return true }; return false }
        guard !ls.isEmpty else { return nil }
        var edits: [TextEdit] = []
        var newState = false
        for l in ls {
            guard case .task(let checked) = l.parsed.kind, let m = l.parsed.markerRange else { continue }
            newState = !checked
            edits.append(TextEdit(range: NSRange(location: l.range.location + m.location + 1, length: 1), replacement: checked ? " " : "x"))
        }
        if cascade, ls.count == 1, let parent = ls.first {
            var loc = NSMaxRange(parent.full)
            while loc < text.length {
                let l = line(at: loc, in: text)
                guard l.parsed.kind.isList, l.parsed.level > parent.parsed.level, !l.inCode else { break }
                if case .task(let checked) = l.parsed.kind, checked != newState, let m = l.parsed.markerRange {
                    edits.append(TextEdit(range: NSRange(location: l.range.location + m.location + 1, length: 1), replacement: newState ? "x" : " "))
                }
                if l.full.length == 0 { break }
                loc = NSMaxRange(l.full)
            }
        }
        return EditResult(edits: edits, selection: sel)
    }

    // MARK: Input rules (markdown shortcuts while typing)

    static func inputRule(_ text: NSString, selection sel: NSRange, typed: String) -> EditResult? {
        guard sel.length == 0, typed == " " || typed == "-" else { return nil }
        let l = line(at: sel.location, in: text)
        guard !l.inCode else { return nil }
        if case .code = l.parsed.kind { return nil }
        let before = text.substring(with: NSRange(location: l.range.location, length: sel.location - l.range.location))
        let afterEmpty = sel.location == l.end
        let ns = before as NSString
        let whole = NSRange(location: 0, length: ns.length)

        if typed == " " {
            // [] / [ ] / [x]  ->  - [ ]
            if let m = taskShortcutRE.firstMatch(in: before, range: whole) {
                let indent = ns.substring(with: m.range(at: 1))
                let mark = m.range(at: 2).length > 0 ? ns.substring(with: m.range(at: 2)) : " "
                let checked = mark.lowercased() == "x"
                let rep = indent + "- [\(checked ? "x" : " ")] "
                return EditResult(edits: [TextEdit(range: NSRange(location: l.range.location, length: ns.length), replacement: rep)],
                                  selection: NSRange(location: l.range.location + (rep as NSString).length, length: 0))
            }
            // ``` / ```lang / ~~~ + space -> code block
            if afterEmpty, let m = fenceShortcutRE.firstMatch(in: before, range: whole) {
                let fence = ns.substring(with: m.range(at: 1))
                let rep = before + "\n\n" + fence
                return EditResult(edits: [TextEdit(range: NSRange(location: l.range.location, length: ns.length), replacement: rep)],
                                  selection: NSRange(location: l.range.location + ns.length + 1, length: 0))
            }
            // ___ + space -> rule
            if afterEmpty, before == "___" {
                return EditResult(edits: [TextEdit(range: NSRange(location: l.range.location, length: 3), replacement: "---\n")],
                                  selection: NSRange(location: l.range.location + 4, length: 0))
            }
        } else if typed == "-", afterEmpty, before == "--" {
            // --- -> rule, caret moves to a new line below
            return EditResult(edits: [TextEdit(range: sel, replacement: "-\n")], selection: NSRange(location: sel.location + 2, length: 0))
        }
        return nil
    }

    private static let taskShortcutRE = try! NSRegularExpression(pattern: #"^(\s*)(?:[-*+] )?\[([ xX]?)\]$"#)
    private static let fenceShortcutRE = try! NSRegularExpression(pattern: #"^(```|~~~)[^\s`]*$"#)

    // MARK: Move lines

    static func moveLines(_ text: NSString, selection sel: NSRange, up: Bool) -> EditResult? {
        let ls = lines(in: sel, of: text)
        guard let first = ls.first, let last = ls.last else { return nil }
        // the empty line after a final newline isn't a line that can move
        if ls.count == 1, first.full.length == 0 { return nil }
        let blockStart = first.full.location
        let blockEnd = NSMaxRange(last.full)
        let other: NSRange
        if up {
            guard blockStart > 0 else { return nil }
            other = text.lineRange(for: NSRange(location: blockStart - 1, length: 0))
        } else {
            guard blockEnd < text.length || (blockEnd == text.length && last.full.length > last.range.length) else { return nil }
            if blockEnd >= text.length { return nil }
            other = text.lineRange(for: NSRange(location: blockEnd, length: 0))
        }
        let combined = NSUnionRange(NSRange(location: blockStart, length: blockEnd - blockStart), other)
        let combinedText = text.substring(with: combined)
        let trailingNewline = combinedText.hasSuffix("\n")
        let blockText = text.substring(with: NSRange(location: blockStart, length: blockEnd - blockStart))
        let otherText = text.substring(with: other)
        func strip(_ s: String) -> String { s.hasSuffix("\n") ? String(s.dropLast()) : s }
        let parts = up ? [strip(blockText), strip(otherText)] : [strip(otherText), strip(blockText)]
        let rep = parts.joined(separator: "\n") + (trailingNewline ? "\n" : "")
        let shift = up ? -((strip(otherText) as NSString).length + 1) : (strip(otherText) as NSString).length + 1
        // a selection that included the block's newline can't extend past the moved text
        let newEnd = combined.location + (rep as NSString).length
        let start = min(sel.location + shift, newEnd)
        return EditResult(edits: [TextEdit(range: combined, replacement: rep)],
                          selection: NSRange(location: start, length: max(0, min(sel.length, newEnd - start))))
    }

    // MARK: Deletion

    /// Backspace at the start of a heading/list/quote removes its marker.
    static func backspace(_ text: NSString, selection sel: NSRange) -> EditResult? {
        guard sel.length == 0, sel.location > 0 else { return nil }
        let l = line(at: sel.location, in: text)
        guard !l.inCode, l.parsed.hasPrefix, sel.location == l.contentStart else { return nil }
        switch l.parsed.kind {
        case .heading, .bullet, .ordered, .task, .quote:
            let r = NSRange(location: l.range.location, length: l.parsed.prefixRange.length)
            return EditResult(edits: [TextEdit(range: r, replacement: "")], selection: NSRange(location: l.range.location, length: 0))
        default:
            return nil
        }
    }

    /// Forward delete at a line end joins the next line's content without its marker.
    static func deleteForward(_ text: NSString, selection sel: NSRange) -> EditResult? {
        guard sel.length == 0, sel.location < text.length, text.character(at: sel.location) == 10 else { return nil }
        let next = line(at: sel.location + 1, in: text)
        guard !next.inCode, next.parsed.hasPrefix else { return nil }
        switch next.parsed.kind {
        case .heading, .bullet, .ordered, .task, .quote:
            return EditResult(edits: [TextEdit(range: NSRange(location: sel.location, length: 1 + next.parsed.prefixRange.length), replacement: "")],
                              selection: sel)
        default:
            return nil
        }
    }

    // MARK: Caret snapping

    /// Keeps a caret out of hidden block markers (heading/list/quote prefixes).
    static func snapCaret(_ text: NSString, proposed: Int, previous: Int) -> Int {
        let l = line(at: proposed, in: text)
        guard !l.inCode, l.parsed.hasPrefix, proposed < l.contentStart, proposed >= l.range.location else { return proposed }
        switch l.parsed.kind {
        case .heading, .bullet, .ordered, .task, .quote: break
        default: return proposed
        }
        if previous == l.contentStart, proposed < previous, l.range.location > 0 { return l.range.location - 1 }
        return l.contentStart
    }

    // MARK: Links

    static func insertLink(_ text: NSString, selection sel: NSRange, url: String?) -> EditResult {
        let label = text.substring(with: sel)
        if let url, !url.isEmpty {
            let rep = "[\(label.isEmpty ? url : label)](\(url))"
            return EditResult(edits: [TextEdit(range: sel, replacement: rep)],
                              selection: NSRange(location: sel.location + (rep as NSString).length, length: 0))
        }
        let rep = "[\(label)]()"
        let caret = label.isEmpty ? sel.location + 1 : sel.location + (rep as NSString).length - 1
        return EditResult(edits: [TextEdit(range: sel, replacement: rep)], selection: NSRange(location: caret, length: 0))
    }

    // MARK: Position mapping

    /// Maps a range through edits given in original coordinates.
    /// - insertBefore: insertions exactly at the range start land before it.
    /// - prefixAware: positions inside a replaced prefix move to its end.
    static func map(_ r: NSRange, through edits: [TextEdit], insertBefore: Bool = false, prefixAware: Bool = false) -> NSRange {
        func mapPos(_ p: Int, stickToEnd: Bool) -> Int {
            var delta = 0
            for e in edits {
                let repLen = (e.replacement as NSString).length
                if e.range.length == 0 {
                    if e.range.location < p || (e.range.location == p && stickToEnd) { delta += repLen }
                } else if NSMaxRange(e.range) <= p {
                    delta += repLen - e.range.length
                } else if e.range.location < p {
                    // inside a replaced range: snap to the end of the replacement
                    delta += (e.range.location + repLen) - p
                }
            }
            return p + delta
        }
        let s = mapPos(r.location, stickToEnd: !insertBefore)
        let e = r.length == 0 ? s : mapPos(NSMaxRange(r), stickToEnd: true)
        return NSRange(location: s, length: max(0, e - s))
    }
}
