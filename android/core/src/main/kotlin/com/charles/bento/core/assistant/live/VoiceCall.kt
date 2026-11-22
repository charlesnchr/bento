package com.charles.bento.core.assistant.live

import kotlinx.coroutines.flow.StateFlow

/**
 * A voice call as the app drives it, whichever engine runs it: [CoreCall] (the shared voice core,
 * `voice-core/`, the logic the web surface, the Mac and the Echo run too) or [AssistantCall] (the
 * Kotlin call the core was ported from).
 */
interface VoiceCall {
    val status: StateFlow<AssistantCall.Status>
    /** The microphone has picked nothing up for a while, even after restarting. Cleared once it does. */
    val microphoneSilent: StateFlow<Boolean>
    /** Tasks waiting for the user's answer, by key, with what Hermes asked. */
    val questions: StateFlow<Map<String, String>>
    /** (role, text) fragments as they're heard: "user" for the user, "assistant" for Gemini. Called on the call's thread. */
    var onTranscript: ((String, String) -> Unit)?
    /** What the user is saying, before Gemini transcribes it; null takes it down. Called on the call's thread. */
    var onCaption: ((String?) -> Unit)?
    /** Tap-to-talk: while muted nothing reaches Gemini. */
    var muted: Boolean

    fun start()
    /** Brings a call in standby back now, to talk before Hermes finishes. */
    fun wake()
    /** Lends the microphone to a dictation while the call is in standby; false unless it is, and not already coming back. Any thread. */
    fun lend(): Boolean
    /** Takes back the microphone [lend] lent. Any thread. */
    fun reclaim()
    /** The screen's progress line for a task, for check_task and list_tasks. */
    fun progress(taskId: String, text: String)
    /** Cancels one running task; the call and the other tasks go on. */
    fun cancelTask(taskId: String)
    /** Ends the call at once; running Hermes tasks are cancelled, not undone. */
    fun stop(message: String? = null)
}

/** What a tool run came to: the words for Gemini, and whether it failed (a failure stays out of the recap). */
data class ToolReply(val text: String, val failed: Boolean = false)
