package com.charles.bento.core.fielddoc

import com.charles.bento.core.json.JSONValue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

/** The protocol's document object for one field-doc collection (`todos`, `voice`); port of `TodoWire`. */
class FieldDocWire(val collection: String) {

    /** The document as put: `body` may be passed when the caller already has it. */
    fun encode(d: FieldDoc, device: String, body: String = d.body): JsonObject = JsonObject(
        mapOf(
            "id" to JsonPrimitive(d.id),
            "body" to JsonPrimitive(body),
            "created_at" to JsonPrimitive(d.createdAt),
            "updated_at" to JsonPrimitive(d.updatedAt),
            "deleted" to JsonPrimitive(d.deleted),
            "device" to JsonPrimitive(device),
            "meta" to JSONValue.encodeObject(d.meta),
            "collection" to JsonPrimitive(collection),
        ),
    )

    /**
     * Null for anything that isn't a document of this collection (another collection, no
     * collection at all as an old server's notes, unreadable body).
     */
    fun decode(e: JsonElement?): FieldDoc? {
        val o = e?.let(AppleJson::normalize) as? JsonObject ?: return null
        val id = o.string("id")?.takeIf { it.isNotEmpty() } ?: return null
        // Servers with collections always say which; anything else isn't ours.
        if (o.string("collection") != collection) return null
        fun int(k: String): Long? = FieldDoc.nsNumber(o[k])?.let(JSONValue::int64)
        val updated = int("updated_at") ?: return null
        val d = FieldDoc(id = id, type = "", createdAt = int("created_at") ?: updated, updatedAt = updated)
        d.deleted = (o["deleted"] as? JsonPrimitive)?.takeIf { !it.isString }?.let { p ->
            p.booleanOrNull ?: p.doubleOrNull?.let { it != 0.0 }
        } ?: false
        if (!d.deleted && !d.load(o.string("body") ?: "")) return null
        d.seq = int("seq")
        d.device = o.string("device") ?: ""
        (o["meta"] as? JsonObject)?.let { m -> d.meta = m.mapValues { JSONValue.of(it.value) } }
        return d
    }

    private fun JsonObject.string(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
}

/**
 * A document as a local database row stores it (the Mac's `docs` table: id, body, type,
 * created_at, updated_at, deleted, seq, device, meta, dirty), so the app's SQLite store and
 * the Mac's agree on what is kept.
 */
object FieldDocRow {
    /** Rebuilds a stored document (Swift `TodoStore.load`). */
    fun fromRow(
        id: String, type: String, body: String, createdAt: Long, updatedAt: Long, deleted: Boolean,
        seq: Long?, device: String, metaJson: String, dirty: Boolean,
    ): FieldDoc {
        val d = FieldDoc(id = id, type = type, createdAt = createdAt, updatedAt = updatedAt)
        d.deleted = deleted
        if (!deleted) d.load(body)
        d.seq = seq
        d.device = device
        d.meta = runCatching { JSONValue.objectOf(AppleJson.parse(metaJson)) }.getOrDefault(emptyMap())
        d.dirty = dirty
        return d
    }

    /** The `meta` column: `{}` when empty, else sorted-key JSON. */
    fun metaJson(d: FieldDoc): String = if (d.meta.isEmpty()) "{}" else FieldDoc.json(JSONValue.Obj(d.meta))

    /** The `body` column (NULs dropped, as the Mac's SQLite layer can't store them). */
    fun bodyColumn(d: FieldDoc): String = d.body.let { if (it.contains('\u0000')) it.replace("\u0000", "") else it }
}
