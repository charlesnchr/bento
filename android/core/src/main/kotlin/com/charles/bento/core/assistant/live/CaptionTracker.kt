package com.charles.bento.core.assistant.live

/**
 * Which of the captioner's guesses ([CallCaptions]) is on screen, for a call the shared voice core
 * runs ([CoreCall]): the core doesn't know captions, so its host keeps them. The rules are
 * [AssistantCall]'s. A guess shows until Gemini's own transcript of those words arrives, and words
 * Gemini has transcribed never come back as a caption; the captioner hears the same audio as it's
 * spoken, so an utterance of its that started by the end of a turn Gemini transcribed is in that
 * transcript.
 *
 * Not thread-safe: the call's thread only. Times are the call's clock, in seconds.
 */
internal class CaptionTracker(
    /** Seconds a caption stays after its utterance ended, if Gemini sends no transcript to replace it. */
    private val linger: Double = 4.0,
    /** The caption to show, or null to take it down. */
    private val show: (String?) -> Unit,
) {
    private class GeminiTurn(val started: Double) {
        var ended: Double? = null
        var transcribed = false
        /** A transcript that came during it went to an earlier turn. */
        var lent = false
    }

    /** The caption on screen, and when the captioner's utterance it came from started. */
    private var text: String? = null
    private var shownFrom: Double? = null
    /** Gemini's recent user turns, and when the last one it transcribed ended (or its transcript came, if that was first). */
    private val turns = ArrayDeque<GeminiTurn>()
    private var transcribedUntil: Double? = null
    /** When the captioner's current utterance started, its latest guess, and how many of its words Gemini has transcribed. */
    private var utteranceAt: Double? = null
    private var guess = ""
    private var wordsTranscribed = 0
    /** When the captioned utterance ended, for taking down a caption Gemini never replaces. */
    private var endedAt: Double? = null

    /** Gemini heard a user turn begin (ACTIVITY_START). */
    fun activityStarted(t: Double) {
        turns.addLast(GeminiTurn(t))
        if (turns.size > 8) turns.removeFirst()
    }

    /** Gemini heard the user's turn end (ACTIVITY_END). */
    fun activityEnded(t: Double) {
        val turn = turns.lastOrNull()?.takeIf { it.ended == null } ?: return
        turn.ended = t
        // A transcript lent to an earlier turn while this one went on, and none of its own: it was this one's.
        if (!turn.transcribed && turn.lent) {
            turn.transcribed = true
            transcribedUntil = maxOf(transcribedUntil ?: 0.0, t)
            if (transcribed()) {
                wordsTranscribed = words(guess).size
                if (shownFrom?.let { it <= transcribedUntil!! } == true) takeDown()
            }
        } else if (turn.transcribed) transcribedUntil = maxOf(transcribedUntil ?: 0.0, t)
    }

    /**
     * Gemini's transcript of the user's [words] arrived. [deliver] hands them on: whoever shows them
     * takes the caption down in the same update, and a caption of later words then comes straight back.
     */
    fun userTranscript(t: Double, words: String, deliver: () -> Unit) {
        transcribedUntil = maxOf(transcribedUntil ?: 0.0, transcribedTurnEnd(t))
        // Covered: this transcript's words, but no more than the captioner has guessed so far (the transcript
        // may span earlier utterances of its; a late one may come after the user has said more).
        if (transcribed()) wordsTranscribed = minOf(words(guess).size, wordsTranscribed + words(words).size)
        val later = text.takeIf { shownFrom?.let { from -> from > transcribedUntil!! } == true }
        if (later == null) endedAt = null
        text = null
        deliver()
        later?.let { showCaption(it, shownFrom!!) }
    }

    /** What the captioner heard. In [standby] nothing shows: the microphone is unheard there. */
    fun caption(caption: Caption, t: Double, standby: Boolean) {
        when (caption) {
            is Caption.Started -> { utteranceAt = caption.at ?: t; guess = ""; wordsTranscribed = 0; endedAt = null }
            is Caption.Partial -> {
                val from = utteranceAt ?: t.also { utteranceAt = it }
                guess = caption.text
                if (standby) return
                // Guesses at words Gemini has transcribed are stale. Once Gemini hears a new turn
                // and the captioner hasn't split there, what follows those words is the new turn's.
                val fresh = when {
                    !transcribed() -> caption.text
                    turns.lastOrNull()?.let { it.started > transcribedUntil!! } == true -> words(caption.text).drop(wordsTranscribed).joinToString(" ")
                    else -> ""
                }
                if (fresh.isBlank()) return
                endedAt = null
                showCaption(fresh, from)
            }
            Caption.Ended -> if (text != null) endedAt = t
        }
    }

    /** Now and then: a caption whose utterance ended [linger] ago, and that Gemini never transcribed, comes down. */
    fun tick(t: Double) {
        endedAt?.let { if (t - it >= linger) takeDown() }
    }

    fun takeDown() {
        endedAt = null
        if (text == null) return
        text = null
        show(null)
    }

    private fun showCaption(words: String, from: Double) {
        text = words
        shownFrom = from
        show(words)
    }

    private fun words(text: String) = text.split(Regex("\\s+")).filter { it.isNotEmpty() }

    /**
     * The turn a user transcript belongs to, marked transcribed, and when it ended (now if it
     * hasn't). Gemini sends a turn's words with its ACTIVITY_END, so they're the latest turn's,
     * unless an earlier one ended just now without words: then they trail it.
     */
    private fun transcribedTurnEnd(t: Double): Double {
        val latest = turns.lastOrNull() ?: return t
        // The latest turn's own words come after Gemini has heard its closing silence.
        val owner = turns.takeIf { t - latest.started < AssistantCall.TURN_SILENCE }?.firstOrNull { turn ->
            turn !== latest && !turn.transcribed && turn.ended?.let { t - it <= AssistantCall.LATE_TRANSCRIPT } == true
        } ?: latest
        owner.transcribed = true
        if (owner !== latest) latest.lent = true
        return owner.ended ?: t
    }

    private fun transcribed(): Boolean {
        val caption = utteranceAt ?: return false
        val until = transcribedUntil ?: return false
        return caption <= until
    }
}
