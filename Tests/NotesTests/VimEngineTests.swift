import Foundation
import Testing
@testable import Notes

/// A plain editor for the engine: text, a caret, undo, collapsed sections that behave like the
/// real editor's (carets skip hidden lines, edits must take them whole).
private final class Host: VimHost {
    var text: NSMutableString
    var sel: NSRange
    var folds = HeadingFolds()
    var undoStack: [(String, NSRange)] = []
    var redoStack: [(String, NSRange)] = []
    var clipboard: String?
    var escapes = 0
    var beeps = 0
    let engine = VimEngine()

    /// `marked`: the text with "|" where the caret is.
    init(_ marked: String) {
        let ns = marked as NSString
        let i = ns.range(of: "|").location
        text = NSMutableString(string: ns.replacingOccurrences(of: "|", with: ""))
        sel = NSRange(location: i == NSNotFound ? 0 : i, length: 0)
        engine.host = self
        engine.start()
    }

    var vimText: NSString { text.copy() as! NSString }
    var vimSelection: NSRange { sel }
    var vimFolds: HeadingFolds { folds }

    func vimSetSelection(_ range: NSRange, show: Int) {
        sel = folds.adjust(range, from: sel, in: text).range
        engine.selectionDidChange()
    }

    func vimApply(_ r: EditResult) -> Bool {
        guard r.edits.allSatisfy({ folds.allows($0.range, in: text) }) else { return false }
        undoStack.append((text as String, sel))
        redoStack = []
        for e in r.edits.sorted(by: { $0.range.location > $1.range.location }) {
            folds.map(e.range, length: (e.replacement as NSString).length)
            text.replaceCharacters(in: e.range, with: e.replacement)
        }
        folds.normalize(in: text, around: NSRange(location: 0, length: text.length))
        sel = r.selection
        return true
    }

    func vimUndo() -> Bool {
        guard let (old, s) = undoStack.popLast() else { return false }
        redoStack.append((text as String, sel))
        text.setString(old)
        sel = NSRange(location: s.location, length: 0)
        return true
    }

    func vimRedo() -> Bool {
        guard let (new, s) = redoStack.popLast() else { return false }
        undoStack.append((text as String, sel))
        text.setString(new)
        sel = NSRange(location: s.location, length: 0)
        return true
    }

    func vimContentStart(_ lineStart: Int) -> Int { lineStart }
    func vimScroll(_ scroll: VimScroll, count: Int, caret: Int) -> Int? { nil }
    func vimScreenLine(_ line: VimScreenLine) -> Int? { nil }

    func vimToggleHeading(_ lineStart: Int) -> Bool {
        if folds.isCollapsed(lineStart) {
            folds.expand(lineStart, entry: false)
        } else {
            let line = text.substring(with: text.lineRange(for: NSRange(location: lineStart, length: 0)))
            folds.collapse(lineStart, level: line.prefix { $0 == "#" }.count, in: text)
            if let f = folds.hidesCaret(at: sel.location, in: text) { sel = NSRange(location: HeadingFolds.lineEndBefore(f, in: text), length: 0) }
        }
        return true
    }

    func vimReveal(_ location: Int) {
        while let f = folds.hidesCaret(at: location, in: text) { folds.expand(f.heading, entry: false) }
    }

    var vimClipboard: String? {
        get { clipboard }
        set { clipboard = newValue }
    }

    func vimEscape() { escapes += 1 }
    func vimBeep() { beeps += 1 }

    func collapse(_ heading: String) {
        let at = text.range(of: heading).location
        folds.collapse(at, level: heading.prefix { $0 == "#" }.count, in: text)
    }

    /// Keys as typed: text in insert mode, commands otherwise.
    @discardableResult
    func keys(_ s: String) -> Host {
        for k in VimKey.parse(s) {
            if engine.mode == .insert {
                if k.isEscape {
                    engine.leaveInsert()
                } else if let c = k.char {
                    let str = String(c)
                    _ = vimApply(EditResult(edits: [TextEdit(range: sel, replacement: str)],
                                            selection: NSRange(location: sel.location + (str as NSString).length, length: 0)))
                } else if k.special == .enter {
                    _ = vimApply(EditResult(edits: [TextEdit(range: sel, replacement: "\n")], selection: NSRange(location: sel.location + 1, length: 0)))
                }
            } else {
                engine.handle(k)
            }
        }
        return self
    }

    /// The text with "|" at the caret, or [ ] around a selection.
    var state: String {
        let s = NSMutableString(string: text)
        if sel.length > 0 {
            s.insert("]", at: NSMaxRange(sel))
            s.insert("[", at: sel.location)
        } else {
            s.insert("|", at: sel.location)
        }
        return s as String
    }
}

private func vim(_ marked: String, _ keys: String) -> String { Host(marked).keys(keys).state }

@Suite struct VimMotionTests {
    @Test func charactersAndLines() {
        #expect(vim("|abc", "l") == "a|bc")
        #expect(vim("|abc", "3l") == "ab|c")
        #expect(vim("|abc", "9l") == "ab|c")
        #expect(vim("ab|c", "h") == "a|bc")
        #expect(vim("|abc\ndef", "j") == "abc\n|def")
        #expect(vim("abc\nd|ef", "k") == "a|bc\ndef")
        #expect(vim("|a\nb\nc\nd", "2j") == "a\nb\n|c\nd")
        #expect(vim("|a\nb", "<Down><Right>") == "a\n|b")
    }

    @Test func verticalMotionsRememberTheColumn() {
        #expect(vim("abc|d\nx\nabcd", "jj") == "abcd\nx\nabc|d")
        #expect(vim("a|b\nabcdef", "$k") == "a|b\nabcdef")
        #expect(vim("a|b\nabcdef", "$j") == "ab\nabcde|f")
    }

    @Test func words() {
        #expect(vim("|one two three", "w") == "one |two three")
        #expect(vim("|one two three", "2w") == "one two |three")
        #expect(vim("|one two", "e") == "on|e two")
        #expect(vim("one two |three", "b") == "one |two three")
        #expect(vim("one two |three", "ge") == "one tw|o three")
        #expect(vim("|foo.bar baz", "w") == "foo|.bar baz")
        #expect(vim("|foo.bar baz", "W") == "foo.bar |baz")
        #expect(vim("|foo.bar baz", "E") == "foo.ba|r baz")
        #expect(vim("foo.bar |baz", "B") == "|foo.bar baz")
        // an empty line is a word
        #expect(vim("|a\n\nb", "w") == "a\n|\nb")
        #expect(vim("a\n\n|b", "b") == "a\n|\nb")
    }

    @Test func lineStartAndEnd() {
        #expect(vim("  ab|c", "0") == "|  abc")
        #expect(vim("  ab|c", "^") == "  |abc")
        #expect(vim("|abc  ", "$") == "abc | ")
        #expect(vim("|abc  ", "g_") == "ab|c  ")
        #expect(vim("|a\nb\nc", "G") == "a\nb\n|c")
        #expect(vim("a\nb\n|c", "gg") == "|a\nb\nc")
        #expect(vim("|a\n  b\nc", "2G") == "a\n  |b\nc")
    }

    @Test func findCharacters() {
        #expect(vim("|a,b,c", "f,") == "a|,b,c")
        #expect(vim("|a,b,c", "f,;") == "a,b|,c")
        #expect(vim("|a,b,c", "f,;,") == "a|,b,c")
        #expect(vim("|ab,c", "t,") == "a|b,c")
        #expect(vim("|a,b,c", "t,;") == "a,|b,c")
        #expect(vim("a,b,|c", "F,") == "a,b|,c")
        #expect(vim("a,b,|c", "T,") == "a,b,|c")
        #expect(vim("|a,b,c", "2f,") == "a,b|,c")
        #expect(vim("|abc", "fz") == "|abc")
    }

    @Test func paragraphsAndBrackets() {
        let text = "a\nb\n\nc\n\nd"
        #expect(vim("|" + text, "}") == "a\nb\n|\nc\n\nd")
        #expect(vim("|" + text, "2}") == "a\nb\n\nc\n|\nd")
        #expect(vim("|" + text, "3}") == "a\nb\n\nc\n\n|d")
        #expect(vim("a\nb\n\nc\n\n|d", "{") == "a\nb\n\nc\n|\nd")
        #expect(vim("|(a [b] c)", "%") == "(a [b] c|)")
        #expect(vim("(a [b] c|)", "%") == "|(a [b] c)")
        #expect(vim("|x (a)", "%") == "x (a|)")
    }

    @Test func search() {
        #expect(vim("|foo bar baz", "/ba<CR>") == "foo |bar baz")
        #expect(vim("|foo bar baz", "/ba<CR>n") == "foo bar |baz")
        #expect(vim("|foo bar baz", "/ba<CR>nn") == "foo |bar baz") // wraps around
        #expect(vim("|foo bar baz", "/ba<CR>N") == "foo bar |baz")
        #expect(vim("|foo bar baz", "/BA<CR>") == "|foo bar baz") // a capital: case-sensitive
        #expect(vim("|foo Bar", "/bar<CR>") == "foo |Bar")
        #expect(vim("foo bar baz|", "?ba<CR>") == "foo bar |baz")
        #expect(vim("|foo food foo", "*") == "foo food |foo")
        #expect(vim("foo food |foo", "#") == "|foo food foo")
        #expect(vim("|foo", "/x<BS>o<CR>") == "f|oo")
    }
}

@Suite struct VimOperatorTests {
    @Test func deleteChangeYank() {
        #expect(vim("|one two three", "dw") == "|two three")
        #expect(vim("|one two three", "d2w") == "|three")
        #expect(vim("|one two three", "2dw") == "|three")
        #expect(vim("a |b\nc", "dw") == "a| \nc") // the last word of a line: not the line break
        #expect(vim("ab|cd", "D") == "a|b")
        #expect(vim("ab|cd", "d0") == "|cd")
        #expect(vim("|abc", "x") == "|bc")
        #expect(vim("|abc", "2x") == "|c")
        #expect(vim("ab|c", "X") == "a|c")
        #expect(vim("|ab,c", "dt,") == "|,c")
        #expect(vim("|ab,c", "df,") == "|c")
        #expect(vim("|one two", "cwX<Esc>") == "|X two")
        #expect(vim("fo|o bar", "cwX<Esc>") == "fo|X bar")
        #expect(vim("ab|cd", "CX<Esc>") == "ab|X")
        #expect(vim("|abc", "sX<Esc>") == "|Xbc")
        #expect(vim("|", "sX<Esc>") == "|X")
        #expect(vim("  |foo\nbar", "ccx<Esc>") == "  |x\nbar") // keeps the indent
        #expect(vim("|foo\nbar", "Sx<Esc>") == "|x\nbar")
        let h = Host("|one two")
        h.keys("yw")
        #expect(h.engine.register(nil) == VimRegister(text: "one ", linewise: false))
        #expect(h.state == "|one two")
    }

    @Test func lines() {
        #expect(vim("a\n|b\nc", "dd") == "a\n|c")
        #expect(vim("a\nb\n|c", "dd") == "a\n|b")
        #expect(vim("|a\nb\nc\nd", "3dd") == "|d")
        #expect(vim("|a\nb\nc", "dj") == "|c")
        #expect(vim("a\nb\n|c", "dk") == "|a")
        #expect(vim("|a\n  b", "yyjp") == "a\n  b\n|a")
        #expect(vim("|a\nb", "yyp") == "a\n|a\nb")
        #expect(vim("|a\nb", "yyP") == "|a\na\nb")
        #expect(vim("a\n|b", "yyp") == "a\nb\n|b")
        #expect(vim("|a\nb", "Yjp") == "a\nb\n|a")
        #expect(vim("|a\nb\n\nc", "d}") == "|\nc")
        #expect(vim("|a\nb\nc", "dG") == "|")
        #expect(vim("|a\nb\nc", "jdgg") == "|c")
    }

    @Test func putCharacters() {
        #expect(vim("|ab", "ylp") == "a|ab")
        #expect(vim("|ab", "ylP") == "|aab")
        #expect(vim("|ab", "yl3p") == "aaa|ab")
        #expect(vim("|one two", "dwP") == "one| two")
    }

    @Test func indentJoinReplaceCase() {
        #expect(vim("|foo", ">>") == "    |foo")
        #expect(vim("    |foo", "<<") == "|foo")
        #expect(vim("|a\nb", ">j") == "    |a\n    b")
        #expect(vim("|a\n\nb", "V2j>") == "    |a\n\n    b") // empty lines stay empty
        #expect(vim("|foo\n  bar", "J") == "foo| bar")
        #expect(vim("|a\nb\nc", "3J") == "a b| c")
        #expect(vim("|foo\n  bar", "gJ") == "foo|  bar")
        #expect(vim("|a\n)", "J") == "a|)")
        #expect(vim("|abc", "rx") == "|xbc")
        #expect(vim("|abc", "3rx") == "xx|x")
        #expect(vim("|abc", "4rx") == "|abc")
        #expect(vim("|abc", "~") == "A|bc")
        #expect(vim("|abc def", "g~w") == "|ABC def")
        #expect(vim("a|bc def", "gUiw") == "|ABC def")
        #expect(vim("A|BC", "guu") == "a|bc")
        #expect(vim("A|bc", "g~~") == "a|BC")
    }

    @Test func textObjects() {
        #expect(vim("foo b|ar baz", "diw") == "foo | baz")
        #expect(vim("foo b|ar baz", "daw") == "foo |baz")
        #expect(vim("foo b|ar", "daw") == "fo|o") // no blanks after: the ones before
        #expect(vim("say \"he|llo\" now", "ci\"X<Esc>") == "say \"|X\" now")
        #expect(vim("say \"he|llo\" now", "da\"") == "say |now")
        #expect(vim("|say \"hi\"", "di\"") == "say \"|\"") // the first pair after the caret
        #expect(vim("f(a, |b)", "di(") == "f(|)")
        #expect(vim("f(a, |b)", "da)") == "|f")
        #expect(vim("f(a, (|b))", "di(") == "f(a, (|))")
        #expect(vim("f(a, (|b))", "2di(") == "f(|)")
        #expect(vim("[x |y]", "ci]z<Esc>") == "[|z]")
        #expect(vim("x {\n    |a\n    b\n}", "di{") == "x {\n|}")
        #expect(vim("x {\n    |a\n    b\n}", "ci{z<Esc>") == "x {\n    |z\n}")
        #expect(vim("a\nb\n\n|c\nd\n\ne", "dap") == "a\nb\n\n|e")
        #expect(vim("a\nb\n\n|c\nd\n\ne", "dip") == "a\nb\n\n|\ne")
        #expect(vim("|a\nb", "yip") == "|a\nb")
    }

    @Test func registers() {
        #expect(vim("|a\nb", "\"ayyj\"ap") == "a\nb\n|a")
        let h = Host("|a\nb\nc")
        h.keys("\"ayyj\"Ayy")
        #expect(h.engine.register("a") == VimRegister(text: "a\nb\n", linewise: true))
        h.keys("gg\"_dd")
        #expect(h.engine.register(nil) == VimRegister(text: "a\nb\n", linewise: true)) // the black hole keeps it
        h.keys("dd")
        #expect(h.engine.register("1") == VimRegister(text: "b\n", linewise: true))
        h.keys("yl")
        #expect(h.engine.register("0") == VimRegister(text: "c", linewise: false))
        h.keys("x")
        #expect(h.engine.register("-") == VimRegister(text: "c", linewise: false))
        #expect(h.engine.register("1") == VimRegister(text: "b\n", linewise: true))
        #expect(h.engine.register("0") == VimRegister(text: "c", linewise: false))

        let d = Host("|a\nb\nc")
        d.keys("dddd")
        #expect(d.engine.register("1")?.text == "b\n")
        #expect(d.engine.register("2")?.text == "a\n")

        let clip = Host("|one two")
        clip.keys("\"+yiw")
        #expect(clip.clipboard == "one")
        clip.clipboard = "X"
        clip.keys("\"+P")
        #expect(clip.state == "|Xone two")
        clip.clipboard = "line\n"
        clip.keys("\"*p")
        #expect(clip.state == "Xone two\n|line")
    }

    @Test func undoRedoAndRepeat() {
        #expect(vim("|one two", "dwu") == "|one two")
        #expect(vim("|one two", "dwu<C-r>") == "|two")
        #expect(vim("|one two", "dw2u") == "|one two")
        #expect(vim("|a b c d", "dw.") == "|c d")
        #expect(vim("|one two three four", "dw2.") == "|four")
        #expect(vim("|foo bar", "ciwX<Esc>w.") == "X |X")
        #expect(vim("|a\nb", "A!<Esc>j.") == "a!\nb|!")
        #expect(vim("|a", "ofoo<Esc>.") == "a\nfoo\nfo|o")
        #expect(vim("|abc abc", "x.") == "|c abc")
        #expect(vim("|a\nb\nc", "dd.") == "|c")
        #expect(vim("|foo bar", "ysiw)w.") == "(|(foo)) bar")
        #expect(vim("|ab", "yyp.") == "ab\nab\n|ab")
    }

    @Test func aChangeAndItsTypingUndoAsOne() {
        #expect(vim("|one two", "ciwXY<Esc>u") == "|one two")
        #expect(Host("|one two").keys("ciwXY<Esc>u<C-r>").text as String == "XY two")
        #expect(vim("|ab", "xiQR<Esc>u") == "|b")
        #expect(vim("|ab", "xiQR<Esc>uu") == "|ab")
        #expect(vim("|a", "oxy<Esc>u") == "|a")
        #expect(vim("|a", "A!<Esc>3.") == "a!!!|!")
    }

    @Test func everyChangeUndoesAsOne() {
        func text(_ marked: String, _ keys: String) -> String { Host(marked).keys(keys).text as String }
        #expect(text("|one two", "ciwA<Esc>wciwB<Esc>uu") == "one two")
        #expect(text("|one two", "ciwA<Esc>wciwB<Esc>uu<C-r>") == "A two")
        #expect(text("|one two", "ciwA<Esc>wciwB<Esc>uu<C-r><C-r>") == "A B")
        #expect(text("|ab", "ciwX<Esc>xPu") == "") // only P: the text matching an older change doesn't matter
        #expect(text("|ab", "ciwX<Esc>xPuuu") == "ab")
        #expect(text("|a b", "xiQ<Esc>ux") == "b") // a new change after an undo
    }

    @Test func visualChangesRepeat() {
        #expect(vim("|abc def ghi", "xveld.") == "| ghi")
        #expect(vim("|ab cd", "vlcX<Esc>w.") == "X |X")
        #expect(vim("|a\nb\nc", "Vd.") == "|c")
        #expect(vim("|ab cd ef", "vlU2w.") == "AB cd |EF")
        // over lines: the last line's column, within the line it lands on
        #expect(vim("|hello\nworld!\nab\nc\ndefghij", "vjedj.") == "!\n|defghij") // "c" is too short: through its break
        // characters, not UTF-16 units
        #expect(vim("|😀😀 abcd", "vldl.") == " |cd")
        #expect(vim("|e\u{301}a bc def", "vd.") == "| bc def")
        #expect(vim("|abc\nd\nxyz", "vlldj.") == "\n|xyz") // one line, too short: through its break
        #expect(vim("x|a\n12345\nzz\nq\nKEEP", "vj$hdj0.") == "x\n|KEEP")
    }

    @Test func insertStateDoesntSurviveTurningVimOff() {
        let h = Host("|ab cd")
        h.keys("3i")
        h.engine.start()
        h.keys("ciwZ<Esc>")
        #expect(h.text as String == "Z cd")
    }

    @Test func countedOpenLineContinuesTheList() {
        #expect(Host("|- a").keys("3ox<Esc>").text as String == "- a\n- x\n- x\n- x")
        #expect(Host("  |a").keys("2Ox<Esc>").text as String == "  x\n  x\n  a")
    }

    @Test func countsOnObjectsInsertsAndEnds() {
        #expect(vim("|one two three", "2diw") == "|two three")
        #expect(vim("|one two three", "2daw") == "|three")
        #expect(vim("|a\n\nb\n\nc", "2dap") == "|c")
        #expect(vim("|a\nb\n\nc\n\nd", "3dip") == "|\nd")
        #expect(vim("|one two three", "v2iwd") == "|two three")
        #expect(vim("|one\ntwo three", "2daw") == "|three") // past the line's end
        #expect(vim("|one\ntwo", "2diw") == "|two")
        #expect(vim("ab|c", "de") == "a|b")
        #expect(vim("ab|c", "ceX<Esc>") == "ab|X")
        #expect(vim("|abc", "3iX<Esc>") == "XX|Xabc")
        #expect(vim("|abc", "3aX<Esc>") == "aXX|Xbc")
        #expect(vim("|z", "2iab<Esc>") == "aba|bz")
        #expect(vim("|a", "2ox<Esc>") == "a\nx\n|x")
        #expect(vim("|z", "2iab<Esc>l.") == "abababa|bz")
    }

    @Test func insertPoints() {
        #expect(vim("a|bc", "iX<Esc>") == "a|Xbc")
        #expect(vim("a|bc", "aX<Esc>") == "ab|Xc")
        #expect(vim("  a|bc", "IX<Esc>") == "  |Xabc")
        #expect(vim("a|bc", "AX<Esc>") == "abc|X")
        #expect(vim("a|bc\nd", "oX<Esc>") == "abc\n|X\nd")
        #expect(vim("  a|bc", "oX<Esc>") == "  abc\n  |X")
        #expect(vim("a\nb|c", "OX<Esc>") == "a\n|X\nbc")
        #expect(vim("ab|c", "i<Esc>") == "a|bc")
        #expect(vim("|abc", "i<Esc>") == "|abc")
    }
}

@Suite struct VimVisualTests {
    @Test func charwise() {
        let h = Host("|abc def")
        h.keys("ve")
        #expect(h.state == "[abc] def")
        #expect(h.engine.mode == .visual)
        h.keys("y")
        #expect(h.engine.register(nil)?.text == "abc")
        #expect(h.state == "|abc def")
        #expect(h.engine.mode == .normal)
        #expect(vim("a|bc\ndef", "vjd") == "a|f")
        #expect(vim("a|bc\nd", "v$d") == "a|d") // $ takes the line break
        #expect(vim("foo b|ar baz", "viwd") == "foo | baz")
        #expect(vim("|abc", "vl~") == "|ABc")
        #expect(vim("|abc", "vlU") == "|ABc")
        #expect(vim("|ABC", "vlu") == "|abC")
        #expect(vim("|abc", "vlrx") == "|xxc")
        #expect(vim("|abc", "vlc-<Esc>") == "|-c")
        #expect(vim("ab|c", "vhho") == "[abc]")
    }

    @Test func linewise() {
        #expect(vim("|a\nb\nc", "Vjd") == "|c")
        #expect(vim("a\n|b\nc", "Vy") == "a\n|b\nc")
        #expect(vim("|a\nb", "yyjVp") == "a\n|a\n")
        #expect(vim("|a\nb\nc", "VjJ") == "a| b\nc")
        #expect(vim("|a\nb", "Vj>") == "    |a\n    b")
        #expect(vim("a\n\n|c\nd\n\ne", "vipd") == "a\n\n|\ne")
        #expect(vim("|a\nb", "Vjv") == "[a\nb]") // v switches to characters
    }

    @Test func reselectEscapeAndPut() {
        #expect(vim("|abc def", "ve<Esc>") == "ab|c def")
        let h = Host("|abc def")
        h.keys("vey")
        #expect(h.state == "|abc def")
        h.keys("gv")
        #expect(h.state == "[abc] def")
        h.keys("<Esc>wviwp")
        #expect(h.state == "abc ab|c")
        #expect(h.engine.register(nil)?.text == "def") // what it replaced
    }

    @Test func outsideSelectionsBecomeVisualMode() {
        let h = Host("|abcdef")
        h.vimSetSelection(NSRange(location: 1, length: 3), show: 1)
        #expect(h.engine.mode == .visual)
        h.keys("d")
        #expect(h.state == "a|ef")
        h.vimSetSelection(NSRange(location: 1, length: 1), show: 1)
        h.vimSetSelection(NSRange(location: 2, length: 0), show: 2)
        #expect(h.engine.mode == .normal)
    }
}

@Suite struct VimSurroundTests {
    @Test func add() {
        #expect(vim("|foo bar", "ysiw)") == "|(foo) bar")
        #expect(vim("|foo bar", "ysiw(") == "|( foo ) bar")
        #expect(vim("|foo bar", "ysiwb") == "|(foo) bar")
        #expect(vim("|foo bar", "ysiw\"") == "|\"foo\" bar")
        #expect(vim("|foo bar", "ysw*") == "|*foo* bar") // the blank after the word stays outside
        #expect(vim("|foo bar", "ys2w]") == "|[foo bar]")
        #expect(vim("|foo bar", "ysiw<") == "|<foo> bar")
        #expect(vim("  fo|o bar  ", "yss]") == "  |[foo bar]  ")
        #expect(vim("|foo", "ysiwq") == "|foo") // not a delimiter
    }

    @Test func deleteAndChange() {
        #expect(vim("f(|a)", "ds)") == "f|a")
        #expect(vim("f( |a )", "ds(") == "f|a")
        #expect(vim("x \"a|b\" y", "ds\"") == "x |ab y")
        #expect(vim("say \"h|i\"", "cs\"'") == "say |'hi'")
        #expect(vim("(|a)", "cs)]") == "|[a]")
        #expect(vim("(|a)", "cs)[") == "|[ a ]")
        #expect(vim("**b|old**", "ds*") == "*|bold*")
        #expect(vim("**b|old**", "ds*.") == "|bold")
        #expect(vim("|abc", "ds(") == "|abc")
    }

    @Test func visual() {
        #expect(vim("|abc", "vllS*") == "|*abc*")
        #expect(vim("|abc def", "veS)") == "|(abc) def")
        #expect(vim("|a\nb", "VS{") == "|{\na\n}\nb")
        #expect(vim("  |a\nb", "VS`") == "  |`\n  a\n  `\nb")
        #expect(vim("|a", "VS{") == "|{\na\n}")
    }
}

@Suite struct VimFoldTests {
    let text = "# A\na1\na2\n# B\nb1"

    fileprivate func folded(_ marked: String, _ heading: String = "# A") -> Host {
        let h = Host(marked)
        h.collapse(heading)
        return h
    }

    @Test func linesSkipACollapsedSection() {
        #expect(folded("|" + text).keys("j").state == "# A\na1\na2\n|# B\nb1")
        #expect(folded("# A\na1\na2\n|# B\nb1").keys("k").state == "|# A\na1\na2\n# B\nb1")
        #expect(folded("# |A\na1\na2\n# B\nb1").keys("w").state == "# A\na1\na2\n|# B\nb1")
        #expect(folded("# A\na1\na2\n|# B\nb1").keys("b").state == "# |A\na1\na2\n# B\nb1")
        // the last line hidden: G goes to its heading
        #expect(folded("|" + text, "# B").keys("G").state == "# A\na1\na2\n|# B\nb1")
    }

    @Test func lineOperatorsTakeTheWholeSection() {
        let h = folded("|" + text)
        h.keys("dd")
        #expect(h.state == "|# B\nb1")
        #expect(h.engine.register(nil) == VimRegister(text: "# A\na1\na2\n", linewise: true))
        h.keys("p")
        #expect(h.state == "# B\n|# A\na1\na2\nb1")
        #expect(folded("|" + text).keys("yyp").state == "# A\na1\na2\n|# A\na1\na2\n# B\nb1")
        #expect(folded("|" + text).keys("dj").state == "|b1")
        #expect(folded("|" + text).keys("Vd").state == "|# B\nb1")
    }

    @Test func hiddenTextIsNeverChangedPiecemeal() {
        // joining would take a hidden line: nothing happens
        let h = folded("|" + text)
        h.keys("J")
        #expect(h.text as String == text)
        #expect(h.beeps == 1)
        // case changes skip hidden lines
        let c = Host("|# a\nb1\n# c\nd")
        c.collapse("# a")
        c.keys("gUj")
        #expect(c.text as String == "# A\nb1\n# C\nd")
        #expect(c.folds.isCollapsed(0))
        // a word motion over a section takes it whole
        let w = folded("# |A\na1\na2\n# B\nb1")
        w.keys("d2w")
        #expect(w.state == "# |# B\nb1")
    }

    @Test func deletingTheLastLineAfterACollapsedSection() {
        let h = Host("|# A\na1\n# B")
        h.collapse("# A")
        h.keys("Gdd")
        #expect(h.state == "# A\na1\n|") // the section's last line break is hidden: an empty line stays
        #expect(h.beeps == 0)
        #expect(h.engine.register(nil) == VimRegister(text: "# B\n", linewise: true))
    }

    @Test func zCommandsCollapseAndOpenHeadings() {
        let h = Host("# A\na|1\na2\n# B\nb1")
        h.keys("zc")
        #expect(h.folds.isCollapsed(0))
        #expect(h.state == "# |A\na1\na2\n# B\nb1")
        h.keys("za")
        #expect(!h.folds.isCollapsed(0))
        h.keys("zo")
        #expect(h.beeps == 1)
        h.keys("za")
        #expect(h.folds.isCollapsed(0))
    }

    @Test func searchOpensTheSection() {
        let h = folded("|" + text)
        h.keys("/a2<CR>")
        #expect(!h.folds.isCollapsed(0))
        #expect(h.state == "# A\na1\n|a2\n# B\nb1")
    }
}

@Suite struct VimStateTests {
    @Test func escapeAndPendingKeys() {
        let h = Host("|abc")
        h.keys("2d")
        #expect(h.engine.pendingText == "2d")
        h.keys("<Esc>")
        #expect(h.engine.pendingText == "")
        #expect(h.escapes == 0)
        h.keys("<Esc>")
        #expect(h.escapes == 1) // nothing pending: the editor's own Escape
        h.keys("\"a")
        #expect(h.engine.pendingText == "\"a")
        h.keys("<C-c>")
        #expect(h.engine.pendingText == "")
        h.keys("v<Esc>")
        #expect(h.engine.mode == .normal)
        #expect(h.escapes == 1)
    }

    @Test func aSecondEscapeRightAfterLeavingInsertModeIsIgnored() {
        let h = Host("|abc")
        var now = Date()
        h.engine.clock = { now }
        h.keys("i<Esc><Esc>")
        #expect(h.escapes == 0)
        now += 1
        h.keys("<Esc>")
        #expect(h.escapes == 1)
        h.keys("v<Esc><Esc>")
        #expect(h.escapes == 1)
    }

    @Test func modes() {
        let h = Host("|abc")
        #expect(h.engine.mode == .normal)
        h.keys("i")
        #expect(h.engine.mode == .insert)
        h.keys("<Esc>V")
        #expect(h.engine.mode == .visualLine)
        h.keys("v")
        #expect(h.engine.mode == .visual)
        h.keys("v")
        #expect(h.engine.mode == .normal)
    }

    @Test func unknownKeysBeep() {
        let h = Host("|abc")
        h.keys("Q")
        #expect(h.beeps == 1)
        #expect(h.engine.pendingText == "")
        h.keys("dq")
        #expect(h.beeps == 2)
        #expect(h.state == "|abc")
    }

    @Test func emojiAndCombinedCharacters() {
        #expect(vim("|😀b", "l") == "😀|b")
        #expect(vim("|😀b", "x") == "|b")
        #expect(vim("a😀|b", "h") == "a|😀b")
        #expect(vim("|e\u{301}x", "x") == "|x")
    }

    @Test func longLinesStayFast() {
        let h = Host("|" + String(repeating: "-+ x.y ", count: 5000))
        let start = Date()
        h.keys("100w$100bdwu*n%f.;")
        #expect(Date().timeIntervalSince(start) < 2)
    }

    @Test func keyNotation() {
        #expect(VimKey.parse("d<C-d><Esc><lt>") == [VimKey("d"), VimKey("d", ctrl: true), VimKey(.escape), VimKey("<")])
        #expect(VimKey.parse("<x") == [VimKey("<"), VimKey("x")])
    }
}
