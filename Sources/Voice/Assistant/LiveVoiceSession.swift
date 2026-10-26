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
    func start() throws
    func stop()
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
