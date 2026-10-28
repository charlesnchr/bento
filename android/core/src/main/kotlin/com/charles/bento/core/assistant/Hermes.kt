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
         * `http://homelab:8642/`, `https://homelab.example.ts.net/v1`. Without a scheme it's
         * https for a tailnet name (`tailscale serve` has a certificate) and http otherwise
         * (the API server itself speaks plain HTTP; on a tailnet WireGuard encrypts it).
         */
        fun parseUrl(text: String): HttpUrl? {
            var s = text.trim().trimEnd('/')
            if (s.isEmpty()) return null
            if (s.endsWith("/v1")) s = s.dropLast(3).trimEnd('/')
            if ("://" !in s) {
                val host = s.substringBefore('/').substringBefore(':')
                s = (if (host.endsWith(".ts.net")) "https://" else "http://") + s
            }
            val url = s.toHttpUrlOrNull() ?: return null
            if (url.scheme != "http" && url.scheme != "https") return null
            return url.newBuilder().query(null).fragment(null).build()
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
