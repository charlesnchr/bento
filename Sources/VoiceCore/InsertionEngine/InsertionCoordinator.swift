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
import Foundation

/// The 3-tier ladder with the two guards that fix Wispr's most-reported bugs:
///
///   guard 1: frontmost app changed since dictation started → NEVER paste blind
///            (text goes to the clipboard; the HUD offers it — F17)
///   guard 2: secure input active → refuse entirely, no clipboard leak (F18)
///
///   tier 1: AX kAXSelectedTextAttribute with read-back verification
///   tier 2: pasteboard + synthesized ⌘V with guarded restore
///   tier 3: text left on the clipboard, visible hint
public struct InsertionCoordinator: TextInserting {
    private let paster: PasteInserter

    @MainActor
    public init() {
        self.paster = PasteInserter()
    }

    @MainActor
    public func insert(_ text: String, context: DictationContext) async -> InsertionOutcome {
        SelectionDiagnostics.record("insertion.begin", targetPID: context.targetPID)
        // Guard 2: secure input — the transcript stays in History only.
        if SecureInput.isActive {
            Log.insertion.warning("secure input active at insert time — refusing (text in History only)")
            return .blockedSecureField
        }

        // Bento's own windows (Notes, Todo, Settings): insert in-process. AX
        // requests to our own process are answered by the main thread, which
        // would be the one waiting on them.
        if let pid = context.targetPID, pid == ProcessInfo.processInfo.processIdentifier {
            return insertInProcess(text)
        }

        // Guard 1: is the user still where they started dictating?
        let frontmost = NSWorkspace.shared.frontmostApplication
        if let expectedPID = context.targetPID, let frontmost, frontmost.processIdentifier != expectedPID {
            Log.insertion.info("frontmost changed (\(context.targetAppName ?? "?", privacy: .private) → \(frontmost.localizedName ?? "?", privacy: .private)) — no blind paste")
            paster.copyOnly(text)
            return .frontmostChanged
        }
        let activity = SelectionActivity(targetPID: context.targetPID)
        defer { activity.stop() }
        func editingSelectionMatches() async -> Bool {
            guard let editing = context.editingSession else { return true }
            if OutputSelection.equivalent(OutputSelection.selectedText(targetPID: context.targetPID), editing.currentText) { return true }
            let selected = await KeyboardSelection.readSelectedText(targetPID: context.targetPID, permitted: { activity.valid })
            return activity.valid && OutputSelection.equivalent(selected, editing.currentText)
        }

        if !(await editingSelectionMatches()) {
            SelectionDiagnostics.record("editing.selectionMismatch", targetPID: context.targetPID)
            paster.copyOnly(text)
            return .fellBackToClipboard
        }
        let selection = context.keepOutputSelected ? OutputSelection.capture(targetPID: context.targetPID, diagnose: true) : nil
        // An unchanged revision is already inserted and selected; do not paste it twice.
        if context.editingSession?.currentText == text { return .inserted }

        // Tier 1: AX direct insertion.
        switch await AXInserter.insert(text, targetPID: context.targetPID, bundleID: context.targetAppBundleID) {
        case .landed:
            SelectionDiagnostics.record("insertion.axLanded", targetPID: context.targetPID)
            Log.insertion.info("inserted via AX")
            if context.keepOutputSelected,
               !(await OutputSelection.selectInserted(text, before: selection, targetPID: context.targetPID, activity: activity)) {
                return .insertedWithoutSelection
            }
            return .inserted
        case .focusElsewhere:
            // PROVEN focus theft — a blind ⌘V would paste into the thief.
            // Same treatment as the frontmost-changed guard: chip, never blind.
            paster.copyOnly(text)
            return .frontmostChanged
        case .notPossible:
            break
        }

        // Guard 1 re-check: the AX attempt takes up to ~350ms — a ⌘Tab in that
        // window would land the ⌘V in the wrong app (production pass 2).
        if let expectedPID = context.targetPID,
           let nowFront = NSWorkspace.shared.frontmostApplication,
           nowFront.processIdentifier != expectedPID {
            Log.insertion.info("frontmost changed during AX attempt — no blind paste")
            paster.copyOnly(text)
            return .frontmostChanged
        }

        guard activity.valid else {
            paster.copyOnly(text)
            return .fellBackToClipboard
        }
        if !(await editingSelectionMatches()) {
            paster.copyOnly(text)
            return .fellBackToClipboard
        }
        // Tier 2: guarded paste. Note: "true" means the ⌘V was POSTED — there is
        // no OS-level delivery receipt for synthetic paste (industry-wide floor;
        // the text also stays recoverable in History).
        var selected = !context.keepOutputSelected
        let afterPaste: @MainActor () async -> Void = {
            if context.keepOutputSelected {
                selected = await OutputSelection.selectInserted(text, before: selection, targetPID: context.targetPID, activity: activity)
                if !selected, selection == nil, activity.valid {
                    // Browser editors may expose no AX range. After our single
                    // paste, use character navigation and verify by Copy instead.
                    selected = await KeyboardSelection.select(text, targetPID: context.targetPID, activity: activity)
                }
            }
        }
        if await paster.paste(text, afterPaste: context.keepOutputSelected ? afterPaste : nil) {
            SelectionDiagnostics.record("insertion.pastePosted", targetPID: context.targetPID)
            Log.insertion.info("⌘V posted (delivery is best-effort)")
            if !selected {
                return .insertedWithoutSelection
            }
            return .inserted
        }

        // Tier 3: clipboard floor.
        paster.copyOnly(text)
        return .fellBackToClipboard
    }

    /// Types into the focused text view of one of Bento's own windows; the
    /// clipboard otherwise.
    @MainActor
    private func insertInProcess(_ text: String) -> InsertionOutcome {
        if let client = NSApp.keyWindow?.firstResponder as? NSTextInputClient & NSResponder,
           !(client is NSTextView) || (client as? NSTextView)?.isEditable == true {
            client.insertText(text, replacementRange: NSRange(location: NSNotFound, length: 0))
            Log.insertion.info("inserted into a Bento window")
            return .insertedWithoutSelection
        }
        paster.copyOnly(text)
        return .fellBackToClipboard
    }
}
