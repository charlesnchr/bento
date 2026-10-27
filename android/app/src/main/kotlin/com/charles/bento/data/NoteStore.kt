package com.charles.bento.data

import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.provider.Settings
import com.charles.bento.core.json.JSONValue
import com.charles.bento.core.notes.Note
import com.charles.bento.core.notes.NoteRepository
import com.charles.bento.core.notes.SyncHeadsCodec
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.UUID

/**
 * The notes database (`notes.db`), the same layout as the Mac's NoteStore: every note in
 * memory, written through to SQLite; heads stored with the hash of the body they describe.
 * Engine thread only; [notes] is an immutable snapshot for the UI and widgets.
 */
class NoteStore(context: Context) : NoteRepository {
    private val db = Db(context, "notes.db", listOf(
        """CREATE TABLE IF NOT EXISTS notes (
          id TEXT PRIMARY KEY, body TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          deleted INTEGER NOT NULL DEFAULT 0, seq INTEGER, device TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL DEFAULT '{}',
          dirty INTEGER NOT NULL DEFAULT 0, opened_at INTEGER NOT NULL DEFAULT 0, base_hash INTEGER, heads TEXT)""",
    ))
    private val cache = LinkedHashMap<String, Note>()
    private val kv: MutableMap<String, String>
    private val _notes = MutableStateFlow<List<Note>>(emptyList())
    /** Every note incl. tombstones, as of the last change. */
    val notes: StateFlow<List<Note>> = _notes.asStateFlow()

    /** The device this database belongs to: a database restored onto another phone gets a new install id there. */
    @SuppressLint("HardwareIds")
    private val hostID: String = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) ?: "android"

    init {
        db.query("SELECT * FROM notes") { c ->
            val body = c.str("body").orEmpty()
            Note(
                id = c.str("id")!!, body = body, createdAt = c.long("created_at") ?: 0, updatedAt = c.long("updated_at") ?: 0,
                deleted = (c.long("deleted") ?: 0) != 0L, seq = c.long("seq"), device = c.str("device").orEmpty(),
                meta = JSONValue.parse(c.str("meta") ?: "{}")?.obj ?: emptyMap(),
                dirty = (c.long("dirty") ?: 0) != 0L, openedAt = c.long("opened_at") ?: 0,
                baseHash = c.long("base_hash")?.toULong(),
                // heads describe the text they were stored with; an older build that edits the
                // note leaves them behind, so they only count while that text is still there
                syncHeads = c.str("heads")?.let { SyncHeadsCodec.decode(it, body) },
            )
        }.forEach { cache[it.id] = it }
        kv = db.kvAll()
        publish()
    }

    override fun note(id: String): Note? = cache[id]

    override fun save(note: Note) {
        // the Mac's SQLite layer passes C strings: a NUL would truncate the body there
        val n = if (note.body.contains('\u0000')) note.copy(body = note.body.replace("\u0000", "")) else note
        if (cache[n.id] == n) return
        write(n)
        cache[n.id] = n
        publish()
    }

    override var lastSeq: Long
        get() = kv["last_seq"]?.toLongOrNull() ?: 0
        set(v) = setKV("last_seq", v.toString())

    override fun allNotes(includeTombstones: Boolean): List<Note> =
        if (includeTombstones) cache.values.toList() else cache.values.filter { !it.deleted }

    override val installID: String
        get() {
            val id = kv["sync_install_id"]
            if (!id.isNullOrEmpty() && kv["sync_install_host"] == hostID) return id
            // a new phone (or a first launch): the old id stays the old device's alone, not retired
            newInstallID()
            return kv["sync_install_id"].orEmpty()
        }

    override fun renewInstallID() {
        kv["sync_install_id"]?.takeIf { it.isNotEmpty() }?.let { old ->
            setKV("sync_retired_ids", JSONValue.Arr((retiredInstallIDs + old).sorted().map { JSONValue.Str(it) }).toElement().toString())
        }
        newInstallID()
    }

    override val retiredInstallIDs: Set<String>
        get() = kv["sync_retired_ids"]?.let { JSONValue.parse(it)?.array?.mapNotNull { v -> v.string }?.toSet() } ?: emptySet()

    /** Remembers when a note was last opened (the list order), without making it a change. */
    fun markOpened(id: String, at: Long = System.currentTimeMillis()) {
        val n = cache[id] ?: return
        val o = n.copy(openedAt = at)
        cache[id] = o
        db.db.execSQL("UPDATE notes SET opened_at = ? WHERE id = ?", arrayOf<Any>(at, id))
        publish()
    }

    /** Removes a row entirely (never-synced empty notes). */
    fun remove(id: String) {
        cache.remove(id) ?: return
        db.db.delete("notes", "id = ?", arrayOf(id))
        publish()
    }

    fun kv(key: String): String? = kv[key]

    fun setKV(key: String, value: String?) {
        if (value == null) kv.remove(key) else kv[key] = value
        db.setKV(key, value)
    }

    private fun newInstallID() {
        setKV("sync_install_id", UUID.randomUUID().toString().uppercase())
        setKV("sync_install_host", hostID)
    }

    private fun publish() { _notes.value = cache.values.toList() }

    private fun write(n: Note) {
        db.db.insertWithOnConflict("notes", null, ContentValues().apply {
            put("id", n.id); put("body", n.body); put("created_at", n.createdAt); put("updated_at", n.updatedAt)
            put("deleted", if (n.deleted) 1 else 0)
            n.seq?.let { put("seq", it) } ?: putNull("seq")
            put("device", n.device)
            put("meta", if (n.meta.isEmpty()) "{}" else JSONValue.Obj(n.meta).canonicalObject())
            put("dirty", if (n.dirty) 1 else 0); put("opened_at", n.openedAt)
            n.baseHash?.let { put("base_hash", it.toLong()) } ?: putNull("base_hash")
            val heads = n.syncHeads?.let { SyncHeadsCodec.encode(it, n.body) }
            if (heads != null) put("heads", heads) else putNull("heads")
        }, SQLiteDatabase.CONFLICT_REPLACE)
    }
}

/** Sorted-key JSON for a stored meta column. */
private fun JSONValue.Obj.canonicalObject(): String = canonical.removePrefix("[").removeSuffix("]")
