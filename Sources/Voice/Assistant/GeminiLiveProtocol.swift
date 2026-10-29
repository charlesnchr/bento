import Foundation

/// The Gemini counterpart of `AzureLiveProtocol`. A function call is only a request
/// ID: Hermes gets the user's own transcribed, unconsumed words, never text the voice
/// model wrote, and transcripts never execute alone.
///
/// Gemini marks each user turn with voiceActivity ACTIVITY_START and ACTIVITY_END; the
/// probe (October 2026) saw the transcript inside that window and the call just after
/// it. A call belongs to the turn it answers, so earlier speech the model never acted
/// on and follow-ups after the call are never its request, and a transcript that
/// trails the call still joins its own turn.
struct GeminiLiveProtocol {
    static let tool = "ask_hermes"
    struct Delegation: Equatable { let id: String; let at: Double; let turn: Int? }
    private struct Turn {
        let id: Int
        let started: Double
        var ended: Double?
        var heard: Double?
        var text = ""
        var consumed = false
        /// Its first words may be the previous turn's late transcript.
        var ambiguous = false
    }
    private struct Fragment { let role: String; let at: Double; let text: String }
    private var seen = Set<String>()
    private var turns: [Turn] = []
    private var history: [Fragment] = []
    private var nextTurn = 0

    /// A new user turn begins (ACTIVITY_START).
    mutating func activityStarted(at: Double) {
        guard at.isFinite, at >= (turns.last?.started ?? 0) else { return }
        var turn = Turn(id: nextTurn, started: at)
        if let previous = turns.last, previous.text.isEmpty, previous.ended.map({ at - $0 < 3 }) ?? true { turn.ambiguous = true }
        turns.append(turn)
        nextTurn += 1
        if turns.count > 32 { turns.removeFirst() }
    }

    /// The current user turn ends (ACTIVITY_END).
    mutating func activityEnded(at: Double) {
        guard at.isFinite, let last = turns.indices.last, turns[last].ended == nil, at >= turns[last].started else { return }
        turns[last].ended = at
    }

    /// Records a transcript fragment for context and, for the user, the current turn.
    mutating func transcript(role: String, text: String, at: Double) {
        guard role == "user" || role == "assistant", !text.isEmpty, text.utf8.count <= 12000,
              at.isFinite, at >= (history.last?.at ?? 0) else { return }
        history.append(Fragment(role: role, at: at, text: text))
        while history.count > 128 || history.reduce(0, { $0 + $1.text.utf8.count }) > 12000 { history.removeFirst() }
        // User words join the latest turn even after its end; a consumed turn keeps
        // its late words, so they can never run.
        guard role == "user", let last = turns.indices.last else { return }
        // Past 4,000 characters a turn never runs, so it stops growing.
        if turns[last].text.count <= 4000 { turns[last].text += text }
        turns[last].heard = at
    }

    /// A new call of the one tool, or nil for anything else (unknown name, repeated or bad ID).
    mutating func delegation(_ call: [String: Any], at: Double) -> Delegation? {
        guard call["name"] as? String == Self.tool, let id = call["id"] as? String, !id.isEmpty, id.count < 200,
              !seen.contains(id), seen.count < 256, at.isFinite, at >= 0 else { return nil }
        seen.insert(id)
        let started = turns.filter { $0.started <= at }
        var turn = started.last
        // The model answers a turn just after its end, so a turn still open when the call
        // arrives is a follow-up to one that ended moments before. If an unanswered turn
        // ended a little earlier, which turn the call answers is unclear and nothing runs.
        if let open = turn, open.ended == nil, started.count > 1, !started[started.count - 2].consumed,
           let end = started[started.count - 2].ended, end >= at - 8 {
            turn = at - end <= 2 ? started[started.count - 2] : nil
        }
        return Delegation(id: id, at: at, turn: turn?.id)
    }

    /// Whether the call's turn has ended with words, and when it last changed.
    func turnState(for delegation: Delegation) -> (complete: Bool, changed: Double?) {
        guard let turn = turns.first(where: { $0.id == delegation.turn }) else { return (false, nil) }
        return (turn.ended != nil && !turn.text.isEmpty, [turn.ended, turn.heard].compactMap { $0 }.max())
    }

    /// Consumes a declined call's turn so a later call cannot replay it.
    mutating func discardRequest(for delegation: Delegation) {
        if let index = turns.firstIndex(where: { $0.id == delegation.turn }) { turns[index].consumed = true }
    }

    mutating func request(for delegation: Delegation) -> AzureLiveProtocol.Call? {
        guard let index = turns.firstIndex(where: { $0.id == delegation.turn }), !turns[index].consumed else { return nil }
        turns[index].consumed = true
        let turn = turns[index]
        // Speech the model left unanswered for long is not this call's request.
        guard let ended = turn.ended, ended >= delegation.at - 8, !turn.ambiguous, turn.text.count <= 4000 else { return nil }
        let task = turn.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !task.isEmpty else { return nil }
        let context = history.filter { $0.at < turn.started }.map { "\($0.role): \($0.text)" }.joined(separator: "\n")
        return AzureLiveProtocol.Call(id: delegation.id, task: task, context: String(context.suffix(6000)))
    }

    /// A function response in the shape Google asks for: status, retryable and a message.
    /// WHEN_IDLE waits for the user to finish speaking, so the model always says the outcome.
    static func response(id: String, name: String = tool, message: String, executed: Bool) -> [String: Any] {
        ["toolResponse": ["functionResponses": [[
            "id": id, "name": name, "scheduling": "WHEN_IDLE",
            "response": ["status": executed ? "ok" : "not_executed", "retryable": false, "message": AzureLiveProtocol.fullResult(message)],
        ] as [String: Any]]]]
    }
}
