import Foundation
import Testing
@testable import Notes

// MARK: - Block parsing

@Suite struct BlockParsing {
    func kind(_ s: String, inCode: Bool = false) -> BlockKind { MarkdownParser.parseLine(s, inCode: inCode).kind }

    @Test func headings() {
        #expect(kind("# Title") == .heading(1))
        #expect(kind("## Sub") == .heading(2))
        #expect(kind("### Third") == .heading(3))
        #expect(kind("#nospace") == .paragraph)
        #expect(kind("#") == .paragraph)
        let p = MarkdownParser.parseLine("## Sub", inCode: false)
        #expect(p.prefixRange == NSRange(location: 0, length: 3))
        #expect(p.contentRange == NSRange(location: 3, length: 3))
    }

    @Test func lists() {
        #expect(kind("- item") == .bullet)
        #expect(kind("* item") == .bullet)
        #expect(kind("+ item") == .bullet)
        #expect(kind("-item") == .paragraph)
        #expect(kind("1. one") == .ordered(1))
        #expect(kind("12) twelve") == .ordered(12))
        #expect(kind("1.no") == .paragraph)
        #expect(kind("- [ ] todo") == .task(checked: false))
        #expect(kind("- [x] done") == .task(checked: true))
        #expect(kind("- [X] done") == .task(checked: true))
        #expect(kind("- [ ]") == .task(checked: false))
        #expect(kind("- [y] no") == .bullet)
        let nested = MarkdownParser.parseLine("    - child", inCode: false)
        #expect(nested.kind == .bullet)
        #expect(nested.level == 1)
        #expect(nested.prefixRange == NSRange(location: 0, length: 6))
        #expect(MarkdownParser.parseLine("        - grandchild", inCode: false).level == 2)
        #expect(MarkdownParser.parseLine("\t- tab child", inCode: false).level == 1)
        let task = MarkdownParser.parseLine("- [ ] todo", inCode: false)
        #expect(task.markerRange == NSRange(location: 2, length: 3))
        #expect(task.contentRange == NSRange(location: 6, length: 4))
    }

    @Test func quotesRulesFences() {
        #expect(kind("> quote") == .quote(depth: 1))
        #expect(kind("> > nested") == .quote(depth: 2))
        #expect(kind(">no space") == .quote(depth: 1))
        #expect(kind("---") == .rule)
        #expect(kind("***") == .rule)
        #expect(kind("___") == .rule)
        #expect(kind("- - -") == .rule)
        #expect(kind("--") == .paragraph)
        #expect(kind("```swift") == .fence(opening: true, lang: "swift"))
        #expect(kind("~~~") == .fence(opening: true, lang: ""))
        #expect(kind("```", inCode: true) == .fence(opening: false, lang: ""))
        #expect(kind("- not a list", inCode: true) == .code)
        #expect(kind("```js", inCode: true) == .code)
    }

    @Test func parseLinesTracksFences() {
        let text = "# T\n```\n- code\n```\n- list\n" as NSString
        let lines = MarkdownParser.parseLines(text)
        #expect(lines.map(\.line.kind) == [.heading(1), .fence(opening: true, lang: ""), .code, .fence(opening: false, lang: ""), .bullet, .paragraph])
        #expect(lines.last?.range == NSRange(location: text.length, length: 0))
        #expect(MarkdownParser.isInCode(text, lineStart: 8))
        #expect(!MarkdownParser.isInCode(text, lineStart: 19))
    }
}

// MARK: - Inline spans

@Suite struct InlineParsing {
    func spans(_ s: String) -> [InlineSpan] { MarkdownParser.inlineSpans(s as NSString) }

    @Test func emphasis() {
        let b = spans("a **bold** b")
        #expect(b.count == 1)
        #expect(b[0].kind == .bold)
        #expect(b[0].range == NSRange(location: 2, length: 8))
        #expect(b[0].contentRange == NSRange(location: 4, length: 4))
        #expect(b[0].markers == [NSRange(location: 2, length: 2), NSRange(location: 8, length: 2)])
        #expect(spans("an *italic* word").first?.kind == .italic)
        #expect(spans("an _italic_ word").first?.kind == .italic)
        #expect(spans("snake_case_name").isEmpty)
        #expect(spans("~~gone~~").first?.kind == .strike)
        #expect(spans("***both***").first?.kind == .boldItalic)
        #expect(spans("<u>under</u>").first?.kind == .underline)
        #expect(spans("2 * 3 * 4").isEmpty)
        #expect(spans("** not bold **").isEmpty)
    }

    @Test func nestedEmphasis() {
        let s = spans("**bold *it* bold**")
        #expect(s.map(\.kind) == [.bold, .italic])
    }

    @Test func codeSpansProtectContent() {
        let s = spans("use `**not bold**` here")
        #expect(s.count == 1)
        #expect(s[0].kind == .code)
        #expect(s[0].contentRange == NSRange(location: 5, length: 12))
        #expect(spans("``a ` b``").first?.kind == .code)
        #expect(spans("unclosed `code").isEmpty)
        // emphasis around a code span is fine
        #expect(spans("**a `b` c**").map(\.kind) == [.bold, .code])
    }

    @Test func links() {
        let s = spans("see [Raycast](https://raycast.com) now")
        #expect(s.count == 1)
        #expect(s[0].kind == .link(url: "https://raycast.com"))
        #expect(s[0].contentRange == NSRange(location: 5, length: 7))
        #expect(s[0].markers == [NSRange(location: 4, length: 1), NSRange(location: 12, length: 22)])
        let bare = spans("go to https://example.com/x, ok")
        #expect(bare.first?.kind == .autolink(url: "https://example.com/x"))
        #expect(bare.first?.markers.isEmpty == true)
        #expect(spans("<https://a.b/c>").first?.kind == .autolink(url: "https://a.b/c"))
        // URL inside link syntax is not a second link
        #expect(spans("[x](https://a.com)").count == 1)
        // underscores in URLs are not italics
        #expect(spans("https://a.com/x_y_z").map(\.kind) == [.autolink(url: "https://a.com/x_y_z")])
    }

    @Test func stripInline() {
        #expect(MarkdownParser.stripInline("**a** [b](c) `d`") == "a b d")
        #expect(NoteText.title(of: "\n\n## **Meeting** notes\nbody") == "Meeting notes")
        #expect(NoteText.title(of: "- [ ] buy milk") == "buy milk")
        #expect(NoteText.title(of: "```\ncode\n```") == "code")
        #expect(NoteText.title(of: "") == "")
    }

    @Test func counts() {
        #expect(NoteText.characterCount(of: "# Hi\n**ab**") == 4)
        #expect(NoteText.wordCount(of: "# Hello world\n- one two") == 4)
    }
}

// MARK: - Editing commands

@Suite struct Editing {
    /// Runs a command on text with the caret marked by "|" (or a selection by "[" and "]").
    func run(_ marked: String, _ cmd: (NSString, NSRange) -> EditResult?) -> String? {
        var s = marked
        var sel = NSRange(location: 0, length: 0)
        if let a = s.range(of: "["), let b = s.range(of: "]"), s.contains("[") && !s.contains("|") {
            let start = s.distance(from: s.startIndex, to: a.lowerBound)
            s.removeSubrange(a)
            let bb = s.range(of: "]")!
            let end = s.distance(from: s.startIndex, to: bb.lowerBound)
            s.removeSubrange(bb)
            sel = NSRange(location: start, length: end - start)
            _ = b
        } else if let c = s.range(of: "|") {
            sel = NSRange(location: (String(s[..<c.lowerBound]) as NSString).length, length: 0)
            s.removeSubrange(c)
        }
        guard let r = cmd(s as NSString, sel) else { return nil }
        let out = NSMutableString(string: r.apply(to: s))
        if r.selection.length == 0 {
            out.insert("|", at: r.selection.location)
        } else {
            out.insert("]", at: NSMaxRange(r.selection))
            out.insert("[", at: r.selection.location)
        }
        return out as String
    }

    @Test func listContinuation() {
        #expect(run("- one|") { MarkdownCommands.newline($0, selection: $1) } == "- one\n- |")
        #expect(run("* one|") { MarkdownCommands.newline($0, selection: $1) } == "* one\n* |")
        #expect(run("1. one|") { MarkdownCommands.newline($0, selection: $1) } == "1. one\n2. |")
        #expect(run("- [x] done|") { MarkdownCommands.newline($0, selection: $1) } == "- [x] done\n- [ ] |")
        #expect(run("> quote|") { MarkdownCommands.newline($0, selection: $1) } == "> quote\n> |")
        #expect(run("    - child|") { MarkdownCommands.newline($0, selection: $1) } == "    - child\n    - |")
        // split in the middle
        #expect(run("- ab|cd") { MarkdownCommands.newline($0, selection: $1) } == "- ab\n- |cd")
        // empty item ends the list
        #expect(run("- one\n- |") { MarkdownCommands.newline($0, selection: $1) } == "- one\n|")
        #expect(run("- [ ] |") { MarkdownCommands.newline($0, selection: $1) } == "|")
        // empty nested item outdents
        #expect(run("- a\n    - |") { MarkdownCommands.newline($0, selection: $1) } == "- a\n- |")
        // paragraphs and headings use the default behaviour
        #expect(run("plain|") { MarkdownCommands.newline($0, selection: $1) } == nil)
        #expect(run("# Head|") { MarkdownCommands.newline($0, selection: $1) } == nil)
    }

    @Test func codeBlockReturn() {
        #expect(run("```swift|") { MarkdownCommands.newline($0, selection: $1) } == "```swift\n|\n```")
        #expect(run("```\n  let a|\n```") { MarkdownCommands.newline($0, selection: $1) } == "```\n  let a\n  |\n```")
        // already closed: default
        #expect(run("```|\nx\n```") { MarkdownCommands.newline($0, selection: $1) } == nil)
    }

    @Test func indentOutdent() {
        #expect(run("- a\n- b|") { MarkdownCommands.indent($0, selection: $1, outdent: false) } == "- a\n    - b|")
        #expect(run("- a\n    - b|") { MarkdownCommands.indent($0, selection: $1, outdent: true) } == "- a\n- b|")
        #expect(run("plain|") { MarkdownCommands.indent($0, selection: $1, outdent: false) } == nil)
        #expect(run("[- a\n- b]") { MarkdownCommands.indent($0, selection: $1, outdent: false) } == "    [- a\n    - b]")
    }

    @Test func inlineToggles() {
        #expect(run("make [this] bold") { MarkdownCommands.toggleInline($0, selection: $1, format: .bold) } == "make **[this]** bold")
        #expect(run("make **[this]** bold") { MarkdownCommands.toggleInline($0, selection: $1, format: .bold) } == "make [this] bold")
        #expect(run("make [**this**] bold") { MarkdownCommands.toggleInline($0, selection: $1, format: .bold) } == "make [this] bold")
        #expect(run("wo|rd") { MarkdownCommands.toggleInline($0, selection: $1, format: .italic) } == "*wo|rd*")
        #expect(run("a | b") { MarkdownCommands.toggleInline($0, selection: $1, format: .code) } == "a `|` b")
        #expect(run("x **bo|ld** y") { MarkdownCommands.toggleInline($0, selection: $1, format: .bold) } == "x bo|ld y")
        // second ⌘B at the end of the span steps out of it
        #expect(run("x **bold|** y") { MarkdownCommands.toggleInline($0, selection: $1, format: .bold) } == "x **bold**| y")
        #expect(run("a `code|`") { MarkdownCommands.toggleInline($0, selection: $1, format: .code) } == "a `code`|")
        #expect(run("[ two words ]") { MarkdownCommands.toggleInline($0, selection: $1, format: .strike) } == " ~~[two words]~~ ")
        #expect(run("[u]") { MarkdownCommands.toggleInline($0, selection: $1, format: .underline) } == "<u>[u]</u>")
        #expect(run("- [a\n- b]") { MarkdownCommands.toggleInline($0, selection: $1, format: .bold) } == "- **[a**\n- **b]**")
    }

    @Test func blockFormats() {
        #expect(run("Title|") { MarkdownCommands.setBlock($0, selection: $1, format: .heading(1)) } == "# Title|")
        #expect(run("# Title|") { MarkdownCommands.setBlock($0, selection: $1, format: .heading(1)) } == "Title|")
        #expect(run("# Title|") { MarkdownCommands.setBlock($0, selection: $1, format: .heading(2)) } == "## Title|")
        #expect(run("[a\nb]") { MarkdownCommands.setBlock($0, selection: $1, format: .ordered) } == "1. [a\n2. b]")
        #expect(run("- item|") { MarkdownCommands.setBlock($0, selection: $1, format: .task) } == "- [ ] item|")
        #expect(run("- [ ] item|") { MarkdownCommands.setBlock($0, selection: $1, format: .task) } == "item|")
        #expect(run("    - item|") { MarkdownCommands.setBlock($0, selection: $1, format: .ordered) } == "    1. item|")
        #expect(run("quote|") { MarkdownCommands.setBlock($0, selection: $1, format: .quote) } == "> quote|")
        #expect(run("- x|") { MarkdownCommands.setBlock($0, selection: $1, format: .paragraph) } == "x|")
        #expect(run("let a|") { MarkdownCommands.setBlock($0, selection: $1, format: .codeBlock) } == "```\nlet a|\n```")
        #expect(run("```\nlet a|\n```") { MarkdownCommands.setBlock($0, selection: $1, format: .codeBlock) } == "let a|")
    }

    @Test func tasks() {
        #expect(run("- [ ] a|") { MarkdownCommands.toggleTasks($0, selection: $1) } == "- [x] a|")
        #expect(run("- [x] a|") { MarkdownCommands.toggleTasks($0, selection: $1) } == "- [ ] a|")
        #expect(run("plain|") { MarkdownCommands.toggleTasks($0, selection: $1) } == nil)
        #expect(run("- [ ] parent|\n    - [ ] kid\n    - [x] kid2\n- [ ] sibling") { MarkdownCommands.toggleTasks($0, selection: $1, cascade: true) }
                == "- [x] parent|\n    - [x] kid\n    - [x] kid2\n- [ ] sibling")
    }

    @Test func inputRules() {
        #expect(run("[]|") { MarkdownCommands.inputRule($0, selection: $1, typed: " ") } == "- [ ] |")
        #expect(run("[x]|") { MarkdownCommands.inputRule($0, selection: $1, typed: " ") } == "- [x] |")
        #expect(run("- []|") { MarkdownCommands.inputRule($0, selection: $1, typed: " ") } == "- [ ] |")
        #expect(run("    []|") { MarkdownCommands.inputRule($0, selection: $1, typed: " ") } == "    - [ ] |")
        #expect(run("```|") { MarkdownCommands.inputRule($0, selection: $1, typed: " ") } == "```\n|\n```")
        #expect(run("```py|") { MarkdownCommands.inputRule($0, selection: $1, typed: " ") } == "```py\n|\n```")
        #expect(run("--|") { MarkdownCommands.inputRule($0, selection: $1, typed: "-") } == "---\n|")
        #expect(run("a--|") { MarkdownCommands.inputRule($0, selection: $1, typed: "-") } == nil)
        #expect(run("hello|") { MarkdownCommands.inputRule($0, selection: $1, typed: " ") } == nil)
        #expect(run("```\n[]|\n```") { MarkdownCommands.inputRule($0, selection: $1, typed: " ") } == nil)
    }

    @Test func moveLines() {
        #expect(run("a\nb|\nc") { MarkdownCommands.moveLines($0, selection: $1, up: true) } == "b|\na\nc")
        #expect(run("a\nb|\nc") { MarkdownCommands.moveLines($0, selection: $1, up: false) } == "a\nc\nb|")
        #expect(run("a|\nb") { MarkdownCommands.moveLines($0, selection: $1, up: true) } == nil)
        #expect(run("a\nb|") { MarkdownCommands.moveLines($0, selection: $1, up: false) } == nil)
        #expect(run("- x|\n- y\n") { MarkdownCommands.moveLines($0, selection: $1, up: false) } == "- y\n- x|\n")
    }

    @Test func deletion() {
        #expect(run("- |item") { MarkdownCommands.backspace($0, selection: $1) } == "|item")
        #expect(run("## |Head") { MarkdownCommands.backspace($0, selection: $1) } == "|Head")
        #expect(run("plain\n|text") { MarkdownCommands.backspace($0, selection: $1) } == nil)
        #expect(run("one|\n- two") { MarkdownCommands.deleteForward($0, selection: $1) } == "one|two")
        #expect(run("one|\ntwo") { MarkdownCommands.deleteForward($0, selection: $1) } == nil)
    }

    @Test func caretSnapping() {
        let t = "para\n- item" as NSString
        // inside the hidden "- " prefix -> content start
        #expect(MarkdownCommands.snapCaret(t, proposed: 5, previous: 0) == 7)
        #expect(MarkdownCommands.snapCaret(t, proposed: 6, previous: 0) == 7)
        // moving left from the content start jumps to the previous line's end
        #expect(MarkdownCommands.snapCaret(t, proposed: 6, previous: 7) == 4)
        #expect(MarkdownCommands.snapCaret(t, proposed: 2, previous: 0) == 2)
    }

    @Test func links() {
        #expect(run("[site]") { MarkdownCommands.insertLink($0, selection: $1, url: "https://a.b") } == "[site](https://a.b)|")
        #expect(run("[site]") { MarkdownCommands.insertLink($0, selection: $1, url: nil) } == "[site](|)")
    }
}
