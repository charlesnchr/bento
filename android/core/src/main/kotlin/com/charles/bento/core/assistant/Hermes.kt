package com.charles.bento.core.assistant

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.io.IOException

internal val HermesJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
}

/** Hermes's API server (the gateway's `api_server` platform) and its bearer token (`API_SERVER_KEY`). */
data class HermesEndpoint(val url: HttpUrl, val token: String) {
    override fun toString() = "HermesEndpoint(${url.host}:${url.port})" // never the token

    companion object {
        /**
         * What someone types or a link carries, as the server's base URL: `100.88.250.122:8642`,
         * `http://192.168.1.5:8642/`, `https://homelab.example.ts.net/v1`. Every request carries
         * the key, so plain http is only for addresses that can't be on the internet (the
         * tailnet's, a LAN's, loopback), where WireGuard or the LAN carries it; anything else
         * must be https. Without a scheme it's http for such an address and https otherwise.
         * Null when unusable ([problem] says why).
         */
        fun parseUrl(text: String): HttpUrl? {
            var s = text.trim().trimEnd('/')
            if (s.isEmpty()) return null
            if (s.endsWith("/v1")) s = s.dropLast(3).trimEnd('/')
            if ("://" !in s) {
                val authority = s.substringBefore('/')
                val host = if (authority.startsWith("[")) authority.substringAfter('[').substringBefore(']') else authority.substringBefore(':')
                s = (if (isPrivateAddress(host)) "http://" else "https://") + s
            }
            val url = s.toHttpUrlOrNull() ?: return null
            if (url.scheme != "http" && url.scheme != "https") return null
            if (url.scheme == "http" && !isPrivateAddress(url.host)) return null
            return url.newBuilder().query(null).fragment(null).build()
        }

        /** Why [parseUrl] refuses [text], for the dialogs; null when it's fine (or empty). */
        fun problem(text: String): String? {
            if (text.isBlank() || parseUrl(text) != null) return null
            val s = text.trim()
            val url = (if ("://" in s) s else "http://$s").toHttpUrlOrNull()
            return if (url != null && url.scheme == "http") {
                "Plain http only works for a tailnet or LAN address (100.x, 192.168.x, 10.x). Use https:// for ${url.host}."
            } else "That isn't a server address."
        }

        /**
         * An IP literal that can't be routed on the internet: Tailscale's CGNAT range
         * (100.64.0.0/10) and its IPv6 ULA, RFC 1918, link-local and loopback. Names don't
         * count, since a name can resolve anywhere.
         */
        fun isPrivateAddress(host: String): Boolean {
            val h = host.trim('[', ']').lowercase()
            val v4 = h.split('.').takeIf { it.size == 4 }?.map { it.toIntOrNull() ?: return false }
            if (v4 != null) {
                if (v4.any { it !in 0..255 }) return false
                val (a, b) = v4
                return a == 10 || a == 127 || (a == 172 && b in 16..31) || (a == 192 && b == 168) ||
                    (a == 169 && b == 254) || (a == 100 && b in 64..127)
            }
            if (':' !in h) return h == "localhost"
            return h == "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe8") ||
                h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")
        }

        fun of(url: String, token: String?): HermesEndpoint? {
            val parsed = parseUrl(url) ?: return null
            val t = token?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            return HermesEndpoint(parsed, t)
        }
    }
}

/** One conversation in Hermes's session store. */
data class HermesSession(
    val id: String,
    val title: String? = null,
    val preview: String? = null,
    val startedAt: Double? = null,
    val lastActive: Double? = null,
    val messageCount: Int? = null,
) {
    /** What a list shows: the title, else the first thing said. */
    val label: String get() = title?.takeIf { it.isNotBlank() } ?: preview?.let(AssistantTranscript::displayRequest)?.takeIf { it.isNotBlank() } ?: "New conversation"

    companion object {
        fun parse(o: JsonObject): HermesSession? {
            val id = o.string("id") ?: return null
            return HermesSession(
                id = id,
                title = o.string("title"),
                preview = o.string("preview"),
                startedAt = o.double("started_at"),
                lastActive = o.double("last_active"),
                messageCount = (o["message_count"] as? JsonPrimitive)?.intOrNull,
            )
        }
    }
}

/** A tool call an assistant row asked for. */
data class HermesToolCall(val id: String?, val name: String, val arguments: String?)

/** One row of a conversation as Hermes stored it (user, assistant or tool). */
data class HermesMessage(
    val role: String,
    val content: String,
    val toolCalls: List<HermesToolCall> = emptyList(),
    val toolCallId: String? = null,
    val toolName: String? = null,
    val reasoning: String? = null,
    /** "failed_turn" for the placeholder Hermes stores when a turn didn't run. */
    val displayKind: String? = null,
) {
    companion object {
        fun parse(o: JsonObject): HermesMessage? {
            val role = o.string("role") ?: return null
            val calls = (o["tool_calls"] as? JsonArray).orEmpty().mapNotNull { call ->
                val c = call as? JsonObject ?: return@mapNotNull null
                val fn = c["function"] as? JsonObject
                val name = fn?.string("name") ?: c.string("name") ?: return@mapNotNull null
                HermesToolCall(c.string("id"), name, fn?.string("arguments"))
            }
            return HermesMessage(
                role = role,
                content = text(o["content"]),
                toolCalls = calls,
                toolCallId = o.string("tool_call_id"),
                toolName = o.string("tool_name"),
                reasoning = o.string("reasoning") ?: o.string("reasoning_content"),
                displayKind = o.string("display_kind"),
            )
        }

        /** A string, or the text parts of multimodal content. */
        internal fun text(content: JsonElement?): String = when (content) {
            is JsonPrimitive -> content.contentOrNull.orEmpty()
            is JsonArray -> content.mapNotNull { part ->
                val p = part as? JsonObject ?: return@mapNotNull (part as? JsonPrimitive)?.contentOrNull
                p.string("text")
            }.joinToString("\n")
            else -> ""
        }
    }
}

/** A request Hermes refused or couldn't serve; [message] is for the user. */
class HermesError(message: String, val status: Int? = null, val code: String? = null) : IOException(message) {
    val unauthorized get() = status == 401 || status == 403
}

internal fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
internal fun JsonObject.double(key: String): Double? = (this[key] as? JsonPrimitive)?.doubleOrNull
internal fun JsonObject.bool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.contentOrNull?.toBooleanStrictOrNull()
