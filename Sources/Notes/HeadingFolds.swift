import Foundation

/// The collapsed heading sections of the note in an editor. Kept per window and note,
/// never written to the note: the text stays plain markdown.
///
/// A fold is a heading's line start and the whole lines it hides (`body`: from a line start
/// to a line start or the text's end). Both move with every edit like carets, so a fold
/// survives typing elsewhere, sync merges and appended thoughts, and text inserted right
/// before or after the hidden lines stays visible. That is what lets Return on a collapsed
/// heading start a line after its section without the line disappearing into it.
/// Collapsing hides the heading's markdown section as it is at that moment (down to the next
/// heading of the same or a higher level).
///
/// Captured thoughts (`ThoughtCapture.isEntryHeading`) start collapsed when they arrive
/// (note opened, sync, capture); the ones the user opened or typed here are remembered in
/// `opened` so they stay open.
struct HeadingFolds: Equatable {
    struct Fold: Equatable {
        /// Line start of the heading.
        var heading: Int
        /// The hidden lines. Empty when the section has nothing in it.
        var body: NSRange
    }

    /// Sorted by heading. A fold inside another one's body (a collapsed subsection of a
    /// collapsed section) keeps its own state.
    private(set) var folds: [Fold] = [] {
        didSet { blocks = HeadingFolds.blocks(folds) }
    }
    /// What is hidden: the folds' hidden lines merged into blocks, sorted. Each block is
    /// reported as a fold with the first heading and the merged lines.
    private var blocks: [Fold] = []
    /// Line starts of captured-thought headings known to be open, sorted.
    private(set) var opened: [Int] = []

    var isEmpty: Bool { folds.isEmpty && opened.isEmpty }

    // MARK: Queries

    func fold(at heading: Int) -> Fold? {
        let i = index(of: heading)
        return i < folds.count && folds[i].heading == heading ? folds[i] : nil
    }

    func isCollapsed(_ heading: Int) -> Bool { fold(at: heading) != nil }

    func isOpened(_ heading: Int) -> Bool {
        let i = lowerBound(opened, heading)
        return i < opened.count && opened[i] == heading
    }

    /// The hidden block containing `loc` (`body.location <= loc < NSMaxRange(body)`).
    func hiding(_ loc: Int) -> Fold? {
        var lo = 0, hi = blocks.count
        while lo < hi {
            let mid = (lo + hi) / 2
            if blocks[mid].body.location <= loc { lo = mid + 1 } else { hi = mid }
        }
        guard lo > 0, loc < NSMaxRange(blocks[lo - 1].body) else { return nil }
        return blocks[lo - 1]
    }

    /// The hidden block starting at `loc`.
    func folding(from loc: Int) -> Fold? {
        guard let b = hiding(loc), b.body.location == loc else { return nil }
        return b
    }

    /// The hidden block ending at `loc` (a line start, or the text's end).
    func folding(upTo loc: Int) -> Fold? {
        guard loc > 0, let b = hiding(loc - 1), NSMaxRange(b.body) == loc else { return nil }
        return b
    }

    /// Whether a caret at `loc` would be on a hidden line. The end of a last line without a
    /// newline belongs to that line.
    func hidesCaret(at loc: Int, in text: NSString) -> Fold? {
        if let f = hiding(loc) { return f }
        if loc == text.length, loc > 0, text.character(at: loc - 1) != 10, let f = folding(upTo: loc) { return f }
        return nil
    }

    /// Positions known to be headings (collapsed or opened) in `r`.
    func headings(in r: NSRange) -> [Int] {
        var out: [Int] = []
        for f in folds where NSLocationInRange(f.heading, r) { out.append(f.heading) }
        for o in opened where NSLocationInRange(o, r) { out.append(o) }
        return out
    }

    // MARK: Changes

    /// Collapses the heading on the line starting at `heading`: hides its section as it is
    /// now. Returns the range to restyle.
    @discardableResult
    mutating func collapse(_ heading: Int, level: Int, in text: NSString) -> NSRange {
        let line = text.lineRange(for: NSRange(location: heading, length: 0))
        let end = max(NSMaxRange(line), MarkdownParser.sectionEnd(after: line, level: level, in: text))
        let body = NSRange(location: NSMaxRange(line), length: end - NSMaxRange(line))
        let i = index(of: heading)
        if i < folds.count, folds[i].heading == heading { folds[i].body = body } else { folds.insert(Fold(heading: heading, body: body), at: i) }
        remove(opened: heading)
        return NSRange(location: heading, length: end - heading)
    }

    /// Opens a collapsed heading. `entry`: it is a captured thought (remembered as opened).
    /// Returns the range to restyle.
    @discardableResult
    mutating func expand(_ heading: Int, entry: Bool) -> NSRange? {
        let i = index(of: heading)
        guard i < folds.count, folds[i].heading == heading else { return nil }
        let f = folds.remove(at: i)
        if entry { markOpened(heading) }
        return NSRange(location: heading, length: NSMaxRange(f.body) - heading)
    }

    mutating func markOpened(_ heading: Int) {
        let i = lowerBound(opened, heading)
        if i == opened.count || opened[i] != heading { opened.insert(heading, at: i) }
    }

    /// Forgets the heading at `pos` (its line is no longer a heading). Returns the lines its
    /// fold hid, to restyle.
    @discardableResult
    mutating func forget(_ pos: Int) -> NSRange? {
        remove(opened: pos)
        let i = index(of: pos)
        guard i < folds.count, folds[i].heading == pos else { return nil }
        return folds.remove(at: i).body
    }

    // MARK: Edits

    /// Moves everything through one replacement of `range` (in the text before it) by
    /// `length` characters. A heading inside the replaced text is forgotten; text inserted
    /// at either end of a fold's hidden lines stays outside them. Returns the hidden lines
    /// of forgotten folds (new coordinates), to restyle.
    @discardableResult
    mutating func map(_ range: NSRange, length: Int) -> [NSRange] {
        let loc = range.location, oldEnd = NSMaxRange(range), delta = length - range.length
        guard delta != 0 || range.length > 0 else { return [] }
        // A line start at the edit moves past an insertion (the heading moves down) and stays
        // put for a replacement starting there; inside the replaced text it's gone.
        func start(_ p: Int) -> Int? {
            if p < loc { return p }
            if p == loc { return range.length == 0 ? p + length : p }
            if p < oldEnd { return nil }
            return p + delta
        }
        // hidden lines: inserted or replacing text at their edges ends up outside them
        func bodyStart(_ p: Int) -> Int {
            if p < loc { return p }
            if p < oldEnd || (p == loc && range.length == 0) { return loc + length }
            return p + delta
        }
        func bodyEnd(_ p: Int) -> Int {
            if p <= loc { return p }
            if p < oldEnd { return loc }
            return p + delta
        }
        var dirty: [NSRange] = []
        var out: [Fold] = []
        out.reserveCapacity(folds.count)
        for f in folds {
            let s = bodyStart(f.body.location)
            let e = max(s, bodyEnd(NSMaxRange(f.body)))
            guard let h = start(f.heading) else {
                if e > s { dirty.append(NSRange(location: s, length: e - s)) }
                continue
            }
            out.append(Fold(heading: h, body: NSRange(location: max(s, h), length: e - max(s, h))))
        }
        folds = out
        opened = opened.compactMap(start)
        return dirty
    }

    /// After edits: hidden lines are whole lines after their heading's line again. A line
    /// that got merged into the hidden ones from outside (a deleted newline) is shown.
    /// Only folds touching `around` are looked at.
    mutating func normalize(in text: NSString, around: NSRange) {
        let len = text.length
        let lo = max(0, around.location - 1), hi = min(len, NSMaxRange(around) + 1)
        var all = folds
        for i in all.indices {
            var f = all[i]
            let s0 = f.body.location, e0 = NSMaxRange(f.body)
            guard (s0 >= lo && s0 <= hi) || (e0 >= lo && e0 <= hi) || (f.heading >= lo && f.heading <= hi) else { continue }
            let headingEnd = NSMaxRange(text.lineRange(for: NSRange(location: min(f.heading, len), length: 0)))
            func isLineStart(_ p: Int) -> Bool { p == 0 || p >= len || text.lineRange(for: NSRange(location: p, length: 0)).location == p }
            var s = max(min(s0, len), headingEnd)
            if !isLineStart(s) { s = NSMaxRange(text.lineRange(for: NSRange(location: s, length: 0))) }
            var e = min(max(e0, s), len)
            if !isLineStart(e) {
                // at the end of a hidden line's text (a newline was added after a last line
                // without one): its newline is hidden too; inside a line (another line merged
                // into it): that line shows
                let line = text.lineRange(for: NSRange(location: e, length: 0))
                e = e == NSMaxRange(MarkdownParser.contentRange(line, in: text)) ? NSMaxRange(line) : max(s, line.location)
            }
            f.body = NSRange(location: s, length: e - s)
            all[i] = f
        }
        if all != folds { folds = all }
    }

    /// Moves everything from `old` to `new` (a note changed while it wasn't shown).
    mutating func map(from old: String, to new: String) {
        guard !old.utf16.elementsEqual(new.utf16) else { return }
        // last first: an edit doesn't move the positions before it
        for e in TextMerge.edits(from: old, to: new).reversed() { map(e.range, length: (e.replacement as NSString).length) }
        normalize(in: new as NSString, around: NSRange(location: 0, length: (new as NSString).length))
    }

    // MARK: Editing around folds

    /// Where the hidden lines' guard starts: the line break before them.
    private static func guardStart(_ f: Fold, in text: NSString) -> Int {
        var s = f.body.location
        if s > 0, text.character(at: s - 1) == 10 { s -= 1 }
        if s > 0, text.character(at: s - 1) == 13 { s -= 1 }
        return s
    }

    /// End of the visible line before a fold's hidden lines (its heading, normally).
    static func lineEndBefore(_ f: Fold, in text: NSString) -> Int { guardStart(f, in: text) }

    /// Whether an edit by the user keeps hidden text intact: it must leave a fold's hidden
    /// lines (and the line break before them) alone or replace them entirely.
    func allows(_ range: NSRange, in text: NSString) -> Bool {
        for f in blocks {
            let lo = HeadingFolds.guardStart(f, in: text), hi = NSMaxRange(f.body)
            if range.location >= hi { continue }
            if range.length == 0 {
                if range.location > lo, range.location < hi { return false }
            } else if NSMaxRange(range) > lo, !(range.location <= lo && NSMaxRange(range) >= hi) {
                return false
            }
        }
        return true
    }

    /// Return on a collapsed heading: at the end of the line it starts a new line after the
    /// whole section (the hidden lines aren't touched and stay collapsed); at the start of its
    /// text an empty line above. nil: not on a collapsed heading (or in the middle of its text).
    func newline(_ text: NSString, selection sel: NSRange) -> EditResult? {
        guard sel.length == 0 else { return nil }
        let l = MarkdownCommands.line(at: sel.location, in: text)
        guard isCollapsed(l.range.location), case .heading = l.parsed.kind, let f = folding(from: NSMaxRange(l.full)) else { return nil }
        if sel.location >= l.end {
            let e = NSMaxRange(f.body)
            // a last hidden line without a newline gets one, the new line comes after it
            let lineStart = e < text.length || (e > 0 && text.character(at: e - 1) == 10)
            return EditResult(edits: [TextEdit(range: NSRange(location: e, length: 0), replacement: "\n")],
                              selection: NSRange(location: lineStart ? e : e + 1, length: 0))
        }
        if sel.location <= l.contentStart {
            return EditResult(edits: [TextEdit(range: NSRange(location: l.range.location, length: 0), replacement: "\n")],
                              selection: NSRange(location: sel.location + 1, length: 0))
        }
        return nil
    }

    /// Backspace at the start of the line after a collapsed section joins that line onto the
    /// visible line above (the heading), or removes it when it's empty. Never touches the
    /// hidden lines.
    func backspace(_ text: NSString, selection sel: NSRange) -> EditResult? {
        guard sel.length == 0, sel.location > 0, let f = folding(upTo: sel.location) else { return nil }
        return join(f, in: text)
    }

    /// Forward delete at the end of a collapsed heading joins the line after its section onto
    /// it, or removes that line when it's empty. Nothing happens at the end of the text.
    func deleteForward(_ text: NSString, selection sel: NSRange) -> EditResult? {
        guard sel.length == 0 else { return nil }
        let full = text.lineRange(for: NSRange(location: sel.location, length: 0))
        guard let f = folding(from: NSMaxRange(full)), sel.location == HeadingFolds.lineEndBefore(f, in: text) else { return nil }
        let e = NSMaxRange(f.body)
        if e == text.length, e == 0 || text.character(at: e - 1) != 10 { return EditResult(edits: [], selection: sel) }
        return join(f, in: text)
    }

    /// Moves the line after `f`'s hidden lines (without its block marker) to the end of the
    /// visible line before them.
    private func join(_ f: Fold, in text: NSString) -> EditResult {
        let e = NSMaxRange(f.body)
        let target = HeadingFolds.lineEndBefore(f, in: text)
        let next = MarkdownCommands.line(at: e, in: text)
        var contentStart = next.range.location
        if !next.inCode, next.parsed.hasPrefix {
            switch next.parsed.kind {
            case .heading, .bullet, .ordered, .task, .quote: contentStart = next.contentStart
            default: break
            }
        }
        let content = text.substring(with: NSRange(location: contentStart, length: next.end - contentStart))
        // the line and its newline; a last line takes the newline before it instead
        let removed = NSMaxRange(next.full) > next.end
            ? NSRange(location: e, length: NSMaxRange(next.full) - e)
            : NSRange(location: e - 1, length: next.end - e + 1)
        var edits = [TextEdit(range: removed, replacement: "")]
        if !content.isEmpty { edits.append(TextEdit(range: NSRange(location: target, length: 0), replacement: content)) }
        return EditResult(edits: edits, selection: NSRange(location: target, length: 0))
    }

    /// Where a new selection really goes. A caret never lands on hidden lines: it skips them
    /// in the direction it moved (onto the line after them, or the end of the line before).
    /// A selection reaching into hidden lines from outside covers them whole. `reveal`: a
    /// selection that starts inside hidden lines without being extended there (a find match):
    /// open those folds.
    func adjust(_ new: NSRange, from old: NSRange, in text: NSString) -> (range: NSRange, reveal: Fold?) {
        if new.length == 0 {
            guard let f = hidesCaret(at: new.location, in: text) else { return (new, nil) }
            let e = NSMaxRange(f.body)
            let afterVisible = e < text.length || (e > 0 && text.character(at: e - 1) == 10)
            let target = new.location > old.location && afterVisible ? e : HeadingFolds.lineEndBefore(f, in: text)
            return (NSRange(location: target, length: 0), nil)
        }
        var start = new.location, end = NSMaxRange(new)
        if let f = hiding(start) {
            // extended backwards into them (the end stayed put): cover them; else reveal
            guard end == NSMaxRange(old), old != new else { return (new, f) }
            start = HeadingFolds.lineEndBefore(f, in: text)
        }
        // ending inside hidden lines, or right before them (the heading's line selected whole)
        if let f = hiding(end - 1) ?? folding(from: end) { end = max(end, NSMaxRange(f.body)) }
        return (NSRange(location: start, length: end - start), nil)
    }

    // MARK: Helpers

    private static func blocks(_ folds: [Fold]) -> [Fold] {
        var out: [Fold] = []
        for f in folds.filter({ $0.body.length > 0 }).sorted(by: { $0.body.location < $1.body.location }) {
            if let last = out.last, f.body.location < NSMaxRange(last.body) {
                out[out.count - 1].body = NSUnionRange(last.body, f.body)
            } else {
                out.append(f)
            }
        }
        return out
    }

    private func index(of heading: Int) -> Int {
        var lo = 0, hi = folds.count
        while lo < hi {
            let mid = (lo + hi) / 2
            if folds[mid].heading < heading { lo = mid + 1 } else { hi = mid }
        }
        return lo
    }

    private func lowerBound(_ a: [Int], _ x: Int) -> Int {
        var lo = 0, hi = a.count
        while lo < hi {
            let mid = (lo + hi) / 2
            if a[mid] < x { lo = mid + 1 } else { hi = mid }
        }
        return lo
    }

    private mutating func remove(opened p: Int) {
        let i = lowerBound(opened, p)
        if i < opened.count, opened[i] == p { opened.remove(at: i) }
    }
}
