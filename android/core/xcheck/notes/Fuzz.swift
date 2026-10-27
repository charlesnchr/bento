import Foundation

// The live-merge fuzz from Tests/NotesTests/SyncTests.swift (LiveMergeTests), with a
// deterministic clock and ids, recording each Mac's final state. NotesCrossCheckTest
// replays every (seed, kind) with the same generator and compares.

final class MemoryRepo: NoteRepository {
    var notes: [String: Note] = [:]
    var lastSeq: Int64 = 0
    var installID: String
    var retiredInstallIDs: Set<String> = []
    init(installID: String) { self.installID = installID }
    func renewInstallID() {
        retiredInstallIDs.insert(installID)
        installID = "install-" + TestClock.nextID()
    }
    func note(_ id: String) -> Note? { notes[id] }
    func save(_ note: Note) { notes[note.id] = note }
    func allNotes(includeTombstones: Bool) -> [Note] { Array(notes.values).filter { includeTombstones || !$0.deleted } }
}

func remote(_ id: String, _ body: String, updated: Int64, seq: Int64, deleted: Bool = false) -> Note {
    var n = Note(id: id, body: body, createdAt: 1, updatedAt: updated)
    n.seq = seq
    n.deleted = deleted
    if deleted { n.body = "" }
    return n
}

func wire(_ obj: [String: Any]) -> [String: Any] {
    try! JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: obj)) as! [String: Any]
}

final class Mac {
    let repo: MemoryRepo
    private(set) var e: SyncEngine
    let name: String
    var changes: [SyncEngine.RemoteResult] = []

    init(_ name: String, body: String, installID: String) {
        self.name = name
        repo = MemoryRepo(installID: installID)
        e = SyncEngine(repo: repo)
        e.device = name
        var start = remote("a", body, updated: 100, seq: 1)
        start.device = "x"
        e.applyRemote(start)
        caret = (body as NSString).length
        shown = body
        e.onRemoteChange = { [unowned self] _, r in changes.append(r) }
    }

    func relaunch() {
        e = SyncEngine(repo: repo)
        e.device = name
        e.onRemoteChange = { [unowned self] _, r in changes.append(r) }
    }

    func mutate(_ change: (inout Note) -> Void) {
        var n = note
        change(&n)
        n.updatedAt = Note.nextUpdate(after: n.updatedAt)
        n.dirty = true
        repo.save(n)
    }

    func touchBlocked() {
        if e.blockedNotes.contains(where: { $0.id == "a" }) { mutate { _ in } }
    }

    var note: Note { repo.notes["a"]! }
    var copies: [Note] { repo.notes.values.filter { $0.meta["conflictOf"] != nil } }

    func type(_ edit: (String) -> String) {
        var n = note
        e.willEdit(n)
        n.body = edit(n.body)
        n.updatedAt = Note.nextUpdate(after: n.updatedAt)
        n.dirty = true
        repo.save(n)
    }

    var caret: Int
    private var shown: String

    func typeAtCaret(_ text: String, elsewhere: Int?, backspace: Bool) {
        followCaret()
        type { body in
            let s = NSMutableString(string: body)
            var at = min(elsewhere ?? caret, s.length)
            if backspace, at > 0 { s.deleteCharacters(in: NSRange(location: at - 1, length: 1)); at -= 1 }
            s.insert(text, at: at)
            caret = at + (text as NSString).length
            return s as String
        }
        shown = note.body
    }

    func followCaret() {
        let body = note.body
        guard body != shown else { return }
        caret = TextMerge.map(NSRange(location: min(caret, (shown as NSString).length), length: 0),
                              through: TextMerge.edits(from: shown, to: body)).location
        shown = body
    }

    func put() -> [String: Any]? {
        guard let n = e.notesToSend().first(where: { $0.id == "a" }) else { return nil }
        e.markSent(n)
        return wire(e.encode(n))
    }

    func receive(_ obj: [String: Any]) { e.applyRemote(NoteWire.decode(obj)!) }
}

struct SeededRNG: RandomNumberGenerator {
    var state: UInt64
    mutating func next() -> UInt64 {
        state = state &* 6364136223846793005 &+ 1442695040888963407
        return state >> 11 | state << 53
    }
}

final class Network {
    enum Message { case note([String: Any]), ack(Int64, Bool), error }
    let macs: [Mac]
    var stored: [String: Any]
    var seq: Int64 = 1
    var inbox: [(mac: Int, conn: Int, put: [String: Any])] = []
    var queues: [[Message]]
    var conns: [Int]

    init(_ macs: [Mac], body: String) {
        self.macs = macs
        stored = ["id": "a", "body": body, "created_at": 1, "updated_at": 100, "seq": 1, "device": "x", "meta": [:]]
        queues = macs.map { _ in [] }
        conns = macs.map { _ in 0 }
    }

    func send(_ i: Int) { if let p = macs[i].put() { inbox.append((i, conns[i], p)) } }

    func serve(refuse: Bool = false, fail: Bool = false, lose: Bool = false) {
        guard !inbox.isEmpty else { return }
        let (i, conn, p) = inbox.removeFirst()
        if lose { return }
        if fail {
            if conns[i] == conn { queues[i].append(.error) }
            return
        }
        let accepted = !refuse && (p["updated_at"] as! NSNumber).int64Value >= (stored["updated_at"] as! NSNumber).int64Value
        if accepted {
            seq += 1
            stored = p
            stored["seq"] = seq
            for j in macs.indices where !(j == i && conns[j] == conn) { queues[j].append(.note(stored)) }
        }
        guard conns[i] == conn else { return }
        queues[i].append(.ack(seq, accepted))
        if !accepted { queues[i].append(.note(stored)) }
    }

    func deliver(_ i: Int) {
        guard !queues[i].isEmpty else { return }
        switch queues[i].removeFirst() {
        case .note(let n): macs[i].receive(n)
        case .ack(let s, let ok): macs[i].e.ack(id: "a", seq: ok ? s : nil, accepted: ok)
        case .error: macs[i].e.putFailed(id: "a")
        }
        macs[i].followCaret()
    }

    func relaunch(_ i: Int) {
        macs[i].relaunch()
        reconnect(i)
    }

    func reconnect(_ i: Int) {
        conns[i] += 1
        queues[i] = []
        macs[i].e.reset()
        let s = (stored["seq"] as! NSNumber).int64Value
        macs[i].e.applySnapshot(s > macs[i].repo.lastSeq ? [NoteWire.decode(stored)!] : [], seq: seq)
        macs[i].followCaret()
    }

    var quiet: Bool { inbox.isEmpty && queues.allSatisfy(\.isEmpty) && macs.allSatisfy { $0.e.notesToSend().allSatisfy { $0.id != "a" } } }

    func settle(steps: Int = 300) -> Bool {
        for _ in 0..<steps {
            TestClock.now! += 1
            macs.forEach { $0.touchBlocked() }
            if quiet { return true }
            for i in macs.indices { send(i) }
            while !inbox.isEmpty { serve() }
            for i in macs.indices { while !queues[i].isEmpty { deliver(i) } }
        }
        return quiet
    }
}

enum Fuzz: String, CaseIterable { case insertOnly, withDeletes, threeMacs, sameName, metaAndRelaunch, sharedInstallID }

func resultName(_ r: SyncEngine.RemoteResult) -> String {
    switch r {
    case .inserted: return "inserted"
    case .overwritten: return "overwritten"
    case .adopted: return "adopted"
    case .keptLocal: return "keptLocal"
    case .unchanged: return "unchanged"
    case .merged: return "merged"
    }
}

func headsDesc(_ h: SyncHeads) -> [String: Any] { h.mapValues { [$0.at, String($0.hash, radix: 16)] as [Any] } }

func noteDesc(_ n: Note) -> [String: Any] {
    ["id": n.id, "body": n.body, "createdAt": n.createdAt, "updatedAt": n.updatedAt, "deleted": n.deleted,
     "seq": n.seq.map { $0 as Any } ?? NSNull(), "device": n.device, "meta": n.meta.mapValues(\.any), "dirty": n.dirty,
     "openedAt": n.openedAt, "baseHash": n.baseHash.map { String($0, radix: 16) as Any } ?? NSNull(),
     "heads": n.syncHeads.map { headsDesc($0) as Any } ?? NSNull()]
}

/// One fuzz run as in LiveMergeTests.fuzz, with the clock advancing by step % 4 ms per
/// step and 1 ms per settle round.
func runFuzz(seed: Int, _ kind: Fuzz) -> [String: Any] {
    TestClock.counter = 0
    TestClock.now = 1_800_000_000_000
    var rng = SeededRNG(state: UInt64(seed) &* 0x9E37_79B9_7F4A_7C15 &+ 1)
    let start = "# Notes\nfirst line\n\nsecond line\n"
    let names = kind == .threeMacs ? ["A", "B", "C"] : kind == .sameName ? ["MacBook Pro", "MacBook Pro"] : ["A", "B"]
    let macs = names.enumerated().map { Mac($0.element, body: start, installID: "install-\($0.offset)") }
    if kind == .sharedInstallID { macs[1].repo.installID = macs[0].repo.installID }
    let net = Network(macs, body: start)
    var next: UInt32 = 0x4E00
    var typed = Set<Character>()
    var deleted = false
    var actions: [Int] = []
    for step in 0..<120 {
        TestClock.now! += Int64(step % 4)
        let i = Int.random(in: 0..<macs.count, using: &rng)
        let extra = kind == .metaAndRelaunch
        let action = Int.random(in: 0..<1000, using: &rng)
        actions.append(i * 1000 + action)
        switch action {
        case 0..<350:
            let m = macs[i]
            guard !m.note.deleted else { break }
            let run = (0..<Int.random(in: 1...3, using: &rng)).map { _ -> Character in
                next += 1
                return Character(Unicode.Scalar(next)!)
            }
            typed.formUnion(run)
            let elsewhere = Int.random(in: 0..<10, using: &rng) == 0
            let backspace = kind == .withDeletes && Int.random(in: 0..<4, using: &rng) == 0
            m.typeAtCaret(String(run), elsewhere: elsewhere ? Int.random(in: 0...1000, using: &rng) : nil, backspace: backspace)
        case 350..<550: net.send(i)
        case 550..<680: net.serve()
        case 680..<690: net.serve(refuse: true)
        case 690..<700: net.serve(fail: true)
        case 700..<960: net.deliver(i)
        case 960..<975 where extra: macs[i].mutate { $0.pinned.toggle() }
        case 975..<985 where extra:
            macs[i].mutate { n in n.meta["trashedAt"] = n.meta["trashedAt"] == nil ? .number(Double(Note.now())) : nil }
        case 985..<990 where extra: net.relaunch(i)
        case 990..<991 where extra:
            deleted = true
            macs[i].mutate { $0.deleted = true; $0.body = "" }
        default: net.reconnect(i)
        }
    }
    let quiet = net.settle()
    var putWhileQuiet = false
    for _ in 0..<30 {
        for i in macs.indices { net.send(i) }
        if !net.inbox.isEmpty { putWhileQuiet = true }
        net.serve()
    }
    let a = macs[0].note.body
    let marks = a.filter { typed.contains($0) }
    return [
        "t": "fuzz", "seed": seed, "kind": kind.rawValue, "quiet": quiet, "putWhileQuiet": putWhileQuiet, "deleted": deleted,
        "actions": actions, "typed": String(typed.sorted()), "duplicated": marks.count != Set(marks).count,
        "server": wire(net.stored),
        "macs": macs.map { m -> [String: Any] in
            ["installID": m.repo.installID, "retired": m.repo.retiredInstallIDs.sorted(), "lastSeq": m.repo.lastSeq,
             "caret": m.caret, "changes": m.changes.map(resultName),
             "notes": m.repo.notes.values.sorted { $0.id < $1.id }.map(noteDesc)]
        },
    ]
}
