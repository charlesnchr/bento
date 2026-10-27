import AppKit
import VoiceCore
import SwiftUI

/// The transcript. Equatable so composer typing doesn't re-render Markdown.
private struct AssistantConversation: View, Equatable {
    let model: AssistantChatModel
    let messages: [AssistantMessage]
    let sessionID: String?
    let scale: Double
    let verbose: Bool
    let editingID: UUID?
    let editable: Bool
    let retryable: Bool
    let matches: [UUID]
    let current: UUID?
    let speakingID: UUID?
    let atBottom: Bool
    let accent: Color

    static func == (a: Self, b: Self) -> Bool {
        a.messages == b.messages && a.sessionID == b.sessionID && a.scale == b.scale && a.verbose == b.verbose &&
            a.editingID == b.editingID && a.editable == b.editable && a.retryable == b.retryable && a.matches == b.matches &&
            a.current == b.current && a.speakingID == b.speakingID && a.atBottom == b.atBottom
    }

    private enum Item: Identifiable {
        case message(AssistantMessage), steps([AssistantMessage])
        var id: UUID {
            switch self { case .message(let message): return message.id; case .steps(let steps): return steps[0].id }
        }
    }

    private var items: [Item] {
        var items: [Item] = []
        for message in messages {
            if message.role == "tool", case .steps(let steps) = items.last { items[items.count - 1] = .steps(steps + [message]) }
            else { items.append(message.role == "tool" ? .steps([message]) : .message(message)) }
        }
        return items
    }

    /// Only the reply to the latest Hermes turn can be regenerated.
    private var regenerateID: UUID? {
        guard retryable, let last = messages.lastIndex(where: \.isTurn) else { return nil }
        return messages[(last + 1)...].last { $0.role == "assistant" && $0.speaker == nil }?.id
    }

    var body: some View {
        let regenerate = regenerateID
        let matched = Set(matches)
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if messages.isEmpty { empty }
                    ForEach(items) { item in
                        switch item {
                        case .message(let message):
                            ChatMessageView(model: model, message: message, scale: scale, editing: editingID == message.id,
                                            editable: editable, canRegenerate: message.id == regenerate, speaking: speakingID == message.id,
                                            highlight: current == message.id ? .current : matched.contains(message.id) ? .match : .none)
                                .equatable().padding(.vertical, 7).id(message.id)
                        case .steps(let steps):
                            if steps.count == 1 { ChatToolView(message: steps[0], verbose: verbose).id(steps[0].id) }
                            else { ChatStepsView(steps: steps, verbose: verbose).id(steps[0].id) }
                        }
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }.padding(.horizontal, 10).padding(.vertical, 18)
                    .background(AssistantScrollFollower { [weak model] following in
                        if model?.atBottom != following { model?.atBottom = following }
                    })
            }
            .overlay(alignment: .bottom) {
                if !atBottom, !messages.isEmpty {
                    Button { withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) } } label: {
                        Image(systemName: "arrow.down").font(.system(size: 12, weight: .semibold)).frame(width: 30, height: 30)
                            .background(Color(nsColor: .windowBackgroundColor), in: Circle())
                            .overlay(Circle().strokeBorder(Color.primary.opacity(0.12)))
                            .shadow(color: .black.opacity(0.15), radius: 6, y: 2)
                    }.buttonStyle(.plain).padding(.bottom, 10).help("Jump to latest").accessibilityLabel("Jump to latest")
                }
            }
            .onChange(of: sessionID) { proxy.scrollTo("bottom", anchor: .bottom) }
            .onChange(of: messages.last(where: { $0.role == "user" })?.id) {
                DispatchQueue.main.async { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: current) { if let current { withAnimation { proxy.scrollTo(current, anchor: .center) } } }
        }
    }

    private var empty: some View {
        VStack(alignment: .leading, spacing: 14) {
            Image(systemName: "waveform.circle.fill").font(.system(size: 30)).foregroundStyle(accent)
            Text("What's on your mind?").font(.system(size: 22, weight: .medium))
            VStack(alignment: .leading, spacing: 6) {
                starter("What's on my screen?", "macwindow", attach: .window)
                starter("Summarize the text I selected", "text.cursor", attach: .selection)
                starter("Search the web for ", "globe", attach: nil)
            }
            Text("Type / for commands, @ to attach context, ⌘K for everything, ⌘/ for shortcuts.")
                .font(.system(size: 11.5)).foregroundStyle(.tertiary)
        }.padding(14).padding(.top, 30).frame(maxWidth: .infinity, alignment: .leading)
    }

    private func starter(_ text: String, _ symbol: String, attach: AssistantContextSource?) -> some View {
        Button {
            if let attach { model.actions?.attach(attach) }
            model.input = text
            model.focus()
        } label: {
            Label(text.trimmingCharacters(in: .whitespaces) + (attach == nil ? "..." : ""), systemImage: symbol)
                .font(.system(size: 12.5)).padding(.horizontal, 10).padding(.vertical, 6)
                .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 7))
        }.buttonStyle(.plain).foregroundStyle(.secondary)
    }
}

struct AssistantChatView: View {
    @ObservedObject var model: AssistantChatModel
    @State private var dropping = false
    private let accent = Color(red: 0.10, green: 0.55, blue: 0.47)

    var body: some View {
        let matches = model.findMatches
        HStack(spacing: 0) {
            if model.historyVisible { AssistantSidebar(model: model).frame(width: 220); Divider() }
            VStack(spacing: 0) {
                header
                Divider()
                if model.findVisible { AssistantFindBar(model: model); Divider() }
                AssistantConversation(model: model, messages: model.messages, sessionID: model.sessionID, scale: model.textScale,
                                      verbose: model.verboseTools, editingID: model.editingID, editable: model.editable,
                                      retryable: model.canRetry, matches: matches,
                                      current: matches.isEmpty ? nil : matches[min(model.findIndex, matches.count - 1)],
                                      speakingID: model.speakingID, atBottom: model.atBottom, accent: accent).equatable()
                AssistantComposer(model: model, accent: accent)
            }.frame(minWidth: 370)
        }.background {
            ZStack {
                ChatGlass()
                Color(nsColor: .windowBackgroundColor).opacity(0.72)
                LinearGradient(colors: [accent.opacity(0.07), Color.clear, Color.pink.opacity(0.04)], startPoint: .topLeading, endPoint: .bottomTrailing)
            }.ignoresSafeArea()
        }
        .overlay {
            if dropping {
                RoundedRectangle(cornerRadius: 12).strokeBorder(accent, style: StrokeStyle(lineWidth: 2, dash: [6]))
                    .background(accent.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
                    .overlay(Label("Drop to attach", systemImage: "paperclip").font(.system(size: 14, weight: .medium)))
                    .padding(8).allowsHitTesting(false)
            }
        }
        .overlay { if model.paletteVisible { AssistantPalette(model: model, accent: accent) } }
        .overlay { if model.shortcutsVisible { AssistantShortcutSheet(model: model) } }
        .onDrop(of: [.fileURL, .image], isTargeted: $dropping) { providers in
            guard !model.liveVoice else { return false }
            Task { @MainActor in model.actions?.attach(await AssistantAttachments.load(providers)) }
            return true
        }
        .tint(accent).accentColor(accent)
    }

    private var subtitle: String {
        if model.liveVoice { return "\(model.liveName) + Hermes" }
        return (["Hermes", model.model, model.effort.map { $0 + " effort" }] as [String?]).compactMap { $0 }.joined(separator: " · ")
    }

    private var header: some View {
        HStack(spacing: 12) {
            tool("sidebar.left", "Conversations (⌘B)") { model.perform(.sidebar) }
            VStack(alignment: .leading, spacing: 2) {
                Text(model.currentTitle)
                    .font(.system(size: 15, weight: .semibold)).lineLimit(1).truncationMode(.tail)
                Text(subtitle).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            chatTools
            tool("gearshape", "Assistant settings (⌘,)") { model.actions?.openBento("settings") }
            tool("xmark", "Hide (Esc)") { model.actions?.hide() }
        }.padding(.horizontal, 18).padding(.vertical, 12)
    }

    @ViewBuilder
    private var chatTools: some View {
            tool("square.and.pencil", "New chat (⌘N)") { model.perform(.newChat) }.disabled(!model.idle)
            Menu {
                Button("Command Palette   ⌘K") { model.perform(.palette) }
                Button("Find   ⌘F") { model.perform(.find) }
                Divider()
                Button("Export as Markdown...   ⌘S") { model.perform(.export) }.disabled(model.messages.isEmpty)
                Button("Copy Conversation as Markdown") {
                    model.copy(AssistantTranscript.markdown(model.messages, title: model.currentTitle)); model.status = "Copied conversation"
                }.disabled(model.messages.isEmpty)
                Button(model.verboseTools ? "Collapse Tool Steps   ⌃O" : "Expand Tool Steps   ⌃O") { model.perform(.steps) }
                Divider()
                Button("Larger Text   ⌘+") { model.perform(.zoomIn) }
                Button("Smaller Text   ⌘−") { model.perform(.zoomOut) }
                Button("Actual Size   ⌘0") { model.perform(.zoomReset) }
                Divider()
                Button("Keyboard Shortcuts   ⌘/") { model.perform(.shortcuts) }
            } label: { Image(systemName: "ellipsis.circle").foregroundStyle(.secondary) }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().help("More")
    }

    private func tool(_ symbol: String, _ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: symbol).frame(width: 26, height: 28).contentShape(Rectangle()) }
            .buttonStyle(.plain).foregroundStyle(.secondary).help(title).accessibilityLabel(title)
    }
}
