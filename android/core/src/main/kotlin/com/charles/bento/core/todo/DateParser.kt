package com.charles.bento.core.todo

import com.charles.bento.core.fielddoc.SwiftChars
import com.charles.bento.core.fielddoc.SwiftText
import java.time.DateTimeException
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** A half-open UTF-16 range in a text (NSRange / Android `Spannable` coordinates). */
data class TextRange(val start: Int, val end: Int) {
    val length: Int get() = end - start

    /** Swift `Range.overlaps`: an element in common (empty ranges overlap nothing). */
    fun overlaps(o: TextRange): Boolean = !(o.end <= start || end <= o.start || start == end || o.start == o.end)

    fun of(text: String): String = text.substring(start, end)
}

/**
 * Natural-language due dates, Todoist-like: "tomorrow 5pm", "fri", "next week", "in 3
 * days", "oct 25", "25/10", "2026-10-25", "at 17:00", "no date". Exact port of the Mac's
 * `DateParser` (see its doc comment for the choices where Todoist is ambiguous).
 *
 * Text is split into whitespace-separated words (surrounding brackets, quotes and trailing
 * punctuation dropped), so phrases only ever match whole words: "mon" never matches inside
 * "monkey", "#tomorrow" (a project) or "a/tomorrow" (a URL).
 *
 * - A weekday alone ("wed") is its next occurrence strictly after today; "this wed" may be
 *   today. "next fri" is Friday of next week (weeks start Monday). "next week" is next Monday.
 * - "weekend"/"this weekend" is Saturday (today on a weekend); "next weekend" is next week's
 *   Saturday. "next month"/"next year" are the 1st.
 * - Month names need a day ("may 5", "5 may").
 * - "25/10" is day-first; "10/25" is month-first only because 25 can't be a month. Dates
 *   without a year that already passed roll to next year.
 * - A time alone is today, even if passed. Times without am/pm are 24 h. noon 12:00,
 *   midnight 00:00, eod 17:00, morning 09:00, afternoon 13:00, evening 19:00; "tonight" 19:00.
 * - [find] (free text) is stricter than [parse]: a bare hour needs "at", "morning" etc. need
 *   a date or "this", and "tom" isn't tomorrow.
 *
 * Days are computed in `zone` from `now`; pass both explicitly in tests.
 */
object DateParser {
    /** What a phrase means: a due date, or "no date" / "no due date" (clear it). */
    sealed class Phrase {
        data class Due(val due: DueDate) : Phrase()
        data object Clear : Phrase()
    }

    data class Match(val range: TextRange, val phrase: Phrase)

    /** Parses a whole string as a date phrase ("tomorrow 5pm"); null if it isn't one entirely. */
    fun parse(text: String, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): DueDate? =
        (parsePhrase(text, now, zone) as? Phrase.Due)?.due

    /** Like [parse], but also recognises "no date" as [Phrase.Clear]. */
    fun parsePhrase(text: String, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): Phrase? {
        val words = tokenize(text, emptyList())
        val g = Grammar(words.map { it.text }, today(now, zone), strict = false, allowClear = true)
        val (phrase, end) = g.phrase(0) ?: return null
        return if (end == words.size) phrase else null
    }

    /** Finds the longest date phrase inside free text (for quick add): its range and value. */
    fun find(text: String, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): Pair<TextRange, DueDate>? {
        val m = findPhrase(text, emptyList(), now, zone, allowClear = false) ?: return null
        return (m.phrase as? Phrase.Due)?.let { m.range to it.due }
    }

    /**
     * The longest phrase in `text` (the last one on ties). Words overlapping `excluding`
     * (e.g. a "#Plan Tomorrow" project token) never take part in a phrase.
     */
    fun findPhrase(
        text: String, excluding: List<TextRange> = emptyList(), now: Instant = Instant.now(),
        zone: ZoneId = ZoneId.systemDefault(), allowClear: Boolean = true,
    ): Match? {
        val words = tokenize(text, excluding)
        val g = Grammar(words.map { it.text }, today(now, zone), strict = true, allowClear = allowClear)
        var best: Match? = null
        var bestLength = 0
        for (i in words.indices) {
            val (phrase, end) = g.phrase(i) ?: continue
            val range = TextRange(words[i].range.start, words[end - 1].range.end)
            if (range.length >= bestLength) {
                best = Match(range, phrase)
                bestLength = range.length
            }
        }
        return best
    }

    private fun today(now: Instant, zone: ZoneId): LocalDate = now.atZone(zone).toLocalDate()

    // MARK: - Words

    /** A word: its lowercased text (NFC, so it compares like a Swift String) and UTF-16 range. */
    data class Word(val text: String, val range: TextRange)

    private val leading = setOf("(", "[", "\"", "'", "“", "‘")
    private val trailing = setOf(".", ",", ";", ":", "!", "?", ")", "]", "\"", "'", "”", "’")

    /** Stands in for an excluded word: matches nothing, so phrases can't span it. */
    private const val BARRIER = "\u0001"

    /** Lowercased whitespace-separated words without surrounding punctuation. */
    fun tokenize(text: String, excluding: List<TextRange>): List<Word> {
        val c = SwiftChars(text)
        val out = ArrayList<Word>()
        var i = 0
        while (i < c.count) {
            if (c.isWhitespace(i)) { i++; continue }
            var j = i
            while (j < c.count && !c.isWhitespace(j)) j++
            var lo = i
            var hi = j
            while (lo < hi && c.nfc(lo) in leading) lo++
            while (hi > lo && c.nfc(hi - 1) in trailing) hi--
            val whole = TextRange(c.offset(i), c.offset(j))
            if (excluding.any { it.overlaps(whole) }) {
                out += Word(BARRIER, whole)
            } else if (lo < hi) {
                out += Word(SwiftText.nfc(SwiftText.lowercased(c.substring(lo, hi))), TextRange(c.offset(lo), c.offset(hi)))
            }
            i = j
        }
        return out
    }

    // MARK: - Grammar

    private class Clock(val hour: Int, val minute: Int)

    /** A date as Foundation's Gregorian calendar names it (years before 1583 are Julian there). */
    private class Day(val y: Int, val m: Int, val d: Int) {
        constructor(date: LocalDate) : this(date.year, date.monthValue, date.dayOfMonth)

        override fun toString() = DueDate.dayString(y, m, d)
    }

    private val weekdays = mapOf( // Calendar weekday: 1 = Sunday … 7 = Saturday
        "sunday" to 1, "sun" to 1, "monday" to 2, "mon" to 2, "tuesday" to 3, "tue" to 3, "tues" to 3,
        "wednesday" to 4, "wed" to 4, "weds" to 4, "thursday" to 5, "thu" to 5, "thur" to 5, "thurs" to 5,
        "friday" to 6, "fri" to 6, "saturday" to 7, "sat" to 7,
    )
    private val months = mapOf(
        "january" to 1, "jan" to 1, "february" to 2, "feb" to 2, "march" to 3, "mar" to 3, "april" to 4, "apr" to 4,
        "may" to 5, "june" to 6, "jun" to 6, "july" to 7, "jul" to 7, "august" to 8, "aug" to 8,
        "september" to 9, "sep" to 9, "sept" to 9, "october" to 10, "oct" to 10, "november" to 11, "nov" to 11,
        "december" to 12, "dec" to 12,
    )
    private val amounts = mapOf(
        "a" to 1, "an" to 1, "one" to 1, "two" to 2, "three" to 3, "four" to 4, "five" to 5, "six" to 6,
        "seven" to 7, "eight" to 8, "nine" to 9, "ten" to 10, "eleven" to 11, "twelve" to 12,
    )
    private val namedTimes = mapOf("noon" to Clock(12, 0), "midday" to Clock(12, 0), "midnight" to Clock(0, 0), "eod" to Clock(17, 0))

    /** Times of day that are ordinary words too; see `strict`. */
    private val vagueTimes = mapOf("morning" to Clock(9, 0), "afternoon" to Clock(13, 0), "evening" to Clock(19, 0))
    private val meridiems = setOf("am", "pm", "a", "p", "a.m", "p.m")

    /**
     * Recursive descent over lowercased words:
     *
     *     phrase := "no" ["due"] "date"
     *             | ["on"] day [["at"] time]
     *             | time [["on"] day]
     */
    private class Grammar(val words: List<String>, val today: LocalDate, val strict: Boolean, val allowClear: Boolean) {
        fun word(i: Int): String = if (i < words.size) words[i] else ""

        /** The longest phrase starting at word `i` and the index after it. */
        fun phrase(i: Int): Pair<Phrase, Int>? {
            if (allowClear && word(i) == "no") {
                if (word(i + 1) == "date") return Phrase.Clear to i + 2
                if (word(i + 1) == "due" && word(i + 2) == "date") return Phrase.Clear to i + 3
            }
            val a = dayFirst(i)
            val b = timeFirst(i)
            if (a != null && b != null) return if (b.second > a.second) b else a
            return a ?: b
        }

        private fun dayFirst(i: Int): Pair<Phrase, Int>? {
            val (date, defaultTime, end) = day(if (word(i) == "on") i + 1 else i) ?: return null
            if (word(end) == "at") time(end + 1, afterAt = true)?.let { (clock, _, e) -> return due(date, clock) to e }
            time(end, afterAt = false)?.let { (clock, _, e) -> return due(date, clock) to e }
            return due(date, defaultTime) to end
        }

        private fun timeFirst(i: Int): Pair<Phrase, Int>? {
            val at = word(i) == "at"
            val (clock, vague, end) = time(if (at) i + 1 else i, afterAt = at) ?: return null
            day(if (word(end) == "on") end + 1 else end)?.let { (date, _, e) -> return due(date, clock) to e }
            if (strict && vague) return null
            return due(Day(today), clock) to end
        }

        private fun due(date: Day, clock: Clock?): Phrase =
            Phrase.Due(DueDate(date.toString(), clock?.let { DueDate.timeString(it.hour, it.minute) }))

        // MARK: Times

        /** A time at word `i`: its clock, whether it's a vague word ("morning"), and the end. */
        private fun time(i: Int, afterAt: Boolean): Triple<Clock, Boolean, Int>? {
            val w = word(i)
            if (w == "this") vagueTimes[word(i + 1)]?.let { return Triple(it, false, i + 2) }
            namedTimes[w]?.let { return Triple(it, false, i + 1) }
            vagueTimes[w]?.let { return Triple(it, true, i + 1) }
            return clock(i, bare = afterAt || !strict)?.let { Triple(it.first, false, it.second) }
        }

        /** "5pm", "5:30pm", "5 pm", "17:00", "9:05" and, if `bare`, "17". */
        private fun clock(i: Int, bare: Boolean): Pair<Clock, Int>? {
            val s = word(i)
            var p = 0
            var hour = 0
            var minute = 0
            while (p < s.length && p < 2 && digit(s[p]) != null) { hour = hour * 10 + digit(s[p])!!; p++ }
            if (p == 0) return null
            val hasMinutes = p < s.length && s[p] == ':'
            if (hasMinutes) {
                if (s.length < p + 3) return null
                val a = digit(s[p + 1]) ?: return null
                val b = digit(s[p + 2]) ?: return null
                minute = a * 10 + b
                p += 3
            }
            var meridiem = s.substring(p)
            var end = i + 1
            if (meridiem.isEmpty() && word(i + 1) in setOf("am", "pm", "a.m", "p.m")) { meridiem = word(i + 1); end++ }
            if (!(meridiem.isEmpty() || meridiem in meridiems) || minute >= 60) return null
            if (meridiem.isEmpty()) {
                if (!(hasMinutes || bare) || hour >= 24) return null
            } else {
                if (hour !in 1..12) return null
                hour = hour % 12 + (if (meridiem.startsWith("p")) 12 else 0)
            }
            return Clock(hour, minute) to end
        }

        // MARK: Days

        /** A day at word `i`: the date, a default time ("tonight"), and the end. */
        private fun day(i: Int): Triple<Day, Clock?, Int>? {
            val w = word(i)
            val next = word(i + 1)
            when (w) {
                "today", "tod" -> return Triple(Day(today), null, i + 1)
                "tomorrow", "tmr", "tmrw" -> return Triple(add(1), null, i + 1)
                "tom" -> if (!strict) return Triple(add(1), null, i + 1)
                "yesterday" -> return Triple(add(-1), null, i + 1)
                "tonight" -> return Triple(Day(today), Clock(19, 0), i + 1)
                "weekend" -> return Triple(weekend(), null, i + 1)
                "this" -> {
                    weekdays[next]?.let { wd -> return Triple(add((wd - weekday + 7) % 7), null, i + 2) }
                    if (next == "weekend") return Triple(weekend(), null, i + 2)
                    return null
                }
                "next" -> {
                    weekdays[next]?.let { wd -> return Triple(add(daysToNextMonday + (wd + 5) % 7), null, i + 2) }
                    return when (next) {
                        "week" -> Triple(add(daysToNextMonday), null, i + 2)
                        "weekend" -> Triple(add(daysToNextMonday + 5), null, i + 2)
                        "month" -> Triple(Day(today.withDayOfMonth(1).plusMonths(1)), null, i + 2)
                        "year" -> Triple(Day(today.withDayOfYear(1).plusYears(1)), null, i + 2)
                        else -> null
                    }
                }
                "in" -> {
                    val n = amounts[next] ?: number(next, 1..3) ?: return null
                    return when (word(i + 2)) {
                        "day", "days" -> Triple(add(n.toLong()), null, i + 3)
                        "week", "weeks" -> Triple(add(7L * n), null, i + 3)
                        "month", "months" -> Triple(Day(today.plusMonths(n.toLong())), null, i + 3)
                        "year", "years" -> Triple(Day(today.plusYears(n.toLong())), null, i + 3)
                        else -> null
                    }
                }
            }
            weekdays[w]?.let { wd -> return Triple(add(((wd - weekday + 6) % 7 + 1).toLong()), null, i + 1) }
            // "oct 25", "october 25th 2027"
            val m0 = months[w]
            val d0 = dayOfMonth(next)
            if (m0 != null && d0 != null) {
                val y = year(word(i + 2))
                return absolute(y, m0, d0)?.let { Triple(it, null, if (y == null) i + 2 else i + 3) }
            }
            // "25 oct", "25th of october 2027"
            dayOfMonth(w)?.let { d ->
                val j = if (next == "of") i + 2 else i + 1
                val m = months[word(j)] ?: return null
                val y = year(word(j + 1))
                return absolute(y, m, d)?.let { Triple(it, null, if (y == null) j + 1 else j + 2) }
            }
            return numericDate(w)?.let { Triple(it, null, i + 1) }
        }

        private fun add(days: Int) = add(days.toLong())

        private fun add(days: Long) = Day(today.plusDays(days))

        /** Calendar weekday of today: 1 = Sunday … 7 = Saturday. */
        private val weekday: Int get() = today.dayOfWeek.value % 7 + 1

        /** 1…7: Monday of next week (weeks start Monday). */
        private val daysToNextMonday: Int get() = if ((9 - weekday) % 7 == 0) 7 else (9 - weekday) % 7

        /** Saturday, or today when it's Saturday or Sunday. */
        private fun weekend(): Day = if (weekday == 1 || weekday == 7) Day(today) else add(7 - weekday)

        /** "25/10", "10/25", "25/10/2027", "25/10/27", "2026-10-25". */
        private fun numericDate(w: String): Day? {
            val dash = w.split("-")
            if (dash.size == 3 && SwiftText.characterCount(dash[0]) == 4) {
                val y = number(dash[0], 4..4)
                val m = number(dash[1], 1..2)
                val d = number(dash[2], 1..2)
                if (y != null && m != null && d != null) return absolute(y, m, d)
            }
            val parts = w.split("/")
            if (parts.size != 2 && parts.size != 3) return null
            var d = number(parts[0], 1..2) ?: return null
            var m = number(parts[1], 1..2) ?: return null
            if (m > 12 && d <= 12) { val t = d; d = m; m = t }
            var y: Int? = null
            if (parts.size == 3) {
                val n = number(parts[2], 2..4) ?: return null
                if (parts[2].length == 3) return null
                y = if (n < 100) 2000 + n else n
            }
            return absolute(y, m, d)
        }

        /** A valid date; without a year, the first one from today on. */
        private fun absolute(year: Int?, month: Int, day: Int): Day? {
            if (year != null) return make(year, month, day)
            val y = today.year
            for (cand in y..y + 8) {
                val date = make(cand, month, day) ?: continue
                if (LocalDate.of(date.y, date.m, date.d) >= today) return date
            }
            return null
        }

        private fun make(y: Int, month: Int, day: Int): Day? {
            if (y < 1583) return julianOrGregorian(y, month, day)
            return try {
                Day(LocalDate.of(y, month, day))
            } catch (_: DateTimeException) {
                null
            }
        }

        /**
         * Foundation's Gregorian calendar is Julian before 15 Oct 1582 (like ICU), and year 0
         * is 1 BC, which DueDate writes as year 1.
         */
        private fun julianOrGregorian(y: Int, m: Int, d: Int): Day? {
            if (m !in 1..12 || d < 1) return null
            val gregorian = y > 1582 || (y == 1582 && (m > 10 || (m == 10 && d >= 15)))
            if (y == 1582 && m == 10 && d in 5..14) return null
            val leap = if (gregorian) (y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)) else Math.floorMod(y, 4) == 0
            val length = when (m) {
                2 -> if (leap) 29 else 28
                4, 6, 9, 11 -> 30
                else -> 31
            }
            if (d > length) return null
            return Day(if (y <= 0) 1 - y else y, m, d)
        }

        /** "25", "25th", "1st" (1…31). */
        private fun dayOfMonth(w: String): Int? {
            var digits = w
            for (suffix in listOf("st", "nd", "rd", "th")) if (w.endsWith(suffix)) digits = digits.dropLast(2)
            return number(digits, 1..2)?.takeIf { it in 1..31 }
        }

        /** A four-digit year 2000…2199. */
        private fun year(w: String): Int? = number(w, 4..4)?.takeIf { it in 2000..2199 }

        private fun number(s: String, digits: IntRange): Int? {
            if (SwiftText.characterCount(s) !in digits || s.any { digit(it) == null }) return null
            return s.toInt()
        }

        private fun digit(c: Char): Int? = if (c in '0'..'9') c - '0' else null
    }
}
