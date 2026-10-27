package com.charles.bento.core.todo

import com.charles.bento.core.fielddoc.SwiftText
import java.time.DateTimeException
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.chrono.IsoChronology
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeFormatterBuilder
import java.time.format.FormatStyle
import java.time.temporal.ChronoUnit
import java.util.Locale

/**
 * A task's due date: a floating local day with an optional wall-clock time, stored as in
 * the sync protocol (`{"date":"2026-10-23","time":"17:00"}`). Floating means "23 Oct at
 * 17:00 wherever I am", so it only becomes an instant in a given time zone.
 */
data class DueDate(
    /** `yyyy-MM-dd`. */
    val date: String,
    /** `HH:mm`, 24 h; null = all day. */
    val time: String? = null,
) {
    /** Year, month, day (and hour, minute when timed); null when the strings are malformed. */
    val components: IntArray?
        get() {
            val d = numbers(date, '-')
            if (d.size != 3) return null
            if (time == null) return d.toIntArray()
            val t = numbers(time, ':')
            if (t.size != 2) return null
            return (d + t).toIntArray()
        }

    /**
     * The due moment in `zone`: its time, or the start of the day when all-day. Out-of-range
     * components roll over like Foundation's lenient calendar ("2026-13-01" is 1 Jan 2027).
     */
    fun dateTime(): LocalDateTime? {
        val c = components ?: return null
        return try {
            val day = LocalDate.of(c[0], 1, 1).plusMonths(c[1] - 1L).plusDays(c[2] - 1L)
            if (c.size == 5) day.atStartOfDay().plusHours(c[3].toLong()).plusMinutes(c[4].toLong()) else day.atStartOfDay()
        } catch (_: DateTimeException) {
            null
        }
    }

    fun instant(zone: ZoneId = ZoneId.systemDefault()): Instant? = dateTime()?.atZone(zone)?.toInstant()

    /** Calendar days from today to the due day: 0 today, 1 tomorrow, -1 yesterday. */
    fun days(now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): Int? {
        val due = instant(zone) ?: return null
        return ChronoUnit.DAYS.between(now.atZone(zone).toLocalDate(), due.atZone(zone).toLocalDate()).toInt()
    }

    /** Past due: an all-day date before today, or a timed one before `now`. */
    fun isOverdue(now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): Boolean {
        if (time != null) instant(zone)?.let { return it < now }
        return (days(now, zone) ?: 0) < 0
    }

    /**
     * Todoist-style label: "Today", "Tomorrow", "Yesterday", the weekday name within the
     * next 6 days ("Friday"), else "23 Oct" (year added when not this year), with the time
     * appended in the locale's 12/24 h style ("Tomorrow 17:00").
     */
    fun label(now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault(), format: DateText = DateText.default()): String {
        val dueInstant = instant(zone) ?: return date
        val days = days(now, zone) ?: return date
        val due = dueInstant.atZone(zone).toLocalDateTime()
        val day = when (days) {
            0 -> "Today"
            1 -> "Tomorrow"
            -1 -> "Yesterday"
            in 2..6 -> format.format(DateText.WEEKDAY, due)
            else -> format.format(if (due.year == now.atZone(zone).year) DateText.DAY_MONTH else DateText.DAY_MONTH_YEAR, due)
        }
        if (time == null) return day
        return day + " " + format.format(DateText.TIME, due)
    }

    companion object {
        /** The day of `moment` in `zone`, plus its time (to the minute) if `includeTime`. */
        fun of(moment: Instant, zone: ZoneId = ZoneId.systemDefault(), includeTime: Boolean = false): DueDate {
            val t = moment.atZone(zone)
            return DueDate(dayString(t.year, t.monthValue, t.dayOfMonth), if (includeTime) timeString(t.hour, t.minute) else null)
        }

        fun of(day: LocalDate, time: LocalTime? = null): DueDate =
            DueDate(dayString(day.year, day.monthValue, day.dayOfMonth), time?.let { timeString(it.hour, it.minute) })

        /** `String(format: "%04d-%02d-%02d")`. */
        fun dayString(y: Int, m: Int, d: Int): String =
            (if (y < 0) "-" + (-y).toString().padStart(3, '0') else y.toString().padStart(4, '0')) +
                "-" + m.toString().padStart(2, '0') + "-" + d.toString().padStart(2, '0')

        fun timeString(h: Int, m: Int): String = h.toString().padStart(2, '0') + ":" + m.toString().padStart(2, '0')

        /** Swift `s.split(separator: sep).compactMap { Int($0) }` (empty pieces dropped). */
        private fun numbers(s: String, sep: Char): List<Int> =
            s.split(sep).filter { it.isNotEmpty() }.mapNotNull { SwiftText.parseInt(it) }
    }
}

/**
 * Localised date text for labels and headings, by ICU skeleton like the Mac's
 * `setLocalizedDateFormatFromTemplate`. The default derives patterns from the JDK's
 * locale data; on Android pass one backed by ICU for exact per-locale patterns, e.g.
 * `DateText { skeleton, value -> DateTimeFormatter.ofPattern(DateFormat.getBestDateTimePattern(locale, skeleton), locale).format(value) }`.
 */
fun interface DateText {
    fun format(skeleton: String, value: LocalDateTime): String

    companion object {
        const val WEEKDAY = "EEEE"
        const val DAY_MONTH = "dMMM"
        const val DAY_MONTH_YEAR = "dMMMy"
        const val TIME = "jmm"
        const val HEADER = "EEEdMMM"
        const val HEADER_YEAR = "EEEdMMMyyyy"

        fun default(locale: Locale = Locale.getDefault()): DateText = JvmDateText(locale)
    }
}

/** [DateText] from the JDK's locale data: day-first or month-first, 12 or 24 h, as the locale's medium/short styles. */
class JvmDateText(private val locale: Locale) : DateText {
    private val dayFirst: Boolean by lazy {
        val p = DateTimeFormatterBuilder.getLocalizedDateTimePattern(FormatStyle.MEDIUM, null, IsoChronology.INSTANCE, locale)
        val d = p.indexOf('d')
        val m = p.indexOf('M')
        d < 0 || m < 0 || d < m
    }
    private val timePattern: String by lazy {
        DateTimeFormatterBuilder.getLocalizedDateTimePattern(null, FormatStyle.SHORT, IsoChronology.INSTANCE, locale)
    }
    private val cache = HashMap<String, DateTimeFormatter>()

    override fun format(skeleton: String, value: LocalDateTime): String {
        val f = cache.getOrPut(skeleton) {
            val pattern = when (skeleton) {
                DateText.WEEKDAY -> "EEEE"
                DateText.DAY_MONTH -> if (dayFirst) "d MMM" else "MMM d"
                DateText.DAY_MONTH_YEAR -> if (dayFirst) "d MMM y" else "MMM d, y"
                DateText.TIME -> timePattern
                DateText.HEADER -> if (dayFirst) "EEE d MMM" else "EEE, MMM d"
                DateText.HEADER_YEAR -> if (dayFirst) "EEE, d MMM y" else "EEE, MMM d, y"
                else -> skeleton
            }
            DateTimeFormatter.ofPattern(pattern, locale)
        }
        return f.format(value)
    }
}
