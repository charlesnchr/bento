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
import java.math.BigDecimal
import java.math.MathContext
import java.math.RoundingMode
import java.text.Normalizer
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
    data class Number(val value: Double) : JSONValue() {
        // Numerically, like Swift's Double == (a data class would tell -0.0 from 0.0).
        override fun equals(other: Any?): Boolean = other is Number && other.value == value
        override fun hashCode(): Int = (if (value == 0.0) 0.0 else value).hashCode()
    }
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
     * `.sortedKeys`: the todo merge's tie-break, so it must match the Mac byte for byte.
     * Cross-checked against macOS 26 (src/test/resources/xcheck/canonical.json): keys sort
     * like Foundation's `compare(_:options: [.numeric, .caseInsensitive, .forcedOrdering])`
     * in the root locale (exact for ASCII keys, close for accented Latin ones), and
     * non-integral numbers are written like C's `%.17g` (0.1 is `0.10000000000000001`).
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
                fields.keys.sortedWith(AppleKeyOrder).forEachIndexed { i, k ->
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
            // Integral values below 1e15 travel as Int64, like the Mac's JSONValue.any.
            if (round(d) == d && abs(d) < 1e15) return d.toLong().toString()
            return formatG17(d)
        }

        /** C's `%.17g`, which JSONSerialization uses for doubles: 0.1 → 0.10000000000000001, 1e20 → 1e+20. */
        internal fun formatG17(d: Double): String {
            if (d.isNaN()) return "nan"
            if (d.isInfinite()) return if (d > 0) "inf" else "-inf"
            if (d == 0.0) return if (1.0 / d < 0) "-0" else "0"
            val bd = BigDecimal(d).round(MathContext(17, RoundingMode.HALF_EVEN))
            val unscaled = bd.unscaledValue().abs().toString()
            val exp = unscaled.length - 1 - bd.scale()
            val digits = unscaled.trimEnd('0').ifEmpty { "0" }
            val sb = StringBuilder()
            if (d < 0) sb.append('-')
            if (exp < -4 || exp >= 17) {
                sb.append(digits[0])
                if (digits.length > 1) sb.append('.').append(digits, 1, digits.length)
                sb.append('e').append(if (exp < 0) '-' else '+')
                if (abs(exp) < 10) sb.append('0')
                sb.append(abs(exp))
            } else if (exp >= 0) {
                if (digits.length <= exp + 1) {
                    sb.append(digits)
                    repeat(exp + 1 - digits.length) { sb.append('0') }
                } else {
                    sb.append(digits, 0, exp + 1).append('.').append(digits, exp + 1, digits.length)
                }
            } else {
                sb.append("0.")
                repeat(-exp - 1) { sb.append('0') }
                sb.append(digits)
            }
            return sb.toString()
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

/**
 * The order JSONSerialization's `.sortedKeys` gives object keys on the Mac: Foundation's
 * `compare(_:options: [.numeric, .caseInsensitive, .forcedOrdering])` in the root locale,
 * i.e. ICU root collation with numeric digit runs. Levels: base characters (spaces and
 * punctuation < digit runs by value < letters), then accents, then case (lower first), then
 * shorter first (`a1` < `a01`). Exact for ASCII keys (cross-checked); other characters are
 * approximated (accented Latin letters by their base letter, everything else after Latin
 * in code point order).
 */
internal object AppleKeyOrder : Comparator<String> {
    private const val PUNCT = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$"
    private const val NUMBER = 1_000_000
    private const val LETTER = 2_000_000
    private const val OTHER = 3_000_000

    private class Element(val primary: Int, val digits: String?, var secondary: Int, val tertiary: Int)

    private fun elements(s: String): List<Element> {
        val out = ArrayList<Element>(s.length)
        val n = if (s.all { it.code < 0x80 }) s else Normalizer.normalize(s, Normalizer.Form.NFD)
        var i = 0
        while (i < n.length) {
            val cp = n.codePointAt(i)
            val len = Character.charCount(cp)
            when {
                cp in 0x30..0x39 -> {
                    var j = i
                    while (j < n.length && n[j] in '0'..'9') j++
                    out += Element(NUMBER, n.substring(i, j).trimStart('0'), 0, 0)
                    i = j
                    continue
                }
                cp in 0x61..0x7A -> out += Element(LETTER + (cp - 0x61), null, 0, 0)
                cp in 0x41..0x5A -> out += Element(LETTER + (cp - 0x41), null, 0, 1)
                cp < 0x80 -> {
                    val p = PUNCT.indexOf(cp.toChar())
                    when {
                        p >= 0 -> out += Element(100 + p, null, 0, 0)
                        cp in 0x09..0x0D -> out += Element(50 + cp, null, 0, 0)
                        else -> {} // other controls are ignorable
                    }
                }
                Character.getType(cp) == Character.NON_SPACING_MARK.toInt() ->
                    out.lastOrNull()?.let { it.secondary = it.secondary * 31 + cp } ?: run { out += Element(0, null, cp, 0) }
                else -> {
                    val lower = Character.toLowerCase(cp)
                    out += Element(OTHER + lower, null, 0, if (lower != cp) 1 else 0)
                }
            }
            i += len
        }
        return out
    }

    private fun comparePrimary(a: Element, b: Element): Int {
        if (a.primary != b.primary) return a.primary.compareTo(b.primary)
        val da = a.digits ?: return 0
        val db = b.digits ?: return 0
        if (da.length != db.length) return da.length.compareTo(db.length)
        return da.compareTo(db)
    }

    override fun compare(a: String, b: String): Int {
        if (a == b) return 0
        val ea = elements(a)
        val eb = elements(b)
        for (level in 0..2) {
            for (k in 0 until minOf(ea.size, eb.size)) {
                val c = when (level) {
                    0 -> comparePrimary(ea[k], eb[k])
                    1 -> ea[k].secondary.compareTo(eb[k].secondary)
                    else -> ea[k].tertiary.compareTo(eb[k].tertiary)
                }
                if (c != 0) return c
            }
            if (ea.size != eb.size) return ea.size.compareTo(eb.size)
        }
        if (a.length != b.length) return a.length.compareTo(b.length)
        return a.compareTo(b)
    }
}
