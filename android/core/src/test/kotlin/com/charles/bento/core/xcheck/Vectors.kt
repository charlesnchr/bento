package com.charles.bento.core.xcheck

import com.charles.bento.core.fielddoc.FieldDoc
import com.charles.bento.core.json.JSONValue
import com.charles.bento.core.todo.DueDate
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import java.time.Instant
import java.time.ZoneId
import java.util.Base64
import java.util.zip.GZIPInputStream

/**
 * Reads the vectors android/core/xcheck/main.swift generated from the Mac's Swift code
 * (src/test/resources/xcheck, gzipped JSON): strings are base64 UTF-8, doubles IEEE bit patterns.
 */
object Vectors {
    fun load(name: String): JsonElement {
        val stream = Vectors::class.java.getResourceAsStream("/xcheck/$name.json.gz") ?: error("missing vector file $name")
        val text = GZIPInputStream(stream).bufferedReader(Charsets.UTF_8).use { it.readText() }
        return Json.parseToJsonElement(text)
    }

    fun str(e: JsonElement): String = String(Base64.getDecoder().decode(e.jsonPrimitive.content), Charsets.UTF_8)

    fun strOrNull(e: JsonElement?): String? = if (e == null || e is JsonNull) null else str(e)

    fun value(e: JsonElement): JSONValue {
        val o = e.jsonObject
        val (k, v) = o.entries.single()
        return when (k) {
            "n" -> JSONValue.Null
            "b" -> JSONValue.Bool(v.jsonPrimitive.boolean)
            "d" -> JSONValue.Number(java.lang.Double.longBitsToDouble(java.lang.Long.parseUnsignedLong(v.jsonPrimitive.content, 16)))
            "s" -> JSONValue.Str(str(v))
            "a" -> JSONValue.Arr(v.jsonArray.map(::value))
            "o" -> JSONValue.Obj(v.jsonArray.associate { p -> str(p.jsonArray[0]) to value(p.jsonArray[1]) })
            else -> error("bad tree $k")
        }
    }

    fun doc(e: JsonElement): FieldDoc? {
        if (e is JsonNull) return null
        val o = e.jsonObject
        return FieldDoc(
            id = str(o["id"]!!),
            type = str(o["type"]!!),
            fields = value(o["fields"]!!).obj!!,
            clocks = o["clocks"]!!.jsonArray.associate { p -> str(p.jsonArray[0]) to p.jsonArray[1].jsonPrimitive.long },
            extra = value(o["extra"]!!).obj!!,
            createdAt = o["createdAt"]!!.jsonPrimitive.long,
            updatedAt = o["updatedAt"]!!.jsonPrimitive.long,
            deleted = o["deleted"]!!.jsonPrimitive.boolean,
            seq = o["seq"]?.jsonPrimitive?.long,
            device = str(o["device"]!!),
            meta = value(o["meta"]!!).obj!!,
            dirty = o["dirty"]!!.jsonPrimitive.boolean,
        )
    }

    fun due(e: JsonElement?): DueDate? {
        if (e == null || e is JsonNull) return null
        val a = e.jsonArray
        return DueDate(a[0].jsonPrimitive.content, a.getOrNull(1)?.jsonPrimitive?.content)
    }

    data class Context(val zone: ZoneId, val now: Instant)

    val contexts: List<Context> by lazy {
        load("parser_contexts").jsonArray.map { c ->
            Context(ZoneId.of(c.jsonArray[0].jsonPrimitive.content), Instant.ofEpochMilli(c.jsonArray[1].jsonPrimitive.long))
        }
    }

    fun JsonElement.intValue(): Int = jsonPrimitive.int
    fun JsonElement.boolValue(): Boolean = jsonPrimitive.boolean
    fun JsonElement?.isNull(): Boolean = this == null || this is JsonNull
    fun JsonElement.contentOrNull(): String? = if (this is JsonNull) null else jsonPrimitive.content
    fun JsonElement.boolOrNull(): Boolean? = (this as? JsonPrimitive)?.booleanOrNull
    val JsonElement.arr: JsonArray get() = jsonArray
    val JsonElement.obj: JsonObject get() = jsonObject
}

/** Collects mismatches and fails once with the first few, so one run shows the whole picture. */
class Mismatches(private val what: String) {
    private val list = ArrayList<String>()
    var checked = 0
        private set

    fun check(ok: Boolean, detail: () -> String) {
        checked++
        if (!ok) list += detail()
    }

    fun assertNone() {
        if (list.isNotEmpty()) {
            throw AssertionError("$what: ${list.size} of $checked differ from the Mac. First ones:\n" + list.take(25).joinToString("\n"))
        }
        println("$what: $checked checks match the Mac")
    }
}

/** Visible escape of a string for failure messages. */
fun esc(s: String?): String = s?.let { "\"" + it.flatMap { c -> if (c.code < 0x20 || c.code > 0x7e) "\\u%04x".format(c.code).toList() else listOf(c) }.joinToString("") + "\"" } ?: "null"
