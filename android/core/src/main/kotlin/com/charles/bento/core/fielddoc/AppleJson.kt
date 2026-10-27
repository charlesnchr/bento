package com.charles.bento.core.fielddoc

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * JSON as the Mac's JSONSerialization reads it. One quirk matters for convergence: it drops
 * a U+FEFF at the start of every string and key it parses (it builds them like
 * `String(data:encoding:)`, which strips a byte order mark), escaped or not; one only.
 * Cross-checked on macOS 26. Documents decoded here therefore hold what a Mac holds after
 * receiving the same JSON.
 */
internal object AppleJson {
    private const val BOM = '﻿'

    fun parse(text: String): JsonElement = normalize(Json.parseToJsonElement(text))

    fun normalize(e: JsonElement): JsonElement = when (e) {
        is JsonPrimitive -> if (e.isString && e.content.startsWith(BOM)) JsonPrimitive(e.content.substring(1)) else e
        is JsonArray -> {
            val items = e.map(::normalize)
            if (items.indices.all { items[it] === e[it] }) e else JsonArray(items)
        }
        is JsonObject -> {
            var changed = false
            val out = LinkedHashMap<String, JsonElement>(e.size)
            for ((k, v) in e) {
                val nk = if (k.startsWith(BOM)) k.substring(1) else k
                val nv = normalize(v)
                if (nk != k || nv !== v) changed = true
                out[nk] = nv
            }
            if (changed) JsonObject(out) else e
        }
    }
}
