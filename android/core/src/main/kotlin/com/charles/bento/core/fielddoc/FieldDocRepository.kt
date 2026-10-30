package com.charles.bento.core.fielddoc

/**
 * Storage the sync engine and the typed layers work against: the app's SQLite store, or
 * [InMemoryFieldDocRepository] in tests. One repository per collection. Port of the Mac's
 * `FieldDocRepository`.
 *
 * Documents go in and out by value: implementations must not hand out an instance they
 * keep (return copies, or never mutate what was saved).
 */
interface FieldDocRepository {
    fun doc(id: String): FieldDoc?

    /** Stores a document. `remote`: the change came from the server (for change notifications). */
    fun save(doc: FieldDoc, remote: Boolean)

    /** Saves several local changes in one transaction (bulk edits, reordering). */
    fun saveAll(docs: List<FieldDoc>) {
        for (d in docs) save(d, remote = false)
    }

    val allDocs: List<FieldDoc>
}

/** A repository in memory: tests, and the app before its database opens. Not thread safe. */
class InMemoryFieldDocRepository : FieldDocRepository {
    private val docs = LinkedHashMap<String, FieldDoc>()

    /** Called after documents change: their ids and whether the change came from the server. */
    var onChange: ((ids: Set<String>, remote: Boolean) -> Unit)? = null

    override fun doc(id: String): FieldDoc? = docs[id]?.copy()

    override fun save(doc: FieldDoc, remote: Boolean) {
        if (docs[doc.id] == doc) return
        docs[doc.id] = doc.copy()
        onChange?.invoke(setOf(doc.id), remote)
    }

    override fun saveAll(docs: List<FieldDoc>) {
        val changed = docs.filter { this.docs[it.id] != it }
        if (changed.isEmpty()) return
        for (d in changed) this.docs[d.id] = d.copy()
        onChange?.invoke(changed.map { it.id }.toSet(), false)
    }

    override val allDocs: List<FieldDoc> get() = docs.values.map { it.copy() }
}
