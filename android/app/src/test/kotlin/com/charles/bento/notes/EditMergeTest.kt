package com.charles.bento.notes

import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The editor and the notes module as two queues, the way they run: keystrokes reach the
 * module some time after they're typed, and changes from elsewhere reach the editor some
 * time after the module applied them. Whatever the interleaving, both end with the same
 * text, and text typed on either side survives.
 */
class EditMergeTest {
    private class Sim(start: String) {
        var stored = start // the module's text
        var local = start // the editor's text
        var synced = start // what the editor last handed over
        val toModule = ArrayDeque<Pair<String, String>>() // (base, body)
        val toEditor = ArrayDeque<Pair<String, String>>() // (body, before)
        val copies = mutableListOf<String>()

        fun type(change: (String) -> String) {
            val text = change(local)
            toModule.addLast(synced to text)
            synced = text
            local = text
        }

        fun moduleStep() {
            val (base, body) = toModule.removeFirst()
            stored = EditMerge.edit(stored, base, body) ?: body.also { copies += stored }
        }

        /** A change from elsewhere, applied on the module's thread between keystrokes. */
        fun remote(change: (String) -> String) {
            val before = stored
            stored = change(stored)
            toEditor.addLast(stored to before)
        }

        fun editorStep() {
            val (body, before) = toEditor.removeFirst()
            local = EditMerge.remote(local, before, body)
            synced = local
        }

        fun drain() {
            while (toModule.isNotEmpty() || toEditor.isNotEmpty()) {
                if (toModule.isNotEmpty()) moduleStep() else editorStep()
            }
        }
    }

    @Test
    fun keystrokesTypedWhileARemoteChangeIsOnItsWaySurvive() {
        val s = Sim("Hello\nworld")
        s.type { "$it!" }
        s.moduleStep()
        s.remote { it.replace("Hello", "Hi") } // the Mac edits the first line
        s.type { "$it!" } // typed before the editor heard about it
        s.moduleStep()
        s.editorStep()
        assertEquals("Hi\nworld!!", s.local)
        assertEquals(s.local, s.stored)
    }

    @Test
    fun aRemoteChangeLandingBeforeQueuedKeystrokesIsMergedNotOverwritten() {
        val s = Sim("one\ntwo")
        s.type { "$it a" }
        s.type { "$it b" }
        s.remote { "zero\n$it" } // before the module saw either keystroke
        s.drain()
        assertEquals("zero\none\ntwo a b", s.stored)
        assertEquals(s.stored, s.local)
    }

    @Test
    fun whenBothChangeTheSameTextTheTypingWinsAndTheOtherIsKept() {
        val s = Sim("Buy milk")
        s.remote { it.replace("milk", "oats") }
        s.type { it.replace("milk", "bread") } // the same word, before the editor heard
        s.drain()
        assertEquals("Buy bread", s.stored)
        assertEquals(s.stored, s.local)
        assertEquals(listOf("Buy oats"), s.copies)
    }

    @Test
    fun randomInterleavingsConverge() {
        repeat(300) { seed ->
            val rnd = Random(seed)
            val s = Sim("# Title\nmine:\ntheirs:")
            var typed = ""
            var theirs = ""
            repeat(40) {
                when (rnd.nextInt(4)) {
                    0 -> { val c = ('a' + rnd.nextInt(26)); typed += c; s.type { t -> t.replace("mine:", "mine:$c") } }
                    1 -> if (s.toModule.isNotEmpty()) s.moduleStep()
                    2 -> { val c = ('A' + rnd.nextInt(26)); theirs += c; s.remote { t -> t.replace("theirs:", "theirs:$c") } }
                    3 -> if (s.toEditor.isNotEmpty()) s.editorStep()
                }
            }
            s.drain()
            assertEquals(s.stored, s.local, "seed $seed")
            assertTrue(s.copies.isEmpty(), "seed $seed: edits on different lines never clash")
            assertTrue(s.stored.contains("mine:${typed.reversed()}"), "seed $seed: every keystroke kept: ${s.stored}")
            assertTrue(s.stored.contains("theirs:${theirs.reversed()}"), "seed $seed: every remote change kept: ${s.stored}")
        }
    }
}
