package com.charles.bento.core.voicesync

import com.charles.bento.core.fielddoc.FieldDoc
import com.charles.bento.core.fielddoc.FieldDocRepository
import com.charles.bento.core.fielddoc.SwiftText

/** The personal dictionary as a list, with the Mac's `DictionaryStore` rules. Pure. */
object VoiceDictionary {
    /** A term as stored: trimmed, 1–60 characters; null when invalid. */
    fun validTerm(term: String): String? {
        val t = SwiftText.trimmingWhitespacesAndNewlines(term)
        return if (SwiftText.characterCount(t) in 1..60) t else null
    }

    /** Starred first, then newest (the Mac's dictionary window and vocabulary order). */
    val order: Comparator<DictionaryEntry> = Comparator { a, b ->
        when {
            a.starred != b.starred -> if (a.starred) -1 else 1
            a.createdAt != b.createdAt -> b.createdAt.compareTo(a.createdAt)
            else -> SwiftText.compare(a.id, b.id)
        }
    }

    /**
     * One entry per term (case-insensitive: terms are unique on every device, but two devices
     * can add the same term before syncing): the earliest added wins, so all devices agree.
     */
    fun deduplicated(entries: List<DictionaryEntry>): List<DictionaryEntry> {
        val byTerm = LinkedHashMap<String, DictionaryEntry>()
        for (e in entries.sortedWith(compareBy<DictionaryEntry> { it.createdAt }.thenComparator { a, b -> SwiftText.compare(a.id, b.id) })) {
            byTerm.putIfAbsent(SwiftText.nfc(SwiftText.lowercased(e.term)), e)
        }
        return byTerm.values.toList()
    }

    /** The dictionary window's search: term or misspelling contains the query, case-insensitively. */
    fun search(entries: List<DictionaryEntry>, query: String): List<DictionaryEntry> =
        if (query.isEmpty()) entries
        else entries.filter { SwiftText.localizedCaseInsensitiveContains(it.term, query) || (it.misspelling?.let { m -> SwiftText.localizedCaseInsensitiveContains(m, query) } ?: false) }

    /** Vocabulary for the cleanup prompt: starred first, then newest. Cap 100. */
    fun vocabulary(entries: List<DictionaryEntry>, limit: Int = 100): List<String> = entries.sortedWith(order).take(limit).map { it.term }

    /**
     * Vocabulary as it goes over the wire (cleanup prompt and transcription vocabulary): no
     * newlines, each term at most 60 characters, at most `maxBytes` in all (starred survive).
     * Only correct terms, never misspellings.
     */
    fun sanitizedVocabulary(entries: List<DictionaryEntry>, maxBytes: Int = 2_048): List<String> {
        var used = 0
        val out = ArrayList<String>()
        for (term in vocabulary(entries)) {
            val oneLine = term.replace("\n", " ").replace("\r", " ")
            val b = SwiftText.characterBoundaries(oneLine)
            val capped = if (b.size - 1 > 60) oneLine.substring(0, b[60]) else oneLine
            val clean = SwiftText.trimmingWhitespaces(capped)
            if (clean.isEmpty()) continue
            val cost = clean.toByteArray(Charsets.UTF_8).size + 1
            if (used + cost > maxBytes) break
            used += cost
            out += clean
        }
        return out
    }

    /** Spelling hints for the prompt: the top 10 entries with misspellings, starred first, then newest. */
    fun spellings(entries: List<DictionaryEntry>): List<Pair<String, String>> =
        entries.sortedWith(order).mapNotNull { e -> e.misspelling?.takeIf { it.isNotEmpty() }?.let { it to e.term } }.take(10)

    /** Deterministic wrong → right rules: every entry with a misspelling, oldest first. */
    fun replacementRules(entries: List<DictionaryEntry>): List<Pair<String, String>> =
        entries.sortedBy { it.createdAt }.mapNotNull { e -> e.misspelling?.takeIf { it.isNotEmpty() }?.let { it to e.term } }
}

/**
 * Typed operations on the `voice` collection's repository: the dictionary, the settings
 * singleton and dictation modes. Every change is a local change (fresh field clocks, dirty,
 * [device]) followed by [onLocalChange]. Not thread safe: call from the sync dispatcher.
 */
class VoiceStore(
    val repo: FieldDocRepository,
    private val device: () -> String = { "" },
    private val onLocalChange: () -> Unit = {},
) {
    // MARK: Dictionary

    /** Every live entry, as stored (duplicates included). */
    val allEntries: List<DictionaryEntry> get() = repo.allDocs.filter { it.isEntry }.map(DictionaryEntry::of)

    /** The dictionary as the list shows it: one entry per term, starred first, then newest. */
    fun dictionary(): List<DictionaryEntry> = VoiceDictionary.deduplicated(allEntries).sortedWith(VoiceDictionary.order)

    fun search(query: String): List<DictionaryEntry> = VoiceDictionary.search(dictionary(), query)

    fun vocabulary(): List<String> = VoiceDictionary.vocabulary(dictionary())
    fun sanitizedVocabulary(maxBytes: Int = 2_048): List<String> = VoiceDictionary.sanitizedVocabulary(dictionary(), maxBytes)
    fun spellings(): List<Pair<String, String>> = VoiceDictionary.spellings(dictionary())
    fun replacementRules(): List<Pair<String, String>> = VoiceDictionary.replacementRules(dictionary())

    private fun termTaken(term: String, except: String? = null): Boolean {
        val key = SwiftText.nfc(SwiftText.lowercased(term))
        return allEntries.any { it.id != except && SwiftText.nfc(SwiftText.lowercased(it.term)) == key }
    }

    /** Adds a term (trimmed, 1–60 characters, not already in the dictionary); null when refused. */
    fun addEntry(term: String, misspelling: String? = null, starred: Boolean = false): DictionaryEntry? {
        val t = VoiceDictionary.validTerm(term) ?: return null
        if (termTaken(t)) return null
        val d = FieldDoc.newEntry(t, cleanMisspelling(misspelling), starred)
        commit(d)
        return DictionaryEntry.of(d)
    }

    /** Renames an entry's term (same rules as adding); false when refused. */
    fun setTerm(id: String, term: String): Boolean {
        val t = VoiceDictionary.validTerm(term) ?: return false
        if (termTaken(t, except = id)) return false
        return edit(id, VoiceKind.ENTRY) { it.setTerm(t) }
    }

    fun setMisspelling(id: String, misspelling: String?): Boolean = edit(id, VoiceKind.ENTRY) { it.setMisspelling(cleanMisspelling(misspelling)) }

    fun setStarred(id: String, starred: Boolean): Boolean = edit(id, VoiceKind.ENTRY) { it.setStarred(starred) }

    fun toggleStar(id: String): Boolean = edit(id, VoiceKind.ENTRY) { it.setStarred(!it.starred) }

    fun removeEntry(id: String): Boolean = edit(id, VoiceKind.ENTRY) { it.markDeleted() }

    private fun cleanMisspelling(s: String?): String? = s?.let(SwiftText::trimmingWhitespacesAndNewlines)?.takeIf { it.isNotEmpty() }

    // MARK: Settings

    val settings: VoiceSettings get() = VoiceSettings.of(repo.doc(VOICE_SETTINGS_ID))

    fun setCustomInstructions(s: String) = editSettings { it.setCustomInstructions(s) }
    fun setCustomInstructionsEnabled(b: Boolean) = editSettings { it.setCustomInstructionsEnabled(b) }
    fun setCleanupEnabled(b: Boolean) = editSettings { it.setCleanupEnabled(b) }

    /** Changes the singleton, creating it (with only the changed field) when missing. */
    private fun editSettings(f: (FieldDoc) -> Unit): Boolean {
        val old = repo.doc(VOICE_SETTINGS_ID)
        val d = old?.copy() ?: FieldDoc.newVoiceSettings()
        if (d.deleted) resurrect(d, VoiceKind.SETTINGS)
        f(d)
        if (d == old) return false
        if (old == null && d.fields.isEmpty()) return false
        return save(d)
    }

    // MARK: Modes

    /** Dictation modes by order. */
    fun modes(): List<VoiceMode> = repo.allDocs.filter { it.isMode }
        .sortedWith(compareBy<FieldDoc> { it.modeOrder }.thenBy { it.createdAt }.thenComparator { a, b -> SwiftText.compare(a.id, b.id) })
        .map(VoiceMode::of)

    fun mode(id: String): VoiceMode? = repo.doc(id)?.takeIf { it.isMode }?.let(VoiceMode::of)

    /** Adds a mode at the end; null when the name is blank. */
    fun addMode(name: String, prompt: String = "", language: String? = null, cleanup: Boolean = true): VoiceMode? {
        val n = SwiftText.trimmingWhitespacesAndNewlines(name)
        if (n.isEmpty()) return null
        val order = (modes().maxOfOrNull { it.order } ?: 0.0) + 1024
        val d = FieldDoc.newMode(n, prompt, order, language?.takeIf { it.isNotBlank() }, cleanup)
        commit(d)
        return VoiceMode.of(d)
    }

    /** Changes the given properties of a mode (null: unchanged; `language = ""` clears it). */
    fun updateMode(id: String, name: String? = null, prompt: String? = null, language: String? = null, cleanup: Boolean? = null): Boolean =
        edit(id, VoiceKind.MODE) { d ->
            name?.let(SwiftText::trimmingWhitespacesAndNewlines)?.takeIf { it.isNotEmpty() }?.let { d.setModeName(it) }
            prompt?.let { d.setModePrompt(it) }
            language?.let { d.setModeLanguage(it.ifBlank { null }) }
            cleanup?.let { d.setModeCleanup(it) }
        }

    fun deleteMode(id: String): Boolean = edit(id, VoiceKind.MODE) { it.markDeleted() }

    /** Moves a mode one place up (-1) or down (+1). */
    fun moveMode(id: String, delta: Int): Boolean {
        val list = modes()
        val i = list.indexOfFirst { it.id == id }
        if (i < 0 || (i + delta) !in list.indices) return false
        val j = i + delta
        val beyond = list.getOrNull(j + delta)?.order
        val o = if (delta < 0) between(beyond, list[j].order) else between(list[j].order, beyond)
        return edit(id, VoiceKind.MODE) { it.setModeOrder(o) }
    }

    private fun between(a: Double?, b: Double?): Double = when {
        a != null && b != null -> (a + b) / 2
        a != null -> a + 1024
        b != null -> b - 1024
        else -> 1024.0
    }

    // MARK: Plumbing

    private fun edit(id: String, type: String, f: (FieldDoc) -> Unit): Boolean {
        val old = repo.doc(id) ?: return false
        if (old.deleted || old.type != type) return false
        val d = old.copy()
        f(d)
        if (d == old) return false
        return save(d)
    }

    /** An edit after a deletion brings the document back (its put carries the full body). */
    private fun resurrect(d: FieldDoc, type: String) {
        d.deleted = false
        d.type = type
        d.updatedAt = FieldDoc.nextClock(d.updatedAt)
    }

    private fun commit(d: FieldDoc) {
        d.device = device()
        d.dirty = true
        repo.save(d, remote = false)
        onLocalChange()
    }

    private fun save(d: FieldDoc): Boolean {
        commit(d)
        return true
    }
}
