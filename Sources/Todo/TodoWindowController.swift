import AppKit
import SwiftUI
import BentoCore

/// The todo window: a titled panel hosting the SwiftUI views. List keys go through a
/// local key monitor (only while the window is visible) so single-letter Todoist
/// bindings work without a text field; text fields get their keys untouched.
final class TodoWindowController: NSObject, NSWindowDelegate {
    let panel: NSPanel
    private unowned let controller: TodoController
    private var keyMonitor: Any?

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
        panel.minSize = NSSize(width: 520, height: 360)
        panel.delegate = self
        panel.contentView = NSHostingView(rootView: TodoRootView(c: controller))
        panel.center()
        panel.setFrameAutosaveName("BentoTodoWindow")
    }

    func apply(_ s: TodoSettings) {
        panel.level = s.floatOnTop ? .floating : .normal
        panel.collectionBehavior = s.floatOnTop ? [.canJoinAllSpaces, .fullScreenAuxiliary] : [.moveToActiveSpace, .fullScreenAuxiliary]
    }

    var isVisible: Bool { panel.isVisible }
    var isKey: Bool { panel.isKeyWindow }

    func show() {
        AppActivation.activateSelf()
        panel.makeKeyAndOrderFront(nil)
        panel.orderFrontRegardless()
        installKeyMonitor()
        if controller.editor == nil, controller.picker == nil, controller.search == nil { focusList() }
    }

    func hide() {
        panel.orderOut(nil)
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
