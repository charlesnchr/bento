import Foundation
import Testing
@testable import Todo

final class MemoryRepo: TodoRepository {
    var docs: [String: TodoDoc] = [:]
    var lastSeq: Int64 = 0
    func doc(_ id: String) -> TodoDoc? { docs[id] }
    func save(_ doc: TodoDoc, remote: Bool) { docs[doc.id] = doc }
    var allDocs: [TodoDoc] { Array(docs.values) }
}

/// The server's last-writer-wins rule (server/src/store.rs) in memory.
final class FakeServer {
    var docs: [String: TodoDoc] = [:]
    var seq: Int64 = 0

    /// Returns the stored version and whether the put was accepted.
    func put(_ d: TodoDoc) -> (TodoDoc, Bool) {
        if let s = docs[d.id], d.updatedAt < s.updatedAt { return (s, false) }
        var n = d
        seq += 1
        n.seq = seq
        n.dirty = false
        if let s = docs[d.id] { n.createdAt = s.createdAt }
        // what travels is the wire form
        n = TodoWire.decode(TodoWire.encode(n, device: d.device).merging(["seq": seq]) { $1 })!
        docs[d.id] = n
        return (n, true)
    }
}

private func task(_ id: String = "t1", title: String = "Task", at t: Int64 = 1000) -> TodoDoc {
    var d = TodoDoc.newTask(title: title, order: 1, now: t)
    d.id = id
    return d
}

@Suite struct TodoMerge {
    @Test func differentFieldsBothSurvive() {
        let base = task()
        var a = base, b = base
        a.setTitle("Renamed", at: 2000)
        b.setDue(DueDate(date: "2026-10-23", time: nil), at: 3000)
        let m1 = a.merged(with: b), m2 = b.merged(with: a)
        #expect(m1.title == "Renamed" && m1.due?.date == "2026-10-23")
        #expect(m1.fields == m2.fields && m1.clocks == m2.clocks)
    }

    @Test func sameFieldNewerWinsAndTiesAreDeterministic() {
        let base = task()
        var a = base, b = base
        a.setTitle("A", at: 2000)
        b.setTitle("B", at: 2500)
        #expect(a.merged(with: b).title == "B")
        #expect(b.merged(with: a).title == "B")
        b.setTitle("C", at: 2000)
        #expect(a.merged(with: b).title == b.merged(with: a).title)
    }

    @Test func wireRoundTripKeepsUnknownFields() {
        var d = task()
        d.fields["future"] = .object(["x": .number(1)])
        d.extra["v"] = .number(2)
        d.meta["k"] = .string("v")
        let back = TodoWire.decode(TodoWire.encode(d, device: "mac"))!
        #expect(back.fields == d.fields && back.clocks == d.clocks && back.extra == d.extra && back.meta == d.meta)
        #expect(TodoWire.decode(["id": "x", "updated_at": 1, "body": "# a note", "collection": "notes"]) == nil)
        // an old server sends no collection: not ours
        #expect(TodoWire.decode(["id": "x", "updated_at": 1, "deleted": true]) == nil)
    }
}

@Suite struct TodoSyncEngineTests {
    @Test func insertsAndOverwritesWhenClean() {
        let repo = MemoryRepo(), e = TodoSyncEngine(repo: repo)
        var r = task(); r.seq = 1
        #expect(e.applyRemote(r) == .inserted)
        var r2 = r; r2.setTitle("New", at: 2000); r2.seq = 2
        #expect(e.applyRemote(r2) == .overwritten)
        #expect(repo.docs["t1"]?.title == "New" && repo.docs["t1"]?.dirty == false && repo.lastSeq == 2)
        #expect(e.applyRemote(r2) == .unchanged)
    }

    @Test func dirtyLocalMergesAndOutranksServer() {
        let repo = MemoryRepo(), e = TodoSyncEngine(repo: repo)
        var base = task(); base.seq = 1
        e.applyRemote(base)
        var local = repo.docs["t1"]!
        local.setTitle("Local title", at: 5000)
        local.dirty = true
        repo.save(local, remote: false)
        var r = base; r.setPriority(1, at: 6000); r.seq = 2
        #expect(e.applyRemote(r) == .merged)
        let m = repo.docs["t1"]!
        #expect(m.title == "Local title" && m.priority == 1 && m.dirty)
        #expect(m.updatedAt > r.updatedAt)
    }

    @Test func staleServerVersionIsHealed() {
        let repo = MemoryRepo(), e = TodoSyncEngine(repo: repo)
        var newer = task(); newer.setTitle("Newest", at: 9000); newer.seq = 5
        e.applyRemote(newer)
        var stale = task(); stale.updatedAt = 9500; stale.seq = 6 // older title, newer doc stamp
        #expect(e.applyRemote(stale) == .keptLocal)
        let d = repo.docs["t1"]!
        #expect(d.title == "Newest" && d.dirty && d.updatedAt > 9500)
    }

    @Test func tombstonesWinOverOlderEditsAndLoseToNewer() {
        let repo = MemoryRepo(), e = TodoSyncEngine(repo: repo)
        var base = task(); base.seq = 1
        e.applyRemote(base)
        var local = repo.docs["t1"]!
        local.setTitle("edit", at: 2000); local.dirty = true
        repo.save(local, remote: false)
        var tomb = TodoDoc(id: "t1", type: "", createdAt: 1000, updatedAt: 3000); tomb.deleted = true; tomb.seq = 2
        e.applyRemote(tomb)
        #expect(repo.docs["t1"]!.deleted && !repo.docs["t1"]!.dirty && repo.docs["t1"]!.type == "task")

        let repo2 = MemoryRepo(), e2 = TodoSyncEngine(repo: repo2)
        e2.applyRemote(base)
        var l2 = repo2.docs["t1"]!
        l2.setTitle("later edit", at: 4000); l2.dirty = true
        repo2.save(l2, remote: false)
        e2.applyRemote(tomb)
        let d = repo2.docs["t1"]!
        #expect(!d.deleted && d.dirty && d.updatedAt > 3000)
    }

    @Test func ackClearsDirtyOnlyForCurrentVersion() {
        let repo = MemoryRepo(), e = TodoSyncEngine(repo: repo)
        var d = task(); d.dirty = true
        repo.save(d, remote: false)
        e.markSent(d)
        d.setTitle("again", at: 2000)
        repo.save(d, remote: false)
        e.ack(id: "t1", seq: 1, accepted: true)
        #expect(repo.docs["t1"]!.dirty)
        #expect(e.docsToSend().map(\.id) == ["t1"])
        e.markSent(repo.docs["t1"]!)
        e.ack(id: "t1", seq: 2, accepted: true)
        #expect(!repo.docs["t1"]!.dirty && !e.hasInflight)
    }

    @Test func adoptingWhileAPutIsInFlightStaysDirty() {
        let repo = MemoryRepo(), e = TodoSyncEngine(repo: repo)
        var d = task(); d.dirty = true
        repo.save(d, remote: false)
        e.markSent(d)
        var r = d; r.setTitle("theirs", at: 5000); r.seq = 3; r.dirty = false
        e.applyRemote(r)
        let s = repo.docs["t1"]!
        #expect(s.title == "theirs" && s.dirty && s.updatedAt > r.updatedAt)
    }

    @Test func seqRegressionMarksEverythingForResend() {
        let repo = MemoryRepo(), e = TodoSyncEngine(repo: repo)
        var r = task(); r.seq = 10
        e.applySnapshot([r], seq: 10)
        #expect(e.applySnapshot([], seq: 3))
        #expect(repo.docs["t1"]!.dirty && repo.lastSeq == 0)
    }

    /// Two devices edit random fields of the same tasks while syncing through a fake
    /// last-writer-wins server, with puts delivered late: they must end up identical.
    @Test(arguments: 0..<40) func devicesConverge(seed: Int) {
        var rng = SeededRNG(seed: UInt64(seed + 1))
        let server = FakeServer()
        let devices = (0..<2).map { _ in MemoryRepo() }
        let engines = devices.map { TodoSyncEngine(repo: $0) }
        for (i, e) in engines.enumerated() { e.device = "d\(i)" }
        var clock: Int64 = 1000
        let ids = ["a", "b", "c"]
        var queued: [(device: Int, doc: TodoDoc)] = []

        let trace = ProcessInfo.processInfo.environment["TODO_TRACE"] == "\(seed)"
        func show(_ d: TodoDoc?) -> String {
            guard let d else { return "nil" }
            return "\(d.deleted ? "DEL" : "live") u=\(d.updatedAt) seq=\(d.seq ?? -1) dirty=\(d.dirty) pr=\(d.fields["priority"]?.double ?? -1)@\(d.clocks["priority"] ?? -1) mc=\(d.maxClock)"
        }
        func deliver(_ q: (device: Int, doc: TodoDoc)) {
            let (stored, accepted) = server.put(q.doc)
            if trace { print("DELIVER d\(q.device) \(q.doc.id) \(show(q.doc)) -> \(accepted ? "ACCEPT" : "REJECT") stored \(show(stored))") }
            defer { if trace { for (i, r) in devices.enumerated() { print("   d\(i): \(show(r.docs[q.doc.id]))") } } }
            engines[q.device].ack(id: q.doc.id, seq: accepted ? stored.seq : nil, accepted: accepted, version: q.doc.updatedAt)
            if !accepted { engines[q.device].applyRemote(stored) }
            for (j, e) in engines.enumerated() where j != q.device && accepted { e.applyRemote(stored) }
        }

        for _ in 0..<60 {
            clock += Int64.random(in: 0...3, using: &rng)
            let dev = Int.random(in: 0..<2, using: &rng)
            let repo = devices[dev]
            let id = ids.randomElement(using: &rng)!
            var d = repo.docs[id] ?? { var t = TodoDoc.newTask(title: "", order: 0, now: 1); t.id = id; return t }()
            let op = Int.random(in: 0..<6, using: &rng)
            clock = max(clock, d.updatedAt + 1) // a device's own clock never repeats a stamp
            if d.deleted, op != 4 { d.deleted = false; d.updatedAt = clock } // an edit after a delete resurrects
            switch op {
            case 0: d.setTitle("t\(Int.random(in: 0..<5, using: &rng))", at: clock)
            case 1: d.setPriority(Int.random(in: 1...4, using: &rng), at: clock)
            case 2: d.setCompleted(Bool.random(using: &rng) ? clock : nil, at: clock)
            case 3: d.setLabels(Bool.random(using: &rng) ? ["x"] : [], at: clock)
            case 4: d.markDeleted(at: clock)
            default: d.setOrder(Double(Int.random(in: 0..<9, using: &rng)), at: clock)
            }
            d.dirty = true
            repo.save(d, remote: false)
            if trace { print("EDIT d\(dev) \(id) op\(op) \(show(d))") }
            for s in engines[dev].docsToSend() { engines[dev].markSent(s); queued.append((dev, s)) }
            // deliver some queued puts, possibly out of device order
            while !queued.isEmpty, Bool.random(using: &rng) { deliver(queued.removeFirst()) }
        }
        // quiesce
        for _ in 0..<20 {
            while !queued.isEmpty { deliver(queued.removeFirst()) }
            for (i, e) in engines.enumerated() {
                for s in e.docsToSend() { e.markSent(s); queued.append((i, s)) }
            }
            if queued.isEmpty { break }
        }
        #expect(queued.isEmpty)
        for id in ids {
            let a = devices[0].docs[id], b = devices[1].docs[id], s = server.docs[id]
            #expect(a?.deleted == b?.deleted, "seed \(seed) \(id)")
            if let a, let b, !a.deleted {
                #expect(a.fields == b.fields, "seed \(seed) \(id)")
                #expect(a.fields == s?.fields, "seed \(seed) \(id)")
            }
            #expect(a?.dirty != true && b?.dirty != true)
        }
    }
}

struct SeededRNG: RandomNumberGenerator {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        return z ^ (z >> 31)
    }
}
