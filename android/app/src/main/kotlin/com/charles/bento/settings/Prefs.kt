package com.charles.bento.settings

import android.content.Context
import android.content.SharedPreferences
import android.provider.Settings
import android.os.Build
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * App settings (not secrets: those are in [SecretStore]). Each setting is a [Pref] whose
 * `flow` Compose screens collect and whose `value` services read; writes apply at once
 * everywhere in the process.
 */
class Prefs(context: Context) {
    private val sp: SharedPreferences = context.getSharedPreferences("bento", Context.MODE_PRIVATE)
    private val prefs = mutableMapOf<String, Pref<*>>()

    // Strong reference: SharedPreferences holds listeners weakly.
    private val changeListener = SharedPreferences.OnSharedPreferenceChangeListener { _, key -> key?.let { prefs[it]?.reload() } }

    init {
        sp.registerOnSharedPreferenceChangeListener(changeListener)
    }

    // Sync (paired with a Mac's "Pair Android Phone" code)
    val server = string("sync.server", "")
    val pairedWith = string("sync.pairedWith", "")
    val syncEnabled = bool("sync.enabled", true)
    /** The server this phone's documents and sync state belong to (kept when unpairing). */
    val syncedServer = string("sync.syncedServer", "")
    /** Pairing with another server: the documents are dropped at the next launch, before anything opens them. */
    val resetPending = bool("sync.resetPending", false)
    val deviceName = string("sync.deviceName", defaultDeviceName(context))

    // Appearance
    val theme = string("ui.theme", "system") // system | graphite | paper
    val notesGrid = bool("notes.grid", false)
    val todoView = string("todo.view", "today") // inbox | today | upcoming | project:<id> | label:<name>

    // Dictation
    val liveTranscription = bool("voice.live", true)
    /** Cleanup in the target app's tone, with its field and preceding text as context (the Mac's smart cleanup pass). */
    val toneMatching = bool("voice.toneMatching", false)
    val meetingSummary = bool("voice.meetingSummary", true)
    val cleanupModel = string("voice.cleanupModel", "gemini-3.5-flash-lite")
    val language = string("voice.language", "")
    val activeMode = string("voice.mode", "")
    val bubbleEnabled = bool("voice.bubble", true)
    val bubbleSize = int("voice.bubbleSize", 52) // dp
    val bubbleX = float("voice.bubbleX", -1f) // fraction of screen width; -1 = default corner
    val bubbleY = float("voice.bubbleY", -1f)
    val volumeHold = bool("voice.volumeHold", true)
    /** Key held for push-to-talk (KeyEvent keycode); Volume Down by default. */
    val holdKey = int("voice.holdKey", 25)
    val holdMillis = int("voice.holdMillis", 280)
    val haptics = bool("voice.haptics", true)
    val sounds = bool("voice.sounds", true)
    val audioRetentionDays = int("voice.audioRetentionDays", 14)
    /** Note that "Capture thought" appends to (note id; empty = ask). */
    val thoughtNote = string("voice.thoughtNote", "")
    val separateIcons = bool("ui.separateIcons", false)

    // Assistant (Hermes's API server; its token is in SecretStore)
    val hermesUrl = string("hermes.url", "")
    val hermesName = string("hermes.name", "")
    /** The conversation the Assistant tab shows (a Hermes session id; empty = a new chat). */
    val hermesSession = string("hermes.session", "")
    /** Conversations started on this phone, newest first, comma-separated: the history lists these. */
    val hermesConversations = string("hermes.conversations", "")
    /** Voice calls: "continuous" (open mic) or "tap" (tap to talk). */
    val hermesTalkMode = string("hermes.talkMode", "continuous")

    // Updates
    val autoUpdateCheck = bool("update.auto", true)
    val skippedVersion = string("update.skipped", "")

    // Onboarding
    val onboarded = bool("ui.onboarded", false)

    private fun string(key: String, def: String) = Pref(key, def, { sp.getString(key, def) ?: def }) { e, v -> e.putString(key, v) }.also { prefs[key] = it }
    private fun bool(key: String, def: Boolean) = Pref(key, def, { sp.getBoolean(key, def) }) { e, v -> e.putBoolean(key, v) }.also { prefs[key] = it }
    private fun int(key: String, def: Int) = Pref(key, def, { sp.getInt(key, def) }) { e, v -> e.putInt(key, v) }.also { prefs[key] = it }
    private fun float(key: String, def: Float) = Pref(key, def, { sp.getFloat(key, def) }) { e, v -> e.putFloat(key, v) }.also { prefs[key] = it }

    /** Free-form keys (widget configuration, per-note state). */
    fun getString(key: String): String? = sp.getString(key, null)
    fun putString(key: String, value: String?) = sp.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()

    /** Writes everything set so far to disk now (before the process exits). */
    fun flush() = sp.edit().commit()

    inner class Pref<T>(val key: String, val default: T, private val read: () -> T, private val write: (SharedPreferences.Editor, T) -> Unit) {
        private val state = MutableStateFlow(read())
        val flow: StateFlow<T> = state.asStateFlow()
        var value: T
            get() = state.value
            set(v) {
                state.value = v
                sp.edit().also { write(it, v) }.apply()
            }

        internal fun reload() { state.value = read() }
    }

    companion object {
        fun defaultDeviceName(context: Context): String =
            runCatching { Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull()
                ?.takeIf { it.isNotBlank() }
                ?: "${Build.MANUFACTURER.replaceFirstChar(Char::uppercase)} ${Build.MODEL}"
    }
}
