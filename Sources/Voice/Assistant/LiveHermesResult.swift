/// What a voice model gets for a Hermes reply, on every route: Azure GPT-Live and
/// Gemini Live here, and Gemini Live on Android (`CallProtocol.fullResult`).
enum LiveHermesResult {
    /// The most of a Hermes reply Bento keeps, on screen and for the voice model.
    static let limit = 64000

    /// All of the reply, marked only if Bento cut it at `limit`.
    static func full(_ result: String) -> String {
        if result.isEmpty { return "Hermes returned no text. Do not infer success." }
        guard result.count > limit else { return result }
        return result.prefix(limit) + " [Bento cut Hermes's reply here at \(limit) characters.]"
    }

    /// `full` as consecutive GPT-Live appends for one delegation, split at whitespace
    /// where possible. Each stays within the helper's 400 UTF-8 bytes (the API caps an
    /// append at 500 tokens but accepts several per delegation).
    static func parts(_ result: String, bytes: Int = 400) -> [String] {
        var parts: [String] = [], part = ""
        for character in full(result) {
            // A grapheme cluster too long for one append goes scalar by scalar.
            let pieces = character.utf8.count <= bytes ? [String(character)] : character.unicodeScalars.map { String($0) }
            for piece in pieces {
                while !part.isEmpty, part.utf8.count + piece.utf8.count > bytes {
                    if let space = part.lastIndex(where: \.isWhitespace), space > part.startIndex {
                        parts.append(String(part[...space])); part = String(part[part.index(after: space)...])
                    } else { parts.append(part); part = "" }
                }
                part += piece
            }
        }
        if !part.isEmpty { parts.append(part) }
        return parts
    }
}
