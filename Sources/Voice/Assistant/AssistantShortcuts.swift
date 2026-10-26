import AppKit

enum AssistantAction: Hashable {
    case newChat, palette, find, findNext, findPrevious, sidebar, nextChat, previousChat, chat(Int), focusInput
    case copyLast, copyCode, regenerate, stop, plan, steps, export, zoomIn, zoomOut, zoomReset, shortcuts, hide, settings
}

struct AssistantShortcut: Identifiable {
    let action: AssistantAction?
    let title: String
    let keys: String
    let group: String
    fileprivate var matchers: [(NSEvent) -> Bool] = []
    var id: String { group + title }
}

/// One table drives both window key handling and the shortcut sheet. Rows without an action are
/// handled by the composer and listed for reference.
enum AssistantShortcuts {
    static let groups = ["Composer", "Conversation", "Navigation", "Window"]

    static let all: [AssistantShortcut] = [
        row(nil, "Send", "↵", "Composer"),
        row(nil, "New line", "⇧↵", "Composer"),
        row(nil, "Queue while Hermes works", "↵", "Composer"),
        row(nil, "Send now, steering the running turn", "⌘↵", "Composer"),
        row(nil, "Previous / next prompt", "↑ ↓", "Composer"),
        row(nil, "Commands", "/", "Composer"),
        row(nil, "Attach context", "@", "Composer"),
        row(.stop, "Stop", "⌘.", "Composer", key(".", .command)),
        row(.focusInput, "Focus input", "⌘L", "Composer", key("l", .command)),
        row(.copyLast, "Copy last reply", "⌘⇧C", "Conversation", key("c", [.command, .shift])),
        row(.copyCode, "Copy last code block", "⌘⇧;", "Conversation", key(";", [.command, .shift]), key(":", [.command, .shift])),
        row(.regenerate, "Regenerate last reply", "⌘R", "Conversation", key("r", .command)),
        row(.find, "Find in conversation", "⌘F", "Conversation", key("f", .command)),
        row(.findNext, "Next match", "⌘G", "Conversation", key("g", .command)),
        row(.findPrevious, "Previous match", "⌘⇧G", "Conversation", key("g", [.command, .shift])),
        row(.plan, "Show or hide plan", "⌃T", "Conversation", key("t", .control)),
        row(.steps, "Expand all tool steps", "⌃O", "Conversation", key("o", .control)),
        row(.export, "Export as Markdown", "⌘S", "Conversation", key("s", .command)),
        row(.newChat, "New chat", "⌘N  ⌘⇧O", "Navigation", key("n", .command), key("o", [.command, .shift])),
        row(.palette, "Command palette and chat search", "⌘K", "Navigation", key("k", .command), key("p", [.command, .shift])),
        row(.sidebar, "Show or hide conversations", "⌘B", "Navigation", key("b", .command)),
        row(.nextChat, "Next conversation", "⌃Tab", "Navigation", code(48, .control), key("]", [.command, .shift]), key("}", [.command, .shift])),
        row(.previousChat, "Previous conversation", "⌃⇧Tab", "Navigation", code(48, [.control, .shift]), key("[", [.command, .shift]), key("{", [.command, .shift])),
        row(nil, "Open conversation 1–9", "⌘1 … ⌘9", "Navigation"),
        row(.zoomIn, "Larger text", "⌘+", "Window", key("=", .command), key("+", .command), key("+", [.command, .shift])),
        row(.zoomOut, "Smaller text", "⌘−", "Window", key("-", .command)),
        row(.zoomReset, "Actual size", "⌘0", "Window", key("0", .command)),
        row(.settings, "Settings", "⌘,", "Window", key(",", .command)),
        row(.shortcuts, "Keyboard shortcuts", "⌘/", "Window", key("/", .command)),
        row(.hide, "Hide assistant", "Esc  ⌘W", "Window", key("w", .command)),
    ]

    static func action(for event: NSEvent) -> AssistantAction? {
        if flags(event) == .command, let digit = event.charactersIgnoringModifiers.flatMap(Int.init), (1...9).contains(digit) {
            return .chat(digit)
        }
        return all.first { $0.matchers.contains { $0(event) } }?.action
    }

    static func flags(_ event: NSEvent) -> NSEvent.ModifierFlags {
        event.modifierFlags.intersection([.command, .shift, .option, .control])
    }

    private static func row(_ action: AssistantAction?, _ title: String, _ keys: String, _ group: String,
                            _ matchers: ((NSEvent) -> Bool)...) -> AssistantShortcut {
        AssistantShortcut(action: action, title: title, keys: keys, group: group, matchers: matchers)
    }

    private static func key(_ character: String, _ modifiers: NSEvent.ModifierFlags) -> (NSEvent) -> Bool {
        { flags($0) == modifiers && $0.charactersIgnoringModifiers?.lowercased() == character }
    }

    private static func code(_ keyCode: UInt16, _ modifiers: NSEvent.ModifierFlags) -> (NSEvent) -> Bool {
        { flags($0) == modifiers && $0.keyCode == keyCode }
    }
}
