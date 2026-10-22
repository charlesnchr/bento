import Foundation
import Testing
@testable import Todo

/// Fixed clock for every parser test: Wednesday 2026-10-21 10:00, London, en_GB.
enum Fixed {
    static let calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Europe/London")!
        c.locale = Locale(identifier: "en_GB")
        return c
    }()
    static let now = calendar.date(from: DateComponents(year: 2026, month: 10, day: 21, hour: 10))!
}

private func parse(_ s: String) -> DueDate? { DateParser.parse(s, now: Fixed.now, calendar: Fixed.calendar) }
private func phrase(_ s: String) -> DateParser.Phrase? { DateParser.parsePhrase(s, now: Fixed.now, calendar: Fixed.calendar) }
private func d(_ date: String, _ time: String? = nil) -> DueDate { DueDate(date: date, time: time) }

/// The matched substring and value of `find`.
private func find(_ s: String) -> (String, DueDate)? {
    DateParser.find(in: s, now: Fixed.now, calendar: Fixed.calendar).map { (String(s[$0.range]), $0.due) }
}

@Suite struct RelativeDays {
    @Test func todayTomorrowYesterday() {
        #expect(parse("today") == d("2026-10-21"))
        #expect(parse("tod") == d("2026-10-21"))
        for s in ["tomorrow", "tmr", "tom", "tmrw", "Tomorrow", "TMRW"] { #expect(parse(s) == d("2026-10-22"), "\(s)") }
        #expect(parse("yesterday") == d("2026-10-20"))
        #expect(parse("tonight") == d("2026-10-21", "19:00"))
    }

    @Test func weekdaysAreStrictlyAfterToday() {
        #expect(parse("thu") == d("2026-10-22"))
        #expect(parse("friday") == d("2026-10-23"))
        #expect(parse("fri") == d("2026-10-23"))
        #expect(parse("sat") == d("2026-10-24"))
        #expect(parse("sunday") == d("2026-10-25"))
        #expect(parse("mon") == d("2026-10-26"))
        #expect(parse("tues") == d("2026-10-27"))
        #expect(parse("wed") == d("2026-10-28"))  // today is Wednesday: next week
        #expect(parse("Wednesday") == d("2026-10-28"))
        #expect(parse("thurs") == d("2026-10-22"))
    }

    @Test func thisWeekdayMayBeToday() {
        #expect(parse("this wed") == d("2026-10-21"))
        #expect(parse("this friday") == d("2026-10-23"))
        #expect(parse("this mon") == d("2026-10-26"))
    }

    @Test func nextWeekdayIsInNextWeek() {
        #expect(parse("next mon") == d("2026-10-26"))
        #expect(parse("next monday") == d("2026-10-26"))
        #expect(parse("next wed") == d("2026-10-28"))
        #expect(parse("next fri") == d("2026-10-30"))
        #expect(parse("next sunday") == d("2026-11-01"))
    }

    @Test func weeksWeekendsMonths() {
        #expect(parse("next week") == d("2026-10-26"))
        #expect(parse("weekend") == d("2026-10-24"))
        #expect(parse("this weekend") == d("2026-10-24"))
        #expect(parse("next weekend") == d("2026-10-31"))
        #expect(parse("next month") == d("2026-11-01"))
        #expect(parse("next year") == d("2027-01-01"))
    }

    @Test func weekendOnTheWeekendIsToday() {
        let sunday = Fixed.calendar.date(from: DateComponents(year: 2026, month: 10, day: 25, hour: 12))!
        #expect(DateParser.parse("weekend", now: sunday, calendar: Fixed.calendar) == d("2026-10-25"))
        #expect(DateParser.parse("next monday", now: sunday, calendar: Fixed.calendar) == d("2026-10-26"))
        #expect(DateParser.parse("next week", now: sunday, calendar: Fixed.calendar) == d("2026-10-26"))
        #expect(DateParser.parse("next weekend", now: sunday, calendar: Fixed.calendar) == d("2026-10-31"))
        let monday = Fixed.calendar.date(from: DateComponents(year: 2026, month: 10, day: 26, hour: 12))!
        #expect(DateParser.parse("next monday", now: monday, calendar: Fixed.calendar) == d("2026-11-02"))
        #expect(DateParser.parse("mon", now: monday, calendar: Fixed.calendar) == d("2026-11-02"))
    }

    @Test func inAmounts() {
        #expect(parse("in 3 days") == d("2026-10-24"))
        #expect(parse("in 1 day") == d("2026-10-22"))
        #expect(parse("in 2 weeks") == d("2026-11-04"))  // across the DST change
        #expect(parse("in a week") == d("2026-10-28"))
        #expect(parse("in two days") == d("2026-10-23"))
        #expect(parse("in 1 month") == d("2026-11-21"))
        #expect(parse("in 3 months") == d("2027-01-21"))
        #expect(parse("in 1 year") == d("2027-10-21"))
        #expect(parse("in 3") == nil)
        #expect(parse("in days") == nil)
        #expect(parse("3 days") == nil)
    }

    @Test func monthEndClamps() {
        let jan31 = Fixed.calendar.date(from: DateComponents(year: 2027, month: 1, day: 31, hour: 9))!
        #expect(DateParser.parse("in 1 month", now: jan31, calendar: Fixed.calendar) == d("2027-02-28"))
    }
}

@Suite struct AbsoluteDates {
    @Test func monthNames() {
        #expect(parse("Oct 25") == d("2026-10-25"))
        #expect(parse("25 Oct") == d("2026-10-25"))
        #expect(parse("October 25") == d("2026-10-25"))
        #expect(parse("october 25th") == d("2026-10-25"))
        #expect(parse("1st nov") == d("2026-11-01"))
        #expect(parse("25th of october") == d("2026-10-25"))
        #expect(parse("25 october 2027") == d("2027-10-25"))
        #expect(parse("oct 25, 2027") == d("2027-10-25"))
        #expect(parse("sept 3") == d("2027-09-03"))
        #expect(parse("dec 31") == d("2026-12-31"))
    }

    @Test func pastDatesWithoutYearRollOver() {
        #expect(parse("oct 20") == d("2027-10-20"))
        #expect(parse("21 oct") == d("2026-10-21"))  // today isn't past
        #expect(parse("jan 5") == d("2027-01-05"))
        #expect(parse("20/10") == d("2027-10-20"))
        #expect(parse("may 5") == d("2027-05-05"))
        // An explicit year is kept even if it's past.
        #expect(parse("20 oct 2026") == d("2026-10-20"))
    }

    @Test func invalidDays() {
        #expect(parse("feb 30") == nil)
        #expect(parse("31 nov") == nil)
        #expect(parse("oct 32") == nil)
        #expect(parse("29 feb") == d("2028-02-29"))  // next leap year
        #expect(parse("29 feb 2027") == nil)
    }

    @Test func monthNeedsADay() {
        #expect(parse("may") == nil)
        #expect(parse("october") == nil)
        #expect(parse("oct 2027") == nil)
    }

    @Test func numeric() {
        #expect(parse("25/10") == d("2026-10-25"))
        #expect(parse("25/10/2027") == d("2027-10-25"))
        #expect(parse("25/10/27") == d("2027-10-25"))
        #expect(parse("1/11") == d("2026-11-01"))  // day first
        #expect(parse("10/25") == d("2026-10-25"))  // 25 can't be a month
        #expect(parse("13/13") == nil)
        #expect(parse("25/10/202") == nil)
        #expect(parse("2026-10-25") == d("2026-10-25"))
        #expect(parse("2025-01-02") == d("2025-01-02"))
        #expect(parse("2026-02-30") == nil)
        #expect(parse("26-10-25") == nil)
    }
}

@Suite struct Times {
    @Test func clockForms() {
        #expect(parse("5pm") == d("2026-10-21", "17:00"))
        #expect(parse("5 pm") == d("2026-10-21", "17:00"))
        #expect(parse("5:30pm") == d("2026-10-21", "17:30"))
        #expect(parse("5:30 PM") == d("2026-10-21", "17:30"))
        #expect(parse("5p") == d("2026-10-21", "17:00"))
        #expect(parse("9am") == d("2026-10-21", "09:00"))
        #expect(parse("9 a.m.") == d("2026-10-21", "09:00"))
        #expect(parse("12am") == d("2026-10-21", "00:00"))
        #expect(parse("12pm") == d("2026-10-21", "12:00"))
        #expect(parse("17:00") == d("2026-10-21", "17:00"))
        #expect(parse("9:05") == d("2026-10-21", "09:05"))
        #expect(parse("17") == d("2026-10-21", "17:00"))
        #expect(parse("at 17") == d("2026-10-21", "17:00"))
        #expect(parse("at 5pm") == d("2026-10-21", "17:00"))
    }

    @Test func invalidClocks() {
        for s in ["13pm", "0am", "25:00", "24", "5:60", "5:3", "5:30:00", "5xm", "123", "at", "@ 5pm"] {
            #expect(parse(s) == nil, "\(s)")
        }
    }

    @Test func namedTimes() {
        #expect(parse("noon") == d("2026-10-21", "12:00"))
        #expect(parse("midnight") == d("2026-10-21", "00:00"))
        #expect(parse("eod") == d("2026-10-21", "17:00"))
        #expect(parse("morning") == d("2026-10-21", "09:00"))
        #expect(parse("this morning") == d("2026-10-21", "09:00"))
        #expect(parse("afternoon") == d("2026-10-21", "13:00"))
        #expect(parse("evening") == d("2026-10-21", "19:00"))
    }

    @Test func pastTimeIsStillToday() {
        let due = parse("9am")!
        #expect(due == d("2026-10-21", "09:00"))
        #expect(due.isOverdue(now: Fixed.now, calendar: Fixed.calendar))
    }

    @Test func combinations() {
        #expect(parse("tomorrow at 5pm") == d("2026-10-22", "17:00"))
        #expect(parse("tomorrow 5pm") == d("2026-10-22", "17:00"))
        #expect(parse("5pm tomorrow") == d("2026-10-22", "17:00"))
        #expect(parse("at 5pm tomorrow") == d("2026-10-22", "17:00"))
        #expect(parse("fri 9am") == d("2026-10-23", "09:00"))
        #expect(parse("9am on fri") == d("2026-10-23", "09:00"))
        #expect(parse("on friday at noon") == d("2026-10-23", "12:00"))
        #expect(parse("oct 25 14:30") == d("2026-10-25", "14:30"))
        #expect(parse("25 oct 2027 8am") == d("2027-10-25", "08:00"))
        #expect(parse("25/10 17:00") == d("2026-10-25", "17:00"))
        #expect(parse("tomorrow morning") == d("2026-10-22", "09:00"))
        #expect(parse("friday evening") == d("2026-10-23", "19:00"))
        #expect(parse("tonight 9pm") == d("2026-10-21", "21:00"))
        #expect(parse("9pm tonight") == d("2026-10-21", "21:00"))
        #expect(parse("next week at 10") == d("2026-10-26", "10:00"))
        #expect(parse("in 2 days at 8:15") == d("2026-10-23", "08:15"))
        #expect(parse("tomorrow 17") == d("2026-10-22", "17:00"))
        #expect(parse("tomorrow at") == nil)
        #expect(parse("tomorrow friday") == nil)
    }
}

@Suite struct ClearAndRejects {
    @Test func noDate() {
        #expect(phrase("no date") == .clear)
        #expect(phrase("No Due Date") == .clear)
        #expect(phrase("no due") == nil)
        #expect(parse("no date") == nil)
        #expect(phrase("tomorrow") == .due(d("2026-10-22")))
    }

    @Test func nonDates() {
        for s in ["", "  ", "in", "at", "next", "this", "on", "next door", "monkey", "mon key", "tomorrowland",
                  "#tomorrow", "@today", "buy milk", "tomorrow buy milk", "today's", "3 days"] {
            #expect(parse(s) == nil, "\(s)")
        }
    }

    @Test func surroundingWhitespaceAndPunctuation() {
        #expect(parse("  tomorrow  ") == d("2026-10-22"))
        #expect(parse("(tomorrow)") == d("2026-10-22"))
        #expect(parse("tomorrow,") == d("2026-10-22"))
    }
}

@Suite struct Find {
    @Test func findsPhraseInText() {
        let r = find("Call mom tomorrow at 5pm please")
        #expect(r?.0 == "tomorrow at 5pm")
        #expect(r?.1 == d("2026-10-22", "17:00"))
        #expect(find("Pay rent oct 25")?.0 == "oct 25")
        #expect(find("dentist 25/10 9:30")?.0 == "25/10 9:30")
        #expect(find("report due next friday ok")?.0 == "next friday")
        #expect(find("ship it in 2 weeks")?.0 == "in 2 weeks")
        #expect(find("standup 9am")?.1 == d("2026-10-21", "09:00"))
        #expect(find("Water plants @home every") == nil)
    }

    @Test func prefersLongestThenLast() {
        #expect(find("fri: move tomorrow at 5pm")?.0 == "tomorrow at 5pm")
        #expect(find("fri and mon")?.0 == "mon")
        #expect(find("today or tomorrow")?.0 == "tomorrow")
    }

    @Test func wordBoundaries() {
        for s in ["feed the monkey", "Tomorrowland tickets", "satisfy wedding", "buy 17 eggs", "page 5",
                  "good morning team", "evening class notes", "call tom", "I may go", "march on",
                  "#tomorrow", "@today", "https://x.com/tomorrow", "a/tomorrow", "in", "at", "next", "next door",
                  "check in later", "meet at the cafe", "mail a@b.com", "v2026-10-25", "C# today's"] {
            #expect(find(s) == nil, "\(s)")
        }
    }

    @Test func strictModeStillAcceptsStrongForms() {
        #expect(find("meet at 17")?.1 == d("2026-10-21", "17:00"))
        #expect(find("buy 17 eggs tomorrow")?.0 == "tomorrow")
        #expect(find("call tomorrow 2 apples")?.0 == "tomorrow")
        #expect(find("report this evening")?.1 == d("2026-10-21", "19:00"))
        #expect(find("report tomorrow evening")?.0 == "tomorrow evening")
        #expect(find("snack at midnight")?.1 == d("2026-10-21", "00:00"))
        #expect(find("may 5 party")?.1 == d("2027-05-05"))
    }

    @Test func rangesExcludePunctuationAndDanglingWords() {
        #expect(find("Call Bob (tomorrow), then")?.0 == "tomorrow")
        #expect(find("call tomorrow at")?.0 == "tomorrow")
        #expect(find("Done by Friday.")?.0 == "Friday")
        #expect(find("go on fri")?.0 == "on fri")
        #expect(find("TOMORROW 5PM")?.1 == d("2026-10-22", "17:00"))
    }

    @Test func clearOnlyViaFindPhrase() {
        #expect(find("fix no date") == nil)
        let m = DateParser.findPhrase(in: "fix no date", now: Fixed.now, calendar: Fixed.calendar)
        #expect(m?.phrase == .clear)
        #expect(m.map { "fix no date"[$0.range] } == "no date")
    }

    @Test func excludedRangesBreakPhrases() {
        let s = "#Plan Tomorrow write"
        let r = s.range(of: "#Plan Tomorrow")!
        #expect(DateParser.findPhrase(in: s, excluding: [r], now: Fixed.now, calendar: Fixed.calendar) == nil)
        #expect(DateParser.findPhrase(in: s, now: Fixed.now, calendar: Fixed.calendar)?.phrase == .due(d("2026-10-22")))
    }

    @Test func emojiAroundPhrase() {
        let s = "👨‍👩‍👧 party 🎉tomorrow 🎉 fri 5pm"
        #expect(find(s)?.0 == "fri 5pm")
    }
}

@Suite struct DueDateHelpers {
    let cal = Fixed.calendar, now = Fixed.now
    func label(_ due: DueDate, _ locale: String = "en_GB") -> String {
        due.label(now: now, calendar: cal, locale: Locale(identifier: locale))
    }

    @Test func labels() {
        #expect(label(d("2026-10-21")) == "Today")
        #expect(label(d("2026-10-22")) == "Tomorrow")
        #expect(label(d("2026-10-20")) == "Yesterday")
        #expect(label(d("2026-10-23")) == "Friday")
        #expect(label(d("2026-10-27")) == "Tuesday")  // 6 days ahead
        #expect(label(d("2026-10-28")) == "28 Oct")  // 7 days ahead
        #expect(label(d("2026-10-19")) == "19 Oct")
        #expect(label(d("2027-10-23")) == "23 Oct 2027")
        #expect(label(d("2026-10-22", "17:00")) == "Tomorrow 17:00")
        #expect(label(d("2026-12-01", "09:05")) == "1 Dec 09:05")
        let us = label(d("2026-10-22", "17:00"), "en_US")
        #expect(us.hasPrefix("Tomorrow 5:00") && us.hasSuffix("PM"))
        #expect(label(d("2026-10-28"), "en_US") == "Oct 28")
        #expect(label(d("garbage")) == "garbage")
    }

    @Test func overdue() {
        #expect(d("2026-10-20").isOverdue(now: now, calendar: cal))
        #expect(!d("2026-10-21").isOverdue(now: now, calendar: cal))
        #expect(d("2026-10-21", "09:59").isOverdue(now: now, calendar: cal))
        #expect(!d("2026-10-21", "10:01").isOverdue(now: now, calendar: cal))
        #expect(!d("2026-10-22").isOverdue(now: now, calendar: cal))
    }

    @Test func dateConversion() {
        let due = d("2026-10-25", "17:30")
        let date = due.dateValue(in: cal)!
        #expect(cal.dateComponents([.year, .month, .day, .hour, .minute], from: date)
            == DateComponents(year: 2026, month: 10, day: 25, hour: 17, minute: 30))
        #expect(DueDate(date, includeTime: true, calendar: cal) == due)
        #expect(DueDate(date, calendar: cal) == d("2026-10-25"))
        #expect(d("2026-10-25").dateValue(in: cal) == cal.startOfDay(for: date))
        #expect(d("2026-10-25").days(from: now, calendar: cal) == 4)
        #expect(d("nope").dateValue(in: cal) == nil)
        #expect(d("2026-10-25", "5pm").dateValue(in: cal) == nil)
        // Floating: the same due date is a different instant in another time zone.
        var tokyo = cal
        tokyo.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        #expect(due.dateValue(in: tokyo) != date)
        #expect(DueDate(due.dateValue(in: tokyo)!, includeTime: true, calendar: tokyo) == due)
    }

    @Test func codableMatchesSyncFormat() throws {
        let enc = JSONEncoder()
        enc.outputFormatting = .sortedKeys
        #expect(String(decoding: try enc.encode(d("2026-10-23", "17:00")), as: UTF8.self)
            == #"{"date":"2026-10-23","time":"17:00"}"#)
        #expect(String(decoding: try enc.encode(d("2026-10-23")), as: UTF8.self) == #"{"date":"2026-10-23"}"#)
        let back = try JSONDecoder().decode(DueDate.self, from: Data(#"{"date":"2026-10-23","time":null}"#.utf8))
        #expect(back == d("2026-10-23"))
    }
}
