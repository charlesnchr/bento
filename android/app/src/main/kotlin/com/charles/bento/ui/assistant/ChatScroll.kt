package com.charles.bento.ui.assistant

/**
 * Where the user left a conversation: its first visible row, how far into it, how many messages
 * there were and how long the last one was, and whether they were at the bottom. Kept in a
 * preference, so switching tabs or screens, or a new process, comes back to the same place.
 */
internal data class ChatScroll(
    val session: String, val index: Int, val offset: Int, val messages: Int, val lastLength: Int, val pinned: Boolean,
) {
    fun encode() = "$index $offset $messages $lastLength ${if (pinned) 1 else 0} $session"

    /** Whether coming back scrolls to the end: only if the user was at the bottom and more has arrived since. */
    fun follows(count: Int, lastLength: Int) = pinned && (count != messages || lastLength != this.lastLength)

    companion object {
        /** The saved position, if it belongs to [session]. */
        fun restore(saved: String, session: String?): ChatScroll? {
            val p = saved.split(' ', limit = 6)
            if (session == null || p.size != 6 || p[5] != session) return null
            val n = p.take(4).map { it.toIntOrNull() ?: return null }
            return ChatScroll(session, n[0], n[1], n[2], n[3], p[4] == "1")
        }
    }
}
