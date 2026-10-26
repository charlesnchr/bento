import BentoCore
import Testing
@testable import Voice

@Suite struct VoiceModulesTests {
    @Test func allReturnsTheThreeVoiceModules() {
        let modules = VoiceModules.all()
        #expect(modules.map(\.id) == ["dictation", "meetings", "assistant"])
        #expect(modules.allSatisfy { !$0.title.isEmpty && !$0.symbol.isEmpty })
    }
}
