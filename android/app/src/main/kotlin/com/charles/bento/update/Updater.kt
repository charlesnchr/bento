package com.charles.bento.update

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.net.toUri
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.charles.bento.BuildConfig
import com.charles.bento.MainActivity
import com.charles.bento.R
import com.charles.bento.graph
import com.charles.bento.settings.Prefs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * Bento for Android updates itself from GitHub releases tagged `android-v<x.y.z>` (the
 * Mac app's releases are `v<x.y.z>`): a daily check, then "Install update" downloads the
 * APK and hands it to the package installer, which asks once to allow installs from Bento.
 */
class Updater(private val context: Context, private val http: OkHttpClient, private val prefs: Prefs) {
    data class Release(val version: String, val apkUrl: String, val size: Long, val notes: String, val page: String, val sha256: String?)

    sealed interface State {
        data object Idle : State
        data object Checking : State
        data object UpToDate : State
        data class Available(val release: Release) : State
        data class Downloading(val release: Release, val progress: Float) : State
        data class Installing(val release: Release) : State
        data class Failed(val message: String) : State
    }

    private val _state = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = _state.asStateFlow()

    suspend fun check(): Release? = withContext(Dispatchers.IO) {
        _state.value = State.Checking
        val release = runCatching { latest() }.getOrElse {
            _state.value = State.Failed(it.message ?: "Couldn't reach GitHub")
            return@withContext null
        }
        _state.value = if (release != null && newer(release.version, BuildConfig.VERSION_NAME.removeSuffix("-debug"))) {
            State.Available(release)
        } else {
            State.UpToDate
        }
        (state.value as? State.Available)?.release
    }

    private fun latest(): Release? {
        val req = Request.Builder().url("https://api.github.com/repos/$REPO/releases?per_page=30")
            .header("Accept", "application/vnd.github+json").header("User-Agent", "Bento-Android").build()
        val body = http.newCall(req).execute().use { r ->
            if (!r.isSuccessful) error("GitHub: HTTP ${r.code}")
            r.body.string()
        }
        return (Json.parseToJsonElement(body) as JsonArray).mapNotNull { it as? JsonObject }
            .filter { it["draft"]?.jsonPrimitive?.booleanOrNull != true && it["prerelease"]?.jsonPrimitive?.booleanOrNull != true }
            .mapNotNull { rel ->
                val tag = (rel["tag_name"] as? JsonPrimitive)?.content ?: return@mapNotNull null
                if (!tag.startsWith("android-v")) return@mapNotNull null
                val asset = (rel["assets"] as? JsonArray)?.mapNotNull { it as? JsonObject }
                    ?.firstOrNull { (it["name"] as? JsonPrimitive)?.content?.endsWith(".apk") == true } ?: return@mapNotNull null
                Release(
                    version = tag.removePrefix("android-v"),
                    apkUrl = (asset["browser_download_url"] as JsonPrimitive).content,
                    size = (asset["size"] as? JsonPrimitive)?.longOrNull ?: 0,
                    notes = (rel["body"] as? JsonPrimitive)?.content.orEmpty(),
                    page = (rel["html_url"] as? JsonPrimitive)?.content.orEmpty(),
                    // GitHub publishes each asset's digest ("sha256:…")
                    sha256 = (asset["digest"] as? JsonPrimitive)?.content?.removePrefix("sha256:"),
                )
            }
            .maxWithOrNull { a, b -> compareVersions(a.version, b.version) }
    }

    /** Downloads and installs; the system shows its confirmation. */
    suspend fun install(release: Release) = withContext(Dispatchers.IO) {
        if (!context.packageManager.canRequestPackageInstalls()) {
            context.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, "package:${context.packageName}".toUri())
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            _state.value = State.Available(release)
            return@withContext
        }
        try {
            val apk = File(context.cacheDir, "update-${release.version}.apk")
            download(release, apk)
            _state.value = State.Installing(release)
            val installer = context.packageManager.packageInstaller
            // A session install that doesn't claim a file source (PACKAGE_SOURCE_LOCAL_FILE or
            // _DOWNLOADED_FILE), unlike opening the APK from a browser or file manager, so updates
            // don't make Android restrict the accessibility switch (see RestrictedSettings).
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                setAppPackageName(context.packageName)
                setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            }
            val id = installer.createSession(params)
            installer.openSession(id).use { session ->
                session.openWrite("bento.apk", 0, apk.length()).use { out -> apk.inputStream().use { it.copyTo(out) }; session.fsync(out) }
                val status = PendingIntent.getBroadcast(
                    context, id, Intent(context, InstallResultReceiver::class.java),
                    PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                )
                session.commit(status.intentSender)
            }
        } catch (e: Exception) {
            _state.value = State.Failed(e.message ?: "Update failed")
        }
    }

    private fun download(release: Release, to: File) {
        val req = Request.Builder().url(release.apkUrl).header("User-Agent", "Bento-Android").build()
        val digest = MessageDigest.getInstance("SHA-256")
        http.newBuilder().readTimeout(60, TimeUnit.SECONDS).build().newCall(req).execute().use { r ->
            if (!r.isSuccessful) error("Download failed: HTTP ${r.code}")
            val total = r.body.contentLength().takeIf { it > 0 } ?: release.size
            to.outputStream().use { out ->
                val buf = ByteArray(64 * 1024)
                var done = 0L
                r.body.byteStream().use { input ->
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        digest.update(buf, 0, n)
                        done += n
                        if (total > 0) _state.value = State.Downloading(release, done.toFloat() / total)
                    }
                }
            }
        }
        val hex = digest.digest().joinToString("") { "%02x".format(it) }
        if (release.sha256 != null && !release.sha256.equals(hex, ignoreCase = true)) {
            to.delete()
            error("The download is damaged (checksum mismatch)")
        }
    }

    fun notifyAvailable(release: Release) {
        if (prefs.skippedVersion.value == release.version) return
        val nm = context.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Updates", NotificationManager.IMPORTANCE_DEFAULT))
        }
        val open = PendingIntent.getActivity(
            context, 7, Intent(context, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN_UPDATES),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        nm.notify(
            NOTIFICATION_ID,
            NotificationCompat.Builder(context, CHANNEL).setSmallIcon(R.drawable.ic_stat_bento)
                .setContentTitle("Bento ${release.version} is available")
                .setContentText("Tap to install the update")
                .setContentIntent(open).setAutoCancel(true).build(),
        )
    }

    companion object {
        const val REPO = "charlesnchr/bento"
        private const val CHANNEL = "updates"
        private const val NOTIFICATION_ID = 51

        fun compareVersions(a: String, b: String): Int {
            val pa = a.split(".").map { it.toIntOrNull() ?: 0 }
            val pb = b.split(".").map { it.toIntOrNull() ?: 0 }
            for (i in 0 until maxOf(pa.size, pb.size)) {
                val d = pa.getOrElse(i) { 0 }.compareTo(pb.getOrElse(i) { 0 })
                if (d != 0) return d
            }
            return 0
        }

        fun newer(candidate: String, current: String) = compareVersions(candidate, current) > 0

        fun schedule(context: Context) {
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                "update-check", ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<UpdateWorker>(1, TimeUnit.DAYS)
                    .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.UNMETERED).build()).build(),
            )
        }
    }
}

class UpdateWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val g = applicationContext.graph
        if (!g.prefs.autoUpdateCheck.value) return Result.success()
        g.updater.check()?.let(g.updater::notifyAvailable)
        return Result.success()
    }
}

/** The installer's answer: asks the user to confirm when it must, reports failures. */
class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: return
                context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            PackageInstaller.STATUS_SUCCESS -> {}
            else -> {
                val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "Installation failed"
                android.widget.Toast.makeText(context, msg, android.widget.Toast.LENGTH_LONG).show()
            }
        }
    }
}
