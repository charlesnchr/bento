package com.charles.bento.core.assistant.live

/** How the call screen names a task and its time: display only, Hermes still gets the user's words as said. */
object TaskLabel {
    private val opener = Regex("^(?:now|ok(?:ay)?|so|and|also|then|hey|right|alright|um+|uh+)\\b[\\s,.!]*", RegexOption.IGNORE_CASE)
    private val please = Regex("^please\\b[\\s,]*", RegexOption.IGNORE_CASE)
    // "Can you ask Hermes to", "Get Hermes to", "I'd like Hermes to", "Hermes, could you", "Could you": what's left is the request.
    private val fillers = listOf(
        // "Let Hermes know" and "Tell Hermes that" are the request itself; "Ask Hermes about" asks about the rest.
        Regex("^(?:can|could|would|will) you\\s+(?:please\\s+)?(?:(?:ask|get|have)\\s+hermes\\s+(?:to\\s+|about(?:\\s+|$))?|(?:tell|let)\\s+hermes\\s+to\\s+)", RegexOption.IGNORE_CASE),
        Regex("^(?:(?:ask|get|have)\\s+hermes\\s+(?:to\\s+|about(?:\\s+|$))?|(?:tell|let)\\s+hermes\\s+to\\s+)", RegexOption.IGNORE_CASE),
        Regex("^i(?:'d| would)? (?:like|want|need)\\s+hermes\\s+to\\s+", RegexOption.IGNORE_CASE),
        Regex("^(?:can|could|would|will) hermes\\s+(?:please\\s+)?", RegexOption.IGNORE_CASE),
        // Hermes addressed by name, not "Hermes's memory".
        Regex("^hermes\\s*,\\s*", RegexOption.IGNORE_CASE),
        Regex("^hermes\\s+(?:(?:can|could|would|will) you\\s+|(?=please\\b))", RegexOption.IGNORE_CASE),
        Regex("^(?:can|could|would|will) you\\s+(?:please\\s+)?", RegexOption.IGNORE_CASE),
    )
    private val trailing = Regex("[\\s,]*(?:,?\\s*please)?[\\s?.!]*$", RegexOption.IGNORE_CASE)

    /** [request] without the filler before what was asked ("Ask Hermes to …"), capitalised; as said if nothing's left. */
    fun short(request: String): String {
        val said = request.replace(Regex("\\s+"), " ").trim()
        var text = said
        while (true) {
            val before = text
            for (r in listOf(opener, please) + fillers) text = r.replace(text, "").trimStart()
            if (text == before) break
        }
        text = text.replace(trailing, "")
        if (text.isEmpty()) return said
        return text.replaceFirstChar { it.titlecase() }
    }

    /** Seconds as "0:42", "12:05" or "1:02:03". */
    fun elapsed(seconds: Long): String {
        val s = seconds.coerceAtLeast(0)
        val h = s / 3600
        val m = s % 3600 / 60
        val sec = s % 60
        return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%d:%02d".format(m, sec)
    }
}
