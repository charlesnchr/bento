package com.charles.bento.core.json

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import kotlin.math.abs
import kotlin.math.round

/**
 * Minimal JSON value for the protocol's opaque `meta` objects and document fields, so
 * unknown keys written by other clients survive a round trip. Mirrors the Mac's
 * `JSONValue`: numbers are doubles and compare numerically.
 */
sealed class JSONValue {
    data object Null : JSONValue()
    data class Bool(val value: Boolean) : JSONValue()
    data class Number(val value: Double) : JSONValue()
    data class Str(val value: String) : JSONValue()
    data class Arr(val items: List<JSONValue>) : JSONValue()
    data class Obj(val fields: Map<String, JSONValue>) : JSONValue()

    val string: String? get() = (this as? Str)?.value
    val double: Double? get() = (this as? Number)?.value
    val bool: Boolean? get() = (this as? Bool)?.value
    val int64: Long? get() = double?.let(::int64)
    val array: List<JSONValue>? get() = (this as? Arr)?.items
    val obj: Map<String, JSONValue>? get() = (this as? Obj)?.fields

    /** The kotlinx element to send: integral numbers below 1e15 as integers, like the Mac. */
    fun toElement(): JsonElement = when (this) {
        Null -> JsonNull
        is Bool -> JsonPrimitive(value)
        is Number -> if (round(value) == value && abs(value) < 1e15) JsonPrimitive(value.toLong()) else JsonPrimitive(value)
        is Str -> JsonPrimitive(value)
        is Arr -> JsonArray(items.map { it.toElement() })
        is Obj -> JsonObject(fields.mapValues { it.value.toElement() })
    }

    /**
     * Canonical JSON text (sorted keys) as Apple's JSONSerialization writes `[value]` with
     * `.sortedKeys`: the todo merge's tie-break, so it must match the Mac byte for byte
     * for ordinary values (strings, integers, booleans, short decimals).
     */
    val canonical: String get() = StringBuilder().also { sb -> sb.append('['); writeCanonical(sb); sb.append(']') }.toString()

    private fun writeCanonical(sb: StringBuilder) {
        when (this) {
            Null -> sb.append("null")
            is Bool -> sb.append(if (value) "true" else "false")
            is Number -> sb.append(formatNumber(value))
            is Str -> appendAppleString(sb, value)
            is Arr -> {
                sb.append('[')
                items.forEachIndexed { i, v -> if (i > 0) sb.append(','); v.writeCanonical(sb) }
                sb.append(']')
            }
            is Obj -> {
                sb.append('{')
                fields.keys.sorted().forEachIndexed { i, k ->
                    if (i > 0) sb.append(',')
                    appendAppleString(sb, k)
                    sb.append(':')
                    fields.getValue(k).writeCanonical(sb)
                }
                sb.append('}')
            }
        }
    }

    companion object {
        /** Long from a JSON number of any size (values come from other clients); never overflows. */
        fun int64(d: Double): Long? {
            if (!d.isFinite()) return null
            if (d >= 9.2e18) return Long.MAX_VALUE
            if (d <= -9.2e18) return Long.MIN_VALUE
            return d.toLong()
        }

        fun of(e: JsonElement?): JSONValue = when (e) {
            null, JsonNull -> Null
            is JsonPrimitive -> when {
                e.isString -> Str(e.content)
                e.booleanOrNull != null -> Bool(e.booleanOrNull!!)
                else -> e.doubleOrNull?.let(::Number) ?: Null
            }
            is JsonArray -> Arr(e.map(::of))
            is JsonObject -> Obj(e.mapValues { of(it.value) })
        }

        fun objectOf(e: JsonElement?): Map<String, JSONValue> = (e as? JsonObject)?.mapValues { of(it.value) } ?: emptyMap()

        fun parse(text: String): JSONValue? = runCatching { of(Json.parseToJsonElement(text)) }.getOrNull()

        fun encodeObject(m: Map<String, JSONValue>): JsonObject = JsonObject(m.mapValues { it.value.toElement() })

        private fun formatNumber(d: Double): String {
            if (round(d) == d && abs(d) < 1e15) return d.toLong().toString()
            val s = d.toString()
            // Kotlin writes 1.0E-5 / 1.0E20; JSONSerialization writes 1e-05 / 1e+20.
            val e = s.indexOf('E')
            if (e < 0) return s
            val mantissa = s.substring(0, e).removeSuffix(".0")
            val exp = s.substring(e + 1).toInt()
            val sign = if (exp < 0) "-" else "+"
            return mantissa + "e" + sign + abs(exp).toString().padStart(2, '0')
        }

        private fun appendAppleString(sb: StringBuilder, s: String) {
            sb.append('"')
            for (c in s) {
                when (c) {
                    '"' -> sb.append("\\\"")
                    '\\' -> sb.append("\\\\")
                    '/' -> sb.append("\\/")
                    '\n' -> sb.append("\\n")
                    '\r' -> sb.append("\\r")
                    '\t' -> sb.append("\\t")
                    '\b' -> sb.append("\\b")
                    '\u000C' -> sb.append("\\f")
                    else -> if (c < ' ') sb.append("\\u").append(c.code.toString(16).padStart(4, '0')) else sb.append(c)
                }
            }
            sb.append('"')
        }
    }
}

/** Long from a wire field (`updated_at`, `seq`…), exact for integers like NSNumber.int64Value. */
fun JsonObject.wireLong(key: String): Long? {
    val p = this[key] as? JsonPrimitive ?: return null
    if (p.isString) return null
    return p.longOrNull ?: p.doubleOrNull?.let(JSONValue::int64)
}

fun JsonObject.wireString(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

fun JsonObject.wireBool(key: String): Boolean? {
    val p = this[key] as? JsonPrimitive ?: return null
    return p.booleanOrNull ?: p.longOrNull?.let { it != 0L }
}

/** Compares strings like Swift's `<` on ASCII-dominated text: by Unicode code points. */
fun compareCodePoints(a: String, b: String): Int {
    var i = 0
    var j = 0
    while (i < a.length && j < b.length) {
        val ca = a.codePointAt(i)
        val cb = b.codePointAt(j)
        if (ca != cb) return ca.compareTo(cb)
        i += Character.charCount(ca)
        j += Character.charCount(cb)
    }
    return (a.length - i).compareTo(b.length - j)
}
