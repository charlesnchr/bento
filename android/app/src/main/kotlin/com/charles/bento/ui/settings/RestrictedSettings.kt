package com.charles.bento.ui.settings

import android.content.Context
import android.content.pm.PackageInstaller
import android.os.Build

/**
 * Android's "restricted settings" (13+): an app installed from a downloaded or local APK file
 * (a browser download, a file manager) can't have its accessibility service turned on, and the
 * entry is greyed out, until the user allows it in App info → ⋮ → Allow restricted settings.
 * Signing has nothing to do with it; the install source does.
 *
 * Android keeps the state in the app op `android:access_restricted_settings`: ERRORED when an
 * install from a file marked the app (13/14, updates included, so there opening a newer APK from a
 * file manager brings the restriction back even after it was allowed), IGNORED once the user has
 * tapped the greyed entry and seen the notice ("Restricted setting", or "App was denied access" on
 * 15+; only then does App info offer "Allow restricted settings"), ALLOWED once allowed. Android 15+ (enhanced confirmation)
 * leaves it DEFAULT and decides from the latest install's source each time, so there an update
 * opened from a file manager restricts the app too, while a session install like the
 * self-updater's (no file source) doesn't, unless the phone's maker lists trusted installers in
 * /system/etc/sysconfig/enhanced-confirmation.xml. An explicit state survives updates through Bento.
 *
 * Apps can't read that op (a restricted-read op: "verifyIncomingOp: uid … does not have any of
 * {MANAGE_APPOPS, …}"), so Bento only infers it from its install source, which it may read.
 */
object RestrictedSettings {
    @android.annotation.SuppressLint("InlinedApi") // constants, and only compared from 33 on
    fun likely(sdk: Int, packageSource: Int?) = sdk >= 33 &&
        (packageSource == PackageInstaller.PACKAGE_SOURCE_LOCAL_FILE || packageSource == PackageInstaller.PACKAGE_SOURCE_DOWNLOADED_FILE)

    fun likely(c: Context): Boolean {
        if (Build.VERSION.SDK_INT < 33) return false
        val source = runCatching { c.packageManager.getInstallSourceInfo(c.packageName).packageSource }.getOrNull()
        return likely(Build.VERSION.SDK_INT, source)
    }
}
