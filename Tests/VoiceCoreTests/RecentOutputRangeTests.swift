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
import CoreFoundation
import Testing
@testable import VoiceCore

/// Dictation leaves its output unselected with the caret after it. Retry and
/// voice editing find that output again, and select it, only when they replace it.
@MainActor
@Suite struct RecentOutputRangeTests {
    private func range(_ text: String, in value: String, at location: Int, length: Int = 0) -> CFRange? {
        OutputSelection.recentOutputRange(text, value: value, selection: CFRange(location: location, length: length))
    }

    @Test func findsOutputEndingAtCaret() {
        let found = range("hello world", in: "Note: hello world", at: 17)
        #expect(found?.location == 6)
        #expect(found?.length == 11)
    }

    @Test func findsOutputBeforeCaretInsideText() {
        let found = range("hello", in: "a hello b", at: 7)
        #expect(found?.location == 2)
        #expect(found?.length == 5)
    }

    @Test func acceptsAnExistingSelectionOfTheOutput() {
        let found = range("hello", in: "a hello b", at: 2, length: 5)
        #expect(found?.location == 2)
        #expect(found?.length == 5)
    }

    @Test func rejectsWhenCaretHasMovedAway() {
        #expect(range("hello", in: "a hello b", at: 9) == nil)
        #expect(range("hello", in: "a hello b", at: 0) == nil)
    }

    @Test func rejectsWhenTextWasTypedAfterOutput() {
        #expect(range("hello", in: "hello there", at: 11) == nil)
    }

    @Test func rejectsUnrelatedSelection() {
        #expect(range("hello", in: "a hello b", at: 0, length: 1) == nil)
        #expect(range("hello", in: "a hello b", at: 2, length: 3) == nil)
    }

    @Test func rejectsEmptyOutputAndInvalidRanges() {
        #expect(range("", in: "abc", at: 3) == nil)
        #expect(range("abc", in: "abc", at: 4) == nil)
        #expect(range("abc", in: "abc", at: -1) == nil)
        #expect(range("abc", in: "abc", at: 1, length: 5) == nil)
    }

    @Test func matchesAcrossEditorNewlineConversion() {
        // Editors may store a pasted "\n" as "\r\n" or "\r"; offsets stay in the editor's UTF-16.
        let crlf = range("one\ntwo", in: "x one\r\ntwo", at: 10)
        #expect(crlf?.location == 2)
        #expect(crlf?.length == 8)
        let cr = range("one\ntwo", in: "one\rtwo", at: 7)
        #expect(cr?.location == 0)
        #expect(cr?.length == 7)
    }

    @Test func usesUTF16OffsetsForEmojiAndAccents() {
        let found = range("café 👍", in: "👋 café 👍", at: 10)
        #expect(found?.location == 3)
        #expect(found?.length == 7)
    }

    @Test func neverSplitsACharacter() {
        // "e" followed by a combining acute is one character; the output "\u{301}x"
        // starts mid-character and must not match.
        #expect(range("\u{301}x", in: "e\u{301}x", at: 3) == nil)
    }

    @Test func searchesOnlyABoundedTailOfLongDocuments() {
        let prefix = String(repeating: "lorem ipsum\r\n", count: 5_000)
        let value = prefix + "x one\r\ntwo"
        let caret = (value as NSString).length
        let found = range("one\ntwo", in: value, at: caret)
        #expect(found?.location == caret - 8)
        #expect(found?.length == 8)
    }

    @Test func boundedTailStartsOnACharacterBoundary() {
        // The tail start lands inside the emoji's surrogate pair and must move to its start.
        let output = String(repeating: "a", count: 10)
        let value = "👍" + String(repeating: "b", count: 25) + output
        let caret = (value as NSString).length
        #expect(caret - (2 * 10 + 16) == 1)
        let found = range(output, in: value, at: caret)
        #expect(found?.location == caret - 10)
        #expect(found?.length == 10)
    }
}

/// Option+F18 only treats output at the caret as the edit target briefly; a
/// selection keeps it editable for the whole editing session.
@Suite struct EditingCaretWindowTests {
    @Test func caretEditingExpiresBeforeTheSession() {
        let start = Date(timeIntervalSince1970: 1_000)
        let session = EditingSession(seed: "hello", now: start)
        #expect(session.editsAtCaret(at: start.addingTimeInterval(29)))
        #expect(!session.editsAtCaret(at: start.addingTimeInterval(31)))
        #expect(session.isActive(at: start.addingTimeInterval(31)))
    }

    @Test func eachRevisionRestartsTheCaretWindow() {
        let start = Date(timeIntervalSince1970: 1_000)
        var session = EditingSession(seed: "hello", now: start)
        session.append(instruction: "shorter", revision: "hi", now: start.addingTimeInterval(60))
        #expect(session.editsAtCaret(at: start.addingTimeInterval(80)))
    }
}

/// Back-to-back pastes must restore the user's clipboard, not clear it.
@MainActor
@Suite struct PasteRestoreCarryTests {
    private func board() -> NSPasteboard {
        NSPasteboard(name: NSPasteboard.Name("com.charles.bento.tests.paste.\(UUID().uuidString)"))
    }

    @Test func secondPasteInheritsTheUsersClipboard() {
        let pasteboard = board()
        defer { pasteboard.releaseGlobally() }
        pasteboard.clearContents()
        pasteboard.setString("user's clipboard", forType: .string)
        let first = PasteInserter.snapshot(pasteboard, carrying: nil)
        let pending = PasteInserter.PendingRestore(snapshot: first,
            changeCount: PasteInserter.writeTranscript("first dictation", to: pasteboard))
        let second = PasteInserter.snapshot(pasteboard, carrying: pending)
        PasteInserter.restore(second, to: pasteboard)
        #expect(pasteboard.string(forType: .string) == "user's clipboard")
    }

    @Test func aCopyBetweenPastesWins() {
        let pasteboard = board()
        defer { pasteboard.releaseGlobally() }
        pasteboard.clearContents()
        pasteboard.setString("old", forType: .string)
        let pending = PasteInserter.PendingRestore(snapshot: PasteInserter.snapshot(pasteboard, carrying: nil),
            changeCount: PasteInserter.writeTranscript("dictation", to: pasteboard))
        pasteboard.clearContents()
        pasteboard.setString("copied since", forType: .string)
        PasteInserter.restore(PasteInserter.snapshot(pasteboard, carrying: pending), to: pasteboard)
        #expect(pasteboard.string(forType: .string) == "copied since")
    }

    @Test func withoutCarryTheOldTranscriptIsSkipped() {
        // The failure mode the carry fixes: our own transcript is never snapshotted.
        let pasteboard = board()
        defer { pasteboard.releaseGlobally() }
        _ = PasteInserter.writeTranscript("dictation", to: pasteboard)
        #expect(PasteInserter.snapshot(pasteboard, carrying: nil).isEmpty)
    }
}
