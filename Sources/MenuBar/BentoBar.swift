import AppKit
import SwiftUI
import BentoCore

/// The Bento Bar: a strip just below the menu bar with the hidden items'
/// images. Opening reveals the item in place and attempts Accessibility press.
/// Unavailable items require a manual click or repositioning in the menu bar.
/// Items that don't fit next to the notch are listed too.
///
/// Keyboard: ←/→ select, Return opens, Esc closes.
/// Created on show and released on close, images included.
final class BentoBar: NSObject, NSWindowDelegate {
    private unowned let controller: MenuBarController
    private var panel: KeyablePanel?
    private var model: BarModel?
    private var keyMonitor: Any?
    private var clickMonitor: Any?
    private var closeTimer: Timer?
    private var lastClosed = Date.distantPast

    init(controller: MenuBarController) {
        self.controller = controller
    }

    var isOpen: Bool { panel != nil }

    /// For `bento://debug/state`: what the bar lists and which item Return opens.
    var diagnostics: [String: Any] {
        guard let model else { return ["open": false] }
        let selected = model.items.indices.contains(model.selected) ? model.items[model.selected].key : ""
        return ["open": true, "items": model.items.map(\.key), "labels": model.items.map { $0.subtitle ?? $0.name },
                "selected": selected, "images": model.images.count]
    }

    func show(all: Bool, closingAfter: TimeInterval? = nil) {
        if isOpen { close() }
        controller.refresh { [weak self] in self?.open(all: all, closingAfter: closingAfter) }
    }

    private func open(all: Bool, closingAfter: TimeInterval?) {
        guard !controller.isArranging else { return }
        let sections = controller.sections()
        let overflow = Set(controller.overflowItems().map(\.windowID))
        let entries = controller.items.filter { item in
            guard item.isMovable || item.role == .fixed else { return false }
            switch sections[item.windowID] ?? .visible {
            case .visible: return overflow.contains(item.windowID)
            case .hidden: return true
            case .alwaysHidden: return all
            }
        }
        let model = BarModel(items: entries)
        model.activate = { [weak self] item in
            guard let self else { return }
            self.close()
            self.controller.activate(item)
        }
        self.model = model

        let p = KeyablePanel(contentRect: NSRect(x: 0, y: 0, width: 200, height: 40),
                             styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        p.title = "Bento Bar"
        p.isFloatingPanel = true
        p.level = .statusBar
        p.hidesOnDeactivate = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.isReleasedWhenClosed = false
        p.delegate = self
        // The captured images are drawn for the menu bar's appearance (it
        // follows the wallpaper on macOS 26): match it.
        p.appearance = (controller.controls.toggle ?? controller.controls.hidden)?.button?.effectiveAppearance

        let host = NSHostingView(rootView: BarView(model: model))
        host.sizingOptions = [.intrinsicContentSize]
        p.contentView = host
        panel = p
        position()
        p.orderFrontRegardless()
        p.makeKey()

        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            guard let self, e.window === self.panel else { return e }
            return self.handleKey(e) ? nil : e
        }
        clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            self?.close()
        }
        if let closingAfter {
            let t = Timer(timeInterval: closingAfter, repeats: false) { [weak self] _ in self?.close() }
            RunLoop.main.add(t, forMode: .common)
            closeTimer = t
        }
        ItemImages.capture(entries) { [weak model] images in model?.images = images }
        controller.syncChangeWatcher()
        controller.notify()
    }

    /// Right-aligned under the chevron (or the right end of the menu bar).
    private func position() {
        guard let p = panel, let screen = controller.menuBarScreen() else { return }
        p.contentView?.layoutSubtreeIfNeeded()
        var size = p.contentView?.fittingSize ?? NSSize(width: 200, height: 40)
        size.width = min(max(size.width, 120), screen.frame.width - 16)
        let anchor = (controller.controls.toggle ?? controller.controls.hidden)?.button?.window?.frame
        var right = screen.frame.maxX - 8
        if let anchor, anchor.width < 1000, screen.frame.intersects(anchor) { right = min(anchor.maxX + 8, right) }
        let top = screen.visibleFrame.maxY - 6
        p.setFrame(NSRect(x: max(screen.frame.minX + 8, right - size.width), y: top - size.height,
                          width: size.width, height: size.height), display: true)
    }

    func close() {
        guard let p = panel else { return }
        panel = nil
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        if let clickMonitor { NSEvent.removeMonitor(clickMonitor) }
        keyMonitor = nil
        clickMonitor = nil
        closeTimer?.invalidate()
        closeTimer = nil
        p.delegate = nil
        p.orderOut(nil)
        p.contentView = nil
        model = nil
        lastClosed = Date()
        controller.syncChangeWatcher()
        controller.notify()
    }

    /// Closed a moment ago: a click on the chevron first takes the bar's key
    /// status (closing it) and must not open it again on mouse-up.
    var closedJustNow: Bool { Date().timeIntervalSince(lastClosed) < 0.4 }

    func windowDidResignKey(_ notification: Notification) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let p = self.panel, !p.isKeyWindow else { return }
            self.close()
        }
    }

    private func handleKey(_ e: NSEvent) -> Bool {
        guard let model else { return false }
        let mods = e.modifierFlags.intersection([.command, .option, .control, .shift])
        switch (e.keyCode, mods) {
        case (123, _), (48, [.shift]): model.select(-1)               // ← ⇧⇥
        case (124, _), (48, []): model.select(1)                      // → ⇥
        case (36, []), (76, []), (49, []): model.activateSelected()
        case (53, _), (13, [.command]): close()                       // Esc ⌘W
        default: return false
        }
        return true
    }
}

final class BarModel: ObservableObject {
    let items: [MenuBarItem]
    @Published var images: [CGWindowID: NSImage] = [:]
    @Published var selected = 0
    var activate: (MenuBarItem) -> Void = { _ in }

    init(items: [MenuBarItem]) {
        self.items = items
        selected = max(0, items.count - 1)
    }

    func select(_ delta: Int) {
        guard !items.isEmpty else { return }
        selected = (selected + delta + items.count) % items.count
    }

    func activateSelected() {
        guard items.indices.contains(selected) else { return }
        activate(items[selected])
    }
}

private struct BarView: View {
    @ObservedObject var model: BarModel

    var body: some View {
        HStack(spacing: 2) {
            if model.items.isEmpty {
                Text("No hidden items")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 10)
            }
            ForEach(Array(model.items.enumerated()), id: \.element.windowID) { index, item in
                BarItemButton(item: item, image: model.images[item.windowID], selected: index == model.selected) {
                    model.selected = index
                    model.activate(item)
                }
            }
        }
        .padding(.horizontal, 6)
        .frame(height: 34)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(.separator.opacity(0.6), lineWidth: 0.5))
        .padding(1)
        .fixedSize()
    }
}

private struct BarItemButton: View {
    let item: MenuBarItem
    let image: NSImage?
    let selected: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        content
            .frame(height: 26)
            .padding(.horizontal, 3)
            .background(RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(Color.primary.opacity(hovering ? 0.14 : selected ? 0.09 : 0)))
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous)
                .strokeBorder(Color.accentColor.opacity(selected ? 0.8 : 0), lineWidth: 1.5))
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
            .onTapGesture { action() }
            .help(item.subtitle.map { "\(item.name) — \($0)" } ?? item.name)
            .accessibilityElement()
            .accessibilityLabel(item.name)
            .accessibilityAddTraits(.isButton)
    }

    @ViewBuilder private var content: some View {
        if let image {
            Image(nsImage: image)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .frame(width: image.size.width * 26 / max(image.size.height, 1))
        } else if let icon = ItemImages.appIcon(for: item) {
            Image(nsImage: icon).resizable().frame(width: 18, height: 18).padding(.horizontal, 6)
        } else {
            Image(systemName: "questionmark.square.dashed").frame(width: 30)
        }
    }
}
