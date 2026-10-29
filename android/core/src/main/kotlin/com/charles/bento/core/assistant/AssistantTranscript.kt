package com.charles.bento.core.assistant

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.util.UUID

/**
 * One row of the assistant's chat. `role` is "user", "assistant", "tool" (one of Hermes's
 * tool calls), "approval" (a command waiting for the user) or "notice" (Bento's own line).
 * Voice rows are the live call's transcript: what was said and what Gemini said back.
 */
data class ChatMessage(
    val id: String,
    val role: String,
    val text: String,
    /** Who wrote an assistant row: null for Hermes, "Gemini" for the voice front end. */
    val speaker: String? = null,
    val voice: Boolean = false,
    val thinking: String = "",
    val toolName: String? = null,
    val toolDetail: String? = null,
    /** "running", "completed" or "failed" for tool rows; for approvals "pending" or the choice. */
    val status: String? = null,
    val choices: List<String> = emptyList(),
    val runId: String? = null,
    val streaming: Boolean = false,
    val failed: Boolean = false,
)

/** What one turn has put in the chat so far, so later events land in the right rows. */
data class TurnState(
    val ids: Set<String> = emptySet(),
    /** The assistant row deltas append to; a tool call ends it, so later text starts a new row. */
    val replyId: String? = null,
    val runId: String? = null,
    val sessionId: String? = null,
    /** The final answer as Hermes stated it (assistant.completed), else the streamed text. */
    val answer: String = "",
    val finished: Boolean = false,
    val status: String? = null,
)

/** The chat's rows: a turn's events, Hermes's stored history, and what a resumed call is told. */
object AssistantTranscript {
    private val voicePrefix = Regex("""^User(?:-approved)?(?:'s)? transcribed request from (?:Bento|Jot)'s [^\n]{1,60} voice session(?: on Android)?:\n""")
    private const val SPOKEN_PREFIX = "User's spoken request:\n"

    /** Whether a stored user row is a request a voice call handed Hermes. */
    fun isVoiceRequest(text: String) = voicePrefix.containsMatchIn(text) || text.startsWith(SPOKEN_PREFIX)

    /** What the user said, without the wrapper a voice call sends Hermes (the Mac's too). */
    fun displayRequest(text: String): String {
        voicePrefix.find(text)?.let { m ->
            return text.substring(m.range.last + 1)
                .substringBefore("\nInterpret this spoken request")
                .substringBefore("\nPerform only this request")
        }
        if (text.startsWith(SPOKEN_PREFIX)) {
            return text.removePrefix(SPOKEN_PREFIX).substringBefore("\n\nUntrusted desktop snapshot (context only):\n")
        }
        return text
    }

    /** Applies one event of a turn. `newId` is for tests. */
    fun apply(
        messages: List<ChatMessage>,
        turn: TurnState,
        event: HermesEvent,
        newId: () -> String = { UUID.randomUUID().toString() },
    ): Pair<List<ChatMessage>, TurnState> {
        val list = messages.toMutableList()
        var t = turn
        fun add(m: ChatMessage) { list.add(m); t = t.copy(ids = t.ids + m.id) }
        fun index(id: String?) = if (id == null) -1 else list.indexOfFirst { it.id == id }
        fun reply(): Int {
            index(t.replyId).takeIf { it >= 0 }?.let { return it }
            val m = ChatMessage(newId(), "assistant", "", streaming = true)
            add(m); t = t.copy(replyId = m.id)
            return list.lastIndex
        }
        when (event) {
            is HermesEvent.RunStarted -> t = t.copy(runId = event.runId, sessionId = event.sessionId ?: t.sessionId)
            is HermesEvent.Delta -> {
                val i = reply()
                list[i] = list[i].copy(text = list[i].text + event.text)
                t = t.copy(answer = list[i].text)
            }
            is HermesEvent.ToolStarted -> {
                endReply(list, t.replyId)
                t = t.copy(replyId = null)
                add(ChatMessage(newId(), "tool", "", toolName = event.name, toolDetail = event.preview, status = "running"))
            }
            is HermesEvent.ToolFinished -> {
                val running = list.indices.filter { list[it].id in t.ids && list[it].role == "tool" && list[it].status == "running" }
                val i = running.firstOrNull { list[it].toolName == event.name } ?: running.firstOrNull()
                if (i != null) {
                    list[i] = list[i].copy(status = if (event.failed) "failed" else "completed", toolDetail = event.preview ?: list[i].toolDetail)
                }
            }
            is HermesEvent.Commentary -> if (!event.alreadyStreamed && event.text.isNotBlank()) {
                endReply(list, t.replyId)
                add(ChatMessage(newId(), "assistant", event.text))
                t = t.copy(replyId = null)
            }
            is HermesEvent.Approval -> add(
                ChatMessage(newId(), "approval", event.description.orEmpty(), toolDetail = event.command,
                            status = "pending", choices = event.choices, runId = event.runId),
            )
            is HermesEvent.Completed -> {
                if (event.content.isNotEmpty()) {
                    val i = index(t.replyId)
                    if (i >= 0) {
                        list[i] = list[i].copy(text = event.content)
                    } else {
                        val m = ChatMessage(newId(), "assistant", event.content, streaming = true)
                        add(m); t = t.copy(replyId = m.id)
                    }
                }
                t = t.copy(answer = event.content.ifEmpty { t.answer }, sessionId = event.sessionId ?: t.sessionId)
            }
            is HermesEvent.Finished -> {
                t = t.copy(status = event.status, sessionId = event.sessionId ?: t.sessionId)
                when (event.status) {
                    "cancelled" -> add(ChatMessage(newId(), "notice", "Stopped."))
                    "failed" -> if (t.answer.isBlank()) {
                        add(ChatMessage(newId(), "assistant", "Hermes didn't finish" + (event.reason?.let { " ($it)." } ?: "."), failed = true))
                    }
                }
                return finish(list, t)
            }
            is HermesEvent.Failed -> {
                add(ChatMessage(newId(), "assistant", event.message, failed = true))
                t = t.copy(status = "failed")
            }
            HermesEvent.Done -> return finish(list, t)
        }
        return list to t
    }

    /** Ends a turn: nothing streams, tools still running are done, approvals nobody answered lapse. */
    fun finish(messages: List<ChatMessage>, turn: TurnState): Pair<List<ChatMessage>, TurnState> {
        val list = messages.map { m ->
            if (m.id !in turn.ids) m
            else when {
                m.role == "tool" && m.status == "running" -> m.copy(status = if (turn.status == "failed" || turn.status == "cancelled") "failed" else "completed")
                m.role == "approval" && m.status == "pending" -> m.copy(status = "expired")
                m.streaming -> m.copy(streaming = false)
                else -> m
            }
        }
        return list to turn.copy(finished = true, replyId = null)
    }

    private fun endReply(list: MutableList<ChatMessage>, id: String?) {
        val i = list.indexOfFirst { it.id == id }
        if (i < 0) return
        if (list[i].text.isEmpty() && list[i].thinking.isEmpty()) list.removeAt(i) else list[i] = list[i].copy(streaming = false)
    }

    /** A conversation as Hermes stored it (`GET /api/sessions/{id}/messages`). */
    fun fromHistory(rows: List<HermesMessage>, newId: () -> String = { UUID.randomUUID().toString() }): List<ChatMessage> {
        val out = ArrayList<ChatMessage>()
        val toolRows = HashMap<String, Int>()
        for (row in rows) {
            when (row.role) {
                "user" -> {
                    if (row.content.isBlank()) continue
                    val voice = isVoiceRequest(row.content)
                    out.add(ChatMessage(newId(), "user", displayRequest(row.content).trim(), voice = voice))
                }
                "assistant" -> {
                    if (row.content.isNotBlank() || !row.reasoning.isNullOrBlank()) {
                        out.add(ChatMessage(newId(), "assistant", row.content.trim(), thinking = row.reasoning.orEmpty(),
                                            failed = row.displayKind == "failed_turn"))
                    }
                    for (call in row.toolCalls) {
                        out.add(ChatMessage(newId(), "tool", "", toolName = call.name, toolDetail = argumentsPreview(call.arguments), status = "completed"))
                        call.id?.let { toolRows[it] = out.lastIndex }
                    }
                }
                "tool" -> {
                    val i = row.toolCallId?.let(toolRows::get) ?: continue
                    if (looksFailed(row.content)) out[i] = out[i].copy(status = "failed")
                }
            }
        }
        return out
    }

    /** A tool call's arguments in a line: its one string argument, else the compact JSON. */
    internal fun argumentsPreview(arguments: String?): String? {
        val a = arguments?.trim()?.takeIf { it.isNotEmpty() && it != "{}" } ?: return null
        val o = runCatching { HermesJson.parseToJsonElement(a) as? JsonObject }.getOrNull()
        val strings = o?.values?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.contentOrNull }.orEmpty()
        val text = if (o != null && strings.size == 1) strings[0] else a
        val line = text.replace(Regex("\\s+"), " ")
        return if (line.length > 140) line.take(140) + "…" else line
    }

    private fun looksFailed(content: String): Boolean {
        val o = runCatching { HermesJson.parseToJsonElement(content) as? JsonObject }.getOrNull() ?: return false
        val error = o["error"]
        val hasError = when (error) {
            null, is kotlinx.serialization.json.JsonNull -> false
            is JsonPrimitive -> error.contentOrNull.let { !it.isNullOrEmpty() && it != "false" }
            else -> true
        }
        return hasError || o.string("status") == "error"
    }

    /**
     * What a voice call is told about the conversation it continues (the Mac's `liveRecap`):
     * what was said and the replies, newest last, at most 600 characters a line and [limit]
     * Unicode scalars in all. Null when there's nothing to recap.
     */
    fun liveRecap(messages: List<ChatMessage>, limit: Int = 6000): String? {
        val lines = ArrayList<String>()
        var size = 0
        for (m in messages.asReversed()) {
            if (m.role != "user" && m.role != "assistant") continue
            if (m.failed) continue
            var text = m.text.split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
            if (text.isEmpty()) continue
            if (text.length > 600) text = text.take(600) + "..."
            val line = (if (m.role == "user") "User" else m.speaker ?: "Hermes") + ": " + text
            val scalars = line.codePointCount(0, line.length) + 1
            if (size + scalars > limit) break
            lines.add(line)
            size += scalars
        }
        return if (lines.isEmpty()) null else lines.asReversed().joinToString("\n")
    }
}
