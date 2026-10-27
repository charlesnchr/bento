package com.charles.bento

import kotlin.test.Test
import kotlin.test.assertEquals

class SpokenTaskTest {
    @Test fun normalisesSpokenTimesAndFullStops() {
        assertEquals("Buy oat milk tomorrow at 5:00 pm", spokenTask("Buy oat milk tomorrow at 5:00 p.m."))
        assertEquals("Call mum at 9 am p1", spokenTask(" Call mum at 9 A.M. p1. "))
        assertEquals("Book the e.g. venue", spokenTask("Book the e.g. venue."))
    }
}
