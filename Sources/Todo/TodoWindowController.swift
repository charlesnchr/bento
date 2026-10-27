import AppKit
import Combine
import SwiftUI
import BentoCore

/// The todo window: a titled panel hosting the SwiftUI views. List keys go through a
/// local key monitor (only while the window is visible) so single-letter Todoist
/// bindings work without a text field; text fields get their keys untouched.
final class TodoWindowController: NSObject, NSWindowDelegate {
    let panel: NSPanel
    private unowned let controller: TodoController
    private var keyMonitor: Any?
    private var sidebarSub: AnyCancellable?

    init(controller: TodoController) {
        self.controller = controller
        panel = KeyablePanel(contentRect: NSRect(x: 0, y: 0, width: 860, height: 600),
                             styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView],
                             backing: .buffered, defer: true)
        super.init()
        panel.title = "Todo"
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.becomesKeyOnlyIfNeeded = false
        panel.tabbingMode = .disallowed
        panel.delegate = self
        panel.contentView = NSHostingView(rootView: TodoRootView(c: controller))
        panel.center()
        panel.setFrameAutosaveName("BentoTodoWindow")
        sidebarSub = controller.$sidebarVisible.removeDuplicates().sink { [weak self] in self?.fitMinWidth(sidebar: $0) }
    }

    /// Hiding the sidebar lets the window go narrower; showing it again widens the
    /// window up to the minimum if it is now narrower, shifting left to stay on screen.
    private func fitMinWidth(sidebar: Bool) {
        let min = NSSize(width: TodoStyle.minWidth(sidebar: sidebar), height: TodoStyle.minHeight)
        panel.contentMinSize = min
        var f = panel.frame
        let content = panel.contentRect(forFrameRect: f)
        guard content.width < min.width else { return }
        f.size.width += min.width - content.width
        if let screen = panel.screen?.visibleFrame, f.maxX > screen.maxX { f.origin.x = max(screen.minX, screen.maxX - f.width) }
        panel.setFrame(f, display: true, animate: false)
    }

    func apply(_ s: TodoSettings) {
        panel.level = s.floatOnTop ? .floating : .normal
        panel.collectionBehavior = s.floatOnTop ? [.canJoinAllSpaces, .fullScreenAuxiliary] : [.moveToActiveSpace, .fullScreenAuxiliary]
    }

    var isVisible: Bool { panel.isVisible && !AppActivation.isOrderingOut(panel) }
    var isKey: Bool { panel.isKeyWindow }

    func show() {
        AppActivation.show(panel)
        installKeyMonitor()
        if controller.editor == nil, controller.picker == nil, controller.search == nil { focusList() }
    }

    /// `app`: hand focus to it (see `AppActivation.orderOut`).
    func hide(activating app: NSRunningApplication? = nil) {
        AppActivation.orderOut(panel, activating: app)
        removeKeyMonitor()
    }

    func close() {
        hide()
        panel.contentView = nil
    }

    /// Takes focus away from any text field so list keys apply.
    func focusList() {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.panel.firstResponder is NSTextView else { return }
            self.panel.makeFirstResponder(nil)
        }
    }

    func windowDidResignKey(_ n: Notification) {
        BentoLog.make("todo").debug("window resigned key; first responder \(String(describing: self.panel.firstResponder), privacy: .public)")
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        controller.hideWindow()
        return false
    }

    private func installKeyMonitor() {
        guard keyMonitor == nil else { return }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            guard let self, e.window === self.panel else { return e }
            if self.panel.firstResponder is NSTextView { return e }
            return self.controller.handleKey(e) ? nil : e
        }
    }

    private func removeKeyMonitor() {
        if let m = keyMonitor { NSEvent.removeMonitor(m) }
        keyMonitor = nil
        controller.keys.reset()
    }
}

/// System material behind the sidebar and overlays.
struct VisualEffect: NSViewRepresentable {
    var material: NSVisualEffectView.Material
    var blending: NSVisualEffectView.BlendingMode = .behindWindow

    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = material
        v.blendingMode = blending
        v.state = .followsWindowActiveState
        return v
    }

    func updateNSView(_ v: NSVisualEffectView, context: Context) {
        v.material = material
        v.blendingMode = blending
    }
}
