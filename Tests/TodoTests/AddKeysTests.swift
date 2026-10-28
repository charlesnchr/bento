import AppKit
import Testing
@testable import Todo

/// A key-down event as AppKit delivers it.
private func key(_ code: UInt16, _ chars: String, _ mods: NSEvent.ModifierFlags = []) -> NSEvent {
    NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: mods, timestamp: 0, windowNumber: 0, context: nil,
                     characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code)!
}

private let returnKey = key(TodoKey.Code.returnKey, "\r")
private let cmdReturn = key(TodoKey.Code.returnKey, "\r", .command)
private let noop = Selector(("noop:"))

/// Return, ⌘↩ and Esc in the add fields (Quick Add and the inline editor).
@MainActor @Suite struct AddKeys {
    final class Recorder {
        var submits: [NSEvent.ModifierFlags] = []
        var cancels = 0
    }

    private func field(_ model: TokenFieldModel, multiline: Bool = false, _ r: Recorder) -> (TokenField.Coordinator, TokenTextView) {
        let f = TokenField(model: model, multiline: multiline,
                           onSubmit: { r.submits.append($0) }, onCancel: { r.cancels += 1 })
        let v = TokenTextView()
        v.string = model.text
        return (f.makeCoordinator(), v)
    }

    @Test func returnPressesAreRecognisedWithAndWithoutCommand() {
        #expect(TokenField.isReturn(#selector(NSResponder.insertNewline(_:)), event: returnKey))
        // AppKit has no binding for ⌘↩: it comes as noop:, recognised by the key itself.
        #expect(TokenField.isReturn(noop, event: cmdReturn))
        #expect(TokenField.isReturn(noop, event: key(TodoKey.Code.keypadEnter, "\u{3}", .command)))
        // Other unbound ⌘ keys stay noop.
        #expect(!TokenField.isReturn(noop, event: key(0, "a", .command)))
        #expect(!TokenField.isReturn(noop, event: nil))
        #expect(!TokenField.isReturn(#selector(NSResponder.cancelOperation(_:)), event: key(TodoKey.Code.escape, "\u{1b}")))
    }

    @Test func commandReturnSubmitsWithCommand() {
        let r = Recorder()
        let (c, v) = field(TokenFieldModel(text: "Buy milk", parses: true), r)
        #expect(c.handle(#selector(NSResponder.insertNewline(_:)), event: returnKey, in: v))
        #expect(c.handle(noop, event: cmdReturn, in: v))
        #expect(r.submits == [[], [.command]])
        #expect(c.handle(#selector(NSResponder.cancelOperation(_:)), event: key(TodoKey.Code.escape, "\u{1b}"), in: v))
        #expect(r.cancels == 1)
    }

    @Test func commandReturnSubmitsFromTheDescription() {
        let r = Recorder()
        let (c, v) = field(TokenFieldModel(text: "notes"), multiline: true, r)
        #expect(c.handle(noop, event: cmdReturn, in: v))
        #expect(r.submits == [[.command]])
        // ⇧↩ is still a newline there.
        #expect(c.handle(#selector(NSResponder.insertNewline(_:)), event: key(TodoKey.Code.returnKey, "\r", .shift), in: v))
        #expect(r.submits.count == 1)
        #expect(v.string == "notes\n")
    }

    @Test func commandReturnAcceptsAShowingCompletionLikeReturn() {
        let r = Recorder()
        let m = TokenFieldModel(text: "Call #Err", parses: true)
        m.projects = { ["Errands"] }
        m.caretMoved(to: 9)
        #expect(m.completion != nil)
        let (c, v) = field(m, r)
        #expect(c.handle(noop, event: cmdReturn, in: v))
        #expect(m.text == "Call #Errands ")
        #expect(r.submits.isEmpty)
    }

    @Test func quickAddCommandReturnIsTheOppositeOfReturn() {
        let m = QuickAddModel()
        #expect(!m.keepsOpen(command: false))
        #expect(m.keepsOpen(command: true))
        #expect(m.hint == "↩ Add · ⌘↩ Add another · Esc")
        m.returnKeepsOpen = true
        #expect(m.keepsOpen(command: false))
        #expect(!m.keepsOpen(command: true))
        #expect(m.hint == "↩ Add another · ⌘↩ Add and close · Esc")
    }
}
