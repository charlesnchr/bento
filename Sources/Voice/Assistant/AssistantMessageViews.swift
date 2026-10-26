import AppKit
import SwiftUI
import MarkdownUI

struct ChatImage: View {
    let source: String
    var maxHeight: CGFloat = 300
    @StateObject private var remote = AssistantRemoteImage()
    var body: some View {
        if let url = URL(string: source), let (latex, display) = AssistantMath.equation(url) {
            AssistantEquation(latex: latex, display: display)
        } else if source.hasPrefix("data:image/"), let comma = source.firstIndex(of: ","),
           let data = Data(base64Encoded: String(source[source.index(after: comma)...])),
           data.count <= 12_000_000, let image = NSImage(data: data) {
            Image(nsImage: image).resizable().scaledToFit().frame(maxHeight: maxHeight)
        } else if let url = URL(string: source), url.scheme == "https", url.user == nil, url.password == nil {
            Group {
            if let image = remote.image {
                Image(nsImage: image).resizable().scaledToFit().frame(maxHeight: maxHeight)
            } else if let error = remote.error {
                VStack(alignment: .leading, spacing: 8) {
                    Label(error, systemImage: "exclamationmark.triangle").font(.system(size: 12)).foregroundStyle(.secondary)
                    Button { remote.load(url) } label: { Label("Retry image", systemImage: "arrow.clockwise") }
                        .buttonStyle(.borderless)
                }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8)
            } else {
                VStack(spacing: 10) {
                    ProgressView().controlSize(.regular).accessibilityLabel("Loading image")
                    Text("Loading image...").font(.system(size: 13, weight: .medium))
                    Text(url.host ?? "website").font(.system(size: 11)).foregroundStyle(.secondary)
                    Button { remote.cancel() } label: { Image(systemName: "xmark").frame(width: 28, height: 28) }
                        .buttonStyle(.borderless).help("Cancel image loading").accessibilityLabel("Cancel image loading")
                }.frame(maxWidth: .infinity, minHeight: 180)
                    .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 6))
            }
            }.onAppear { remote.loadIfNeeded(url) }
        } else { Label("Image unavailable", systemImage: "photo").foregroundStyle(.secondary) }
    }
}

private struct ChatImageProvider: ImageProvider {
    func makeImage(url: URL?) -> some View { ChatImage(source: url?.absoluteString ?? "").id(url) }
}

private struct ChatInlineImageProvider: InlineImageProvider {
    var dark: Bool
    func image(with url: URL, label: String) async throws -> Image {
        if let (latex, display) = AssistantMath.equation(url) {
            return await MainActor.run {
                AssistantMath.image(latex, display: display, dark: dark).map { Image(nsImage: $0) } ?? Image(systemName: "function")
            }
        }
        // Inline images must not trigger hidden network requests.
        if url.scheme == "data", let comma = url.absoluteString.firstIndex(of: ","),
           let data = Data(base64Encoded: String(url.absoluteString[url.absoluteString.index(after: comma)...])),
           data.count <= 12_000_000, let image = NSImage(data: data) { return Image(nsImage: image) }
        return Image(systemName: "photo")
    }
}

private struct ChatCodeBlock: View {
    let configuration: CodeBlockConfiguration
    let scale: Double
    @State private var copied = false
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(configuration.language?.isEmpty == false ? configuration.language! : "code")
                    .font(.system(size: 10.5, design: .monospaced)).foregroundStyle(.secondary)
                Spacer()
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(configuration.content, forType: .string)
                    copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
                } label: { Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc").font(.system(size: 11)) }
                    .buttonStyle(.borderless).foregroundStyle(.secondary).help("Copy code")
            }.padding(.horizontal, 10).padding(.vertical, 4).background(Color.primary.opacity(0.035))
            ScrollView(.horizontal) {
                configuration.label.markdownTextStyle { FontFamilyVariant(.monospaced); FontSize(12 * scale); BackgroundColor(nil) }
                    .padding(10)
            }
        }.background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.primary.opacity(0.06)))
            .markdownMargin(top: 4, bottom: 8)
    }
}

@MainActor
private enum ChatTheme {
    private static var cache: [Double: Theme] = [:]
    static func scaled(_ scale: Double) -> Theme {
        if let theme = cache[scale] { return theme }
        let theme = Theme.gitHub
            .text { FontSize(14 * scale); ForegroundColor(.primary); BackgroundColor(nil) }
            .code { FontFamilyVariant(.monospaced); FontSize(.em(0.9)); BackgroundColor(.primary.opacity(0.06)) }
            .paragraph { configuration in
                configuration.label.fixedSize(horizontal: false, vertical: true)
                    .relativeLineSpacing(.em(0.18)).markdownMargin(top: 0, bottom: 8)
            }
            .heading1 { configuration in
                configuration.label.markdownTextStyle { FontSize(19 * scale); FontWeight(.semibold) }
                    .markdownMargin(top: 14, bottom: 8)
            }
            .heading2 { configuration in
                configuration.label.markdownTextStyle { FontSize(17 * scale); FontWeight(.semibold) }
                    .markdownMargin(top: 12, bottom: 6)
            }
            .heading3 { configuration in
                configuration.label.markdownTextStyle { FontSize(15 * scale); FontWeight(.semibold) }
                    .markdownMargin(top: 10, bottom: 6)
            }
            .codeBlock { configuration in ChatCodeBlock(configuration: configuration, scale: scale) }
            .table { configuration in
                ScrollView(.horizontal) {
                    configuration.label.markdownTableBorderStyle(.init(color: .primary.opacity(0.12)))
                        .markdownTableBackgroundStyle(.alternatingRows(.clear, .primary.opacity(0.035)))
                }.markdownMargin(top: 4, bottom: 8)
            }
        cache[scale] = theme
        return theme
    }
}

struct ChatGlass: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = .hudWindow
        view.blendingMode = .behindWindow
        view.state = .active
        return view
    }
    func updateNSView(_ view: NSVisualEffectView, context: Context) {}
}

struct AttachmentChip: View {
    let attachment: AssistantAttachment
    var remove: (() -> Void)?
    var body: some View {
        HStack(spacing: 6) {
            if attachment.kind == .image, let data = Data(base64Encoded: attachment.data), let image = NSImage(data: data) {
                Image(nsImage: image).resizable().scaledToFill().frame(width: 22, height: 22).clipShape(RoundedRectangle(cornerRadius: 4))
            } else {
                Image(systemName: attachment.kind == .text ? "text.quote" : "doc").font(.system(size: 11)).frame(width: 16)
            }
            Text(attachment.name).font(.system(size: 11.5)).lineLimit(1).truncationMode(.middle).frame(maxWidth: 160, alignment: .leading)
            if let remove {
                Button(action: remove) { Image(systemName: "xmark").font(.system(size: 9, weight: .bold)) }
                    .buttonStyle(.plain).foregroundStyle(.secondary).help("Remove attachment").accessibilityLabel("Remove " + attachment.name)
            }
        }.padding(.horizontal, 7).padding(.vertical, 4)
            .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
            .help(attachment.kind == .file ? attachment.path : attachment.name)
    }
}

private struct ChatThoughtView: View {
    let thought: String
    let seconds: Double?
    let scale: Double
    @State private var expanded = false
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() } } label: {
                HStack(spacing: 6) {
                    Image(systemName: "brain").font(.system(size: 11))
                    Text(seconds == nil ? "Thinking..." : seconds! >= 1 ? "Thought for \(Int(seconds!.rounded()))s" : "Thoughts")
                    Image(systemName: "chevron.right").font(.system(size: 8, weight: .semibold)).rotationEffect(.degrees(expanded ? 90 : 0))
                }.font(.system(size: 12 * scale)).foregroundStyle(.secondary).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityValue(expanded ? "Expanded" : "Collapsed")
            if expanded {
                Text(thought.trimmingCharacters(in: .whitespacesAndNewlines)).font(.system(size: 12.5 * scale)).foregroundStyle(.secondary)
                    .textSelection(.enabled).fixedSize(horizontal: false, vertical: true).padding(.leading, 10)
                    .overlay(alignment: .leading) { Rectangle().fill(Color.primary.opacity(0.12)).frame(width: 2) }
            } else if seconds == nil, let line = thought.split(separator: "\n").last(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }) {
                Text(line.trimmingCharacters(in: .whitespaces)).font(.system(size: 11.5 * scale)).foregroundStyle(.tertiary).lineLimit(1)
            }
        }
    }
}

private struct ChatDiffView: View {
    let path: String
    let rows: [(mark: Character, text: String)]
    init(_ diff: AssistantDiff) { path = diff.path; rows = AssistantTranscript.diffLines(diff) }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(path).font(.system(size: 11, weight: .medium, design: .monospaced)).lineLimit(1).truncationMode(.head)
                .padding(.horizontal, 8).padding(.vertical, 5)
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                Text((row.mark == "~" ? " " : String(row.mark)) + " " + row.text)
                    .font(.system(size: 11, design: .monospaced)).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 8)
                    .foregroundStyle(row.mark == "~" ? Color.secondary : Color.primary)
                    .background(row.mark == "+" ? Color.green.opacity(0.14) : row.mark == "-" ? Color.red.opacity(0.14) : Color.clear)
            }
        }.background(Color.primary.opacity(0.03), in: RoundedRectangle(cornerRadius: 5))
            .clipShape(RoundedRectangle(cornerRadius: 5))
    }
}

struct ChatToolView: View {
    let message: AssistantMessage
    var verbose = false
    @State private var expanded: Bool?
    @State private var hovered = false
    private var running: Bool { !["completed", "failed", "interrupted"].contains(message.toolStatus) }
    static func symbol(_ kind: String) -> String {
        switch kind {
        case "read": return "doc.text"
        case "edit": return "pencil"
        case "delete": return "trash"
        case "move": return "arrow.right.doc.on.clipboard"
        case "search": return "magnifyingglass"
        case "execute": return "terminal"
        case "think": return "brain"
        case "fetch": return "globe"
        case "switch_mode": return "arrow.triangle.swap"
        default: return "wrench.and.screwdriver"
        }
    }
    var body: some View {
        let open = expanded ?? verbose
        VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(.easeInOut(duration: 0.15)) { expanded = !open } } label: {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(open ? 90 : 0)).frame(width: 10)
                    Image(systemName: Self.symbol(message.toolKind)).frame(width: 14)
                        .foregroundStyle(message.toolStatus == "failed" ? Color.red : Color.accentColor)
                    Text(message.text.replacingOccurrences(of: "\n", with: " "))
                        .lineLimit(1).truncationMode(.middle).frame(maxWidth: .infinity, alignment: .leading)
                    if running {
                        TimelineView(.periodic(from: message.date, by: 1)) { context in
                            Text(Self.duration(context.date.timeIntervalSince(message.date))).monospacedDigit()
                        }
                        ProgressView().controlSize(.mini)
                    } else {
                        if let finished = message.finished, message.date > .distantPast, finished.timeIntervalSince(message.date) >= 0.1 {
                            Text(Self.duration(finished.timeIntervalSince(message.date))).monospacedDigit()
                        }
                        Image(systemName: message.toolStatus == "failed" ? "exclamationmark.circle" :
                                message.toolStatus == "interrupted" ? "pause.circle" : "checkmark")
                            .foregroundStyle(message.toolStatus == "failed" ? Color.red : Color.secondary)
                    }
                }.font(.system(size: 12)).foregroundStyle(.secondary)
                    .padding(.horizontal, 8).frame(height: 28)
                    .background(Color.primary.opacity(hovered ? 0.06 : 0), in: RoundedRectangle(cornerRadius: 5))
                    .contentShape(Rectangle())
            }.buttonStyle(.plain).onHover { hovered = $0 }
                .help(message.text).accessibilityLabel(message.text)
                .accessibilityValue((open ? "Expanded, " : "Collapsed, ") + message.toolStatus)
            if open {
                VStack(alignment: .leading, spacing: 8) {
                    Text(message.text).font(.system(size: 12, weight: .medium))
                    ForEach(Array(message.diffs.enumerated()), id: \.offset) { _, diff in ChatDiffView(diff) }
                    if !message.toolDetail.isEmpty {
                        Text(message.toolDetail).font(.system(size: 11, design: .monospaced))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Text(message.toolStatus.replacingOccurrences(of: "_", with: " ").capitalized).font(.system(size: 10)).foregroundStyle(.secondary)
                }.textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, 14).padding(.vertical, 8)
                    .overlay(alignment: .leading) { Rectangle().fill(Color.primary.opacity(0.12)).frame(width: 1) }
                    .padding(.leading, 13).padding(.trailing, 8).padding(.bottom, 6)
            }
        }.padding(.horizontal, 4)
            .onChange(of: verbose) { expanded = nil }
    }
    static func duration(_ seconds: Double) -> String {
        seconds < 60 ? String(format: seconds < 10 ? "%.1fs" : "%.0fs", seconds) : String(format: "%d:%02d", Int(seconds) / 60, Int(seconds) % 60)
    }
}

/// Consecutive tool calls collapse into one summary row once they finish.
struct ChatStepsView: View {
    let steps: [AssistantMessage]
    let verbose: Bool
    @State private var expanded: Bool?
    @State private var hovered = false
    private var running: AssistantMessage? { steps.last { !["completed", "failed", "interrupted"].contains($0.toolStatus) } }
    private var summary: String {
        if let running { return running.text.replacingOccurrences(of: "\n", with: " ") }
        let failed = steps.filter { $0.toolStatus == "failed" }.count
        return "Used \(steps.count) tools" + (failed > 0 ? " · \(failed) failed" : "")
    }
    var body: some View {
        let open = expanded ?? (verbose || running != nil)
        VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(.easeInOut(duration: 0.15)) { expanded = !open } } label: {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(open ? 90 : 0)).frame(width: 10)
                    HStack(spacing: 3) {
                        ForEach(Array(Set(steps.map(\.toolKind))).sorted().prefix(4), id: \.self) { kind in
                            Image(systemName: ChatToolView.symbol(kind)).font(.system(size: 10))
                        }
                    }.foregroundStyle(Color.accentColor)
                    Text(summary).lineLimit(1).truncationMode(.middle).frame(maxWidth: .infinity, alignment: .leading)
                    if running != nil { ProgressView().controlSize(.mini) }
                }.font(.system(size: 12)).foregroundStyle(.secondary)
                    .padding(.horizontal, 8).frame(height: 28)
                    .background(Color.primary.opacity(hovered ? 0.06 : 0), in: RoundedRectangle(cornerRadius: 5))
                    .contentShape(Rectangle())
            }.buttonStyle(.plain).onHover { hovered = $0 }.accessibilityLabel(summary)
            if open {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(steps) { ChatToolView(message: $0, verbose: verbose) }
                }.padding(.leading, 14)
            }
        }.padding(.horizontal, 4)
            .onChange(of: verbose) { expanded = nil }
    }
}

private struct ChatEditBox: View {
    @ObservedObject var model: AssistantChatModel
    var body: some View {
        VStack(alignment: .trailing, spacing: 8) {
            TextEditor(text: $model.editText).font(.system(size: 14 * model.textScale)).scrollContentBackground(.hidden)
                .frame(minHeight: 60, maxHeight: 220).padding(6)
                .background(Color(nsColor: .textBackgroundColor).opacity(0.7), in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.accentColor.opacity(0.5)))
            HStack {
                Text("Replies after this message are replaced. Completed actions are not undone.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                Spacer()
                Button("Cancel") { model.cancelEdit() }
                Button("Send") { model.commitEdit() }.keyboardShortcut(.return, modifiers: .command).buttonStyle(.borderedProminent)
                    .disabled(model.editText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }
}

struct ChatMessageView: View, Equatable {
    enum Highlight: Equatable { case none, match, current }
    let model: AssistantChatModel
    let message: AssistantMessage
    let scale: Double
    let editing: Bool
    let editable: Bool
    let canRegenerate: Bool
    let speaking: Bool
    let highlight: Highlight
    @Environment(\.colorScheme) private var colorScheme
    @State private var hovered = false
    private var user: Bool { message.role == "user" }

    static func == (a: Self, b: Self) -> Bool {
        a.message == b.message && a.scale == b.scale && a.editing == b.editing && a.editable == b.editable &&
            a.canRegenerate == b.canRegenerate && a.speaking == b.speaking && a.highlight == b.highlight
    }

    var body: some View {
        if message.role == "note" {
            Label(message.text, systemImage: "arrow.turn.down.right").font(.system(size: 12 * scale)).foregroundStyle(.secondary)
                .padding(.horizontal, 12).padding(.vertical, 4).frame(maxWidth: .infinity, alignment: .leading)
        } else { bubble }
    }

    private var bubble: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 7) {
                Image(systemName: user ? (message.command ? "command" : "person.crop.circle") : "waveform.circle.fill")
                    .foregroundStyle(user ? Color.secondary : Color.accentColor)
                Text(user ? "You" : (message.speaker ?? "Hermes")).font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
                if hovered, message.date > .distantPast {
                    Text(message.date, format: .dateTime.hour().minute()).font(.system(size: 11)).foregroundStyle(.tertiary)
                }
                Spacer()
                actions.opacity(hovered || speaking ? 1 : 0).allowsHitTesting(hovered || speaking)
            }
            if editing { ChatEditBox(model: model) }
            else if user {
                Text(message.text).font(.system(size: 14 * scale)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            } else {
                if !message.thought.isEmpty { ChatThoughtView(thought: message.thought, seconds: message.thoughtSeconds, scale: scale) }
                if !message.text.isEmpty {
                    Markdown(AssistantMath.markdown(message.text)).markdownTheme(ChatTheme.scaled(scale))
                        .markdownImageProvider(ChatImageProvider())
                        .markdownInlineImageProvider(ChatInlineImageProvider(dark: colorScheme == .dark))
                        .textSelection(.enabled)
                        .environment(\.openURL, OpenURLAction { url in
                            guard ["https", "http"].contains(url.scheme?.lowercased() ?? "") else { return .discarded }
                            NSWorkspace.shared.open(url); return .handled
                        })
                }
            }
            if !message.attachments.isEmpty {
                FlowRow(spacing: 6) { ForEach(message.attachments) { AttachmentChip(attachment: $0) } }
            }
            ForEach(Array(message.images.enumerated()), id: \.offset) { _, source in ChatImage(source: source) }
            if message.stopped {
                Label("Stopped. Completed actions were not undone.", systemImage: "stop.circle").font(.system(size: 11.5)).foregroundStyle(.secondary)
            }
            if message.failed {
                HStack(spacing: 10) {
                    Label("Request failed; not automatically retried.", systemImage: "exclamationmark.triangle").foregroundStyle(.secondary)
                    if canRegenerate { Button("Retry") { model.actions?.regenerate() } }
                }.font(.system(size: 11.5))
            }
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(user ? Color.primary.opacity(0.045) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
            .overlay {
                if highlight != .none {
                    RoundedRectangle(cornerRadius: 8).strokeBorder(Color.yellow.opacity(highlight == .current ? 0.9 : 0.35), lineWidth: highlight == .current ? 2 : 1)
                }
            }
            .contentShape(Rectangle())
            .onHover { hovered = $0 }
            .contextMenu { menu }
    }

    @ViewBuilder private var actions: some View {
        HStack(spacing: 10) {
            if !message.text.isEmpty {
                icon("doc.on.doc", "Copy message") { model.copy(message.text); model.status = "Copied message" }
            }
            if user, editable, message.isTurn { icon("pencil", "Edit and resend") { model.beginEdit(message) } }
            if !user, !message.text.isEmpty {
                icon(speaking ? "stop.circle" : "speaker.wave.2", speaking ? "Stop reading" : "Read aloud") { model.speak(message) }
            }
            if !user, canRegenerate { icon("arrow.clockwise", "Regenerate (⌘R)") { model.actions?.regenerate() } }
            if !user, editable { icon("arrow.triangle.branch", "Branch into a new conversation") { model.actions?.branch(message.id) } }
        }
    }

    @ViewBuilder private var menu: some View {
        if !message.text.isEmpty { Button("Copy") { model.copy(message.text) } }
        if user, editable, message.isTurn { Button("Edit and Resend") { model.beginEdit(message) } }
        if !user, canRegenerate { Button("Regenerate") { model.actions?.regenerate() } }
        if !user, editable { Button("Branch into New Conversation") { model.actions?.branch(message.id) } }
        if !user, !message.text.isEmpty { Button(speaking ? "Stop Reading" : "Read Aloud") { model.speak(message) } }
    }

    private func icon(_ symbol: String, _ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: symbol).font(.system(size: 12)) }
            .buttonStyle(.plain).foregroundStyle(.secondary).help(title).accessibilityLabel(title)
    }
}

/// Wrapping horizontal layout for chips.
struct FlowRow: Layout {
    var spacing: CGFloat = 6
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width { y += line + spacing; x = 0; line = 0 }
            x += size.width + spacing; line = max(line, size.height); widest = max(widest, x - spacing)
        }
        return CGSize(width: min(widest, width), height: y + line)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX { y += line + spacing; x = bounds.minX; line = 0 }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing; line = max(line, size.height)
        }
    }
}
