package com.charles.bento.ui.settings

import android.content.pm.PackageInstaller
import com.charles.bento.ui.voice.AccessibilityGuide
import com.charles.bento.ui.voice.AccessibilityGuide.Step
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class RestrictedSettingsTest {
    @Test fun fileInstallsAreLikelyRestricted() {
        assertTrue(RestrictedSettings.likely(36, PackageInstaller.PACKAGE_SOURCE_DOWNLOADED_FILE))
        assertTrue(RestrictedSettings.likely(33, PackageInstaller.PACKAGE_SOURCE_LOCAL_FILE))
        // adb, the self-updater's session (no source), a store
        assertFalse(RestrictedSettings.likely(36, PackageInstaller.PACKAGE_SOURCE_OTHER))
        assertFalse(RestrictedSettings.likely(36, PackageInstaller.PACKAGE_SOURCE_UNSPECIFIED))
        assertFalse(RestrictedSettings.likely(36, PackageInstaller.PACKAGE_SOURCE_STORE))
        assertFalse(RestrictedSettings.likely(36, null))
        // Android 12 has no restricted settings
        assertFalse(RestrictedSettings.likely(32, PackageInstaller.PACKAGE_SOURCE_DOWNLOADED_FILE))
    }

    @Test fun theGuideMovesOnWhenTheUserComesBack() {
        assertEquals(Step.AllowInAppInfo, AccessibilityGuide.afterReturn(Step.SeeNotice))
        assertEquals(Step.TurnOn, AccessibilityGuide.afterReturn(Step.AllowInAppInfo))
        assertEquals(Step.TurnOn, AccessibilityGuide.afterReturn(Step.TurnOn))
        assertEquals("Open App info", AccessibilityGuide.button(Step.AllowInAppInfo))
        assertEquals("Open Accessibility", AccessibilityGuide.button(Step.SeeNotice))
        assertEquals("Open Accessibility", AccessibilityGuide.button(Step.TurnOn))
    }

    @Test fun aFailedDirectTryOffersTheGuideOnceWhereItExists() {
        assertTrue(AccessibilityGuide.offerAfterDirect(36, offeredBefore = false))
        assertFalse(AccessibilityGuide.offerAfterDirect(36, offeredBefore = true))
        assertFalse(AccessibilityGuide.offerAfterDirect(32, offeredBefore = false)) // no restricted settings on 12
    }

    @Test fun theChecklistRowSaysWhatToDo() {
        assertEquals("Bento dictation is on", AccessibilityGuide.summary(on = true, needsGuide = true))
        assertTrue("Greyed out?" in AccessibilityGuide.summary(on = false, needsGuide = true))
        assertEquals("Turn on Bento dictation in Accessibility", AccessibilityGuide.summary(on = false, needsGuide = false))
    }

    @Test fun colorOsNamesAppManagement() {
        assertEquals("Settings → Apps → App management → Bento", AccessibilityGuide.appInfoPath("OPPO"))
        assertEquals("Settings → Apps → App management → Bento", AccessibilityGuide.appInfoPath("OnePlus"))
        assertEquals("Settings → Apps → Bento", AccessibilityGuide.appInfoPath("Google"))
        assertTrue("App management" in AccessibilityGuide.text(Step.AllowInAppInfo, "OPPO", 36))
    }

    @Test fun theNoticeIsNamedAsTheVersionShowsIt() {
        assertTrue("App was denied access" in AccessibilityGuide.text(Step.SeeNotice, "OPPO", 36))
        assertTrue("Restricted setting" in AccessibilityGuide.text(Step.SeeNotice, "Google", 33))
    }
}
