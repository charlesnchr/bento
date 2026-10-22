import AppKit
import SwiftUI
import BentoCore

final class QuickAddModel: ObservableObject {
    let field = TokenFieldModel(parses: true)
    @Published var defaultProject: String?
}

/// Global Quick Add: a Spotlight-style panel that takes typing without activating
/// Bento, so the app you were in stays frontmost.
final class QuickAddController: NSObject, NSWindowDelegate {
    private unowned let controller: TodoController
    private let model = QuickAddModel()
    private var panel: KeyablePanel?
    private var openedFromWindow = false

    init(controller: TodoController) {
        self.controller = controller
        super.init()
        model.field.projects = { [weak controller] in controller?.projectNames ?? [] }
        model.field.labels = { [weak controller] in controller?.labels ?? [] }
    }

    func show(defaultProject: String?) {
        let p = panel ?? makePanel()
        panel = p
        model.defaultProject = defaultProject
        model.field.reparse()
        openedFromWindow = controller.windowController?.isKey == true
        let screen = NSScreen.main ?? NSScreen.screens[0]
        let f = screen.visibleFrame
        p.setFrame(NSRect(x: f.midX - 330, y: f.maxY - f.height * 0.22 - 360, width: 660, height: 360), display: false)
        p.makeKeyAndOrderFront(nil)
        p.orderFrontRegardless()
        model.field.focus()
    }

    func close() {
        guard let p = panel, p.isVisible else { return }
        p.orderOut(nil)
        model.field.completion = nil
        if openedFromWindow, let w = controller.windowController, w.isVisible { w.panel.makeKey() }
    }

    private func makePanel() -> KeyablePanel {
        let p = KeyablePanel(contentRect: NSRect(x: 0, y: 0, width: 660, height: 360),
                             styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView], backing: .buffered, defer: true)
        p.isFloatingPanel = true
        p.level = .modalPanel
        p.backgroundColor = .clear
        p.isOpaque = false
        p.hasShadow = false
        p.hidesOnDeactivate = false
        p.isReleasedWhenClosed = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        p.delegate = self
        p.contentView = NSHostingView(rootView: QuickAddView(model: model, field: model.field, c: controller,
                                                             submit: { [weak self] keep in self?.submit(keepOpen: keep) },
                                                             cancel: { [weak self] in self?.close() }))
        return p
    }

    func windowDidResignKey(_ n: Notification) { close() }

    private func submit(keepOpen: Bool) {
        let text = model.field.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { close(); return }
        let parsed = QuickAddParser.parse(text, projects: controller.projectNames, labels: controller.labels)
        let t = controller.createTask(parsed, defaults: .init(project: model.defaultProject))
        let where_ = controller.projectName(t.project)
        model.field.text = ""
        model.field.caret = 0
        if controller.windowController?.isVisible == true { controller.flash("Added to \(where_)") }
        if keepOpen || controller.settings.quickAddReturn == "keep" {
            model.field.focus()
        } else {
            close()
            if controller.windowController?.isVisible != true { HUD.show("Added to \(where_)", symbol: "checkmark.circle") }
        }
    }
}

struct QuickAddView: View {
    @ObservedObject var model: QuickAddModel
    @ObservedObject var field: TokenFieldModel
    let c: TodoController
    let submit: (Bool) -> Void
    let cancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: "plus.circle.fill").foregroundStyle(Color(nsColor: TodoStyle.priority(1))).font(.system(size: 17))
                TokenField(model: field, placeholder: "Buy milk tomorrow 5pm p1 #Errands @shop",
                           font: .systemFont(ofSize: 18),
                           onSubmit: { f in submit(f.contains(.command)) }, onCancel: cancel)
            }
            CompletionList(model: field, colorOf: { name in
                TodoStyle.project(c.projects.first { $0.name == name }?.color ?? "grey")
            })
            HStack {
                ParsedChips(c: c, parsed: field.parsed, defaults: .init(project: model.defaultProject), task: nil)
                Spacer()
                Text("↩ Add · ⌘↩ Add another · Esc").font(.caption).foregroundStyle(.tertiary)
            }
        }
        .padding(16)
        .background(VisualEffect(material: .hudWindow, blending: .behindWindow))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.primary.opacity(0.12)))
        .shadow(color: .black.opacity(0.3), radius: 18, y: 8)
        .padding(20)
        .frame(width: 660, height: 360, alignment: .top)
    }
}
