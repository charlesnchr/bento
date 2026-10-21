import AppKit
import SwiftUI
import BentoCore

/// Dev-harness test hook (`scripts/perform notes.debug`): runs the commands in
/// `$BENTO_HOME/debug.txt` against the editor so the UI can be exercised without
/// synthesizing keystrokes. One command per line:
///
///     open | hide | toggle | new | wait <ms> | cmd <NotesCommand> | key newline|tab|backtab|backspace|delete|escape
///     type <text with \n \t>     set <text with \n>     select <loc> <len>     caret end|start
///     checkbox <line>            palette <query>        palette-enter          palette-down
///     dump                       (writes $BENTO_HOME/dump.json)
enum NotesDebug {
    static var home: URL { URL(fileURLWithPath: ProcessInfo.processInfo.environment["BENTO_HOME"] ?? "/tmp/bento-dev/notes") }
    /// Result of the last bench-* command (included in the dump).
    static var bench: [String: Any] = [:]

    static func run(_ c: NotesController) {
        guard let script = try? String(contentsOf: home.appendingPathComponent("debug.txt"), encoding: .utf8) else { return }
        let lines = script.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
        step(c, lines[...])
    }

    private static func unescape(_ s: String) -> String {
        s.replacingOccurrences(of: "\\n", with: "\n").replacingOccurrences(of: "\\t", with: "\t")
    }

    private static func step(_ c: NotesController, _ rest: ArraySlice<String>) {
        guard let line = rest.first else { return }
        let next = rest.dropFirst()
        let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
        let cmd = parts.first ?? ""
        let arg = parts.count > 1 ? parts[1] : ""
        var delay: TimeInterval = 0.05
        let w = c.debugWindow
        switch cmd {
        case "open": c.openWindow()
        case "hide": c.hideWindow()
        case "toggle": c.toggle()
        case "new": c.createNote(body: "")
        case "wait": delay = (Double(arg) ?? 100) / 1000
        case "cmd":
            if let k = NotesCommand(rawValue: arg) { c.perform(k) }
        case "key":
            guard let tv = w?.textView else { break }
            let sel: Selector? = ["newline": #selector(NSResponder.insertNewline(_:)), "tab": #selector(NSResponder.insertTab(_:)),
                                  "backtab": #selector(NSResponder.insertBacktab(_:)), "backspace": #selector(NSResponder.deleteBackward(_:)),
                                  "delete": #selector(NSResponder.deleteForward(_:)), "escape": #selector(NSResponder.cancelOperation(_:)),
                                  "up": #selector(NSResponder.moveUp(_:)), "down": #selector(NSResponder.moveDown(_:)),
                                  "left": #selector(NSResponder.moveLeft(_:)), "right": #selector(NSResponder.moveRight(_:))][arg]
            if let sel { tv.doCommand(by: sel) }
        case "type":
            guard let tv = w?.textView else { break }
            let chars = Array(unescape(arg))
            typeChars(tv, chars[...]) { step(c, next) }
            return
        case "set":
            guard let tv = w?.textView else { break }
            let text = unescape(arg)
            tv.apply(EditResult(edits: [TextEdit(range: NSRange(location: 0, length: (tv.string as NSString).length), replacement: text)],
                                selection: NSRange(location: (text as NSString).length, length: 0)))
        case "select":
            let n = arg.split(separator: " ").compactMap { Int($0) }
            if n.count == 2, let tv = w?.textView {
                tv.setSelectedRange(NSRange(location: n[0], length: n[1]))
                tv.scrollRangeToVisible(tv.selectedRange()) // like typing: the caret is on screen
            }
        case "caret":
            if let tv = w?.textView {
                tv.setSelectedRange(NSRange(location: arg == "start" ? 0 : (tv.string as NSString).length, length: 0))
                tv.scrollRangeToVisible(tv.selectedRange())
            }
        case "checkbox":
            if let tv = w?.textView, let n = Int(arg) {
                let lines = (tv.string as NSString).components(separatedBy: "\n")
                let start = lines.prefix(n).reduce(0) { $0 + ($1 as NSString).length + 1 }
                tv.onToggleTask?(start, false)
            }
        case "palette": w?.palette.debugSetQuery(arg)
        case "palette-enter": w?.palette.debugActivate()
        case "palette-down": w?.palette.debugMove(1)
        case "dump": dump(c)
        case "sync-now": c.sync.syncNow()
        case "settings-png":
            // renders the settings pane offscreen: settings-png <path> [dark]
            let parts = arg.split(separator: " ").map(String.init)
            let view = NSHostingView(rootView: c.makeSettingsView(actions: []).frame(width: 620, height: 1500))
            view.frame = NSRect(x: 0, y: 0, width: 620, height: 1500)
            let win = NSWindow(contentRect: view.frame, styleMask: [.borderless], backing: .buffered, defer: false)
            win.appearance = parts.count > 1 && parts[1] == "dark" ? NSAppearance(named: .darkAqua) : NSAppearance(named: .aqua)
            win.contentView = view
            view.layoutSubtreeIfNeeded()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                if let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
                    view.cacheDisplay(in: view.bounds, to: rep)
                    try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: parts.first ?? "/tmp/notes-settings.png"))
                }
                _ = win
            }
            delay = 0.8
        case "edit-title":
            // edit-title <title>|<new body>: local edit of a stored note (window not needed)
            let kv = arg.components(separatedBy: "|")
            if kv.count == 2, var n = c.store.liveNotes.first(where: { $0.title == kv[0] }) {
                n.body = unescape(kv[1])
                n.updatedAt = Note.now()
                n.dirty = true
                c.store.save(n)
                c.sync.localChange()
            }
        case "open-title":
            if let n = c.store.liveNotes.first(where: { $0.title == arg }) { c.openWindow(); c.open(n.id) }
        case "put":
            // put <id>|<body>: local edit of a note by id, created if missing (no window needed)
            let kv = arg.components(separatedBy: "|")
            if kv.count >= 2 { c.debugPut(id: kv[0], body: unescape(kv.dropFirst().joined(separator: "|"))) }
        case "put-file":
            // put-file <id> <path>: same with the body read from a file (large notes)
            let p = arg.split(separator: " ", maxSplits: 1).map(String.init)
            if p.count == 2, let body = try? String(contentsOfFile: p[1], encoding: .utf8) { c.debugPut(id: p[0], body: body) }
        case "append":
            // append <id>|<text>: rapid edits without a window
            let kv = arg.components(separatedBy: "|")
            if kv.count >= 2, let n = c.store.note(kv[0]) { c.debugPut(id: n.id, body: n.body + unescape(kv.dropFirst().joined(separator: "|"))) }
        case "trash": c.debugMutate(arg) { $0.trashedAt = Note.now() }
        case "restore": c.debugMutate(arg) { $0.trashedAt = nil }
        case "purge": c.debugMutate(arg) { $0.deleted = true; $0.body = "" }
        case "pin": c.debugMutate(arg) { $0.pinned.toggle() }
        case "undo": w?.textView.undoManager?.undo()
        case "redo": w?.textView.undoManager?.redo()
        case "paste-file":
            // paste-file <path> <uti>: pastes through a private pasteboard (never the user's)
            let p = arg.split(separator: " ", maxSplits: 1).map(String.init)
            if let tv = w?.textView, p.count == 2, let data = FileManager.default.contents(atPath: p[0]) {
                let pb = NSPasteboard(name: NSPasteboard.Name("com.charles.bento.notes.debug"))
                pb.clearContents()
                pb.setData(data, forType: NSPasteboard.PasteboardType(p[1]))
                tv.pastePlain(from: pb)
            }
        case "quit": NSApp.terminate(nil)
        case "status-text": c.toggleStatusText()
        case "bench-type":
            // bench-type <n>: n single-character insertions at the caret, each laid out and
            // drawn like a keystroke; records the mean and worst time per keystroke
            guard let w, let tv = w.textView as NoteTextView? else { break }
            var times: [Double] = []
            for i in 0..<(Int(arg) ?? 20) {
                let t0 = CFAbsoluteTimeGetCurrent()
                tv.insertText(i % 7 == 6 ? " " : "x", replacementRange: NSRange(location: NSNotFound, length: 0))
                if let lm = tv.layoutManager, let tc = tv.textContainer { lm.ensureLayout(forBoundingRect: tv.visibleRect, in: tc) }
                tv.displayIfNeeded()
                times.append((CFAbsoluteTimeGetCurrent() - t0) * 1000)
            }
            bench = ["meanMs": times.reduce(0, +) / Double(max(1, times.count)), "maxMs": times.max() ?? 0, "count": times.count]
        case "bench-browse":
            // bench-browse <query>: opens Browse Notes and times filtering with the query
            let t0 = CFAbsoluteTimeGetCurrent()
            c.showBrowse()
            let t1 = CFAbsoluteTimeGetCurrent()
            w?.palette.debugSetQuery(arg)
            let t2 = CFAbsoluteTimeGetCurrent()
            bench = ["openMs": (t1 - t0) * 1000, "filterMs": (t2 - t1) * 1000, "rows": w?.palette.debugRowCount ?? -1]
        case "bench-open":
            // bench-open <id>: time to load a note into the editor and lay out the visible part
            let t0 = CFAbsoluteTimeGetCurrent()
            c.open(arg)
            if let tv = w?.textView, let lm = tv.layoutManager, let tc = tv.textContainer { lm.ensureLayout(forBoundingRect: tv.visibleRect, in: tc) }
            w?.textView.displayIfNeeded()
            bench = ["openMs": (CFAbsoluteTimeGetCurrent() - t0) * 1000]
        case "frame":
            let n = arg.split(separator: " ").compactMap { Double($0) }
            if n.count == 4 { w?.panel.setFrame(NSRect(x: n[0], y: n[1], width: n[2], height: n[3]), display: true) }
        case "appearance":
            w?.panel.appearance = arg == "dark" ? NSAppearance(named: .darkAqua) : arg == "light" ? NSAppearance(named: .aqua) : nil
            w?.palette.debugAppearance(w?.panel.appearance)
        default: break
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { step(c, next) }
    }

    private static func typeChars(_ tv: NoteTextView, _ chars: ArraySlice<Character>, done: @escaping () -> Void) {
        guard let ch = chars.first else { done(); return }
        if ch == "\n" {
            tv.doCommand(by: #selector(NSResponder.insertNewline(_:)))
        } else if ch == "\t" {
            tv.doCommand(by: #selector(NSResponder.insertTab(_:)))
        } else {
            tv.insertText(String(ch), replacementRange: NSRange(location: NSNotFound, length: 0))
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.012) { typeChars(tv, chars.dropFirst(), done: done) }
    }

    static func dump(_ c: NotesController) {
        var d: [String: Any] = [:]
        if let w = c.debugWindow {
            let tv = w.textView
            d["body"] = tv.string
            d["selection"] = [tv.selectedRange().location, tv.selectedRange().length]
            d["visible"] = w.panel.isVisible
            d["key"] = w.panel.isKeyWindow
            d["windowNumber"] = w.panel.windowNumber
            d["frame"] = NSStringFromRect(w.panel.frame)
            d["noteID"] = w.noteID ?? ""
            d["paletteOpen"] = w.palette.isOpen
            d["pid"] = Int(getpid())
            d["frontmostPID"] = Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0)
            // hidden ranges and decorations per line
            if let ts = tv.textStorage {
                var hidden: [[Int]] = []
                ts.enumerateAttribute(.notesHidden, in: NSRange(location: 0, length: ts.length)) { v, r, _ in
                    if v != nil { hidden.append([r.location, r.length]) }
                }
                d["hidden"] = hidden
                var decos: [String] = []
                let text = ts.string as NSString
                var loc = 0
                while loc < text.length {
                    let lr = text.lineRange(for: NSRange(location: loc, length: 0))
                    let deco = ts.attribute(.notesBlock, at: loc, effectiveRange: nil) as? BlockDecoration
                    decos.append(deco.map { "\($0.kind)" } ?? "nil")
                    loc = NSMaxRange(lr)
                }
                d["decorations"] = decos
                // screen rects (Cocoa coordinates) of task checkboxes, for click tests
                var boxes: [String] = []
                if let lm = tv.notesLayoutManager {
                    var l2 = 0
                    while l2 < text.length {
                        let lr = text.lineRange(for: NSRange(location: l2, length: 0))
                        if let deco = ts.attribute(.notesBlock, at: l2, effectiveRange: nil) as? BlockDecoration, case .task(let level, _) = deco.kind,
                           let r = lm.checkboxRect(paragraphStart: l2, level: level) {
                            let inView = r.offsetBy(dx: tv.textContainerOrigin.x, dy: tv.textContainerOrigin.y)
                            let inWin = tv.convert(inView, to: nil)
                            boxes.append(NSStringFromRect(w.panel.convertToScreen(inWin)))
                        }
                        l2 = NSMaxRange(lr)
                    }
                }
                d["checkboxes"] = boxes
            }
        }
        d["currentID"] = c.currentID ?? ""
        d["notes"] = c.store.allNotes(includeTombstones: true).sorted(by: NoteStore.listOrder).map { n in
            ["id": n.id, "title": n.title, "pinned": n.pinned, "trashed": n.isTrashed, "deleted": n.deleted, "dirty": n.dirty, "seq": n.seq ?? -1, "body": n.body] as [String: Any]
        }
        d["lastSeq"] = c.store.lastSeq
        d["sync"] = c.sync.status.summary
        d["syncState"] = "\(c.sync.status.state)"
        d["bench"] = bench
        d["pending"] = c.sync.status.pending
        d["blocked"] = c.sync.status.blocked
        d["lastError"] = c.sync.status.lastError ?? ""
        if let w = c.debugWindow {
            d["footer"] = w.debugFooter
            d["header"] = w.debugHeader
            d["level"] = w.panel.level.rawValue
            d["autoResize"] = c.settings.autoResize
        }
        d["settings"] = (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(c.settings))) ?? [:]
        if let data = try? JSONSerialization.data(withJSONObject: d, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: home.appendingPathComponent("dump.json"))
        }
    }
}
