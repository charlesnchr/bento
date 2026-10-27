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

/// How a resumed call is told about the conversation it continues: the earlier call's
/// transcript, as reference only. The wording lives in `helper/live_resume.json`, which the
/// helpers read too (`azure_live.resume_note`), so every route says the same; this is the
/// Gemini API path's copy of that code.
enum LiveResumeNote {
    /// What the call's instructions end with: empty without a recap, nil when the file is
    /// missing or the recap is longer than it allows.
    static func note(_ recap: String, from url: URL? = VoiceResources.url("live_resume", "json", in: "helper")) -> String? {
        guard !recap.isEmpty else { return "" }
        guard let url, let data = try? Data(contentsOf: url),
              let resume = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let limit = resume["recapLimit"] as? Int, let tag = resume["tag"] as? String,
              let instruction = resume["instruction"] as? String, recap.unicodeScalars.count <= limit else { return nil }
        // The transcript can't close its own fence, however the tag is cased or split.
        var recap = recap
        while recap.range(of: "</" + tag + ">", options: .caseInsensitive) != nil {
            recap = recap.replacingOccurrences(of: "</" + tag + ">", with: "", options: .caseInsensitive)
        }
        recap = recap.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !recap.isEmpty else { return "" }
        return " " + instruction + "\n<" + tag + ">\n" + recap + "\n</" + tag + ">"
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
