import Foundation

// Writes notes-vectors.jsonl: expected outputs of the Mac's Notes code (TextMerge,
// MarkdownParser, NoteText, NoteWire, SyncHeadsCodec, ThoughtCapture, FuzzyMatch,
// RelativeDate, the live-merge fuzz) for NotesCrossCheckTest. See generate.sh.

var out: [String] = []
func emit(_ obj: [String: Any]) {
    let d = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
    out.append(String(decoding: d, as: UTF8.self))
}
func opt(_ x: Any?) -> Any { x ?? NSNull() }
func rr(_ r: NSRange) -> [Int] { [r.location, r.length] }
func enc(_ e: [TextEdit]) -> [[Any]] { e.map { [$0.range.location, $0.range.length, $0.replacement] } }

struct SplitMix {
    var state: UInt64
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
    mutating func int(_ n: Int) -> Int { n <= 0 ? 0 : Int(next() % UInt64(n)) }
    mutating func pick<T>(_ a: [T]) -> T { a[int(a.count)] }
}

let atoms: [String] = [
    "a", "b", "c", "x", "y", "z", "e", "the ", "quick ", "brown ", "fox ", "word", "line", "milk", "eggs", " ", "  ", "\t",
    "\n", "\n", "\n", "\n", "\n\n", "\r\n", "\r\n", "\r",
    "# ", "## ", "- ", "* ", "1. ", "- [ ] ", "- [x] ", "> ", "```", "~~~", "---", "**", "*", "_", "~~", "`", "<u>", "</u>",
    "[l](https://x.y)", "https://a.b/c_d", "www.example.com", "<https://q.r/s>",
    "<details>", "</details>", "<summary>", "</summary>", "<details open>", "::: details ", ":::",
    "😀", "😁", "👍", "👍🏽", "👩‍👩‍👧", "👨🏽‍💻", "🏳️‍🌈", "❤️", "☺︎", "1️⃣", "🇩🇰", "🇬🇧", "🇺🇸", "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
    "e\u{301}", "\u{e9}", "a\u{308}\u{301}", "\u{301}", "\u{200D}", "\u{200C}", "\u{FE0F}", "\u{1F3FB}",
    "日本語", "中文", "한국어", "\u{1100}\u{1161}\u{11A8}", "\u{1100}", "\u{1161}", "\u{11A8}",
    "क्षत्रिय", "नमस्ते", "क्", "ष", "স্ত্র", "สวัสดี", "مرحبا", "שלום", "\u{0600}1",
    "\u{2028}", "\u{2029}", "\u{0085}", "\u{000B}", "\u{000C}", "\u{00A0}", "\u{3000}", "\u{0}",
    "Ω", "İ", "ß", "ﬁ", "Σ", "𝔘𝔫𝔦",
]
let words = ["alpha", "beta", "gamma", "delta", "milk", "eggs", "note", "plan", "shared", "edited", "line", "text"]

func scalars(_ s: String) -> [Unicode.Scalar] { Array(s.unicodeScalars) }
func str(_ a: [Unicode.Scalar]) -> String {
    var v = String.UnicodeScalarView()
    v.append(contentsOf: a)
    return String(v)
}
func randomText(_ r: inout SplitMix, _ n: Int) -> String {
    var s = ""
    for _ in 0..<n { s += r.pick(atoms) }
    return s
}
func lineStarts(_ a: [Unicode.Scalar]) -> [Int] {
    var o = [0]
    for (i, c) in a.enumerated() where c == "\n" { o.append(i + 1) }
    return o
}

/// Random edits at scalar positions (so inside composed characters too), at character
/// boundaries, and of whole lines and line ends.
func mutate(_ s: String, _ r: inout SplitMix, _ count: Int) -> String {
    var a = scalars(s)
    for _ in 0..<count {
        switch r.int(12) {
        case 0, 1, 2:
            a.insert(contentsOf: r.pick(atoms).unicodeScalars, at: r.int(a.count + 1))
        case 3:
            a.insert(contentsOf: (r.pick(words) + (r.int(2) == 0 ? " " : "")).unicodeScalars, at: r.int(a.count + 1))
        case 4, 5:
            if a.isEmpty { continue }
            let at = r.int(a.count), len = min(a.count - at, 1 + r.int(5))
            a.removeSubrange(at..<(at + len))
        case 6:
            if a.isEmpty { continue }
            let at = r.int(a.count), len = min(a.count - at, 1 + r.int(4))
            a.replaceSubrange(at..<(at + len), with: r.pick(atoms).unicodeScalars)
        case 7:
            let at = r.pick(lineStarts(a))
            a.insert(contentsOf: (r.pick(words) + " " + r.pick(atoms) + "\n").unicodeScalars, at: at)
        case 8:
            let ends = a.indices.filter { a[$0] == "\n" || a[$0] == "\r" } + [a.count]
            let at = r.pick(ends)
            a.insert(contentsOf: (r.int(2) == 0 ? " " + r.pick(words) : r.pick(atoms)).unicodeScalars, at: at)
        case 9:
            let ls = lineStarts(a)
            if ls.count < 2 { continue }
            let i = r.int(ls.count - 1)
            a.removeSubrange(ls[i]..<ls[i + 1])
        case 10:
            let nl = a.indices.filter { a[$0] == "\n" }
            if nl.isEmpty { a.append("\n"); continue }
            let i = r.pick(nl)
            if i > 0, a[i - 1] == "\r" { a.remove(at: i - 1) } else { a.insert("\r", at: i) }
        default:
            var bounds = [0], x = 0
            for c in str(a) { x += c.unicodeScalars.count; bounds.append(x) }
            a.insert(contentsOf: r.pick(atoms).unicodeScalars, at: r.pick(bounds))
        }
    }
    return str(a)
}

func charBounds(_ s: String) -> [Int] {
    var o = [0], x = 0
    for c in s { x += c.utf16.count; o.append(x) }
    return o
}
func composedRanges(_ s: String) -> [[Int]] {
    let ns = s as NSString
    return (0..<ns.length).map { rr(ns.rangeOfComposedCharacterSequence(at: $0)) }
}

// MARK: TextMerge

var mergeCount = 0
func emitMerge(_ base: String, _ local: String, _ remote: String, _ r: inout SplitMix, long: Bool = false) {
    let el = TextMerge.edits(from: base, to: local), er = TextMerge.edits(from: base, to: remote)
    let m = TextMerge.merge(base: base, local: local, remote: remote)
    let m2 = TextMerge.merge(base: base, local: remote, remote: local)
    let bl = (base as NSString).length
    var sels: [[Int]] = [], points: [[Int]] = []
    for _ in 0..<3 {
        let a = r.int(bl + 1), len = r.int(3) == 0 ? 0 : r.int(bl - a + 1)
        let mm = TextMerge.map(NSRange(location: a, length: len), through: el)
        sels.append([a, len, mm.location, mm.length])
        let x = r.int(bl + 1)
        for past in [false, true] {
            for inside in [false, true] {
                points.append([x, past ? 1 : 0, inside ? 1 : 0, TextMerge.map(x, through: er, pastInsertions: past, insideToEnd: inside)])
            }
        }
    }
    var obj: [String: Any] = ["t": "merge", "base": base, "local": local, "remote": remote, "el": enc(el), "er": enc(er),
                              "m": opt(m), "m2": opt(m2), "sel": sels, "pt": points]
    if !long { obj["ex"] = enc(TextMerge.edits(from: local, to: remote)) }
    emit(obj)
    mergeCount += 1
}

for i in 0..<2400 {
    var r = SplitMix(state: UInt64(i) &* 7919 &+ 17)
    let base = randomText(&r, r.int(i % 3 == 0 ? 60 : 25))
    var local = base, remote = base
    switch i % 8 {
    case 4: // the same change on both, more on one
        let both = mutate(base, &r, 1)
        local = both
        remote = r.int(2) == 0 ? mutate(both, &r, 1) : both
    case 5: // typing at the same spot
        let a = scalars(base), at = r.int(a.count + 1)
        let x = r.pick(atoms) + (r.int(2) == 0 ? r.pick(words) : "")
        var y = r.pick(atoms)
        switch r.int(4) { case 0: y = x + y; case 1: y += x; case 2: y = x; default: break }
        var la = a; la.insert(contentsOf: x.unicodeScalars, at: at); local = str(la)
        var ra = a; ra.insert(contentsOf: y.unicodeScalars, at: at); remote = str(ra)
    case 6: // canonically equivalent edits
        let pairs = [("\u{e9}", "e\u{301}"), ("\u{c5}", "A\u{30a}"), ("\u{212b}", "\u{c5}"), ("\u{1e69}", "s\u{323}\u{307}"), ("\u{fb01}", "fi"), ("\u{e9}x", "e\u{301}x")]
        let (x, y) = r.pick(pairs)
        let a = scalars(base), at = r.int(a.count + 1)
        if r.int(2) == 0 {
            var la = a; la.insert(contentsOf: x.unicodeScalars, at: at); local = str(la)
            var ra = a; ra.insert(contentsOf: y.unicodeScalars, at: at); remote = str(ra)
        } else {
            let len = min(a.count - at, 1 + r.int(3))
            var la = a; la.replaceSubrange(at..<(at + len), with: x.unicodeScalars); local = str(la)
            var ra = a; ra.replaceSubrange(at..<(at + len), with: y.unicodeScalars); remote = str(ra)
        }
    case 7: // one side unchanged or both identical
        local = mutate(base, &r, 1 + r.int(3))
        remote = [base, local, base][r.int(3)]
        if r.int(2) == 0 { swap(&local, &remote) }
    default:
        local = mutate(base, &r, 1 + r.int(4))
        remote = mutate(base, &r, 1 + r.int(4))
    }
    emitMerge(base, local, remote, &r)
}

// Long texts: line diff first, then by character; past the limits one replacement.
func editLines(_ lines: [String], _ r: inout SplitMix, _ count: Int, every: Int = 0) -> [String] {
    var l = lines
    if every > 0 {
        for k in stride(from: r.int(every), to: l.count, by: every) { l[k] += " changed" }
        return l
    }
    for _ in 0..<count {
        let k = r.int(l.count)
        switch r.int(4) {
        case 0: l[k] = mutate(l[k], &r, 1)
        case 1: l.insert(r.pick(words) + " inserted " + r.pick(atoms), at: k)
        case 2: if l.count > 1 { l.remove(at: k) }
        default: l[k] += " " + r.pick(words)
        }
    }
    return l
}
for i in 0..<64 {
    var r = SplitMix(state: 0xABCDEF &+ UInt64(i) &* 31)
    var lines: [String]
    var nl = "\n"
    switch i % 8 {
    case 0, 1: lines = (0..<3000).map { "line \($0) of a long note" }
    case 2: lines = (0..<400).map { "row \($0) " + r.pick(atoms) + r.pick(words) }; nl = i % 16 == 2 ? "\r\n" : "\n"
    case 3: lines = (0..<21_000).map { "x\($0 % 7)" }
    case 4: lines = (0..<2500).map { "entry \($0)" }
    case 5: lines = [String(repeating: "abcdefghij", count: 600)]
    case 6: lines = (0..<1500).map { _ in randomText(&r, 4).replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " ").replacingOccurrences(of: "\u{2028}", with: " ") }
    default: lines = (0..<120).map { "short \($0)" }
    }
    let base = lines.joined(separator: nl)
    var ll: [String], rl: [String]
    switch i % 8 {
    case 2, 7: // many small changes: past the character diff's limit
        ll = lines.map { r.int(2) == 0 ? mutate($0, &r, 1) : $0 }
        rl = editLines(lines, &r, 3)
    case 4: // more changed lines than the line diff allows
        ll = editLines(lines, &r, 0, every: 2)
        rl = editLines(lines, &r, 2)
    case 5:
        ll = [mutate(lines[0], &r, 3)]
        rl = [mutate(lines[0], &r, 2)]
    default:
        ll = editLines(lines, &r, 2 + r.int(5))
        rl = editLines(lines, &r, 2 + r.int(5))
    }
    emitMerge(base, ll.joined(separator: nl), rl.joined(separator: nl), &r, long: true)
}

// MARK: Graphemes (Swift Characters and NSString composed character sequences)

var gstrings = Set(atoms)
for i in 0..<400 {
    var r = SplitMix(state: 0x5151 &+ UInt64(i))
    gstrings.insert(mutate(randomText(&r, 1 + r.int(5)), &r, 2))
}
// short random runs of the code points the segmentation rules treat specially
let gpool: [String] = [
    "a", "b", "x", "1", " ", "\t", "\n", "\r", "\u{0}", "\u{200D}", "\u{200C}", "\u{034F}", "\u{FE0F}", "\u{FE0E}", "\u{301}", "\u{308}",
    "\u{1F3FB}", "\u{1F3FD}", "👩", "❤", "🌈", "🏳", "😀", "\u{1F1E9}", "\u{1F1F0}", "\u{1F1EC}", "\u{E0067}", "\u{E0062}", "\u{E007F}",
    "\u{1100}", "\u{1161}", "\u{11A8}", "가", "각", "\u{11A3}", "স", "্", "ত", "র", "क", "्", "ष", "\u{0D15}", "\u{0D4D}", "\u{17D2}",
    "ក", "\u{0E3A}", "\u{0903}", "\u{0600}", "\u{0D4E}", "\u{F870}", "\u{F860}", "\u{F861}", "\u{FF9E}", "ﾊ", "日", "\u{2028}", "\u{0085}",
    "\u{000B}", "\u{1F9D1}", "\u{2695}", "\u{20E3}", "#", "\u{1F44D}", "Ω", "\u{00A0}", "\u{0E33}", "\u{1F466}", "\u{0915}\u{094D}",
]
for i in 0..<6000 {
    var r = SplitMix(state: 0x7777 &+ UInt64(i) &* 13)
    var s = ""
    for _ in 0..<(1 + r.int(9)) { s += r.pick(gpool) }
    gstrings.insert(s)
}
for s in gstrings.sorted() where !s.isEmpty {
    emit(["t": "g", "s": s, "chars": charBounds(s), "composed": composedRanges(s)])
}

// MARK: MarkdownParser and NoteText

let lineAtoms = [
    "# Title", "## Sub heading", "### **Bold** heading", "#nospace", "- item", "* item", "+ item", "-item", "1. one", "12) twelve", "1.no",
    "- [ ] todo", "- [x] done", "- [X] Done", "- [ ]", "- [y] no", "    - child", "        - grandchild", "\t- tab child", " \t- mixed",
    "> quote", "> > nested", ">no space", "---", "***", "___", "- - -", "--", " * * * ", "-_-", "```swift", "```", "~~~", "~~~~",
    "``` js `x`", "   ```", "    ```", "~~~ lang ~", "::: details Summary here", ":::details Tight", "  ::: details", ":::", " :::  ",
    "::::", "::: tip Careful", "::: detailsx", "a ::: details", "    ::: details deep", ":: details", ":::\tdetails\tTab",
    "<details><summary>Some **idea**</summary>", "<DETAILS open> <Summary>X</Summary>", "<details>", "</details>", "  </details>  ",
    "<detailsx>", "</details> more", "<details", "    <details>", "a <details>", "<details open><summary>Open</summary>",
    "<details><summary>open</summary>", "<details\topen>", "<details open=\"\"><summary>A</summary> tail", "<details><summary>No close",
    "<details> <summary>Spaced</summary>", "</DETAILS>", "plain text", "a **bold** b", "an *italic* word", "an _italic_ word",
    "snake_case_name", "~~gone~~", "***both***", "<u>under</u>", "2 * 3 * 4", "** not bold **", "**bold *it* bold**",
    "use `**not bold**` here", "``a ` b``", "unclosed `code", "**a `b` c**", "see [Raycast](https://raycast.com) now",
    "go to https://example.com/x, ok", "<https://a.b/c>", "[x](https://a.com)", "https://a.com/x_y_z", "www.example.org/path.",
    "mailto:a@b.c <mailto:x@y.z>", "", "   ", "\t", "  # Indented heading", "    # code-ish heading", "# ", "#", "######## too many",
    "###### six", "😀 emoji title", "日本語のタイトル", "  trailing spaces  ", "tab\tinside", "e\u{301}cole", "nb\u{00A0}sp\u{00A0}",
    "ideo\u{3000}", "**x**\u{00A0}", "[a](b c)", "[](x)", "[a]()", "**a**b**", "__init__", "_a_b_", "*a*b*", "a*b*c", "\\*escaped*",
    "**\\**", "~~a~~~", "<u></u>", "<u>a</u> <u>b</u>", "`a``b`", "```inline```", "http://a.b/(x)", "see www.a.b, then", "1) x",
    "1234567890. big", "123456789. ok", "- [x]", "- [x]a", "-  double space", "*\tx", "> ", ">", "> > > deep", "  > indented quote",
    "  - two space child", "   - three", "     - five", "\u{200B}zero width", "İstanbul ΣΑΣ", "Ünïcödé **wörds**", "a_b_ _c_",
    "x\u{000B}y", "f\u{000C}f", "**v\u{000B}**", "_\u{0085}_", "*a\u{00A0}*", "*\u{00A0}a*", "~~\u{3000}x~~", "__bold__ and __more__",
    "***a** b*", "**a *b***", "*a **b***", "[link **bold**](https://x.y/z)", "[**b**](u) **[c](d)**", "`code` and https://u.v/w`x`",
    "https://example.com/a_b_c_ end", "(https://paren.com/x)", "\"https://quote.com/q\"", "https://e.com/x**y**", "email@https://no.x",
    "/https://slash.x", "word_https://under.x", "<u>**both**</u>", "a <u>b", "~~~~not strike~~~~",
]
let terminators = ["\n", "\n", "\n", "\n", "\r\n", "\r", "\u{2028}", "\u{2029}", "\u{0085}"]

func kindDesc(_ k: BlockKind) -> String {
    switch k {
    case .paragraph: return "paragraph"
    case .heading(let n): return "heading:\(n)"
    case .bullet: return "bullet"
    case .ordered(let n): return "ordered:\(n)"
    case .task(let c): return "task:\(c ? 1 : 0)"
    case .quote(let d): return "quote:\(d)"
    case .rule: return "rule"
    case .fence(let o, let lang): return "fence:\(o ? 1 : 0):\(lang)"
    case .code: return "code"
    case .details: return "details"
    case .detailsEnd: return "detailsEnd"
    }
}
func lineDesc(_ p: ParsedLine) -> [Any] {
    [kindDesc(p.kind), p.level, rr(p.prefixRange), rr(p.contentRange), opt(p.suffixRange.map(rr)), opt(p.markerRange.map(rr)), String(p.bulletChar)]
}
func inlineDesc(_ s: InlineSpan) -> [Any] {
    let kind: String
    switch s.kind {
    case .bold: kind = "bold"
    case .italic: kind = "italic"
    case .boldItalic: kind = "boldItalic"
    case .strike: kind = "strike"
    case .underline: kind = "underline"
    case .code: kind = "code"
    case .link(let u): kind = "link:" + u
    case .autolink(let u): kind = "autolink:" + u
    }
    return [kind, rr(s.range), rr(s.contentRange), s.markers.map(rr)]
}

var lineSet = Set(lineAtoms)
let inlineAtoms = ["**", "*", "_", "__", "~~", "`", "``", "<u>", "</u>", "[", "](", ")", "(", "https://", "http://", "www.", "a", "b", " ", " ",
                   "word", "\\", "<", ">", "mailto:", "x.y", "/p", "😀", "日本", "é", ",", ".", "!", "?", "\u{00A0}", "\u{000B}", "\u{0085}",
                   "\u{3000}", "_snake_", "**bold**", "*it*", "~~s~~", "`c`", "[t](u)", "<https://a.b>", "e\u{301}", "\t", "'", "\"", "@", "#",
                   "- ", "> ", "1. ", ":::", "<details>", "</summary>"]
for i in 0..<1600 {
    var r = SplitMix(state: 0x1111 &+ UInt64(i) &* 3)
    var s = ""
    for _ in 0..<(1 + r.int(9)) { s += r.pick(inlineAtoms) }
    lineSet.insert(s)
}
for line in lineSet.sorted() {
    let p0 = MarkdownParser.parseLine(line, inCode: false), p1 = MarkdownParser.parseLine(line, inCode: true)
    let fence = MarkdownParser.isFence(Array(line.utf16)).map { [Int($0.char), $0.lang] as [Any] }
    emit(["t": "line", "s": line, "p0": lineDesc(p0), "p1": lineDesc(p1), "fence": opt(fence), "rule": MarkdownParser.isRule(line),
          "strip": MarkdownParser.stripInline(line), "spans": MarkdownParser.inlineSpans(line as NSString).map(inlineDesc),
          "plainLine": NoteText.plainLine(line), "open": MarkdownParser.detailsStartsOpen(line), "title": NoteText.title(of: line)])
}

func docVector(_ body: String) {
    let ns = body as NSString
    var info: [[Any]] = []
    for (range, p) in MarkdownParser.parseLines(ns) {
        let full = ns.lineRange(for: NSRange(location: range.location, length: 0))
        info.append([rr(range), lineDesc(p), MarkdownParser.isInCode(ns, lineStart: range.location),
                     opt(MarkdownParser.expanderEnd(after: full, in: ns).map(rr)), MarkdownParser.visibleEnd(ofLine: full, in: ns), rr(full)])
    }
    var sub: [Any] = []
    if ns.length > 2 { // a sub-range parse, as the styler does
        let a = ns.length / 3, b = ns.length - a
        let r = NSRange(location: a, length: b - a)
        sub = [rr(r), MarkdownParser.parseLines(ns, in: r, startInCode: true).map { [rr($0.range), lineDesc($0.line)] }]
    }
    var enumerated: [String] = []
    body.enumerateLines { line, _ in enumerated.append(line) }
    emit(["t": "doc", "body": body, "hash": String(NoteText.hash(body), radix: 16), "title": NoteText.title(of: body),
          "display": NoteText.displayTitle(of: body), "plain": NoteText.plainText(of: body), "chars": NoteText.characterCount(of: body),
          "words": NoteText.wordCount(of: body), "search": NoteText.searchText(of: body),
          "cc": opt(NoteText.conflictCopyBody(body, device: "Air")), "cc0": opt(NoteText.conflictCopyBody(body, device: "")),
          "lines": info, "sub": sub, "enumerated": enumerated])
}
let fixedDocs = [
    "", "\n", "\n\n", "a\n", "# Plan\nintro\n\nend\n", "\n```\ncode\n```\n# Title  \nbody", "# Title  \nbody", "  \n\n", "- [ ] milk",
    "::: details 2026-10-26 14:05 · Idea\nThe **full** idea.\n:::", "<details><summary>Idea</summary>\nThe **full** idea.\n</details>",
    "before\n:::\nafter", ":::\nafter", "::: details A\nbody\n```\n:::\n```\n:::\nafter", "::: details A\nbody\n::: details B\nx\n:::",
    "::: details A\r\nbody\r\n:::\r\nafter", "# T\n```\n- code\n```\n- list\n", "# Hi\n**ab**", "# Hello world\n- one two",
    "\n\n## **Meeting** notes\nbody", "```\ncode\n```", "---\n***\nTitle after rules", "Title\t \u{00A0}\nbody", "Title\r\nbody",
    "  Title \r\nbody", "Title \u{3000}", "😀\u{2028}second", "x\u{0085}y", "a\u{000B}b\nc", "<details open><summary>Open</summary>\nshown\n</details>\nend",
    "<details><summary>A</summary>\n<details><summary>B</summary>\nx\n</details>\n</details>", "```\n<details>\n```\n</details>",
    "Straße ΣΑΣ İ", "ΟΔΟΣ", "e\u{301}cole \u{e9}cole", "one\n\n\ntwo   three\tfour", "don't stop-believing 3.14 a.b", "日本語の文章です。中文。",
]
var docs = Set(fixedDocs)
for i in 0..<900 {
    var r = SplitMix(state: 0x2222 &+ UInt64(i) &* 5)
    var s = ""
    let n = r.int(9)
    for k in 0..<n {
        s += r.pick(lineAtoms)
        if k < n - 1 || r.int(3) == 0 { s += r.int(5) == 0 ? r.pick(terminators) : "\n" }
    }
    if r.int(4) == 0 { s = mutate(s, &r, 1) }
    docs.insert(s)
}
for d in docs.sorted() { docVector(d) }

// MARK: ThoughtCapture

let date = Date(timeIntervalSince1970: 1_793_021_145)
let utc = TimeZone(identifier: "UTC")!
let captureAtoms = ["Add", "a", "capture", "mode", "to the", "transcribe shortcut", " ", "  ", "\n", "\n\n", "\r\n", "\r", "\t", ":::", "::: details x",
                    "    :::", "</details>", "<details>", "<details open>", "```", "~~~~swift", "```js", "<", "</summary>", "😀", "日本語", "\u{0}",
                    "\u{00A0}", "\u{2028}", "\u{3000}", "e\u{301}", "- [ ] task", "# Heading", "word."]
let captureBodies = ["", "  \n", "# Random snippets\nold text\n\n\n", "# Note\nA hard break  \n\n\n", "# Note\n~~~~swift\nlet x = 1", "x", "x\n",
                     "x\n\n", "```\nopen", "~~~\ncode\n~~~", "# Thoughts", "a\r\n", "```js\n```\n```", "<details><summary>s</summary>\nb\n</details>\n"]
var captures: [(String, String)] = [
    ("  Add a capture mode to the transcribe shortcut that appends to a note.\n", ""), ("Short one", ""), ("a </summary> b", ""),
    (" \n\n ", ""), ("a\r\n\r\n\r\nb\n\n", ""), ("a\n:::\n::: details x\nb", ""), ("a\n</details>\n<details>\nb", ""), ("look:\n```\ncode", ""),
    ("one\ntwo  three", ""), ("    :::\nbody", ""), ("    ::: details Nested\nbody", ""), ("~~~~swift\nlet x = 1", ""), ("~~~```lang\ncode", ""),
    ("First idea with quite a few words in it", "# Random snippets\n- [ ] a task"), ("Second:\n\n:::\nwith a stray fence", "x"),
    // Foundation's replacements and Swift's characters around combining marks and CR LF
    ("<\u{301}x y", "a\r\n"), ("a\r\n\u{301}b", "a\r\n\n"), ("<\u{200C} z", "```\u{301}\nx"), ("a\r\u{301}\nb", "x\r\n\r\n"),
    ("x <\u{200D} y", "~~~\u{301}x\ncode"), ("\u{301}lead \u{20}\u{301}word", ""), ("tab\t\u{301}x", "\n\u{301}"),
]
for i in 0..<400 {
    var r = SplitMix(state: 0x3333 &+ UInt64(i) &* 7)
    var t = ""
    for _ in 0..<r.int(12) { t += r.pick(captureAtoms) + (r.int(2) == 0 ? " " : "") }
    captures.append((t, r.pick(captureBodies)))
}
for (text, body) in captures {
    let e = ThoughtCapture.entry(text, at: date, timeZone: utc)
    emit(["t": "capture", "text": text, "body": body, "entry": opt(e), "cleaned": ThoughtCapture.cleaned(text),
          "summary": ThoughtCapture.summary(of: text), "appended": opt(e.map { ThoughtCapture.append($0, to: body) }),
          "appendRaw": ThoughtCapture.append(text, to: body)])
}
for (secs, tz) in [(1_793_021_145, "UTC"), (1_793_021_145, "Europe/London"), (1_793_021_145, "Asia/Kolkata"), (1_793_021_145, "America/Los_Angeles"),
                   (1_774_746_000, "Europe/London"), (0, "UTC"), (1_700_000_000, "Australia/Adelaide"), (1_740_000_000, "Europe/Copenhagen")] {
    let d = Date(timeIntervalSince1970: TimeInterval(secs))
    emit(["t": "stamp", "secs": secs, "tz": tz, "out": ThoughtCapture.timestamp(d, timeZone: TimeZone(identifier: tz)!),
          "entry": opt(ThoughtCapture.entry("Idea", at: d, timeZone: TimeZone(identifier: tz)!))])
}

// MARK: FuzzyMatch

let queries = ["dt", "daily", "milk", "x", "Da To", " t ", "\u{e9}e", "日本", "pl an", "PLAN", "\u{e9}", "e\u{301}", "İ", "ß", "", "  ", "todo s",
               "note", "a b c", "😀", "ΣΑ", "σα", "\t", "zz", "shop list"]
let titles = ["Daily Todos", "Shopping", "Plan for the week", "日本語のノート", "Café notes", "Cafe\u{301} notes", "İstanbul trip", "Straße",
              "", "x", "ΣΑΣ", "a-b_c d", "😀 party", "Todo: shop list", "MILK and eggs", "notebook"]
let bodies = ["- [ ] milk", "", "buy milk and eggs\nplan the week", "日本語の文章", "caf\u{e9} au lait", String(repeating: "lorem ipsum ", count: 300),
              "todo shop list", "ΣΑΣ σας", "note: a b c"]
for q in queries {
    for (k, t) in titles.enumerated() {
        let b = bodies[(k + q.count) % bodies.count]
        emit(["t": "fuzzy", "q": q, "text": t, "body": b, "score": opt(FuzzyMatch.score(q, t)), "note": opt(FuzzyMatch.noteScore(q, title: t, body: b))])
    }
}

// MARK: RelativeDate

let now: Int64 = 1_793_021_145_000
for d: Int64 in [0, 1, 59_999, 60_000, 3_599_999, 3_600_000, 86_399_999, 86_400_000, 6 * 86_400_000, 7 * 86_400_000, 29 * 86_400_000,
                 30 * 86_400_000, 364 * 86_400_000, 365 * 86_400_000, 10 * 365 * 86_400_000, -5_000, -86_400_000] {
    emit(["t": "rel", "ms": now - d, "now": now, "out": RelativeDate.short(now - d, now: now)])
}
let relExtremes: [(Int64, Int64)] = [(.min, now), (.max, now), (.min, .max), (.max, .min), (0, .max), (-1, .max), (.min, 0)]
for (ms, n) in relExtremes {
    emit(["t": "rel", "ms": ms, "now": n, "out": RelativeDate.short(ms, now: n)])
}

// MARK: NoteWire and SyncHeadsCodec

func jsonText(_ o: Any) -> String {
    String(decoding: try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]), as: UTF8.self)
}
do {
    var n = Note(id: "id-1", body: "# T\nbody", createdAt: 5, updatedAt: 1_761_000_123_456)
    n.pinned = true
    n.pinOrder = 2.5
    n.meta["custom"] = .array([.string("x/y"), .number(1e20), .number(-3), .number(0.1), .bool(false), .null, .object(["k": .string("v")])])
    n.meta["base"] = .string("dropped")
    let heads: SyncHeads = ["install-A": SyncHead(at: 1_761_000_123_456, hash: NoteText.hash("x")), "B": SyncHead(at: 1, hash: 0),
                            "C": SyncHead(at: Int64.max, hash: UInt64.max)]
    emit(["t": "wire", "name": "full", "json": jsonText(NoteWire.encode(n, device: "Mac", origin: "install-A", heads: heads,
                                                                        retired: Set((0..<10).map { "r\($0)" })))])
    emit(["t": "wire", "name": "noHeads", "json": jsonText(NoteWire.encode(n, device: "Mac", origin: "install-A"))])
    emit(["t": "wire", "name": "noOrigin", "json": jsonText(NoteWire.encode(n, device: "", heads: heads))])
    var d = n
    d.deleted = true
    emit(["t": "wire", "name": "deleted", "json": jsonText(NoteWire.encode(d, device: "Mac", origin: "install-A", heads: heads))])
    emit(["t": "heads", "name": "full", "body": "x", "out": SyncHeadsCodec.encode(heads, body: "x")])
    emit(["t": "heads", "name": "empty", "body": "", "out": SyncHeadsCodec.encode([:], body: "")])
}
let decodeCases: [String] = [
    #"{"id":"a","body":"text","created_at":1,"updated_at":500,"seq":7,"device":"B","meta":{"pinned":true,"base":{"at":500,"from":"install-B","heads":{"install-B":[500,"ff"],"A":[3,"0"]},"retired":["x","y"]}}}"#,
    #"{"id":"a","body":"text","updated_at":600,"meta":{"base":{"at":500,"from":"install-B","heads":{"install-B":[500,"ff"]}}}}"#,
    #"{"id":"a","body":"text","updated_at":500,"meta":{"base":{"at":500.0,"from":"","heads":{"B":[500,"FF"]}}}}"#,
    #"{"id":"a","body":"text","updated_at":500,"meta":{"base":{"at":500,"from":"o","heads":{"B":[500,"zz"],"C":[1,"1"]}}}}"#,
    #"{"id":"a","body":"text","updated_at":500,"meta":{"base":{"at":500,"from":"o","heads":{"B":[500]}}}}"#,
    #"{"id":"a","body":"text","updated_at":500,"meta":{"base":{"at":500,"heads":{"B":[1e300,"1"]},"retired":["1","2","3","4","5","6","7","8","9",5]}}}"#,
    #"{"id":"a","body":"text","updated_at":500,"meta":{"base":{"at":500,"heads":{}}}}"#,
    #"{"id":"a","body":"text","updated_at":500,"meta":{"base":"nope","other":[1,2.5,"s",null,{"x":false}]}}"#,
    #"{"id":"x","updated_at":3,"deleted":true,"body":"ignored"}"#,
    #"{"id":"x","updated_at":3,"deleted":1,"body":"ignored"}"#,
    #"{"id":"x","updated_at":3,"deleted":0,"body":"kept"}"#,
    #"{"id":"x","updated_at":12.7,"created_at":-4,"body":5}"#,
    #"{"id":"x","updated_at":"5"}"#,
    #"{"body":"no id","updated_at":1}"#,
    #"{"id":"","updated_at":1}"#,
    #"{"id":"x","updated_at":9007199254740993,"seq":9223372036854775807,"meta":[]}"#,
    #"{"id":"x","updated_at":1,"device":7,"meta":{"base":{"at":1,"from":"o","heads":{"B":[1,"+a"]}}}}"#,
    #"{"id":"x","updated_at":1,"meta":{"base":{"at":1,"from":"o","heads":{"B":[1,"10000000000000000"]}}}}"#,
]
func noteSummary(_ n: Note?) -> Any {
    guard let n else { return NSNull() }
    return ["id": n.id, "body": n.body, "createdAt": n.createdAt, "updatedAt": n.updatedAt, "deleted": n.deleted, "seq": opt(n.seq),
            "device": n.device, "meta": n.meta.mapValues(\.any), "remoteHeads": opt(n.remoteHeads.map(headsDesc)), "remoteOrigin": opt(n.remoteOrigin),
            "remoteRetired": n.remoteRetired]
}
for c in decodeCases {
    emit(["t": "decode", "json": c, "note": noteSummary(NoteWire.decode(try! JSONSerialization.jsonObject(with: Data(c.utf8))))])
}
let headsCases: [(String, String)] = [
    (#"{"body":"af63dc4c8601ec8c","heads":{"i":[5,"ff"]}}"#, "a"),
    (#"{"body":"af63dc4c8601ec8c","heads":{"i":[5,"ff"]}}"#, "b"),
    (#"{"body":"af63dc4c8601ec8c","heads":{}}"#, "a"),
    (#"{"body":"af63dc4c8601ec8c","heads":{"i":[5.9,"FF"],"j":[-1,"0"]}}"#, "a"),
    (#"{"body":"af63dc4c8601ec8c","heads":{"i":[5,"xyz"]}}"#, "a"),
    (#"{"body":"af63dc4c8601ec8c","heads":{"i":[5]}}"#, "a"),
    (#"{"body":"af63dc4c8601ec8c"}"#, "a"),
    ("not json", "a"),
]
for (s, body) in headsCases {
    emit(["t": "headsDecode", "s": s, "body": body, "out": opt(SyncHeadsCodec.decode(s, body: body).map(headsDesc))])
}

// MARK: Live-merge fuzz

for kind in Fuzz.allCases {
    for seed in 0..<150 { emit(runFuzz(seed: seed, kind)) }
}

let path = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "notes-vectors.jsonl"
try! (out.joined(separator: "\n") + "\n").write(toFile: path, atomically: true, encoding: .utf8)
print("wrote \(out.count) vectors (\(mergeCount) merges) to \(path)")
