import Foundation

/// Client delegation carries an ID, not task text. Only an explicitly delegated,
/// unconsumed user utterance is sent to Hermes. Transcripts never execute alone.
struct AzureLiveProtocol {
    struct Delegation: Equatable { let id: String; let offsetMS: Double }
    struct Call: Equatable { let id: String; let task: String; let context: String }
    private struct Fragment {
        let role: String
        let start: Double
        let end: Double
        let text: String
    }
    private var seen = Set<String>()
    private var fragments: [Fragment] = []
    private var consumedThrough = -1.0
    private var evictedUserThrough = -1.0
    private var lastUserEnd = -1.0

    mutating func transcript(_ event: [String: Any]) -> Bool {
        let role: String
        switch event["type"] as? String {
        case "session.input_transcript.delta": role = "user"
        case "session.output_transcript.delta": role = "assistant"
        default: return false
        }
        guard let text = event["delta"] as? String, !text.isEmpty, text.utf8.count <= 12000,
              let start = event["start_ms"] as? Double, let end = event["end_ms"] as? Double,
              start.isFinite, end.isFinite, start >= 0, end > start else { return false }
        if role == "user" {
            guard start >= lastUserEnd else { return false }
            lastUserEnd = end
        }
        fragments.append(Fragment(role: role, start: start, end: end, text: text))
        while fragments.count > 128 || fragments.reduce(0, { $0 + $1.text.utf8.count }) > 12000 {
            let removed = fragments.removeFirst()
            if removed.role == "user" { evictedUserThrough = removed.end }
        }
        return role == "user"
    }

    mutating func delegation(_ event: [String: Any]) -> Delegation? {
        guard event["type"] as? String == "session.delegation.created",
              let value = event["delegation"] as? [String: Any],
              value["type"] as? String == "delegation", value["target"] as? String == "client",
              let id = value["id"] as? String, !id.isEmpty, id.count < 200,
              !seen.contains(id), seen.count < 256,
              let offset = event["offset_ms"] as? Double, offset.isFinite, offset >= 0 else { return nil }
        seen.insert(id)
        return Delegation(id: id, offsetMS: offset)
    }

    mutating func request(for delegation: Delegation) -> Call? {
        let user = fragments.filter { $0.role == "user" && $0.end > consumedThrough }
        // Bind to the utterance at delegation time, not a newer follow-up that
        // happened to arrive while transcript settling/approval was pending.
        guard let anchor = user.lastIndex(where: { $0.start <= delegation.offsetMS + 200 }),
              user[anchor].end >= delegation.offsetMS - 5000 else { return nil }
        var first = anchor, last = anchor
        while first > 0, user[first].start - user[first - 1].end < 1200 { first -= 1 }
        while last + 1 < user.count, user[last + 1].start - user[last].end < 1200 { last += 1 }
        // If the utterance began before the bounded history, do not offer a partial task.
        guard user[first].start - evictedUserThrough >= 1200 || evictedUserThrough < 0 else { return nil }
        let utterance = user[first...last].map(\.text).joined().trimmingCharacters(in: .whitespacesAndNewlines)
        consumedThrough = user[last].end
        guard !utterance.isEmpty, utterance.count <= 4000 else { return nil }
        let context = fragments.filter { $0.end <= user[first].start }.map {
            "\($0.role): \($0.text)"
        }.joined(separator: "\n")
        return Call(id: delegation.id, task: utterance, context: String(context.suffix(6000)))
    }

    mutating func discardRequest(for delegation: Delegation) { _ = request(for: delegation) }

    static func spokenResult(_ result: String) -> String {
        if result.utf8.count <= 400 { return result.isEmpty ? "Hermes returned no text. Do not infer success." : result }
        let prefix = "Truncated excerpt. Full reply is visible in Bento's assistant window: "
        var text = prefix
        for character in result {
            let next = String(character)
            if text.utf8.count + next.utf8.count > 400 { break }
            text += next
        }
        return text
    }
}
