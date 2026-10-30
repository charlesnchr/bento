import Foundation
import VoiceCore

/// A continuous voice call that hands spoken requests to Hermes. The assistant
/// starts whichever provider Settings selects; only one call runs at a time.
@MainActor
protocol LiveVoiceSession: AnyObject {
    var provider: SettingsStore.AssistantLiveProvider { get }
    var active: Bool { get }
    var onStatus: ((String) -> Void)? { get set }
    var onTranscript: ((String, String) -> Void)? { get set }
    var onEnd: (() -> Void)? { get set }
    var onTool: ((AzureLiveProtocol.Call) async -> String)? { get set }
    /// `recap` is the earlier call's transcript when this one resumes it (`AssistantTranscript.liveRecap`).
    func start(recap: String?) throws
    func stop()
}

/// How a resumed call is told about the conversation it continues: a fixed line for the
/// instructions and the earlier call's transcript, fenced, as reference only. The wording lives
/// in `helper/live_resume.json`, which the helpers read too (`azure_live.resume_context`), so
/// every route says the same; this is the Gemini API path's copy of that code.
enum LiveResume {
    struct Context: Equatable {
        /// Appended to the call's system instruction.
        let instruction: String
        /// The fenced transcript, sent as the first user turn.
        let recap: String
    }

    /// Nil for a new call, which never reads the file.
    static func context(_ recap: String, from url: URL? = VoiceResources.url("live_resume", "json", in: "helper")) throws -> Context? {
        guard !recap.isEmpty else { return nil }
        guard let url, let data = try? Data(contentsOf: url),
              let resume = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let limit = resume["recapLimit"] as? Int, let tag = resume["tag"] as? String,
              let instruction = resume["instruction"] as? String, let preamble = resume["preamble"] as? String else {
            throw ACPClient.Failure(message: "The wording for resumed calls (live_resume.json) is missing from Bento.")
        }
        guard recap.unicodeScalars.count <= limit else {
            throw ACPClient.Failure(message: "The earlier conversation is too long to resume. Press New Chat to start a new call.")
        }
        // The transcript can't close its own fence.
        let recap = fenced(recap, tag: tag)
        guard !recap.isEmpty else { return nil }
        return Context(instruction: " " + instruction, recap: preamble + "\n<" + tag + ">\n" + recap + "\n</" + tag + ">")
    }

    /// What a call back from standby hears about the request it waited on: a fixed line and
    /// Hermes's reply, cut to an excerpt and fenced like the recap (`azure_live.standby_result`).
    static func result(_ reply: String, from url: URL? = VoiceResources.url("live_resume", "json", in: "helper")) throws -> String {
        guard let url, let data = try? Data(contentsOf: url),
              let resume = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let tag = resume["resultTag"] as? String, let preamble = resume["result"] as? String else {
            throw ACPClient.Failure(message: "The wording for resumed calls (live_resume.json) is missing from Bento.")
        }
        return preamble + "\n<" + tag + ">\n" + fenced(GeminiLiveProtocol.excerpt(reply), tag: tag) + "\n</" + tag + ">"
    }

    /// `text` unable to close a `tag` fence, however the tag is cased, spaced or split.
    static func fenced(_ text: String, tag: String) -> String {
        var text = text
        let close = #"</\s*"# + NSRegularExpression.escapedPattern(for: tag) + #"\s*>"#
        while text.range(of: close, options: [.regularExpression, .caseInsensitive]) != nil {
            text = text.replacingOccurrences(of: close, with: "", options: [.regularExpression, .caseInsensitive])
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

extension LiveVoiceSession {
    var diagnosticsLog: AzureLiveDiagnostics.Log { provider == .gemini ? .gemini : .azure }
    var requestSource: String { provider.requestSource }
}

extension SettingsStore.AssistantLiveProvider {
    /// How Hermes is told where a spoken request came from; GPT-Live's wording predates Gemini.
    var requestSource: String { self == .gemini ? "Gemini Live" : "Azure" }
}

extension AzureLiveController: LiveVoiceSession {
    var provider: SettingsStore.AssistantLiveProvider { .gpt }
}

extension GeminiLiveController: LiveVoiceSession {
    var provider: SettingsStore.AssistantLiveProvider { .gemini }
}
