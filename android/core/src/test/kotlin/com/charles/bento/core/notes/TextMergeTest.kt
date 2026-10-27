package com.charles.bento.core.notes

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Tests/NotesTests/TextMergeTests.swift. */
class TextDiffTest {
    private fun roundTrips(a: String, b: String): List<TextEdit> {
        val e = TextMerge.edits(a, b)
        assertEquals(b, TextMerge.apply(e, a))
        return e
    }

    @Test fun identicalTextsHaveNoEdits() {
        assertTrue(TextMerge.edits("same", "same").isEmpty())
    }

    @Test fun oneInsertion() {
        assertEquals(listOf(TextEdit(6, 0, "brave ")), roundTrips("hello world", "hello brave world"))
    }

    @Test fun aRepeatedCharacterDoesntSplitAnInsertion() {
        // "A line\n" typed before an empty line diffs as one insertion, not "A line" + "\n"
        assertEquals(2, roundTrips("intro\n\nB line\nend\n", "intro\nA line\n\nB line too\nend\n").size)
    }

    @Test fun separateChangesStaySeparate() {
        // a change at the top and one at the bottom are two edits, not one big replacement
        val a = "# Plan\nfirst line\n" + "filler line\n".repeat(20) + "last line\n"
        val b = "# Plan\nfirst line!\n" + "filler line\n".repeat(20) + "very last line\n"
        val e = roundTrips(a, b)
        assertEquals(2, e.size)
        assertEquals(listOf("!", "very "), e.map { it.replacement })
    }

    @Test fun longNotesDiffByLineThenCharacter() {
        val lines = (0 until 3000).map { "line $it of a long note" }
        val changed = lines.toMutableList()
        changed[10] = "line 10 of a long, long note"
        changed[2900] = "line 2900 edited"
        val old = lines.joinToString("\n")
        val e = roundTrips(old, changed.joinToString("\n"))
        // only those two lines are touched, not everything between them
        val line10 = old.indexOf("line 10 of")
        val line2900 = old.indexOf("line 2900 of")
        assertTrue(e.first().range.location > line10 && e.first().range.end < line2900)
        assertTrue(e.last().range.location > line2900)
        assertTrue(e.size < 10)
    }

    @Test fun neverSplitsComposedCharacters() {
        assertEquals(listOf(TextEdit(1, 2, "😁")), roundTrips("a😀b", "a😁b"))
        val flags = roundTrips("x🇩🇰y", "x🇬🇧y")
        assertTrue(flags.size == 1 && flags[0].range.length == 4)
    }

    @Test fun canonicallyEquivalentTextKeepsItsBytes() {
        // "é" precomposed vs decomposed: equal for Swift's ==, different text for the editor
        assertTrue(roundTrips("caf\u00e9", "cafe\u0301").isNotEmpty())
    }
}

class TextMergeTest {
    /** Merges both ways round and checks both devices end up with the same text. */
    private fun merge(base: String, local: String, remote: String): String? {
        val a = TextMerge.merge(base, local, remote)
        val b = TextMerge.merge(base, remote, local)
        assertEquals(a, b)
        return a
    }

    @Test fun editsInDifferentPlacesBothSurvive() {
        assertEquals("# Plan\nintro, mine\n\ntheirs\nend\n", merge("# Plan\nintro\n\nend\n", "# Plan\nintro, mine\n\nend\n", "# Plan\nintro\n\ntheirs\nend\n"))
    }

    @Test fun oneSideUnchangedTakesTheOther() {
        assertEquals("base + theirs", merge("base", "base", "base + theirs"))
        assertEquals("base + mine", merge("base", "base + mine", "base"))
        assertEquals("same", merge("base", "same", "same"))
    }

    @Test fun deletionAndInsertionElsewhere() {
        assertEquals("one three four five", merge("one two three four", "one three four", "one two three four five"))
    }

    @Test fun typingAtTheSameSpotKeepsBoth() {
        assertEquals("list:\neggsmilk", merge("list:\n", "list:\nmilk", "list:\neggs"))
    }

    @Test fun twoRewritesOfTheSameTextDontMix() {
        // "base" rewritten differently on each device: a conflict, not "edited on AB"
        assertNull(merge("# Shared\nbase", "# Shared\nedited on A", "# Shared\nedited on B"))
    }

    @Test fun overlappingChangesDontMerge() {
        assertNotNull(merge("the quick brown fox", "the slow brown fox", "the quick red fox")) // separate words
        assertEquals("the dog", merge("the quick brown fox", "the fox", "the quick brown dog")) // next to each other
        assertNull(merge("the quick brown fox", "the fox", "the quick red fox")) // deleted text was edited
        assertNull(merge("abc", "aXc", "aYc"))
    }

    @Test fun combineIsSymmetric() {
        for ((x, y) in listOf("milk" to "eggs", "abc" to "xyz")) {
            assertEquals(TextMerge.combine(x, y), TextMerge.combine(y, x))
        }
    }

    @Test fun theSameTypingFromTwoBasesIsAConflict() {
        // one side's insertion starts or ends with the other's: never "abcabcdef"
        assertNull(TextMerge.combine("abc", "abcdef"))
        assertNull(TextMerge.combine("def", "abcdef"))
        assertNull(merge("x\n", "x\nabc", "x\nabcdef"))
    }
}

class SelectionMappingTest {
    private fun caret(at: Int) = TextRange(at, 0)

    private fun mapped(old: String, new: String, sel: TextRange): TextRange = TextMerge.map(sel, TextMerge.edits(old, new))

    @Test fun textBeforeTheCaretShiftsIt() {
        // caret after "world"; someone types at the start
        assertEquals(caret(15), mapped("hello world", "Oh, hello world", caret(11)))
        assertEquals(caret(5), mapped("hello world", "world", caret(11)))
    }

    @Test fun textAfterTheCaretLeavesIt() {
        assertEquals(caret(5), mapped("hello world", "hello world, again", caret(5)))
        assertEquals(caret(2), mapped("hello world", "hello", caret(2)))
    }

    @Test fun textTypedRightAtTheCaretGoesAfterIt() {
        // the other device appends where this caret is: the caret stays after "hello"
        assertEquals(caret(5), mapped("hello", "hello world", caret(5)))
    }

    @Test fun deletingAroundTheCaretMovesItToTheGap() {
        assertEquals(caret(6), mapped("alpha beta gamma", "alpha gamma", caret(8)))
    }

    @Test fun changesOnBothSidesOfTheCaret() {
        assertEquals(caret(13), mapped("first\nmiddle\nlast", "the first\nmiddle\nlast line", caret(9))) // inside "middle"
    }

    @Test fun selectionKeepsItsTextAndDoesntGrow() {
        val new = "please keep >this< selected"
        val m = mapped("keep this selected", new, TextRange(5, 4)) // "this"
        assertEquals("this", new.substring(m.location, m.end))
    }

    @Test fun selectionShrinksWhenPartlyDeleted() {
        assertEquals(TextRange(2, 2), mapped("abc def ghi", "abc ghi", TextRange(2, 4))) // "c de"
    }
}
