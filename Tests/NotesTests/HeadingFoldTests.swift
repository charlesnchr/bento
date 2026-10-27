import AppKit
import Testing
@testable import Notes

@Suite struct HeadingFoldTests {
    func styled(_ text: String, caret: Int? = nil) -> (NSTextStorage, MarkdownStyler) {
        let s = NSTextStorage(string: text)
        let st = MarkdownStyler()
        st.selectionChanged(s, to: NSRange(location: caret ?? s.length, length: 0))
        st.styleAll(s)
        return (s, st)
    }

    func deco(_ s: NSTextStorage, _ loc: Int) -> BlockDecoration? {
        s.attribute(.notesBlock, at: loc, effectiveRange: nil) as? BlockDecoration
    }

    func hidden(_ s: NSTextStorage, _ loc: Int) -> Bool { s.attribute(.notesHidden, at: loc, effectiveRange: nil) != nil }

    let text = "# Note\nintro\n## A\nline a\n### A1\ndeep\n## B\nline b"
    func at(_ s: String) -> Int { (text as NSString).range(of: s).location }

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
        let (s, _) = styled(text)
        for h in ["# Note", "## A", "### A1", "## B"] { #expect(deco(s, at(h))?.collapsed == false, "\(h)") }
        #expect(deco(s, at("line a"))?.collapsed == nil)
        #expect(deco(s, at("deep"))?.kind == .paragraph(empty: false))
    }

    @Test func collapsingHidesTheSectionIncludingSubheadings() {
        let (s, st) = styled(text, caret: 0)
        #expect(st.toggleHeading(s, at: at("## A")))
        #expect(deco(s, at("## A"))?.collapsed == true)
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
        for loc in [-1, NSNotFound, s.length + 1] {
            #expect(!st.toggleHeading(s, at: loc))
            #expect(MarkdownStyler.collapsedSection(at: loc, in: s) == nil)
        }
    }

    @Test func nestedSectionsKeepTheirOwnState() {
        let (s, st) = styled(text, caret: 0)
        #expect(st.toggleHeading(s, at: at("### A1")))
        #expect(deco(s, at("line a"))?.kind == .paragraph(empty: false))
        #expect(deco(s, at("deep"))?.kind == .folded)
        // collapsing and reopening the parent keeps the child collapsed
        #expect(st.toggleHeading(s, at: at("## A")))
        #expect(deco(s, at("### A1"))?.kind == .folded)
        #expect(st.toggleHeading(s, at: at("## A")))
        #expect(deco(s, at("### A1"))?.collapsed == true)
        #expect(deco(s, at("deep"))?.kind == .folded)
    }

    @Test func collapsedSectionRange() {
        let (s, st) = styled(text, caret: 0)
        st.toggleHeading(s, at: at("## A"))
        let e = MarkdownStyler.collapsedSection(at: at("deep"), in: s)
        #expect(e?.heading == NSRange(location: at("## A"), length: 5))
        #expect(e?.hidden == NSRange(location: at("line a"), length: at("## B") - 1 - at("line a")))  // not the last newline
        #expect(MarkdownStyler.collapsedSection(at: at("## A"), in: s) == nil)
        #expect(MarkdownStyler.collapsedSection(at: at("line b"), in: s) == nil)
    }

    @Test func selectionInsideOpensIt() {
        let (s, st) = styled(text, caret: 0)
        st.toggleHeading(s, at: at("## A"))
        // a find match in the section
        st.selectionChanged(s, to: NSRange(location: at("deep"), length: 4))
        #expect(deco(s, at("## A"))?.collapsed == false)
        #expect(deco(s, at("deep"))?.kind == .paragraph(empty: false))
    }

    @Test func capturedThoughtsStartCollapsed() {
        let body = "# Thoughts\n\n### 2026-10-26 14:05 · An idea\nthe idea\n\n### 2026-10-26 14:06 · Another\nmore\n"
        let ns = body as NSString
        // the caret at the end (where a note opens) doesn't open the last one
        let (s, st) = styled(body)
        #expect(deco(s, 0)?.collapsed == false)
        #expect(deco(s, ns.range(of: "### 2026-10-26 14:05").location)?.collapsed == true)
        #expect(deco(s, ns.range(of: "the idea").location)?.kind == .folded)
        let last = ns.range(of: "### 2026-10-26 14:06").location
        #expect(deco(s, last)?.collapsed == true)
        #expect(deco(s, ns.range(of: "more").location)?.kind == .folded)
        #expect(st.toggleHeading(s, at: last))
        #expect(deco(s, ns.range(of: "more").location)?.kind == .paragraph(empty: false))
        #expect(ThoughtCapture.isEntryHeading("2026-10-26 14:05 · An idea"))
        #expect(!ThoughtCapture.isEntryHeading("Meeting 2026-10-26 14:05 · x"))
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
        let s = NSTextStorage(string: "## Idea\nbody\n## Next")
        let st = MarkdownStyler()
        st.selectionChanged(s, to: NSRange(location: 7, length: 0))
        st.styleAll(s)
        st.toggleHeading(s, at: 0)
        s.replaceCharacters(in: NSRange(location: 7, length: 0), with: "s")
        st.didEdit(s, editedRange: NSRange(location: 7, length: 1))
        #expect(deco(s, 0)?.collapsed == true)
        #expect(deco(s, 9)?.kind == .folded)
        #expect(st.toggled.contains("## Ideas\u{0}0"))
        // removing the "#"s: no heading, nothing folded
        s.replaceCharacters(in: NSRange(location: 0, length: 3), with: "")
        st.didEdit(s, editedRange: NSRange(location: 0, length: 0))
        #expect(deco(s, 0)?.collapsed == nil)
        #expect(deco(s, 6)?.kind == .paragraph(empty: false))
    }

    @Test func typingAHeadingAboveFoldsNothingElse() {
        let (s, st) = styled("a\nb\n## X\nc", caret: 0)
        s.replaceCharacters(in: NSRange(location: 0, length: 0), with: "# ")
        st.didEdit(s, editedRange: NSRange(location: 0, length: 2))
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
        #expect(MarkdownStyler.collapsedSection(at: 7, in: s)?.hidden == NSRange(location: 6, length: 4))
    }

    @Test func randomEditsKeepFoldRangesInsideTheDocument() {
        var rng = CommandFuzz.RNG(state: 73)
        let (s, st) = styled(text + "\n### 2026-10-26 14:05 · B\n😀\n")
        let lm = NotesLayoutManager()
        let container = NSTextContainer(size: NSSize(width: 360, height: CGFloat.greatestFiniteMagnitude))
        lm.addTextContainer(container)
        s.addLayoutManager(lm)
        let pieces = ["## A\n", "# B\n", "```\n", "\r\n", "😀", "- [ ] task\n", "", "text"]
        for _ in 0..<400 {
            let a = Int.random(in: 0...s.length, using: &rng)
            let b = Int.random(in: a...min(s.length, a + 12), using: &rng)
            let rep = pieces.randomElement(using: &rng)!
            s.replaceCharacters(in: NSRange(location: a, length: b - a), with: rep)
            st.didEdit(s, editedRange: NSRange(location: a, length: (rep as NSString).length))
            let caret = Int.random(in: 0...s.length, using: &rng)
            st.selectionChanged(s, to: NSRange(location: caret, length: 0))
            let ns = s.string as NSString
            let line = ns.lineRange(for: NSRange(location: caret, length: 0))
            _ = st.toggleHeading(s, at: line.location)
            lm.ensureLayout(for: container)
            if let e = MarkdownStyler.collapsedSection(at: caret, in: s) {
                #expect(e.heading.location >= 0 && NSMaxRange(e.heading) <= s.length)
                #expect(e.hidden.location >= NSMaxRange(e.heading) && NSMaxRange(e.hidden) <= s.length)
            }
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
        st.styleAll(s)
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
