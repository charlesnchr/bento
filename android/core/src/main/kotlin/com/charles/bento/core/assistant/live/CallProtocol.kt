package com.charles.bento.core.assistant.live

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import kotlinx.serialization.json.addJsonObject

/** A spoken request for Hermes: the user's own transcribed words, and what was said before them. */
data class HermesCall(val id: String, val task: String, val context: String)

/**
 * Port of the Mac's `GeminiLiveProtocol`. A function call is only a request ID: Hermes
 * gets the user's own transcribed, unconsumed words, never text the voice model wrote,
 * and transcripts never execute alone.
 *
 * Gemini marks each user turn with voiceActivity ACTIVITY_START and ACTIVITY_END; the
 * transcript arrives inside that window and the call just after it. A call belongs to the
 * turn it answers, so earlier speech the model never acted on and follow-ups after the call
 * are never its request, and a transcript that trails the call still joins its own turn.
 */
class CallProtocol {
    data class Delegation(val id: String, val at: Double, val turn: Int?)
    data class TurnState(val complete: Boolean, val changed: Double?)

    private class Turn(val id: Int, val started: Double) {
        var ended: Double? = null
        var heard: Double? = null
        val text = StringBuilder()
        var consumed = false
        /** Its first words may be the previous turn's late transcript. */
        var ambiguous = false
    }

    private data class Fragment(val role: String, val at: Double, val text: String)

    private val seen = HashSet<String>()
    private val turns = ArrayList<Turn>()
    private val history = ArrayList<Fragment>()
    private var nextTurn = 0

    /** A new user turn begins (ACTIVITY_START). */
    fun activityStarted(at: Double) {
        if (!at.isFinite() || at < (turns.lastOrNull()?.started ?: 0.0)) return
        val turn = Turn(nextTurn, at)
        val previous = turns.lastOrNull()
        if (previous != null && previous.text.isEmpty() && (previous.ended?.let { at - it < 3 } ?: true)) turn.ambiguous = true
        turns.add(turn)
        nextTurn++
        if (turns.size > 32) turns.removeAt(0)
    }

    /** The current user turn ends (ACTIVITY_END). */
    fun activityEnded(at: Double) {
        val last = turns.lastOrNull() ?: return
        if (!at.isFinite() || last.ended != null || at < last.started) return
        last.ended = at
    }

    /** Records a transcript fragment for context and, for the user, the current turn. */
    fun transcript(role: String, text: String, at: Double) {
        if (role != "user" && role != "assistant") return
        if (text.isEmpty() || text.toByteArray().size > 12_000 || !at.isFinite() || at < (history.lastOrNull()?.at ?: 0.0)) return
        history.add(Fragment(role, at, text))
        while (history.size > 128 || history.sumOf { it.text.toByteArray().size } > 12_000) history.removeAt(0)
        // User words join the latest turn even after its end; a consumed turn keeps its late
        // words, so they can never run.
        if (role != "user") return
        val last = turns.lastOrNull() ?: return
        // Past 4,000 characters a turn never runs, so it stops growing.
        if (last.text.length <= 4000) last.text.append(text)
        last.heard = at
    }

    /** A new call of the one tool, or null for anything else (unknown name, repeated or bad ID). */
    fun delegation(name: String?, id: String?, at: Double): Delegation? {
        if (name != TOOL || id.isNullOrEmpty() || id.length >= 200 || id in seen || seen.size >= 256 || !at.isFinite() || at < 0) return null
        seen.add(id)
        val started = turns.filter { it.started <= at }
        var turn = started.lastOrNull()
        // The model answers a turn just after its end, so a turn still open when the call
        // arrives is a follow-up to one that ended moments before. If an unanswered turn
        // ended a little earlier, which turn the call answers is unclear and nothing runs.
        if (turn != null && turn.ended == null && started.size > 1) {
            val before = started[started.size - 2]
            val end = before.ended
            if (!before.consumed && end != null && end >= at - 8) turn = if (at - end <= 2) before else null
        }
        return Delegation(id, at, turn?.id)
    }

    /** Whether the call's turn has ended with words, and when it last changed. */
    fun turnState(d: Delegation): TurnState {
        val turn = turns.firstOrNull { it.id == d.turn } ?: return TurnState(false, null)
        return TurnState(turn.ended != null && turn.text.isNotEmpty(), listOfNotNull(turn.ended, turn.heard).maxOrNull())
    }

    /** Consumes a declined call's turn so a later call cannot replay it. */
    fun discardRequest(d: Delegation) {
        turns.firstOrNull { it.id == d.turn }?.consumed = true
    }

    fun request(d: Delegation): HermesCall? {
        val turn = turns.firstOrNull { it.id == d.turn } ?: return null
        if (turn.consumed) return null
        turn.consumed = true
        // Speech the model left unanswered for long is not this call's request.
        val ended = turn.ended ?: return null
        if (ended < d.at - 8 || turn.ambiguous || turn.text.length > 4000) return null
        val task = turn.text.toString().trim()
        if (task.isEmpty()) return null
        val context = history.filter { it.at < turn.started }.joinToString("\n") { "${it.role}: ${it.text}" }
        return HermesCall(d.id, task, context.takeLast(6000))
    }

    companion object {
        const val TOOL = "ask_hermes"

        /**
         * A function response in the shape Google asks for: status, retryable and a message.
         * WHEN_IDLE waits for the user to finish speaking, so the model always says the outcome.
         */
        fun response(id: String, name: String = TOOL, message: String, executed: Boolean): String = buildJsonObject {
            putJsonObject("toolResponse") {
                putJsonArray("functionResponses") {
                    addJsonObject {
                        put("id", id)
                        put("name", name)
                        put("scheduling", "WHEN_IDLE")
                        putJsonObject("response") {
                            put("status", if (executed) "ok" else "not_executed")
                            put("retryable", false)
                            put("message", excerpt(message))
                        }
                    }
                }
            }
        }.toString()

        /** Long Hermes replies are on screen; the model gets enough to speak a summary. */
        fun excerpt(result: String): String {
            if (result.isEmpty()) return "Hermes returned no text. Do not infer success."
            if (result.length <= 4000) return result
            return "Truncated excerpt. Full reply is visible in Bento's assistant screen: " + result.take(4000)
        }

        internal fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
    }
}
