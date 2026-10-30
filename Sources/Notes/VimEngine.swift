import Foundation

// MARK: - Keys, modes, registers

/// The editor's mode while Vim keybindings are on (`notes.vimMode`).
enum VimMode: Equatable {
    case normal, insert, visual, visualLine

    var title: String {
        switch self {
        case .normal: return "NORMAL"
        case .insert: return "INSERT"
        case .visual: return "VISUAL"
        case .visualLine: return "V-LINE"
        }
    }

    var isVisual: Bool { self == .visual || self == .visualLine }
}

/// One key press as the engine sees it: a typed character (with Ctrl or without) or a special key.
struct VimKey: Equatable {
    enum Special: Equatable { case escape, enter, backspace, tab, delete, left, right, up, down }
    var char: Character?
    var special: Special?
    var ctrl = false

    init(_ char: Character, ctrl: Bool = false) {
        self.char = char
        self.ctrl = ctrl
    }

    init(_ special: Special) { self.special = special }

    /// Escape, Ctrl-[ or Ctrl-C.
    var isEscape: Bool { special == .escape || (ctrl && (char == "[" || char == "c")) }

    /// Keys in Vim's notation: `d2w`, `ci"`, `<Esc>`, `<CR>`, `<BS>`, `<Del>`, `<Tab>`, `<Left>`,
    /// `<C-d>`, `<lt>` (a literal "<").
    static func parse(_ s: String) -> [VimKey] {
        var out: [VimKey] = []
        var rest = Substring(s)
        while let c = rest.first {
            if c == "<", let close = rest.firstIndex(of: ">"), close > rest.index(after: rest.startIndex) {
                let name = rest[rest.index(after: rest.startIndex)..<close].lowercased()
                var key: VimKey?
                switch name {
                case "esc": key = VimKey(.escape)
                case "cr", "enter", "return": key = VimKey(.enter)
                case "bs": key = VimKey(.backspace)
                case "del": key = VimKey(.delete)
                case "tab": key = VimKey(.tab)
                case "left": key = VimKey(.left)
                case "right": key = VimKey(.right)
                case "up": key = VimKey(.up)
                case "down": key = VimKey(.down)
                case "lt": key = VimKey("<")
                case "space": key = VimKey(" ")
                default:
                    if name.hasPrefix("c-"), name.count == 3, let ch = name.last { key = VimKey(ch, ctrl: true) }
                }
                if let key {
                    out.append(key)
                    rest = rest[rest.index(after: close)...]
                    continue
                }
            }
            out.append(VimKey(c))
            rest = rest.dropFirst()
        }
        return out
    }

    /// How the key shows among the keys typed so far.
    var display: String {
        if let c = char { return ctrl ? "^" + String(c).uppercased() : String(c) }
        return ""
    }
}

/// A register's content. Linewise text always ends with a line break.
struct VimRegister: Equatable {
    var text: String
    var linewise: Bool
}

enum VimScroll: Equatable { case halfDown, halfUp, pageDown, pageUp, lineDown, lineUp, center, top, bottom }
enum VimScreenLine { case top, middle, bottom }
enum VimFoldAction { case toggle, open, close }

/// The editor's side: its text, selection, undo, scrolling and collapsed sections.
protocol VimHost: AnyObject {
    var vimText: NSString { get }
    var vimSelection: NSRange { get }
    /// The collapsed heading sections: their hidden lines behave like one closed fold.
    var vimFolds: HeadingFolds { get }
    /// Selects `range` and scrolls `show` into view.
    func vimSetSelection(_ range: NSRange, show: Int)
    /// Applies the edits as one undoable change; false when the editor refuses them.
    func vimApply(_ result: EditResult) -> Bool
    func vimUndo() -> Bool
    func vimRedo() -> Bool
    /// The first caret position on the line starting at `lineStart` (after a hidden block marker
    /// such as "- " or "## ").
    func vimContentStart(_ lineStart: Int) -> Int
    /// Scrolls; returns a character on the line the caret should go to, nil to leave it.
    func vimScroll(_ scroll: VimScroll, count: Int, caret: Int) -> Int?
    /// A character on the top, middle or bottom line in view.
    func vimScreenLine(_ line: VimScreenLine) -> Int?
    /// Collapses or opens the section of the heading starting at `lineStart`.
    func vimToggleHeading(_ lineStart: Int) -> Bool
    /// Opens the collapsed sections hiding `location` (a search match).
    func vimReveal(_ location: Int)
    /// The system clipboard (the `+` and `*` registers).
    var vimClipboard: String? { get set }
    /// Escape in normal mode with nothing pending: the editor's own Escape (closes the window).
    func vimEscape()
    func vimBeep()
}

// MARK: - Commands

enum VimOperator: Equatable { case delete, change, yank, indent, outdent, toggleCase, lowercase, uppercase }

struct VimMotion: Equatable {
    var key: String
    var char: Character?
    var pattern: String?

    init(_ key: String, char: Character? = nil, pattern: String? = nil) {
        self.key = key
        self.char = char
        self.pattern = pattern
    }
}

enum VimTarget: Equatable {
    case motion(VimMotion)
    case object(inner: Bool, kind: Character)
    /// The doubled operator (dd, yy, >>, g~~) or yss.
    case line
}

enum VimInsertPoint: Equatable { case before, after, lineStart, lineEnd, below, above }

enum VimAction: Equatable {
    case move(VimMotion)
    case op(VimOperator, VimTarget)
    /// Visual mode: an operator on the selection (`lines`: D, X, Y, C and R take whole lines).
    case visualOp(VimOperator, lines: Bool)
    /// Visual mode: select a text object.
    case object(inner: Bool, kind: Character)
    case put(before: Bool)
    case join(spaces: Bool)
    case toggleCaseChar
    case replace(Character)
    case insert(VimInsertPoint)
    case undo, redo, repeatChange
    case visual(VimMode), reselect, swapEnds
    case scroll(VimScroll)
    case fold(VimFoldAction)
    case surround(VimTarget, Character)
    case deleteSurround(Character)
    case changeSurround(Character, Character)
    case visualSurround(Character)
}

struct VimCommand: Equatable {
    var register: Character?
    var count: Int?
    var action: VimAction
    /// A change made in visual mode: how much it covered, so `.` covers as much from the caret.
    var extent: VimExtent?
}

struct VimExtent: Equatable {
    var mode: VimMode
    /// Lines from the first to the last (1: within one line).
    var lines: Int
    /// Within one line: the characters covered; over several: the last line's end column.
    var width: Int
}

private enum VimParse: Error { case incomplete, invalid }

private struct VimParser {
    let keys: [VimKey]
    var i = 0

    func peek() -> VimKey? { i < keys.count ? keys[i] : nil }

    mutating func key() throws -> VimKey {
        guard i < keys.count else { throw VimParse.incomplete }
        i += 1
        return keys[i - 1]
    }

    /// A typed character (Return is "\n").
    mutating func char() throws -> Character {
        let k = try key()
        if k.special == .enter { return "\n" }
        guard let c = k.char, !k.ctrl else { throw VimParse.invalid }
        return c
    }

    mutating func count() -> Int? {
        var n: Int?
        while let k = peek(), !k.ctrl, let c = k.char, c.isASCII, let d = c.wholeNumberValue, n != nil || d != 0 {
            n = min((n ?? 0) * 10 + d, 99_999)
            i += 1
        }
        return n
    }
}

// MARK: - Engine

/// Vim keybindings for the notes editor: normal, insert, visual and visual-line modes, motions,
/// operators with counts, text objects, registers, undo/redo, `.`, vim-surround and Ctrl-D/U/F/B.
///
/// Pure logic over a `VimHost`. In insert mode the editor types as usual (markdown input rules,
/// list continuation); only Escape comes here. A collapsed heading section counts as one line,
/// like a closed fold in Vim: motions skip its hidden lines and line operators take them along,
/// so hidden text is never changed piecemeal.
final class VimEngine {
    weak var host: VimHost?
    private(set) var mode: VimMode = .normal
    /// After every change of mode or of the keys typed so far.
    var onChange: (() -> Void)?
    private(set) var pending: [VimKey] = []
    private var registers: [Character: VimRegister] = [:]
    private var unnamed: VimRegister?
    /// The column vertical motions aim for (from the line's first caret position; Int.max: the end).
    private var desiredColumn: Int?
    private var lastFind: (key: Character, char: Character)?
    private var lastSearch: (pattern: String, forward: Bool, word: Bool)?
    private(set) var visualAnchor = 0
    private(set) var visualCursor = 0
    private var visualSelection = NSRange(location: NSNotFound, length: 0)
    private var lastVisual: (anchor: Int, cursor: Int, mode: VimMode)?
    private var lastChange: VimCommand?
    private var lastInsert = ""
    private var insertCommand: VimCommand?
    private var insertStart: (location: Int, length: Int)?
    /// A count on i, a, I, A, o, O: the typed text goes in that many times (`newline`: as lines).
    private var insertRepeat = (count: 1, newline: false)
    private var replaying = false
    /// The text when the running command started, and when the current insert session did:
    /// a change and what was typed after it become one undo step, like Vim (`squash`).
    private var commandStartText: NSString = ""
    private var insertBefore: NSString?
    /// When insert or visual mode last ended: an Escape right after it (a reflexive double
    /// Escape) doesn't also close the window.
    private var lastModeExit = Date.distantPast
    var clock: () -> Date = Date.init
    /// A command is running: selection changes are the engine's own.
    private(set) var isExecuting = false
    /// The text and collapsed sections as of the last change.
    private var t: NSString = ""
    private var folds = HeadingFolds()
    /// The line `cls` looked at last and where its text starts (after a hidden block marker).
    private var markerLine = (start: 0, end: 0, content: 0)

    static let objectKinds: Set<Character> = ["w", "W", "p", "\"", "'", "`", "(", ")", "b", "[", "]", "{", "}", "B", "<", ">"]

    /// The keys typed so far of an unfinished command ("2d", "\"a", "/foo").
    var pendingText: String { pending.map(\.display).joined() }

    // MARK: Input

    /// A key in normal or visual mode.
    func handle(_ key: VimKey) {
        guard let host else { return }
        guard mode != .insert else {
            if key.isEscape { leaveInsert() }
            return
        }
        if key.isEscape {
            if !pending.isEmpty {
                pending = []
                changed()
            } else if mode.isVisual {
                run { exitVisual(to: visualCursor) }
                lastModeExit = clock()
            } else if clock().timeIntervalSince(lastModeExit) > 0.6 {
                host.vimEscape()
            }
            return
        }
        pending.append(key)
        do {
            let cmd = try VimEngine.parse(pending, visual: mode.isVisual)
            pending = []
            run { execute(cmd) }
        } catch VimParse.incomplete {
            changed()
        } catch {
            pending = []
            host.vimBeep()
            changed()
        }
    }

    /// Escape in insert mode: back to normal mode, the caret one character left.
    func leaveInsert() {
        guard mode == .insert, let host else { return }
        let was = isExecuting
        isExecuting = true
        defer { isExecuting = was }
        refresh()
        var loc = host.vimSelection.location
        let typed = insertedText(upTo: loc)
        if !replaying, let c = insertCommand {
            lastChange = c
            lastInsert = typed
        }
        if insertRepeat.count > 1, !typed.isEmpty {
            var copy = typed
            if insertRepeat.newline, let s = insertStart {
                // o and O: each copy on a line of its own, with the first one's indent and list marker
                let ls = lineStart(s.location)
                copy = "\n" + t.substring(with: NSRange(location: ls, length: s.location - ls)) + typed
            }
            let more = String(repeating: copy, count: min(insertRepeat.count - 1, 9_999))
            let end = loc + (more as NSString).length
            if apply([TextEdit(range: NSRange(location: loc, length: 0), replacement: more)], caret: end) { loc = end }
        }
        insertCommand = nil
        insertStart = nil
        insertRepeat = (1, false)
        refresh()
        if let before = insertBefore { squash(from: before, caret: loc) }
        insertBefore = nil
        lastModeExit = clock()
        mode = .normal
        desiredColumn = nil
        let ls = lineStart(loc)
        setCursor(loc > contentStart(ls) ? prev(loc) : loc)
        changed()
    }

    /// Another note is about to be loaded: an insert session in progress becomes one undo step
    /// in this note while its text and history are still in the editor.
    func noteWillChange() {
        guard mode == .insert, let before = insertBefore, let host else { return }
        let was = isExecuting
        isExecuting = true
        defer { isExecuting = was }
        squash(from: before, caret: host.vimSelection.location)
        insertBefore = nil
    }

    /// Another note was loaded. In insert mode, what's typed from here is a session of its own
    /// (one undo step in this note); otherwise like `normalize`.
    func noteLoaded() {
        if mode == .insert, let host {
            refresh()
            insertBefore = t
            insertStart = (host.vimSelection.location, t.length)
            insertCommand = nil
            insertRepeat = (1, false)
        }
        normalize()
    }

    /// Vim mode was turned on: normal mode.
    func start() {
        mode = .normal
        insertCommand = nil
        insertStart = nil
        insertBefore = nil
        insertRepeat = (1, false)
        normalize()
    }

    /// Another note was loaded, or an undo ran outside the engine: no pending keys, no visual
    /// selection, the caret on a character (insert mode stays).
    func normalize() {
        pending = []
        guard let host else { return }
        if mode.isVisual { mode = .normal }
        if mode == .normal {
            run {
                let sel = host.vimSelection
                setCursor(sel.location)
            }
        } else {
            changed()
        }
    }

    /// The selection changed outside the engine (a click, a drag, ⌘A, a find match): a selection
    /// is visual mode, a caret is normal mode.
    func selectionDidChange() {
        guard !isExecuting, let host, mode != .insert else { return }
        let sel = host.vimSelection
        refresh()
        if sel.length > 0 {
            guard sel != visualSelection || !mode.isVisual else { return }
            mode = .visual
            pending = []
            visualAnchor = sel.location
            visualCursor = max(sel.location, prev(NSMaxRange(sel)))
            visualSelection = sel
            changed()
        } else {
            if mode.isVisual {
                lastVisual = (visualAnchor, visualCursor, mode)
                mode = .normal
                changed()
            }
            let c = clamp(sel.location)
            if c != sel.location {
                isExecuting = true
                host.vimSetSelection(NSRange(location: c, length: 0), show: c)
                isExecuting = false
            }
        }
    }

    /// For tests: a register's content (nil or "\"": the unnamed register).
    func register(_ name: Character?) -> VimRegister? { read(name) }

    // MARK: Running

    private func run(_ body: () -> Void) {
        let was = isExecuting
        isExecuting = true
        refresh()
        commandStartText = t
        body()
        isExecuting = was
        changed()
    }

    private func refresh() {
        t = host?.vimText ?? ""
        folds = host?.vimFolds ?? HeadingFolds()
        markerLine = (0, 0, 0)
    }

    private func changed() { onChange?() }

    private func beep() { host?.vimBeep() }

    private func execute(_ cmd: VimCommand) {
        if mode.isVisual { executeVisual(cmd) } else { executeNormal(cmd) }
    }

    /// Remembers a change for `.` (one that enters insert mode once insert mode ends).
    private func record(_ cmd: VimCommand, entersInsert: Bool = false) {
        guard !replaying else { return }
        if entersInsert {
            insertCommand = cmd
        } else {
            lastChange = cmd
            insertCommand = nil
        }
    }

    /// Makes an insert session (the change that started it and everything typed) one step in
    /// the editor's own undo history, so `u`, Ctrl-R and ⌘Z treat it as one in every note: the
    /// editor's steps since `before` are undone and the whole change applied again as one edit.
    /// Nothing changes when the steps don't land on `before` or the edit is refused.
    private func squash(from before: NSString, caret: Int) {
        guard let host else { return }
        refresh()
        let after = t
        guard !before.isEqual(to: after as String) else { return }
        var steps = 0
        while !host.vimText.isEqual(to: before as String), steps < 1_000, host.vimUndo() { steps += 1 }
        let landed = host.vimText.isEqual(to: before as String)
        if landed, steps > 1 {
            // only the stretches that changed, so collapsed sections between them stay collapsed
            // (and come back on undo, as for any change of several stretches)
            let edits = TextMerge.edits(from: before as String, to: after as String)
            if !edits.isEmpty, host.vimApply(EditResult(edits: edits, selection: NSRange(location: caret, length: 0))) {
                refresh()
                return
            }
        }
        for _ in 0..<steps { _ = host.vimRedo() }
        refresh()
    }

    /// Remembers a visual-mode change for `.` with how much it covered.
    private func recordVisual(_ cmd: VimCommand, entersInsert: Bool = false) {
        let a = min(visualAnchor, visualCursor), b = max(visualAnchor, visualCursor)
        var lines = 1, l = lineStart(a)
        while l < lineStart(b), let nl = nextLine(l) {
            l = nl
            lines += 1
        }
        var c = cmd
        c.extent = VimExtent(mode: mode, lines: lines, width: max(1, characters(from: lines == 1 ? a : lineStart(b), to: next(b))))
        record(c, entersInsert: entersInsert)
    }

    private func characters(from a: Int, to b: Int) -> Int {
        var n = 0, p = a
        while p < b {
            p = next(p)
            n += 1
        }
        return n
    }

    private func lastCharOf(_ p: Int) -> Int {
        let ls = lineStart(p), lo = contentStart(ls), e = lineEnd(ls)
        return e > lo ? prev(e) : lo
    }

    private func executeNormal(_ cmd: VimCommand) {
        guard let host else { return }
        let cur = clamp(host.vimSelection.location)
        let n = cmd.count ?? 1
        if case .move = cmd.action {} else if case .scroll = cmd.action {} else { desiredColumn = nil }
        switch cmd.action {
        case .move(let m):
            guard let r = motion(m, from: cur, count: cmd.count, operator: false) else { return beep() }
            if r.searchHit, folds.hidesCaret(at: r.pos, in: t) != nil {
                host.vimReveal(r.pos)
                refresh()
            }
            if !r.vertical { desiredColumn = m.key == "$" ? Int.max : nil }
            setCursor(r.pos)

        case .op(let op, let target):
            guard let (range, linewise) = targetRange(target, op: op, from: cur, count: cmd.count) else { return beep() }
            if op != .yank { record(cmd, entersInsert: op == .change) }
            // ci{ on a block over several lines leaves a line to type on
            var keepLine = false
            if case .object(true, let kind) = target, VimEngine.brackets[kind] != nil, range.length > 0, NSMaxRange(range) < t.length,
               lineStart(range.location) == range.location, lineStart(NSMaxRange(range)) == NSMaxRange(range) {
                keepLine = true
            }
            perform(op, range: range, linewise: linewise, register: cmd.register, cursor: cur, keepLine: keepLine)

        case .put(let before):
            guard let reg = read(cmd.register), !reg.text.isEmpty else { return beep() }
            record(cmd)
            put(reg, before: before, count: n, cursor: cur)

        case .join(let spaces):
            record(cmd)
            join(from: lineStart(cur), lines: max(2, n), spaces: spaces)

        case .toggleCaseChar:
            let end = lineEnd(cur)
            var e = cur
            for _ in 0..<n where e < end { e = next(e) }
            guard e > cur else { return beep() }
            record(cmd)
            let r = NSRange(location: cur, length: e - cur)
            guard apply([TextEdit(range: r, replacement: VimEngine.toggledCase(t.substring(with: r)))], caret: cur) else { return }
            setCursor(e)

        case .replace(let c):
            let end = lineEnd(cur)
            var e = cur, k = 0
            while k < n, e < end {
                e = next(e)
                k += 1
            }
            guard k == n else { return beep() }
            record(cmd)
            let rep = c == "\n" ? "\n" : String(repeating: String(c), count: n)
            guard apply([TextEdit(range: NSRange(location: cur, length: e - cur), replacement: rep)], caret: cur) else { return }
            setCursor(c == "\n" ? cur + 1 : prev(cur + (rep as NSString).length))

        case .insert(let point):
            record(cmd, entersInsert: true)
            switch point {
            case .before: enterInsert(at: cur)
            case .after: enterInsert(at: cur < lineEnd(cur) ? next(cur) : cur)
            case .lineStart: enterInsert(at: firstNonBlank(lineStart(cur)))
            case .lineEnd: enterInsert(at: lineEnd(cur))
            case .below, .above: openLine(below: point == .below, cursor: cur)
            }
            if mode == .insert { insertRepeat = (n, point == .below || point == .above) }

        case .undo, .redo:
            for i in 0..<n {
                guard cmd.action == .undo ? host.vimUndo() : host.vimRedo() else {
                    if i == 0 { beep() }
                    break
                }
            }
            refresh()
            setCursor(host.vimSelection.location)

        case .repeatChange:
            guard var c = lastChange else { return beep() }
            if cmd.count != nil, c.extent == nil { c.count = cmd.count }
            replaying = true
            defer { replaying = false }
            if let x = c.extent {
                // a visual change: as much text again from the caret
                visualAnchor = cur
                var l = lineStart(cur)
                for _ in 1..<max(1, x.lines) {
                    guard let nl = nextLine(l) else { break }
                    l = nl
                }
                if x.mode == .visualLine {
                    visualCursor = l
                } else {
                    // the same number of characters (on the last line: up to the same column);
                    // a line too short for that is taken through its line break, like Vim
                    let from = x.lines <= 1 ? cur : l
                    let end = lineEnd(from)
                    var e = from
                    for _ in 1..<max(1, x.width) where e < end { e = next(e) }
                    visualCursor = e >= end && end < t.length ? end : clamp(e)
                }
                mode = x.mode
                executeVisual(c)
            } else {
                executeNormal(c)
            }
            if mode == .insert {
                let p = host.vimSelection.location
                if !lastInsert.isEmpty {
                    apply([TextEdit(range: NSRange(location: p, length: 0), replacement: lastInsert)], caret: p + (lastInsert as NSString).length)
                }
                leaveInsert()
            }

        case .visual(let m):
            visualAnchor = cur
            visualCursor = cur
            mode = m
            updateVisual()

        case .reselect:
            guard let lv = lastVisual else { return beep() }
            visualAnchor = min(lv.anchor, t.length)
            visualCursor = min(lv.cursor, t.length)
            mode = lv.mode
            updateVisual()

        case .scroll(let s):
            guard let p = host.vimScroll(s, count: n, caret: cur) else { return }
            refresh()
            setCursor(scrollTarget(s, p))

        case .fold(let a):
            fold(a, at: cur)

        case .surround(let target, let c):
            guard VimEngine.surroundPair(c) != nil else { return beep() }
            if target == .line {
                let ls = lineStart(cur)
                let s = firstNonBlank(ls)
                var e = lineEnd(ls)
                while e > s, isBlank(e - 1) { e -= 1 }
                guard e > s else { return beep() }
                record(cmd)
                addSurround(NSRange(location: s, length: e - s), linewise: false, c)
            } else {
                guard let (r, linewise) = targetRange(target, op: .yank, from: cur, count: cmd.count), r.length > 0 else { return beep() }
                record(cmd)
                addSurround(coverFolds(r), linewise: linewise, c)
            }

        case .deleteSurround(let c):
            guard let (o, cl) = surroundingPair(c, at: cur) else { return beep() }
            record(cmd)
            guard apply([TextEdit(range: o, replacement: ""), TextEdit(range: cl, replacement: "")], caret: o.location) else { return }
            setCursor(o.location)

        case .changeSurround(let from, let to):
            guard let pair = VimEngine.surroundPair(to), let (o, cl) = surroundingPair(from, at: cur) else { return beep() }
            record(cmd)
            guard apply([TextEdit(range: o, replacement: pair.open), TextEdit(range: cl, replacement: pair.close)], caret: o.location) else { return }
            setCursor(o.location)

        case .visualOp, .object, .swapEnds, .visualSurround:
            beep()
        }
    }

    private func executeVisual(_ cmd: VimCommand) {
        guard let host else { return }
        let n = cmd.count ?? 1
        switch cmd.action {
        case .move(let m):
            guard let r = motion(m, from: visualCursor, count: cmd.count, operator: false) else { return beep() }
            if r.searchHit, folds.hidesCaret(at: r.pos, in: t) != nil {
                host.vimReveal(r.pos)
                refresh()
            }
            if !r.vertical { desiredColumn = m.key == "$" ? Int.max : nil }
            visualCursor = clamp(r.pos, eol: desiredColumn == Int.max)
            updateVisual()

        case .object(let inner, let kind):
            guard let (r, linewise) = textObject(kind, inner: inner, at: visualCursor, count: n), r.length > 0 else { return beep() }
            if linewise { mode = .visualLine }
            visualAnchor = r.location
            visualCursor = max(r.location, prev(NSMaxRange(r)))
            updateVisual()

        case .visualOp(let op, let lines):
            let linewise = mode == .visualLine || lines
            let a = min(visualAnchor, visualCursor)
            let range = linewise ? linesRange(a, max(visualAnchor, visualCursor)) : visualRange()
            if op != .yank { recordVisual(cmd, entersInsert: op == .change) }
            leaveVisual()
            desiredColumn = nil
            perform(op, range: range, linewise: linewise, register: cmd.register, cursor: a,
                    times: op == .indent || op == .outdent ? n : 1)

        case .swapEnds:
            swap(&visualAnchor, &visualCursor)
            updateVisual()

        case .visual(let m):
            if m == mode {
                exitVisual(to: visualCursor)
            } else {
                mode = m
                updateVisual()
            }

        case .reselect:
            guard let lv = lastVisual else { return beep() }
            lastVisual = (visualAnchor, visualCursor, mode)
            visualAnchor = min(lv.anchor, t.length)
            visualCursor = min(lv.cursor, t.length)
            mode = lv.mode
            updateVisual()

        case .put(let before):
            guard let reg = read(cmd.register), !reg.text.isEmpty else { return beep() }
            let linewise = mode == .visualLine
            let r = coverFolds(visualRange())
            let replaced = t.substring(with: r)
            var text = reg.text
            if reg.linewise, !linewise { text = "\n" + text }
            if !reg.linewise, linewise { text += "\n" }
            recordVisual(cmd)
            leaveVisual()
            guard apply([TextEdit(range: r, replacement: text)], caret: r.location) else { return }
            if !before { store(nil, VimRegister(text: linewise ? VimEngine.withNewline(replaced) : replaced, linewise: linewise), yank: false) }
            setCursor(reg.linewise ? firstNonBlank(lineStart(r.location + (text.hasPrefix("\n") ? 1 : 0))) : prev(r.location + (text as NSString).length))

        case .replace(let c):
            let r = coverFolds(visualRange())
            var edits: [TextEdit] = []
            for seg in visibleSegments(r) {
                let old = t.substring(with: seg)
                let new = String(old.map { $0.isNewline ? $0 : c })
                if new != old { edits.append(TextEdit(range: seg, replacement: new)) }
            }
            recordVisual(cmd)
            leaveVisual()
            if !edits.isEmpty { guard apply(edits, caret: r.location) else { return } }
            setCursor(r.location)

        case .join(let spaces):
            let a = lineStart(min(visualAnchor, visualCursor)), b = lineStart(max(visualAnchor, visualCursor))
            var lines = 1, l = a
            while l < b, let nl = nextLine(l) {
                l = nl
                lines += 1
            }
            recordVisual(cmd)
            leaveVisual()
            join(from: a, lines: max(2, lines), spaces: spaces)

        case .visualSurround(let c):
            guard VimEngine.surroundPair(c) != nil else { return beep() }
            let linewise = mode == .visualLine
            let r = linewise ? linesRange(min(visualAnchor, visualCursor), max(visualAnchor, visualCursor)) : visualRange()
            recordVisual(cmd)
            leaveVisual()
            addSurround(coverFolds(r), linewise: linewise, c)

        case .scroll(let s):
            guard let p = host.vimScroll(s, count: n, caret: visualCursor) else { return }
            refresh()
            visualCursor = clamp(scrollTarget(s, p))
            updateVisual()

        default:
            beep()
        }
    }

    // MARK: Visual mode

    private func visualRange() -> NSRange {
        let a = min(visualAnchor, visualCursor), b = max(visualAnchor, visualCursor)
        if mode == .visualLine { return linesRange(a, b) }
        let e = b < t.length ? next(b) : t.length
        return NSRange(location: a, length: e - a)
    }

    /// Whole lines from the line of `a` through the line of `b` (a collapsed section included).
    private func linesRange(_ a: Int, _ b: Int) -> NSRange {
        let s = lineStart(a)
        return NSRange(location: s, length: lineFullEnd(b) - s)
    }

    private func updateVisual() {
        guard let host else { return }
        host.vimSetSelection(visualRange(), show: visualCursor)
        visualSelection = host.vimSelection
    }

    private func leaveVisual() {
        lastVisual = (visualAnchor, visualCursor, mode)
        mode = .normal
    }

    private func exitVisual(to p: Int) {
        leaveVisual()
        setCursor(p)
    }

    // MARK: Insert mode

    private func enterInsert(at p: Int) {
        guard let host else { return }
        host.vimSetSelection(NSRange(location: p, length: 0), show: p)
        mode = .insert
        insertStart = (p, t.length)
        insertBefore = commandStartText
    }

    /// What was typed since insert mode started, when that is all that happened.
    private func insertedText(upTo loc: Int) -> String {
        guard let s = insertStart, loc >= s.location, t.length - s.length == loc - s.location, loc <= t.length else { return "" }
        return t.substring(with: NSRange(location: s.location, length: loc - s.location))
    }

    /// o and O: a new line below (after a collapsed section, continuing a list) or above.
    private func openLine(below: Bool, cursor cur: Int) {
        let ls = lineStart(cur)
        let end = lineEnd(ls)
        let indent = rawIndent(ls)
        let line = MarkdownCommands.line(at: ls, in: t)
        if below {
            let caret = NSRange(location: end, length: 0)
            if let r = folds.newline(t, selection: caret) {
                guard apply(r.edits, caret: r.selection.location) else { return }
                return enterInsert(at: r.selection.location)
            }
            let content = t.substring(with: NSRange(location: line.contentStart, length: max(0, line.end - line.contentStart)))
            let emptyItem = (line.parsed.kind.isList || { if case .quote = line.parsed.kind { return true }; return false }())
                && content.trimmingCharacters(in: .whitespaces).isEmpty
            if !emptyItem, let r = MarkdownCommands.newline(t, selection: caret) {
                guard apply(r.edits, caret: r.selection.location) else { return }
                return enterInsert(at: r.selection.location)
            }
            let rep = "\n" + indent
            guard apply([TextEdit(range: caret, replacement: rep)], caret: end + (rep as NSString).length) else { return }
            enterInsert(at: end + (rep as NSString).length)
        } else {
            var prefix = indent
            if !line.inCode {
                switch line.parsed.kind {
                case .bullet, .task, .quote: prefix = MarkdownCommands.continuationPrefix(t, line)
                default: break
                }
            }
            guard apply([TextEdit(range: NSRange(location: ls, length: 0), replacement: prefix + "\n")], caret: ls + (prefix as NSString).length) else { return }
            enterInsert(at: ls + (prefix as NSString).length)
        }
    }

    // MARK: Operators

    /// The range an operator works on and whether it is linewise.
    private func targetRange(_ target: VimTarget, op: VimOperator, from cur: Int, count: Int?) -> (NSRange, Bool)? {
        switch target {
        case .line:
            var last = lineStart(cur)
            for _ in 1..<max(1, count ?? 1) {
                guard let nl = nextLine(last) else { break }
                last = nl
            }
            let s = lineStart(cur)
            return (NSRange(location: s, length: lineFullEnd(last) - s), true)

        case .object(let inner, let kind):
            return textObject(kind, inner: inner, at: cur, count: count ?? 1)

        case .motion(let m):
            let big = m.key == "W"
            if op == .change, m.key == "w" || big, cur < t.length, cls(cur, big) != 0 {
                // cw on a word changes to its end, like ce
                var e = cur
                for i in 0..<max(1, count ?? 1) {
                    if i == 0, next(e) >= lineEnd(e) || cls(next(e), big) != cls(e, big) { continue }
                    e = wordEnd(e, big: big)
                }
                return (NSRange(location: cur, length: next(e) - cur), false)
            }
            guard let r = motion(m, from: cur, count: count, operator: true) else {
                // s and cl on an empty line just start typing
                return op == .change && m.key == "l" ? (NSRange(location: cur, length: 0), false) : nil
            }
            switch r.kind {
            case .linewise:
                return (linesRange(min(cur, r.pos), max(cur, r.pos)), true)
            case .inclusive:
                let s = min(cur, r.pos), e = min(t.length, next(max(cur, r.pos)))
                return (NSRange(location: s, length: e - s), false)
            case .exclusive:
                let s = min(cur, r.pos)
                var e = max(cur, r.pos)
                // :help o_v: ending at the start of a line, it ends at the end of the line before;
                // started at or before the first non-blank, it takes whole lines
                if e > s, lineStart(e) == e, lineStart(s) < e {
                    let before = lineStart(e - 1)
                    if s <= firstNonBlank(lineStart(s)) { return (linesRange(s, before), true) }
                    e = max(s, lineEnd(before))
                }
                return (NSRange(location: s, length: e - s), false)
            }
        }
    }

    private func perform(_ op: VimOperator, range r0: NSRange, linewise: Bool, register: Character?, cursor cur: Int, times: Int = 1, keepLine: Bool = false) {
        let r = r0.length > 0 ? coverFolds(r0) : r0
        let s = t.substring(with: r)
        let reg = VimRegister(text: linewise ? VimEngine.withNewline(s) : s, linewise: linewise)
        switch op {
        case .yank:
            store(register, reg, yank: true)
            setCursor(linewise ? (r.location < lineStart(cur) ? r.location : cur) : min(cur, r.location))

        case .delete:
            guard r.length > 0 else { return }
            var dr = r
            // deleting the last lines takes the line break before them (unless that break ends
            // a collapsed section: then the empty last line stays)
            if linewise, NSMaxRange(dr) == t.length, dr.location > 0, !s.hasSuffix("\n"), folds.hiding(dr.location - 1) == nil {
                dr.location -= 1
                dr.length += 1
            }
            guard apply([TextEdit(range: dr, replacement: "")], caret: dr.location) else { return }
            store(register, reg, yank: false)
            setCursor(linewise ? firstNonBlank(lineStart(dr.location)) : dr.location)

        case .change:
            if linewise {
                // the first line keeps its indent and block marker, the last its line break
                let start = firstNonBlank(r.location)
                let e = max(NSMaxRange(r), start)
                // (replaced through the last break, so a collapsed section goes whole)
                let br = e > r.location && isLineBreak(e - 1) ? t.substring(with: NSRange(location: lineEnd(e - 1), length: e - lineEnd(e - 1))) : ""
                if e - start > (br as NSString).length {
                    guard apply([TextEdit(range: NSRange(location: start, length: e - start), replacement: br)], caret: start) else { return }
                }
                if r.length > 0 { store(register, reg, yank: false) }
                enterInsert(at: start)
            } else {
                let rep = keepLine ? rawIndent(r.location) + "\n" : ""
                let caret = r.location + max(0, (rep as NSString).length - 1)
                if r.length > 0 {
                    guard apply([TextEdit(range: r, replacement: rep)], caret: caret) else { return }
                    store(register, reg, yank: false)
                }
                enterInsert(at: caret)
            }

        case .indent, .outdent:
            let first = lineStart(r.location)
            let unit = MarkdownParser.indentUnit
            var edits: [TextEdit] = []
            var ls = first
            repeat {
                let b = lineBounds(ls)
                if folds.hiding(ls) == nil, b.contentsEnd > ls {
                    if op == .indent {
                        edits.append(TextEdit(range: NSRange(location: ls, length: 0), replacement: String(repeating: unit, count: times)))
                    } else {
                        var p = ls, removed = 0
                        while p < b.contentsEnd, removed < unit.count * times {
                            let u = t.character(at: p)
                            if u == 32 { removed += 1 } else if u == 9 { removed += unit.count } else { break }
                            p += 1
                        }
                        if p > ls { edits.append(TextEdit(range: NSRange(location: ls, length: p - ls), replacement: "")) }
                    }
                }
                guard b.end > ls else { break }
                ls = b.end
            } while ls < NSMaxRange(r) && ls < t.length
            if !edits.isEmpty { guard apply(edits, caret: first) else { return } }
            setCursor(firstNonBlank(first))

        case .toggleCase, .lowercase, .uppercase:
            var edits: [TextEdit] = []
            for seg in visibleSegments(r) {
                let old = t.substring(with: seg)
                let new = op == .lowercase ? old.lowercased() : op == .uppercase ? old.uppercased() : VimEngine.toggledCase(old)
                if new != old { edits.append(TextEdit(range: seg, replacement: new)) }
            }
            if !edits.isEmpty { guard apply(edits, caret: r.location) else { return } }
            setCursor(linewise ? cur : r.location)
        }
    }

    private func put(_ reg: VimRegister, before: Bool, count: Int, cursor cur: Int) {
        let text = String(repeating: reg.text, count: count)
        if reg.linewise {
            let at = before ? lineStart(cur) : lineFullEnd(cur)
            var ins = text
            var first = at
            if !before, at == t.length, at > 0, !isLineBreak(at - 1) {
                // after a last line without a line break
                ins = "\n" + String(text.dropLast())
                first = at + 1
            }
            guard apply([TextEdit(range: NSRange(location: at, length: 0), replacement: ins)], caret: first) else { return }
            setCursor(firstNonBlank(first))
        } else {
            let end = lineEnd(cur)
            let at = before || end == contentStart(lineStart(cur)) ? cur : min(next(cur), end)
            guard apply([TextEdit(range: NSRange(location: at, length: 0), replacement: text)], caret: at) else { return }
            setCursor(text.contains("\n") ? at : prev(at + (text as NSString).length))
        }
    }

    /// J and gJ: joins `lines` lines starting with the one at `ls0`. J drops the next line's
    /// indent and block marker and puts one space between. A collapsed heading isn't joined.
    private func join(from ls0: Int, lines: Int, spaces: Bool) {
        var ls = ls0, edits: [TextEdit] = [], delta = 0, caret = -1
        for _ in 1..<max(2, lines) {
            let b = lineBounds(ls)
            guard b.end > b.contentsEnd, folds.folding(from: b.end) == nil, let nl = nextLine(ls) else { break }
            let nb = lineBounds(nl)
            var rep = "", end = nl
            if spaces {
                end = contentStart(nl)
                while end < nb.contentsEnd, isBlank(end) { end += 1 }
                let emptyLine = b.contentsEnd == contentStart(ls)
                let endsBlank = b.contentsEnd > ls && isBlank(b.contentsEnd - 1)
                if end < nb.contentsEnd, !emptyLine, !endsBlank, t.character(at: end) != 41 { rep = " " }
            }
            edits.append(TextEdit(range: NSRange(location: b.contentsEnd, length: end - b.contentsEnd), replacement: rep))
            caret = b.contentsEnd + delta
            delta += (rep as NSString).length - (end - b.contentsEnd)
            ls = nl
        }
        guard !edits.isEmpty, caret >= 0 else { return beep() }
        guard apply(edits, caret: caret) else { return }
        setCursor(caret)
    }

    // MARK: Surround

    static func surroundPair(_ c: Character) -> (open: String, close: String)? {
        switch c {
        case "(": return ("( ", " )")
        case ")", "b": return ("(", ")")
        case "[": return ("[ ", " ]")
        case "]", "r": return ("[", "]")
        case "{": return ("{ ", " }")
        case "}", "B": return ("{", "}")
        case "<", ">", "a": return ("<", ">")
        default:
            guard !c.isLetter, !c.isNumber, !c.isWhitespace, !c.isNewline else { return nil }
            return (String(c), String(c))
        }
    }

    private static let brackets: [Character: (open: unichar, close: unichar)] = [
        "(": (40, 41), ")": (40, 41), "b": (40, 41), "[": (91, 93), "]": (91, 93), "r": (91, 93),
        "{": (123, 125), "}": (123, 125), "B": (123, 125), "<": (60, 62), ">": (60, 62), "a": (60, 62),
    ]

    private func addSurround(_ range: NSRange, linewise: Bool, _ c: Character) {
        guard let pair = VimEngine.surroundPair(c) else { return beep() }
        if linewise {
            // the delimiters on lines of their own
            let ls = range.location, e = NSMaxRange(range)
            let indent = rawIndent(ls)
            let open = pair.open.trimmingCharacters(in: .whitespaces), shut = pair.close.trimmingCharacters(in: .whitespaces)
            let close = e > ls && isLineBreak(e - 1) ? indent + shut + "\n" : "\n" + indent + shut
            guard apply([TextEdit(range: NSRange(location: ls, length: 0), replacement: indent + open + "\n"),
                         TextEdit(range: NSRange(location: e, length: 0), replacement: close)], caret: ls) else { return }
            setCursor(firstNonBlank(ls))
        } else {
            var r = range
            while r.length > 0, isBlank(NSMaxRange(r) - 1) || isLineBreak(NSMaxRange(r) - 1) { r.length -= 1 }
            guard r.length > 0 else { return beep() }
            guard apply([TextEdit(range: NSRange(location: r.location, length: 0), replacement: pair.open),
                         TextEdit(range: NSRange(location: NSMaxRange(r), length: 0), replacement: pair.close)], caret: r.location) else { return }
            setCursor(r.location)
        }
    }

    /// The delimiters around the caret for ds and cs: an enclosing bracket pair (an opening
    /// bracket also takes the blanks inside it), quotes on the line, or the nearest other mark
    /// (*, _, ~…) before and after the caret on the line.
    private func surroundingPair(_ c: Character, at cur: Int) -> (NSRange, NSRange)? {
        if let b = VimEngine.brackets[c] {
            guard let (o, cl) = enclosingBracket(b.open, b.close, at: cur, count: 1) else { return nil }
            var open = NSRange(location: o, length: 1), close = NSRange(location: cl, length: 1)
            if "([{<".contains(c) {
                var e = o + 1
                while e < cl, isBlank(e) { e += 1 }
                open.length = e - o
                var s = cl
                while s > NSMaxRange(open), isBlank(s - 1) { s -= 1 }
                close = NSRange(location: s, length: cl + 1 - s)
            }
            return (open, close)
        }
        guard VimEngine.surroundPair(c) != nil, c.utf16.count == 1, let u = c.utf16.first else { return nil }
        if "\"'`".contains(c) {
            guard let (o, cl) = quotePair(u, at: cur) else { return nil }
            return (NSRange(location: o, length: 1), NSRange(location: cl, length: 1))
        }
        let b = lineBounds(cur)
        var before: Int?, after: Int?
        var i = b.start
        while i < cur {
            if t.character(at: i) == u { before = i }
            i += 1
        }
        i = cur
        while i < b.contentsEnd {
            if t.character(at: i) == u, before != nil || i > cur {
                after = i
                break
            }
            if t.character(at: i) == u, before == nil { before = i }
            i += 1
        }
        guard let o = before, let cl = after, o < cl else { return nil }
        return (NSRange(location: o, length: 1), NSRange(location: cl, length: 1))
    }

    // MARK: Folds and scrolling

    private func fold(_ a: VimFoldAction, at cur: Int) {
        guard let host else { return }
        let ls = lineStart(cur)
        var heading: Int? = isHeading(ls) ? ls : nil
        if heading == nil, a != .open {
            // the section the caret is in
            var l = ls, k = 0
            while k < 5000, let pl = prevLine(l) {
                l = pl
                k += 1
                if isHeading(l) {
                    heading = l
                    break
                }
            }
        }
        guard let h = heading else { return beep() }
        let collapsed = folds.isCollapsed(h)
        if a == .open && !collapsed || a == .close && collapsed { return beep() }
        guard host.vimToggleHeading(h) else { return beep() }
        refresh()
        setCursor(host.vimSelection.location)
    }

    private func isHeading(_ ls: Int) -> Bool {
        guard ls < t.length else { return false }
        let l = MarkdownCommands.line(at: ls, in: t)
        return !l.inCode && l.parsed.kind.isHeading
    }

    private func scrollTarget(_ s: VimScroll, _ p: Int) -> Int {
        switch s {
        case .halfDown, .halfUp, .pageDown, .pageUp: return firstNonBlank(visibleLineStart(lineStart(p)))
        default: return p
        }
    }

    // MARK: Registers

    static func isRegisterName(_ c: Character) -> Bool {
        (c.isASCII && (c.isLetter || c.isNumber)) || "\"-_+*".contains(c)
    }

    private func store(_ name: Character?, _ r: VimRegister, yank: Bool) {
        switch name {
        case "_":
            return
        case "+", "*":
            host?.vimClipboard = r.text
            unnamed = r
        case let c? where c.isLetter:
            let k = Character(c.lowercased())
            if c.isUppercase, let old = registers[k] {
                var text = old.text
                if r.linewise, !old.linewise { text += "\n" }
                text += r.text
                if old.linewise, !r.linewise { text += "\n" }
                registers[k] = VimRegister(text: text, linewise: old.linewise || r.linewise)
            } else {
                registers[k] = r
            }
            unnamed = registers[k]
        case let c? where c.isNumber || c == "-":
            registers[c] = r
            unnamed = r
        default:
            unnamed = r
            if yank {
                registers["0"] = r
            } else if r.linewise || r.text.contains("\n") {
                for d in stride(from: 9, to: 1, by: -1) { registers[Character(String(d))] = registers[Character(String(d - 1))] }
                registers["1"] = r
            } else {
                registers["-"] = r
            }
        }
    }

    private func read(_ name: Character?) -> VimRegister? {
        switch name {
        case nil, "\"":
            return unnamed
        case "+", "*":
            guard let s = host?.vimClipboard, !s.isEmpty else { return nil }
            return VimRegister(text: s, linewise: s.hasSuffix("\n"))
        case let c?:
            return registers[c.isLetter ? Character(c.lowercased()) : c]
        }
    }

    static func withNewline(_ s: String) -> String { s.hasSuffix("\n") ? s : s + "\n" }

    static func toggledCase(_ s: String) -> String {
        String(s.flatMap { c -> String in
            c.isUppercase ? c.lowercased() : c.isLowercase ? c.uppercased() : String(c)
        })
    }

    // MARK: Edits and the caret

    @discardableResult
    private func apply(_ edits: [TextEdit], caret: Int) -> Bool {
        guard let host else { return false }
        guard host.vimApply(EditResult(edits: edits, selection: NSRange(location: max(0, caret), length: 0))) else {
            beep()
            return false
        }
        refresh()
        return true
    }

    /// Puts the caret on a character (on the line's end only with `eol`), out of hidden lines.
    private func setCursor(_ p: Int, eol: Bool = false) {
        guard let host else { return }
        let c = clamp(p, eol: eol)
        host.vimSetSelection(NSRange(location: c, length: 0), show: c)
        let actual = host.vimSelection
        // the editor moved it (out of a collapsed section): onto a character there
        if actual.location != c, actual.length == 0 {
            let c2 = clamp(actual.location)
            if c2 != actual.location { host.vimSetSelection(NSRange(location: c2, length: 0), show: c2) }
        }
    }

    /// Where the caret may be in normal mode: on a character of its line (not before a hidden
    /// block marker, not on the line break unless `eol` or the line is empty).
    private func clamp(_ p0: Int, eol: Bool = false) -> Int {
        let len = t.length
        guard len > 0 else { return 0 }
        var p = min(max(0, p0), len)
        let ls = lineStart(p)
        let b = lineBounds(ls)
        let lo = contentStart(ls)
        let hi = eol ? b.contentsEnd : max(lo, b.contentsEnd > lo ? prev(b.contentsEnd) : lo)
        p = min(max(p, lo), hi)
        if p < b.contentsEnd { p = max(lo, t.rangeOfComposedCharacterSequence(at: p).location) }
        return p
    }

    // MARK: Lines

    private func lineBounds(_ p: Int) -> (start: Int, end: Int, contentsEnd: Int) {
        var s = 0, e = 0, c = 0
        t.getLineStart(&s, end: &e, contentsEnd: &c, for: NSRange(location: min(max(0, p), t.length), length: 0))
        return (s, e, c)
    }

    private func lineStart(_ p: Int) -> Int { lineBounds(p).start }
    private func lineEnd(_ p: Int) -> Int { lineBounds(p).contentsEnd }

    /// The end of the line including its break, and a collapsed section after it.
    private func lineFullEnd(_ p: Int) -> Int {
        let b = lineBounds(p)
        if b.end > b.contentsEnd, let f = folds.folding(from: b.end) { return NSMaxRange(f.body) }
        return b.end
    }

    private func contentStart(_ ls: Int) -> Int {
        let end = lineEnd(ls)
        return min(max(ls, host?.vimContentStart(ls) ?? ls), end)
    }

    private func firstNonBlank(_ ls: Int) -> Int {
        let start = lineStart(ls)
        var p = contentStart(start)
        let end = lineEnd(start)
        while p < end, isBlank(p) { p += 1 }
        return p
    }

    private func rawIndent(_ ls: Int) -> String {
        var p = ls
        let end = lineEnd(ls)
        while p < end, isBlank(p) { p += 1 }
        return t.substring(with: NSRange(location: ls, length: p - ls))
    }

    /// The start of the next visible line (after a collapsed section), nil on the last one.
    private func nextLine(_ ls: Int) -> Int? {
        let b = lineBounds(ls)
        guard b.end > b.contentsEnd else { return nil }
        var n = b.end
        if let f = folds.hiding(n) {
            n = NSMaxRange(f.body)
            if n == t.length, n > 0, !isLineBreak(n - 1) { return nil }
        }
        return n
    }

    /// The start of the previous visible line (a collapsed section's heading), nil on the first.
    private func prevLine(_ ls: Int) -> Int? {
        guard ls > 0 else { return nil }
        var p = lineStart(ls - 1)
        if let f = folds.hiding(p) {
            guard f.body.location > 0 else { return nil }
            p = lineStart(f.body.location - 1)
        }
        return p
    }

    /// The line itself, or the heading of the collapsed section hiding it.
    private func visibleLineStart(_ ls: Int) -> Int {
        guard let f = folds.hidesCaret(at: ls, in: t) else { return ls }
        return lineStart(HeadingFolds.lineEndBefore(f, in: t))
    }

    /// A position on hidden lines moved off them: past them going forward, else to the end of
    /// the heading's line.
    private func skipHidden(_ p: Int, forward: Bool) -> Int {
        guard let f = folds.hidesCaret(at: p, in: t) else { return p }
        let e = NSMaxRange(f.body)
        if forward, e < t.length || (e > 0 && isLineBreak(e - 1)) { return e }
        return HeadingFolds.lineEndBefore(f, in: t)
    }

    /// Grows a range that changes collapsed lines partly so it takes them whole.
    private func coverFolds(_ r0: NSRange) -> NSRange {
        var r = r0
        for _ in 0..<8 {
            let partial = folds.blocks(changedBy: r, in: t)
            guard !partial.isEmpty else { break }
            for f in partial {
                let s = min(r.location, HeadingFolds.lineEndBefore(f, in: t)), e = max(NSMaxRange(r), NSMaxRange(f.body))
                r = NSRange(location: s, length: e - s)
            }
        }
        return r
    }

    /// The parts of `r` that aren't hidden (nor the line break before hidden lines).
    private func visibleSegments(_ r: NSRange) -> [NSRange] {
        var out: [NSRange] = []
        var p = r.location
        for h in folds.hiddenRanges(in: r) {
            var g = h.location
            if g > 0, t.character(at: g - 1) == 10 { g -= 1 }
            if g > 0, t.character(at: g - 1) == 13 { g -= 1 }
            if g > p { out.append(NSRange(location: p, length: g - p)) }
            p = max(p, NSMaxRange(h))
        }
        if NSMaxRange(r) > p { out.append(NSRange(location: p, length: NSMaxRange(r) - p)) }
        return out
    }

    private func column(in ls: Int, from cur: Int) -> Int {
        let col = desiredColumn ?? max(0, cur - contentStart(lineStart(cur)))
        desiredColumn = col
        let end = lineEnd(ls)
        if col == Int.max { return end }
        let p = min(contentStart(ls) + col, end)
        return p < end ? t.rangeOfComposedCharacterSequence(at: p).location : p
    }

    private func isEmptyLine(_ ls: Int) -> Bool { lineEnd(ls) == ls }

    private func isBlankLine(_ ls: Int) -> Bool {
        var p = ls
        let end = lineEnd(ls)
        while p < end, isBlank(p) { p += 1 }
        return p == end
    }

    private func lineStart(ofLine number: Int) -> Int {
        var p = 0, k = 1
        while k < number {
            let b = lineBounds(p)
            guard b.end > b.contentsEnd else { break }
            p = b.end
            k += 1
        }
        return p
    }

    private func lineCount() -> Int {
        var n = 1, p = 0
        while true {
            let b = lineBounds(p)
            guard b.end > b.contentsEnd else { return n }
            p = b.end
            n += 1
        }
    }

    // MARK: Characters

    private func next(_ p: Int) -> Int { p >= t.length ? t.length : NSMaxRange(t.rangeOfComposedCharacterSequence(at: p)) }
    private func prev(_ p: Int) -> Int { p <= 0 ? 0 : t.rangeOfComposedCharacterSequence(at: min(p, t.length) - 1).location }
    private func isBlank(_ i: Int) -> Bool { let u = t.character(at: i); return u == 32 || u == 9 }
    private func isLineBreak(_ i: Int) -> Bool { let u = t.character(at: i); return u == 10 || u == 13 }

    /// 0: blank or line break, 1: punctuation, 2: word character. WORDs (`big`) are 0 or 2.
    /// A hidden block marker ("## ", "- [ ] ", "1. ") counts as blank.
    private func cls(_ i: Int, _ big: Bool) -> Int {
        let u = t.character(at: i)
        if u == 32 || u == 9 || u == 10 || u == 13 || u == 0xA0 { return 0 }
        let word = VimEngine.isWordChar(u)
        if !word || (u >= 48 && u <= 57) || u == 120 || u == 88, inMarker(i) { return 0 }
        if big { return 2 }
        return word ? 2 : 1
    }

    private func inMarker(_ i: Int) -> Bool {
        if i < markerLine.start || i >= markerLine.end {
            let b = lineBounds(i)
            markerLine = (b.start, max(b.end, i + 1), contentStart(b.start))
        }
        return i < markerLine.content
    }

    static func isWordChar(_ u: unichar) -> Bool {
        if u < 0x80 { return (u >= 48 && u <= 57) || (u >= 65 && u <= 90) || (u >= 97 && u <= 122) || u == 95 }
        if UTF16.isLeadSurrogate(u) || UTF16.isTrailSurrogate(u) { return true }
        guard let s = Unicode.Scalar(u) else { return true }
        return CharacterSet.alphanumerics.contains(s)
    }

    /// The start of an empty line (a word of its own for w and b).
    private func isEmptyLineStart(_ i: Int) -> Bool {
        if i >= t.length { return i > 0 && t.character(at: i - 1) == 10 }
        return isLineBreak(i) && (i == 0 || t.character(at: i - 1) == 10)
    }
}

// MARK: - Motions

extension VimEngine {
    fileprivate struct MotionResult {
        enum Kind { case exclusive, inclusive, linewise }
        var pos: Int
        var kind: Kind
        var vertical = false
        var searchHit = false
    }

    // swiftlint:disable:next cyclomatic_complexity function_body_length
    fileprivate func motion(_ m: VimMotion, from cur: Int, count: Int?, operator op: Bool) -> MotionResult? {
        let n = max(1, count ?? 1)
        let ls = lineStart(cur)
        switch m.key {
        case "h":
            var p = cur
            let lo = contentStart(ls)
            for _ in 0..<n where p > lo { p = prev(p) }
            return p == cur ? nil : MotionResult(pos: p, kind: .exclusive)
        case "l":
            var p = cur
            let end = lineEnd(cur)
            for _ in 0..<n where p < end { p = next(p) }
            if !op { p = clamp(p) }
            return p == cur ? nil : MotionResult(pos: p, kind: .exclusive)
        case "j", "k":
            var l = ls, moved = 0
            for _ in 0..<n {
                guard let nl = m.key == "j" ? nextLine(l) : prevLine(l) else { break }
                l = nl
                moved += 1
            }
            guard moved > 0 else { return nil }
            return MotionResult(pos: column(in: l, from: cur), kind: .linewise, vertical: true)
        case "+", "-", "_":
            var l = ls
            for _ in 0..<(m.key == "_" ? n - 1 : n) {
                guard let nl = m.key == "-" ? prevLine(l) : nextLine(l) else { return nil }
                l = nl
            }
            return MotionResult(pos: firstNonBlank(l), kind: .linewise)
        case "w", "W":
            let big = m.key == "W"
            var p = cur
            for i in 0..<n {
                guard p < t.length else { break }
                var np = wordForward(p, big: big)
                // with an operator, a word that ends its line ends the range there (:help word)
                if op, i == n - 1, lineStart(np) > lineStart(p), lineEnd(p) > p { np = lineEnd(p) }
                p = np
            }
            return p == cur ? nil : MotionResult(pos: skipHidden(p, forward: true), kind: .exclusive)
        case "b", "B":
            var p = cur
            for _ in 0..<n { p = wordBackward(p, big: m.key == "B") }
            return p == cur ? nil : MotionResult(pos: skipHidden(p, forward: false), kind: .exclusive)
        case "e", "E":
            var p = cur
            for _ in 0..<n { p = wordEnd(p, big: m.key == "E") }
            // at the end of the last word: an operator still takes its last character
            if p == cur { return op && cur < t.length && cls(cur, m.key == "E") != 0 ? MotionResult(pos: cur, kind: .inclusive) : nil }
            return MotionResult(pos: skipHidden(p, forward: true), kind: .inclusive)
        case "ge", "gE":
            var p = cur
            for _ in 0..<n { p = wordEndBackward(p, big: m.key == "gE") }
            return p == cur ? nil : MotionResult(pos: skipHidden(p, forward: false), kind: .inclusive)
        case "0":
            return MotionResult(pos: contentStart(ls), kind: .exclusive)
        case "^":
            return MotionResult(pos: firstNonBlank(ls), kind: .exclusive)
        case "$", "g_":
            var l = ls
            for _ in 1..<n {
                guard let nl = nextLine(l) else { break }
                l = nl
            }
            if m.key == "$" { return MotionResult(pos: lineEnd(l), kind: .exclusive) }
            var e = lineEnd(l)
            let lo = contentStart(l)
            while e > lo, isBlank(e - 1) { e -= 1 }
            return e > lo ? MotionResult(pos: prev(e), kind: .inclusive) : MotionResult(pos: lo, kind: .exclusive)
        case "|":
            var p = contentStart(ls)
            let end = lineEnd(ls)
            for _ in 1..<n where p < end { p = next(p) }
            return MotionResult(pos: p, kind: .exclusive)
        case "gg", "G":
            let target = count.map { lineStart(ofLine: $0) } ?? (m.key == "gg" ? 0 : lineStart(t.length))
            return MotionResult(pos: firstNonBlank(visibleLineStart(target)), kind: .linewise)
        case "H", "M", "L":
            guard let p0 = host?.vimScreenLine(m.key == "H" ? .top : m.key == "M" ? .middle : .bottom) else { return nil }
            var l = visibleLineStart(lineStart(p0))
            if m.key != "M" {
                for _ in 1..<n {
                    guard let nl = m.key == "H" ? nextLine(l) : prevLine(l) else { break }
                    l = nl
                }
            }
            return MotionResult(pos: firstNonBlank(l), kind: .linewise)
        case "}", "{":
            return paragraph(forward: m.key == "}", count: n, from: ls)
        case "%":
            if let count {
                guard count <= 100 else { return nil }
                let line = (count * lineCount() + 99) / 100
                return MotionResult(pos: firstNonBlank(visibleLineStart(lineStart(ofLine: line))), kind: .linewise)
            }
            return matchingBracket(from: cur).map { MotionResult(pos: skipHidden($0, forward: $0 > cur), kind: .inclusive) }
        case "f", "F", "t", "T":
            guard let c = m.char, let k = m.key.first else { return nil }
            lastFind = (k, c)
            return find(k, c, count: n, from: cur, again: false)
        case ";", ",":
            guard let lf = lastFind else { return nil }
            var k = lf.key
            if m.key == "," { k = ["f": "F", "F": "f", "t": "T", "T": "t"][k] ?? k }
            return find(k, lf.char, count: n, from: cur, again: true)
        case "/", "?":
            var pattern = m.pattern ?? ""
            if pattern.isEmpty {
                guard let last = lastSearch else { return nil }
                pattern = last.pattern
            }
            lastSearch = (pattern, m.key == "/", false)
            return search(pattern, forward: m.key == "/", word: false, from: cur, count: n)
        case "n", "N":
            guard let s = lastSearch else { return nil }
            return search(s.pattern, forward: m.key == "n" ? s.forward : !s.forward, word: s.word, from: cur, count: n)
        case "*", "#":
            guard let w = keyword(at: cur) else { return nil }
            let pattern = t.substring(with: w)
            lastSearch = (pattern, m.key == "*", true)
            return search(pattern, forward: m.key == "*", word: true, from: w.location, count: n)
        default:
            return nil
        }
    }

    // MARK: Words

    fileprivate func wordForward(_ p0: Int, big: Bool) -> Int {
        let len = t.length
        var i = p0
        guard i < len else { return len }
        let c = cls(i, big)
        if c != 0 { while i < len, cls(i, big) == c { i += 1 } }
        while i < len, cls(i, big) == 0 {
            if t.character(at: i) == 10 {
                i += 1
                if isEmptyLineStart(i) { return i }
                continue
            }
            i += 1
        }
        return i
    }

    fileprivate func wordEnd(_ p0: Int, big: Bool) -> Int {
        let len = t.length
        var i = next(p0)
        while i < len, cls(i, big) == 0 { i += 1 }
        guard i < len else { return p0 }
        let c = cls(i, big)
        while i + 1 < len, cls(i + 1, big) == c { i += 1 }
        return t.rangeOfComposedCharacterSequence(at: i).location
    }

    fileprivate func wordBackward(_ p0: Int, big: Bool) -> Int {
        guard p0 > 0 else { return 0 }
        var i = prev(p0)
        while i > 0, cls(i, big) == 0 {
            if isEmptyLineStart(i) { return i }
            i -= 1
        }
        if cls(i, big) == 0 { return i }
        let c = cls(i, big)
        while i > 0, cls(i - 1, big) == c { i -= 1 }
        return i
    }

    fileprivate func wordEndBackward(_ p0: Int, big: Bool) -> Int {
        var i = min(p0, t.length)
        guard i > 0 else { return 0 }
        if i < t.length, cls(i, big) != 0 {
            let c = cls(i, big)
            while i > 0, cls(i, big) == c { i -= 1 }
            if cls(i, big) == c { return 0 }
        } else if i == t.length {
            i -= 1
        }
        while i > 0, cls(i, big) == 0 {
            if isEmptyLineStart(i), i < p0 { return i }
            i -= 1
        }
        return t.rangeOfComposedCharacterSequence(at: i).location
    }

    // MARK: Paragraphs, brackets, find, search

    fileprivate func paragraph(forward: Bool, count: Int, from ls: Int) -> MotionResult {
        var l = ls
        for _ in 0..<count {
            var c = l
            let step: (Int) -> Int? = forward ? { self.nextLine($0) } : { self.prevLine($0) }
            while isEmptyLine(c), let nl = step(c) { c = nl }
            var found: Int?
            while let nl = step(c) {
                c = nl
                if isEmptyLine(c) {
                    found = c
                    break
                }
            }
            guard let f = found else { return MotionResult(pos: forward ? lineEnd(c) : 0, kind: .exclusive) }
            l = f
        }
        return MotionResult(pos: l, kind: .exclusive)
    }

    fileprivate func matchingBracket(from cur: Int) -> Int? {
        let end = lineEnd(cur)
        let pairs: [unichar: (unichar, Bool)] = [40: (41, true), 91: (93, true), 123: (125, true), 41: (40, false), 93: (91, false), 125: (123, false)]
        var p = cur
        while p < end, pairs[t.character(at: p)] == nil { p += 1 }
        guard p < end, let (other, forward) = pairs[t.character(at: p)] else { return nil }
        let me = t.character(at: p)
        var depth = 0, i = p
        while i >= 0, i < t.length {
            let u = t.character(at: i)
            if u == me { depth += 1 } else if u == other {
                depth -= 1
                if depth == 0 { return i }
            }
            i += forward ? 1 : -1
        }
        return nil
    }

    fileprivate func find(_ k: Character, _ c: Character, count: Int, from cur: Int, again: Bool) -> MotionResult? {
        let b = lineBounds(cur)
        let lo = contentStart(b.start)
        let target = String(c)
        let unit: unichar? = c.utf16.count == 1 ? c.utf16.first : nil
        func matches(_ i: Int) -> Bool {
            if let unit { return t.character(at: i) == unit }
            return t.substring(with: t.rangeOfComposedCharacterSequence(at: i)) == target
        }
        var found = 0
        if k == "f" || k == "t" {
            var i = next(cur)
            // ; after t doesn't stay put before the same character
            if k == "t", again, i < b.contentsEnd, matches(i) { i = next(i) }
            while i < b.contentsEnd {
                if matches(i) {
                    found += 1
                    if found == count { return MotionResult(pos: k == "f" ? i : prev(i), kind: .inclusive) }
                }
                i = next(i)
            }
            return nil
        }
        guard cur > lo else { return nil }
        var i = prev(cur)
        if k == "T", again, i > lo, matches(i) { i = prev(i) }
        while true {
            if matches(i) {
                found += 1
                if found == count { return MotionResult(pos: k == "F" ? i : next(i), kind: .exclusive) }
            }
            if i <= lo { return nil }
            i = prev(i)
        }
    }

    /// Literal search, case-insensitive unless the pattern has a capital (smartcase), wrapping
    /// around the end. `word`: whole words only (* and #).
    fileprivate func search(_ pattern: String, forward: Bool, word: Bool, from p: Int, count: Int) -> MotionResult? {
        guard !pattern.isEmpty else { return nil }
        let opts: NSString.CompareOptions = pattern.lowercased() == pattern ? [.caseInsensitive] : []
        let len = t.length
        func valid(_ r: NSRange) -> Bool {
            guard word else { return true }
            let before = r.location == 0 || !VimEngine.isWordChar(t.character(at: r.location - 1))
            let after = NSMaxRange(r) >= len || !VimEngine.isWordChar(t.character(at: NSMaxRange(r)))
            return before && after
        }
        func first(after s: Int) -> Int? {
            var r = NSRange(location: min(s, len), length: len - min(s, len))
            while r.length > 0 {
                let m = t.range(of: pattern, options: opts, range: r)
                guard m.location != NSNotFound else { return nil }
                if valid(m) { return m.location }
                r = NSRange(location: m.location + 1, length: len - m.location - 1)
            }
            return nil
        }
        func last(before s: Int) -> Int? {
            var r = NSRange(location: 0, length: len)
            while r.length > 0 {
                let m = t.range(of: pattern, options: opts.union(.backwards), range: r)
                guard m.location != NSNotFound else { return nil }
                if m.location < s, valid(m) { return m.location }
                r = NSRange(location: 0, length: NSMaxRange(m) - 1)
            }
            return nil
        }
        var pos = p
        for _ in 0..<count {
            guard let f = forward ? (first(after: pos + 1) ?? first(after: 0)) : (last(before: pos) ?? last(before: len + 1)) else { return nil }
            pos = f
        }
        return MotionResult(pos: pos, kind: .exclusive, searchHit: true)
    }

    /// The keyword under or after the caret on its line (for * and #).
    fileprivate func keyword(at cur: Int) -> NSRange? {
        let b = lineBounds(cur)
        var p = cur
        while p < b.contentsEnd, !VimEngine.isWordChar(t.character(at: p)) { p += 1 }
        guard p < b.contentsEnd else { return nil }
        var s = p, e = p
        while s > b.start, VimEngine.isWordChar(t.character(at: s - 1)) { s -= 1 }
        while e < b.contentsEnd, VimEngine.isWordChar(t.character(at: e)) { e += 1 }
        return NSRange(location: s, length: e - s)
    }
}

// MARK: - Text objects

extension VimEngine {
    fileprivate func textObject(_ kind: Character, inner: Bool, at cur: Int, count: Int) -> (NSRange, Bool)? {
        switch kind {
        case "w", "W": return wordObject(at: cur, inner: inner, big: kind == "W", count: count).map { ($0, false) }
        case "p": return paragraphObject(at: cur, inner: inner, count: count).map { ($0, true) }
        case "\"", "'", "`": return quoteObject(kind, at: cur, inner: inner).map { ($0, false) }
        default:
            guard let b = VimEngine.brackets[kind], let (o, c) = enclosingBracket(b.open, b.close, at: cur, count: count) else { return nil }
            if !inner { return (NSRange(location: o, length: c - o + 1), false) }
            var s = o + 1, e = c
            // a block over several lines: its lines, not the breaks after "{" and before "}"
            if s < e, isLineBreak(s) { s = lineBounds(s).end }
            if e > s, lineStart(e) > s, rawIndent(lineStart(e)).utf16.count == e - lineStart(e) { e = lineStart(e) }
            return (NSRange(location: min(s, e), length: max(0, e - s)), false)
        }
    }

    private func wordObject(at cur: Int, inner: Bool, big: Bool, count: Int) -> NSRange? {
        let b = lineBounds(cur)
        let lo = contentStart(b.start)
        guard b.contentsEnd > lo else { return nil }
        let p = min(cur, prev(b.contentsEnd))
        func runStart(_ i: Int, _ c: Int) -> Int {
            var s = i
            while s > lo, cls(s - 1, big) == c { s -= 1 }
            return s
        }
        func runEnd(_ i: Int, _ c: Int) -> Int {
            var e = i
            while e < b.contentsEnd, cls(e, big) == c { e += 1 }
            return e
        }
        let c = cls(p, big)
        var s = runStart(p, c), e = runEnd(p, c)
        // with a count it goes on past the line's end (line breaks are blanks)
        let len = t.length
        func runOn(_ i: Int, _ c: Int) -> Int {
            var e = i
            while e < len, cls(e, big) == c { e += 1 }
            return e
        }
        if inner {
            // each count takes the next word or blanks
            for _ in 1..<max(1, count) where e < len { e = runOn(e, cls(e, big)) }
            return NSRange(location: s, length: e - s)
        }
        if count > 1 {
            // count times a word and its blanks (blanks and a word when it started on blanks)
            for i in 0..<count {
                if c == 0 {
                    if i > 0 { e = runOn(e, 0) }
                    if e < len { e = runOn(e, cls(e, big)) }
                } else {
                    if i > 0, e < len { e = runOn(e, cls(e, big)) }
                    e = runOn(e, 0)
                }
            }
            return NSRange(location: s, length: e - s)
        }
        if c == 0 {
            if e < b.contentsEnd { e = runEnd(e, cls(e, big)) }
        } else {
            let e2 = runEnd(e, 0)
            if e2 > e {
                e = e2
            } else {
                // no blanks after: the ones before (unless they're the indent)
                let s2 = runStart(s, 0)
                if s2 < s, s2 > lo { s = s2 }
            }
        }
        return NSRange(location: s, length: e - s)
    }

    private func paragraphObject(at cur: Int, inner: Bool, count: Int) -> NSRange? {
        let l0 = lineStart(cur)
        let blank = isBlankLine(l0)
        var first = l0, last = l0
        while let pl = prevLine(first), isBlankLine(pl) == blank { first = pl }
        while let nl = nextLine(last), isBlankLine(nl) == blank { last = nl }
        if !inner {
            if blank {
                while let nl = nextLine(last), !isBlankLine(nl) { last = nl }
            } else {
                var l = last, grew = false
                while let nl = nextLine(l), isBlankLine(nl) {
                    l = nl
                    grew = true
                }
                if grew {
                    last = l
                } else {
                    while let pl = prevLine(first), isBlankLine(pl) { first = pl }
                }
            }
        }
        // each count takes the next run of lines (a paragraph and its blank lines for ap)
        func nextRun(_ l: Int) -> Int? {
            guard let nl = nextLine(l) else { return nil }
            let blank = isBlankLine(nl)
            var e = nl
            while let n2 = nextLine(e), isBlankLine(n2) == blank { e = n2 }
            return e
        }
        for _ in 1..<max(1, count) {
            guard let e = nextRun(last) else { break }
            last = e
            if !inner, let e2 = nextRun(last) { last = e2 }
        }
        return NSRange(location: first, length: lineFullEnd(last) - first)
    }

    /// The quotes around (or after) the caret on its line, like Vim: on a quote, counting
    /// the quotes before it tells whether it opens or closes.
    fileprivate func quotePair(_ q: unichar, at cur: Int) -> (Int, Int)? {
        let b = lineBounds(cur)
        var qs: [Int] = []
        var i = b.start
        while i < b.contentsEnd {
            let u = t.character(at: i)
            if u == 92 {
                i += 2
                continue
            }
            if u == q { qs.append(i) }
            i += 1
        }
        if let k = qs.firstIndex(of: cur) {
            if k % 2 == 1 { return (qs[k - 1], qs[k]) }
            return k + 1 < qs.count ? (qs[k], qs[k + 1]) : nil
        }
        let before = qs.filter { $0 < cur }.count
        if before % 2 == 1, before < qs.count { return (qs[before - 1], qs[before]) }
        if before % 2 == 0, before + 1 < qs.count { return (qs[before], qs[before + 1]) }
        return nil
    }

    private func quoteObject(_ q: Character, at cur: Int, inner: Bool) -> NSRange? {
        guard let u = q.utf16.first, let (o, c) = quotePair(u, at: cur) else { return nil }
        if inner { return NSRange(location: o + 1, length: c - o - 1) }
        let b = lineBounds(cur)
        var s = o, e = c + 1, e2 = e
        while e2 < b.contentsEnd, isBlank(e2) { e2 += 1 }
        if e2 > e {
            e = e2
        } else {
            while s > b.start, isBlank(s - 1) { s -= 1 }
        }
        return NSRange(location: s, length: e - s)
    }

    /// The `count`th bracket pair enclosing the caret (a bracket under the caret counts).
    fileprivate func enclosingBracket(_ open: unichar, _ close: unichar, at cur: Int, count: Int) -> (Int, Int)? {
        let len = t.length
        guard len > 0 else { return nil }
        func back(_ from: Int) -> Int? {
            var d = 0, i = from
            while i >= 0 {
                let u = t.character(at: i)
                if u == close { d += 1 } else if u == open {
                    if d == 0 { return i }
                    d -= 1
                }
                i -= 1
            }
            return nil
        }
        func forward(_ from: Int) -> Int? {
            var d = 0, i = from
            while i < len {
                let u = t.character(at: i)
                if u == open { d += 1 } else if u == close {
                    if d == 0 { return i }
                    d -= 1
                }
                i += 1
            }
            return nil
        }
        let here: unichar = cur < len ? t.character(at: cur) : 0
        var o = here == open ? cur : back(cur - 1)
        for _ in 1..<max(1, count) {
            guard let oo = o, oo > 0 else { return nil }
            o = back(oo - 1)
        }
        guard let oo = o, let cc = forward(oo + 1) else { return nil }
        return (oo, cc)
    }
}

// MARK: - Parsing

extension VimEngine {
    fileprivate static func parse(_ keys: [VimKey], visual: Bool) throws -> VimCommand {
        var p = VimParser(keys: keys)
        var count = p.count()
        var register: Character?
        if let k = p.peek(), k.char == "\"", !k.ctrl {
            p.i += 1
            let r = try p.char()
            guard isRegisterName(r) else { throw VimParse.invalid }
            register = r
            if let c2 = p.count() { count = min((count ?? 1) * c2, 99_999) }
        }
        let k = try p.key()
        let action = visual ? try parseVisual(k, &p) : try parseNormal(k, &p, &count)
        return VimCommand(register: register, count: count, action: action)
    }

    private static func parseNormal(_ k: VimKey, _ p: inout VimParser, _ count: inout Int?) throws -> VimAction {
        if k.ctrl {
            switch k.char {
            case "d": return .scroll(.halfDown)
            case "u": return .scroll(.halfUp)
            case "f": return .scroll(.pageDown)
            case "b": return .scroll(.pageUp)
            case "e": return .scroll(.lineDown)
            case "y": return .scroll(.lineUp)
            case "r": return .redo
            default: throw VimParse.invalid
            }
        }
        if k.special == .delete { return .op(.delete, .motion(VimMotion("l"))) }
        guard let c = k.char else { return .move(try parseMotion(k, &p)) }
        switch c {
        case "d", "c", "y", ">", "<":
            if c == "d" || c == "c" || c == "y", let k2 = p.peek(), k2.char == "s", !k2.ctrl {
                p.i += 1
                switch c {
                case "d": return .deleteSurround(try p.char())
                case "c":
                    let from = try p.char()
                    return .changeSurround(from, try p.char())
                default:
                    let target = try parseTarget(&p, &count, doubled: "s", gOp: nil)
                    return .surround(target, try p.char())
                }
            }
            let op: VimOperator = c == "d" ? .delete : c == "c" ? .change : c == "y" ? .yank : c == ">" ? .indent : .outdent
            return .op(op, try parseTarget(&p, &count, doubled: c, gOp: nil))
        case "g":
            let k2 = try p.key()
            guard !k2.ctrl, let c2 = k2.char else { throw VimParse.invalid }
            switch c2 {
            case "~": return .op(.toggleCase, try parseTarget(&p, &count, doubled: "~", gOp: "~"))
            case "u": return .op(.lowercase, try parseTarget(&p, &count, doubled: "u", gOp: "u"))
            case "U": return .op(.uppercase, try parseTarget(&p, &count, doubled: "U", gOp: "U"))
            case "v": return .reselect
            case "J": return .join(spaces: false)
            default:
                p.i -= 2
                return .move(try parseMotion(try p.key(), &p))
            }
        case "z":
            switch try p.char() {
            case "z": return .scroll(.center)
            case "t": return .scroll(.top)
            case "b": return .scroll(.bottom)
            case "a": return .fold(.toggle)
            case "o": return .fold(.open)
            case "c": return .fold(.close)
            default: throw VimParse.invalid
            }
        case "x": return .op(.delete, .motion(VimMotion("l")))
        case "X": return .op(.delete, .motion(VimMotion("h")))
        case "s": return .op(.change, .motion(VimMotion("l")))
        case "S": return .op(.change, .line)
        case "C": return .op(.change, .motion(VimMotion("$")))
        case "D": return .op(.delete, .motion(VimMotion("$")))
        case "Y": return .op(.yank, .line)
        case "p": return .put(before: false)
        case "P": return .put(before: true)
        case "J": return .join(spaces: true)
        case "~": return .toggleCaseChar
        case "r": return .replace(try p.char())
        case "i": return .insert(.before)
        case "a": return .insert(.after)
        case "I": return .insert(.lineStart)
        case "A": return .insert(.lineEnd)
        case "o": return .insert(.below)
        case "O": return .insert(.above)
        case "u": return .undo
        case ".": return .repeatChange
        case "v": return .visual(.visual)
        case "V": return .visual(.visualLine)
        default: return .move(try parseMotion(k, &p))
        }
    }

    private static func parseVisual(_ k: VimKey, _ p: inout VimParser) throws -> VimAction {
        if k.ctrl {
            switch k.char {
            case "d": return .scroll(.halfDown)
            case "u": return .scroll(.halfUp)
            case "f": return .scroll(.pageDown)
            case "b": return .scroll(.pageUp)
            case "e": return .scroll(.lineDown)
            case "y": return .scroll(.lineUp)
            default: throw VimParse.invalid
            }
        }
        if k.special == .delete { return .visualOp(.delete, lines: false) }
        guard let c = k.char else { return .move(try parseMotion(k, &p)) }
        switch c {
        case "d", "x": return .visualOp(.delete, lines: false)
        case "X", "D": return .visualOp(.delete, lines: true)
        case "y": return .visualOp(.yank, lines: false)
        case "Y": return .visualOp(.yank, lines: true)
        case "c", "s": return .visualOp(.change, lines: false)
        case "C", "R": return .visualOp(.change, lines: true)
        case ">": return .visualOp(.indent, lines: true)
        case "<": return .visualOp(.outdent, lines: true)
        case "~": return .visualOp(.toggleCase, lines: false)
        case "u": return .visualOp(.lowercase, lines: false)
        case "U": return .visualOp(.uppercase, lines: false)
        case "J": return .join(spaces: true)
        case "r": return .replace(try p.char())
        case "p": return .put(before: false)
        case "P": return .put(before: true)
        case "o", "O": return .swapEnds
        case "v": return .visual(.visual)
        case "V": return .visual(.visualLine)
        case "S": return .visualSurround(try p.char())
        case "i", "a":
            let kind = try p.char()
            guard objectKinds.contains(kind) else { throw VimParse.invalid }
            return .object(inner: c == "i", kind: kind)
        case "g":
            let k2 = try p.key()
            switch k2.ctrl ? nil : k2.char {
            case "J": return .join(spaces: false)
            case "v": return .reselect
            case "~": return .visualOp(.toggleCase, lines: false)
            case "u": return .visualOp(.lowercase, lines: false)
            case "U": return .visualOp(.uppercase, lines: false)
            default:
                p.i -= 2
                return .move(try parseMotion(try p.key(), &p))
            }
        case "z":
            switch try p.char() {
            case "z": return .scroll(.center)
            case "t": return .scroll(.top)
            case "b": return .scroll(.bottom)
            default: throw VimParse.invalid
            }
        default:
            return .move(try parseMotion(k, &p))
        }
    }

    /// What an operator works on: the doubled key (dd, g~~, yss), a text object or a motion.
    private static func parseTarget(_ p: inout VimParser, _ count: inout Int?, doubled: Character, gOp: Character?) throws -> VimTarget {
        if let c2 = p.count() { count = min((count ?? 1) * c2, 99_999) }
        let k = try p.key()
        if !k.ctrl, let c = k.char {
            if c == doubled { return .line }
            if let g = gOp, c == "g" {
                // g~g~, gugu, gUgU (or a g motion: gugg)
                guard let k2 = p.peek() else { throw VimParse.incomplete }
                if k2.char == g, !k2.ctrl {
                    p.i += 1
                    return .line
                }
            }
            if c == "i" || c == "a" {
                let kind = try p.char()
                guard objectKinds.contains(kind) else { throw VimParse.invalid }
                return .object(inner: c == "i", kind: kind)
            }
        }
        return .motion(try parseMotion(k, &p))
    }

    private static func parseMotion(_ k: VimKey, _ p: inout VimParser) throws -> VimMotion {
        guard !k.ctrl else { throw VimParse.invalid }
        if let s = k.special {
            switch s {
            case .left, .backspace: return VimMotion("h")
            case .right: return VimMotion("l")
            case .up: return VimMotion("k")
            case .down: return VimMotion("j")
            case .enter: return VimMotion("+")
            default: throw VimParse.invalid
            }
        }
        guard let c = k.char else { throw VimParse.invalid }
        switch c {
        case "h", "j", "k", "l", "w", "W", "b", "B", "e", "E", "0", "^", "$", "{", "}", "%", "G", "H", "M", "L",
             "n", "N", "*", "#", ";", ",", "|", "+", "-", "_":
            return VimMotion(String(c))
        case " ":
            return VimMotion("l")
        case "f", "F", "t", "T":
            return VimMotion(String(c), char: try p.char())
        case "g":
            switch try p.char() {
            case "g": return VimMotion("gg")
            case "e": return VimMotion("ge")
            case "E": return VimMotion("gE")
            case "_": return VimMotion("g_")
            case "j": return VimMotion("j")
            case "k": return VimMotion("k")
            default: throw VimParse.invalid
            }
        case "/", "?":
            var pattern = ""
            while true {
                let k2 = try p.key()
                if k2.special == .enter { break }
                if k2.special == .backspace {
                    guard !pattern.isEmpty else { throw VimParse.invalid }
                    pattern.removeLast()
                    continue
                }
                if let ch = k2.char, !k2.ctrl { pattern.append(ch) }
            }
            return VimMotion(String(c), pattern: pattern)
        default:
            throw VimParse.invalid
        }
    }
}
