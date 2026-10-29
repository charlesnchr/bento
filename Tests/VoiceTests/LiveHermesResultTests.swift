import Testing
@testable import Voice

/// A Hermes reply reaches the voice model whole: one message for Gemini Live,
/// appends the helper accepts for GPT-Live.
@Suite struct LiveHermesResultTests {
    @Test func aShortReplyIsOneAppend() {
        #expect(LiveHermesResult.parts("Sunny, 18 degrees.") == ["Sunny, 18 degrees."])
        #expect(LiveHermesResult.parts("") == ["Hermes returned no text. Do not infer success."])
    }

    @Test func aLongReplyIsSplitAtWordsWithNothingLost() {
        let reply = (0..<300).map { "word\($0) é" }.joined(separator: " ")
        let parts = LiveHermesResult.parts(reply)
        #expect(parts.count > 1)
        #expect(parts.joined() == reply)
        #expect(parts.allSatisfy { !$0.isEmpty && $0.utf8.count <= 400 })
        #expect(parts.dropLast().allSatisfy { $0.last == " " })
    }

    @Test func aReplyWithoutSpacesIsStillSplitWithinTheLimit() {
        let reply = String(repeating: "日本", count: 500)
        let parts = LiveHermesResult.parts(reply)
        #expect(parts.joined() == reply)
        #expect(parts.allSatisfy { $0.utf8.count <= 400 })
    }

    @Test func aGraphemeClusterTooLongForOneAppendIsNotDropped() {
        let reply = "a" + String(repeating: "\u{301}", count: 300)
        let parts = LiveHermesResult.parts(reply)
        #expect(parts.count > 1)
        #expect(parts.joined().unicodeScalars.elementsEqual(reply.unicodeScalars))
        #expect(parts.allSatisfy { !$0.isEmpty && $0.utf8.count <= 400 })
    }

    @Test func geminiGetsTheWholeReplyInOneMessage() throws {
        let reply = String(repeating: "word ", count: 8000)
        let frame = GeminiLiveProtocol.response(id: "a", message: reply, executed: true)
        let calls = try #require((frame["toolResponse"] as? [String: Any])?["functionResponses"] as? [[String: Any]])
        #expect((calls.first?["response"] as? [String: Any])?["message"] as? String == reply)
    }

    @Test func onlyAReplyPastBentosLimitIsMarked() {
        let exact = String(repeating: "x", count: 64000)
        #expect(LiveHermesResult.full(exact) == exact)
        let huge = String(repeating: "x", count: 70000)
        #expect(LiveHermesResult.full(huge) == exact + " [Bento cut Hermes's reply here at 64000 characters.]")
        #expect(LiveHermesResult.parts(huge).joined() == LiveHermesResult.full(huge))
    }
}
