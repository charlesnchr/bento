import Foundation

/// Block type of one line. The editor is line based: every line is one block,
/// like a paragraph in Raycast's editor.
enum BlockKind: Equatable {
    case paragraph
    case heading(Int)
    case bullet
    case ordered(Int)
    case task(checked: Bool)
    case quote(depth: Int)
    case rule
    /// A ``` / ~~~ line. `opening` is false for the closing fence.
    case fence(opening: Bool, lang: String)
    /// A line inside a fenced code block.
    case code
    /// "::: details Summary": opens an expander (VitePress / markdown-it-container syntax).
    case details
    /// ":::": closes an expander.
    case detailsEnd

    var isList: Bool {
        switch self {
        case .bullet, .ordered, .task: return true
        default: return false
        }
    }
}

/// Parse result of one line. Ranges are UTF-16 offsets relative to the line.
struct ParsedLine: Equatable {
    var kind: BlockKind
    /// Nesting level for list items (0 = top level).
    var level = 0
    /// Block syntax at the start of the line (indentation + marker), hidden in the editor.
    var prefixRange: NSRange
    /// Everything after the prefix.
    var contentRange: NSRange
    /// Bullet char / "1." / "[ ]" etc. inside the prefix.
    var markerRange: NSRange?
    /// The literal list marker character(s): "-", "*", "+", or "." / ")" for ordered lists.
    var bulletChar: Character = "-"

    var hasPrefix: Bool { prefixRange.length > 0 }
}

enum InlineKind: Equatable {
    case bold, italic, boldItalic, strike, underline, code
    case link(url: String)
    /// Bare URL or <url>; no hidden markers for bare URLs.
    case autolink(url: String)
}

/// One inline construct. `range` includes the markers.
struct InlineSpan: Equatable {
    var kind: InlineKind
    var range: NSRange
    var contentRange: NSRange
    var markers: [NSRange]
}

enum MarkdownParser {
    private static let space: UInt16 = 32, tab: UInt16 = 9, hash: UInt16 = 35, gt: UInt16 = 62
    private static let dash: UInt16 = 45, star: UInt16 = 42, plus: UInt16 = 43, underscore: UInt16 = 95
    private static let backtick: UInt16 = 96, tilde: UInt16 = 126, lbracket: UInt16 = 91, rbracket: UInt16 = 93
    private static let dot: UInt16 = 46, rparen: UInt16 = 41, x: UInt16 = 120, X: UInt16 = 88
    private static let colon: UInt16 = 58
    private static let detailsWord = Array("details".utf16)

    /// Number of spaces one list nesting level is written with.
    static let indentUnit = "    "

    // MARK: Blocks

    static func parseLine(_ line: String, inCode: Bool) -> ParsedLine {
        parseLine(Array(line.utf16), inCode: inCode)
    }

    static func parseLine(_ u: [UInt16], inCode: Bool) -> ParsedLine {
        let n = u.count
        let whole = NSRange(location: 0, length: n)
        let empty = NSRange(location: n, length: 0)

        if inCode {
            if isFence(u).map({ $0.lang.isEmpty }) == true {
                return ParsedLine(kind: .fence(opening: false, lang: ""), prefixRange: whole, contentRange: empty)
            }
            return ParsedLine(kind: .code, prefixRange: NSRange(location: 0, length: 0), contentRange: whole)
        }

        var i = 0, cols = 0
        while i < n, u[i] == space || u[i] == tab {
            cols += u[i] == tab ? 4 - cols % 4 : 1
            i += 1
        }

        if cols <= 3, let f = isFence(u) {
            return ParsedLine(kind: .fence(opening: true, lang: f.lang), prefixRange: whole, contentRange: empty)
        }

        if cols <= 3, let d = detailsLine(u, from: i) { return d }

        // Heading: up to 6 '#' followed by a space.
        if cols <= 3, i < n, u[i] == hash {
            var j = i
            while j < n, u[j] == hash { j += 1 }
            let level = j - i
            if level <= 6, j < n, u[j] == space {
                var k = j
                while k < n, u[k] == space { k += 1 }
                return ParsedLine(kind: .heading(level), prefixRange: NSRange(location: 0, length: k),
                                  contentRange: NSRange(location: k, length: n - k),
                                  markerRange: NSRange(location: i, length: level))
            }
        }

        if cols <= 3, isRule(u, from: i) {
            return ParsedLine(kind: .rule, prefixRange: whole, contentRange: empty)
        }

        // Blockquote: one or more '>' each optionally followed by a space.
        if cols <= 3, i < n, u[i] == gt {
            var j = i, depth = 0
            while j < n, u[j] == gt {
                depth += 1
                j += 1
                if j < n, u[j] == space { j += 1 }
                // allow "> > nested"
                var k = j
                while k < n, u[k] == space { k += 1 }
                if k < n, u[k] == gt { j = k } else { break }
            }
            return ParsedLine(kind: .quote(depth: depth), prefixRange: NSRange(location: 0, length: j),
                              contentRange: NSRange(location: j, length: n - j),
                              markerRange: NSRange(location: i, length: j - i))
        }

        let level = (cols + 3) / 4

        // Bullet / task: [-*+] followed by a space.
        if i < n, u[i] == dash || u[i] == star || u[i] == plus, i + 1 < n, u[i + 1] == space {
            let bullet = Character(UnicodeScalar(u[i])!)
            var j = i + 2
            // Task: "[ ]" / "[x]" followed by a space or end of line.
            if j + 2 < n, u[j] == lbracket, u[j + 2] == rbracket,
               u[j + 1] == space || u[j + 1] == x || u[j + 1] == X,
               j + 3 == n || u[j + 3] == space {
                let checked = u[j + 1] != space
                let marker = NSRange(location: j, length: 3)
                j += 3
                if j < n { j += 1 }
                return ParsedLine(kind: .task(checked: checked), level: level, prefixRange: NSRange(location: 0, length: j),
                                  contentRange: NSRange(location: j, length: n - j), markerRange: marker, bulletChar: bullet)
            }
            return ParsedLine(kind: .bullet, level: level, prefixRange: NSRange(location: 0, length: j),
                              contentRange: NSRange(location: j, length: n - j),
                              markerRange: NSRange(location: i, length: 1), bulletChar: bullet)
        }

        // Ordered: 1-9 digits, '.' or ')', then a space.
        if i < n, (48...57).contains(u[i]) {
            var j = i
            while j < n, j - i < 9, (48...57).contains(u[j]) { j += 1 }
            if j < n, u[j] == dot || u[j] == rparen, j + 1 < n, u[j + 1] == space {
                let number = Int(String(utf16CodeUnits: Array(u[i..<j]), count: j - i)) ?? 1
                let delim = Character(UnicodeScalar(u[j])!)
                return ParsedLine(kind: .ordered(number), level: level, prefixRange: NSRange(location: 0, length: j + 2),
                                  contentRange: NSRange(location: j + 2, length: n - j - 2),
                                  markerRange: NSRange(location: i, length: j - i + 1), bulletChar: delim)
            }
        }

        return ParsedLine(kind: .paragraph, prefixRange: NSRange(location: 0, length: 0), contentRange: whole)
    }

    /// ``` or ~~~ (3+) at the start (after ≤3 spaces); returns the info string.
    static func isFence(_ u: [UInt16]) -> (char: UInt16, lang: String)? {
        var i = 0
        while i < u.count, i < 4, u[i] == space { i += 1 }
        guard i < 4, i < u.count, u[i] == backtick || u[i] == tilde else { return nil }
        let c = u[i]
        var j = i
        while j < u.count, u[j] == c { j += 1 }
        guard j - i >= 3 else { return nil }
        let rest = String(utf16CodeUnits: Array(u[j...]), count: u.count - j).trimmingCharacters(in: .whitespaces)
        if c == backtick, rest.contains("`") { return nil }
        return (c, rest)
    }

    /// "::: details <summary>" (an expander's header) or a bare ":::" (its end).
    private static func detailsLine(_ u: [UInt16], from i: Int) -> ParsedLine? {
        let n = u.count
        guard i + 2 < n, u[i] == colon, u[i + 1] == colon, u[i + 2] == colon else { return nil }
        var j = i + 3
        while j < n, u[j] == space || u[j] == tab { j += 1 }
        if j == n {
            return ParsedLine(kind: .detailsEnd, prefixRange: NSRange(location: 0, length: n), contentRange: NSRange(location: n, length: 0))
        }
        let w = detailsWord.count
        guard j + w <= n, Array(u[j..<j + w]) == detailsWord, j + w == n || u[j + w] == space else { return nil }
        var k = j + w
        while k < n, u[k] == space { k += 1 }
        return ParsedLine(kind: .details, prefixRange: NSRange(location: 0, length: k), contentRange: NSRange(location: k, length: n - k),
                          markerRange: NSRange(location: i, length: j + w - i))
    }

    static func isRule(_ s: String) -> Bool { isRule(Array(s.utf16), from: 0) }

    static func isRule(_ u: [UInt16], from start: Int) -> Bool {
        var ch: UInt16 = 0, count = 0
        for i in start..<u.count {
            let c = u[i]
            if c == space || c == tab { continue }
            guard c == dash || c == star || c == underscore else { return false }
            if ch == 0 { ch = c } else if c != ch { return false }
            count += 1
        }
        return count >= 3
    }

    /// Lines of `text` with their ranges and parse results, tracking fences.
    /// `startInCode` is the fence state before `range`.
    static func parseLines(_ text: NSString, in range: NSRange? = nil, startInCode: Bool = false) -> [(range: NSRange, line: ParsedLine)] {
        let r = range ?? NSRange(location: 0, length: text.length)
        var out: [(NSRange, ParsedLine)] = []
        var inCode = startInCode
        var loc = r.location
        let end = NSMaxRange(r)
        while true {
            let lineRange = text.lineRange(for: NSRange(location: loc, length: 0))
            var contentEnd = NSMaxRange(lineRange)
            // strip the line terminator
            if contentEnd > lineRange.location, text.character(at: contentEnd - 1) == 10 { contentEnd -= 1 }
            if contentEnd > lineRange.location, text.character(at: contentEnd - 1) == 13 { contentEnd -= 1 }
            let lr = NSRange(location: lineRange.location, length: contentEnd - lineRange.location)
            let p = parseLine(utf16(text, lr), inCode: inCode)
            if case .fence(let opening, _) = p.kind { inCode = opening }
            out.append((lr, p))
            loc = NSMaxRange(lineRange)
            // A final "\n" is followed by an empty last line.
            let trailingEmptyLine = loc == text.length && lineRange.length > 0 && text.character(at: loc - 1) == 10
            if loc > end || (loc == end && !trailingEmptyLine) || lineRange.length == 0 { break }
        }
        return out
    }

    /// The closing ":::" line (without newline) of the expander whose summary line is
    /// `summary`; nil when another expander or the end of the note comes first.
    static func expanderEnd(after summary: NSRange, in text: NSString) -> NSRange? {
        var loc = NSMaxRange(summary)
        guard loc > summary.location, text.character(at: loc - 1) == 10 else { return nil }
        var inCode = false
        while loc < text.length {
            let full = text.lineRange(for: NSRange(location: loc, length: 0))
            var lineEnd = NSMaxRange(full)
            if lineEnd > full.location, text.character(at: lineEnd - 1) == 10 { lineEnd -= 1 }
            let r = NSRange(location: full.location, length: lineEnd - full.location)
            switch parseLine(utf16(text, r), inCode: inCode).kind {
            case .detailsEnd: return r
            case .details: return nil
            case .fence(let opening, _): inCode = opening
            default: break
            }
            loc = NSMaxRange(full)
        }
        return nil
    }

    static func utf16(_ text: NSString, _ r: NSRange) -> [UInt16] {
        var buf = [UInt16](repeating: 0, count: r.length)
        if r.length > 0 { text.getCharacters(&buf, range: r) }
        return buf
    }

    /// Whether the line starting at `lineStart` is inside a fenced code block
    /// (i.e. an odd number of fence lines precede it).
    static func isInCode(_ text: NSString, lineStart: Int) -> Bool {
        var inCode = false
        var loc = 0
        while loc < lineStart {
            let lr = text.lineRange(for: NSRange(location: loc, length: 0))
            // cheap pre-check before decoding the line
            let first = firstNonSpace(text, lr)
            if first == backtick || first == tilde {
                var end = NSMaxRange(lr)
                if end > lr.location, text.character(at: end - 1) == 10 { end -= 1 }
                let u = utf16(text, NSRange(location: lr.location, length: end - lr.location))
                if let f = isFence(u) {
                    if inCode { if f.lang.isEmpty { inCode = false } } else { inCode = true }
                }
            }
            if lr.length == 0 { break }
            loc = NSMaxRange(lr)
        }
        return inCode
    }

    private static func firstNonSpace(_ text: NSString, _ r: NSRange) -> UInt16 {
        var i = r.location
        while i < NSMaxRange(r), i - r.location < 4 {
            let c = text.character(at: i)
            if c != space { return c }
            i += 1
        }
        return 0
    }

    // MARK: Inline

    private static func re(_ p: String) -> NSRegularExpression { try! NSRegularExpression(pattern: p) }
    private static let linkRE = re(#"\[([^\[\]\n]+)\]\(([^()\s]*)\)"#)
    private static let angleRE = re(#"<((?:https?|mailto|ftp)://[^\s<>]+|mailto:[^\s<>]+)>"#)
    private static let urlRE = re(#"(?<![\w/@])(?:https?://|www\.)[^\s<>\[\]]+"#)
    private static let underlineRE = re(#"<u>(.+?)</u>"#)
    private static let boldItalicRE = re(#"(?<![\\*])(\*\*\*|___)(?=\S)(.+?)(?<=\S)\1(?!\*)"#)
    private static let boldRE = re(#"(?<![\\*])(\*\*|__)(?=\S)(.+?)(?<=[^\s\\])\1"#)
    private static let strikeRE = re(#"(?<!\\)~~(?=\S)(.+?)(?<=\S)~~"#)
    private static let italicStarRE = re(#"(?<![\*\\])\*(?=[^\s\*])(.+?)(?<=[^\s\*\\])\*(?!\*)"#)
    private static let italicUnderRE = re(#"(?<![_\w\\])_(?=[^\s_])(.+?)(?<=[^\s_\\])_(?![_\w])"#)

    /// Inline spans in `text` (one line or a content range of it). Ranges are in `text`'s
    /// coordinates; pass `range` to restrict to part of the string.
    static func inlineSpans(_ text: NSString, in range: NSRange? = nil) -> [InlineSpan] {
        let r = range ?? NSRange(location: 0, length: text.length)
        guard r.length > 0 else { return [] }
        guard r.location == 0, r.length == text.length else {
            // Work on a copy of just this line: the regexes would otherwise bridge (copy)
            // the whole document on every call, which made typing in long notes slow.
            let sub = text.substring(with: r) as NSString
            func shift(_ x: NSRange) -> NSRange { NSRange(location: x.location + r.location, length: x.length) }
            return inlineSpansOfWhole(sub).map { sp in
                InlineSpan(kind: sp.kind, range: shift(sp.range), contentRange: shift(sp.contentRange), markers: sp.markers.map(shift))
            }
        }
        return inlineSpansOfWhole(text)
    }

    private static func inlineSpansOfWhole(_ text: NSString) -> [InlineSpan] {
        let r = NSRange(location: 0, length: text.length)
        guard r.length > 0 else { return [] }
        var spans: [InlineSpan] = []
        // Ranges no other construct may partially overlap (code spans, link urls).
        var hard: [NSRange] = []

        // 1. Code spans.
        var i = r.location
        let end = NSMaxRange(r)
        while i < end {
            if text.character(at: i) == backtick {
                var j = i
                while j < end, text.character(at: j) == backtick { j += 1 }
                let k = j - i
                // find closing run of exactly k
                var m = j
                var found = -1
                while m < end {
                    if text.character(at: m) == backtick {
                        var e = m
                        while e < end, text.character(at: e) == backtick { e += 1 }
                        if e - m == k { found = m; break }
                        m = e
                    } else { m += 1 }
                }
                if found > j {
                    let full = NSRange(location: i, length: found + k - i)
                    spans.append(InlineSpan(kind: .code, range: full,
                                            contentRange: NSRange(location: j, length: found - j),
                                            markers: [NSRange(location: i, length: k), NSRange(location: found, length: k)]))
                    hard.append(full)
                    i = found + k
                    continue
                }
                i = j
                continue
            }
            i += 1
        }

        func free(_ x: NSRange) -> Bool {
            !hard.contains { NSIntersectionRange($0, x).length > 0 }
        }
        func allowed(_ whole: NSRange, markers: [NSRange]) -> Bool {
            // markers must not touch hard ranges; hard ranges must be fully inside or outside.
            for h in hard {
                for mk in markers where NSIntersectionRange(h, mk).length > 0 { return false }
                let inter = NSIntersectionRange(h, whole)
                if inter.length > 0 && inter.length != h.length { return false }
            }
            return true
        }

        // 2. Links [text](url)
        for m in linkRE.matches(in: text as String, range: r) {
            let whole = m.range
            guard free(whole) else { continue }
            let textR = m.range(at: 1), urlR = m.range(at: 2)
            let open = NSRange(location: whole.location, length: 1)
            let close = NSRange(location: NSMaxRange(textR), length: NSMaxRange(whole) - NSMaxRange(textR))
            spans.append(InlineSpan(kind: .link(url: text.substring(with: urlR)), range: whole, contentRange: textR, markers: [open, close]))
            hard.append(open)
            hard.append(close)
        }
        // 3. <url> and bare URLs
        for m in angleRE.matches(in: text as String, range: r) where free(m.range) {
            let inner = m.range(at: 1)
            spans.append(InlineSpan(kind: .autolink(url: text.substring(with: inner)), range: m.range, contentRange: inner,
                                    markers: [NSRange(location: m.range.location, length: 1), NSRange(location: NSMaxRange(inner), length: 1)]))
            hard.append(m.range)
        }
        for m in urlRE.matches(in: text as String, range: r) {
            var u = m.range
            // trim trailing punctuation
            while u.length > 0 {
                let c = text.character(at: NSMaxRange(u) - 1)
                if [46, 44, 59, 58, 33, 63, 41, 39, 34, 42, 95, 126].contains(c) { u.length -= 1 } else { break }
            }
            guard u.length > 4, free(u), !spans.contains(where: { NSIntersectionRange($0.range, u).length > 0 }) else { continue }
            var url = text.substring(with: u)
            if url.hasPrefix("www.") { url = "https://" + url }
            spans.append(InlineSpan(kind: .autolink(url: url), range: u, contentRange: u, markers: []))
            hard.append(u)
        }

        // 4. Emphasis-like constructs.
        var used: [NSRange] = [] // marker ranges already claimed
        func add(_ re: NSRegularExpression, _ kind: InlineKind, markerLen: (NSTextCheckingResult) -> Int) {
            for m in re.matches(in: text as String, range: r) {
                let whole = m.range
                let ml = markerLen(m)
                let open = NSRange(location: whole.location, length: ml)
                let close = NSRange(location: NSMaxRange(whole) - ml, length: ml)
                guard allowed(whole, markers: [open, close]),
                      !used.contains(where: { NSIntersectionRange($0, open).length > 0 || NSIntersectionRange($0, close).length > 0 }) else { continue }
                spans.append(InlineSpan(kind: kind, range: whole, contentRange: NSRange(location: NSMaxRange(open), length: close.location - NSMaxRange(open)), markers: [open, close]))
                used.append(open)
                used.append(close)
            }
        }
        for m in underlineRE.matches(in: text as String, range: r) {
            let whole = m.range
            let open = NSRange(location: whole.location, length: 3), close = NSRange(location: NSMaxRange(whole) - 4, length: 4)
            guard allowed(whole, markers: [open, close]) else { continue }
            spans.append(InlineSpan(kind: .underline, range: whole, contentRange: m.range(at: 1), markers: [open, close]))
            used.append(open); used.append(close)
        }
        add(boldItalicRE, .boldItalic) { _ in 3 }
        add(boldRE, .bold) { _ in 2 }
        add(strikeRE, .strike) { _ in 2 }
        add(italicStarRE, .italic) { _ in 1 }
        add(italicUnderRE, .italic) { _ in 1 }

        return spans.sorted { $0.range.location < $1.range.location }
    }

    /// Inline markdown removed: `**a** [b](c)` -> `a b`.
    static func stripInline(_ s: String) -> String {
        let ns = s as NSString
        let spans = inlineSpans(ns)
        guard !spans.isEmpty else { return s }
        var remove = IndexSet()
        for sp in spans {
            for m in sp.markers { remove.insert(integersIn: m.location..<NSMaxRange(m)) }
        }
        var out = [UInt16]()
        out.reserveCapacity(ns.length)
        for i in 0..<ns.length where !remove.contains(i) { out.append(ns.character(at: i)) }
        return String(utf16CodeUnits: out, count: out.count)
    }
}
