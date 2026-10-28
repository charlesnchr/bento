package com.charles.bento.ui.voice

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.RadioButtonUnchecked
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/**
 * The way past "restricted settings" (see [com.charles.bento.ui.settings.RestrictedSettings]) to
 * Bento dictation being on. Android doesn't let Bento see whether restricted settings are allowed
 * yet, so the guide moves on each time the user comes back from the screen a step opened, and the
 * one thing it can check, the service being on, ends it.
 */
object AccessibilityGuide {
    enum class Step { SeeNotice, AllowInAppInfo, TurnOn }

    /** The step to show on coming back from the screen opened for [opened], the service still off. */
    fun afterReturn(opened: Step) = when (opened) {
        Step.SeeNotice -> Step.AllowInAppInfo
        Step.AllowInAppInfo, Step.TurnOn -> Step.TurnOn
    }

    /**
     * Whether to offer the guide on coming back from Accessibility (opened directly) with the
     * service still off: only where restricted settings exist, and only once, as the user may just
     * have backed out.
     */
    fun offerAfterDirect(sdk: Int, offeredBefore: Boolean) = sdk >= 33 && !offeredBefore

    /** The checklist row's line: [needsGuide] when the install source or a failed try says the switch is greyed out. */
    fun summary(on: Boolean, needsGuide: Boolean) = when {
        on -> "Bento dictation is on"
        needsGuide -> "Greyed out? Tap for the 3 steps Android needs"
        else -> "Turn on Bento dictation in Accessibility"
    }

    /** ColorOS (OPPO, OnePlus, realme) files App info under App management. */
    fun appInfoPath(manufacturer: String) =
        if (manufacturer.lowercase() in setOf("oppo", "oneplus", "realme")) "Settings → Apps → App management → Bento"
        else "Settings → Apps → Bento"

    /** Android 15+ shows the permission controller's "App was denied access"; 13 and 14 showed "Restricted setting". */
    fun notice(sdk: Int) = if (sdk >= 35) "\"App was denied access\": tap Close" else "\"Restricted setting\": tap OK"

    fun text(step: Step, manufacturer: String, sdk: Int) = when (step) {
        Step.SeeNotice -> "In Accessibility, tap the greyed-out Bento dictation. Android says ${notice(sdk)}. " +
            "That's what makes the option in the next step appear."
        Step.AllowInAppInfo -> "In App info (${appInfoPath(manufacturer)}), tap ⋮ at the top right, then Allow restricted settings, " +
            "and confirm with your PIN or fingerprint."
        Step.TurnOn -> "Back in Accessibility, turn on Bento dictation."
    }

    fun button(step: Step) = if (step == Step.AllowInAppInfo) "Open App info" else "Open Accessibility"
}

/**
 * [step] is the current step; [retry] says the user came back from the last step with the
 * service still off. Tapping a step makes it current, to go through it again.
 */
@Composable
fun AccessibilityGuideDialog(
    step: AccessibilityGuide.Step, retry: Boolean,
    onSelect: (AccessibilityGuide.Step) -> Unit, onOpen: (AccessibilityGuide.Step) -> Unit, onDismiss: () -> Unit,
) {
    val manufacturer = android.os.Build.MANUFACTURER.orEmpty()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Turn on Bento dictation") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "Android greys out the switch for apps installed from a downloaded APK until you allow \"restricted settings\" " +
                        "for them. It isn't about signing. Updates through Bento keep it; on Android 13 and 14, opening a newer APK from a file manager brings the restriction back.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                AccessibilityGuide.Step.entries.forEach { s ->
                    val done = s.ordinal < step.ordinal
                    val current = s == step
                    Row(Modifier.fillMaxWidth().clickable { onSelect(s) }.padding(vertical = 6.dp), verticalAlignment = Alignment.Top) {
                        Icon(
                            if (done) Icons.Rounded.CheckCircle else Icons.Rounded.RadioButtonUnchecked, null, Modifier.size(20.dp),
                            tint = if (done || current) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.width(12.dp))
                        Text(
                            AccessibilityGuide.text(s, manufacturer, android.os.Build.VERSION.SDK_INT),
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = if (current) FontWeight.SemiBold else FontWeight.Normal,
                            color = if (current) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                val hint = when {
                    retry -> "Still greyed out? Tap step 1 and go through it again: Allow restricted settings only appears after the notice."
                    step == AccessibilityGuide.Step.AllowInAppInfo ->
                        "No ⋮, or no Allow restricted settings in it? Do step 1 again from here: only the notice from the Accessibility list unlocks it."
                    else -> null
                }
                hint?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        },
        confirmButton = { TextButton(onClick = { onOpen(step) }) { Text(AccessibilityGuide.button(step)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}
