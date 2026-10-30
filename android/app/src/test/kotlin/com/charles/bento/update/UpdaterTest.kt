package com.charles.bento.update

import kotlinx.coroutines.flow.MutableStateFlow
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class UpdaterTest {
    @Test fun aNewVersionIsOfferedUntilSkippedOrPutOff() {
        assertTrue(Updater.offered("0.9.0", skipped = "", postponed = emptySet()))
        assertFalse(Updater.offered("0.9.0", skipped = "0.9.0", postponed = emptySet()))
        assertFalse(Updater.offered("0.9.0", skipped = "", postponed = setOf("0.9.0")))
        // skipping or putting off one version doesn't hide the next
        assertTrue(Updater.offered("0.9.1", skipped = "0.9.0", postponed = setOf("0.9.0")))
    }

    @Test fun versionsCompareNumerically() {
        assertTrue(Updater.newer("0.10.0", "0.9.9"))
        assertTrue(Updater.newer("1.0.1", "1.0"))
        assertFalse(Updater.newer("0.9.0", "0.9.0"))
        assertFalse(Updater.newer("0.8.9", "0.9.0"))
    }

    private val release = Updater.Release("0.9.0", "https://example.com/bento.apk", 1, "", "", null)

    @Test fun aCheckNeverRunsOverAnInstallOrAnotherCheck() {
        for (busy in listOf(Updater.State.Checking, Updater.State.Downloading(release, 0f), Updater.State.Installing(release))) {
            val state = MutableStateFlow<Updater.State>(busy)
            assertFalse(Updater.beginCheck(state))
            assertEquals(busy, state.value)
        }
        val state = MutableStateFlow<Updater.State>(Updater.State.Available(release))
        assertTrue(Updater.beginCheck(state))
        assertEquals(Updater.State.Checking, state.value)
    }

    @Test fun aCheckOvertakenByAnInstallIsDiscarded() {
        val state = MutableStateFlow<Updater.State>(Updater.State.Idle)
        assertTrue(Updater.beginCheck(state))
        // Update now while GitHub is still answering
        state.value = Updater.State.Downloading(release, 0f)
        assertFalse(Updater.finishCheck(state, Updater.State.Available(release)))
        assertEquals(Updater.State.Downloading(release, 0f), state.value)
        // otherwise the outcome lands
        state.value = Updater.State.UpToDate
        assertTrue(Updater.beginCheck(state))
        assertTrue(Updater.finishCheck(state, Updater.State.Available(release)))
        assertEquals(Updater.State.Available(release), state.value)
    }
}
