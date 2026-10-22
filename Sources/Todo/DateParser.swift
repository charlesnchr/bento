import Foundation

/// A task's due date: a floating local day with an optional wall-clock time, stored
/// as in the sync protocol (`{"date":"2026-10-23","time":"17:00"}`). Floating means
/// "23 Oct at 17:00 wherever I am", so it only becomes a `Date` in a given calendar.
struct DueDate: Equatable, Hashable, Codable {
    /// `yyyy-MM-dd`.
    var date: String
    /// `HH:mm`, 24 h; nil = all day.
    var time: String?

    init(date: String, time: String? = nil) {
        self.date = date
        self.time = time
    }

    /// The day of `moment` in `calendar`, plus its time (to the minute) if `includeTime`.
    init(_ moment: Date, includeTime: Bool = false, calendar: Calendar = .current) {
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: moment)
        date = String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
        time = includeTime ? String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0) : nil
    }

    /// Year/month/day (and hour/minute when timed); nil when the strings are malformed.
    var components: DateComponents? {
        let d = date.split(separator: "-").compactMap { Int($0) }
        guard d.count == 3 else { return nil }
        var c = DateComponents(year: d[0], month: d[1], day: d[2])
        if let time {
            let t = time.split(separator: ":").compactMap { Int($0) }
            guard t.count == 2 else { return nil }
            c.hour = t[0]
            c.minute = t[1]
        }
        return c
    }

    /// The due moment in `calendar`: its time, or the start of the day when all-day.
    func dateValue(in calendar: Calendar = .current) -> Date? {
        components.flatMap { calendar.date(from: $0) }
    }

    /// Calendar days from today to the due day: 0 today, 1 tomorrow, -1 yesterday.
    func days(from now: Date = Date(), calendar: Calendar = .current) -> Int? {
        guard let due = dateValue(in: calendar) else { return nil }
        return calendar.dateComponents([.day], from: calendar.startOfDay(for: now),
                                       to: calendar.startOfDay(for: due)).day
    }

    /// Past due: an all-day date before today, or a timed one before `now`.
    func isOverdue(now: Date = Date(), calendar: Calendar = .current) -> Bool {
        if time != nil, let due = dateValue(in: calendar) { return due < now }
        return (days(from: now, calendar: calendar) ?? 0) < 0
    }

    /// Todoist-style label: "Today", "Tomorrow", "Yesterday", the weekday name within
    /// the next 6 days ("Friday"), else "23 Oct" (year added when not this year), with
    /// the time appended in the locale's 12/24 h style ("Tomorrow 17:00").
    func label(now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) -> String {
        guard let due = dateValue(in: calendar), let days = days(from: now, calendar: calendar) else { return date }
        let day: String
        switch days {
        case 0: day = "Today"
        case 1: day = "Tomorrow"
        case -1: day = "Yesterday"
        case 2...6: day = Formatters.make("EEEE", locale, calendar).string(from: due)
        default:
            let sameYear = calendar.component(.year, from: due) == calendar.component(.year, from: now)
            day = Formatters.make(sameYear ? "dMMM" : "dMMMy", locale, calendar).string(from: due)
        }
        guard time != nil else { return day }
        return day + " " + Formatters.make("jmm", locale, calendar).string(from: due)
    }
}

/// Labels are drawn for every visible task, so formatters are built once per
/// template/locale/calendar.
private enum Formatters {
    private static let cache = NSCache<NSString, DateFormatter>()

    static func make(_ template: String, _ locale: Locale, _ calendar: Calendar) -> DateFormatter {
        let key = "\(template)|\(locale.identifier)|\(calendar.identifier)|\(calendar.timeZone.identifier)" as NSString
        if let f = cache.object(forKey: key) { return f }
        let f = DateFormatter()
        f.locale = locale
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.setLocalizedDateFormatFromTemplate(template)
        cache.setObject(f, forKey: key)
        return f
    }
}

/// Natural-language due dates, Todoist-like: "tomorrow 5pm", "fri", "next week",
/// "in 3 days", "oct 25", "25/10", "2026-10-25", "at 17:00", "no date".
///
/// Text is split into whitespace-separated words (surrounding brackets, quotes and
/// trailing punctuation dropped), so phrases only ever match whole words: "mon" never
/// matches inside "monkey", "#tomorrow" (a project) or "a/tomorrow" (a URL).
///
/// Choices where Todoist's behaviour is ambiguous:
/// - A weekday alone ("wed") is its next occurrence strictly after today; "this wed" may
///   be today. "next fri" is Friday of next week (weeks start Monday), so on a
///   Wednesday "fri" is in 2 days and "next fri" in 9. "next week" is next Monday.
/// - "weekend"/"this weekend" is Saturday (today when it's already the weekend);
///   "next weekend" is next week's Saturday. "next month"/"next year" are the 1st.
/// - Month names need a day ("may 5", "5 may"), so "may", "march" and "sat" as words
///   stay text unless followed/preceded by a day number. "sat"/"sun"/"wed" alone are
///   still weekdays, as in Todoist.
/// - "25/10" is day-first; "10/25" is accepted as month-first only because 25 can't
///   be a month. Absolute dates without a year that already passed roll to next year.
/// - A time alone is today, even if that time has passed (Todoist does the same).
///   Times without am/pm are 24 h ("at 5" is 05:00). noon 12:00, midnight 00:00,
///   eod 17:00, morning 09:00, afternoon 13:00, evening 19:00; "tonight" is today 19:00.
/// - `find` (quick add, free text) is stricter than `parse` (a date field): a bare
///   hour needs "at" ("at 17"; "buy 17 eggs" has no date), "morning"/"afternoon"/
///   "evening" need a date or "this" ("good morning" has no date), and "tom" isn't
///   tomorrow (it's usually a name).
enum DateParser {
    /// What a phrase means: a due date, or "no date" / "no due date" (clear it).
    enum Phrase: Equatable {
        case due(DueDate)
        case clear
    }

    /// Parses a whole string as a date phrase ("tomorrow 5pm"); nil if it isn't one entirely.
    static func parse(_ text: String, now: Date = Date(), calendar: Calendar = .current) -> DueDate? {
        if case .due(let due)? = parsePhrase(text, now: now, calendar: calendar) { return due }
        return nil
    }

    /// Like `parse`, but also recognises "no date" as `.clear`.
    static func parsePhrase(_ text: String, now: Date = Date(), calendar: Calendar = .current) -> Phrase? {
        let words = tokenize(text, excluding: [])
        let g = Grammar(words: words.map(\.text), now: now, calendar: calendar, strict: false, allowClear: true)
        guard let (phrase, end) = g.phrase(at: 0), end == words.count else { return nil }
        return phrase
    }

    /// Finds the longest date phrase inside free text (for quick add). Returns its range and value.
    static func find(in text: String, now: Date = Date(), calendar: Calendar = .current)
        -> (range: Range<String.Index>, due: DueDate)? {
        guard let m = findPhrase(in: text, now: now, calendar: calendar, allowClear: false),
              case .due(let due) = m.phrase else { return nil }
        return (m.range, due)
    }

    /// The longest phrase in `text` (the last one on ties). Words overlapping `excluding`
    /// (e.g. a "#Plan Tomorrow" project token) never take part in a phrase.
    static func findPhrase(in text: String, excluding: [Range<String.Index>] = [], now: Date = Date(),
                           calendar: Calendar = .current, allowClear: Bool = true)
        -> (range: Range<String.Index>, phrase: Phrase)? {
        let words = tokenize(text, excluding: excluding)
        let g = Grammar(words: words.map(\.text), now: now, calendar: calendar, strict: true, allowClear: allowClear)
        var best: (range: Range<String.Index>, phrase: Phrase, length: Int)?
        for i in words.indices {
            guard let (phrase, end) = g.phrase(at: i) else { continue }
            let range = words[i].range.lowerBound..<words[end - 1].range.upperBound
            let length = text.utf16.distance(from: range.lowerBound, to: range.upperBound)
            if length >= best?.length ?? 0 { best = (range, phrase, length) }
        }
        return best.map { ($0.range, $0.phrase) }
    }

    // MARK: - Words

    struct Word {
        var text: String
        var range: Range<String.Index>
    }

    private static let leading: Set<Character> = ["(", "[", "\"", "'", "“", "‘"]
    private static let trailing: Set<Character> = [".", ",", ";", ":", "!", "?", ")", "]", "\"", "'", "”", "’"]
    /// Stands in for an excluded word: matches nothing, so phrases can't span it.
    private static let barrier = "\u{1}"

    /// Lowercased whitespace-separated words without surrounding punctuation.
    static func tokenize(_ text: String, excluding: [Range<String.Index>]) -> [Word] {
        var out: [Word] = []
        var i = text.startIndex
        while i < text.endIndex {
            if text[i].isWhitespace { i = text.index(after: i); continue }
            var j = i
            while j < text.endIndex, !text[j].isWhitespace { j = text.index(after: j) }
            var lo = i, hi = j
            while lo < hi, leading.contains(text[lo]) { lo = text.index(after: lo) }
            while hi > lo, trailing.contains(text[text.index(before: hi)]) { hi = text.index(before: hi) }
            if excluding.contains(where: { $0.overlaps(i..<j) }) {
                out.append(Word(text: barrier, range: i..<j))
            } else if lo < hi {
                out.append(Word(text: text[lo..<hi].lowercased(), range: lo..<hi))
            }
            i = j
        }
        return out
    }
}

// MARK: - Grammar

private typealias TimeOfDay = (hour: Int, minute: Int)

private let weekdays: [String: Int] = [  // Calendar weekday: 1 = Sunday … 7 = Saturday
    "sunday": 1, "sun": 1, "monday": 2, "mon": 2, "tuesday": 3, "tue": 3, "tues": 3,
    "wednesday": 4, "wed": 4, "weds": 4, "thursday": 5, "thu": 5, "thur": 5, "thurs": 5,
    "friday": 6, "fri": 6, "saturday": 7, "sat": 7,
]
private let months: [String: Int] = [
    "january": 1, "jan": 1, "february": 2, "feb": 2, "march": 3, "mar": 3, "april": 4, "apr": 4,
    "may": 5, "june": 6, "jun": 6, "july": 7, "jul": 7, "august": 8, "aug": 8,
    "september": 9, "sep": 9, "sept": 9, "october": 10, "oct": 10, "november": 11, "nov": 11,
    "december": 12, "dec": 12,
]
private let amounts: [String: Int] = [
    "a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
]
private let namedTimes: [String: TimeOfDay] = ["noon": (12, 0), "midday": (12, 0), "midnight": (0, 0), "eod": (17, 0)]
/// Times of day that are ordinary words too; see `strict`.
private let vagueTimes: [String: TimeOfDay] = ["morning": (9, 0), "afternoon": (13, 0), "evening": (19, 0)]
private let meridiems: Set<String> = ["am", "pm", "a", "p", "a.m", "p.m"]

/// Recursive descent over lowercased words:
///
///     phrase := "no" ["due"] "date"
///             | ["on"] day [["at"] time]
///             | time [["on"] day]
private struct Grammar {
    let words: [String]
    let today: Date
    let calendar: Calendar
    /// Free-text mode (`find`): skip readings that are usually ordinary words.
    let strict: Bool
    let allowClear: Bool

    init(words: [String], now: Date, calendar: Calendar, strict: Bool, allowClear: Bool) {
        self.words = words
        self.today = calendar.startOfDay(for: now)
        self.calendar = calendar
        self.strict = strict
        self.allowClear = allowClear
    }

    func word(_ i: Int) -> String { i < words.count ? words[i] : "" }

    /// The longest phrase starting at word `i` and the index after it.
    func phrase(at i: Int) -> (Phrase, Int)? {
        if allowClear, word(i) == "no" {
            if word(i + 1) == "date" { return (.clear, i + 2) }
            if word(i + 1) == "due", word(i + 2) == "date" { return (.clear, i + 3) }
        }
        let a = dayFirst(i), b = timeFirst(i)
        if let a, let b { return b.1 > a.1 ? b : a }
        return a ?? b
    }

    typealias Phrase = DateParser.Phrase

    private func dayFirst(_ i: Int) -> (Phrase, Int)? {
        guard let (date, defaultTime, end) = day(word(i) == "on" ? i + 1 : i) else { return nil }
        if word(end) == "at", let (clock, _, e) = time(end + 1, afterAt: true) { return (due(date, clock), e) }
        if let (clock, _, e) = time(end, afterAt: false) { return (due(date, clock), e) }
        return (due(date, defaultTime), end)
    }

    private func timeFirst(_ i: Int) -> (Phrase, Int)? {
        let at = word(i) == "at"
        guard let (clock, vague, end) = time(at ? i + 1 : i, afterAt: at) else { return nil }
        if let (date, _, e) = day(word(end) == "on" ? end + 1 : end) { return (due(date, clock), e) }
        if strict && vague { return nil }
        return (due(today, clock), end)
    }

    private func due(_ date: Date, _ clock: TimeOfDay?) -> Phrase {
        var d = DueDate(date, calendar: calendar)
        if let clock { d.time = String(format: "%02d:%02d", clock.hour, clock.minute) }
        return .due(d)
    }

    // MARK: Times

    /// A time at word `i`: its clock, whether it's a vague word ("morning"), and the end.
    private func time(_ i: Int, afterAt: Bool) -> (TimeOfDay, Bool, Int)? {
        let w = word(i)
        if w == "this", let c = vagueTimes[word(i + 1)] { return (c, false, i + 2) }
        if let c = namedTimes[w] { return (c, false, i + 1) }
        if let c = vagueTimes[w] { return (c, true, i + 1) }
        return clock(i, bare: afterAt || !strict).map { ($0.0, false, $0.1) }
    }

    /// "5pm", "5:30pm", "5 pm", "17:00", "9:05" and, if `bare`, "17".
    private func clock(_ i: Int, bare: Bool) -> (TimeOfDay, Int)? {
        let s = Array(word(i).utf8)
        var p = 0, hour = 0, minute = 0
        while p < s.count, p < 2, let d = digit(s[p]) { hour = hour * 10 + d; p += 1 }
        guard p > 0 else { return nil }
        let hasMinutes = p < s.count && s[p] == UInt8(ascii: ":")
        if hasMinutes {
            guard s.count >= p + 3, let a = digit(s[p + 1]), let b = digit(s[p + 2]) else { return nil }
            minute = a * 10 + b
            p += 3
        }
        var meridiem = String(decoding: s[p...], as: UTF8.self)
        var end = i + 1
        if meridiem.isEmpty, ["am", "pm", "a.m", "p.m"].contains(word(i + 1)) { meridiem = word(i + 1); end += 1 }
        guard meridiem.isEmpty || meridiems.contains(meridiem), minute < 60 else { return nil }
        if meridiem.isEmpty {
            guard hasMinutes || bare, hour < 24 else { return nil }
        } else {
            guard (1...12).contains(hour) else { return nil }
            hour = hour % 12 + (meridiem.hasPrefix("p") ? 12 : 0)
        }
        return ((hour, minute), end)
    }

    // MARK: Days

    /// A day at word `i`: its start, a default time ("tonight"), and the end.
    private func day(_ i: Int) -> (Date, TimeOfDay?, Int)? {
        let w = word(i), next = word(i + 1)
        switch w {
        case "today", "tod": return (today, nil, i + 1)
        case "tomorrow", "tmr", "tmrw": return (add(1), nil, i + 1)
        case "tom" where !strict: return (add(1), nil, i + 1)
        case "yesterday": return (add(-1), nil, i + 1)
        case "tonight": return (today, (19, 0), i + 1)
        case "weekend": return (weekend(), nil, i + 1)
        case "this":
            if let wd = weekdays[next] { return (add((wd - weekday + 7) % 7), nil, i + 2) }
            if next == "weekend" { return (weekend(), nil, i + 2) }
            return nil
        case "next":
            if let wd = weekdays[next] { return (add(daysToNextMonday + (wd + 5) % 7), nil, i + 2) }
            switch next {
            case "week": return (add(daysToNextMonday), nil, i + 2)
            case "weekend": return (add(daysToNextMonday + 5), nil, i + 2)
            case "month", "year":
                let unit: Calendar.Component = next == "month" ? .month : .year
                let start = calendar.dateInterval(of: unit, for: today)!.start
                return (calendar.date(byAdding: unit, value: 1, to: start)!, nil, i + 2)
            default: return nil
            }
        case "in":
            guard let n = amounts[next] ?? number(next, digits: 1...3) else { return nil }
            switch word(i + 2) {
            case "day", "days": return (add(n), nil, i + 3)
            case "week", "weeks": return (add(7 * n), nil, i + 3)
            case "month", "months": return calendar.date(byAdding: .month, value: n, to: today).map { ($0, nil, i + 3) }
            case "year", "years": return calendar.date(byAdding: .year, value: n, to: today).map { ($0, nil, i + 3) }
            default: return nil
            }
        default: break
        }
        if let wd = weekdays[w] { return (add((wd - weekday + 6) % 7 + 1), nil, i + 1) }
        // "oct 25", "october 25th 2027"
        if let m = months[w], let d = dayOfMonth(next) {
            let y = year(word(i + 2))
            return absolute(y, m, d).map { ($0, nil, y == nil ? i + 2 : i + 3) }
        }
        // "25 oct", "25th of october 2027"
        if let d = dayOfMonth(w) {
            let j = next == "of" ? i + 2 : i + 1
            guard let m = months[word(j)] else { return nil }
            let y = year(word(j + 1))
            return absolute(y, m, d).map { ($0, nil, y == nil ? j + 1 : j + 2) }
        }
        return numericDate(w).map { ($0, nil, i + 1) }
    }

    private var weekday: Int { calendar.component(.weekday, from: today) }
    /// 1…7: Monday of next week (weeks start Monday).
    private var daysToNextMonday: Int { (9 - weekday) % 7 == 0 ? 7 : (9 - weekday) % 7 }

    private func add(_ days: Int) -> Date { calendar.date(byAdding: .day, value: days, to: today)! }

    /// Saturday, or today when it's Saturday or Sunday.
    private func weekend() -> Date { weekday == 1 || weekday == 7 ? today : add(7 - weekday) }

    /// "25/10", "10/25", "25/10/2027", "25/10/27", "2026-10-25".
    private func numericDate(_ w: String) -> Date? {
        let dash = w.split(separator: "-", omittingEmptySubsequences: false)
        if dash.count == 3, dash[0].count == 4, let y = number(dash[0], digits: 4...4),
           let m = number(dash[1], digits: 1...2), let d = number(dash[2], digits: 1...2) {
            return absolute(y, m, d)
        }
        let parts = w.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2 || parts.count == 3,
              var d = number(parts[0], digits: 1...2), var m = number(parts[1], digits: 1...2) else { return nil }
        if m > 12 && d <= 12 { swap(&d, &m) }
        var y: Int?
        if parts.count == 3 {
            guard let n = number(parts[2], digits: 2...4), parts[2].count != 3 else { return nil }
            y = n < 100 ? 2000 + n : n
        }
        return absolute(y, m, d)
    }

    /// A valid date; without a year, the first one from today on.
    private func absolute(_ year: Int?, _ month: Int, _ day: Int) -> Date? {
        func make(_ y: Int) -> Date? {
            guard let date = calendar.date(from: DateComponents(year: y, month: month, day: day)),
                  calendar.component(.day, from: date) == day, calendar.component(.month, from: date) == month
            else { return nil }
            return date
        }
        if let year { return make(year) }
        let y = calendar.component(.year, from: today)
        return (y...y + 8).lazy.compactMap(make).first { $0 >= today }
    }

    /// "25", "25th", "1st" (1…31).
    private func dayOfMonth(_ w: String) -> Int? {
        var digits = Substring(w)
        for suffix in ["st", "nd", "rd", "th"] where w.hasSuffix(suffix) { digits = digits.dropLast(2) }
        return number(digits, digits: 1...2).flatMap { (1...31).contains($0) ? $0 : nil }
    }

    /// A four-digit year 2000…2199.
    private func year(_ w: String) -> Int? {
        number(w, digits: 4...4).flatMap { (2000...2199).contains($0) ? $0 : nil }
    }

    private func number<S: StringProtocol>(_ s: S, digits: ClosedRange<Int>) -> Int? {
        guard digits.contains(s.count), s.utf8.allSatisfy({ digit($0) != nil }) else { return nil }
        return Int(s)
    }

    private func digit(_ c: UInt8) -> Int? {
        c >= UInt8(ascii: "0") && c <= UInt8(ascii: "9") ? Int(c - UInt8(ascii: "0")) : nil
    }
}
