package com.charles.bento.update

import kotlin.test.Test
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
}
