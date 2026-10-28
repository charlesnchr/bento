package com.charles.bento.ui.settings

import android.Manifest
import android.app.StatusBarManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.view.inputmethod.InputMethodManager
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import com.charles.bento.R
import com.charles.bento.keyboard.BentoKeyboardService
import com.charles.bento.voice.BentoAccessibilityService
import com.charles.bento.voice.DictateTileService

/** The system switches Bento's dictation needs, and where to flip them. */
object Setup {
    fun hasMic(c: Context) = ContextCompat.checkSelfPermission(c, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    fun hasNotifications(c: Context) = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun accessibilityComponent(c: Context) = ComponentName(c, BentoAccessibilityService::class.java)

    fun accessibilityEnabled(c: Context): Boolean {
        val enabled = Settings.Secure.getString(c.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
        val me = accessibilityComponent(c)
        return enabled.split(':').any { ComponentName.unflattenFromString(it) == me }
    }

    /** Straight to Bento's switch where the system allows it, else the accessibility list. */
    fun openAccessibility(c: Context) {
        val details = Intent("android.settings.ACCESSIBILITY_DETAILS_SETTINGS")
            .putExtra(Intent.EXTRA_COMPONENT_NAME, accessibilityComponent(c).flattenToString())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { c.startActivity(details) }.onFailure {
            c.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    /**
     * The accessibility list, freshly opened. While the switch is restricted this is the way in:
     * tapping the greyed entry here records that the notice was seen, which is what makes App info
     * offer "Allow restricted settings". The notice the details link above shows instead (over
     * Bento, on Android 16) doesn't.
     */
    fun openAccessibilityList(c: Context) = c.startActivity(
        Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
    )

    /**
     * App info, where "Allow restricted settings" (sideloaded apps) and battery options live. A
     * fresh task, as a Settings screen left open from before doesn't show that menu item.
     */
    fun openAppInfo(c: Context) = c.startActivity(
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, "package:${c.packageName}".toUri())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
    )

    private fun keyboardId(c: Context) = ComponentName(c, BentoKeyboardService::class.java).flattenToShortString()

    fun keyboardEnabled(c: Context): Boolean =
        c.getSystemService(InputMethodManager::class.java).enabledInputMethodList.any { it.packageName == c.packageName }

    fun keyboardSelected(c: Context): Boolean =
        Settings.Secure.getString(c.contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD)?.startsWith(c.packageName + "/") == true

    fun openKeyboards(c: Context) = c.startActivity(Intent(Settings.ACTION_INPUT_METHOD_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))

    fun pickKeyboard(c: Context) = c.getSystemService(InputMethodManager::class.java).showInputMethodPicker()

    fun ignoringBatteryOptimizations(c: Context) =
        c.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(c.packageName)

    @android.annotation.SuppressLint("BatteryLife") // a sync and dictation app the user installed for this
    fun requestBatteryExemption(c: Context) {
        runCatching {
            c.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, "package:${c.packageName}".toUri())
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }.onFailure { openAppInfo(c) }
    }

    /** Android 13+: offers to add the Dictate tile to Quick Settings in one tap. */
    fun requestTile(c: Context, onResult: (Int) -> Unit) {
        if (Build.VERSION.SDK_INT < 33) return
        c.getSystemService(StatusBarManager::class.java).requestAddTileService(
            ComponentName(c, DictateTileService::class.java), "Capture thought",
            Icon.createWithResource(c, R.drawable.ic_stat_mic), c.mainExecutor, onResult,
        )
    }

    /** Whether Bento keyboard's id string is known to the system (for diagnostics). */
    fun describeKeyboard(c: Context) = keyboardId(c)
}
