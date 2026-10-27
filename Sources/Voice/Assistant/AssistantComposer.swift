import AppKit
import VoiceCore
import SwiftUI

private struct ChatEditor: NSViewRepresentable {
    @ObservedObject var model: AssistantChatModel
    @Binding var height: CGFloat
    let enabled: Bool

    final class Editor: NSTextView {
        var onKey: ((AssistantChatModel.ComposerKey) -> Bool)?
        var onAttach: ((NSPasteboard) -> Bool)?
        var onResize: (() -> Void)?
        override func keyDown(with event: NSEvent) {
            if !hasMarkedText(), event.keyCode == 36 || event.keyCode == 76 {
                let flags = AssistantShortcuts.flags(event)
                if flags.isEmpty, onKey?(.enter) == true { return }
                if flags == .command, onKey?(.steer) == true { return }
            }
            super.keyDown(with: event)
        }
        override func paste(_ sender: Any?) {
            if onAttach?(.general) == true { return }
            super.paste(sender)
        }
        override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
            if onAttach?(sender.draggingPasteboard) == true { return true }
            return super.performDragOperation(sender)
        }
        override func setFrameSize(_ newSize: NSSize) {
            let changed = newSize.width != frame.width
            super.setFrameSize(newSize)
            if changed { onResize?() }
        }
    }

    @MainActor final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ChatEditor
        var focus: UUID?
        var scale: Double = 0
        init(_ parent: ChatEditor) { self.parent = parent }
        func textDidChange(_ notification: Notification) {
            guard let editor = notification.object as? NSTextView else { return }
            parent.model.edited(editor.string)
            measure(editor)
        }
        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            guard !textView.hasMarkedText() else { return false }
            let text = textView.string as NSString, caret = textView.selectedRange()
            let firstLine = !text.substring(to: min(caret.location, text.length)).contains("\n")
            let lastLine = !text.substring(from: min(NSMaxRange(caret), text.length)).contains("\n")
            let key: AssistantChatModel.ComposerKey
            switch selector {
            case #selector(NSResponder.moveUp(_:)): key = .up
            case #selector(NSResponder.moveDown(_:)): key = .down
            case #selector(NSResponder.insertTab(_:)): key = .tab
            default: return false
            }
            let handled = parent.model.composerKey(key, firstLine: firstLine, lastLine: lastLine)
            if handled { sync(textView) }
            return handled
        }
        /// Applies the model's draft at once: keys queued behind Return must not land in the sent text.
        func sync(_ editor: NSTextView) {
            guard editor.string != parent.model.input else { return }
            editor.string = parent.model.input
            editor.setSelectedRange(NSRange(location: (editor.string as NSString).length, length: 0))
            measure(editor)
        }
        func measure(_ editor: NSTextView) {
            guard let manager = editor.layoutManager, let container = editor.textContainer else { return }
            manager.ensureLayout(for: container)
            let height = min(max(ceil(manager.usedRect(for: container).height + editor.textContainerInset.height * 2), 32), 220)
            if abs(height - parent.height) > 0.5 { DispatchQueue.main.async { self.parent.height = height } }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false
        let editor = Editor()
        editor.isRichText = false
        editor.importsGraphics = false
        editor.allowsUndo = true
        editor.drawsBackground = false
        editor.textColor = .labelColor
        editor.textContainerInset = NSSize(width: 5, height: 6)
        editor.isVerticallyResizable = true
        editor.autoresizingMask = [.width]
        editor.textContainer?.widthTracksTextView = true
        editor.isAutomaticQuoteSubstitutionEnabled = false
        editor.isAutomaticDashSubstitutionEnabled = false
        editor.delegate = context.coordinator
        editor.setAccessibilityLabel("Ask Hermes")
        editor.string = model.input
        scroll.documentView = editor
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        guard let editor = scroll.documentView as? Editor else { return }
        let model = self.model
        editor.onKey = { [weak editor, weak coordinator] key in
            guard let editor else { return false }
            let text = editor.string as NSString, caret = editor.selectedRange()
            let handled = model.composerKey(key, firstLine: !text.substring(to: min(caret.location, text.length)).contains("\n"),
                                            lastLine: !text.substring(from: min(NSMaxRange(caret), text.length)).contains("\n"))
            if handled { coordinator?.sync(editor) }
            return handled
        }
        editor.onAttach = { pasteboard in
            guard let attachments = AssistantAttachments.pasteboard(pasteboard), !attachments.isEmpty else { return false }
            model.actions?.attach(attachments)
            return true
        }
        editor.onResize = { [weak coordinator, weak editor] in
            guard let coordinator, let editor else { return }
            coordinator.measure(editor)
        }
        if coordinator.scale != model.textScale {
            coordinator.scale = model.textScale
            editor.font = .systemFont(ofSize: 15 * model.textScale)
            coordinator.measure(editor)
        }
        coordinator.sync(editor)
        editor.isEditable = enabled
        if coordinator.focus != model.focusToken {
            coordinator.focus = model.focusToken
            DispatchQueue.main.async { editor.window?.makeFirstResponder(editor) }
        }
    }
}

private struct DimmedWhenDisabled: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(enabled ? (configuration.isPressed ? 0.75 : 1) : 0.4)
    }
}

private struct ContextRing: View {
    let usage: AssistantUsage
    var body: some View {
        ZStack {
            Circle().stroke(Color.primary.opacity(0.15), lineWidth: 2.5)
            Circle().trim(from: 0, to: max(0.02, usage.fraction))
                .stroke(usage.fraction > 0.85 ? Color.red : usage.fraction > 0.6 ? Color.orange : Color.accentColor,
                        style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }.frame(width: 15, height: 15)
    }
    static func tokens(_ count: Int) -> String {
        count >= 1_000_000 ? String(format: "%.1fM", Double(count) / 1_000_000) :
            count >= 1000 ? String(format: "%.1fk", Double(count) / 1000) : "\(count)"
    }
}

struct AssistantPlanView: View {
    @ObservedObject var model: AssistantChatModel
    var body: some View {
        let done = model.plan.filter { $0.status == "completed" }.count
        let current = model.plan.first { $0.status == "in_progress" } ?? model.plan.first { $0.status == "pending" }
        VStack(alignment: .leading, spacing: 6) {
            Button { withAnimation(.easeInOut(duration: 0.15)) { model.planExpanded.toggle() } } label: {
                HStack(spacing: 8) {
                    Image(systemName: "checklist").foregroundStyle(Color.accentColor)
                    Text("Plan").fontWeight(.semibold)
                    Text("\(done) of \(model.plan.count)").foregroundStyle(.secondary)
                    if !model.planExpanded, let current { Text(current.content).foregroundStyle(.secondary).lineLimit(1) }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.up").font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(model.planExpanded ? 180 : 0)).foregroundStyle(.secondary)
                }.font(.system(size: 12)).contentShape(Rectangle())
            }.buttonStyle(.plain).help("Show or hide plan (⌃T)")
            if model.planExpanded {
                ForEach(Array(model.plan.enumerated()), id: \.offset) { _, entry in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: entry.status == "completed" ? "checkmark.circle.fill" :
                                entry.status == "in_progress" ? "circle.dotted.circle" : "circle")
                            .foregroundStyle(entry.status == "pending" ? Color.secondary : Color.accentColor)
                        Text(entry.content).strikethrough(entry.status == "completed")
                            .foregroundStyle(entry.status == "completed" ? Color.secondary : Color.primary)
                            .fixedSize(horizontal: false, vertical: true)
                    }.font(.system(size: 12))
                }
            }
        }.padding(.horizontal, 10).padding(.vertical, 8)
            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct AssistantComposer: View {
    @AppStorage("assistantLiveCall") private var assistantLiveCall = true
    @AppStorage("assistantLiveProvider") private var assistantLiveProvider = SettingsStore.AssistantLiveProvider.gpt.rawValue
    @ObservedObject var model: AssistantChatModel
    let accent: Color
    @State private var height: CGFloat = 32
    @State private var contextDetails = false

    var body: some View {
        VStack(spacing: 8) {
            if !model.plan.isEmpty { AssistantPlanView(model: model) }
            if !model.queue.isEmpty { queue }
            HStack(spacing: 7) {
                Circle().fill(model.busy ? accent : Color.secondary.opacity(0.5)).frame(width: 5, height: 5)
                Text(model.status).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1).help(model.status)
                Spacer(minLength: 0)
            }
            box
        }.padding(.horizontal, 18).padding(.bottom, 16).padding(.top, 8)
    }

    private var placeholder: String {
        if model.liveVoice { return "\(model.liveName) call in progress" }
        return model.busy ? "Queue a follow-up, or ⌘↵ to steer..." : "Ask Hermes...   / for commands, @ to attach"
    }

    private var box: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !model.attachments.isEmpty {
                FlowRow(spacing: 6) {
                    ForEach(model.attachments) { attachment in
                        AttachmentChip(attachment: attachment) { model.attachments.removeAll { $0.id == attachment.id } }
                    }
                }.padding(.horizontal, 4).padding(.top, 2)
            }
            ZStack(alignment: .topLeading) {
                if model.input.isEmpty {
                    // Matches the editor's text inset plus line fragment padding.
                    Text(placeholder).font(.system(size: 15 * model.textScale)).foregroundStyle(.tertiary)
                        .padding(.top, 6).padding(.leading, 10).allowsHitTesting(false)
                }
                ChatEditor(model: model, height: $height, enabled: !model.historyBusy && !model.liveVoice)
            }.frame(height: height)
            toolbar
        }.padding(8)
            .background(Color(nsColor: .textBackgroundColor).opacity(0.65), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.primary.opacity(0.13)))
            .overlay(alignment: .top) {
                // A zero-height anchor on the top edge; the popup grows upward from it.
                let items = model.suggestions
                Color.clear.frame(height: 0).overlay(alignment: .bottom) {
                    if !items.isEmpty { suggestions(items).fixedSize(horizontal: false, vertical: true).padding(.bottom, 6) }
                }
            }
    }

    private var toolbar: some View {
        HStack(spacing: 4) {
            Menu {
                ForEach(AssistantContextSource.allCases, id: \.self) { source in
                    Button { model.actions?.attach(source) } label: { Label(source.title, systemImage: source.symbol) }
                }
            } label: { Image(systemName: "plus").font(.system(size: 13, weight: .medium)) }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .padding(.horizontal, 6).help("Attach context (@)").disabled(model.liveVoice)
            if !model.efforts.isEmpty {
                Menu {
                    ForEach(model.efforts, id: \.self) { effort in
                        Button { model.actions?.settings(effort: effort, model: nil) } label: {
                            if effort == model.effort { Label(effort.capitalized, systemImage: "checkmark") } else { Text(effort.capitalized) }
                        }
                    }
                } label: { Label(model.effort?.capitalized ?? "Effort", systemImage: "brain").font(.system(size: 11.5)) }
                    .menuStyle(.borderlessButton).fixedSize().help("Reasoning effort").disabled(!model.idle || model.liveVoice)
            }
            if model.models.count > 1 {
                Menu {
                    ForEach(model.models, id: \.self) { name in
                        Button { model.actions?.settings(effort: nil, model: name) } label: {
                            if name == model.model { Label(name, systemImage: "checkmark") } else { Text(name) }
                        }
                    }
                } label: { Label(model.model ?? "Model", systemImage: "cpu").font(.system(size: 11.5)) }
                    // A long model name truncates rather than pushing the send button out of the box.
                    .menuStyle(.borderlessButton).fixedSize(horizontal: false, vertical: true)
                    .frame(minWidth: 60, maxWidth: 200, alignment: .leading).layoutPriority(-1)
                    .help(model.model ?? "Model").disabled(!model.idle || model.liveVoice)
            }
            Spacer(minLength: 0)
            if let usage = model.currentUsage, usage.size > 0 {
                // Menu labels render only text and images on macOS, so the ring opens a popover.
                Button { contextDetails.toggle() } label: { ContextRing(usage: usage).padding(6).contentShape(Rectangle()) }
                    .buttonStyle(.plain).help("Context \(Int((usage.fraction * 100).rounded()))% used")
                    .popover(isPresented: $contextDetails, arrowEdge: .top) {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Context window").font(.system(size: 12, weight: .semibold))
                            Text("\(ContextRing.tokens(usage.used)) of \(ContextRing.tokens(usage.size)) tokens (\(Int((usage.fraction * 100).rounded()))%)")
                                .font(.system(size: 12)).foregroundStyle(.secondary)
                            HStack {
                                Button("Compress") { contextDetails = false; model.runCommand("/compress") }
                                Button("Details") { contextDetails = false; model.runCommand("/context") }
                            }.disabled(!model.idle)
                        }.padding(14)
                    }
            }
            if !model.liveVoice {
                Button { model.actions?.dictate() } label: {
                    Image(systemName: model.recording ? "mic.fill" : "mic").font(.system(size: 15, weight: .medium))
                        .frame(width: 28, height: 28).contentShape(Rectangle())
                }.buttonStyle(DimmedWhenDisabled()).foregroundStyle(model.recording ? Color.red : Color.secondary)
                    .help(model.recording ? "Finish voice request" : "Dictate to Hermes")
                    .accessibilityLabel(model.recording ? "Finish voice request" : "Dictate to Hermes")
                    .disabled(!model.recording && (model.busy || model.historyBusy))
            }
            let empty = model.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && model.attachments.isEmpty
            if model.liveVoice {
                button("phone.down.fill", "End \(model.liveName) call", tint: .red) { model.actions?.call() }
            } else {
                if model.busy, !model.recording { // A recording finishes with the mic.
                    button("stop.fill", model.stopping ? "Stopping..." : "Stop (⌘.)") { model.perform(.stop) }.disabled(model.stopping)
                }
                if !empty {
                    button("arrow.up", model.busy ? "Queue (↵) or steer (⌘↵)" : "Send (↵)") { model.submit() }
                        .disabled(model.historyBusy || model.recording)
                } else if !model.busy {
                    let provider = SettingsStore.AssistantLiveProvider(rawValue: assistantLiveProvider) ?? .gpt
                    button("waveform", assistantLiveCall ? "Start \(provider.displayName) call" : "Voice calls are off in Assistant settings") {
                        model.actions?.call()
                    }.disabled(!assistantLiveCall || model.historyBusy || model.recording)
                }
            }
        }
    }

    /// The round primary button, ChatGPT style: inverted against the window.
    private func button(_ symbol: String, _ title: String, tint: Color = .primary, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 13, weight: .semibold))
                .frame(width: 30, height: 30)
                .foregroundStyle(tint == .primary ? Color(nsColor: .windowBackgroundColor) : .white)
                .background(tint, in: Circle())
        }.buttonStyle(DimmedWhenDisabled()).help(title).accessibilityLabel(title)
    }

    private var queue: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Queued, sends when Hermes finishes").font(.system(size: 10.5, weight: .semibold)).foregroundStyle(.secondary)
            ForEach(model.queue) { item in
                HStack(spacing: 8) {
                    Image(systemName: "clock.arrow.circlepath").foregroundStyle(.secondary)
                    Text(item.text.isEmpty ? item.attachments.map(\.name).joined(separator: ", ") : item.text)
                        .lineLimit(1).truncationMode(.tail).frame(maxWidth: .infinity, alignment: .leading)
                    if !item.attachments.isEmpty { Image(systemName: "paperclip").foregroundStyle(.secondary) }
                    if item.attachments.isEmpty, !item.text.hasPrefix("/") {
                        Button("Send now") { model.steerNow(item) }.buttonStyle(.borderless).help("Steer the running turn")
                    }
                    Button { model.unqueue(item) } label: { Image(systemName: "pencil") }.buttonStyle(.borderless).help("Edit")
                    Button { model.queue.removeAll { $0.id == item.id } } label: { Image(systemName: "xmark") }
                        .buttonStyle(.borderless).help("Remove from queue")
                }.font(.system(size: 12))
            }
        }.padding(.horizontal, 10).padding(.vertical, 8)
            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
    }

    private func suggestions(_ items: [AssistantSuggestion]) -> some View {
        let selected = min(model.selection, items.count - 1)
        return VStack(alignment: .leading, spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 1) {
                        ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                            Button { model.selection = index; model.accept(item, run: true) } label: {
                                row(item).padding(.horizontal, 8).padding(.vertical, 5)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(index == selected ? accent.opacity(0.18) : Color.clear, in: RoundedRectangle(cornerRadius: 5))
                                    .contentShape(Rectangle())
                            }.buttonStyle(.plain).id(index)
                        }
                    }.padding(5)
                }.frame(maxHeight: 240).fixedSize(horizontal: false, vertical: true)
                    .onChange(of: selected) { proxy.scrollTo(selected) }
            }
            Divider()
            Text("↑↓ navigate   ↵ select   Tab complete   Esc dismiss").font(.system(size: 10)).foregroundStyle(.tertiary)
                .padding(.horizontal, 12).padding(.vertical, 5)
        }.background(Color(nsColor: .windowBackgroundColor), in: RoundedRectangle(cornerRadius: 9))
            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Color.primary.opacity(0.12)))
            .shadow(color: .black.opacity(0.18), radius: 12, y: 4)
    }

    @ViewBuilder private func row(_ item: AssistantSuggestion) -> some View {
        switch item.kind {
        case .command(let command):
            HStack(spacing: 8) {
                Text("/" + command.name).font(.system(size: 12.5, weight: .medium, design: .monospaced))
                if let hint = command.hint { Text(hint).font(.system(size: 11.5)).foregroundStyle(.tertiary).lineLimit(1) }
                Spacer(minLength: 8)
                Text(command.description).font(.system(size: 11.5)).foregroundStyle(.secondary).lineLimit(1)
            }
        case .context(let source):
            HStack(spacing: 8) {
                Image(systemName: source.symbol).frame(width: 16).foregroundStyle(accent)
                Text(source.title).font(.system(size: 12.5, weight: .medium))
                Spacer(minLength: 8)
                Text(source.detail).font(.system(size: 11.5)).foregroundStyle(.secondary).lineLimit(1)
            }
        }
    }
}
