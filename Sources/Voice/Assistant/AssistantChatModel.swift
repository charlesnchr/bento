import AppKit
import AVFoundation
import SwiftUI

struct AssistantHistoryItem: Identifiable {
    let id: String
    let title: String
    let date: String
    var updated: Date? { AssistantChatModel.parseDate(date) }
}

struct AssistantCommand: Identifiable, Equatable {
    let name: String
    let description: String
    var hint: String?
    var local = false
    var id: String { name }
}

struct AssistantQueued: Identifiable {
    var id = UUID()
    var text: String
    var attachments: [AssistantAttachment]
}

struct AssistantUsage: Equatable {
    let used: Int
    let size: Int
    var fraction: Double { size > 0 ? min(1, Double(used) / Double(size)) : 0 }
}

enum AssistantContextSource: String, CaseIterable {
    case selection, window, screen, clipboard, file
    var title: String {
        switch self {
        case .selection: return "Selected text"
        case .window: return "Window screenshot"
        case .screen: return "Screen screenshot"
        case .clipboard: return "Clipboard"
        case .file: return "Files..."
        }
    }
    var symbol: String {
        switch self {
        case .selection: return "text.cursor"
        case .window: return "macwindow"
        case .screen: return "display"
        case .clipboard: return "doc.on.clipboard"
        case .file: return "paperclip"
        }
    }
    var detail: String {
        switch self {
        case .selection: return "Text selected in the app you came from"
        case .window: return "That app's front window"
        case .screen: return "The display showing that window"
        case .clipboard: return "Current clipboard text or image"
        case .file: return "Choose files or images"
        }
    }
}

struct AssistantSuggestion: Identifiable {
    enum Kind { case command(AssistantCommand), context(AssistantContextSource) }
    let kind: Kind
    var id: String {
        switch kind { case .command(let command): return "/" + command.name; case .context(let source): return "@" + source.rawValue }
    }
}

struct AssistantPaletteItem: Identifiable {
    let id: String
    let title: String
    var detail = ""
    let symbol: String
    var keys = ""
    let run: () -> Void
}

@MainActor
protocol AssistantActions: AnyObject {
    func send(_ text: String, attachments: [AssistantAttachment])
    func steer(_ text: String)
    func stopTurn()
    func newChat()
    func refreshHistory()
    func restore(_ id: String)
    /// A voice call when calls are on, else a dictated request (⌥F18, /voice).
    func liveVoice()
    /// Starts or ends a live call.
    func call()
    /// Brings a call in standby back to Gemini before Hermes finishes.
    func wakeLive()
    /// Records a request with the normal dictation path and sends it to Hermes.
    func dictate()
    func hide()
    func regenerate()
    func edit(_ id: UUID, text: String)
    func branch(_ id: UUID)
    func delete(_ id: String)
    func attach(_ source: AssistantContextSource)
    func attach(_ attachments: [AssistantAttachment])
    func settings(effort: String?, model: String?)
    func export()
    /// Bento's own windows and settings: "settings", "history", "dictionary", "meetings".
    func openBento(_ page: String)
}

@MainActor
final class AssistantChatModel: ObservableObject {
    @Published var messages: [AssistantMessage] = []
    @Published var status = "Ready"
    @Published var busy = false
    @Published var stopping = false
    @Published var liveVoice = false
    /// The call left Gemini while Hermes works (`GeminiLiveController.standby`).
    @Published var liveStandby = false
    /// The provider of the current or last call, for labels.
    @Published var liveName = "Azure GPT-Live"
    @Published var recording = false
    @Published var historyBusy = false
    @Published var historyError: String?
    @Published var history: [AssistantHistoryItem] = []
    @Published var historyVisible = false
    @Published var sessionID: String?
    @Published var input = UserDefaults.standard.string(forKey: "assistantUnsentDraft") ?? "" {
        didSet { UserDefaults.standard.set(input, forKey: "assistantUnsentDraft") }
    }
    @Published var pinned = Set(UserDefaults.standard.stringArray(forKey: "assistantPinnedSessions") ?? [])
    @Published var archived = Set(UserDefaults.standard.stringArray(forKey: "assistantArchivedSessions") ?? [])
    @Published var aliases = UserDefaults.standard.dictionary(forKey: "assistantSessionNames") as? [String: String] ?? [:]
    @Published var showArchived = false
    @Published var unread = Set<String>()
    @Published var titles: [String: String] = [:]
    @Published var usage: [String: AssistantUsage] = [:]
    @Published var commands: [AssistantCommand] = []
    @Published var plan: [AssistantPlanEntry] = []
    @Published var planExpanded = false
    @Published var queue: [AssistantQueued] = []
    @Published var attachments: [AssistantAttachment] = []
    @Published var selection = 0
    @Published var dismissedSuggestions: String?
    @Published var textScale = UserDefaults.standard.object(forKey: "assistantTextScale") as? Double ?? 1 {
        didSet { UserDefaults.standard.set(textScale, forKey: "assistantTextScale") }
    }
    @Published var verboseTools = false
    @Published var findVisible = false
    @Published var findQuery = "" { didSet { findIndex = 0 } }
    @Published var findIndex = 0
    @Published var findFocus = UUID()
    @Published var paletteVisible = false
    @Published var paletteQuery = "" { didSet { paletteSelection = 0 } }
    @Published var paletteSelection = 0
    @Published var shortcutsVisible = false
    @Published var editingID: UUID?
    @Published var editText = ""
    @Published var atBottom = true
    @Published var effort: String?
    @Published var efforts: [String] = []
    @Published var model: String?
    @Published var models: [String] = []
    @Published var focusToken = UUID()
    @Published var speakingID: UUID?
    weak var actions: AssistantActions?
    private var drafts: [String: String] = [:]
    private var promptHistory = UserDefaults.standard.stringArray(forKey: "assistantPromptHistory") ?? []
    private var historyCursor: Int?
    private var historyDraft = ""
    private let speech = AssistantSpeech()

    var idle: Bool { !busy && !historyBusy && !recording }
    /// Edits rewind Hermes history, which voice-call transcripts don't map onto.
    var editable: Bool { idle && !liveVoice && sessionID != nil && !messages.contains { $0.speaker != nil } }
    /// Regenerate and Retry also cover failures before Hermes created a session.
    var canRetry: Bool { idle && !liveVoice && !messages.contains { $0.speaker != nil } }
    var currentTitle: String {
        guard let id = sessionID else { return messages.isEmpty ? "New conversation" : "Conversation" }
        return aliases[id] ?? titles[id] ?? history.first { $0.id == id }?.title ?? "Conversation"
    }
    var currentUsage: AssistantUsage? { sessionID.flatMap { usage[$0] } }
    var findMatches: [UUID] { findVisible ? AssistantTranscript.matches(findQuery, in: messages) : [] }

    func pin(_ id: String) {
        if pinned.contains(id) { pinned.remove(id) } else { pinned.insert(id) }
        UserDefaults.standard.set(Array(pinned), forKey: "assistantPinnedSessions")
    }
    func archive(_ id: String) {
        if archived.contains(id) { archived.remove(id) } else { archived.insert(id) }
        UserDefaults.standard.set(Array(archived), forKey: "assistantArchivedSessions")
    }
    func title(_ item: AssistantHistoryItem) -> String { aliases[item.id] ?? titles[item.id] ?? item.title }
    func rename(_ id: String, _ name: String) {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { aliases.removeValue(forKey: id) } else { aliases[id] = String(name.prefix(120)) }
        UserDefaults.standard.set(aliases, forKey: "assistantSessionNames")
    }
    func forget(_ id: String) {
        history.removeAll { $0.id == id }
        if pinned.contains(id) { pin(id) }
        if archived.contains(id) { archive(id) }
        rename(id, "")
    }
    func select(_ id: String?, keepDraft: Bool = false) {
        if let id { unread.remove(id) }
        guard sessionID != id else { return }
        if !keepDraft { drafts[sessionID ?? "new"] = input }
        sessionID = id
        if !keepDraft { input = drafts[id ?? "new"] ?? "" }
        plan = []
        editingID = nil
    }
    func focus() { focusToken = UUID() }

    // MARK: Sessions

    var orderedSessions: [AssistantHistoryItem] {
        history.filter { showArchived || !archived.contains($0.id) }.sorted { a, b in
            let ap = pinned.contains(a.id), bp = pinned.contains(b.id)
            if ap != bp { return ap }
            return (a.updated ?? .distantPast) > (b.updated ?? .distantPast)
        }
    }

    func sessionGroups(_ search: String) -> [(title: String, items: [AssistantHistoryItem])] {
        let items = orderedSessions.filter { search.isEmpty || title($0).localizedCaseInsensitiveContains(search) }
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        let names = ["Pinned", "Today", "Yesterday", "Previous 7 Days", "Previous 30 Days", "Older"]
        var buckets: [String: [AssistantHistoryItem]] = [:]
        for item in items {
            let name: String
            if pinned.contains(item.id) { name = "Pinned" }
            else if let date = item.updated {
                let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: today).day ?? 0
                name = days <= 0 ? "Today" : days == 1 ? "Yesterday" : days < 7 ? "Previous 7 Days" : days < 30 ? "Previous 30 Days" : "Older"
            } else { name = "Older" }
            buckets[name, default: []].append(item)
        }
        return names.compactMap { name in buckets[name].map { (name, $0) } }
    }

    private func cycle(_ delta: Int) {
        let sessions = orderedSessions
        guard !sessions.isEmpty else { actions?.refreshHistory(); return }
        let index = sessions.firstIndex { $0.id == sessionID } ?? (delta > 0 ? -1 : 0)
        actions?.restore(sessions[(index + delta + sessions.count) % sessions.count].id)
    }

    nonisolated static func parseDate(_ value: String) -> Date? {
        if let seconds = Double(value) { return Date(timeIntervalSince1970: seconds) }
        let plain = value.replacingOccurrences(of: #"\.\d+"#, with: "", options: .regularExpression)
        return ISO8601DateFormatter().date(from: plain.hasSuffix("Z") || plain.contains("+") ? plain : plain + "Z")
    }

    // MARK: Composer

    var allCommands: [AssistantCommand] {
        var local = [
            AssistantCommand(name: "new", description: "Start a new conversation", local: true),
            AssistantCommand(name: "copy", description: "Copy the last reply", local: true),
            AssistantCommand(name: "export", description: "Save this conversation as Markdown", local: true),
            AssistantCommand(name: "find", description: "Find in this conversation", hint: "text", local: true),
            AssistantCommand(name: "history", description: "Show conversations", local: true),
            AssistantCommand(name: "voice", description: "Start or end a voice call", local: true),
            AssistantCommand(name: "shortcuts", description: "Show keyboard shortcuts", local: true),
        ]
        if !efforts.isEmpty {
            local.append(AssistantCommand(name: "effort", description: "Set reasoning effort", hint: efforts.joined(separator: ", "), local: true))
        }
        // Bento's /new replaces Hermes /reset, which clears the saved conversation; the queue is client-side.
        let names = Set(local.map(\.name))
        return local + commands.filter { !names.contains($0.name) && !["reset", "queue"].contains($0.name) }
    }

    private var mentionToken: (index: String.Index, token: String)? {
        guard let at = input.lastIndex(of: "@") else { return nil }
        let token = input[input.index(after: at)...]
        guard !token.contains(where: \.isWhitespace), at == input.startIndex || input[input.index(before: at)].isWhitespace else { return nil }
        return (at, token.lowercased())
    }

    var suggestions: [AssistantSuggestion] {
        guard dismissedSuggestions != input, editingID == nil, !liveVoice else { return [] }
        if input.hasPrefix("/"), !input.contains(where: \.isWhitespace) {
            let query = input.dropFirst().lowercased()
            return allCommands.filter { query.isEmpty || $0.name.lowercased().contains(query) }
                .sorted { ($0.name.lowercased().hasPrefix(query) ? 0 : 1) < ($1.name.lowercased().hasPrefix(query) ? 0 : 1) }
                .map { AssistantSuggestion(kind: .command($0)) }
        }
        if let (_, token) = mentionToken {
            return AssistantContextSource.allCases
                .filter { token.isEmpty || $0.rawValue.hasPrefix(token) || $0.title.lowercased().contains(token) }
                .map { AssistantSuggestion(kind: .context($0)) }
        }
        return []
    }

    enum ComposerKey { case up, down, tab, enter, steer }

    /// Keys the editor offers before handling them itself; true when consumed.
    func composerKey(_ key: ComposerKey, firstLine: Bool, lastLine: Bool) -> Bool {
        let items = suggestions
        if !items.isEmpty, key != .steer {
            let current = items[min(selection, items.count - 1)]
            switch key {
            case .up: selection = (min(selection, items.count - 1) - 1 + items.count) % items.count
            case .down: selection = (min(selection, items.count - 1) + 1) % items.count
            case .tab: accept(current, run: false)
            default: accept(current, run: true)
            }
            return true
        }
        switch key {
        case .enter: submit(); return true
        case .steer: submit(steer: true); return true
        case .tab: return false
        case .up:
            guard firstLine, input.isEmpty || historyCursor != nil, !promptHistory.isEmpty else { return false }
            if historyCursor == nil { historyDraft = input; historyCursor = promptHistory.count }
            if let cursor = historyCursor, cursor > 0 { historyCursor = cursor - 1; input = promptHistory[cursor - 1] }
            return true
        case .down:
            guard lastLine, let cursor = historyCursor else { return false }
            if cursor + 1 < promptHistory.count { historyCursor = cursor + 1; input = promptHistory[cursor + 1] }
            else { historyCursor = nil; input = historyDraft }
            return true
        }
    }

    /// Called for user typing, as opposed to programmatic input changes.
    func edited(_ text: String) {
        input = text
        historyCursor = nil
        selection = 0
        if dismissedSuggestions != nil, dismissedSuggestions != text { dismissedSuggestions = nil }
    }

    func accept(_ suggestion: AssistantSuggestion, run: Bool) {
        switch suggestion.kind {
        case .command(let command):
            if command.hint != nil || !run { input = "/" + command.name + " " }
            else { input = "/" + command.name; submit() }
        case .context(let source):
            if let (index, _) = mentionToken { input = String(input[..<index]) }
            actions?.attach(source)
        }
        selection = 0
        focus()
    }

    func submit(steer: Bool = false) {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let files = attachments
        guard !text.isEmpty || !files.isEmpty, !historyBusy, !liveVoice, !recording else { return }
        remember(text)
        if files.isEmpty, text.hasPrefix("/"), runLocal(text) { input = ""; return }
        input = ""
        attachments = []
        if busy {
            if steer, files.isEmpty, !text.hasPrefix("/") { actions?.steer(text) }
            else { queue.append(AssistantQueued(text: text, attachments: files)) }
            return
        }
        actions?.send(text, attachments: files)
    }

    private func remember(_ text: String) {
        historyCursor = nil
        guard !text.isEmpty, promptHistory.last != text else { return }
        promptHistory = Array((promptHistory + [text]).suffix(200))
        UserDefaults.standard.set(promptHistory, forKey: "assistantPromptHistory")
    }

    private func runLocal(_ text: String) -> Bool {
        let parts = text.dropFirst().split(separator: " ", maxSplits: 1)
        let args = parts.count > 1 ? parts[1].trimmingCharacters(in: .whitespaces) : ""
        switch parts.first?.lowercased() ?? "" {
        case "new", "clear": actions?.newChat()
        case "copy": copyLast()
        case "export": actions?.export()
        case "find": findVisible = true; findQuery = args; findFocus = UUID()
        case "history": perform(.sidebar)
        case "voice": actions?.liveVoice()
        case "shortcuts", "keys": shortcutsVisible = true
        case "effort" where !efforts.isEmpty:
            guard efforts.contains(args.lowercased()) else { status = "Effort must be " + efforts.joined(separator: ", "); return true }
            actions?.settings(effort: args.lowercased(), model: nil)
        default: return false
        }
        return true
    }

    /// Runs a slash command without touching the draft or its attachments.
    func runCommand(_ command: String) {
        guard !historyBusy, !liveVoice, !recording else { return }
        if busy { queue.append(AssistantQueued(text: command, attachments: [])) } else { actions?.send(command, attachments: []) }
    }

    func unqueue(_ item: AssistantQueued) {
        queue.removeAll { $0.id == item.id }
        input = input.isEmpty ? item.text : item.text + "\n" + input
        attachments += item.attachments
        focus()
    }

    func steerNow(_ item: AssistantQueued) {
        guard item.attachments.isEmpty, !item.text.hasPrefix("/") else { return }
        queue.removeAll { $0.id == item.id }
        actions?.steer(item.text)
    }

    // MARK: Actions

    @discardableResult
    func perform(_ action: AssistantAction) -> Bool {
        switch action {
        case .newChat: actions?.newChat()
        case .palette:
            paletteVisible.toggle()
            paletteQuery = ""
            if paletteVisible, history.isEmpty { actions?.refreshHistory() }
            if !paletteVisible { focus() }
        case .find: findVisible = true; findFocus = UUID()
        case .findNext, .findPrevious:
            if !findVisible { findVisible = true; findFocus = UUID(); return true }
            let count = findMatches.count
            guard count > 0 else { return true }
            findIndex = (findIndex + (action == .findNext ? 1 : -1) + count) % count
        case .sidebar:
            historyVisible.toggle()
            if historyVisible { actions?.refreshHistory() }
        case .nextChat: cycle(1)
        case .previousChat: cycle(-1)
        case .chat(let number):
            let sessions = orderedSessions
            if sessions.count >= number { actions?.restore(sessions[number - 1].id) } else if sessions.isEmpty { actions?.refreshHistory() }
        case .focusInput: focus()
        case .copyLast: copyLast()
        case .copyCode:
            if let code = AssistantTranscript.lastCodeBlock(in: messages) { copy(code); status = "Copied code block" }
            else { status = "No code block to copy" }
        case .regenerate: actions?.regenerate()
        case .stop: if busy { actions?.stopTurn() }
        // ⌃T and ⌃O are also text-editing keys; they pass through when there's nothing to toggle.
        case .plan:
            guard !plan.isEmpty else { return false }
            planExpanded.toggle()
        case .steps:
            guard messages.contains(where: { $0.role == "tool" }) else { return false }
            verboseTools.toggle()
        case .export: actions?.export()
        case .zoomIn: textScale = min(1.6, (textScale + 0.1).rounded(toPlaces: 1))
        case .zoomOut: textScale = max(0.8, (textScale - 0.1).rounded(toPlaces: 1))
        case .zoomReset: textScale = 1
        case .shortcuts: shortcutsVisible.toggle()
        case .hide: actions?.hide()
        case .settings: actions?.openBento("settings")
        }
        return true
    }

    /// Esc closes the innermost transient UI first; false means hide the window.
    func escape() -> Bool {
        if shortcutsVisible { shortcutsVisible = false; return true }
        if paletteVisible { paletteVisible = false; focus(); return true }
        if !suggestions.isEmpty { dismissedSuggestions = input; return true }
        if editingID != nil { cancelEdit(); return true }
        if findVisible { findVisible = false; findQuery = ""; focus(); return true }
        return false
    }

    func movePalette(_ delta: Int) {
        let count = paletteItems.count
        guard count > 0 else { return }
        paletteSelection = max(0, min(count - 1, paletteSelection + delta))
    }

    func runPalette() {
        let items = paletteItems
        guard items.indices.contains(paletteSelection) else { return }
        paletteVisible = false
        focus()
        items[paletteSelection].run()
    }

    var paletteItems: [AssistantPaletteItem] {
        var items: [AssistantPaletteItem] = [
            .init(id: "new", title: "New chat", symbol: "square.and.pencil", keys: "⌘N") { [weak self] in self?.perform(.newChat) },
            .init(id: "find", title: "Find in conversation", symbol: "magnifyingglass", keys: "⌘F") { [weak self] in self?.perform(.find) },
            .init(id: "sidebar", title: historyVisible ? "Hide conversations" : "Show conversations", symbol: "sidebar.left", keys: "⌘B") { [weak self] in self?.perform(.sidebar) },
            .init(id: "copy", title: "Copy last reply", symbol: "doc.on.doc", keys: "⌘⇧C") { [weak self] in self?.perform(.copyLast) },
            .init(id: "code", title: "Copy last code block", symbol: "chevron.left.forwardslash.chevron.right", keys: "⌘⇧;") { [weak self] in self?.perform(.copyCode) },
            .init(id: "regenerate", title: "Regenerate last reply", symbol: "arrow.clockwise", keys: "⌘R") { [weak self] in self?.perform(.regenerate) },
            .init(id: "export", title: "Export as Markdown...", symbol: "square.and.arrow.down", keys: "⌘S") { [weak self] in self?.perform(.export) },
            .init(id: "markdown", title: "Copy conversation as Markdown", symbol: "doc.richtext") { [weak self] in
                guard let self else { return }
                copy(AssistantTranscript.markdown(messages, title: currentTitle)); status = "Copied conversation"
            },
            .init(id: "compress", title: "Compress conversation context", detail: "/compress", symbol: "rectangle.compress.vertical") { [weak self] in
                self?.runCommand("/compress")
            },
            .init(id: "context", title: "Show context usage", detail: "/context", symbol: "chart.pie") { [weak self] in
                self?.runCommand("/context")
            },
            .init(id: "archived", title: showArchived ? "Hide archived conversations" : "Show archived conversations", symbol: "archivebox") { [weak self] in
                self?.showArchived.toggle()
            },
            .init(id: "bigger", title: "Larger text", symbol: "textformat.size.larger", keys: "⌘+") { [weak self] in self?.perform(.zoomIn) },
            .init(id: "smaller", title: "Smaller text", symbol: "textformat.size.smaller", keys: "⌘−") { [weak self] in self?.perform(.zoomOut) },
            .init(id: "shortcuts", title: "Keyboard shortcuts", symbol: "keyboard", keys: "⌘/") { [weak self] in self?.perform(.shortcuts) },
            .init(id: "settings", title: "Assistant settings", symbol: "gearshape", keys: "⌘,") { [weak self] in self?.actions?.openBento("settings") },
            .init(id: "history", title: "Dictation history", symbol: "clock.arrow.circlepath") { [weak self] in self?.actions?.openBento("history") },
            .init(id: "dictionary", title: "Dictionary", symbol: "character.book.closed") { [weak self] in self?.actions?.openBento("dictionary") },
            .init(id: "meetings", title: "Meetings", symbol: "person.2.wave.2") { [weak self] in self?.actions?.openBento("meetings") },
        ]
        for effort in efforts where effort != self.effort {
            items.append(.init(id: "effort-" + effort, title: "Reasoning effort: " + effort.capitalized, symbol: "brain") { [weak self] in
                self?.actions?.settings(effort: effort, model: nil)
            })
        }
        for model in models where model != self.model {
            items.append(.init(id: "model-" + model, title: "Model: " + model, symbol: "cpu") { [weak self] in
                self?.actions?.settings(effort: nil, model: model)
            })
        }
        for (index, item) in orderedSessions.enumerated() {
            items.append(.init(id: "chat-" + item.id, title: title(item), detail: String(item.date.prefix(10)),
                               symbol: pinned.contains(item.id) ? "pin" : "bubble.left", keys: index < 9 ? "⌘\(index + 1)" : "") { [weak self] in
                self?.actions?.restore(item.id)
            })
        }
        let words = paletteQuery.lowercased().split(separator: " ")
        return items.filter { item in words.allSatisfy { (item.title + " " + item.detail).lowercased().contains($0) } }
    }

    // MARK: Messages

    func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    func copyLast() {
        if let reply = messages.last(where: { $0.role == "assistant" && !$0.text.isEmpty }) { copy(reply.text); status = "Copied last reply" }
        else { status = "No reply to copy" }
    }

    func beginEdit(_ message: AssistantMessage) {
        guard editable, message.isTurn else { return }
        editingID = message.id
        editText = message.text
    }

    func commitEdit() {
        let text = editText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let id = editingID, !text.isEmpty else { return }
        editingID = nil
        actions?.edit(id, text: text)
    }

    func cancelEdit() {
        editingID = nil
        focus()
    }

    func speak(_ message: AssistantMessage) {
        if speakingID == message.id { speech.stop(); speakingID = nil; return }
        speakingID = message.id
        speech.speak(AssistantSpeech.plain(message.text)) { [weak self] in
            if self?.speakingID == message.id { self?.speakingID = nil }
        }
    }
}

private extension Double {
    func rounded(toPlaces places: Int) -> Double {
        let scale = pow(10, Double(places))
        return (self * scale).rounded() / scale
    }
}

@MainActor
final class AssistantSpeech: NSObject, AVSpeechSynthesizerDelegate {
    /// Created on first Read Aloud: the synthesizer starts a speech thread and
    /// audio session, which an idle Bento doesn't need.
    private var synthesizer: AVSpeechSynthesizer?
    private var done: (() -> Void)?

    func speak(_ text: String, done: @escaping () -> Void) {
        stop()
        self.done = done
        let synthesizer = self.synthesizer ?? AVSpeechSynthesizer()
        synthesizer.delegate = self
        self.synthesizer = synthesizer
        synthesizer.speak(AVSpeechUtterance(string: text))
    }

    func stop() {
        let finished = done
        done = nil
        if synthesizer?.isSpeaking == true { synthesizer?.stopSpeaking(at: .immediate) }
        finished?()
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in
            let finished = self.done
            self.done = nil
            finished?()
        }
    }

    /// Readable text for speech: no code, images, link targets or Markdown punctuation.
    static func plain(_ markdown: String) -> String {
        var text = markdown
        for (pattern, template) in [(#"(?s)```.*?```"#, " (code omitted) "), (#"!\[[^\]]*\]\([^)]*\)"#, ""),
                                    (#"\[([^\]]*)\]\([^)]*\)"#, "$1"), (#"[*_`#>|]+"#, ""), (#"\$\$?[^$]+\$\$?"#, " (equation) ")] {
            text = text.replacingOccurrences(of: pattern, with: template, options: .regularExpression)
        }
        return String(text.prefix(20000))
    }
}
