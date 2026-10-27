import Foundation

/// Text diffs, three-way merges and selection mapping for live sync. Ranges are UTF-16
/// (NSString) offsets and never split a composed character (emoji, accents).
enum TextMerge {
    /// The edits that turn `old` into `new`: sorted, non-overlapping, in `old`'s coordinates.
    static func edits(from old: String, to new: String) -> [TextEdit] {
        let o = old as NSString, n = new as NSString
        let ou = Array(old.utf16), nu = Array(new.utf16)
        // unchanged start and end (cheap, UTF-16), on composed-character boundaries
        var p = 0
        while p < ou.count, p < nu.count, ou[p] == nu[p] { p += 1 }
        if p == ou.count, p == nu.count { return [] }
        if p < ou.count { p = min(p, o.rangeOfComposedCharacterSequence(at: p).location) }
        if p < nu.count { p = min(p, n.rangeOfComposedCharacterSequence(at: p).location) }
        var s = 0
        while s < min(ou.count, nu.count) - p, ou[ou.count - 1 - s] == nu[nu.count - 1 - s] { s += 1 }
        func endAligned(_ str: NSString, _ s: Int) -> Int {
            let e = str.length - s
            guard e > p, e < str.length else { return s }
            let r = str.rangeOfComposedCharacterSequence(at: e)
            return r.location < e ? str.length - NSMaxRange(r) : s
        }
        s = max(0, min(endAligned(o, s), endAligned(n, s)))
        let oldMid = o.substring(with: NSRange(location: p, length: o.length - p - s))
        let newMid = n.substring(with: NSRange(location: p, length: n.length - p - s)) as NSString
        // the middle by character, compared as exact UTF-16
        var interned = Interner()
        let a = Array(oldMid).map { interned.id($0) }, b = Array(newMid as String).map { interned.id($0) }
        let oa = utf16Offsets(oldMid), ob = utf16Offsets(newMid as String)
        func edit(_ h: Hunk) -> TextEdit {
            let lo = ob[h.b.lowerBound], hi = ob[h.b.upperBound]
            return TextEdit(range: NSRange(location: p + oa[h.a.lowerBound], length: oa[h.a.upperBound] - oa[h.a.lowerBound]),
                            replacement: newMid.substring(with: NSRange(location: lo, length: hi - lo)))
        }
        let whole = edit(Hunk(a: 0..<a.count, b: 0..<b.count))
        let result = absorbed(shifted(align(a, 0..<a.count, b, 0..<b.count).map(edit), in: o), in: o)
        // Tokens compare exact UTF-16, so this holds; never hand out edits that don't.
        guard apply(result, to: old).utf16.elementsEqual(new.utf16) else { return [whole] }
        return result
    }

    /// Moves an insertion or deletion sideways into its neighbour when the unchanged text
    /// between them repeats at its own end or start ("A line" + kept "\n" + inserted "\n"
    /// is one insertion "A line\n"), so the same change diffs the same way against
    /// different texts and merges don't duplicate it.
    private static func shifted(_ edits: [TextEdit], in old: NSString) -> [TextEdit] {
        guard edits.count > 1 else { return edits }
        func text(_ e: TextEdit) -> String? { // the inserted or deleted text, nil for replacements
            if e.range.length == 0 { return e.replacement }
            return e.replacement.isEmpty ? old.substring(with: e.range) : nil
        }
        var out: [TextEdit] = [edits[0]]
        for var e in edits.dropFirst() {
            let prev = out[out.count - 1]
            let gap = old.substring(with: NSRange(location: NSMaxRange(prev.range), length: e.range.location - NSMaxRange(prev.range)))
            if let t = text(e), !gap.isEmpty, t.utf16.count >= gap.utf16.count, t.utf16.reversed().starts(with: gap.utf16.reversed()) {
                let g = (gap as NSString).length
                if e.range.length == 0 {
                    e = TextEdit(range: NSRange(location: NSMaxRange(prev.range), length: 0),
                                 replacement: gap + (t as NSString).substring(to: (t as NSString).length - g))
                } else {
                    e.range = NSRange(location: NSMaxRange(prev.range), length: e.range.length)
                }
            }
            if e.range.location == NSMaxRange(prev.range) {
                out[out.count - 1] = TextEdit(range: NSRange(location: prev.range.location, length: prev.range.length + e.range.length),
                                              replacement: prev.replacement + e.replacement)
            } else {
                out.append(e)
            }
        }
        return out
    }

    /// Joins edits separated by unchanged text no longer than the edits on either side
    /// when one of them deletes text: "base" → "edited" is one replacement, not pieces
    /// around a shared "e" that would merge into a mix of two different rewrites. (Text
    /// between two pure insertions really is unchanged.)
    private static func absorbed(_ edits: [TextEdit], in old: NSString) -> [TextEdit] {
        var out: [TextEdit] = []
        for e in edits {
            guard let prev = out.last else { out.append(e); continue }
            let gap = e.range.location - NSMaxRange(prev.range)
            func size(_ x: TextEdit) -> Int { max(x.range.length, (x.replacement as NSString).length) }
            if prev.range.length > 0 || e.range.length > 0, gap <= size(prev), gap <= size(e) {
                let kept = old.substring(with: NSRange(location: NSMaxRange(prev.range), length: gap))
                out[out.count - 1] = TextEdit(range: NSRange(location: prev.range.location, length: NSMaxRange(e.range) - prev.range.location),
                                              replacement: prev.replacement + kept + e.replacement)
            } else {
                out.append(e)
            }
        }
        return out
    }

    /// Applies sorted, non-overlapping edits (several may start at one offset: insertions
    /// first, in order).
    static func apply(_ edits: [TextEdit], to text: String) -> String {
        let s = text as NSString
        var out = ""
        var pos = 0
        for e in edits {
            out += s.substring(with: NSRange(location: pos, length: e.range.location - pos))
            out += e.replacement
            pos = NSMaxRange(e.range)
        }
        return out + s.substring(from: pos)
    }

    /// `base` became `local` on this Mac and `remote` on another: both changes applied
    /// together, or nil when they touch the same text. Symmetric (merging remote into
    /// local gives the same text as local into remote), so two Macs merging the same pair
    /// of versions agree.
    static func merge(base: String, local: String, remote: String) -> String? {
        if local.utf16.elementsEqual(remote.utf16) || base.utf16.elementsEqual(remote.utf16) { return local }
        if base.utf16.elementsEqual(local.utf16) { return remote }
        let l = edits(from: base, to: local), r = edits(from: base, to: remote)
        var out: [TextEdit] = []
        var i = 0, j = 0
        while i < l.count, j < r.count {
            let x = l[i], y = r[j]
            if x == y { out.append(x); i += 1; j += 1; continue } // the same change on both
            if x.range.length == 0, y.range.length == 0, x.range.location == y.range.location {
                guard let both = combine(x.replacement, y.replacement) else { return nil }
                out.append(TextEdit(range: x.range, replacement: both))
                i += 1; j += 1
                continue
            }
            if NSMaxRange(x.range) <= y.range.location {
                out.append(x); i += 1
            } else if NSMaxRange(y.range) <= x.range.location {
                out.append(y); j += 1
            } else {
                return nil // overlapping changes
            }
        }
        out += l[i...]
        out += r[j...]
        return apply(out, to: base)
    }

    /// Two insertions at the same spot (both typed there): both, in an order both Macs
    /// agree on. nil when one starts or ends with the other: that's the same typing seen
    /// from two different bases, and keeping both would duplicate it.
    static func combine(_ x: String, _ y: String) -> String? {
        let a = x.utf16, b = y.utf16
        func contains(_ l: String.UTF16View, _ s: String.UTF16View) -> Bool {
            l.starts(with: s) || l.reversed().starts(with: s.reversed())
        }
        if contains(a, b) || contains(b, a) { return nil }
        return a.lexicographicallyPrecedes(b) ? x + y : y + x
    }

    /// Where a selection ends up after `edits` (sorted, in its text's coordinates), like
    /// Google Docs: text inserted or deleted before it shifts it, text after it doesn't
    /// (text inserted right at a caret goes after it). A selection doesn't grow to take in
    /// text inserted at its ends.
    static func map(_ sel: NSRange, through edits: [TextEdit]) -> NSRange {
        guard !edits.isEmpty else { return sel }
        if sel.length == 0 {
            return NSRange(location: map(sel.location, through: edits, pastInsertions: false, insideToEnd: true), length: 0)
        }
        let a = map(sel.location, through: edits, pastInsertions: true, insideToEnd: false)
        let b = map(NSMaxRange(sel), through: edits, pastInsertions: false, insideToEnd: true)
        return NSRange(location: a, length: max(0, b - a))
    }

    /// Maps one offset. `pastInsertions`: text inserted exactly at it ends up before it.
    /// `insideToEnd`: an offset inside replaced text goes to the end of the replacement
    /// (else to its start).
    static func map(_ x: Int, through edits: [TextEdit], pastInsertions: Bool, insideToEnd: Bool) -> Int {
        var delta = 0
        for e in edits {
            let start = e.range.location, end = NSMaxRange(e.range), len = (e.replacement as NSString).length
            if x < start || (x == start && (e.range.length > 0 || !pastInsertions)) { break }
            if x >= end {
                delta += len - e.range.length
                continue
            }
            return start + delta + (insideToEnd ? len : 0)
        }
        return x + delta
    }

    // MARK: Diff

    private struct Hunk {
        let a: Range<Int>
        let b: Range<Int>
    }

    /// Myers' diff takes O((n + m)·D) time and O(D²) memory for D differences, so it gives
    /// up past a limit: long stretches are diffed by line first, then the changed lines by
    /// character; whatever is still too different becomes one replacement.
    private static let maxCharTokens = 10_000, maxCharChanges = 300
    private static let maxLines = 40_000, maxLineChanges = 1_000

    /// Changed stretches between `a[ra]` and `b[rb]` (token indices).
    private static func align(_ a: [Int], _ ra: Range<Int>, _ b: [Int], _ rb: Range<Int>) -> [Hunk] {
        if ra.isEmpty && rb.isEmpty { return [] }
        if ra.isEmpty || rb.isEmpty { return [Hunk(a: ra, b: rb)] }
        if let h = charDiff(a, ra, b, rb) { return h }
        let la = lines(a, ra), lb = lines(b, rb)
        guard la.count + lb.count <= maxLines else { return [Hunk(a: ra, b: rb)] }
        var ids: [ArraySlice<Int>: Int] = [:]
        func id(_ s: ArraySlice<Int>) -> Int {
            if let i = ids[s] { return i }
            ids[s] = ids.count
            return ids.count - 1
        }
        let ia = la.map { id(a[$0]) }, ib = lb.map { id(b[$0]) }
        guard let lineHunks = diff(ia, ib, maxChanges: maxLineChanges) else { return [Hunk(a: ra, b: rb)] }
        func span(_ lines: [Range<Int>], _ r: Range<Int>, end: Int) -> Range<Int> {
            guard !r.isEmpty else {
                let at = r.lowerBound < lines.count ? lines[r.lowerBound].lowerBound : end
                return at..<at
            }
            return lines[r.lowerBound].lowerBound..<lines[r.upperBound - 1].upperBound
        }
        return lineHunks.flatMap { h -> [Hunk] in
            let ta = span(la, h.a, end: ra.upperBound), tb = span(lb, h.b, end: rb.upperBound)
            if ta.isEmpty || tb.isEmpty { return [Hunk(a: ta, b: tb)] }
            return charDiff(a, ta, b, tb) ?? [Hunk(a: ta, b: tb)]
        }
    }

    private static func charDiff(_ a: [Int], _ ra: Range<Int>, _ b: [Int], _ rb: Range<Int>) -> [Hunk]? {
        guard ra.count + rb.count <= maxCharTokens,
              let h = diff(Array(a[ra]), Array(b[rb]), maxChanges: maxCharChanges) else { return nil }
        return h.map { Hunk(a: $0.a.shifted(ra.lowerBound), b: $0.b.shifted(rb.lowerBound)) }
    }

    /// Token ranges of the lines in `t[r]`, each with its line break.
    private static func lines(_ t: [Int], _ r: Range<Int>) -> [Range<Int>] {
        var out: [Range<Int>] = []
        var start = r.lowerBound
        for i in r where t[i] == Interner.newline || t[i] == Interner.crlf || t[i] == 13 {
            out.append(start..<(i + 1))
            start = i + 1
        }
        if start < r.upperBound { out.append(start..<r.upperBound) }
        return out
    }

    /// Changed stretches between two token arrays (Myers), nil past `maxChanges`.
    private static func diff(_ a: [Int], _ b: [Int], maxChanges: Int) -> [Hunk]? {
        let n = a.count, m = b.count
        let limit = min(maxChanges, n + m)
        let off = limit + 1
        var v = [Int](repeating: 0, count: 2 * limit + 3)
        // trace[d]: the furthest x per diagonal k in -d-1...d+1 before step d
        var trace: [[Int]] = []
        var done = false
        search: for d in 0...limit {
            trace.append(Array(v[(off - d - 1)...(off + d + 1)]))
            for k in stride(from: -d, through: d, by: 2) {
                var x = k == -d || (k != d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
                var y = x - k
                while x < n, y < m, a[x] == b[y] { x += 1; y += 1 }
                v[off + k] = x
                if x >= n, y >= m { done = true; break search }
            }
        }
        guard done else { return nil }
        var removed = [Bool](repeating: false, count: n), inserted = [Bool](repeating: false, count: m)
        var x = n, y = m
        for d in stride(from: trace.count - 1, to: 0, by: -1) {
            let t = trace[d], k = x - y
            func at(_ k: Int) -> Int { t[k + d + 1] }
            let down = k == -d || (k != d && at(k - 1) < at(k + 1))
            let px = at(down ? k + 1 : k - 1), py = px - (down ? k + 1 : k - 1)
            if down { inserted[py] = true } else { removed[px] = true }
            x = px; y = py
        }
        var out: [Hunk] = []
        var i = 0, j = 0
        while i < n || j < m {
            if i < n, j < m, !removed[i], !inserted[j] { i += 1; j += 1; continue }
            let si = i, sj = j
            while i < n, removed[i] { i += 1 }
            while j < m, inserted[j] { j += 1 }
            out.append(Hunk(a: si..<i, b: sj..<j))
        }
        return out
    }

    /// UTF-16 offset of every character (plus the end).
    private static func utf16Offsets(_ s: String) -> [Int] {
        var out = [0]
        out.reserveCapacity(s.count + 1)
        var o = 0
        for c in s {
            o += c.utf16.count
            out.append(o)
        }
        return out
    }

    /// Characters as integers that are equal only for identical UTF-16 (Swift's `==`
    /// treats canonically equivalent characters as equal, which would lose bytes).
    private struct Interner {
        static let newline = 10
        static let crlf = 0x10000
        private var ids: [[UInt16]: Int] = [[13, 10]: Interner.crlf]

        mutating func id(_ c: Character) -> Int {
            let u = c.utf16
            if u.count == 1 { return Int(u.first!) }
            let key = Array(u)
            if let i = ids[key] { return i }
            let i = 0x10000 + ids.count
            ids[key] = i
            return i
        }
    }
}

private extension Range where Bound == Int {
    func shifted(_ d: Int) -> Range<Int> { (lowerBound + d)..<(upperBound + d) }
}
