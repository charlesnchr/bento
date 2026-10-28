import AppKit
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

// MARK: - Dictate to Assistant

private let dictateKey = Shortcut(AssistantModule.dictateShortcut)!

@Suite struct DictateToAssistantShortcutTests {
    private var action: BentoAction? { AssistantModule().actions.first { $0.id == AssistantModule.dictateID } }

    @Test func isAnAssistantActionWithItsOwnHoldOrTapShortcut() throws {
        let action = try #require(action)
        #expect(action.title == "Dictate to Assistant")
        #expect(action.group == "Assistant")
        #expect(!action.hiddenFromMenu)
        #expect(action.bindingWriter == nil, "rebindable through the shortcut overrides like the others")
        #expect(action.defaultShortcut == dictateKey)
        #expect(action.hold != nil, "the key's press and release drive hold-or-tap; the menu toggles")
        #expect(dictateKey.displayString == "⌃⌥F18")
        #expect(dictateKey.isSafeGlobalHotkey)
    }

    @Test func liveCallsKeepTheirKeys() {
        let actions = AssistantModule().actions
        #expect(actions.first { $0.id == "assistant.toggle" }?.defaultShortcut == Shortcut("shift+opt+f18"))
        // ⌥F18 is the call key on the voice tap, not a registered shortcut.
        #expect(actions.first { $0.id == "assistant.voice-call" }?.defaultShortcut == nil)
        #expect(!actions.compactMap(\.defaultShortcut).contains(Shortcut("opt+f18")!))
    }

    /// Every shortcut literal in Sources (module defaults, import tables,
    /// window-local keys): only the declaration may be ⌃⌥F18. Literals with an
    /// interpolated key ("ctrl+opt+cmd+\(key)") never take an F-key.
    @Test func defaultCollidesWithNoOtherShortcut() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let sources = root.appendingPathComponent("Sources")
        let files = try #require(FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil))
            .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
        #expect(files.count > 50)
        let literal = try NSRegularExpression(pattern: #""((?:(?:ctrl|control|ctl|⌃|opt|option|alt|⌥|cmd|command|⌘|super|win|shift|⇧|fn|function|hyper|meh)\+)+[^"\s]+)""#,
                                              options: .caseInsensitive)
        var seen = 0
        var uses: [String] = []
        for file in files {
            let text = try String(contentsOf: file, encoding: .utf8)
            for m in literal.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                let s = String(text[Range(m.range(at: 1), in: text)!])
                guard !s.contains("\\("), let sc = Shortcut(s) else { continue }
                seen += 1
                if sc == dictateKey { uses.append("\(file.lastPathComponent): \(s)") }
            }
        }
        #expect(seen > 40)
        #expect(uses == ["VoiceModules.swift: \(AssistantModule.dictateShortcut)"], "⌃⌥F18 is also used by: \(uses)")
    }

    @Test func defaultIsNotAMacOSShortcut() {
        #expect(!SystemShortcuts.isReserved(dictateKey))
    }
}
