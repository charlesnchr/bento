package com.charles.bento.core.assistant

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** One server-sent event: its `event:` name (if any) and its `data:` lines joined. */
data class SseFrame(val event: String?, val data: String)

/** Server-sent events, a line at a time (the HTML spec's parsing, minus `id`/`retry`, which Hermes doesn't need). */
class SseParser {
    private var event: String? = null
    private val data = StringBuilder()
    private var hasData = false

    /** Feeds one line without its terminator; returns a frame when a blank line ends one. */
    fun line(line: String): SseFrame? {
        if (line.isEmpty()) {
            val frame = if (hasData) SseFrame(event, data.toString()) else null
            event = null; data.setLength(0); hasData = false
            return frame
        }
        if (line.startsWith(":")) return null // a comment: Hermes's keepalive
        val colon = line.indexOf(':')
        val field = if (colon < 0) line else line.substring(0, colon)
        var value = if (colon < 0) "" else line.substring(colon + 1)
        if (value.startsWith(" ")) value = value.substring(1)
        when (field) {
            "event" -> event = value
            "data" -> { if (hasData) data.append('\n'); data.append(value); hasData = true }
        }
        return null
    }
}

/**
 * What `POST /api/sessions/{id}/chat/stream` reports about one turn (Hermes's
 * `api_server.py`, `_handle_session_chat_stream`). Everything not listed decodes to null.
 */
sealed interface HermesEvent {
    data class RunStarted(val runId: String, val sessionId: String?) : HermesEvent
    data class Delta(val text: String) : HermesEvent
    data class ToolStarted(val name: String, val preview: String?) : HermesEvent
    data class ToolFinished(val name: String, val preview: String?, val failed: Boolean) : HermesEvent
    /** Text the model wrote beside its tool calls, before the answer. */
    data class Commentary(val text: String, val alreadyStreamed: Boolean) : HermesEvent
    /** A dangerous command waits for the user (`POST /v1/runs/{run}/approval`). */
    data class Approval(val runId: String, val command: String?, val description: String?, val choices: List<String>) : HermesEvent
    /** The final answer; replaces whatever the deltas built. */
    data class Completed(val content: String, val sessionId: String?) : HermesEvent
    /** `run.completed`, `run.failed`, `run.cancelled`; the session id can change when Hermes compresses. */
    data class Finished(val status: String, val sessionId: String?, val reason: String?) : HermesEvent
    data class Failed(val message: String) : HermesEvent
    data object Done : HermesEvent

    companion object {
        fun decode(frame: SseFrame): HermesEvent? {
            val o = runCatching { HermesJson.parseToJsonElement(frame.data) as? JsonObject }.getOrNull() ?: return null
            val name = frame.event ?: o.string("event") ?: return null
            val runId = o.string("run_id")
            return when (name) {
                "run.started" -> runId?.let { RunStarted(it, o.string("session_id")) }
                "assistant.delta" -> o.string("delta")?.takeIf { it.isNotEmpty() }?.let(::Delta)
                // `_thinking` progress relays the model's own text, already streamed as deltas.
                "tool.progress" -> null
                "tool.started" -> ToolStarted(o.string("tool_name") ?: "tool", o.string("preview"))
                "tool.completed" -> ToolFinished(o.string("tool_name") ?: "tool", o.string("preview"), failed = false)
                "tool.failed" -> ToolFinished(o.string("tool_name") ?: "tool", o.string("preview"), failed = true)
                "assistant.commentary" -> o.string("text")?.let { Commentary(it, o.bool("already_streamed") == true) }
                "approval.request" -> runId?.let {
                    val choices = (o["choices"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
                    Approval(it, o.string("command"), o.string("description"), choices.ifEmpty { listOf("once", "deny") })
                }
                "assistant.completed" -> Completed(o.string("content").orEmpty(), o.string("session_id"))
                "error" -> Failed(o.string("message") ?: (o["error"] as? JsonObject)?.string("message") ?: "Hermes failed")
                "done" -> Done
                else -> if (name.startsWith("run.") && name != "run.queued") {
                    Finished(name.removePrefix("run."), o.string("session_id"), o.string("turn_exit_reason"))
                } else if (name == "run.queued") {
                    Failed("Another Hermes window holds this conversation; the message is queued there.")
                } else null
            }
        }
    }
}
