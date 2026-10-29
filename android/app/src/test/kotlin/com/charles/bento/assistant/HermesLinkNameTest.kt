package com.charles.bento.assistant

import com.charles.bento.ui.settings.displayName
import kotlin.test.Test
import kotlin.test.assertEquals

/** A bento://hermes link's name is whatever its maker chose: the confirm dialog shows it plain and short. */
class HermesLinkNameTest {
    @Test fun namesArePlainAndShort() {
        assertEquals("homelab", displayName(" homelab "))
        assertEquals("your Mac Pay now", displayName("your Mac\n\n‮Pay now\u0000"))
        assertEquals(40, displayName("x".repeat(200)).length)
        assertEquals("", displayName("​\t"))
    }
}
