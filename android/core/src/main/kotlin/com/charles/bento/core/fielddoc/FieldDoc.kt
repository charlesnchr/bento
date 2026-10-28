package com.charles.bento.core.fielddoc

import com.charles.bento.core.json.AppleKeyOrder
import com.charles.bento.core.json.JSONValue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import java.util.UUID
import kotlin.math.max
import kotlin.math.min

/**
 * One synced field-clock document plus local bookkeeping: a todo task or project, a voice
 * dictionary entry… Port of the Mac's `TodoDoc` without the todo-typed accessors (those are
 * in `core.todo`, the voice ones in `core.voicesync`).
 *
 * Fields carry their own clocks (ms of the last change) so concurrent edits of different
 * fields on two devices merge instead of overwriting each other; see "Todo documents" in
 * docs/SYNC_PROTOCOL.md. The body is `{"type": …, "fields": {…}, "clocks": {…}}` plus any
 * unknown top-level keys, which are preserved.
 *
 * Value semantics like the Swift struct: properties are `var`, maps are never mutated in
 * place (every change installs a new map), so [copy] gives an independent document. Copy
 * before changing a document you got from a repository.
 */
data class FieldDoc(
    var id: String,
    /** "task", "project", "entry"…; unknown values are kept but ignored. */
    var type: String,
    var fields: Map<String, JSONValue> = emptyMap(),
    var clocks: Map<String, Long> = emptyMap(),
    /** Unknown top-level keys of the body, preserved. */
    var extra: Map<String, JSONValue> = emptyMap(),
    var createdAt: Long,
    var updatedAt: Long,
    var deleted: Boolean = false,
    /** Server seq of the version we last saw (null: never synced). */
    var seq: Long? = null,
    var device: String = "",
    var meta: Map<String, JSONValue> = emptyMap(),
    /** Local only: changes the server hasn't acknowledged. */
    var dirty: Boolean = false,
) {
    /** A new local document of `type` (Swift `TodoDoc(id:kind:createdAt:)`). */
    constructor(type: String, id: String = newId(), createdAt: Long = now()) :
        this(id = id, type = type, createdAt = createdAt, updatedAt = createdAt)

    // MARK: Fields

    /** Sets a field as a local change (no-op when the value is unchanged). */
    fun set(key: String, value: JSONValue, clock: Long? = null) {
        if (fields[key] == value) return
        val c = clock ?: nextClock(updatedAt)
        fields = fields + (key to value)
        clocks = clocks + (key to c)
        updatedAt = max(updatedAt, c)
    }

    /** Turns the document into a tombstone as a local change. */
    fun markDeleted(clock: Long? = null) {
        if (deleted) return
        deleted = true
        updatedAt = max(if (updatedAt == Long.MAX_VALUE) Long.MAX_VALUE else updatedAt + 1, clock ?: nextClock(updatedAt))
    }

    val maxClock: Long get() = clocks.values.maxOrNull() ?: createdAt

    /**
     * Field-by-field merge: per field the larger clock wins; ties go to the value whose
     * canonical JSON sorts higher (Swift `>` on the strings), so every device converges on
     * the same result. Bookkeeping (seq, dirty, updatedAt, deleted) comes from `this`.
     */
    fun merged(other: FieldDoc): FieldDoc {
        val m = copy()
        val mf = LinkedHashMap(fields)
        val mc = LinkedHashMap(clocks)
        val keys = LinkedHashSet<String>().apply { addAll(fields.keys); addAll(other.fields.keys); addAll(clocks.keys); addAll(other.clocks.keys) }
        for (key in keys) {
            val a = clocks[key] ?: (if (fields[key] == null) -1L else 0L)
            val b = other.clocks[key] ?: (if (other.fields[key] == null) -1L else 0L)
            val takeOther = if (a != b) b > a else
                SwiftText.compare(other.fields[key]?.canonical ?: "", fields[key]?.canonical ?: "") > 0
            if (takeOther) {
                val v = other.fields[key]
                if (v == null) mf.remove(key) else mf[key] = v
                other.clocks[key]?.let { mc[key] = it }
            }
        }
        m.fields = mf
        m.clocks = mc
        // Extra keys have no clocks; no client writes them yet, so take the server's.
        if (other.extra.isNotEmpty()) m.extra = extra + other.extra
        m.createdAt = min(createdAt, other.createdAt)
        return m
    }

    /** Same synced content (ignores seq/dirty/device bookkeeping). */
    fun sameContent(o: FieldDoc): Boolean =
        type == o.type && fields == o.fields && clocks == o.clocks && extra == o.extra &&
            deleted == o.deleted && meta == o.meta && updatedAt == o.updatedAt && createdAt == o.createdAt

    // MARK: Body (wire)

    /** The wire body: sorted-key JSON as the Mac writes it; "" for tombstones. */
    val body: String
        get() {
            if (deleted) return ""
            val keys = LinkedHashSet(extra.keys).apply { add("type"); add("fields"); add("clocks") }
            val sb = StringBuilder()
            sb.append('{')
            keys.sortedWith(AppleKeyOrder).forEachIndexed { i, k ->
                if (i > 0) sb.append(',')
                sb.append(json(JSONValue.Str(k))).append(':')
                when (k) {
                    "type" -> sb.append(json(JSONValue.Str(type)))
                    "fields" -> sb.append(json(JSONValue.Obj(fields)))
                    "clocks" -> {
                        sb.append('{')
                        clocks.keys.sortedWith(AppleKeyOrder).forEachIndexed { j, ck ->
                            if (j > 0) sb.append(',')
                            sb.append(json(JSONValue.Str(ck))).append(':').append(clocks.getValue(ck))
                        }
                        sb.append('}')
                    }
                    else -> sb.append(json(extra.getValue(k)))
                }
            }
            sb.append('}')
            return sb.toString()
        }

    /** Fills type/fields/clocks/extra from a body; false when it isn't a field-doc body. */
    fun load(body: String): Boolean {
        val obj = runCatching { AppleJson.parse(body) }.getOrNull() as? JsonObject ?: return false
        val t = (obj["type"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return false
        type = t
        fields = JSONValue.objectOf(obj["fields"])
        clocks = (obj["clocks"] as? JsonObject)?.entries?.mapNotNull { (k, v) ->
            nsNumber(v)?.let(JSONValue::int64)?.let { k to it }
        }?.toMap() ?: emptyMap()
        extra = obj.filterKeys { it != "type" && it != "fields" && it != "clocks" }.mapValues { JSONValue.of(it.value) }
        return true
    }

    companion object {
        /** The clock all local stamps come from (ms since 1970); replace in tests. */
        @Volatile var clock: () -> Long = { System.currentTimeMillis() }

        fun now(): Long = clock()

        /** A document id like Swift's `UUID().uuidString` (uppercase). */
        fun newId(): String = UUID.randomUUID().toString().uppercase()

        /**
         * A clock for a new local change: now, but always after each of `after` (clocks come
         * from other devices and may be ahead of ours; never overflows).
         */
        fun nextClock(vararg after: Long): Long =
            after.fold(now()) { acc, x -> max(acc, if (x == Long.MAX_VALUE) Long.MAX_VALUE else x + 1) }

        /**
         * A JSON element as Foundation's `as? NSNumber` sees it: numbers, and booleans as 1/0
         * (JSONSerialization bridges both to NSNumber); null for anything else.
         */
        internal fun nsNumber(e: JsonElement?): Double? {
            val p = e as? JsonPrimitive ?: return null
            if (p is JsonNull || p.isString) return null
            p.booleanOrNull?.let { return if (it) 1.0 else 0.0 }
            return p.doubleOrNull
        }

        /** JSON text of a value: its canonical form without the `[`…`]` wrapper. */
        internal fun json(v: JSONValue): String = v.canonical.let { it.substring(1, it.length - 1) }
    }
}
