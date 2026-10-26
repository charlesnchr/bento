import Foundation

/// Dictated thoughts appended to the capture note (`notes.captureNoteID`), one
/// expander each:
///
///     ::: details 2026-10-26 14:05 · Add a capture mode to the…
///     Add a capture mode to the transcribe shortcut that appends to a note.
///     :::
///
/// The summary is the local date and time (no seconds) and the first few words; the
/// body is the full text. Entries are separated by a blank line. Plain markdown text, so
/// sync and other clients see an ordinary note body.
enum ThoughtCapture {
    /// Words of the text shown in the summary.
    static let summaryWords = 6

    static func entry(_ text: String, at date: Date = Date(), timeZone: TimeZone = .current) -> String? {
        let body = cleaned(text)
        guard !body.isEmpty else { return nil }
        return "::: details \(timestamp(date, timeZone: timeZone)) · \(summary(of: body))\n\(body)\n:::"
    }

    /// `body` with `entry` appended after a blank line.
    static func append(_ entry: String, to body: String) -> String {
        var head = body
        while let last = head.last, last.isWhitespace { head.removeLast() }
        return head.isEmpty ? entry + "\n" : head + "\n\n" + entry + "\n"
    }

    /// "2026-10-26 14:05".
    static func timestamp(_ date: Date, timeZone: TimeZone = .current) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = timeZone
        f.dateFormat = "yyyy-MM-dd HH:mm"
        return f.string(from: date)
    }

    /// The first `summaryWords` words on one line, "…" when there are more.
    static func summary(of text: String) -> String {
        let words = text.split(whereSeparator: { $0.isWhitespace })
        let head = words.prefix(summaryWords).joined(separator: " ")
        return words.count > summaryWords ? head + "…" : head
    }

    /// Trimmed, "\n" line ends, no blank-line runs, and no line that would end the
    /// expander early (expander syntax is escaped, an open code fence closed).
    static func cleaned(_ text: String) -> String {
        let normalised = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
            .replacingOccurrences(of: "\u{0}", with: "")
        var lines: [String] = []
        for line in normalised.components(separatedBy: "\n") {
            let blank = line.trimmingCharacters(in: .whitespaces).isEmpty
            if blank, lines.last?.isEmpty != false { continue }
            switch MarkdownParser.parseLine(line, inCode: false).kind {
            case .details, .detailsEnd: lines.append("\\" + line.trimmingCharacters(in: .whitespaces))
            default: lines.append(blank ? "" : line)
            }
        }
        var body = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        // an unclosed code fence would swallow the closing ":::"
        if MarkdownParser.isInCode(body + "\n" as NSString, lineStart: (body as NSString).length + 1) { body += "\n```" }
        return body
    }
}
