import Foundation
import Testing
import VoiceCore
@testable import Voice

/// A Gemini call waiting on Hermes in silence leaves the connection, and comes back to speak
/// the answer: the controller against scripted sockets and a fake microphone.
@MainActor
@Suite(.serialized) struct GeminiLiveStandbyTests {
    /// A socket that answers the setup, records what it's sent, and fails once closed.
    final class Socket: LiveTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var inbox: [Data] = []
        private var frames: [Data] = []
        private var closed = false
        private var holding = false

        init(setsUp: Bool = true) { if setsUp { push(#"{"setupComplete":{}}"#) } }

        func push(_ json: String) { lock.withLock { inbox.append(Data(json.utf8)) } }
        /// Sends from now on wait until the socket closes, then fail.
        func holdSends() { lock.withLock { holding = true } }
        var isClosed: Bool { lock.withLock { closed } }
        var sent: [[String: Any]] {
            lock.withLock { frames }.compactMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        }
        func sent(_ key: String) -> [[String: Any]] { sent.filter { $0[key] != nil } }

        func connect() async throws {}
        func send(_ data: Data) async throws {
            if lock.withLock({ holding }) {
                while !isClosed { try await Task.sleep(for: .milliseconds(5)) }
            }
            guard !isClosed else { throw URLError(.networkConnectionLost) }
            lock.withLock { frames.append(data) }
        }
        func receive() async throws -> Data {
            while true {
                if let data = lock.withLock({ inbox.isEmpty ? nil : inbox.removeFirst() }) { return data }
                if isClosed { throw URLError(.networkConnectionLost) }
                try await Task.sleep(for: .milliseconds(5))
            }
        }
        func close() { lock.withLock { closed = true } }
    }

    /// A microphone delivering 20 ms frames until stopped; playback goes nowhere.
    final class Microphone: LiveCallAudio {
        var onFailure: ((String) -> Void)?
        private var feeder: Task<Void, Never>?
        func start(sink: @escaping @Sendable (Data) -> Void) throws {
            feeder = Task.detached {
                while !Task.isCancelled { sink(Data(count: 640)); try? await Task.sleep(for: .milliseconds(20)) }
            }
        }
        func play(_ pcm: Data, startMS: Double?, endMS: Double?) {}
        func flush() {}
        func stop() { feeder?.cancel() }
    }

    /// Hermes's answer, given when the test says.
    actor Answer {
        private var text: String?
        func give(_ answer: String) { text = answer }
        func wait() async -> String {
            while text == nil { try? await Task.sleep(for: .milliseconds(10)) }
            return text!
        }
    }

    final class Sockets {
        var made: [Socket] = []
        var next: () -> Socket = { Socket() }
    }

    private func eventually(_ what: Comment, timeout: Double = 5, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline { Issue.record("Timed out: \(what)"); return }
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    /// A call that asked Hermes something on its first socket and stands by after 0.3 s of silence.
    private func waitingOnHermes(_ sockets: Sockets, answer: Answer, wrap: ((Socket) -> LiveTransport)? = nil, standbyAfter: Double = 0.3,
                                 onAsk: @escaping @MainActor () -> Void = {}) async throws -> GeminiLiveController {
        let controller = GeminiLiveController(makeTransport: { _ in
            let socket = sockets.next()
            sockets.made.append(socket)
            return wrap?(socket) ?? socket
        }, audio: Microphone(), permitted: { true }, tick: .milliseconds(50))
        controller.standbyAfter = { standbyAfter }
        controller.recap = { "User: what's on today?" }
        controller.onTool = { _ in
            await MainActor.run { onAsk() }
            return await answer.wait()
        }
        try controller.start(recap: nil)
        let first = sockets.made[0]
        await eventually("listening") { !first.sent("realtimeInput").isEmpty }
        first.push(#"{"voiceActivity":{"type":"ACTIVITY_START"}}"#)
        first.push(#"{"serverContent":{"inputTranscription":{"text":"What's on today?"}}}"#)
        first.push(#"{"voiceActivity":{"type":"ACTIVITY_END"}}"#)
        first.push(#"{"toolCall":{"functionCalls":[{"id":"c1","name":"ask_hermes","args":{}}]}}"#)
        await eventually("standby") { controller.standby }
        return controller
    }

    @Test func silenceWhileHermesWorksLeavesGeminiAndTheAnswerBringsTheCallBack() async throws {
        let sockets = Sockets(), answer = Answer()
        let controller = try await waitingOnHermes(sockets, answer: answer)
        #expect(sockets.made.count == 1, "No new connection until it's needed")
        #expect(sockets.made[0].isClosed)
        let sentBefore = sockets.made[0].sent.count
        try await Task.sleep(for: .milliseconds(200))
        #expect(sockets.made[0].sent.count == sentBefore, "The microphone goes nowhere in standby")
        await answer.give("Dentist at 3pm.")
        await eventually("the answer goes in") { sockets.made.count == 2 && !sockets.made[1].sent("hermesResult").isEmpty }
        #expect(sockets.made[1].sent("hermesResult").first?["hermesResult"] as? String == "Dentist at 3pm.")
        #expect(sockets.made.allSatisfy { $0.sent("toolResponse").isEmpty }, "The old session's call went with it")
        #expect(!controller.standby && controller.active)
        await eventually("listening again") { !sockets.made[1].sent("realtimeInput").isEmpty }
        controller.stop()
    }

    @Test func onTheGeminiAPITheAnswerIsATurnAfterTheRecap() async throws {
        let sockets = Sockets(), answer = Answer()
        let setup = try #require(GeminiAPILiveTransport.setupFrame())
        let controller = try await waitingOnHermes(sockets, answer: answer, wrap: { socket in
            GeminiAPILiveTransport(socket: socket, setup: setup, recap: try? GeminiAPILiveTransport.recapFrame("User: what's on today?"))
        })
        await answer.give("Dentist at 3pm.")
        await eventually("the answer goes in") {
            sockets.made.count == 2 && sockets.made[1].sent("clientContent").count == 2
        }
        let turns = sockets.made[1].sent("clientContent").compactMap { $0["clientContent"] as? [String: Any] }
        #expect(turns.map { $0["turnComplete"] as? Bool } == [false, true])
        let text = ((turns[1]["turns"] as? [[String: Any]])?.first?["parts"] as? [[String: Any]])?.first?["text"] as? String
        #expect(text == (try LiveResume.result("Dentist at 3pm.")))
        controller.stop()
    }

    @Test func talkingFirstKeepsTheConnectionTheAnswerFollowsOnIt() async throws {
        let sockets = Sockets(), answer = Answer()
        let controller = try await waitingOnHermes(sockets, answer: answer)
        controller.wake()
        await eventually("back on Gemini") { sockets.made.count == 2 && !controller.standby }
        await eventually("listening") { !sockets.made[1].sent("realtimeInput").isEmpty }
        await answer.give("Done.")
        await eventually("the answer goes in") { !sockets.made[1].sent("hermesResult").isEmpty }
        try await Task.sleep(for: .milliseconds(100))
        #expect(sockets.made.count == 2, "The connection the user talks on stays")
        #expect(!sockets.made[1].isClosed && controller.active)
        controller.stop()
    }

    @Test func anAnswerDuringTheComebackWaitsForItsSetup() async throws {
        let sockets = Sockets(), answer = Answer()
        let controller = try await waitingOnHermes(sockets, answer: answer)
        sockets.next = { Socket(setsUp: false) }
        controller.wake()
        await eventually("reconnecting") { sockets.made.count == 2 }
        await answer.give("Done.")
        try await Task.sleep(for: .milliseconds(200))
        #expect(sockets.made[1].sent.isEmpty, "Gemini takes nothing before setupComplete")
        sockets.made[1].push(#"{"setupComplete":{}}"#)
        await eventually("the answer goes in") { !sockets.made[1].sent("hermesResult").isEmpty }
        #expect(sockets.made.count == 2)
        controller.stop()
    }

    @Test func aComebackTheHelperRefusesAsBusyTriesAgain() async throws {
        let sockets = Sockets(), answer = Answer()
        let controller = try await waitingOnHermes(sockets, answer: answer)
        // The helper still holds the call left for standby; the next try gets through.
        sockets.next = { [unowned sockets] in
            sockets.next = { Socket() }
            let busy = Socket(setsUp: false)
            busy.push(#"{"error":{"message":"Gemini Live call ended","code":"busy"}}"#)
            return busy
        }
        await answer.give("Done.")
        await eventually("the answer goes in on the second try") { sockets.made.count == 3 && !sockets.made[2].sent("hermesResult").isEmpty }
        #expect(sockets.made[1].isClosed && controller.active)
        controller.stop()
    }

    @Test func aCancelledRequestFinishingInStandbyBringsTheCallBackSilently() async throws {
        let sockets = Sockets(), answer = Answer()
        // The user talks over Gemini and it cancels the call; Hermes works on, and the call stands by later.
        let controller = try await waitingOnHermes(sockets, answer: answer, standbyAfter: 1.5, onAsk: {
            sockets.made[0].push(#"{"toolCallCancellation":{"ids":["c1"]}}"#)
        })
        await answer.give("Done.")
        await eventually("back on Gemini") { sockets.made.count == 2 && !controller.standby }
        await eventually("listening") { !sockets.made[1].sent("realtimeInput").isEmpty }
        #expect(sockets.made[1].sent("hermesResult").isEmpty, "Gemini cancelled that request")
        controller.stop()
    }

    @Test func aSendCaughtByStandbyDoesntEndTheCall() async throws {
        let sockets = Sockets(), answer = Answer()
        // The microphone's next send hangs until standby closes the socket under it.
        let controller = try await waitingOnHermes(sockets, answer: answer, onAsk: { sockets.made[0].holdSends() })
        try await Task.sleep(for: .milliseconds(200))
        #expect(controller.active && controller.standby)
        await answer.give("Done.")
        await eventually("the answer goes in") { sockets.made.count == 2 && !sockets.made[1].sent("hermesResult").isEmpty }
        controller.stop()
    }

    @Test func neverMeansTheCallStaysOnGemini() async throws {
        let sockets = Sockets(), answer = Answer()
        let controller = GeminiLiveController(makeTransport: { _ in let s = Socket(); sockets.made.append(s); return s },
                                              audio: Microphone(), permitted: { true }, tick: .milliseconds(50))
        controller.standbyAfter = { 0 }
        controller.onTool = { _ in await answer.wait() }
        try controller.start(recap: nil)
        let first = sockets.made[0]
        await eventually("listening") { !first.sent("realtimeInput").isEmpty }
        first.push(#"{"voiceActivity":{"type":"ACTIVITY_START"}}"#)
        first.push(#"{"serverContent":{"inputTranscription":{"text":"Book it"}}}"#)
        first.push(#"{"voiceActivity":{"type":"ACTIVITY_END"}}"#)
        first.push(#"{"toolCall":{"functionCalls":[{"id":"c1","name":"ask_hermes","args":{}}]}}"#)
        try await Task.sleep(for: .milliseconds(1500))
        #expect(!controller.standby && !first.isClosed)
        await answer.give("Booked.")
        await eventually("a normal tool result") { !first.sent("toolResponse").isEmpty }
        controller.stop()
    }
}
