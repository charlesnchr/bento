import Foundation

/// What Todoist-style quick add text means: "Buy milk tomorrow #Errands @shop p1".
struct QuickAddResult: Equatable {
    /// The text without the recognised tokens, whitespace collapsed.
    var title: String
    /// Project name after `#`: an existing project's spelling when one matched, else the
    /// raw word (the caller decides whether to create it or fall back to the Inbox).
    var project: String?
    /// Labels after `@`, deduplicated case-insensitively, in order.
    var labels: [String]
    /// 1 (p1, highest) … 4.
    var priority: Int?
    var due: DueDate?
    /// "no date" / "no due date": remove the due date.
    var clearDue: Bool
    /// Recognised tokens in text order, for highlighting in the input field.
    var tokens: [Token]

    struct Token: Equatable {
        enum Kind { case project, label, priority, date }
        var kind: Kind
        /// UTF-16 range in the input text (NSTextView coordinates).
        var range: NSRange
    }
}

/// Parses quick add text:
/// - `#Project`: the longest existing project (case-insensitive, may contain spaces)
///   that the text continues with up to a word boundary, else the word after `#`.
/// - `@label`: likewise with existing labels, else `[A-Za-z0-9_-]+`.
/// - `p1`…`p4` as a standalone word.
/// - one date phrase (`DateParser.findPhrase`, the longest; the last on ties).
///
/// `#`/`@` only count at the start of a word, so e-mail addresses (a@b.com), URLs
/// (x.com/@me, page#anchor) and "C#" stay in the title. When the text has several
/// projects or priorities the last one wins and the others stay in the title.
enum QuickAddParser {
    typealias Token = QuickAddResult.Token

    static func parse(_ text: String, projects: [String], labels: [String], now: Date = Date(),
                      calendar: Calendar = .current) -> QuickAddResult {
        var result = QuickAddResult(title: "", labels: [], clearDue: false, tokens: [])
        var found: [(kind: Token.Kind, range: Range<String.Index>)] = []
        var projectToken: (name: String, range: Range<String.Index>)?
        var priorityToken: (value: Int, range: Range<String.Index>)?
        var excluded: [Range<String.Index>] = []

        var i = text.startIndex
        while i < text.endIndex {
            if text[i].isWhitespace { i = text.index(after: i); continue }
            let wordEnd = text[i...].firstIndex(where: \.isWhitespace) ?? text.endIndex
            let word = trimmed(text[i..<wordEnd])
            var end = wordEnd
            switch text[i] {
            case "#":
                if let (name, e) = sigil(text, at: i, known: projects, isValid: { _ in true }) {
                    projectToken = (name, i..<e)
                    excluded.append(i..<e)
                    end = max(e, end)
                }
            case "@":
                if let (name, e) = sigil(text, at: i, known: labels, isValid: isLabelWord) {
                    if !result.labels.contains(where: { $0.caseInsensitiveCompare(name) == .orderedSame }) {
                        result.labels.append(name)
                    }
                    found.append((.label, i..<e))
                    excluded.append(i..<e)
                    end = max(e, end)
                }
            default:
                if word.count == 2, let c = word.last?.wholeNumberValue, (1...4).contains(c),
                   word.first == "p" || word.first == "P" {
                    priorityToken = (c, word.startIndex..<word.endIndex)
                    excluded.append(i..<wordEnd)
                }
            }
            // A multi-word name may end inside a word ("#Side Project," ends before ",").
            i = end > wordEnd ? (text[end...].firstIndex(where: \.isWhitespace) ?? text.endIndex) : wordEnd
        }
        if let projectToken {
            result.project = projectToken.name
            found.append((.project, projectToken.range))
        }
        if let priorityToken {
            result.priority = priorityToken.value
            found.append((.priority, priorityToken.range))
        }
        if let m = DateParser.findPhrase(in: text, excluding: excluded, now: now, calendar: calendar) {
            switch m.phrase {
            case .due(let due): result.due = due
            case .clear: result.clearDue = true
            }
            found.append((.date, m.range))
        }

        found.sort { $0.range.lowerBound < $1.range.lowerBound }
        result.tokens = found.map { Token(kind: $0.kind, range: NSRange($0.range, in: text)) }
        result.title = title(text, removing: found.map(\.range))
        return result
    }

    /// Autocomplete context at the caret (UTF-16 offset): typing "#Wo|" gives
    /// (.project, "Wo", range of "#Wo"). The query runs from the sigil to the caret; the
    /// range covers the whole word so accepting a completion replaces all of it.
    static func completionContext(_ text: String, caret: Int) -> (kind: Token.Kind, query: String, range: NSRange)? {
        let u = Array(text.utf16)
        let caret = min(max(caret, 0), u.count)
        let isSpace = { (c: UInt16) in c == 32 || c == 9 || c == 10 || c == 13 || c == 0xA0 }
        var start = caret
        while start > 0, !isSpace(u[start - 1]) {
            start -= 1
            guard u[start] == 35 || u[start] == 64 else { continue }  // "#", "@"
            guard start == 0 || isSpace(u[start - 1]) else { return nil }
            var end = caret
            while end < u.count, !isSpace(u[end]) { end += 1 }
            let query = String(decoding: u[(start + 1)..<caret], as: UTF16.self)
            return (u[start] == 35 ? .project : .label, query, NSRange(location: start, length: end - start))
        }
        return nil
    }

    // MARK: - Helpers

    private static let trailing: Set<Character> = [".", ",", ";", ":", "!", "?", ")", "]", "\"", "'"]

    private static func trimmed(_ s: Substring) -> Substring {
        var s = s
        while let c = s.last, trailing.contains(c) { s = s.dropLast() }
        return s
    }

    private static func isLabelWord(_ s: Substring) -> Bool {
        !s.isEmpty && s.unicodeScalars.allSatisfy {
            $0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "_" || $0 == "-")
        }
    }

    /// The name after the sigil at `i` and the end of the token: the longest `known`
    /// name ending at a word boundary, else the word (if `isValid`).
    private static func sigil(_ text: String, at i: String.Index, known: [String],
                              isValid: (Substring) -> Bool) -> (String, String.Index)? {
        let start = text.index(after: i)
        var best: (String, String.Index)?
        for name in known where !name.isEmpty {
            guard let r = text.range(of: name, options: [.caseInsensitive, .anchored], range: start..<text.endIndex),
                  r.upperBound > best?.1 ?? start, isBoundary(text, r.upperBound) else { continue }
            best = (name, r.upperBound)
        }
        if let best { return best }
        let word = trimmed(text[start..<(text[start...].firstIndex(where: \.isWhitespace) ?? text.endIndex)])
        return !word.isEmpty && isValid(word) ? (String(word), word.endIndex) : nil
    }

    /// End of text, whitespace, or trailing punctuation.
    private static func isBoundary(_ text: String, _ i: String.Index) -> Bool {
        i == text.endIndex || text[i].isWhitespace || trailing.contains(text[i])
    }

    /// `text` without `ranges` (sorted, disjoint), whitespace collapsed. Punctuation
    /// that followed a removed token sticks to the previous word ("Call Bob tomorrow,
    /// then" → "Call Bob, then"), and a dangling "," or ";" at the end is dropped.
    private static func title(_ text: String, removing ranges: [Range<String.Index>]) -> String {
        guard !ranges.isEmpty else { return collapse(Substring(text)) }
        var out = ""
        var pos = text.startIndex
        for r in ranges {
            out += text[pos..<r.lowerBound]
            pos = r.upperBound
            if pos < text.endIndex, ",;:.!?".contains(text[pos]) {
                while out.last?.isWhitespace == true { out.removeLast() }
            }
        }
        out += text[pos...]
        var title = collapse(Substring(out))
        while let c = title.last, c == "," || c == ";" || c == ":" { title.removeLast() }
        return title.trimmingCharacters(in: .whitespaces)
    }

    private static func collapse(_ s: Substring) -> String {
        s.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
}
