import AppKit
import Testing
@testable import Notes

@Suite struct HeadingFoldTests {
    /// A note as the editor shows it after opening it (captured thoughts collapse).
    func styled(_ text: String, caret: Int? = nil) -> (NSTextStorage, MarkdownStyler) {
        let s = NSTextStorage(string: text)
        let st = MarkdownStyler()
        st.selectionChanged(s, to: NSRange(location: caret ?? s.length, length: 0))
        st.styleAll(s, adopt: true)
        return (s, st)
    }

    func deco(_ s: NSTextStorage, _ loc: Int) -> BlockDecoration? {
        s.attribute(.notesBlock, at: loc, effectiveRange: nil) as? BlockDecoration
    }

    func hidden(_ s: NSTextStorage, _ loc: Int) -> Bool { s.attribute(.notesHidden, at: loc, effectiveRange: nil) != nil }

    /// Applies an edit like the editor: each replacement processed on its own.
    func apply(_ r: EditResult?, _ s: NSTextStorage, _ st: MarkdownStyler, external: Bool = false) {
        guard let r else { Issue.record("no edit"); return }
        for e in r.edits.sorted(by: { $0.range.location > $1.range.location }) {
            s.replaceCharacters(in: e.range, with: e.replacement)
            st.didEdit(s, editedRange: NSRange(location: e.range.location, length: (e.replacement as NSString).length), external: external)
        }
        st.selectionChanged(s, to: r.selection)
    }

    func type(_ str: String, at loc: Int, _ s: NSTextStorage, _ st: MarkdownStyler) {
        apply(EditResult(edits: [TextEdit(range: NSRange(location: loc, length: 0), replacement: str)],
                         selection: NSRange(location: loc + (str as NSString).length, length: 0)), s, st)
    }

    /// Every line's decoration agrees with the fold state.
    func checkConsistent(_ s: NSTextStorage, _ st: MarkdownStyler, sourceLocation: SourceLocation = #_sourceLocation) {
        let ns = s.string as NSString
        var loc = 0
        while loc < ns.length {
            let line = ns.lineRange(for: NSRange(location: loc, length: 0))
            #expect((deco(s, loc)?.kind == .folded) == (st.folds.hiding(loc) != nil), "line at \(loc)", sourceLocation: sourceLocation)
            loc = NSMaxRange(line)
        }
        for f in st.folds.folds {
            #expect(f.heading >= 0 && NSMaxRange(f.body) <= ns.length, sourceLocation: sourceLocation)
            #expect(f.body.location >= NSMaxRange(ns.lineRange(for: NSRange(location: min(f.heading, ns.length), length: 0))), sourceLocation: sourceLocation)
            #expect(ns.lineRange(for: NSRange(location: min(f.heading, ns.length), length: 0)).location == f.heading, sourceLocation: sourceLocation)
            let e = NSMaxRange(f.body)
            #expect(f.body.length == 0 || e == ns.length || ns.lineRange(for: NSRange(location: e, length: 0)).location == e, sourceLocation: sourceLocation)
        }
    }

    let text = "# Note\nintro\n## A\nline a\n### A1\ndeep\n## B\nline b"
    func at(_ s: String) -> Int { (text as NSString).range(of: s).location }

    // MARK: Sections

    @Test func sectionEndsAtTheNextHeadingOfTheSameOrAHigherLevel() {
        let ns = text as NSString
        let a = ns.lineRange(for: NSRange(location: at("## A"), length: 0))
        #expect(MarkdownParser.sectionEnd(after: a, level: 2, in: ns) == at("## B"))
        let a1 = ns.lineRange(for: NSRange(location: at("### A1"), length: 0))
        #expect(MarkdownParser.sectionEnd(after: a1, level: 3, in: ns) == at("## B"))
        #expect(MarkdownParser.sectionEnd(after: ns.lineRange(for: NSRange(location: 0, length: 0)), level: 1, in: ns) == ns.length)
        // a "#" line in a code block isn't a heading
        let code = "## A\n```\n# not\n```\nx\n# B" as NSString
        #expect(MarkdownParser.sectionEnd(after: code.lineRange(for: NSRange(location: 0, length: 0)), level: 2, in: code) == code.range(of: "# B").location)
    }

    @Test func headingsAreOpenByDefault() {
        let (s, st) = styled(text)
        for h in ["# Note", "## A", "### A1", "## B"] { #expect(deco(s, at(h))?.collapsed == false, "\(h)") }
        #expect(deco(s, at("line a"))?.collapsed == nil)
        #expect(deco(s, at("deep"))?.kind == .paragraph(empty: false))
        #expect(st.folds.isEmpty)
    }

    @Test func collapsingHidesTheSectionIncludingSubheadings() {
        let (s, st) = styled(text, caret: 0)
        #expect(st.toggleHeading(s, at: at("## A")))
        #expect(deco(s, at("## A"))?.collapsed == true)
        #expect(st.folds.fold(at: at("## A"))?.body == NSRange(location: at("line a"), length: at("## B") - at("line a")))
        for loc in [at("line a"), at("### A1"), at("deep")] {
            #expect(deco(s, loc)?.kind == .folded)
            #expect(hidden(s, loc))
        }
        #expect(!hidden(s, at("line a") + 6))  // newlines stay line breaks
        let ps = s.attribute(.paragraphStyle, at: at("deep"), effectiveRange: nil) as? NSParagraphStyle
        #expect((ps?.maximumLineHeight ?? 0) > 0 && (ps?.maximumLineHeight ?? 1) < 1)
        #expect(deco(s, at("## B"))?.collapsed == false)
        #expect(deco(s, at("line b"))?.kind == .paragraph(empty: false))
        #expect(st.toggleHeading(s, at: at("## A")))
        #expect(deco(s, at("deep"))?.kind == .paragraph(empty: false))
        #expect(!st.toggleHeading(s, at: at("line a")))
        #expect(!st.toggleHeading(s, at: at("## A") + 1))
        for loc in [-1, NSNotFound, s.length + 1] { #expect(!st.toggleHeading(s, at: loc)) }
        checkConsistent(s, st)
    }

    @Test func nestedSectionsKeepTheirOwnState() {
        let (s, st) = styled(text, caret: 0)
        #expect(st.toggleHeading(s, at: at("### A1")))
        #expect(deco(s, at("line a"))?.kind == .paragraph(empty: false))
        #expect(deco(s, at("deep"))?.kind == .folded)
        // collapsing and reopening the parent keeps the child collapsed
        #expect(st.toggleHeading(s, at: at("## A")))
        #expect(deco(s, at("### A1"))?.kind == .folded)
        #expect(st.folds.hiding(at("deep"))?.heading == at("## A"))
        #expect(st.toggleHeading(s, at: at("## A")))
        #expect(deco(s, at("### A1"))?.collapsed == true)
        #expect(deco(s, at("deep"))?.kind == .folded)
        checkConsistent(s, st)
    }

    @Test func capturedThoughtsStartCollapsed() {
        let body = "# Thoughts\n\n### 2026-10-26 14:05 · An idea\nthe idea\n\n### 2026-10-26 14:06 · Another\nmore\n"
        let ns = body as NSString
        let (s, st) = styled(body)
        #expect(deco(s, 0)?.collapsed == false)
        #expect(deco(s, ns.range(of: "### 2026-10-26 14:05").location)?.collapsed == true)
        #expect(deco(s, ns.range(of: "the idea").location)?.kind == .folded)
        let last = ns.range(of: "### 2026-10-26 14:06").location
        #expect(deco(s, last)?.collapsed == true)
        #expect(deco(s, ns.range(of: "more").location)?.kind == .folded)
        #expect(st.toggleHeading(s, at: last))
        #expect(deco(s, ns.range(of: "more").location)?.kind == .paragraph(empty: false))
        #expect(st.folds.isOpened(last))
        #expect(ThoughtCapture.isEntryHeading("2026-10-26 14:05 · An idea"))
        #expect(!ThoughtCapture.isEntryHeading("Meeting 2026-10-26 14:05 · x"))
        // restyling everything (a theme change) doesn't collapse an opened one again
        st.styleAll(s)
        #expect(deco(s, last)?.collapsed == false)
        checkConsistent(s, st)
    }

    @Test func identicalHeadingsToggleIndependently() {
        let entry = "## Same\nbody\n"
        let (s, st) = styled(entry + entry + "after", caret: 0)
        let second = (entry as NSString).length
        #expect(st.toggleHeading(s, at: 0))
        st.styleAll(s)
        #expect(deco(s, 0)?.collapsed == true)
        #expect(deco(s, second)?.collapsed == false)
        #expect(st.toggleHeading(s, at: second))
        #expect(st.toggleHeading(s, at: 0))
        #expect(deco(s, 0)?.collapsed == false)
        #expect(deco(s, second)?.collapsed == true)
    }

    @Test func editingAHeadingKeepsItCollapsed() {
        let (s, st) = styled("## Idea\nbody\n## Next", caret: 7)
        st.toggleHeading(s, at: 0)
        type("s", at: 7, s, st)
        #expect(deco(s, 0)?.collapsed == true)
        #expect(deco(s, 9)?.kind == .folded)
        // removing the "#"s: no heading, nothing folded
        apply(EditResult(edits: [TextEdit(range: NSRange(location: 0, length: 3), replacement: "")], selection: NSRange(location: 0, length: 0)), s, st)
        #expect(deco(s, 0)?.collapsed == nil)
        #expect(deco(s, 6)?.kind == .paragraph(empty: false))
        #expect(st.folds.folds.isEmpty)
        checkConsistent(s, st)
    }

    @Test func typingAHeadingAboveFoldsNothingElse() {
        let (s, st) = styled("a\nb\n## X\nc", caret: 0)
        type("# ", at: 0, s, st)
        var loc = 0
        let ns = s.string as NSString
        while loc < ns.length {
            #expect(deco(s, loc)?.kind != .folded)
            loc = NSMaxRange(ns.lineRange(for: NSRange(location: loc, length: 0)))
        }
    }

    @Test func CRLFSectionsCollapseWithoutHidingTheirTerminators() {
        let (s, st) = styled("## A\r\nbody\r\n## B", caret: 0)
        st.toggleHeading(s, at: 0)
        #expect(deco(s, 6)?.kind == .folded)
        #expect(!hidden(s, 10) && !hidden(s, 11))
        #expect(st.folds.fold(at: 0)?.body == NSRange(location: 6, length: 6))
        #expect(st.folds.adjust(NSRange(location: 7, length: 0), from: NSRange(location: 4, length: 0), in: s.string as NSString).range.location == 12)
        #expect(st.folds.adjust(NSRange(location: 7, length: 0), from: NSRange(location: 12, length: 0), in: s.string as NSString).range.location == 4)
    }

    // MARK: Editing around a collapsed section

    let thoughts = "# Thoughts\n\n### 2026-10-26 14:05 · A\none\n\n### 2026-10-26 14:06 · B\ntwo\n"
    func th(_ str: String) -> Int { (thoughts as NSString).range(of: str).location }
    var aEnd: Int { NSMaxRange((thoughts as NSString).range(of: "### 2026-10-26 14:05 · A")) }

    @Test func returnOnACollapsedHeadingStartsALineAfterItsSection() {
        let (s, st) = styled(thoughts)
        let a = th("### 2026-10-26 14:05"), b = th("### 2026-10-26 14:06")
        let r = st.folds.newline(s.string as NSString, selection: NSRange(location: aEnd, length: 0))
        #expect(r?.edits == [TextEdit(range: NSRange(location: b, length: 0), replacement: "\n")])
        #expect(r?.selection == NSRange(location: b, length: 0))
        apply(r, s, st)
        // the section stays collapsed with the same hidden lines; the new line shows
        #expect(st.folds.fold(at: a)?.body == NSRange(location: th("one"), length: 5))
        #expect(deco(s, b)?.kind == .paragraph(empty: true))
        #expect(st.folds.hidesCaret(at: b, in: s.string as NSString) == nil)
        #expect(st.folds.isCollapsed(b + 1))
        type("hello", at: b, s, st)
        #expect(s.string == thoughts.replacingOccurrences(of: "one\n\n", with: "one\n\nhello\n"))
        #expect(deco(s, b)?.kind == .paragraph(empty: false) && !hidden(s, b))
        #expect(st.folds.fold(at: a)?.body == NSRange(location: th("one"), length: 5))
        checkConsistent(s, st)
        // in the middle of the heading's text: not handled (an ordinary split)
        #expect(st.folds.newline(s.string as NSString, selection: NSRange(location: aEnd - 2, length: 0)) == nil)
        // on an open heading or a plain line: not handled
        st.toggleHeading(s, at: a)
        #expect(st.folds.newline(s.string as NSString, selection: NSRange(location: aEnd, length: 0)) == nil)
        #expect(st.folds.newline(s.string as NSString, selection: NSRange(location: 3, length: 0)) == nil)
    }

    @Test func returnAtTheStartOfACollapsedHeadingAddsALineAbove() {
        let (s, st) = styled(thoughts)
        let a = th("### 2026-10-26 14:05")
        let r = st.folds.newline(s.string as NSString, selection: NSRange(location: a + 4, length: 0))
        #expect(r?.edits == [TextEdit(range: NSRange(location: a, length: 0), replacement: "\n")])
        apply(r, s, st)
        #expect(st.folds.fold(at: a + 1)?.body == NSRange(location: th("one") + 1, length: 5))
        #expect(deco(s, a)?.kind == .paragraph(empty: true))
        checkConsistent(s, st)
    }

    @Test func returnOnTheLastSectionWithoutANewline() {
        let (s, st) = styled("## X\nbody", caret: 0)
        st.toggleHeading(s, at: 0)
        let r = st.folds.newline(s.string as NSString, selection: NSRange(location: 4, length: 0))
        #expect(r?.edits == [TextEdit(range: NSRange(location: 9, length: 0), replacement: "\n")])
        #expect(r?.selection == NSRange(location: 10, length: 0))
        apply(r, s, st)
        #expect(st.folds.fold(at: 0)?.body == NSRange(location: 5, length: 5))
        #expect(st.folds.hidesCaret(at: 10, in: s.string as NSString) == nil)
        type("next", at: 10, s, st)
        #expect(s.string == "## X\nbody\nnext")
        #expect(!hidden(s, 10))
        checkConsistent(s, st)
        // and with a trailing newline the new line goes before the empty last line
        let (s2, st2) = styled("## X\nbody\n", caret: 0)
        st2.toggleHeading(s2, at: 0)
        let r2 = st2.folds.newline(s2.string as NSString, selection: NSRange(location: 4, length: 0))
        #expect(r2?.edits == [TextEdit(range: NSRange(location: 10, length: 0), replacement: "\n")])
        #expect(r2?.selection == NSRange(location: 10, length: 0))
    }

    @Test func backspaceAfterACollapsedSectionNeverTouchesHiddenText() {
        let (s, st) = styled(thoughts)
        let a = th("### 2026-10-26 14:05"), b = th("### 2026-10-26 14:06")
        apply(st.folds.newline(s.string as NSString, selection: NSRange(location: aEnd, length: 0)), s, st)
        // an empty line after it: removed, the caret goes to the heading
        let r = st.folds.backspace(s.string as NSString, selection: NSRange(location: b, length: 0))
        #expect(r?.selection == NSRange(location: aEnd, length: 0))
        apply(r, s, st)
        #expect(s.string == thoughts)
        #expect(st.folds.fold(at: a)?.body == NSRange(location: th("one"), length: 5))
        // a line with text: joined onto the heading
        apply(st.folds.newline(s.string as NSString, selection: NSRange(location: aEnd, length: 0)), s, st)
        type("hello", at: b, s, st)
        apply(st.folds.backspace(s.string as NSString, selection: NSRange(location: b, length: 0)), s, st)
        #expect(s.string == thoughts.replacingOccurrences(of: "· A\n", with: "· Ahello\n"))
        let f = st.folds.fold(at: a)
        #expect(f.map { (s.string as NSString).substring(with: $0.body) } == "one\n\n")
        checkConsistent(s, st)
        // not after a collapsed section: not handled
        #expect(st.folds.backspace(s.string as NSString, selection: NSRange(location: 3, length: 0)) == nil)
    }

    @Test func forwardDeleteAtTheEndOfACollapsedHeading() {
        let body = "## X\nbody\n\nnext line\n## Y"
        let (s, st) = styled(body, caret: 0)
        st.toggleHeading(s, at: 0)
        let hiddenText = "body\n\nnext line\n"
        #expect(st.folds.fold(at: 0).map { (s.string as NSString).substring(with: $0.body) } == hiddenText)
        // the next visible line ("## Y") is joined without its marker; the caret stays
        let r = st.folds.deleteForward(s.string as NSString, selection: NSRange(location: 4, length: 0))
        #expect(r?.selection == NSRange(location: 4, length: 0))
        apply(r, s, st)
        // ("## Y" was the last line: the newline before it went instead of one after it)
        #expect(s.string == "## XY\nbody\n\nnext line")
        #expect(st.folds.fold(at: 0).map { (s.string as NSString).substring(with: $0.body) } == "body\n\nnext line")
        // nothing after the section now: nothing happens
        #expect(st.folds.deleteForward(s.string as NSString, selection: NSRange(location: 5, length: 0))?.edits == [])
        let (s2, st2) = styled("## X\nbody", caret: 0)
        st2.toggleHeading(s2, at: 0)
        #expect(st2.folds.deleteForward(s2.string as NSString, selection: NSRange(location: 4, length: 0))?.edits == [])
        checkConsistent(s, st)
    }

    @Test func editsOfHiddenTextAreRefusedUnlessTheyTakeItWhole() {
        let (s, st) = styled(thoughts)
        let ns = s.string as NSString
        let a = th("### 2026-10-26 14:05"), one = th("one"), b = th("### 2026-10-26 14:06")
        let f = st.folds
        #expect(f.allows(NSRange(location: aEnd, length: 0), in: ns))          // typing at the heading's end
        #expect(f.allows(NSRange(location: b, length: 0), in: ns))             // on the line after
        #expect(f.allows(NSRange(location: a + 4, length: 3), in: ns))         // the heading's text
        #expect(!f.allows(NSRange(location: one, length: 0), in: ns))          // inside
        #expect(!f.allows(NSRange(location: one + 1, length: 1), in: ns))
        #expect(!f.allows(NSRange(location: aEnd, length: 1), in: ns))         // the line break before it
        #expect(!f.allows(NSRange(location: b - 1, length: 2), in: ns))        // into it from below
        #expect(!f.allows(NSRange(location: a + 4, length: one + 1 - a - 4), in: ns))
        #expect(f.allows(NSRange(location: a, length: b - a), in: ns))         // the whole section
        #expect(f.allows(NSRange(location: 2, length: ns.length - 2), in: ns))
    }

    @Test func shiftRightAtTheEndOfACollapsedHeadingDoesntTakeTheSection() {
        let (s, st) = styled(thoughts)
        let ns = s.string as NSString
        let a = th("### 2026-10-26 14:05"), one = th("one")
        // ⇧→ at the heading's end (the text view jumps over the hidden lines): stays put
        let b = th("### 2026-10-26 14:06")
        #expect(st.folds.adjust(NSRange(location: aEnd, length: b - aEnd), from: NSRange(location: aEnd, length: 0), in: ns).range == NSRange(location: aEnd, length: 0))
        #expect(st.folds.adjust(NSRange(location: aEnd, length: 1), from: NSRange(location: aEnd, length: 0), in: ns).range == NSRange(location: aEnd, length: 0))
        // from inside the heading's text into the hidden lines: up to the heading's end
        #expect(st.folds.adjust(NSRange(location: a + 6, length: one + 2 - a - 6), from: NSRange(location: a + 6, length: 0), in: ns).range == NSRange(location: a + 6, length: aEnd - a - 6))
        // past them, into the next line: the section comes along (the selection shows beyond it)
        #expect(st.folds.adjust(NSRange(location: a + 6, length: b + 6 - a - 6), from: NSRange(location: a + 6, length: 0), in: ns).range.length == b - a)
        // the whole line (from its start): the section comes along
        #expect(st.folds.adjust(NSRange(location: a, length: one - a), from: NSRange(location: a, length: 0), in: ns).range == NSRange(location: a, length: th("### 2026-10-26 14:06") - a))
    }

    @Test func aCollapsedSectionLeftHidingNothingOpens() {
        let (s, st) = styled("## X\n## Y\nbody", caret: 0)
        #expect(st.toggleHeading(s, at: 0))
        #expect(st.folds.fold(at: 0)?.body.length == 0)
        type("typed under it\n", at: 5, s, st)
        #expect(!st.folds.isCollapsed(0) && st.folds.isOpened(0))
        #expect(deco(s, 0)?.collapsed == false)
        #expect(deco(s, 5)?.kind == .paragraph(empty: false))
        checkConsistent(s, st)
    }

    @Test func movingALinePastACollapsedHeadingKeepsTheSection() {
        let body = "above\n## S\nhidden\n# E"
        for (caret, up) in [(1, false), (8, true)] {
            let (s, st) = styled(body, caret: 0)
            st.toggleHeading(s, at: 6)
            let r = st.folds.moveLines(s.string as NSString, selection: NSRange(location: caret, length: 0), up: up)
            #expect(r?.edits == [TextEdit(range: NSRange(location: 0, length: 6), replacement: ""), TextEdit(range: NSRange(location: 11, length: 0), replacement: "above\n")])
            apply(r, s, st)
            #expect(s.string == "## S\nabove\nhidden\n# E")
            #expect(st.folds.fold(at: 0).map { (s.string as NSString).substring(with: $0.body) } == "hidden\n")
            #expect(deco(s, 5)?.kind == .paragraph(empty: false))
            checkConsistent(s, st)
        }
        // nowhere near a collapsed section: an ordinary move
        let (s, st) = styled(body, caret: 0)
        #expect(st.folds.moveLines(s.string as NSString, selection: NSRange(location: 1, length: 0), up: false) == nil)
    }

    @Test func caretsSkipHiddenLinesAndSelectionsCoverThem() {
        let (s, st) = styled(thoughts)
        let ns = s.string as NSString
        let a = th("### 2026-10-26 14:05"), one = th("one"), b = th("### 2026-10-26 14:06")
        let f = st.folds
        // ↓ from the heading lands after the section, ↑ from below on the heading
        let down = f.adjust(NSRange(location: one, length: 0), from: NSRange(location: aEnd, length: 0), in: ns)
        #expect(down.range == NSRange(location: b, length: 0) && down.reveal == nil)
        #expect(f.adjust(NSRange(location: one + 2, length: 0), from: NSRange(location: b + 4, length: 0), in: ns).range == NSRange(location: aEnd, length: 0))
        // the end of the last hidden line is the heading's end too
        #expect(f.adjust(NSRange(location: ns.length - 1, length: 0), from: NSRange(location: ns.length, length: 0), in: ns).range.location == th("### 2026-10-26 14:06") + 24)
        #expect(f.adjust(NSRange(location: ns.length, length: 0), from: NSRange(location: 0, length: 0), in: ns).range.location == ns.length)
        // the heading's line selected whole (triple-click, ⇧↓): the section comes with it
        #expect(f.adjust(NSRange(location: a, length: one - a), from: NSRange(location: a + 3, length: 0), in: ns).range == NSRange(location: a, length: b - a))
        // ⇧↑ from below into it: covers it
        #expect(f.adjust(NSRange(location: one + 1, length: b - one - 1), from: NSRange(location: b, length: 0), in: ns).range == NSRange(location: aEnd, length: b - aEnd))
        // a find match inside: reveal
        let found = f.adjust(NSRange(location: one, length: 3), from: NSRange(location: 0, length: 0), in: ns)
        #expect(found.range == NSRange(location: one, length: 3) && found.reveal?.heading == a)
        st.reveal(s, at: one)
        #expect(!st.folds.isCollapsed(a) && st.folds.isOpened(a))
        #expect(deco(s, one)?.kind == .paragraph(empty: false))
        checkConsistent(s, st)
    }

    // MARK: Fold state across edits

    @Test func foldsMoveWithEditsElsewhere() {
        let (s, st) = styled(thoughts, caret: 0)
        let a = th("### 2026-10-26 14:05"), b = th("### 2026-10-26 14:06")
        st.toggleHeading(s, at: b)  // the user opens B
        type("New first line\n", at: 0, s, st)
        let shift = 15
        #expect(st.folds.isCollapsed(a + shift) && st.folds.isOpened(b + shift))
        #expect(deco(s, th("one") + shift)?.kind == .folded)
        #expect(deco(s, th("two") + shift)?.kind == .paragraph(empty: false))
        // deleting a line between them
        apply(EditResult(edits: [TextEdit(range: NSRange(location: 0, length: shift), replacement: "")], selection: NSRange(location: 0, length: 0)), s, st)
        #expect(st.folds.isCollapsed(a) && st.folds.isOpened(b))
        checkConsistent(s, st)
    }

    @Test func foldsSurviveSyncMergesAndArrivingThoughts() {
        let (s, st) = styled(thoughts, caret: 0)
        let a = th("### 2026-10-26 14:05"), b = th("### 2026-10-26 14:06")
        st.toggleHeading(s, at: b)  // the user opens B
        // another device edits the hidden text of A, adds a line at the top and captures a thought
        let remote = "Top\n" + thoughts.replacingOccurrences(of: "one\n", with: "one, edited\n") + "\n### 2026-10-26 15:00 · C\nthree\n"
        let edits = TextMerge.edits(from: s.string, to: remote)
        apply(EditResult(edits: edits, selection: NSRange(location: 0, length: 0)), s, st, external: true)
        #expect(s.string == remote)
        let rs = remote as NSString
        let a2 = rs.range(of: "### 2026-10-26 14:05").location, b2 = rs.range(of: "### 2026-10-26 14:06").location
        let c = rs.range(of: "### 2026-10-26 15:00").location
        #expect(a2 == a + 4 && b2 == b + 12)
        #expect(st.folds.fold(at: a2).map { rs.substring(with: $0.body) } == "one, edited\n\n")
        #expect(st.folds.isOpened(b2) && !st.folds.isCollapsed(b2))
        #expect(st.folds.isCollapsed(c))
        #expect(deco(s, rs.range(of: "three").location)?.kind == .folded)
        #expect(deco(s, rs.range(of: "two").location)?.kind == .paragraph(empty: false))
        checkConsistent(s, st)
    }

    @Test func thoughtsTypedHereStayOpen() {
        let (s, st) = styled("# Note\n", caret: 7)
        type("### 2026-10-27 09:00 · typed\nline", at: 7, s, st)
        #expect(!st.folds.isCollapsed(7) && st.folds.isOpened(7))
        #expect(deco(s, (s.string as NSString).range(of: "line").location)?.kind == .paragraph(empty: false))
        // a capture arriving while the note is open collapses
        let captured = ThoughtCapture.append(ThoughtCapture.entry("Arrived", at: Date(timeIntervalSince1970: 1_793_021_145))!, to: s.string)
        apply(EditResult(edits: TextMerge.edits(from: s.string, to: captured), selection: NSRange(location: 0, length: 0)), s, st, external: true)
        let arrived = (captured as NSString).range(of: "\nArrived").location + 1
        #expect(deco(s, arrived)?.kind == .folded)
        #expect(!st.folds.isCollapsed(7))
        checkConsistent(s, st)
    }

    @Test func foldsComeBackWhenANoteIsShownAgain() {
        let (s, st) = styled(thoughts, caret: 0)
        let b = th("### 2026-10-26 14:06")
        st.toggleHeading(s, at: b)
        var saved = st.folds
        // changed elsewhere while another note was shown
        let changed = "Line\n" + thoughts + "\n### 2026-10-26 15:00 · C\nthree\n"
        saved.map(from: thoughts, to: changed)
        let s2 = NSTextStorage(string: changed)
        let st2 = MarkdownStyler()
        st2.setFolds(saved)
        st2.styleAll(s2, adopt: true)
        let cs = changed as NSString
        #expect(st2.folds.isCollapsed(cs.range(of: "### 2026-10-26 14:05").location))
        #expect(st2.folds.isOpened(b + 5) && !st2.folds.isCollapsed(b + 5))
        #expect(st2.folds.isCollapsed(cs.range(of: "### 2026-10-26 15:00").location))
        checkConsistent(s2, st2)
    }

    @Test func groupedEditsMoveFoldsExactly() {
        // several edits reported as one span (a sync merge, a command), with the edits given
        let (s, st) = styled(thoughts)
        let a = th("### 2026-10-26 14:05")
        let edits: [(range: NSRange, length: Int)] = [(NSRange(location: s.length, length: 0), 4), (NSRange(location: aEnd, length: 0), 5), (NSRange(location: 0, length: 0), 2)]
        s.replaceCharacters(in: NSRange(location: s.length, length: 0), with: "end\n")
        s.replaceCharacters(in: NSRange(location: aEnd, length: 0), with: " more")
        s.replaceCharacters(in: NSRange(location: 0, length: 0), with: "x\n")
        st.didEdit(s, editedRange: NSRange(location: 0, length: s.length), edits: edits, external: true)
        #expect(st.folds.fold(at: a + 2).map { (s.string as NSString).substring(with: $0.body) } == "one\n\n")
        #expect(st.folds.fold(at: th("### 2026-10-26 14:06") + 7).map { (s.string as NSString).substring(with: $0.body) } == "two\n")
        checkConsistent(s, st)
    }

    /// Random edits, toggles and fold-aware commands: the fold state stays well formed and
    /// in step with the styling, and no edit the editor allows changes hidden text.
    @Test func randomEditsNeverChangeHiddenText() {
        var rng = CommandFuzz.RNG(state: 73)
        let (s, st) = styled(text + "\n" + thoughts + "### 2026-10-26 14:07 · C\n😀\n")
        let lm = NotesLayoutManager()
        let container = NSTextContainer(size: NSSize(width: 360, height: CGFloat.greatestFiniteMagnitude))
        lm.addTextContainer(container)
        s.addLayoutManager(lm)
        let pieces = ["## A\n", "# B\n", "```\n", "\r\n", "\n", "😀", "- [ ] task\n", "", "text", "### 2026-10-26 14:09 · D\nd\n"]
        func hiddenTexts() -> [String] {
            let ns = s.string as NSString
            var out: [String] = [], loc = 0
            while loc < ns.length {
                if let b = st.folds.hiding(loc) {
                    out.append(ns.substring(with: b.body))
                    loc = NSMaxRange(b.body)
                } else {
                    loc = NSMaxRange(ns.lineRange(for: NSRange(location: loc, length: 0)))
                }
            }
            return out
        }
        for i in 0..<500 {
            let ns = s.string as NSString
            let caret = Int.random(in: 0...s.length, using: &rng)
            let line = ns.lineRange(for: NSRange(location: caret, length: 0))
            switch i % 5 {
            case 0:
                _ = st.toggleHeading(s, at: line.location)
            case 1:
                // a fold-aware command at a spot that matters for it
                let spot = [caret, NSMaxRange(MarkdownParser.contentRange(line, in: ns)), line.location].randomElement(using: &rng)!
                let sel = NSRange(location: spot, length: 0)
                let before = hiddenTexts()
                if let r = st.folds.newline(ns, selection: sel) ?? st.folds.backspace(ns, selection: sel) ?? st.folds.deleteForward(ns, selection: sel),
                   !r.edits.isEmpty {
                    apply(r, s, st)
                    for h in hiddenTexts() { #expect(before.contains { $0.contains(h) }, "\(h)") }
                }
            case 2:
                // a sync merge: anything goes
                let a = Int.random(in: 0...s.length, using: &rng)
                let b = Int.random(in: a...min(s.length, a + 12), using: &rng)
                apply(EditResult(edits: [TextEdit(range: NSRange(location: a, length: b - a), replacement: pieces.randomElement(using: &rng)!)],
                                 selection: NSRange(location: 0, length: 0)), s, st, external: true)
            default:
                // typing: only what the editor lets through
                let a = Int.random(in: 0...s.length, using: &rng)
                let b = Int.random(in: a...min(s.length, a + 12), using: &rng)
                let range = NSRange(location: a, length: b - a)
                guard st.folds.allows(range, in: ns) else { break }
                let covers = st.folds.folds.contains { $0.body.length > 0 && range.location <= $0.body.location && NSMaxRange(range) >= NSMaxRange($0.body) }
                let before = hiddenTexts()
                apply(EditResult(edits: [TextEdit(range: range, replacement: pieces.randomElement(using: &rng)!)],
                                 selection: NSRange(location: min(a, s.length), length: 0)), s, st)
                if !covers { for h in hiddenTexts() { #expect(before.contains { $0.contains(h) }, "\(h)") } }
            }
            lm.ensureLayout(for: container)
            checkConsistent(s, st)
        }
    }
}

@Suite struct ThoughtCaptureTests {
    let date = Date(timeIntervalSince1970: 1_793_021_145) // 2026-10-26 13:25:45 UTC
    let utc = TimeZone(identifier: "UTC")!

    @Test func entryIsAHeadingWithTimestampAndFirstWords() {
        let e = ThoughtCapture.entry("  Add a capture mode to the transcribe shortcut that appends to a note.\n", at: date, timeZone: utc)
        #expect(e == "### 2026-10-26 13:25 · Add a capture mode to the…\nAdd a capture mode to the transcribe shortcut that appends to a note.")
        #expect(ThoughtCapture.entry("Short one", at: date, timeZone: utc) == "### 2026-10-26 13:25 · Short one\nShort one")
        #expect(ThoughtCapture.entry(" \n\n ", at: date) == nil)
        #expect(ThoughtCapture.timestamp(date, timeZone: TimeZone(identifier: "Europe/London")!) == "2026-10-26 13:25")
        #expect(ThoughtCapture.isEntryHeading(String(e!.dropFirst(4).prefix { $0 != "\n" })))
    }

    @Test func bodyIsCleaned() {
        #expect(ThoughtCapture.cleaned("a\r\n\r\n\r\nb\n\n") == "a\n\nb")
        // a heading would end the entry's section
        #expect(ThoughtCapture.cleaned("a\n# Big\n  ### small\nb") == "a\n\\# Big\n\\### small\nb")
        #expect(ThoughtCapture.cleaned("look:\n```\ncode") == "look:\n```\ncode\n```")
        #expect(ThoughtCapture.summary(of: "one\ntwo  three") == "one two three")
    }

    @Test func appendsAsSeparateEntries() {
        #expect(ThoughtCapture.append("E1", to: "") == "E1\n")
        #expect(ThoughtCapture.append("E1", to: "  \n") == "  \n\nE1\n")
        #expect(ThoughtCapture.append("E2", to: "# Random snippets\nold text\n\n\n") == "# Random snippets\nold text\n\n\nE2\n")
    }

    @Test func appendPreservesExistingWhitespaceAndClosesAnOpenFence() {
        let body = "# Note\nA hard break  \n\n\n"
        #expect(ThoughtCapture.append("E", to: body) == body + "E\n")
        let fenced = "# Note\n~~~~swift\nlet x = 1"
        #expect(ThoughtCapture.append("E", to: fenced) == fenced + "\n~~~~\n\nE\n")
        #expect(ThoughtCapture.cleaned("~~~~swift\nlet x = 1") == "~~~~swift\nlet x = 1\n~~~~")
        #expect(ThoughtCapture.cleaned("~~~```lang\ncode") == "~~~```lang\ncode\n~~~")
    }

    /// Captures appended to an existing note are one collapsed section each, leaving the
    /// note's other lines alone.
    @Test func appendedEntriesAreCollapsedSections() {
        var body = "# Random snippets\n- [ ] a task"
        for text in ["First idea with quite a few words in it", "Second:\n\n## a heading\nwith a stray heading"] {
            body = ThoughtCapture.append(ThoughtCapture.entry(text, at: date, timeZone: utc)!, to: body)
        }
        let s = NSTextStorage(string: body)
        let st = MarkdownStyler()
        st.selectionChanged(s, to: NSRange(location: s.length, length: 0))
        st.styleAll(s, adopt: true)
        let ns = body as NSString
        var collapsed: [Bool] = [], folded = 0
        var loc = 0
        while loc < ns.length {
            let d = s.attribute(.notesBlock, at: loc, effectiveRange: nil) as? BlockDecoration
            if let c = d?.collapsed { collapsed.append(c) }
            if d?.kind == .folded { folded += 1 }
            loc = NSMaxRange(ns.lineRange(for: NSRange(location: loc, length: 0)))
        }
        #expect(collapsed == [false, true, true])
        #expect(folded == 6)  // 1 + blank, 4 + blank before the second entry
        #expect(NoteText.title(of: body) == "Random snippets")
        #expect((s.attribute(.notesBlock, at: 18, effectiveRange: nil) as? BlockDecoration)?.kind == .task(level: 0, checked: false))
        #expect(body.hasSuffix("· Second: ## a heading with a…\nSecond:\n\n\\## a heading\nwith a stray heading\n"))
    }
}

@Suite struct HeadingFoldPerformanceTests {
    /// A long Thoughts note (every thought collapsed) in the editor's storage, laid out:
    /// opening it and typing stay fast.
    @Test func longThoughtsNoteStaysFast() {
        var body = "# Thoughts\n"
        for i in 0..<400 {
            body = ThoughtCapture.append(ThoughtCapture.entry("Thought number \(i) with a few more words in it\n\nand a second paragraph \(i)",
                                                              at: Date(timeIntervalSince1970: 1_793_021_145 + Double(i) * 60))!, to: body)
        }
        do {
            let s = NSTextStorage(string: body)
            let lm = NotesLayoutManager()
            let container = NSTextContainer(size: NSSize(width: 360, height: CGFloat.greatestFiniteMagnitude))
            lm.addTextContainer(container)
            s.addLayoutManager(lm)
            let st = MarkdownStyler()
            let t0 = Date()
            st.styleAll(s, adopt: true)
            let open = Date().timeIntervalSince(t0)
            #expect(st.folds.folds.count == 400)
            var typing: TimeInterval = 0
            var line = 0
            for k in 0..<50 {
                // at the end, then on a new line between two collapsed thoughts
                if k == 25 { line = (s.string as NSString).range(of: "### 2026", options: .backwards).location }
                let loc = k < 25 ? s.length : line + max(0, k - 26)
                let t1 = Date()
                s.replaceCharacters(in: NSRange(location: loc, length: 0), with: k == 25 ? "\n" : "x")
                st.didEdit(s, editedRange: NSRange(location: loc, length: 1))
                lm.ensureLayout(forBoundingRect: NSRect(x: 0, y: 0, width: 360, height: 600), in: container)
                typing += Date().timeIntervalSince(t1)
            }
            let perKey = typing / 50
            print("thoughts note \(s.length) chars: open \(Int(open * 1000)) ms, per keystroke \(String(format: "%.2f", perKey * 1000)) ms")
            #expect(perKey < 0.02)
            #expect(open < 3)
            #expect(st.folds.folds.count == 400)
        }
    }
}
