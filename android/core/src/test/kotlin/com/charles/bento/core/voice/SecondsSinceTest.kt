package com.charles.bento.core.voice

import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SecondsSinceTest {
    @Test fun distantPastDoesNotOverflow() {
        // MeetingRecorder starts its timers at Instant.MIN (Swift's distantPast)
        assertTrue(Instant.now().secondsSince(Instant.MIN) > 1e15)
    }

    @Test fun fractionalSeconds() {
        val a = Instant.ofEpochSecond(100, 250_000_000)
        val b = Instant.ofEpochSecond(98, 750_000_000)
        assertEquals(1.5, a.secondsSince(b), 1e-9)
        assertEquals(-1.5, b.secondsSince(a), 1e-9)
    }
}
