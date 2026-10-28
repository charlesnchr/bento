package com.charles.bento.core.voice

import com.charles.bento.core.voice.format.ReplacementEngine

/**
 * One Dictionary entry as the voice pipeline sees it. The app maps synced entries
 * onto this. `createdAtMillis` orders unstarred entries newest first, as the Mac
 * does; entries with equal timestamps keep the order they were given in.
 */
data class DictionaryEntry(
    /** The correct term ("Kubernetes", "Ammaar", "gRPC"). */
    val term: String,
    /** A misspelling the recogniser tends to produce ("cooper netties"), or null. */
    val misspelling: String? = null,
    val starred: Boolean = false,
    val createdAtMillis: Long = 0,
)

/** A spelling hint for prompts: "`wrong`" means "`right`". */
data class Spelling(val wrong: String, val right: String)

/**
 * The Dictionary's pipeline inputs, derived exactly as the Mac's `DictionaryStore`
 * does: vocabulary (starred first, then newest, cap 100), the wire-sanitized
 * vocabulary (≤ 2 KiB, correct terms only, never misspellings), the top 10
 * spellings, and the deterministic replacement rules (every entry with a misspelling).
 */
class Dictionary(entries: List<DictionaryEntry>) {
    private val sorted: List<DictionaryEntry> = entries.withIndex()
        .sortedWith(
            compareByDescending<IndexedValue<DictionaryEntry>> { it.value.starred }
                .thenByDescending { it.value.createdAtMillis }
                .thenBy { it.index },
        )
        .map { it.value }
    private val all = entries

    /** Vocabulary for the cleanup prompt: starred first, then newest. Cap 100. */
    fun vocabulary(): List<String> = sorted.take(100).map { it.term }

    /**
     * Vocabulary as it goes over the wire, shared by the cleanup prompt and the
     * transcription request's custom vocabulary. Newlines stripped, each term capped
     * at 60 characters, and a total-byte ceiling (truncated from the end, so starred
     * terms survive).
     */
    fun sanitizedVocabulary(maxBytes: Int = 2_048): List<String> {
        var used = 0
        val out = ArrayList<String>()
        for (term in vocabulary()) {
            val clean = term.replace("\n", " ").replace("\r", " ").take(60).trim()
            if (clean.isEmpty()) continue
            val cost = clean.toByteArray(Charsets.UTF_8).size + 1
            if (used + cost > maxBytes) break
            used += cost
            out.add(clean)
        }
        return out
    }

    /** Spelling hints for the prompt: top 10 entries with misspellings, starred first. */
    fun spellings(): List<Spelling> = sorted.mapNotNull { entry ->
        entry.misspelling?.takeIf { it.isNotEmpty() }?.let { Spelling(wrong = it, right = entry.term) }
    }.take(10)

    /** Deterministic rules for the ReplacementEngine: every entry with a misspelling. */
    fun replacementRules(): List<ReplacementEngine.Rule> = all.mapNotNull { entry ->
        entry.misspelling?.takeIf { it.isNotEmpty() }?.let { ReplacementEngine.Rule(wrong = it, right = entry.term) }
    }
}
