import AppKit
import VoiceCore
import BentoCore
import SwiftUI

/// The meeting recorder's only on-screen presence: a small glass capsule that
/// stays out of the way for an hour. At rest it is a dot, a timer and a faint
/// meter; hover opens it into the latest line and the controls. It never takes
/// focus, joins every Space, and stays where it was last dragged.
@MainActor
final class MeetingWidgetController {
    static let panelSize = NSSize(width: 440, height: 46)
    private static let originKey = "meetingWidgetOrigin"

    private let panel: NSPanel
    private let model = MeetingWidgetModel()
    private var dragStartMouse: NSPoint?
    private var dragStartOrigin: NSPoint?

    private final class Panel: NSPanel {
        override var canBecomeKey: Bool { false }
        override var canBecomeMain: Bool { false }
    }

    /// A non-key panel otherwise spends the first click activating itself.
    private final class FirstClickHostingView<Content: View>: NSHostingView<Content> {
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    }

    init(controller: MeetingController) {
        panel = Panel(
            contentRect: NSRect(origin: .zero, size: Self.panelSize),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.acceptsMouseMovedEvents = true
        panel.contentView = FirstClickHostingView(rootView: MeetingWidgetView(
            controller: controller,
            recorder: controller.recorder,
            model: model,
            onDrag: { [weak self] in self?.dragChanged() },
            onDragEnd: { [weak self] in self?.dragEnded() }
        ))
    }

    func show() {
        if !panel.isVisible { place() }
        panel.orderFrontRegardless()
    }

    func hide() {
        panel.orderOut(nil)
    }

    // MARK: - Placement

    /// Where it was left, if that is still on a screen; otherwise top-right,
    /// tucked under the menu bar near Bento's status item.
    private func place() {
        if let raw = UserDefaults.standard.string(forKey: Self.originKey) {
            let origin = NSPointFromString(raw)
            let frame = NSRect(origin: origin, size: Self.panelSize)
            if NSScreen.screens.contains(where: { $0.visibleFrame.contains(NSPoint(x: frame.midX, y: frame.midY)) }) {
                panel.setFrameOrigin(origin)
                model.anchorTrailing = UserDefaults.standard.object(forKey: Self.originKey + "Trailing") as? Bool ?? true
                return
            }
        }
        guard let visible = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame else { return }
        panel.setFrameOrigin(NSPoint(x: visible.maxX - Self.panelSize.width - 8,
                                     y: visible.maxY - Self.panelSize.height - 2))
        model.anchorTrailing = true
    }

    private func dragChanged() {
        let mouse = NSEvent.mouseLocation
        if dragStartMouse == nil {
            dragStartMouse = mouse
            dragStartOrigin = panel.frame.origin
        }
        guard let start = dragStartMouse, let origin = dragStartOrigin else { return }
        panel.setFrameOrigin(NSPoint(x: origin.x + mouse.x - start.x, y: origin.y + mouse.y - start.y))
    }

    /// The capsule hugs whichever panel edge faces the middle of the screen, so
    /// hovering grows it inward. Dropping it across the middle flips that edge;
    /// the panel is moved to compensate, so the capsule stays exactly where it
    /// was let go.
    private func dragEnded() {
        dragStartMouse = nil
        dragStartOrigin = nil
        let size = Self.panelSize
        let width = min(model.capsuleWidth, size.width)
        var origin = panel.frame.origin
        let capsuleMinX = model.anchorTrailing ? origin.x + size.width - width : origin.x
        let center = NSPoint(x: capsuleMinX + width / 2, y: origin.y + size.height / 2)
        guard let visible = (NSScreen.screens.first(where: { $0.frame.contains(center) }) ?? NSScreen.main)?.visibleFrame else {
            return
        }
        let trailing = center.x > visible.midX
        let clampedMinX = min(max(capsuleMinX, visible.minX + 4), visible.maxX - width - 4)
        origin.x = trailing ? clampedMinX + width - size.width : clampedMinX
        origin.y = min(max(origin.y, visible.minY), visible.maxY - size.height)
        model.anchorTrailing = trailing
        panel.setFrameOrigin(origin)
        UserDefaults.standard.set(NSStringFromPoint(origin), forKey: Self.originKey)
        UserDefaults.standard.set(trailing, forKey: Self.originKey + "Trailing")
    }
}

@MainActor
final class MeetingWidgetModel: ObservableObject {
    @Published var anchorTrailing = true
    /// Measured, so a drag can keep the capsule — not the panel — in place.
    @Published var capsuleWidth: CGFloat = 110
}

private struct CapsuleWidthKey: PreferenceKey {
    static let defaultValue: CGFloat = 110
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

struct MeetingWidgetView: View {
    @ObservedObject var controller: MeetingController
    @ObservedObject var recorder: MeetingRecorder
    @ObservedObject var model: MeetingWidgetModel
    let onDrag: () -> Void
    let onDragEnd: () -> Void

    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 0) {
            if model.anchorTrailing { Spacer(minLength: 0) }
            capsule
            if !model.anchorTrailing { Spacer(minLength: 0) }
        }
        .frame(width: MeetingWidgetController.panelSize.width, height: MeetingWidgetController.panelSize.height)
        .onPreferenceChange(CapsuleWidthKey.self) { model.capsuleWidth = $0 }
    }

    private var expanded: Bool { hovering && recorder.phase != .idle }

    private var capsule: some View {
        content
            .padding(.horizontal, expanded ? VoiceUI.Spacing.s : 10)
            .frame(height: 30)
            .background(GeometryReader { Color.clear.preference(key: CapsuleWidthKey.self, value: $0.size.width) })
            .clipShape(Capsule())
            .gtGlassCapsule()
            .contentShape(Capsule())
            .onHover { inside in
                withAnimation(reduceMotion ? .linear(duration: 0.12) : JotMotion.defaultSpatial) { hovering = inside }
            }
            .onTapGesture { controller.openNotes() }
            .gesture(
                DragGesture(minimumDistance: 3)
                    .onChanged { _ in onDrag() }
                    .onEnded { _ in onDragEnd() }
            )
            .help(helpText)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(accessibilityText)
    }

    @ViewBuilder
    private var content: some View {
        if recorder.phase == .idle {
            if let finished = controller.justFinished {
                ReadyLabel(processor: finished)
            } else if let processor = controller.finishing.last {
                FinishingLabel(processor: processor)
            }
        } else {
            HStack(spacing: VoiceUI.Spacing.xs) {
                StatusDot(color: dotColor, pulsing: recorder.phase == .recording && !reduceMotion)
                Text(MeetingDocument.timestamp(recorder.elapsed))
                    .font(VoiceUI.TypeScale.numeric())
                    .foregroundStyle(recorder.phase == .paused ? VoiceUI.Colors.onSurfaceVariant : VoiceUI.Colors.onSurface)
                if expanded {
                    Text(line)
                        .font(VoiceUI.TypeScale.labelSmall())
                        .foregroundStyle(VoiceUI.Colors.onSurfaceVariant)
                        .lineLimit(1)
                        .truncationMode(.head)
                        .frame(width: 210, alignment: .leading)
                        .animation(nil, value: line)
                        .transition(.opacity)
                    WidgetIconButton(symbol: "text.alignleft", label: "Open meeting notes") { controller.openNotes() }
                    WidgetIconButton(symbol: recorder.phase == .paused ? "play.fill" : "pause.fill",
                                     label: recorder.phase == .paused ? "Resume recording" : "Pause recording") {
                        controller.pauseOrResume()
                    }
                    StopButton { controller.stop() }
                } else if recorder.phase == .paused {
                    Text("Paused")
                        .font(VoiceUI.TypeScale.labelSmall())
                        .foregroundStyle(VoiceUI.Colors.onSurfaceVariant)
                } else if recorder.micMuted {
                    Image(systemName: "mic.slash.fill")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(VoiceUI.Colors.onSurfaceVariant)
                        .help("Your dictation or assistant call is being kept out of the meeting notes")
                } else {
                    MiniMeter(level: recorder.level)
                }
            }
        }
    }

    private var dotColor: Color {
        if recorder.phase == .paused { return VoiceUI.Colors.onSurfaceVariant.opacity(0.55) }
        switch recorder.connection {
        case .connecting, .reconnecting: return VoiceUI.Colors.gYellow
        case .live, .unavailable: return VoiceUI.Colors.gRed
        }
    }

    private var line: String {
        if recorder.phase == .paused { return "Paused — nothing is being recorded" }
        if recorder.micMuted { return "Dictating — kept out of the notes" }
        switch recorder.connection {
        case .connecting where recorder.latestLine.isEmpty: return "Connecting…"
        case .reconnecting: return "Reconnecting — still recording"
        case .unavailable where recorder.latestLine.isEmpty: return "Recording — transcribed every few minutes"
        default: return recorder.latestLine.isEmpty ? "Listening…" : recorder.latestLine
        }
    }

    private var helpText: String {
        recorder.phase == .idle
            ? "Click to open the meeting notes"
            : "Recording a meeting — click for notes, drag to move." + (MeetingShortcut.display.map { " \($0) stops." } ?? "")
    }

    private var accessibilityText: String {
        switch recorder.phase {
        case .idle: return "Meeting notes"
        case .paused: return "Meeting recording paused"
        case .recording: return "Recording meeting, \(MeetingDocument.timestamp(recorder.elapsed))"
        }
    }
}

// MARK: - Pieces

/// Breathes slowly while recording — present, never insistent.
private struct StatusDot: View {
    let color: Color
    let pulsing: Bool

    var body: some View {
        if pulsing {
            TimelineView(.animation(minimumInterval: 1.0 / 15)) { context in
                let phase = (sin(context.date.timeIntervalSinceReferenceDate * .pi / 1.3) + 1) / 2
                dot.opacity(0.45 + 0.55 * phase)
            }
        } else {
            dot
        }
    }

    private var dot: some View {
        Circle().fill(color).frame(width: 7, height: 7)
    }
}

/// Three hairline bars: enough to show the mic is hearing the room.
private struct MiniMeter: View {
    let level: Float

    var body: some View {
        HStack(alignment: .center, spacing: 2) {
            ForEach(Array([0.55, 1.0, 0.7].enumerated()), id: \.offset) { _, weight in
                Capsule()
                    .fill(VoiceUI.Colors.onSurfaceVariant.opacity(0.7))
                    .frame(width: 2, height: 2 + 9 * CGFloat(min(1, Double(level) * weight * 1.6)))
            }
        }
        .frame(width: 12, height: 12)
        .animation(JotMotion.fastSpatial, value: level)
        .accessibilityHidden(true)
    }
}

private struct WidgetIconButton: View {
    let symbol: String
    let label: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(VoiceUI.Colors.onSurface)
                .frame(width: 22, height: 22)
                .background(Circle().fill(VoiceUI.Colors.onSurface.opacity(hovering ? VoiceUI.StateLayer.hover : 0)))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(label)
        .accessibilityLabel(label)
    }
}

private struct StopButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle().fill(VoiceUI.Colors.gRed)
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(Color.white)
                    .frame(width: 7, height: 7)
            }
            .frame(width: 22, height: 22)
        }
        .buttonStyle(.plain)
        .help("Stop recording and finish the notes")
        .accessibilityLabel("Stop recording and finish the notes")
    }
}

private struct FinishingLabel: View {
    @ObservedObject var processor: MeetingProcessor

    var body: some View {
        HStack(spacing: VoiceUI.Spacing.xs) {
            ProgressView()
                .controlSize(.mini)
            Text(processor.step ?? "Finishing notes…")
                .font(VoiceUI.TypeScale.labelSmall())
                .foregroundStyle(VoiceUI.Colors.onSurfaceVariant)
                .fixedSize()
        }
    }
}

private struct ReadyLabel: View {
    @ObservedObject var processor: MeetingProcessor

    var body: some View {
        HStack(spacing: VoiceUI.Spacing.xs) {
            Image(systemName: "checkmark")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(VoiceUI.Colors.success)
            Text("Notes ready")
                .font(VoiceUI.TypeScale.labelSmall())
                .foregroundStyle(VoiceUI.Colors.onSurface)
                .fixedSize()
        }
    }
}
