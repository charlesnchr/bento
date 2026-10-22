import AppKit
import SwiftUI

/// Text + caret of a `TokenField`, with Todoist quick-add parsing (token highlighting)
/// and #project / @label completion when `parses` is on.
final class TokenFieldModel: ObservableObject {
    struct Completion: Equatable {
        var kind: QuickAddResult.Token.Kind
        var range: NSRange
        var items: [String]
        var index = 0
    }

    @Published var text: String { didSet { if text != oldValue { reparse() } } }
    @Published private(set) var parsed: QuickAddResult?
    @Published var completion: Completion?
    /// Bumped to ask the view to take keyboard focus.
    @Published var focusRequest = 0
    var caret = 0
    let parses: Bool
    var projects: () -> [String] = { [] }
    var labels: () -> [String] = { [] }

    init(text: String = "", parses: Bool = false) {
        self.text = text
        self.parses = parses
        reparse()
    }

    func focus() { focusRequest += 1 }

    func reparse() {
        guard parses else { return }
        parsed = QuickAddParser.parse(text, projects: projects(), labels: labels())
    }

    /// Called by the view after every edit or caret move.
    func caretMoved(to c: Int) {
        caret = c
        guard parses, let ctx = QuickAddParser.completionContext(text, caret: c), ctx.kind == .project || ctx.kind == .label else {
            if completion != nil { completion = nil }
            return
        }
        let pool = ctx.kind == .project ? projects() : labels()
        let q = ctx.query.lowercased()
        var items = pool.filter { q.isEmpty || $0.lowercased().hasPrefix(q) }
        items += pool.filter { !q.isEmpty && !$0.lowercased().hasPrefix(q) && $0.lowercased().contains(q) }
        if items.count == 1, items[0].lowercased() == q { items = [] } // already complete
        let next = items.isEmpty ? nil : Completion(kind: ctx.kind, range: ctx.range, items: Array(items.prefix(8)),
                                                    index: completion?.items == Array(items.prefix(8)) ? completion!.index : 0)
        if next != completion { completion = next }
    }

    func moveCompletion(_ delta: Int) {
        guard var c = completion, !c.items.isEmpty else { return }
        c.index = (c.index + delta + c.items.count) % c.items.count
        completion = c
    }

    /// Replaces the token being typed with the chosen name. Returns the new caret.
    func acceptCompletion() -> Int? {
        guard let c = completion, c.items.indices.contains(c.index) else { return nil }
        let ns = text as NSString
        guard NSMaxRange(c.range) <= ns.length else { return nil }
        let replacement = (c.kind == .project ? "#" : "@") + c.items[c.index] + " "
        text = ns.replacingCharacters(in: c.range, with: replacement)
        completion = nil
        return c.range.location + (replacement as NSString).length
    }
}

/// A single- or multi-line text field backed by NSTextView, so it can colour quick-add
/// tokens and report Return/Escape/Tab/arrows to its owner.
struct TokenField: NSViewRepresentable {
    @ObservedObject var model: TokenFieldModel
    var placeholder = ""
    var font: NSFont = .systemFont(ofSize: 14)
    var multiline = false
    /// Return (with its modifiers); multiline fields insert a newline on ⇧↩/⌥↩.
    var onSubmit: (NSEvent.ModifierFlags) -> Void = { _ in }
    var onCancel: () -> Void = {}
    /// Tab / ⇧Tab when no completion is showing; return false to let the text view handle it.
    var onTab: ((Bool) -> Bool)? = nil
    /// ↑ (-1) / ↓ (+1) when no completion is showing; return false for the default caret move.
    var onArrow: ((Int) -> Bool)? = nil
    /// Called when the field gains or loses focus.
    var onFocus: ((Bool) -> Void)? = nil

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> TokenTextView {
        let v = TokenTextView()
        v.delegate = context.coordinator
        v.coordinator = context.coordinator
        v.isRichText = false
        v.importsGraphics = false
        v.allowsUndo = true
        v.drawsBackground = false
        v.isAutomaticQuoteSubstitutionEnabled = false
        v.isAutomaticDashSubstitutionEnabled = false
        v.isAutomaticTextReplacementEnabled = false
        v.isAutomaticSpellingCorrectionEnabled = false
        v.isContinuousSpellCheckingEnabled = false
        v.textContainerInset = NSSize(width: 0, height: 2)
        v.textContainer?.lineFragmentPadding = 0
        v.textContainer?.widthTracksTextView = true
        v.isHorizontallyResizable = false
        v.isVerticallyResizable = true
        v.setContentHuggingPriority(.defaultHigh, for: .vertical)
        v.setContentCompressionResistancePriority(.required, for: .vertical)
        v.font = font
        v.placeholder = placeholder
        v.string = model.text
        v.multiline = multiline
        context.coordinator.restyle(v)
        return v
    }

    func updateNSView(_ v: TokenTextView, context: Context) {
        context.coordinator.parent = self
        if v.string != model.text {
            let caret = min(model.caret, (model.text as NSString).length)
            v.string = model.text
            v.setSelectedRange(NSRange(location: caret, length: 0))
            v.invalidateIntrinsicContentSize()
        }
        if v.font != font { v.font = font }
        v.placeholder = placeholder
        context.coordinator.restyle(v)
        if context.coordinator.focusSeen != model.focusRequest {
            context.coordinator.focusSeen = model.focusRequest
            DispatchQueue.main.async {
                guard let w = v.window else { return }
                w.makeFirstResponder(v)
                v.setSelectedRange(NSRange(location: (v.string as NSString).length, length: 0))
            }
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: TokenField
        var focusSeen = 0

        init(_ p: TokenField) { parent = p }

        func textDidChange(_ n: Notification) {
            guard let v = n.object as? TokenTextView else { return }
            let m = parent.model
            m.caret = v.selectedRange().location
            if m.text != v.string { m.text = v.string }
            m.caretMoved(to: v.selectedRange().location)
            restyle(v)
            v.invalidateIntrinsicContentSize()
        }

        func textViewDidChangeSelection(_ n: Notification) {
            guard let v = n.object as? TokenTextView, v.window?.firstResponder === v else { return }
            parent.model.caretMoved(to: v.selectedRange().location)
        }

        func textView(_ v: NSTextView, doCommandBy sel: Selector) -> Bool {
            let m = parent.model
            let flags = NSApp.currentEvent?.modifierFlags.intersection(.deviceIndependentFlagsMask) ?? []
            switch sel {
            case #selector(NSResponder.insertNewline(_:)), #selector(NSResponder.insertLineBreak(_:)),
                 #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)):
                if m.completion != nil, let caret = m.acceptCompletion() {
                    v.string = m.text
                    v.setSelectedRange(NSRange(location: caret, length: 0))
                    restyle(v as! TokenTextView)
                    return true
                }
                if parent.multiline, flags.contains(.shift) || flags.contains(.option) {
                    v.insertText("\n", replacementRange: v.selectedRange())
                    return true
                }
                parent.onSubmit(flags)
                return true
            case #selector(NSResponder.cancelOperation(_:)):
                if m.completion != nil { m.completion = nil; return true }
                parent.onCancel()
                return true
            case #selector(NSResponder.insertTab(_:)):
                if m.completion != nil, let caret = m.acceptCompletion() {
                    v.string = m.text
                    v.setSelectedRange(NSRange(location: caret, length: 0))
                    restyle(v as! TokenTextView)
                    return true
                }
                // never a literal tab in a single-line field
                return parent.onTab?(false) ?? !parent.multiline
            case #selector(NSResponder.insertBacktab(_:)):
                return parent.onTab?(true) ?? !parent.multiline
            case #selector(NSResponder.moveUp(_:)):
                if m.completion != nil { m.moveCompletion(-1); return true }
                return parent.onArrow?(-1) ?? false
            case #selector(NSResponder.moveDown(_:)):
                if m.completion != nil { m.moveCompletion(1); return true }
                return parent.onArrow?(1) ?? false
            default:
                return false
            }
        }

        /// Colours the quick-add tokens (project, label, priority, date) in place.
        func restyle(_ v: TokenTextView) {
            guard let storage = v.textStorage else { return }
            let full = NSRange(location: 0, length: storage.length)
            storage.beginEditing()
            storage.setAttributes([.font: parent.font, .foregroundColor: NSColor.labelColor], range: full)
            if let p = parent.model.parsed, parent.model.text == v.string {
                for t in p.tokens where NSMaxRange(t.range) <= storage.length {
                    storage.addAttributes([.foregroundColor: TodoStyle.tokenColor(t.kind),
                                           .backgroundColor: TodoStyle.tokenColor(t.kind).withAlphaComponent(0.14)], range: t.range)
                }
            }
            storage.endEditing()
            v.typingAttributes = [.font: parent.font, .foregroundColor: NSColor.labelColor]
        }
    }
}

final class TokenTextView: NSTextView {
    weak var coordinator: TokenField.Coordinator?
    var multiline = false
    var placeholder = "" { didSet { if placeholder != oldValue { needsDisplay = true } } }

    override var intrinsicContentSize: NSSize {
        guard let lm = layoutManager, let tc = textContainer else { return super.intrinsicContentSize }
        lm.ensureLayout(for: tc)
        let line = (font ?? .systemFont(ofSize: 14)).boundingRectForFont.height
        let used = lm.usedRect(for: tc).height
        let h = max(line, multiline ? used : min(used, line * 6))
        return NSSize(width: NSView.noIntrinsicMetric, height: ceil(h + textContainerInset.height * 2))
    }

    override func setFrameSize(_ s: NSSize) {
        let widthChanged = s.width != frame.width
        super.setFrameSize(s)
        if widthChanged { invalidateIntrinsicContentSize() }
    }

    override func becomeFirstResponder() -> Bool {
        let ok = super.becomeFirstResponder()
        if ok { coordinator?.parent.onFocus?(true) }
        return ok
    }

    override func resignFirstResponder() -> Bool {
        let ok = super.resignFirstResponder()
        if ok { coordinator?.parent.onFocus?(false); coordinator?.parent.model.completion = nil }
        return ok
    }

    override func draw(_ r: NSRect) {
        super.draw(r)
        guard string.isEmpty, !placeholder.isEmpty else { return }
        let attrs: [NSAttributedString.Key: Any] = [.font: font ?? .systemFont(ofSize: 14), .foregroundColor: NSColor.placeholderTextColor]
        (placeholder as NSString).draw(at: NSPoint(x: textContainerInset.width, y: textContainerInset.height), withAttributes: attrs)
    }

    // Paste as plain text; single-line fields fold newlines into spaces.
    override func paste(_ sender: Any?) {
        guard var s = NSPasteboard.general.string(forType: .string) else { return }
        if !multiline { s = s.components(separatedBy: .newlines).filter { !$0.isEmpty }.joined(separator: " ") }
        insertText(s, replacementRange: selectedRange())
    }
}

/// Completion list shown under a `TokenField`.
struct CompletionList: View {
    @ObservedObject var model: TokenFieldModel
    var colorOf: (String) -> Color = { _ in .secondary }

    var body: some View {
        if let c = model.completion {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(c.items.enumerated()), id: \.offset) { i, name in
                    HStack(spacing: 8) {
                        Image(systemName: c.kind == .project ? "number" : "tag")
                            .foregroundStyle(c.kind == .project ? colorOf(name) : Color(nsColor: TodoStyle.tokenColor(.label)))
                            .frame(width: 16)
                        Text(name)
                        Spacer()
                        if i == c.index { Text("⇥").foregroundStyle(.secondary).font(.caption) }
                    }
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(i == c.index ? Color.accentColor.opacity(0.18) : .clear, in: RoundedRectangle(cornerRadius: 5))
                }
            }
            .padding(4)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.primary.opacity(0.1)))
        }
    }
}
