import AppKit
import Testing
@testable import Notes

@Suite struct ExpanderParserTests {
    @Test func parsesSummaryAndEndLines() {
        let h = MarkdownParser.parseLine("::: details 2026-10-26 14:05 · An idea", inCode: false)
        #expect(h.kind == .details)
        #expect(h.prefixRange == NSRange(location: 0, length: 12))
        #expect(("::: details 2026-10-26 14:05 · An idea" as NSString).substring(with: h.contentRange) == "2026-10-26 14:05 · An idea")
        #expect(MarkdownParser.parseLine(":::details Tight", inCode: false).kind == .details)
        #expect(MarkdownParser.parseLine("  ::: details", inCode: false).kind == .details)
        #expect(MarkdownParser.parseLine(":::", inCode: false).kind == .detailsEnd)
        #expect(MarkdownParser.parseLine(" :::  ", inCode: false).kind == .detailsEnd)
    }

    @Test func otherColonLinesStayText() {
        for line in ["::::", "::: tip Careful", "::: detailsx", "a ::: details", "    ::: details deep", ":: details"] {
            #expect(MarkdownParser.parseLine(line, inCode: false).kind == .paragraph, "\(line)")
        }
        #expect(MarkdownParser.parseLine(":::", inCode: true).kind == .code)
        #expect(MarkdownParser.parseLine("::: details x", inCode: true).kind == .code)
    }

    @Test func findsTheClosingLine() {
        let text = "::: details A\nbody\n```\n:::\n```\n:::\nafter" as NSString
        let summary = text.lineRange(for: NSRange(location: 0, length: 0))
        // the ":::" inside the code fence doesn't close it
        #expect(MarkdownParser.expanderEnd(after: summary, in: text) == NSRange(location: 31, length: 3))
        let unclosed = "::: details A\nbody\n::: details B\nx\n:::" as NSString
        #expect(MarkdownParser.expanderEnd(after: unclosed.lineRange(for: NSRange(location: 0, length: 0)), in: unclosed) == nil)
        let last = "::: details A" as NSString
        #expect(MarkdownParser.expanderEnd(after: NSRange(location: 0, length: last.length), in: last) == nil)
    }

    @Test func titlesCountsAndExportsUseTheSummary() {
        let body = "::: details 2026-10-26 14:05 · Idea\nThe **full** idea.\n:::"
        #expect(NoteText.title(of: body) == "2026-10-26 14:05 · Idea")
        #expect(NoteText.plainText(of: body) == "2026-10-26 14:05 · Idea\nThe full idea.")
        #expect(MarkdownExport.plainText(body) == "2026-10-26 14:05 · Idea\nThe full idea.")
        let html = MarkdownExport.html(body, standalone: false)
        #expect(html.contains("<details><summary>2026-10-26 14:05 · Idea</summary>\n<p>The <strong>full</strong> idea.</p>\n</details>"))
    }

    @Test func returnClosesAnOpenSummary() {
        let text = "::: details Idea" as NSString
        let r = MarkdownCommands.newline(text, selection: NSRange(location: text.length, length: 0))
        #expect(r?.edits.first?.replacement == "\n\n:::")
        #expect(r?.selection == NSRange(location: text.length + 1, length: 0))
        let closed = "::: details Idea\nbody\n:::" as NSString
        #expect(MarkdownCommands.newline(closed, selection: NSRange(location: 16, length: 0)) == nil)
    }
}

@Suite struct ExpanderStylerTests {
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

    // "::: details Idea\n" 0-16, "Line one\n" 17-25, "- item\n" 26-32, ":::\n" 33-36, "after" 37-41
    let text = "::: details Idea\nLine one\n- item\n:::\nafter"

    @Test func collapsedByDefault() {
        let (s, _) = styled(text)
        #expect(deco(s, 0)?.kind == .summary(collapsed: true))
        #expect(hidden(s, 0) && hidden(s, 11) && !hidden(s, 12))  // "::: details " hidden, summary shown
        #expect(s.attribute(.notesPrefixLen, at: 0, effectiveRange: nil) as? Int == 12)
        for loc in [17, 26, 33] {
            #expect(deco(s, loc)?.kind == .folded)
            #expect(hidden(s, loc))
        }
        #expect(!hidden(s, 25) && !hidden(s, 36))  // newlines stay line breaks
        let ps = s.attribute(.paragraphStyle, at: 17, effectiveRange: nil) as? NSParagraphStyle
        #expect((ps?.maximumLineHeight ?? 0) > 0 && (ps?.maximumLineHeight ?? 1) < 1)
        #expect(deco(s, 37)?.kind == .paragraph(empty: false))
        #expect(deco(s, 37)?.inDetails == false && !hidden(s, 37))
    }

    @Test func toggleOpensAndCloses() {
        let (s, st) = styled(text)
        #expect(st.toggleExpander(s, summaryAt: 0))
        #expect(deco(s, 0)?.kind == .summary(collapsed: false))
        #expect(deco(s, 17)?.kind == .paragraph(empty: false))
        #expect(deco(s, 17)?.inDetails == true && !hidden(s, 17))
        #expect(deco(s, 26)?.kind == .bullet(level: 0))
        #expect(deco(s, 33)?.kind == .detailsEnd(revealed: false))
        #expect(hidden(s, 33))
        let ps = s.attribute(.paragraphStyle, at: 17, effectiveRange: nil) as? NSParagraphStyle
        #expect(ps?.headIndent == NotesTheme().listIndent)
        #expect(deco(s, 37)?.inDetails == false)
        #expect(st.toggleExpander(s, summaryAt: 0))
        #expect(deco(s, 0)?.kind == .summary(collapsed: true))
        #expect(deco(s, 17)?.kind == .folded)
        #expect(!st.toggleExpander(s, summaryAt: 17))
    }

    @Test func selectionInsideOpensIt() {
        let (s, st) = styled(text, caret: 20)
        #expect(deco(s, 0)?.kind == .summary(collapsed: false))
        #expect(st.expanded.contains("Idea"))
        // a find match inside a collapsed one, after loading
        let (s2, st2) = styled(text)
        st2.selectionChanged(s2, to: NSRange(location: 17, length: 4))
        #expect(deco(s2, 0)?.kind == .summary(collapsed: false))
        #expect(deco(s2, 17)?.kind == .paragraph(empty: false))
    }

    @Test func collapsedExpanderRange() {
        let (s, _) = styled(text)
        let e = MarkdownStyler.collapsedExpander(at: 20, in: s)
        #expect(e?.summary == NSRange(location: 0, length: 17))
        #expect(e?.hidden == NSRange(location: 17, length: 19))  // through the closing ":::", not its newline
        #expect(MarkdownStyler.collapsedExpander(at: 16, in: s) == nil)
        #expect(MarkdownStyler.collapsedExpander(at: 37, in: s) == nil)
        let (end, _) = styled("::: details A\nx\n:::")
        #expect(MarkdownStyler.collapsedExpander(at: 19, in: end)?.hidden == NSRange(location: 14, length: 5))
    }

    @Test func unclosedSummaryHasNoBody() {
        let (s, st) = styled("::: details Idea\nnot inside\n")
        #expect(deco(s, 0)?.kind == .summary(collapsed: nil))
        #expect(deco(s, 17)?.kind == .paragraph(empty: false))
        #expect(deco(s, 17)?.inDetails == false)
        #expect(!st.toggleExpander(s, summaryAt: 0))
        // a stray ":::" is just text
        let (stray, _) = styled("a\n:::\nb")
        #expect(deco(stray, 2)?.kind == .paragraph(empty: false))
        #expect(!hidden(stray, 2))
    }

    @Test func notesWithoutExpandersAreUnchanged() {
        let plain = "# T\n- a\n```\n:::\n```\nx ::: y"
        let (s, _) = styled(plain)
        var loc = 0
        let ns = plain as NSString
        while loc < ns.length {
            let d = deco(s, loc)
            #expect(d?.inDetails == false && d?.foldAfter == nil)
            loc = NSMaxRange(ns.lineRange(for: NSRange(location: loc, length: 0)))
        }
        #expect(deco(s, 12)?.kind == .code)
    }

    /// Edits restyle the expander they affect: typing its closing line, editing its
    /// summary, removing the closing line.
    @Test func editsKeepTheExpanderConsistent() {
        let s = NSTextStorage(string: "::: details Idea\nbody\n")
        let st = MarkdownStyler()
        st.selectionChanged(s, to: NSRange(location: 22, length: 0))
        st.styleAll(s)
        #expect(deco(s, 0)?.kind == .summary(collapsed: nil))
        s.replaceCharacters(in: NSRange(location: 22, length: 0), with: ":::")
        st.didEdit(s, editedRange: NSRange(location: 22, length: 3))
        // closed with the caret inside: open
        #expect(deco(s, 0)?.kind == .summary(collapsed: false))
        #expect(deco(s, 17)?.inDetails == true)
        #expect(deco(s, 22)?.kind == .detailsEnd(revealed: true))
        // typing in the summary keeps it open although its text (the key) changes
        st.selectionChanged(s, to: NSRange(location: 16, length: 0))
        s.replaceCharacters(in: NSRange(location: 16, length: 0), with: "s")
        st.didEdit(s, editedRange: NSRange(location: 16, length: 1))
        #expect(deco(s, 0)?.kind == .summary(collapsed: false))
        #expect(st.expanded.contains("Ideas"))
        // removing the closing line: no body any more
        s.replaceCharacters(in: NSRange(location: 23, length: 3), with: "")
        st.didEdit(s, editedRange: NSRange(location: 23, length: 0))
        #expect(deco(s, 0)?.kind == .summary(collapsed: nil))
        #expect(deco(s, 18)?.inDetails == false)
    }
}

@Suite struct ThoughtCaptureTests {
    let date = Date(timeIntervalSince1970: 1_793_021_145) // 2026-10-26 13:25:45 UTC
    let utc = TimeZone(identifier: "UTC")!

    @Test func entryHasTimestampSummaryAndBody() {
        let e = ThoughtCapture.entry("  Add a capture mode to the transcribe shortcut that appends to a note.\n", at: date, timeZone: utc)
        #expect(e == "::: details 2026-10-26 13:25 · Add a capture mode to the…\nAdd a capture mode to the transcribe shortcut that appends to a note.\n:::")
        #expect(ThoughtCapture.entry("Short one", at: date, timeZone: utc) == "::: details 2026-10-26 13:25 · Short one\nShort one\n:::")
        #expect(ThoughtCapture.entry(" \n\n ", at: date) == nil)
        #expect(ThoughtCapture.timestamp(date, timeZone: TimeZone(identifier: "Europe/London")!) == "2026-10-26 13:25")
    }

    @Test func bodyIsCleaned() {
        #expect(ThoughtCapture.cleaned("a\r\n\r\n\r\nb\n\n") == "a\n\nb")
        #expect(ThoughtCapture.cleaned("a\n:::\n::: details x\nb") == "a\n\\:::\n\\::: details x\nb")
        #expect(ThoughtCapture.cleaned("look:\n```\ncode") == "look:\n```\ncode\n```")
        #expect(ThoughtCapture.summary(of: "one\ntwo  three") == "one two three")
    }

    @Test func appendsAsSeparateEntries() {
        #expect(ThoughtCapture.append("E1", to: "") == "E1\n")
        #expect(ThoughtCapture.append("E1", to: "  \n") == "E1\n")
        #expect(ThoughtCapture.append("E2", to: "# Random snippets\nold text\n\n\n") == "# Random snippets\nold text\n\nE2\n")
    }

    /// Captures appended to an existing note parse back as one closed, collapsed expander
    /// each, leaving the note's other lines alone.
    @Test func appendedEntriesRenderAsExpanders() {
        var body = "# Random snippets\n- [ ] a task"
        for text in ["First idea with quite a few words in it", "Second:\n\n:::\nwith a stray fence"] {
            body = ThoughtCapture.append(ThoughtCapture.entry(text, at: date, timeZone: utc)!, to: body)
        }
        let s = NSTextStorage(string: body)
        let st = MarkdownStyler()
        st.selectionChanged(s, to: NSRange(location: 0, length: 0))
        st.styleAll(s)
        let ns = body as NSString
        var summaries: [BlockDecoration.Kind] = []
        var loc = 0
        while loc < ns.length {
            if let d = s.attribute(.notesBlock, at: loc, effectiveRange: nil) as? BlockDecoration, case .summary = d.kind { summaries.append(d.kind) }
            loc = NSMaxRange(ns.lineRange(for: NSRange(location: loc, length: 0)))
        }
        #expect(summaries == [.summary(collapsed: true), .summary(collapsed: true)])
        #expect(NoteText.title(of: body) == "Random snippets")
        #expect((s.attribute(.notesBlock, at: 18, effectiveRange: nil) as? BlockDecoration)?.kind == .task(level: 0, checked: false))
        #expect(body.hasSuffix("with a stray fence\nSecond:\n\n\\:::\nwith a stray fence\n:::\n"))
    }
}
