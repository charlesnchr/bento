package com.charles.bento.core.voicesync

import com.charles.bento.core.fielddoc.FieldDoc
import com.charles.bento.core.fielddoc.FieldDocCollectionSync
import com.charles.bento.core.fielddoc.FieldDocRepository
import com.charles.bento.core.json.JSONValue

/*
 * The `voice` collection: dictation settings shared with the Macs, as field-clock documents
 * exactly like todos (`{"type": …, "fields": {…}, "clocks": {…}}`, per-field merge,
 * tombstones; unknown fields and types are preserved).
 *
 * - `type: "entry"`: a personal-dictionary entry. Id: the entry's UUID, uppercase. Fields
 *   `term` (string, 1–60 characters), `misspelling` (string or null), `starred` (bool),
 *   `created_at` (ms).
 * - `type: "settings"`: a singleton, id `voice-settings`. Fields `customInstructions`
 *   (string), `customInstructionsEnabled` (bool), `cleanupEnabled` (bool).
 * - `type: "mode"`: Android dictation profiles (Macs keep them but ignore them). Fields
 *   `name`, `prompt` (extra instructions for the cleanup model), `order` (number),
 *   `language` (BCP-47 or null), `cleanup` (bool).
 *
 * Absent fields take the defaults below (the Mac's defaults for the settings).
 */

const val VOICE_COLLECTION = "voice"

/** Id of the settings singleton. */
const val VOICE_SETTINGS_ID = "voice-settings"

object VoiceKind {
    const val ENTRY = "entry"
    const val SETTINGS = "settings"
    const val MODE = "mode"
}

val FieldDoc.isEntry: Boolean get() = !deleted && type == VoiceKind.ENTRY
val FieldDoc.isVoiceSettings: Boolean get() = !deleted && type == VoiceKind.SETTINGS
val FieldDoc.isMode: Boolean get() = !deleted && type == VoiceKind.MODE

// Entries
val FieldDoc.term: String get() = fields["term"]?.string ?: ""
val FieldDoc.misspelling: String? get() = fields["misspelling"]?.string
val FieldDoc.starred: Boolean get() = fields["starred"]?.bool ?: false

/** The entry's `created_at` field (ms); the document's creation when absent. */
val FieldDoc.entryCreatedAt: Long get() = fields["created_at"]?.int64 ?: createdAt

fun FieldDoc.setTerm(s: String, at: Long? = null) = set("term", JSONValue.Str(s), at)
fun FieldDoc.setMisspelling(s: String?, at: Long? = null) = set("misspelling", s?.let { JSONValue.Str(it) } ?: JSONValue.Null, at)
fun FieldDoc.setStarred(b: Boolean, at: Long? = null) = set("starred", JSONValue.Bool(b), at)

// Settings
val FieldDoc.customInstructions: String get() = fields["customInstructions"]?.string ?: ""
val FieldDoc.customInstructionsEnabled: Boolean get() = fields["customInstructionsEnabled"]?.bool ?: false
val FieldDoc.cleanupEnabled: Boolean get() = fields["cleanupEnabled"]?.bool ?: true

fun FieldDoc.setCustomInstructions(s: String, at: Long? = null) = set("customInstructions", JSONValue.Str(s), at)
fun FieldDoc.setCustomInstructionsEnabled(b: Boolean, at: Long? = null) = set("customInstructionsEnabled", JSONValue.Bool(b), at)
fun FieldDoc.setCleanupEnabled(b: Boolean, at: Long? = null) = set("cleanupEnabled", JSONValue.Bool(b), at)

// Modes
val FieldDoc.modeName: String get() = fields["name"]?.string ?: ""
val FieldDoc.modePrompt: String get() = fields["prompt"]?.string ?: ""
val FieldDoc.modeOrder: Double get() = fields["order"]?.double ?: createdAt.toDouble()
val FieldDoc.modeLanguage: String? get() = fields["language"]?.string
val FieldDoc.modeCleanup: Boolean get() = fields["cleanup"]?.bool ?: true

fun FieldDoc.setModeName(s: String, at: Long? = null) = set("name", JSONValue.Str(s), at)
fun FieldDoc.setModePrompt(s: String, at: Long? = null) = set("prompt", JSONValue.Str(s), at)
fun FieldDoc.setModeOrder(o: Double, at: Long? = null) = set("order", JSONValue.Number(o), at)
fun FieldDoc.setModeLanguage(s: String?, at: Long? = null) = set("language", s?.let { JSONValue.Str(it) } ?: JSONValue.Null, at)
fun FieldDoc.setModeCleanup(b: Boolean, at: Long? = null) = set("cleanup", JSONValue.Bool(b), at)

/** A new dictionary entry with every field stamped (its id is new, so nothing can be overwritten). */
fun FieldDoc.Companion.newEntry(term: String, misspelling: String? = null, starred: Boolean = false, now: Long = FieldDoc.now()): FieldDoc {
    val d = FieldDoc(type = VoiceKind.ENTRY, createdAt = now)
    d.setTerm(term, now)
    d.setMisspelling(misspelling, now)
    d.setStarred(starred, now)
    d.set("created_at", JSONValue.Number(now.toDouble()), now)
    d.updatedAt = now
    return d
}

fun FieldDoc.Companion.newMode(
    name: String, prompt: String = "", order: Double, language: String? = null, cleanup: Boolean = true, now: Long = FieldDoc.now(),
): FieldDoc {
    val d = FieldDoc(type = VoiceKind.MODE, createdAt = now)
    d.setModeName(name, now)
    d.setModePrompt(prompt, now)
    d.setModeOrder(order, now)
    d.setModeLanguage(language, now)
    d.setModeCleanup(cleanup, now)
    d.updatedAt = now
    return d
}

/**
 * The settings singleton, new: no fields at all. Only fields the user changes get stamped,
 * so a fresh device never overrides settings made elsewhere with its defaults.
 */
fun FieldDoc.Companion.newVoiceSettings(now: Long = FieldDoc.now()): FieldDoc =
    FieldDoc(type = VoiceKind.SETTINGS, id = VOICE_SETTINGS_ID, createdAt = now)

/** A dictionary entry as the UI and the dictation pipeline see it. */
data class DictionaryEntry(
    val id: String,
    val term: String,
    val misspelling: String?,
    val starred: Boolean,
    /** ms since 1970. */
    val createdAt: Long,
) {
    companion object {
        fun of(d: FieldDoc) = DictionaryEntry(d.id, d.term, d.misspelling, d.starred, d.entryCreatedAt)
    }
}

data class VoiceSettings(
    val customInstructions: String = "",
    val customInstructionsEnabled: Boolean = false,
    val cleanupEnabled: Boolean = true,
) {
    /** What goes into the cleanup prompt (the Mac's `effectiveInstructions`). */
    val effectiveInstructions: String
        get() = if (customInstructionsEnabled) com.charles.bento.core.fielddoc.SwiftText.trimmingWhitespacesAndNewlines(customInstructions) else ""

    companion object {
        fun of(d: FieldDoc?) = if (d == null || !d.isVoiceSettings) VoiceSettings()
        else VoiceSettings(d.customInstructions, d.customInstructionsEnabled, d.cleanupEnabled)
    }
}

/** An Android dictation profile. */
data class VoiceMode(
    val id: String,
    val name: String,
    /** Extra instructions for the cleanup model. */
    val prompt: String,
    val order: Double,
    /** BCP-47 tag, or null for automatic. */
    val language: String?,
    val cleanup: Boolean,
) {
    companion object {
        fun of(d: FieldDoc) = VoiceMode(d.id, d.modeName, d.modePrompt, d.modeOrder, d.modeLanguage, d.modeCleanup)
    }
}

/** Label for sync errors: the term, "Voice settings", or the mode's name. */
fun voiceLabel(d: FieldDoc): String = FieldDocCollectionSync.shortLabel(
    when {
        d.isEntry -> d.term
        d.isVoiceSettings -> "Voice settings"
        d.isMode -> d.modeName
        else -> ""
    },
)

/** The [com.charles.bento.core.sync.CollectionSync] for `voice`, over the app's voice repository. */
fun voiceCollectionSync(repo: FieldDocRepository): FieldDocCollectionSync = FieldDocCollectionSync(VOICE_COLLECTION, repo, ::voiceLabel)
