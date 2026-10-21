import AppKit
import Testing
@testable import Notes

@Suite struct StylerTests {
    func styled(_ text: String, caret: Int? = nil) -> (NSTextStorage, MarkdownStyler) {
        let s = NSTextStorage(string: text)
        let st = MarkdownStyler()
        if let caret { st.selectionChanged(s, to: NSRange(location: caret, length: 0)) }
        st.styleAll(s)
        return (s, st)
    }

    func hidden(_ s: NSTextStorage) -> [NSRange] {
        var out: [NSRange] = []
        s.enumerateAttribute(.notesHidden, in: NSRange(location: 0, length: s.length)) { v, r, _ in if v != nil { out.append(r) } }
        return out
    }

    func deco(_ s: NSTextStorage, _ loc: Int) -> BlockDecoration.Kind? {
        (s.attribute(.notesBlock, at: loc, effectiveRange: nil) as? BlockDecoration)?.kind
    }

    @Test func blockPrefixesAreHiddenAndDecorated() {
        let (s, _) = styled("# Title\n- item\n- [x] done\n2. two\n> q\nplain", caret: 0)
        #expect(deco(s, 0) == .heading(level: 1, spaced: false))
        #expect(deco(s, 8) == .bullet(level: 0))
        #expect(deco(s, 15) == .task(level: 0, checked: true))
        #expect(deco(s, 26) == .ordered(level: 0, number: 2))
        #expect(deco(s, 33) == .quote(depth: 1))
        #expect(deco(s, 37) == .paragraph(empty: false))
        let h = hidden(s)
        #expect(h.contains(NSRange(location: 0, length: 2)))   // "# "
        #expect(h.contains(NSRange(location: 8, length: 2)))   // "- "
        #expect(h.contains(NSRange(location: 15, length: 6)))  // "- [x] "
        #expect(h.contains(NSRange(location: 26, length: 3)))  // "2. "
        #expect(h.contains(NSRange(location: 33, length: 2)))  // "> "
        #expect(s.attribute(.notesPrefixLen, at: 15, effectiveRange: nil) as? Int == 6)
        // heading font is larger than body text
        let hf = s.attribute(.font, at: 3, effectiveRange: nil) as! NSFont
        let bf = s.attribute(.font, at: 40, effectiveRange: nil) as! NSFont
        #expect(hf.pointSize > bf.pointSize)
    }

    @Test func orderedListsAreNumberedSequentially() {
        let (s, _) = styled("1. a\n1. b\n1. c\n\n5. d\n1. e")
        #expect(deco(s, 0) == .ordered(level: 0, number: 1))
        #expect(deco(s, 5) == .ordered(level: 0, number: 2))
        #expect(deco(s, 10) == .ordered(level: 0, number: 3))
        #expect(deco(s, 16) == .ordered(level: 0, number: 5))
        #expect(deco(s, 21) == .ordered(level: 0, number: 6))
    }

    @Test func inlineMarkersHideUnlessTouched() {
        let text = "a **bold** b"
        let (far, _) = styled(text, caret: 12)
        #expect(hidden(far) == [NSRange(location: 2, length: 2), NSRange(location: 8, length: 2)])
        let boldFont = far.attribute(.font, at: 5, effectiveRange: nil) as! NSFont
        let weight = (boldFont.fontDescriptor.object(forKey: .traits) as? [NSFontDescriptor.TraitKey: Any])?[.weight] as? CGFloat ?? 0
        #expect(weight >= NSFont.Weight.semibold.rawValue - 0.01)
        // caret inside the span reveals the markers
        let (near, _) = styled(text, caret: 5)
        #expect(hidden(near).isEmpty)
    }

    @Test func selectionChangeRestylesOnlyWhatChanged() {
        let s = NSTextStorage(string: "x **b** y\n~~s~~")
        let st = MarkdownStyler()
        st.styleAll(s)
        #expect(hidden(s).count == 4)
        st.selectionChanged(s, to: NSRange(location: 4, length: 0))
        #expect(hidden(s) == [NSRange(location: 10, length: 2), NSRange(location: 13, length: 2)])
        st.selectionChanged(s, to: NSRange(location: 15, length: 0))
        #expect(hidden(s) == [NSRange(location: 2, length: 2), NSRange(location: 5, length: 2)])
    }

    @Test func fencesPropagateAfterEdits() {
        let s = NSTextStorage(string: "a\n- b\nc")
        let st = MarkdownStyler()
        st.styleAll(s)
        #expect(deco(s, 2) == .bullet(level: 0))
        // insert an opening fence above: following lines become code
        s.replaceCharacters(in: NSRange(location: 0, length: 0), with: "```\n")
        st.didEdit(s, editedRange: NSRange(location: 0, length: 4))
        #expect(deco(s, 6) == .code)
        #expect(deco(s, 10) == .code)
        // remove it again: back to a list
        s.replaceCharacters(in: NSRange(location: 0, length: 4), with: "")
        st.didEdit(s, editedRange: NSRange(location: 0, length: 0))
        #expect(deco(s, 2) == .bullet(level: 0))
    }

    @Test func numberingUpdatesBelowAnEdit() {
        let s = NSTextStorage(string: "1. a\n1. b\n1. c")
        let st = MarkdownStyler()
        st.styleAll(s)
        #expect(deco(s, 10) == .ordered(level: 0, number: 3))
        // insert a new item at the top
        s.replaceCharacters(in: NSRange(location: 0, length: 0), with: "1. z\n")
        st.didEdit(s, editedRange: NSRange(location: 0, length: 5))
        #expect(deco(s, 15) == .ordered(level: 0, number: 4))
    }

    @Test func codeSpansGetPills() {
        let (s, _) = styled("use `x` now", caret: 11)
        #expect(s.attribute(.notesInlineCode, at: 4, effectiveRange: nil) != nil)
        #expect(s.attribute(.notesInlineCode, at: 5, effectiveRange: nil) != nil)
        #expect(s.attribute(.notesInlineCode, at: 8, effectiveRange: nil) == nil)
        // backticks are kept as thin padding, not hidden
        #expect(hidden(s).isEmpty)
    }

    @Test func linksCarryURL() {
        let (s, _) = styled("see [site](https://a.b) x", caret: 25)
        #expect(s.attribute(.notesLink, at: 6, effectiveRange: nil) as? String == "https://a.b")
        #expect(hidden(s) == [NSRange(location: 4, length: 1), NSRange(location: 9, length: 14)])
    }
}

@Suite struct StylerPerformance {
    @Test func longNotesStayFast() {
        var lines: [String] = []
        for i in 0..<3000 {
            switch i % 6 {
            case 0: lines.append("## Section \(i)")
            case 1: lines.append("- [ ] task **\(i)** with `code` and a [link](https://example.com/\(i))")
            case 2: lines.append("1. item \(i) _italic_ ~~strike~~")
            case 3: lines.append("Plain paragraph text number \(i) that is long enough to wrap in a narrow notes window.")
            case 4: lines.append("> quote \(i)")
            default: lines.append("    - nested \(i)")
            }
        }
        let s = NSTextStorage(string: lines.joined(separator: "\n"))
        let st = MarkdownStyler()
        let t0 = Date()
        st.styleAll(s)
        let full = Date().timeIntervalSince(t0)
        // a keystroke in the middle
        let mid = s.length / 2
        let t1 = Date()
        for k in 0..<50 {
            s.replaceCharacters(in: NSRange(location: mid + k, length: 0), with: "x")
            st.didEdit(s, editedRange: NSRange(location: mid + k, length: 1))
        }
        let perKey = Date().timeIntervalSince(t1) / 50
        print("styleAll \(s.length) chars: \(Int(full * 1000)) ms, per keystroke: \(String(format: "%.2f", perKey * 1000)) ms")
        #expect(perKey < 0.02)
        #expect(full < 3)
    }
}
