import Foundation
import Testing
@testable import Notes

@Suite struct TextDiffTests {
    func roundTrips(_ a: String, _ b: String) -> [TextEdit] {
        let e = TextMerge.edits(from: a, to: b)
        #expect(TextMerge.apply(e, to: a) == b)
        return e
    }

    @Test func identicalTextsHaveNoEdits() {
        #expect(TextMerge.edits(from: "same", to: "same").isEmpty)
    }

    @Test func oneInsertion() {
        #expect(roundTrips("hello world", "hello brave world") == [TextEdit(range: NSRange(location: 6, length: 0), replacement: "brave ")])
    }

    @Test func aRepeatedCharacterDoesntSplitAnInsertion() {
        // "A line\n" typed before an empty line diffs as one insertion, not "A line" + "\n"
        #expect(roundTrips("intro\n\nB line\nend\n", "intro\nA line\n\nB line too\nend\n").count == 2)
    }

    @Test func separateChangesStaySeparate() {
        // a change at the top and one at the bottom are two edits, not one big replacement
        let a = "# Plan\nfirst line\n" + String(repeating: "filler line\n", count: 20) + "last line\n"
        let b = "# Plan\nfirst line!\n" + String(repeating: "filler line\n", count: 20) + "very last line\n"
        let e = roundTrips(a, b)
        #expect(e.count == 2)
        #expect(e.map(\.replacement) == ["!", "very "])
    }

    @Test func longNotesDiffByLineThenCharacter() {
        let lines = (0..<3000).map { "line \($0) of a long note" }
        var changed = lines
        changed[10] = "line 10 of a long, long note"
        changed[2900] = "line 2900 edited"
        let old = lines.joined(separator: "\n")
        let e = roundTrips(old, changed.joined(separator: "\n"))
        // only those two lines are touched, not everything between them
        let line10 = (old as NSString).range(of: "line 10 of"), line2900 = (old as NSString).range(of: "line 2900 of")
        #expect(e.first!.range.location > line10.location && NSMaxRange(e.first!.range) < line2900.location)
        #expect(e.last!.range.location > line2900.location)
        #expect(e.count < 10)
    }

    @Test func neverSplitsComposedCharacters() {
        let e = roundTrips("a😀b", "a😁b")
        #expect(e == [TextEdit(range: NSRange(location: 1, length: 2), replacement: "😁")])
        let flags = roundTrips("x🇩🇰y", "x🇬🇧y")
        #expect(flags.count == 1 && flags[0].range.length == 4)
    }

    @Test func canonicallyEquivalentTextKeepsItsBytes() {
        // "é" precomposed vs decomposed: equal for Swift's ==, different text for the editor
        let e = roundTrips("caf\u{e9}", "cafe\u{301}")
        #expect(!e.isEmpty)
    }
}

@Suite struct TextMergeTests {
    /// Merges both ways round and checks both Macs end up with the same text.
    func merge(_ base: String, _ local: String, _ remote: String) -> String? {
        let a = TextMerge.merge(base: base, local: local, remote: remote)
        let b = TextMerge.merge(base: base, local: remote, remote: local)
        #expect(a == b)
        return a
    }

    @Test func editsInDifferentPlacesBothSurvive() {
        #expect(merge("# Plan\nintro\n\nend\n", "# Plan\nintro, mine\n\nend\n", "# Plan\nintro\n\ntheirs\nend\n")
            == "# Plan\nintro, mine\n\ntheirs\nend\n")
    }

    @Test func oneSideUnchangedTakesTheOther() {
        #expect(merge("base", "base", "base + theirs") == "base + theirs")
        #expect(merge("base", "base + mine", "base") == "base + mine")
        #expect(merge("base", "same", "same") == "same")
    }

    @Test func deletionAndInsertionElsewhere() {
        #expect(merge("one two three four", "one three four", "one two three four five") == "one three four five")
    }

    @Test func typingAtTheSameSpotKeepsBoth() {
        #expect(merge("list:\n", "list:\nmilk", "list:\neggs") == "list:\neggsmilk")
    }

    @Test func twoRewritesOfTheSameTextDontMix() {
        // "base" rewritten differently on each Mac: a conflict, not "edited on AB"
        #expect(merge("# Shared\nbase", "# Shared\nedited on A", "# Shared\nedited on B") == nil)
    }

    @Test func overlappingChangesDontMerge() {
        #expect(merge("the quick brown fox", "the slow brown fox", "the quick red fox") != nil) // separate words
        #expect(merge("the quick brown fox", "the fox", "the quick brown dog") == "the dog")   // next to each other
        #expect(merge("the quick brown fox", "the fox", "the quick red fox") == nil)           // deleted text was edited
        #expect(merge("abc", "aXc", "aYc") == nil)
    }

    @Test func combineIsSymmetric() {
        for (x, y) in [("milk", "eggs"), ("abc", "xyz")] {
            #expect(TextMerge.combine(x, y) == TextMerge.combine(y, x))
        }
    }

    @Test func theSameTypingFromTwoBasesIsAConflict() {
        // one side's insertion starts or ends with the other's: never "abcabcdef"
        #expect(TextMerge.combine("abc", "abcdef") == nil)
        #expect(TextMerge.combine("def", "abcdef") == nil)
        #expect(merge("x\n", "x\nabc", "x\nabcdef") == nil)
    }
}

@Suite struct SelectionMappingTests {
    func caret(_ at: Int) -> NSRange { NSRange(location: at, length: 0) }

    func mapped(_ old: String, _ new: String, _ sel: NSRange) -> NSRange {
        TextMerge.map(sel, through: TextMerge.edits(from: old, to: new))
    }

    @Test func textBeforeTheCaretShiftsIt() {
        // caret after "world"; someone types at the start
        #expect(mapped("hello world", "Oh, hello world", caret(11)) == caret(15))
        #expect(mapped("hello world", "world", caret(11)) == caret(5))
    }

    @Test func textAfterTheCaretLeavesIt() {
        #expect(mapped("hello world", "hello world, again", caret(5)) == caret(5))
        #expect(mapped("hello world", "hello", caret(2)) == caret(2))
    }

    @Test func textTypedRightAtTheCaretGoesAfterIt() {
        // the other Mac appends where this caret is: the caret stays after "hello"
        #expect(mapped("hello", "hello world", caret(5)) == caret(5))
    }

    @Test func deletingAroundTheCaretMovesItToTheGap() {
        #expect(mapped("alpha beta gamma", "alpha gamma", caret(8)) == caret(6))
    }

    @Test func changesOnBothSidesOfTheCaret() {
        let old = "first\nmiddle\nlast"
        let new = "the first\nmiddle\nlast line"
        #expect(mapped(old, new, caret(9)) == caret(13)) // inside "middle"
    }

    @Test func selectionKeepsItsTextAndDoesntGrow() {
        let old = "keep this selected"
        let sel = NSRange(location: 5, length: 4) // "this"
        let new = "please keep >this< selected"
        let m = mapped(old, new, sel)
        #expect((new as NSString).substring(with: m) == "this")
    }

    @Test func selectionShrinksWhenPartlyDeleted() {
        let m = mapped("abc def ghi", "abc ghi", NSRange(location: 2, length: 4)) // "c de"
        #expect(m == NSRange(location: 2, length: 2))
    }
}
