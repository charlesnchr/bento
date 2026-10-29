package com.charles.bento.widget

import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue

class WidgetActionsTest {
    /** Glance makes a tapped widget's callback from its class name: the no-argument constructor must exist. */
    @Test fun callbacksConstructLikeGlanceDoes() {
        listOf(ToggleTaskAction::class.java, ToggleChecklistAction::class.java).forEach { it.getDeclaredConstructor().newInstance() }
    }

    /** ...and survive R8 in release builds, which drops constructors nothing in the app calls. */
    @Test fun releaseKeepsCallbackConstructors() {
        val rules = File("proguard-rules.pro").readLines().map { it.trim() }
        assertTrue("-keep class * implements androidx.glance.appwidget.action.ActionCallback { <init>(); }" in rules)
    }
}
