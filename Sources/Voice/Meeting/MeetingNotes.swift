import AppKit
import VoiceCore
import BentoCore
import SwiftUI

/// A meeting's notes as they are being written: title, summary once there is
/// one, and the transcript — cleaned paragraphs in full colour, words not yet
/// cleaned a step quieter, and the sentence in progress quieter still.
struct MeetingNotesView: View {
    @ObservedObject var processor: MeetingProcessor
    let controller: MeetingController
    /// Deliberately not observed: its meter publishes ~10Hz, and an hour of
    /// transcript should not re-render for that. The two values this view needs
    /// are mirrored into state below; the timer observes it on its own.
    let recorder: MeetingRecorder

    @State private var phase: MeetingRecorder.Phase = .idle
    @State private var interim = ""
    @State private var title = ""
    @FocusState private var titleFocused: Bool
    @State private var follow = true
    @Environment(\.colorScheme) private var scheme
    private var grad: CGFloat { scheme == .dark ? 25 : 0 }
    private let bottom = "bottom"

    private var document: MeetingDocument { processor.document }
    private var isRecording: Bool { phase != .idle && recorder.processor === processor }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: VoiceUI.Spacing.l) {
                        header
                        summary
                        transcript
                        Color.clear.frame(height: 1).id(bottom)
                    }
                    .padding(.horizontal, VoiceUI.Spacing.xxl)
                    .padding(.top, VoiceUI.Spacing.xxl)
                    .padding(.bottom, VoiceUI.Spacing.l)
                    .frame(maxWidth: 760, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
                .onChange(of: transcriptVersion) { _, _ in
                    guard isRecording, follow else { return }
                    withAnimation(JotMotion.defaultEffects) { proxy.scrollTo(bottom, anchor: .bottom) }
                }
                .onAppear {
                    if isRecording { proxy.scrollTo(bottom, anchor: .bottom) }
                }
            }
            Divider()
            footer
        }
        .onAppear { title = document.meta.title ?? "" }
        .onChange(of: document.meta.title) { _, newValue in
            if !titleFocused { title = newValue ?? "" }
        }
        .onReceive(recorder.$phase) { phase = $0 }
        .onReceive(recorder.$interim.removeDuplicates()) { interim = $0 }
    }

    private var transcriptVersion: Int {
        document.transcript.segments.count &+ document.transcript.blocks.count &* 31 &+ interim.count
    }

    private func commitTitle() {
        if title != (document.meta.title ?? "") { processor.rename(title) }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: VoiceUI.Spacing.xxs) {
            TextField(document.displayTitle, text: $title)
                .font(VoiceUI.TypeScale.headline(grad: grad))
                .textFieldStyle(.plain)
                .focused($titleFocused)
                .onSubmit(commitTitle)
                .onChange(of: titleFocused) { _, focused in
                    if !focused { commitTitle() }
                }
            HStack(spacing: VoiceUI.Spacing.xs) {
                Text(document.meta.startedAt.formatted(date: .abbreviated, time: .shortened))
                Text("·")
                if isRecording {
                    ElapsedLabel(recorder: recorder)
                } else {
                    Text(MeetingDocument.timestamp(document.meta.durationSeconds)).monospacedDigit()
                }
                if document.meta.parts.contains(where: \.hasSystemAudio) {
                    Text("·")
                    Text("Mic + system audio")
                }
                statusChip
            }
            .font(VoiceUI.TypeScale.labelSmall(grad: grad))
            .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var statusChip: some View {
        if isRecording {
            chip(phase == .paused ? "Paused" : "Recording",
                 color: phase == .paused ? .secondary : VoiceUI.Colors.gRed)
        } else if let step = processor.step {
            chip(step, color: VoiceUI.Colors.primary)
        } else if document.meta.failedChunkCount + document.meta.pendingBatchCount > 0 {
            chip("Some audio not transcribed", color: Color(nsColor: .systemOrange))
        }
    }

    private func chip(_ text: String, color: Color) -> some View {
        Text(text)
            .font(VoiceUI.TypeScale.labelSmall(grad: grad))
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Capsule().fill(color.opacity(0.12)))
    }

    // MARK: - Summary

    @ViewBuilder
    private var summary: some View {
        if let summary = document.meta.summary {
            VStack(alignment: .leading, spacing: VoiceUI.Spacing.s) {
                if !summary.overview.isEmpty {
                    section("Summary") { bullets(summary.overview) }
                }
                if !summary.decisions.isEmpty {
                    section("Decisions") { bullets(summary.decisions) }
                }
                if !summary.actionItems.isEmpty {
                    section("Action items") {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(Array(summary.actionItems.enumerated()), id: \.offset) { _, item in
                                HStack(alignment: .firstTextBaseline, spacing: VoiceUI.Spacing.xs) {
                                    Image(systemName: "circle")
                                        .font(.system(size: 9, weight: .semibold))
                                        .foregroundStyle(.secondary)
                                    // The variable font ignores fontWeight; ask for the axis.
                                    (Text(item.owner.map { "\($0)  " } ?? "").font(GTFont.flex(14, weight: 650, grad: grad))
                                        + Text(item.task)
                                        + Text(item.due.map { "  · \($0)" } ?? "").foregroundColor(.secondary))
                                        .font(VoiceUI.TypeScale.body(grad: grad))
                                }
                            }
                        }
                    }
                }
            }
            .textSelection(.enabled)
            .padding(VoiceUI.Spacing.m)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: VoiceUI.Radius.medium).fill(VoiceUI.Colors.surfaceContainer))
        } else if processor.step == "Writing the summary…" {
            Label("Writing the summary…", systemImage: "sparkles")
                .font(VoiceUI.TypeScale.labelSmall(grad: grad))
                .foregroundStyle(.secondary)
        } else if let error = document.meta.summaryError, !isRecording {
            Label("No summary — \(error.lowercased())", systemImage: "exclamationmark.circle")
                .font(VoiceUI.TypeScale.labelSmall(grad: grad))
                .foregroundStyle(.secondary)
        }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased())
                .font(VoiceUI.TypeScale.labelSmall(grad: grad))
                .tracking(0.6)
                .foregroundStyle(.secondary)
            content()
        }
    }

    private func bullets(_ items: [String]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: VoiceUI.Spacing.xs) {
                    Text("•").foregroundStyle(.secondary)
                    Text(item)
                }
                .font(VoiceUI.TypeScale.body(grad: grad))
            }
        }
    }

    // MARK: - Transcript

    private var transcript: some View {
        // Lazy: a two-hour meeting is hundreds of paragraphs.
        LazyVStack(alignment: .leading, spacing: VoiceUI.Spacing.s) {
            let paragraphs = document.paragraphs
            if paragraphs.isEmpty, interim.isEmpty || !isRecording {
                Text(isRecording ? "Listening — words appear here as people speak." : "Nothing was transcribed.")
                    .font(VoiceUI.TypeScale.body(grad: grad))
                    .foregroundStyle(.secondary)
            }
            ForEach(paragraphs) { paragraph in
                row(start: paragraph.start) { paragraphText(paragraph) }
            }
            if isRecording, !interim.isEmpty {
                row(start: nil) {
                    Text(interim)
                        .font(VoiceUI.TypeScale.bodyLarge(grad: grad))
                        .foregroundStyle(.tertiary)
                        .italic()
                }
            }
        }
        .textSelection(.enabled)
    }

    private func row<Content: View>(start: Double?, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: VoiceUI.Spacing.s) {
            Text(start.map(MeetingDocument.timestamp) ?? "")
                .font(VoiceUI.TypeScale.numeric(grad: grad))
                .foregroundStyle(.tertiary)
                .frame(width: 48, alignment: .trailing)
            content()
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private func paragraphText(_ paragraph: MeetingParagraph) -> some View {
        switch paragraph.kind {
        case .cleaned:
            Text(paragraph.text)
                .font(VoiceUI.TypeScale.bodyLarge(grad: grad))
                .lineSpacing(3)
        case .pending:
            Text(paragraph.text)
                .font(VoiceUI.TypeScale.bodyLarge(grad: grad))
                .lineSpacing(3)
                .foregroundStyle(VoiceUI.Colors.onSurfaceVariant.opacity(0.85))
                .help("Not tidied yet — cleanup runs every minute or so")
        case .gap(let seconds, let failed):
            HStack(spacing: VoiceUI.Spacing.xs) {
                Image(systemName: failed ? "exclamationmark.triangle" : "waveform")
                Text(failed
                     ? "Couldn't transcribe \(MeetingDocument.timestamp(seconds)) of audio"
                     : "Transcribing \(MeetingDocument.timestamp(seconds)) of audio from the recording…")
                if failed, processor.canRetry {
                    Button("Retry") { controller.retry(processor) }
                        .buttonStyle(.link)
                }
            }
            .font(VoiceUI.TypeScale.labelSmall(grad: grad))
            .foregroundStyle(.secondary)
        }
    }

    // MARK: - Footer

    private var footer: some View {
        HStack(spacing: VoiceUI.Spacing.s) {
            Text(stats)
                .font(VoiceUI.TypeScale.labelSmall(grad: grad))
                .foregroundStyle(.secondary)
                .help("Estimated from the model's own usage reports for Live transcription and batch re-transcription. Cleanup and summary calls are small and not included.")
            Spacer()
            if isRecording {
                Toggle(isOn: $follow) { Image(systemName: "arrow.down.to.line") }
                    .toggleStyle(.button)
                    .help("Keep the newest words in view")
                Button(phase == .paused ? "Resume" : "Pause") { controller.pauseOrResume() }
                Button("Stop") { controller.stop() }
                    .keyboardShortcut(".", modifiers: .command)
            } else if processor.canRetry {
                Button("Retry") { controller.retry(processor) }
                    .help("Transcribe the audio that's still missing and redo the summary")
            }
            Button {
                let pasteboard = NSPasteboard.general
                pasteboard.clearContents()
                pasteboard.setString(document.markdown, forType: .string)
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
            .help("Copy the notes as Markdown")
            Button {
                NSWorkspace.shared.activateFileViewerSelecting([MeetingStore.notesURL(in: document.folder)])
            } label: {
                Image(systemName: "folder")
            }
            .help("Show notes.md and the recording in Finder")
        }
        .controlSize(.small)
        .padding(.horizontal, VoiceUI.Spacing.m)
        .padding(.vertical, VoiceUI.Spacing.xs)
    }

    private var stats: String {
        let words = document.transcript.wordCount
        let cost = document.meta.usage.estimatedCostUSD
        return "\(words) words" + (cost >= 0.005 ? String(format: " · ≈ $%.2f", cost) : "")
    }
}

/// The running time, observing the recorder on its own so nothing else
/// re-renders twice a second.
private struct ElapsedLabel: View {
    @ObservedObject var recorder: MeetingRecorder

    var body: some View {
        Text(MeetingDocument.timestamp(recorder.elapsed)).monospacedDigit()
    }
}

/// A standalone window on one meeting's notes, opened from the widget.
@MainActor
final class MeetingNotesWindowController: NSWindowController, NSWindowDelegate {
    private let id: UUID
    private let onClose: (UUID) -> Void

    init(processor: MeetingProcessor, controller: MeetingController, onClose: @escaping (UUID) -> Void) {
        id = processor.id
        self.onClose = onClose
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 600, height: 720),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Meeting Notes"
        window.titlebarAppearsTransparent = true
        window.minSize = NSSize(width: 420, height: 360)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: MeetingNotesView(
            processor: processor, controller: controller, recorder: controller.recorder
        ))
        host.sizingOptions = [] // the window keeps the size the user gave it
        window.contentView = host
        super.init(window: window)
        window.delegate = self
        if !window.setFrameUsingName("BentoMeetingNotes") { window.center() }
        window.setFrameAutosaveName("BentoMeetingNotes")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    func present() {
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowWillClose(_ notification: Notification) {
        onClose(id)
    }
}

/// The Meetings section of the main window: every meeting, newest first, with
/// its notes beside it.
struct MeetingsPane: View {
    @ObservedObject var controller: MeetingController
    /// Not observed, for the same reason as in `MeetingNotesView`.
    let recorder: MeetingRecorder

    @State private var phase: MeetingRecorder.Phase = .idle
    @State private var selection: UUID?
    @State private var deleting: MeetingListItem?
    @State private var systemAudio = SettingsStore().meetingCaptureSystemAudio
    @State private var summaries = SettingsStore().meetingSummaryEnabled
    @State private var excludeDictation = SettingsStore().meetingExcludesDictation
    @Environment(\.colorScheme) private var scheme
    private var grad: CGFloat { scheme == .dark ? 25 : 0 }

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                listHeader
                if controller.library.isEmpty {
                    Spacer()
                    Text("No meetings yet")
                        .font(VoiceUI.TypeScale.body(grad: grad))
                        .foregroundStyle(.secondary)
                    Spacer()
                } else {
                    List(selection: $selection) {
                        ForEach(controller.library) { item in
                            row(item)
                                .tag(item.id)
                                .contextMenu {
                                    Button("Open in Window") { controller.openNotes(for: controller.processor(for: item)) }
                                    Button("Show in Finder") {
                                        NSWorkspace.shared.activateFileViewerSelecting([MeetingStore.notesURL(in: item.folder)])
                                    }
                                    Divider()
                                    Button("Delete…", role: .destructive) { deleting = item }
                                        .disabled(item.status == .recording || item.status == .paused || item.status == .finishing)
                                }
                        }
                    }
                    .listStyle(.sidebar)
                    .scrollContentBackground(.hidden)
                }
            }
            .frame(width: 250)
            Divider()
            detail
        }
        .onAppear {
            if selection == nil { selection = recorder.processor?.id ?? controller.library.first?.id }
        }
        .onReceive(recorder.$phase) { newPhase in
            // A meeting just started: show it.
            if phase == .idle, newPhase != .idle, let id = recorder.processor?.id { selection = id }
            phase = newPhase
        }
        .confirmationDialog(
            "Delete this meeting? Its notes and recording will be removed.",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            presenting: deleting
        ) { item in
            Button("Delete Meeting", role: .destructive) {
                if selection == item.id { selection = nil }
                controller.delete(item)
            }
        }
    }

    private var listHeader: some View {
        HStack(spacing: VoiceUI.Spacing.xs) {
            Button {
                controller.toggle()
            } label: {
                Label(phase == .idle ? "Record Meeting" : "Stop Recording",
                      systemImage: phase == .idle ? "record.circle" : "stop.circle")
            }
            .help(MeetingShortcut.sentence("starts and stops a meeting from anywhere"))
            Spacer()
            Menu {
                Toggle("Include system audio (the other side of calls)", isOn: $systemAudio)
                Toggle("Summarize when a meeting ends", isOn: $summaries)
                Toggle("Keep dictation out of meeting notes", isOn: $excludeDictation)
            } label: {
                Image(systemName: "gearshape")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Meeting settings")
            .onChange(of: systemAudio) { _, value in SettingsStore().setMeetingCaptureSystemAudio(value) }
            .onChange(of: summaries) { _, value in SettingsStore().setMeetingSummaryEnabled(value) }
            .onChange(of: excludeDictation) { _, value in SettingsStore().setMeetingExcludesDictation(value) }
        }
        .controlSize(.small)
        .padding(.horizontal, VoiceUI.Spacing.s)
        .padding(.top, VoiceUI.Spacing.l)
        .padding(.bottom, VoiceUI.Spacing.xs)
    }

    private func row(_ item: MeetingListItem) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                if item.status == .recording || item.status == .paused {
                    Circle()
                        .fill(item.status == .recording ? VoiceUI.Colors.gRed : Color.secondary)
                        .frame(width: 6, height: 6)
                }
                Text(item.title)
                    .font(VoiceUI.TypeScale.body(grad: grad))
                    .lineLimit(1)
            }
            HStack(spacing: 4) {
                Text(item.startedAt.formatted(date: .abbreviated, time: .shortened))
                if item.durationSeconds > 0 {
                    Text("·")
                    Text(MeetingDocument.timestamp(item.durationSeconds)).monospacedDigit()
                }
                if item.needsAttention, item.status == .complete {
                    Text("·")
                    Text("Needs retry").foregroundStyle(Color(nsColor: .systemOrange))
                } else if item.status == .finishing || item.status == .interrupted {
                    Text("·")
                    Text("Finishing…")
                }
            }
            .font(VoiceUI.TypeScale.labelSmall(grad: grad))
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private var detail: some View {
        if let id = selection, let item = controller.library.first(where: { $0.id == id }) {
            MeetingNotesView(processor: controller.processor(for: item), controller: controller, recorder: recorder)
                .id(item.id)
        } else if let active = recorder.processor, selection == active.id {
            MeetingNotesView(processor: active, controller: controller, recorder: recorder)
        } else {
            VStack(spacing: VoiceUI.Spacing.m) {
                Image(systemName: "person.2.wave.2")
                    .font(.system(size: 30))
                    .foregroundStyle(.secondary)
                Text("Record a meeting")
                    .font(VoiceUI.TypeScale.title(grad: grad))
                Text("Bento transcribes as people talk, tidies the text as it goes, and writes a summary when you stop."
                     + (MeetingShortcut.display.map { " Press \($0) from anywhere." } ?? ""))
                    .font(VoiceUI.TypeScale.body(grad: grad))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 360)
                Button("Record Meeting") { controller.start() }
                    .disabled(phase != .idle)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}
