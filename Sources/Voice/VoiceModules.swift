import AppKit
import BentoCore
import SwiftUI
import VoiceCore

/// Dictation, Meetings and the Assistant: three modules over one engine
/// (`VoiceApp`), created when the first of them starts.
public enum VoiceModules {
    public static func all() -> [BentoModule] { [DictationModule(), MeetingsModule(), AssistantModule()] }

    /// The stored Gemini API key, for pairing the Android app (`PhonePairing`).
    public static func geminiAPIKey() -> String? { APIKeyStore.loadAPIKey() }
}

/// Runs `body` on the main actor; Bento calls modules on the main thread.
private func onMain<T>(_ body: @MainActor () -> T) -> T { MainActor.assumeIsolated(body) }

/// A submenu item titled like the module, holding `menu`.
private func submenuItem(_ module: BentoModule, _ menu: NSMenu) -> NSMenuItem {
    let item = NSMenuItem(title: module.title, action: nil, keyEquivalent: "")
    item.image = NSImage(systemSymbolName: module.symbol, accessibilityDescription: nil)
    item.submenu = menu
    return item
}

/// A menu item for one of the module's actions, with its current shortcut.
private func actionItem(_ id: String) -> NSMenuItem {
    if let action = ActionRegistry.shared.action(id) { return ActionRegistry.shared.menuItem(for: action) }
    let item = NSMenuItem(title: id, action: nil, keyEquivalent: "")
    item.isEnabled = false
    return item
}

// MARK: - Dictation

public final class DictationModule: BentoModule {
    public let id = "dictation"
    public let title = "Dictation"
    /// Off until switched on: it asks for the microphone and takes keys.
    public let enabledByDefault = false
    public let symbol = "mic"

    public init() {}

    /// Appends a transcript to the capture note and returns the note's title, nil when
    /// that isn't possible. Set by the app to Notes' `capture` (called on the main
    /// thread); nil without Notes.
    public static var noteCapture: ((String) -> String?)?

    public var actions: [BentoAction] {
        let group = "Dictation"
        return [
            BentoAction("dictation.hands-free", "Start Hands-Free Dictation", group: group) {
                onMain { VoiceApp.shared.dictation.startHandsFree() }
            },
            BentoAction("dictation.stop", "Stop Dictation", group: group, hiddenFromMenu: true) {
                onMain { _ = VoiceApp.shared.dictation.coordinator.handle(.finalize) }
            },
            BentoAction("dictation.capture-note", "Capture Thought to Note", group: group) {
                onMain { VoiceApp.shared.dictation.toggleCapture() }
            },
            BentoAction("dictation.compose", "Compose…", group: group) {
                onMain { VoiceApp.shared.dictation.openComposer() }
            },
            BentoAction("dictation.paste-last", "Paste Last Transcript", group: group) {
                onMain { VoiceApp.shared.dictation.pasteLastTranscript() }
            },
            BentoAction("dictation.retry-last", "Retry Last Transcription", group: group, shortcut: "meh+r") {
                onMain { VoiceApp.shared.dictation.retryLast() }
            },
            BentoAction("dictation.history", "Dictation History…", group: group) {
                onMain { VoiceApp.shared.openHistory() }
            },
            BentoAction("dictation.dictionary", "Dictionary…", group: group, hiddenFromMenu: true) {
                onMain { VoiceApp.shared.dictation.openDictionary() }
            },
        ]
    }

    public func start() { onMain { VoiceApp.shared.setEnabled(.dictation, true) } }
    public func stop() { onMain { VoiceApp.current?.setEnabled(.dictation, false) } }

    public func makeSettingsView() -> AnyView? {
        onMain { AnyView(DictationSettingsView()) }
    }

    public func menuItems() -> [NSMenuItem] {
        onMain {
            guard let app = VoiceApp.current else { return [] }
            return [submenuItem(self, app.dictationMenu(actionItem))]
        }
    }

    public func diagnostics() -> [String: Any] {
        onMain { VoiceApp.current?.diagnostics() ?? [:] }
    }
}

// MARK: - Meetings

public final class MeetingsModule: BentoModule {
    public let id = "meetings"
    public let title = "Meetings"
    /// Off until switched on: it asks for the microphone and takes keys.
    public let enabledByDefault = false
    public let symbol = "person.2.wave.2"

    public init() {}

    public var actions: [BentoAction] {
        let group = "Meetings"
        return [
            BentoAction("meetings.toggle", "Record or Stop Meeting", group: group, shortcut: "shift+opt+f17") {
                onMain { VoiceApp.shared.meetings?.toggle() }
            },
            BentoAction("meetings.start", "Start Meeting Recording", group: group, hiddenFromMenu: true) {
                onMain { VoiceApp.shared.meetings?.start() }
            },
            BentoAction("meetings.stop", "Stop Meeting Recording", group: group, hiddenFromMenu: true) {
                onMain { VoiceApp.shared.meetings?.stop() }
            },
            BentoAction("meetings.pause", "Pause or Resume Meeting", group: group) {
                onMain { VoiceApp.shared.meetings?.pauseOrResume() }
            },
            BentoAction("meetings.notes", "Meeting Notes", group: group) {
                onMain { VoiceApp.shared.meetings?.openNotes() }
            },
            BentoAction("meetings.show", "Meetings…", group: group) {
                onMain { VoiceApp.shared.openMeetings() }
            },
        ]
    }

    public func start() { onMain { VoiceApp.shared.setEnabled(.meetings, true) } }
    public func stop() { onMain { VoiceApp.current?.setEnabled(.meetings, false) } }

    public func makeSettingsView() -> AnyView? {
        onMain { AnyView(MeetingsSettingsView()) }
    }

    public func menuItems() -> [NSMenuItem] {
        onMain {
            guard let app = VoiceApp.current else { return [] }
            return [submenuItem(self, app.meetingsMenu(actionItem))]
        }
    }
}

// MARK: - Assistant

public final class AssistantModule: BentoModule {
    public let id = "assistant"
    public let title = "Assistant"
    /// Off until switched on: it asks for the microphone and takes keys.
    public let enabledByDefault = false
    public let symbol = "bubble.left.and.bubble.right"

    public init() {}

    static let dictateID = "assistant.dictate"
    /// ⌃⌥F18, beside ⇧⌥F18 (the window) and ⌥F18 (calls, or with calls off
    /// voice editing and requests), which used to dictate requests before
    /// calls took it over.
    static let dictateShortcut = "ctrl+opt+f18"

    public var actions: [BentoAction] {
        let group = "Assistant"
        return [
            BentoAction("assistant.toggle", "Show or Hide Assistant", group: group, shortcut: "shift+opt+f18") {
                onMain { VoiceApp.shared.dictation.toggleAssistant() }
            },
            BentoAction(Self.dictateID, "Dictate to Assistant", group: group, shortcut: Self.dictateShortcut,
                        hold: BentoAction.Hold(down: { onMain { VoiceApp.shared.dictation.assistantDictationKeyDown() } },
                                               up: { onMain { VoiceApp.current?.dictation.assistantDictationKeyUp() } })) {
                onMain { VoiceApp.shared.dictation.toggleAssistantDictation() }
            },
            BentoAction("assistant.open", "Open Assistant", group: group, hiddenFromMenu: true) {
                onMain { VoiceApp.shared.dictation.openAssistant() }
            },
            BentoAction("assistant.voice-call", "Start or End Voice Call", group: group) {
                onMain { VoiceApp.shared.dictation.toggleAssistantCall() }
            },
            BentoAction("assistant.new", "New Conversation", group: group) {
                onMain { VoiceApp.shared.dictation.newAssistantChat() }
            },
        ]
    }

    public func start() {
        // Added after release: users who already put ⌃⌥F18 on something else keep it there.
        ActionRegistry.shared.yieldNewDefault(of: Self.dictateID)
        onMain { VoiceApp.shared.setEnabled(.assistant, true) }
    }
    public func stop() { onMain { VoiceApp.current?.setEnabled(.assistant, false) } }

    public func makeSettingsView() -> AnyView? {
        onMain { AnyView(AssistantSettingsView()) }
    }

    public func menuItems() -> [NSMenuItem] {
        onMain {
            guard let app = VoiceApp.current else { return [] }
            return [submenuItem(self, app.assistantMenu(actionItem))]
        }
    }
}
