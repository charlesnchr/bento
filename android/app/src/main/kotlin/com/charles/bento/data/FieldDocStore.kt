package com.charles.bento.data

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import com.charles.bento.core.fielddoc.FieldDoc
import com.charles.bento.core.fielddoc.FieldDocRepository
import com.charles.bento.core.fielddoc.FieldDocRow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * One collection of field-clock documents (todos, voice) in SQLite, laid out like the
 * Mac's `TodoStore` (`docs` table + `kv` with `last_seq`). Every document is cached in
 * memory; [docs] is an immutable snapshot for the UI and widgets. Engine thread only.
 */
class FieldDocStore(context: Context, file: String) : FieldDocRepository {
    private val db = Db(context, file, listOf(
        """CREATE TABLE IF NOT EXISTS docs (
          id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
          seq INTEGER, device TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL DEFAULT '{}', dirty INTEGER NOT NULL DEFAULT 0)""",
    ))
    private val cache = LinkedHashMap<String, FieldDoc>()
    private val kv: MutableMap<String, String>
    private val _docs = MutableStateFlow<List<FieldDoc>>(emptyList())
    /** Every document incl. tombstones, as of the last change. */
    val docs: StateFlow<List<FieldDoc>> = _docs.asStateFlow()

    /** After any change: the ids and whether it came from the server. */
    var onChange: ((Set<String>, Boolean) -> Unit)? = null

    init {
        db.query("SELECT * FROM docs") { c ->
            FieldDocRow.fromRow(
                id = c.str("id")!!, type = c.str("type").orEmpty(), body = c.str("body").orEmpty(),
                createdAt = c.long("created_at") ?: 0, updatedAt = c.long("updated_at") ?: 0,
                deleted = (c.long("deleted") ?: 0) != 0L, seq = c.long("seq"), device = c.str("device").orEmpty(),
                metaJson = c.str("meta") ?: "{}", dirty = (c.long("dirty") ?: 0) != 0L,
            )
        }.forEach { cache[it.id] = it }
        kv = db.kvAll()
        publish()
    }

    override fun doc(id: String): FieldDoc? = cache[id]?.copy()

    override fun save(doc: FieldDoc, remote: Boolean) {
        if (cache[doc.id] == doc) return
        write(doc)
        cache[doc.id] = doc.copy()
        publish()
        onChange?.invoke(setOf(doc.id), remote)
    }

    override fun saveAll(docs: List<FieldDoc>) {
        val changed = docs.filter { cache[it.id] != it }
        if (changed.isEmpty()) return
        db.transaction { changed.forEach(::write) }
        changed.forEach { cache[it.id] = it.copy() }
        publish()
        onChange?.invoke(changed.map { it.id }.toSet(), false)
    }

    override val allDocs: List<FieldDoc> get() = cache.values.map { it.copy() }

    fun kv(key: String): String? = kv[key]
    fun setKV(key: String, value: String?) { if (value == null) kv.remove(key) else kv[key] = value; db.setKV(key, value) }

    private fun publish() { _docs.value = cache.values.map { it.copy() } }

    private fun write(d: FieldDoc) {
        db.db.insertWithOnConflict("docs", null, ContentValues().apply {
            put("id", d.id); put("type", d.type); put("body", FieldDocRow.bodyColumn(d))
            put("created_at", d.createdAt); put("updated_at", d.updatedAt); put("deleted", if (d.deleted) 1 else 0)
            d.seq?.let { put("seq", it) } ?: putNull("seq")
            put("device", d.device); put("meta", FieldDocRow.metaJson(d)); put("dirty", if (d.dirty) 1 else 0)
        }, SQLiteDatabase.CONFLICT_REPLACE)
    }
}
