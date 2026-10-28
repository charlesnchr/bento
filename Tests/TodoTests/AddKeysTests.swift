import AppKit
import Testing
@testable import Todo

/// A key-down event as AppKit delivers it.
private func key(_ code: UInt16, _ chars: String, _ mods: NSEvent.ModifierFlags = [], held: Bool = false) -> NSEvent {
    NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: mods, timestamp: 0, windowNumber: 0, context: nil,
                     characters: chars, charactersIgnoringModifiers: chars, isARepeat: held, keyCode: code)!
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
        #expect(TokenField.returnKey(#selector(NSResponder.insertNewline(_:)), event: returnKey) == .press)
        // AppKit has no binding for ⌘↩: it comes as noop:, recognised by the key itself.
        #expect(TokenField.returnKey(noop, event: cmdReturn) == .press)
        // keypad Enter (fn+Return on a laptop) carries the numeric pad / fn flags too
        #expect(TokenField.returnKey(noop, event: key(TodoKey.Code.keypadEnter, "\u{3}", [.command, .numericPad, .function])) == .press)
        // Return with other ⌘ combinations is swallowed; other unbound ⌘ keys stay noop.
        #expect(TokenField.returnKey(noop, event: key(TodoKey.Code.returnKey, "\r", [.command, .shift])) == .ignored)
        #expect(TokenField.returnKey(noop, event: key(TodoKey.Code.returnKey, "\r", [.command, .option])) == .ignored)
        #expect(TokenField.returnKey(noop, event: key(0, "a", .command)) == nil)
        #expect(TokenField.returnKey(noop, event: nil) == nil)
        #expect(TokenField.returnKey(#selector(NSResponder.cancelOperation(_:)), event: key(TodoKey.Code.escape, "\u{1b}")) == nil)
        // While an input method composes, ⌘↩ is left to it.
        #expect(TokenField.returnKey(noop, event: cmdReturn, composing: true) == nil)
    }

    @Test func commandReturnDuringCompositionDoesNotSubmit() {
        let r = Recorder()
        let (c, v) = field(TokenFieldModel(text: "", parses: true), r)
        v.setMarkedText("か", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: 0, length: 0))
        #expect(v.hasMarkedText())
        #expect(!c.handle(noop, event: cmdReturn, in: v))
        #expect(r.submits.isEmpty)
    }

    @Test func otherCommandReturnsDoNothingInEitherField() {
        let r = Recorder()
        let (c, v) = field(TokenFieldModel(text: "Buy milk", parses: true), r)
        let (dc, dv) = field(TokenFieldModel(text: "notes"), multiline: true, r)
        for mods: NSEvent.ModifierFlags in [[.command, .shift], [.command, .option]] {
            #expect(c.handle(noop, event: key(TodoKey.Code.returnKey, "\r", mods), in: v))
            #expect(dc.handle(noop, event: key(TodoKey.Code.returnKey, "\r", mods), in: dv))
        }
        #expect(r.submits.isEmpty)
        #expect(dv.string == "notes")
    }

    @Test func aHeldReturnSubmitsOnce() {
        let r = Recorder()
        let m = TokenFieldModel(text: "Buy milk", parses: true)
        let (c, v) = field(m, r)
        #expect(c.handle(noop, event: cmdReturn, in: v))
        #expect(c.handle(noop, event: key(TodoKey.Code.returnKey, "\r", .command, held: true), in: v))
        #expect(c.handle(#selector(NSResponder.insertNewline(_:)), event: key(TodoKey.Code.returnKey, "\r", held: true), in: v))
        #expect(r.submits == [[.command]])
        // A repeat doesn't accept a completion either.
        m.projects = { ["Errands"] }
        m.text = "Call #Err"
        m.caretMoved(to: 9)
        #expect(m.completion != nil)
        #expect(c.handle(#selector(NSResponder.insertNewline(_:)), event: key(TodoKey.Code.returnKey, "\r", held: true), in: v))
        #expect(m.text == "Call #Err")
        // ⇧↩ still repeats newlines in the description.
        let (dc, dv) = field(TokenFieldModel(text: "a"), multiline: true, r)
        #expect(dc.handle(#selector(NSResponder.insertNewline(_:)), event: key(TodoKey.Code.returnKey, "\r", .shift, held: true), in: dv))
        #expect(dv.string == "a\n")
        #expect(r.submits.count == 1)
    }

    @Test func quickAddConfirmationGoesWhenTypingStarts() {
        let m = QuickAddModel()
        m.added = "Added to Inbox"
        m.field.text = ""
        #expect(m.added == "Added to Inbox")
        m.field.text = "n"
        #expect(m.added == nil)
        m.field.text = ""
        #expect(m.added == nil)
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
