package com.charles.bento.core.assistant.live

/**
 * How the call names its Hermes tasks to Gemini and the user: by what each is about ("Pennyworth
 * wake word"), never by number, since a number is what Gemini then reads out ("task one is
 * finished"). Also what a reply asks the user, whether the user's words answer a question, and
 * whether Gemini's speech relayed a result. Names are display and reference only: Hermes still
 * gets only the user's words.
 */
object TaskNames {
    /** The longest name, in characters. */
    const val MAX_NAME = 40

    private val stop = setOf(
        "a", "an", "the", "to", "of", "for", "in", "on", "at", "with", "from", "by", "about", "into", "and", "or", "but", "so",
        "me", "my", "i", "i'd", "i'm", "we", "our", "us", "you", "your", "it", "its", "it's", "this", "that", "these", "those", "there",
        "is", "are", "was", "be", "been", "am", "do", "does", "did", "can", "could", "would", "will", "should", "shall", "may", "might",
        "what", "what's", "how", "when", "where", "which", "who", "why", "whether", "if", "many", "much", "some", "any", "something",
        "please", "just", "also", "now", "right", "separately", "then", "really", "quite", "very", "one", "more", "thing", "things",
        "think", "find", "out", "look", "up", "tell", "check", "get", "give", "show", "make", "let", "let's", "see", "know", "want",
        "like", "need", "use", "using", "new", "different", "another", "better", "good", "nice", "currently", "current", "still",
        "hermes", "okay", "ok", "yeah", "yes", "no", "hey", "um", "uh", "oh", "well", "actually", "maybe", "because", "them", "they", "their", "then", "than",
    )
    /** Words between two named words that read better kept ("weather in Copenhagen", "book a table"). */
    private val joins = setOf("in", "on", "for", "with", "from", "of", "to", "a", "an", "the")

    private fun words(text: String) = text.lowercase().split(Regex("[^\\p{L}\\p{N}']+")).map { it.trim('\'') }.filter { it.isNotEmpty() }

    /** Distinctive words: a few letters long and not filler. */
    private fun distinctive(text: String) = words(text).filter { it.length >= 4 && it !in stop }.toSet()

    /** A name the user's own words give a task when Gemini gave none: up to three words of what was asked, from its first clause. */
    fun fromRequest(request: String): String {
        val said = TaskLabel.short(request)
        val clause = said.split(Regex("[.?!;:]|,\\s+(?:because|since|so|and|but)\\b")).firstOrNull { words(it).any { w -> w !in stop } } ?: said
        val all = clause.split(Regex("\\s+")).map { it.trim(',', '"', '\'', '(', ')') }.filter { it.isNotEmpty() }
        val picked = ArrayList<String>()
        var named = 0
        for (w in all) {
            val lower = w.lowercase()
            if (lower !in stop) { picked += w; named++ }
            else if (lower in joins && named > 0) picked += lower
            if (named == 3) break
        }
        while (picked.isNotEmpty() && picked.last().lowercase() in stop) picked.removeAt(picked.size - 1)
        val name = picked.joinToString(" ").ifEmpty { said.split(Regex("\\s+")).take(3).joinToString(" ") }
        return tidy(name.replaceFirstChar { it.lowercase() }) ?: "request"
    }

    /**
     * A name Gemini proposed, made safe to show and quote: letters, digits, spaces and a little
     * punctuation, no "task 2" of its own; null when nothing usable is left.
     */
    fun tidy(name: String?): String? {
        if (name == null) return null
        var text = name.replace(Regex("[^\\p{L}\\p{N} '&+-]"), " ").replace(Regex("\\s+"), " ").trim()
        text = text.replace(Regex("^(?:the\\s+)?(?:task|session)\\b\\s*(?:\\d+|one|two|three|four|five)?\\b\\s*", RegexOption.IGNORE_CASE), "")
            .replace(Regex("\\s+(?:task|session)$", RegexOption.IGNORE_CASE), "").trim()
        if (text.isEmpty() || text.all { it.isDigit() || it == ' ' }) return null
        if (text.length > MAX_NAME) text = text.take(MAX_NAME).substringBeforeLast(' ').ifEmpty { text.take(MAX_NAME) }
        return text
    }

    /**
     * [name], or if another task already has it, told apart by another word of [request] or "again",
     * cut to leave room for that so the result is still unique within [MAX_NAME].
     */
    fun unique(given: String, request: String, taken: Collection<String>): String {
        // A name that tidies to something else would fail every check below: settle it first.
        var name = given
        repeat(4) { name = tidy(name) ?: "request" }
        val used = taken.map { it.lowercase() }.toSet()
        if (name.lowercase() !in used) return name
        fun with(suffix: String): String? {
            val room = MAX_NAME - suffix.length - 1
            if (room < 3) return null
            val base = if (name.length <= room) name else name.take(room).substringBeforeLast(' ').ifEmpty { name.take(room) }
            return "$base $suffix".takeIf { tidy(it) == it && it.lowercase() !in used }
        }
        val have = words(name).toSet()
        for (w in words(TaskLabel.short(request))) {
            if (w in stop || w in have || w.length > 20) continue
            with(w)?.let { return it }
        }
        for (suffix in AGAIN) with(suffix)?.let { return it }
        // Past those, a letter or two: never a number, which Gemini would read out. More tasks than that can't share a name.
        for (n in 0 until 26 * 27) {
            var tag = ""
            var k = n
            do { tag = ('a' + k % 26) + tag; k = k / 26 - 1 } while (k >= 0)
            with("again $tag")?.let { return it }
        }
        return name
    }

    /** How a repeat of a name is told apart when the request has no other word. */
    private val AGAIN = listOf("again", "once more", "yet again", "anew", "afresh", "encore", "reprise", "redux")

    /**
     * The task Gemini means by [ref] among (name, request) pairs by key: its name, more or less
     * as given, or the one whose name and request share the most distinctive words with it.
     * Null when none fits or two fit equally.
     */
    fun <K> find(ref: String, tasks: Map<K, Pair<String, String>>): K? {
        val r = ref.lowercase().replace(Regex("[\"“”'`.]"), " ").replace(Regex("\\s+"), " ").trim()
            .removePrefix("the ").removeSuffix(" task").removeSuffix(" one").trim()
        if (r.isEmpty()) return null
        tasks.entries.firstOrNull { it.value.first.lowercase() == r }?.let { return it.key }
        tasks.entries.filter { val n = it.value.first.lowercase(); n in r || r in n }.singleOrNull()?.let { return it.key }
        val wanted = distinctive(r)
        if (wanted.isEmpty()) return null
        val scored = tasks.entries.map { it.key to (distinctive(it.value.first).count { w -> w in wanted } * 2 + distinctive(it.value.second).count { w -> w in wanted }) }
            .filter { it.second > 0 }.sortedByDescending { it.second }
        if (scored.isEmpty() || scored.size > 1 && scored[0].second == scored[1].second) return null
        return scored[0].first
    }

    /**
     * What [reply] asks the user, if anything: the last question in its spoken summary (Hermes
     * gives one first, then any detail after a blank line), or null.
     */
    fun question(reply: String): String? {
        val summary = reply.trim().split(Regex("\\n\\s*\\n")).firstOrNull()?.trim().orEmpty()
        val sentences = summary.split(Regex("(?<=[.?!])\\s+")).map { it.trim() }.filter { it.isNotEmpty() }
        val asked = sentences.lastOrNull { it.endsWith("?") } ?: return null
        return if (asked.length > 200) asked.take(200).substringBeforeLast(' ') + "…?" else asked
    }

    /** Openers that answer whatever follows them. */
    private val answer = Regex(
        "^(?:yes|yeah|yep|yup|yea|no|nope|nah|please do|go ahead|go for it|do it|do that|let's do (?:it|that)|start it|sounds good)\\b",
        RegexOption.IGNORE_CASE,
    )
    /** Openers that also start plenty of requests ("Okay, so…"): an answer only in a short reply. */
    private val shortAnswer = Regex(
        "^(?:ok(?:ay)?|sure|fine|correct|right|absolutely|definitely|that's fine|that works|let's go|the (?:first|second|third|last) one|neither|both)\\b",
        RegexOption.IGNORE_CASE,
    )
    /** Words that say a request is separate: any of them after a short opener, the clearest after any. */
    private val separate = Regex("\\b(?:separately|also|another|as well|a new|different thing|something else)\\b", RegexOption.IGNORE_CASE)
    private val clearlySeparate = Regex("\\b(?:separately|also|as well|something else|different thing)\\b", RegexOption.IGNORE_CASE)

    /**
     * The user's words are an answer to a question ("Yes, …", "Go ahead", "No", a short "Okay"), not a
     * request of their own: not when they say it's separate ("Okay, separately, find me a taxi").
     * "No, try another one" still answers.
     */
    fun isAnswer(words: String): Boolean {
        val said = words.trim().trimStart('"', '\'', ' ')
        if (answer.containsMatchIn(said)) return !clearlySeparate.containsMatchIn(said)
        return shortAnswer.containsMatchIn(said) && words(said).size <= 5 && !separate.containsMatchIn(said)
    }

    private val questionCue = Regex("\\?|\\b(?:shall i|should i|want me to|do you want|would you like|ok(?:ay)? to)\\b", RegexOption.IGNORE_CASE)

    /**
     * Gemini's [speech] asks [question], from the reply [result] of the task [name] asked as [request]:
     * it says one of the question's own words, those not already in the rest of the reply, the name or
     * the request, since the summary often names what the question is about. With none of its own, a
     * question cue ("shall I…", "?") has to be said.
     */
    fun says(speech: String, question: String, result: String = "", name: String = "", request: String = ""): Boolean {
        val rest = result.replace(question, " ")
        val own = distinctive(question) - distinctive(rest) - distinctive(name) - distinctive(request)
        if (own.isNotEmpty()) return distinctive(speech).any { it in own }
        return distinctive(question).isNotEmpty() && questionCue.containsMatchIn(speech)
    }

    /**
     * Gemini's [speech] relays the result [result] of the task [name], asked as [request]: it says
     * three of the reply's distinctive words besides those of the task's name and request (all of
     * them for a reply with two). Saying what the task is about isn't saying what came of it ("still
     * working on the Pennyworth training").
     */
    fun relays(speech: String, name: String, result: String, request: String = ""): Boolean {
        val said = distinctive(speech)
        if (said.isEmpty()) return false
        val summary = result.trim().split(Regex("\\n\\s*\\n")).firstOrNull().orEmpty().split(Regex("\\s+")).take(80).joinToString(" ")
        val reply = distinctive(summary) - distinctive(name) - distinctive(request)
        if (reply.size < 2) return false
        return reply.count { it in said } >= minOf(3, reply.size)
    }
}
