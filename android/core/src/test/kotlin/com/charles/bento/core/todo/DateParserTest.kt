package com.charles.bento.core.todo

import com.charles.bento.core.fielddoc.FieldDoc
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Fixed clock for every parser test: Wednesday 2026-10-21 10:00, London, en_GB. */
object Fixed {
    val zone: ZoneId = ZoneId.of("Europe/London")
    val now: Instant = at(2026, 10, 21, 10)
    val gb = JvmDateText(Locale.UK)

    fun at(y: Int, m: Int, d: Int, h: Int, min: Int = 0): Instant = ZonedDateTime.of(y, m, d, h, min, 0, 0, zone).toInstant()
}

private fun parse(s: String) = DateParser.parse(s, Fixed.now, Fixed.zone)
private fun phrase(s: String) = DateParser.parsePhrase(s, Fixed.now, Fixed.zone)
private fun d(date: String, time: String? = null) = DueDate(date, time)

/** The matched substring and value of `find`. */
private fun find(s: String): Pair<String, DueDate>? = DateParser.find(s, Fixed.now, Fixed.zone)?.let { (r, due) -> r.of(s) to due }

/** Port of Tests/TodoTests/DateParserTests.swift. */
class DateParserTest {
    // RelativeDays
    @Test fun todayTomorrowYesterday() {
        assertEquals(d("2026-10-21"), parse("today"))
        assertEquals(d("2026-10-21"), parse("tod"))
        for (s in listOf("tomorrow", "tmr", "tom", "tmrw", "Tomorrow", "TMRW")) assertEquals(d("2026-10-22"), parse(s), s)
        assertEquals(d("2026-10-20"), parse("yesterday"))
        assertEquals(d("2026-10-21", "19:00"), parse("tonight"))
    }

    @Test fun weekdaysAreStrictlyAfterToday() {
        assertEquals(d("2026-10-22"), parse("thu"))
        assertEquals(d("2026-10-23"), parse("friday"))
        assertEquals(d("2026-10-23"), parse("fri"))
        assertEquals(d("2026-10-24"), parse("sat"))
        assertEquals(d("2026-10-25"), parse("sunday"))
        assertEquals(d("2026-10-26"), parse("mon"))
        assertEquals(d("2026-10-27"), parse("tues"))
        assertEquals(d("2026-10-28"), parse("wed")) // today is Wednesday: next week
        assertEquals(d("2026-10-28"), parse("Wednesday"))
        assertEquals(d("2026-10-22"), parse("thurs"))
    }

    @Test fun thisWeekdayMayBeToday() {
        assertEquals(d("2026-10-21"), parse("this wed"))
        assertEquals(d("2026-10-23"), parse("this friday"))
        assertEquals(d("2026-10-26"), parse("this mon"))
    }

    @Test fun nextWeekdayIsInNextWeek() {
        assertEquals(d("2026-10-26"), parse("next mon"))
        assertEquals(d("2026-10-26"), parse("next monday"))
        assertEquals(d("2026-10-28"), parse("next wed"))
        assertEquals(d("2026-10-30"), parse("next fri"))
        assertEquals(d("2026-11-01"), parse("next sunday"))
    }

    @Test fun weeksWeekendsMonths() {
        assertEquals(d("2026-10-26"), parse("next week"))
        assertEquals(d("2026-10-24"), parse("weekend"))
        assertEquals(d("2026-10-24"), parse("this weekend"))
        assertEquals(d("2026-10-31"), parse("next weekend"))
        assertEquals(d("2026-11-01"), parse("next month"))
        assertEquals(d("2027-01-01"), parse("next year"))
    }

    @Test fun weekendOnTheWeekendIsToday() {
        val sunday = Fixed.at(2026, 10, 25, 12)
        assertEquals(d("2026-10-25"), DateParser.parse("weekend", sunday, Fixed.zone))
        assertEquals(d("2026-10-26"), DateParser.parse("next monday", sunday, Fixed.zone))
        assertEquals(d("2026-10-26"), DateParser.parse("next week", sunday, Fixed.zone))
        assertEquals(d("2026-10-31"), DateParser.parse("next weekend", sunday, Fixed.zone))
        val monday = Fixed.at(2026, 10, 26, 12)
        assertEquals(d("2026-11-02"), DateParser.parse("next monday", monday, Fixed.zone))
        assertEquals(d("2026-11-02"), DateParser.parse("mon", monday, Fixed.zone))
    }

    @Test fun inAmounts() {
        assertEquals(d("2026-10-24"), parse("in 3 days"))
        assertEquals(d("2026-10-22"), parse("in 1 day"))
        assertEquals(d("2026-11-04"), parse("in 2 weeks")) // across the DST change
        assertEquals(d("2026-10-28"), parse("in a week"))
        assertEquals(d("2026-10-23"), parse("in two days"))
        assertEquals(d("2026-11-21"), parse("in 1 month"))
        assertEquals(d("2027-01-21"), parse("in 3 months"))
        assertEquals(d("2027-10-21"), parse("in 1 year"))
        assertNull(parse("in 3"))
        assertNull(parse("in days"))
        assertNull(parse("3 days"))
    }

    @Test fun monthEndClamps() {
        val jan31 = Fixed.at(2027, 1, 31, 9)
        assertEquals(d("2027-02-28"), DateParser.parse("in 1 month", jan31, Fixed.zone))
    }

    // AbsoluteDates
    @Test fun monthNames() {
        assertEquals(d("2026-10-25"), parse("Oct 25"))
        assertEquals(d("2026-10-25"), parse("25 Oct"))
        assertEquals(d("2026-10-25"), parse("October 25"))
        assertEquals(d("2026-10-25"), parse("october 25th"))
        assertEquals(d("2026-11-01"), parse("1st nov"))
        assertEquals(d("2026-10-25"), parse("25th of october"))
        assertEquals(d("2027-10-25"), parse("25 october 2027"))
        assertEquals(d("2027-10-25"), parse("oct 25, 2027"))
        assertEquals(d("2027-09-03"), parse("sept 3"))
        assertEquals(d("2026-12-31"), parse("dec 31"))
    }

    @Test fun pastDatesWithoutYearRollOver() {
        assertEquals(d("2027-10-20"), parse("oct 20"))
        assertEquals(d("2026-10-21"), parse("21 oct")) // today isn't past
        assertEquals(d("2027-01-05"), parse("jan 5"))
        assertEquals(d("2027-10-20"), parse("20/10"))
        assertEquals(d("2027-05-05"), parse("may 5"))
        // An explicit year is kept even if it's past.
        assertEquals(d("2026-10-20"), parse("20 oct 2026"))
    }

    @Test fun invalidDays() {
        assertNull(parse("feb 30"))
        assertNull(parse("31 nov"))
        assertNull(parse("oct 32"))
        assertEquals(d("2028-02-29"), parse("29 feb")) // next leap year
        assertNull(parse("29 feb 2027"))
    }

    @Test fun monthNeedsADay() {
        assertNull(parse("may"))
        assertNull(parse("october"))
        assertNull(parse("oct 2027"))
    }

    @Test fun numeric() {
        assertEquals(d("2026-10-25"), parse("25/10"))
        assertEquals(d("2027-10-25"), parse("25/10/2027"))
        assertEquals(d("2027-10-25"), parse("25/10/27"))
        assertEquals(d("2026-11-01"), parse("1/11")) // day first
        assertEquals(d("2026-10-25"), parse("10/25")) // 25 can't be a month
        assertNull(parse("13/13"))
        assertNull(parse("25/10/202"))
        assertEquals(d("2026-10-25"), parse("2026-10-25"))
        assertEquals(d("2025-01-02"), parse("2025-01-02"))
        assertNull(parse("2026-02-30"))
        assertNull(parse("26-10-25"))
    }

    @Test fun julianDatesLikeFoundation() {
        // Foundation's Gregorian calendar is Julian before 15 Oct 1582 (cross-checked on macOS).
        assertEquals(d("1500-02-29"), parse("1500-02-29"))
        assertNull(parse("1582-10-10"))
        assertEquals(d("0001-01-01"), parse("0000-01-01"))
    }

    // Times
    @Test fun clockForms() {
        assertEquals(d("2026-10-21", "17:00"), parse("5pm"))
        assertEquals(d("2026-10-21", "17:00"), parse("5 pm"))
        assertEquals(d("2026-10-21", "17:30"), parse("5:30pm"))
        assertEquals(d("2026-10-21", "17:30"), parse("5:30 PM"))
        assertEquals(d("2026-10-21", "17:00"), parse("5p"))
        assertEquals(d("2026-10-21", "09:00"), parse("9am"))
        assertEquals(d("2026-10-21", "09:00"), parse("9 a.m."))
        assertEquals(d("2026-10-21", "00:00"), parse("12am"))
        assertEquals(d("2026-10-21", "12:00"), parse("12pm"))
        assertEquals(d("2026-10-21", "17:00"), parse("17:00"))
        assertEquals(d("2026-10-21", "09:05"), parse("9:05"))
        assertEquals(d("2026-10-21", "17:00"), parse("17"))
        assertEquals(d("2026-10-21", "17:00"), parse("at 17"))
        assertEquals(d("2026-10-21", "17:00"), parse("at 5pm"))
    }

    @Test fun invalidClocks() {
        for (s in listOf("13pm", "0am", "25:00", "24", "5:60", "5:3", "5:30:00", "5xm", "123", "at", "@ 5pm")) assertNull(parse(s), s)
    }

    @Test fun namedTimes() {
        assertEquals(d("2026-10-21", "12:00"), parse("noon"))
        assertEquals(d("2026-10-21", "00:00"), parse("midnight"))
        assertEquals(d("2026-10-21", "17:00"), parse("eod"))
        assertEquals(d("2026-10-21", "09:00"), parse("morning"))
        assertEquals(d("2026-10-21", "09:00"), parse("this morning"))
        assertEquals(d("2026-10-21", "13:00"), parse("afternoon"))
        assertEquals(d("2026-10-21", "19:00"), parse("evening"))
    }

    @Test fun pastTimeIsStillToday() {
        val due = parse("9am")!!
        assertEquals(d("2026-10-21", "09:00"), due)
        assertTrue(due.isOverdue(Fixed.now, Fixed.zone))
    }

    @Test fun combinations() {
        assertEquals(d("2026-10-22", "17:00"), parse("tomorrow at 5pm"))
        assertEquals(d("2026-10-22", "17:00"), parse("tomorrow 5pm"))
        assertEquals(d("2026-10-22", "17:00"), parse("5pm tomorrow"))
        assertEquals(d("2026-10-22", "17:00"), parse("at 5pm tomorrow"))
        assertEquals(d("2026-10-23", "09:00"), parse("fri 9am"))
        assertEquals(d("2026-10-23", "09:00"), parse("9am on fri"))
        assertEquals(d("2026-10-23", "12:00"), parse("on friday at noon"))
        assertEquals(d("2026-10-25", "14:30"), parse("oct 25 14:30"))
        assertEquals(d("2027-10-25", "08:00"), parse("25 oct 2027 8am"))
        assertEquals(d("2026-10-25", "17:00"), parse("25/10 17:00"))
        assertEquals(d("2026-10-22", "09:00"), parse("tomorrow morning"))
        assertEquals(d("2026-10-23", "19:00"), parse("friday evening"))
        assertEquals(d("2026-10-21", "21:00"), parse("tonight 9pm"))
        assertEquals(d("2026-10-21", "21:00"), parse("9pm tonight"))
        assertEquals(d("2026-10-26", "10:00"), parse("next week at 10"))
        assertEquals(d("2026-10-23", "08:15"), parse("in 2 days at 8:15"))
        assertEquals(d("2026-10-22", "17:00"), parse("tomorrow 17"))
        assertNull(parse("tomorrow at"))
        assertNull(parse("tomorrow friday"))
    }

    // ClearAndRejects
    @Test fun noDate() {
        assertEquals(DateParser.Phrase.Clear, phrase("no date"))
        assertEquals(DateParser.Phrase.Clear, phrase("No Due Date"))
        assertNull(phrase("no due"))
        assertNull(parse("no date"))
        assertEquals(DateParser.Phrase.Due(d("2026-10-22")), phrase("tomorrow"))
    }

    @Test fun nonDates() {
        for (s in listOf("", "  ", "in", "at", "next", "this", "on", "next door", "monkey", "mon key", "tomorrowland",
            "#tomorrow", "@today", "buy milk", "tomorrow buy milk", "today's", "3 days")) {
            assertNull(parse(s), s)
        }
    }

    @Test fun surroundingWhitespaceAndPunctuation() {
        assertEquals(d("2026-10-22"), parse("  tomorrow  "))
        assertEquals(d("2026-10-22"), parse("(tomorrow)"))
        assertEquals(d("2026-10-22"), parse("tomorrow,"))
    }

    // Find
    @Test fun findsPhraseInText() {
        val r = find("Call mom tomorrow at 5pm please")
        assertEquals("tomorrow at 5pm", r?.first)
        assertEquals(d("2026-10-22", "17:00"), r?.second)
        assertEquals("oct 25", find("Pay rent oct 25")?.first)
        assertEquals("25/10 9:30", find("dentist 25/10 9:30")?.first)
        assertEquals("next friday", find("report due next friday ok")?.first)
        assertEquals("in 2 weeks", find("ship it in 2 weeks")?.first)
        assertEquals(d("2026-10-21", "09:00"), find("standup 9am")?.second)
        assertNull(find("Water plants @home every"))
    }

    @Test fun prefersLongestThenLast() {
        assertEquals("tomorrow at 5pm", find("fri: move tomorrow at 5pm")?.first)
        assertEquals("mon", find("fri and mon")?.first)
        assertEquals("tomorrow", find("today or tomorrow")?.first)
    }

    @Test fun wordBoundaries() {
        for (s in listOf("feed the monkey", "Tomorrowland tickets", "satisfy wedding", "buy 17 eggs", "page 5",
            "good morning team", "evening class notes", "call tom", "I may go", "march on",
            "#tomorrow", "@today", "https://x.com/tomorrow", "a/tomorrow", "in", "at", "next", "next door",
            "check in later", "meet at the cafe", "mail a@b.com", "v2026-10-25", "C# today's")) {
            assertNull(find(s), s)
        }
    }

    @Test fun strictModeStillAcceptsStrongForms() {
        assertEquals(d("2026-10-21", "17:00"), find("meet at 17")?.second)
        assertEquals("tomorrow", find("buy 17 eggs tomorrow")?.first)
        assertEquals("tomorrow", find("call tomorrow 2 apples")?.first)
        assertEquals(d("2026-10-21", "19:00"), find("report this evening")?.second)
        assertEquals("tomorrow evening", find("report tomorrow evening")?.first)
        assertEquals(d("2026-10-21", "00:00"), find("snack at midnight")?.second)
        assertEquals(d("2027-05-05"), find("may 5 party")?.second)
    }

    @Test fun rangesExcludePunctuationAndDanglingWords() {
        assertEquals("tomorrow", find("Call Bob (tomorrow), then")?.first)
        assertEquals("tomorrow", find("call tomorrow at")?.first)
        assertEquals("Friday", find("Done by Friday.")?.first)
        assertEquals("on fri", find("go on fri")?.first)
        assertEquals(d("2026-10-22", "17:00"), find("TOMORROW 5PM")?.second)
    }

    @Test fun clearOnlyViaFindPhrase() {
        assertNull(find("fix no date"))
        val m = DateParser.findPhrase("fix no date", now = Fixed.now, zone = Fixed.zone)
        assertEquals(DateParser.Phrase.Clear, m?.phrase)
        assertEquals("no date", m?.range?.of("fix no date"))
    }

    @Test fun excludedRangesBreakPhrases() {
        val s = "#Plan Tomorrow write"
        val r = TextRange(0, "#Plan Tomorrow".length)
        assertNull(DateParser.findPhrase(s, listOf(r), Fixed.now, Fixed.zone))
        assertEquals(DateParser.Phrase.Due(d("2026-10-22")), DateParser.findPhrase(s, now = Fixed.now, zone = Fixed.zone)?.phrase)
    }

    @Test fun emojiAroundPhrase() {
        val s = "👨‍👩‍👧 party 🎉tomorrow 🎉 fri 5pm"
        assertEquals("fri 5pm", find(s)?.first)
    }

    // DueDateHelpers
    private fun label(due: DueDate, locale: Locale = Locale.UK) = due.label(Fixed.now, Fixed.zone, JvmDateText(locale))

    @Test fun labels() {
        assertEquals("Today", label(d("2026-10-21")))
        assertEquals("Tomorrow", label(d("2026-10-22")))
        assertEquals("Yesterday", label(d("2026-10-20")))
        assertEquals("Friday", label(d("2026-10-23")))
        assertEquals("Tuesday", label(d("2026-10-27"))) // 6 days ahead
        assertEquals("28 Oct", label(d("2026-10-28"))) // 7 days ahead
        assertEquals("19 Oct", label(d("2026-10-19")))
        assertEquals("23 Oct 2027", label(d("2027-10-23")))
        assertEquals("Tomorrow 17:00", label(d("2026-10-22", "17:00")))
        assertEquals("1 Dec 09:05", label(d("2026-12-01", "09:05")))
        val us = label(d("2026-10-22", "17:00"), Locale.US)
        assertTrue(us.startsWith("Tomorrow 5:00") && us.endsWith("PM"), us)
        assertEquals("Oct 28", label(d("2026-10-28"), Locale.US))
        assertEquals("garbage", label(d("garbage")))
    }

    @Test fun overdue() {
        assertTrue(d("2026-10-20").isOverdue(Fixed.now, Fixed.zone))
        assertFalse(d("2026-10-21").isOverdue(Fixed.now, Fixed.zone))
        assertTrue(d("2026-10-21", "09:59").isOverdue(Fixed.now, Fixed.zone))
        assertFalse(d("2026-10-21", "10:01").isOverdue(Fixed.now, Fixed.zone))
        assertFalse(d("2026-10-22").isOverdue(Fixed.now, Fixed.zone))
    }

    @Test fun dateConversion() {
        val due = d("2026-10-25", "17:30")
        val instant = due.instant(Fixed.zone)!!
        val z = instant.atZone(Fixed.zone)
        assertEquals(listOf(2026, 10, 25, 17, 30), listOf(z.year, z.monthValue, z.dayOfMonth, z.hour, z.minute))
        assertEquals(due, DueDate.of(instant, Fixed.zone, includeTime = true))
        assertEquals(d("2026-10-25"), DueDate.of(instant, Fixed.zone))
        assertEquals(z.toLocalDate().atStartOfDay(Fixed.zone).toInstant(), d("2026-10-25").instant(Fixed.zone))
        assertEquals(4, d("2026-10-25").days(Fixed.now, Fixed.zone))
        assertNull(d("nope").instant(Fixed.zone))
        assertNull(d("2026-10-25", "5pm").instant(Fixed.zone))
        // Floating: the same due date is a different instant in another time zone.
        val tokyo = ZoneId.of("Asia/Tokyo")
        assertNotEquals(instant, due.instant(tokyo))
        assertEquals(due, DueDate.of(due.instant(tokyo)!!, tokyo, includeTime = true))
    }

    @Test fun storedLikeTheSyncFormat() {
        val t = FieldDoc.newTask("x", order = 1.0, now = 1)
        t.setDue(d("2026-10-23", "17:00"), 2)
        assertEquals("""[{"date":"2026-10-23","time":"17:00"}]""", t.fields["due"]!!.canonical)
        t.setDue(d("2026-10-23"), 3)
        assertEquals("""[{"date":"2026-10-23"}]""", t.fields["due"]!!.canonical)
        assertTrue(t.load("""{"type":"task","fields":{"due":{"date":"2026-10-23","time":null}},"clocks":{}}"""))
        assertEquals(d("2026-10-23"), t.due)
    }
}
