package com.charles.bento.core.assistant.live

import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CallEarconsTest {
    private fun samples(pcm: ByteArray) = IntArray(pcm.size / 2) { i -> ((pcm[2 * i + 1].toInt() shl 8) or (pcm[2 * i].toInt() and 0xff)).toShort().toInt() }
    private fun pcm(vararg s: Int) = ByteArray(s.size * 2).also { b -> s.forEachIndexed { i, v -> b[2 * i] = v.toByte(); b[2 * i + 1] = (v shr 8).toByte() } }

    @Test fun theTonesAreShortQuietAndDistinct() {
        val started = CallEarcons.pcm(Earcon.TaskStarted)
        val result = CallEarcons.pcm(Earcon.ResultArrived)
        for (tone in listOf(started, result)) {
            val s = samples(tone)
            val seconds = s.size.toDouble() / CallEarcons.RATE
            assertTrue(seconds in 0.05..0.3, "short: $seconds s")
            assertTrue(s.maxOf { abs(it) } <= CallEarcons.PEAK * Short.MAX_VALUE + 1, "quiet")
            assertTrue(s.maxOf { abs(it) } > CallEarcons.PEAK * Short.MAX_VALUE / 2, "but audible")
            // No click at either end.
            assertTrue(abs(s.first()) < 200 && abs(s.last()) < 200)
        }
        assertTrue(result.size > started.size, "the result's tone is the longer, two notes")
        assertContentEquals(started, CallEarcons.pcm(Earcon.TaskStarted))
    }

    @Test fun aToneMixesIntoSpeechAndClips() {
        val mixer = CueMixer()
        mixer.add(pcm(100, -100, 30_000))
        val speech = pcm(1, 2, 3_000, 4)
        mixer.mixInto(speech, 0, speech.size)
        assertEquals(listOf(101, -98, 32_767, 4), samples(speech).toList())
        assertFalse(mixer.playing)
    }

    @Test fun aToneCarriesOnAcrossSlicesAndPlaysAloneWhenThereIsNoSpeech() {
        val mixer = CueMixer()
        assertNull(mixer.next(4))
        mixer.add(pcm(1, 2, 3))
        mixer.add(pcm(7))
        assertEquals(listOf(1, 2), samples(mixer.next(4)!!).toList())
        val speech = pcm(10, 10, 10)
        mixer.mixInto(speech, 2, 4)
        assertEquals(listOf(10, 13, 17), samples(speech).toList(), "the rest of one tone, then the next, from the offset")
        assertFalse(mixer.playing)
        mixer.add(pcm(5))
        assertEquals(listOf(5, 0), samples(mixer.next(4)!!).toList(), "padded with silence")
        mixer.add(pcm(5))
        mixer.clear()
        assertNull(mixer.next(4))
    }

    @Test fun aToneAloneIsPaddedToFillTheTrack() {
        val mixer = CueMixer()
        assertNull(mixer.lone(4, 12))
        assertFalse(mixer.waiting(12))
        mixer.add(pcm(1, 2, 3))
        assertEquals(listOf(1, 2), samples(mixer.lone(4, 12)!!).toList())
        assertEquals(listOf(3, 0), samples(mixer.lone(4, 12)!!).toList())
        assertTrue(mixer.waiting(12), "silence follows until 12 bytes have gone")
        assertEquals(listOf(0, 0), samples(mixer.lone(4, 12)!!).toList())
        assertFalse(mixer.waiting(12))
        assertNull(mixer.lone(4, 12))
    }

    @Test fun aFlushMidToneFillsTheStoppedTrackAfresh() {
        val mixer = CueMixer()
        mixer.add(pcm(1, 2, 3, 4))
        mixer.lone(4, 12)
        // The user talked over Gemini: the track was flushed and stops until its buffer fills again.
        mixer.restart()
        assertEquals(listOf(3, 4), samples(mixer.lone(4, 12)!!).toList())
        assertNotNull(mixer.lone(4, 12))
        assertNotNull(mixer.lone(4, 12), "12 bytes from the flush, not from the tone's start")
        assertNull(mixer.lone(4, 12))
    }

    @Test fun speechEndsTheTonesPadding() {
        val mixer = CueMixer()
        mixer.add(pcm(1, 2))
        mixer.lone(4, 12)
        mixer.restart() // speech went to the track: it's playing
        assertFalse(mixer.waiting(12))
        assertNull(mixer.lone(4, 12))
    }
}

class TaskLabelTest {
    @Test fun fillerBeforeTheRequestGoes() {
        assertEquals("Run a terminal command", TaskLabel.short("Ask Hermes to run a terminal command"))
        assertEquals("Find me a good recipe for a vegetarian lasagna. With the full ingredient list",
                     TaskLabel.short("Now, get Hermes to find me a good recipe for a vegetarian lasagna. With the full ingredient list."))
        assertEquals("Check my calendar", TaskLabel.short("Can you ask Hermes to check my calendar?"))
        assertEquals("Book a table for two", TaskLabel.short("could you please get hermes to book a table for two, please"))
        assertEquals("Look up the weather", TaskLabel.short("Hermes, can you look up the weather"))
        assertEquals("Find my keys", TaskLabel.short("Hermes please find my keys"))
        assertEquals("Email Sam", TaskLabel.short("OK so I'd like Hermes to email Sam"))
        assertEquals("Find flights to Rome", TaskLabel.short("Please have Hermes find flights to Rome"))
        assertEquals("My calendar tomorrow", TaskLabel.short("Ask Hermes about my calendar tomorrow"))
        assertEquals("Book a taxi", TaskLabel.short("Tell Hermes to book a taxi"))
    }

    @Test fun aRequestWithoutFillerStaysAsSaid() {
        assertEquals("What's the weather in London", TaskLabel.short("What's the weather in London?"))
        assertEquals("Hermes's memory: what's in it", TaskLabel.short("Hermes's memory: what's in it"))
        assertEquals("Ask Hermes", TaskLabel.short("Ask Hermes"))
        assertEquals("Ask Hermes about", TaskLabel.short("Ask Hermes about"))
        assertEquals("Let Hermes know I'm running late", TaskLabel.short("Let Hermes know I'm running late."))
        assertEquals("Tell Hermes that the meeting moved", TaskLabel.short("Tell Hermes that the meeting moved"))
        assertEquals("Hermes", TaskLabel.short("  Hermes  "))
    }

    @Test fun elapsedTime() {
        assertEquals("0:00", TaskLabel.elapsed(-3))
        assertEquals("0:42", TaskLabel.elapsed(42))
        assertEquals("12:05", TaskLabel.elapsed(725))
        assertEquals("1:02:03", TaskLabel.elapsed(3723))
    }
}
