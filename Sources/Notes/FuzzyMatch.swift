import Foundation

/// Small fuzzy matcher for the notes list (Raycast-like: subsequence match with
/// bonuses for word starts and consecutive characters).
enum FuzzyMatch {
    /// Score of `query` against `text` (higher is better), nil when not matched.
    static func score(_ query: String, _ text: String) -> Int? {
        let q = Array(query.lowercased().unicodeScalars.filter { !CharacterSet.whitespaces.contains($0) })
        guard !q.isEmpty else { return 0 }
        let t = Array(text.lowercased().unicodeScalars)
        guard t.count >= q.count else { return nil }
        // Exact substring gets a big bonus.
        if let r = text.lowercased().range(of: query.lowercased().trimmingCharacters(in: .whitespaces)) {
            let pos = text.lowercased().distance(from: text.lowercased().startIndex, to: r.lowerBound)
            return 1000 - min(pos, 500) + (pos == 0 ? 200 : 0)
        }
        var score = 0
        var ti = 0
        var prevMatch = -2
        for qc in q {
            var found = false
            while ti < t.count {
                if t[ti] == qc {
                    var s = 10
                    if ti == prevMatch + 1 { s += 15 }
                    if ti == 0 || !CharacterSet.alphanumerics.contains(t[ti - 1]) { s += 20 }
                    score += s
                    prevMatch = ti
                    ti += 1
                    found = true
                    break
                }
                ti += 1
            }
            if !found { return nil }
        }
        return score - min(t.count / 10, 50)
    }

    /// Scores a note: title (fuzzy) weighs more than body (substring/fuzzy on words).
    static func noteScore(_ query: String, title: String, body: String) -> Int? {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return 0 }
        var best: Int?
        if let s = score(q, title) { best = s + 500 }
        // body: every word of the query must appear
        let words = q.lowercased().split(separator: " ")
        let lower = body.lowercased()
        if words.allSatisfy({ lower.contains($0) }) {
            let s = 300 - min(lower.count / 200, 100)
            best = max(best ?? Int.min, s)
        }
        return best
    }
}
