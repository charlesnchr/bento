// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import AppKit
import SwiftUI
import VoiceCore

/// Owns the non-activating NSPanel that hosts the pill. Fixed-size panel; the pill
/// animates its own bounds inside (avoids NSWindow frame-animation jank).
/// The panel never becomes key except transiently for the locked-state stop button.
/// Dragging the pill moves the panel; where it is dropped is remembered.
@MainActor
final class PillHUDController {
    let model = PillModel()
    private let panel: NSPanel
    /// The visible frame of the screen the pill is on, and its bottom-centre there.
    private var visible: NSRect?
    private var anchor: CGPoint?
    private var dragStartMouse: NSPoint?
    private var dragStartAnchor: CGPoint?
    private var observers: [NSObjectProtocol] = []

    init() {
        panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: PillPlacement.panelSize),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.acceptsMouseMovedEvents = true
        panel.contentView = NSHostingView(
            rootView: PillRootView(
                model: model,
                onDrag: { [weak self] in self?.dragChanged(translation: $0) },
                onDragEnd: { [weak self] in self?.dragEnded() }
            )
        )
        reposition()
        for name in [Notification.Name.pillPositionReset, NSApplication.didChangeScreenParametersNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                Task { @MainActor [weak self] in
                    if note.name == .pillPositionReset { UserDefaults.standard.removeObject(forKey: PillPlacement.defaultsKey) }
                    self?.reposition()
                }
            })
        }
    }

    func show() {
        reposition()
        panel.orderFrontRegardless()
    }

    /// Called at each session start so the pill follows the display the user is
    /// actually dictating on (audit L14 — it used to stick to the launch screen).
    func repositionToActiveScreen() {
        reposition()
    }

    func hide() {
        panel.orderOut(nil)
    }

    /// On the screen hosting the FOCUSED window — where the text will actually
    /// land — at the spot the user dragged it to, bottom-centre by default.
    /// Mouse position is only a fallback: keyboard-first users routinely
    /// dictate on one display with the pointer parked on another (production
    /// pass 2). Doesn't jump mid-session (spec §1.1).
    private func reposition() {
        let screen = Self.screenOfFocusedWindow()
            ?? NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) })
            ?? NSScreen.main
        guard let screen else { return }
        let saved = UserDefaults.standard.string(forKey: PillPlacement.defaultsKey).map(NSPointFromString)
        place(PillPlacement.anchor(relative: saved, in: screen.visibleFrame), in: screen.visibleFrame)
    }

    private func place(_ point: CGPoint, in frame: NSRect) {
        let placement = PillPlacement.panelOrigin(anchor: point, in: frame)
        visible = frame
        anchor = PillPlacement.clampedAnchor(point, in: frame)
        panel.setFrameOrigin(placement.origin)
        if model.anchorX != placement.anchorX { model.anchorX = placement.anchorX }
    }

    // MARK: - Dragging

    /// Screen coordinates, not the gesture's: the panel moves under the pointer.
    /// Only the first translation is used, before the panel has moved, to find
    /// where the press was, so the pill keeps the movement under the threshold.
    private func dragChanged(translation: CGSize) {
        let mouse = NSEvent.mouseLocation
        if dragStartMouse == nil {
            dragStartMouse = NSPoint(x: mouse.x - translation.width, y: mouse.y + translation.height)
            dragStartAnchor = anchor
        }
        guard let start = dragStartMouse, let startAnchor = dragStartAnchor else { return }
        let point = CGPoint(x: startAnchor.x + mouse.x - start.x, y: startAnchor.y + mouse.y - start.y)
        // It can be dragged onto another display; it stops at the screen's edges.
        let frame = NSScreen.screens.first(where: { $0.frame.contains(mouse) })?.visibleFrame ?? visible
        guard let frame else { return }
        place(point, in: frame)
    }

    private func dragEnded() {
        dragStartMouse = nil
        dragStartAnchor = nil
        guard let anchor, let visible else { return }
        let relative = PillPlacement.relative(anchor: anchor, in: visible)
        UserDefaults.standard.set(NSStringFromPoint(relative), forKey: PillPlacement.defaultsKey)
    }

    /// Screen hosting the frontmost app's front window, via the window list —
    /// a local syscall, never an AX round-trip into the target app. The AX
    /// version could block ~100ms per attribute on a busy app, and this runs
    /// on the key-press path where the pill must appear instantly (dogfood).
    private static func screenOfFocusedWindow() -> NSScreen? {
        guard let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier,
              let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }
        // The list is front-to-back; the first normal-layer window owned by the
        // frontmost app is its focused/front window.
        guard let info = windows.first(where: {
            ($0[kCGWindowOwnerPID as String] as? pid_t) == pid
                && (($0[kCGWindowLayer as String] as? Int) ?? 1) == 0
        }), let bounds = info[kCGWindowBounds as String] as? [String: CGFloat] else {
            return nil
        }
        let midX = (bounds["X"] ?? 0) + (bounds["Width"] ?? 0) / 2
        let midY = (bounds["Y"] ?? 0) + (bounds["Height"] ?? 0) / 2
        // Window-list coords are top-left-origin global; flip into Cocoa space.
        guard let primary = NSScreen.screens.first else { return nil }
        let cocoaPoint = NSPoint(x: midX, y: primary.frame.maxY - midY)
        return NSScreen.screens.first(where: { $0.frame.contains(cocoaPoint) })
    }
}

private struct PillRootView: View {
    @ObservedObject var model: PillModel
    let onDrag: (CGSize) -> Void
    let onDragEnd: () -> Void

    var body: some View {
        PillAnchorLayout(anchorX: model.anchorX) {
            PillView(model: model)
                // High priority so a drag cancels the Dictate/Stop button
                // underneath; a click moves less than the minimum and still
                // reaches it.
                .highPriorityGesture(
                    DragGesture(minimumDistance: 3)
                        .onChanged { onDrag($0.translation) }
                        .onEnded { _ in onDragEnd() }
                )
        }
        .padding(.bottom, PillPlacement.bottomInset)
    }
}

/// Bottom-aligns the pill on the anchor, so a state change grows it about its
/// centre, but never past the panel's sides.
private struct PillAnchorLayout: Layout {
    var anchorX: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let available = ProposedViewSize(bounds.size)
        for subview in subviews {
            let width = subview.sizeThatFits(available).width
            let x = PillPlacement.pillMinX(anchorX: anchorX, width: width, panelWidth: bounds.width)
            subview.place(at: CGPoint(x: bounds.minX + x, y: bounds.maxY), anchor: .bottomLeading, proposal: available)
        }
    }
}
