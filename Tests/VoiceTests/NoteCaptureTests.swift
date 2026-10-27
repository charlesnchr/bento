import AppKit
import Testing
import VoiceCore
@testable import Voice

@MainActor
@Suite(.serialized) struct NoteCaptureTests {
    @Test func routerCapturesWithoutUsingTheComposerOrClipboard() async {
        let pb = NSPasteboard.withUniqueName()
        defer { pb.releaseGlobally() }
        pb.setString("untouched", forType: .string)
        var captured: String?
        let router = VoiceOutputRouter(composer: ComposerWindow(), assistant: AssistantController(),
                                       noteCapture: { captured = $0; return "Thoughts" },
                                       pasteboard: pb, secureInputActive: { false })
        var context = DictationContext()
        context.captureToNote = true
        context.useComposer = true
        let outcome = await router.insert("An idea", context: context)
        #expect(outcome == .inserted)
        #expect(captured == "An idea")
        #expect(pb.string(forType: .string) == "untouched")
    }

    @Test func unavailableNotesUseAnIsolatedClipboard() async {
        let pb = NSPasteboard.withUniqueName()
        defer { pb.releaseGlobally() }
        let router = VoiceOutputRouter(composer: ComposerWindow(), assistant: AssistantController(),
                                       noteCapture: { _ in nil }, pasteboard: pb, secureInputActive: { false })
        var context = DictationContext()
        context.captureToNote = true
        let outcome = await router.insert("Keep this", context: context)
        #expect(outcome == .fellBackToClipboard)
        #expect(pb.string(forType: .string) == "Keep this")
    }

    @Test func secureInputHoldsCaptureWithoutTouchingNotesOrClipboard() async {
        let pb = NSPasteboard.withUniqueName()
        defer { pb.releaseGlobally() }
        pb.setString("untouched", forType: .string)
        var called = false
        let router = VoiceOutputRouter(composer: ComposerWindow(), assistant: AssistantController(),
                                       noteCapture: { _ in called = true; return nil },
                                       pasteboard: pb, secureInputActive: { true })
        var context = DictationContext()
        context.captureToNote = true
        let outcome = await router.insert("Private", context: context)
        #expect(outcome == .blockedSecureField)
        #expect(!called)
        #expect(pb.string(forType: .string) == "untouched")
    }
}
