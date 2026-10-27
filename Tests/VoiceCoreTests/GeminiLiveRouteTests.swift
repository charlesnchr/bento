import Foundation
import Testing
@testable import VoiceCore

/// Gemini Live calls use dictation's Google connection: the Gemini API with a
/// key when there is no runtime file, Vertex through the direct helper when there is.
@Suite struct GeminiLiveRouteTests {
    typealias Route = SettingsStore.GeminiLiveRoute
    private let directConfig: VertexRuntimeConfig = {
        var config = try! VertexRuntimeConfig(bifrostBaseURL: URL(string: "http://127.0.0.1:8767")!,
                                              bifrostKey: "k", project: "p", location: "global", model: "m")
        config.transport = "direct"
        return config
    }()
    private let gateway = VertexRuntimeConfig.State.configured(
        try! VertexRuntimeConfig(bifrostBaseURL: URL(string: "http://127.0.0.1:8080")!,
                                 bifrostKey: "k", project: "p", location: "global", model: "m"))

    private func route(_ runtime: VertexRuntimeConfig.State, key: Bool, override: Bool = false) -> Route {
        SettingsStore.geminiLiveRoute(runtime: runtime, hasAPIKey: { key }, hasEndpointOverride: override)
    }

    @Test func theGeminiAPIDictationBackendCallsTheGeminiAPI() {
        #expect(route(.notConfigured, key: true) == .geminiAPI)
        #expect(route(.notConfigured, key: true, override: true) == .geminiAPI, "The key carries the call; the override is for uploads")
    }

    @Test func theDirectHelperCallsVertexWithoutAKey() {
        var asked = false
        #expect(SettingsStore.geminiLiveRoute(runtime: .configured(directConfig), hasAPIKey: { asked = true; return true },
                                              hasEndpointOverride: false) == .vertexHelper(directConfig))
        #expect(!asked, "Vertex never falls back to the Gemini API key")
        #expect(directConfig.conversationEndpoint.absoluteString == "ws://127.0.0.1:8767/conversation")
    }

    @Test func withoutAKeyTheReasonSaysWhatToAdd() {
        guard case .unavailable(let reason) = route(.notConfigured, key: false) else { Issue.record("Expected unavailable"); return }
        #expect(reason.contains("Gemini API key"))
        #expect(!reason.contains("Vertex"), "The Gemini API path never needs the Vertex helper")
        guard case .unavailable(let overrideReason) = route(.notConfigured, key: false, override: true) else {
            Issue.record("Expected unavailable"); return
        }
        #expect(overrideReason.contains("endpoint override"))
    }

    /// Vertex through a gateway stays on Vertex: the gateway has no call route, and
    /// the Gemini API key (if any) doesn't quietly take over.
    @Test func aGatewayOrBrokenRuntimeNeverFallsBackToTheGeminiAPI() {
        guard case .unavailable(let reason) = route(gateway, key: true) else { Issue.record("Expected unavailable"); return }
        #expect(reason.contains("Vertex helper"))
        guard case .unavailable(let invalid) = route(.invalid("runtime config is malformed"), key: true) else {
            Issue.record("Expected unavailable"); return
        }
        #expect(invalid.contains("Vertex configuration is invalid"))
    }

    @Test func theGeminiAPIModelIsTheStableLiveModel() {
        #expect(Route.geminiAPIModel == "gemini-3.8-live")
    }
}

extension SharedStateTests {
    /// The same rules through the runtime file, Keychain and saved override.
    @Suite struct GeminiLiveRouteSettingsTests {
        private let state = SharedStateGuard()

        @Test func followsTheRuntimeFileAndKey() {
            let settings = SettingsStore()
            #expect(settings.geminiLiveRoute == .geminiAPI)
            state.useAPIKey(false)
            settings.setEndpointOverride("http://127.0.0.1:4000")
            guard case .unavailable(let reason) = settings.geminiLiveRoute else { Issue.record("Expected unavailable"); return }
            #expect(reason.contains("endpoint override"))
            state.useRuntimeConfig(RuntimeConfigFixture.direct)
            guard case .vertexHelper(let config) = settings.geminiLiveRoute else { Issue.record("Expected Vertex"); return }
            #expect(config.isDirect)
        }

        /// GPT-Live stays a separate choice; the route only says where Gemini would go.
        @Test func theProviderChoiceIsIndependentOfTheRoute() {
            let settings = SettingsStore()
            settings.setAssistantLiveProvider(.gpt)
            state.useRuntimeConfig(RuntimeConfigFixture.direct)
            #expect(settings.assistantLiveProvider == .gpt)
            state.useRuntimeConfig(nil)
            #expect(settings.assistantLiveProvider == .gpt)
            settings.setAssistantLiveProvider(.gemini)
            #expect(settings.assistantLiveProvider == .gemini)
            #expect(settings.geminiLiveRoute == .geminiAPI)
        }
    }
}
