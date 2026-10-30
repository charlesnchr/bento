// Cross-check vector generator: runs the Mac's real Todo code (copied from Sources/Todo and
// Sources/BentoCore by run.sh) and writes what it computes as JSON, which the Kotlin tests replay
// (android/core/src/test/resources/xcheck/). Build: see run.sh.
//
// Strings travel as base64 UTF-8 and doubles as their IEEE bit patterns, so nothing is lost
// or reinterpreted between the two JSON stacks.

import Foundation

// MARK: - Plumbing

// The names TodoStore.swift and TodoSyncClient.swift give BentoCore's types (they need SQLite).
typealias TodoRepository = FieldDocRepository
typealias TodoSyncEngine = FieldSyncEngine

struct RNG {
    var state: UInt64
    init(_ seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        return z ^ (z >> 31)
    }
    mutating func int(_ n: Int) -> Int { Int(next() % UInt64(n)) }
    mutating func bool() -> Bool { next() & 1 == 0 }
    mutating func pick<T>(_ a: [T]) -> T { a[int(a.count)] }
}

func b64(_ s: String) -> String { Data(s.utf8).base64EncodedString() }

func tree(_ v: JSONValue) -> Any {
    switch v {
    case .null: return ["n": 0]
    case .bool(let b): return ["b": b]
    case .number(let d): return ["d": String(d.bitPattern, radix: 16)]
    case .string(let s): return ["s": b64(s)]
    case .array(let a): return ["a": a.map(tree)]
    case .object(let o): return ["o": o.map { [b64($0.key), tree($0.value)] }]
    }
}

func docTree(_ d: TodoDoc?) -> Any {
    guard let d else { return NSNull() }
    var o: [String: Any] = [
        "id": b64(d.id), "type": b64(d.type), "fields": tree(.object(d.fields)),
        "clocks": d.clocks.map { [b64($0.key), $0.value] }, "extra": tree(.object(d.extra)),
        "createdAt": d.createdAt, "updatedAt": d.updatedAt, "deleted": d.deleted, "device": b64(d.device),
        "meta": tree(.object(d.meta)), "dirty": d.dirty,
    ]
    if let s = d.seq { o["seq"] = s }
    return o
}

func dueTree(_ d: DueDate?) -> Any {
    guard let d else { return NSNull() }
    return d.time.map { [d.date, $0] } ?? [d.date]
}

func write(_ name: String, _ obj: Any) {
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
    try! data.write(to: URL(fileURLWithPath: "out/\(name).json"))
    print("wrote out/\(name).json (\(data.count) bytes)")
}

func utf16(_ s: String, _ r: Range<String.Index>) -> [Int] {
    [s.utf16.distance(from: s.startIndex, to: r.lowerBound), s.utf16.distance(from: r.lowerBound, to: r.upperBound)]
}

try? FileManager.default.createDirectory(atPath: "out", withIntermediateDirectories: true)

// MARK: - Values

let stringPieces = ["a", "Z", "0", "9", "/", "\\", "\"", "'", " ", "\n", "\t", "\r", "\u{0}", "\u{1}", "\u{8}", "\u{b}",
                    "\u{c}", "\u{1f}", "\u{7f}", "\u{80}", "\u{9f}", "é", "e\u{301}", "ß", "中文", "😀", "👨‍👩‍👧",
                    "\u{2028}", "\u{2029}", "\u{a0}", "\u{feff}", "<", ">", "&", "Ω", "\u{212B}", "Å", "ﬁ", "#", "@",
                    "[", "]", "{", "}", ":", ",", "x/y", "http://a.b/c?d=1&e=2", "f", "A", "b", "🇬🇧", "\u{10FFFF}"]

func randString(_ r: inout RNG) -> String { (0..<r.int(6)).map { _ in r.pick(stringPieces) }.joined() }

let fixedNumbers: [Double] = [0, 1, -1, 42, 1024, 1024.5, 0.1, 0.2, 0.3, 0.30000000000000004, 1e-7, 1e-5, 1e-4, 0.001,
                              1e20, 1e21, 1e15, 1e15 - 1, 1e15 + 0.5, 999999999999999.9, 1e16, 9007199254740992,
                              9007199254740993, -0.0, 5e-324, 1.7976931348623157e308, 2.5e-10, 12345678.9,
                              123456789012345.6, 1761000123456, 1761000123456.5, -1024.25, 3.14159, 1.0 / 3, 2.0 / 3,
                              100, 1e300, -1e-300, 0.5, 1.5, 2.5, 512.75, 1536, -999999999999999, 4503599627370496.5,
                              0.000123, 123e-20, 6.02214076e23, 1e-310]

func randNumber(_ r: inout RNG) -> Double {
    switch r.int(6) {
    case 0, 1: return r.pick(fixedNumbers)
    case 2: return Double(Int64(bitPattern: r.next()) % 2_000_000_000_000_000)
    case 3: return Double(Int64(bitPattern: r.next()) % 1_000_000) / pow(10, Double(r.int(9)))
    case 4:
        let d = Double(bitPattern: r.next())
        return d.isFinite ? d : 1.0
    default: return Double(r.int(100_000)) / 8
    }
}

let keyPieces = ["a", "b", "A", "B", "z", "Z", "_", "-", "1", "2", "10", "01", "001", " ", "é", "date", "time", "x", "Y",
                 "$", "~", ".", "aa", "aB", "Ab", "9", "0", "#", "@", "/", "ä", "Ä"]

func randKey(_ r: inout RNG) -> String { (0..<(1 + r.int(3))).map { _ in r.pick(keyPieces) }.joined() }

func randValue(_ r: inout RNG, depth: Int) -> JSONValue {
    switch r.int(depth > 2 ? 4 : 6) {
    case 0: return .null
    case 1: return .bool(r.bool())
    case 2: return .number(randNumber(&r))
    case 3: return .string(randString(&r))
    case 4: return .array((0..<r.int(4)).map { _ in randValue(&r, depth: depth + 1) })
    default:
        var o: [String: JSONValue] = [:]
        for _ in 0..<r.int(6) { o[randKey(&r)] = randValue(&r, depth: depth + 1) }
        return .object(o)
    }
}

// MARK: - 1. canonical + string order

do {
    var r = RNG(1)
    var out: [[String: Any]] = []
    for n in fixedNumbers { out.append(["v": tree(.number(n)), "c": b64(JSONValue.number(n).canonical)]) }
    for s in stringPieces { out.append(["v": tree(.string(s)), "c": b64(JSONValue.string(s).canonical)]) }
    var keysObj: [String: JSONValue] = [:]
    for (i, k) in keyPieces.enumerated() { keysObj[k] = .number(Double(i)) }
    for c in 0x20...0x7e { keysObj[String(UnicodeScalar(UInt8(c)))] = .number(Double(c)) }
    out.append(["v": tree(.object(keysObj)), "c": b64(JSONValue.object(keysObj).canonical)])
    for _ in 0..<500 {
        let v = randValue(&r, depth: 0)
        out.append(["v": tree(v), "c": b64(v.canonical)])
    }
    // objects of random ASCII keys only: the key order must match exactly
    for _ in 0..<150 {
        var o: [String: JSONValue] = [:]
        for _ in 0..<(2 + r.int(8)) {
            let k = String((0..<(1 + r.int(4))).map { _ in Character(UnicodeScalar(UInt8(0x20 + r.int(95)))) })
            o[k] = .number(1)
        }
        out.append(["v": tree(.object(o)), "c": b64(JSONValue.object(o).canonical)])
    }
    write("canonical", out)

    var pairs: [[Any]] = []
    let cmpPieces = ["a", "b", "A", "é", "e\u{301}", "e", "f", "\u{212B}", "Å", "A\u{30A}", "ﬁ", "fi", "😀", "\u{FFFF}",
                     "\u{10000}", "z", "[", "\"", "\\", "1", "10", "2", "ß", "ss", "\u{3B1}\u{301}", "\u{3AC}"]
    for _ in 0..<400 {
        let a = (0..<(1 + r.int(3))).map { _ in r.pick(cmpPieces) }.joined()
        let b = (0..<(1 + r.int(3))).map { _ in r.pick(cmpPieces) }.joined()
        pairs.append([b64(a), b64(b), a < b, a == b])
    }
    write("string_order", pairs)
}

// MARK: - 2. merge, body, wire

do {
    var r = RNG(2)
    let fieldKeys = ["title", "description", "project", "labels", "priority", "due", "completed_at", "order", "x", "Ö", "Za", "a1"]
    let pool: [JSONValue] = [.string("A"), .string("B"), .string("a"), .number(1), .number(2), .number(0.1), .null, .bool(true),
                             .bool(false), .array([.string("x")]), .object(["date": .string("2026-10-23")]),
                             .object(["date": .string("2026-10-23"), "time": .string("17:00")]), .string("é"),
                             .string("e\u{301}"), .string("f"), .string("a/b"), .string(""), .number(1024.5)]
    let clocks: [Int64] = [0, 1000, 1000, 2000, 2000, 3000, -5, 1761000123456, .max]
    func randDoc(_ id: String) -> TodoDoc {
        var d = TodoDoc(id: id, type: r.pick(["task", "project", "entry", "weird", ""]), createdAt: Int64(r.int(3000)), updatedAt: 0)
        for k in fieldKeys where r.int(3) > 0 {
            d.fields[k] = r.int(3) == 0 ? randValue(&r, depth: 1) : r.pick(pool)
            if r.int(5) > 0 { d.clocks[k] = r.pick(clocks) }
        }
        for k in fieldKeys where d.fields[k] == nil && r.int(6) == 0 { d.clocks[k] = r.pick(clocks) }
        if r.int(4) == 0 { d.extra[r.pick(["v", "future", "A", "zz"])] = randValue(&r, depth: 1) }
        if r.int(4) == 0 { d.meta[randKey(&r)] = randValue(&r, depth: 2) }
        d.updatedAt = d.maxClock
        return d
    }
    var out: [[String: Any]] = []
    for i in 0..<400 {
        let a = randDoc("doc-\(i)")
        var b = r.int(4) == 0 ? a : randDoc("doc-\(i)")
        if r.int(3) == 0 { // same fields, some clocks equal: ties decided by canonical order
            b.fields = a.fields.mapValues { r.int(2) == 0 ? $0 : r.pick(pool) }
            b.clocks = a.clocks
        }
        let wire = try! JSONSerialization.data(withJSONObject: TodoWire.encode(a, device: "mac/1"))
        let back = TodoWire.decode(try! JSONSerialization.jsonObject(with: wire))
        out.append(["a": docTree(a), "b": docTree(b), "ab": docTree(a.merged(with: b)), "ba": docTree(b.merged(with: a)),
                    "body": b64(a.body), "wire": b64(String(data: wire, encoding: .utf8)!), "back": docTree(back),
                    "same": a.sameContent(b)])
    }
    write("merge", out)

    // Hand-made wire objects: what decode accepts and how.
    let raw = [
        ##"{"id":"x","updated_at":1,"body":"# a note","collection":"notes"}"##,
        ##"{"id":"x","updated_at":1,"deleted":true}"##,
        ##"{"id":"x","updated_at":1,"deleted":true,"collection":"todos"}"##,
        ##"{"id":"","updated_at":1,"deleted":true,"collection":"todos"}"##,
        ##"{"id":"x","updated_at":"1","deleted":true,"collection":"todos"}"##,
        ##"{"id":"x","updated_at":true,"deleted":true,"collection":"todos"}"##,
        ##"{"id":"x","updated_at":1.9,"created_at":0.5,"deleted":1,"collection":"todos"}"##,
        ##"{"id":"x","updated_at":1,"deleted":0,"body":"{\"type\":\"task\"}","collection":"todos"}"##,
        ##"{"id":"x","updated_at":1,"deleted":"true","body":"{\"type\":\"task\"}","collection":"todos"}"##,
        ##"{"id":"x","updated_at":1,"body":"{\"type\":1}","collection":"todos"}"##,
        ##"{"id":"x","updated_at":1,"body":"[1]","collection":"todos"}"##,
        ##"{"id":"x","updated_at":1,"body":"","collection":"todos"}"##,
        ##"{"id":"x","updated_at":1,"collection":"todos"}"##,
        ##"{"id":"x","updated_at":1,"body":"{\"type\":\"task\",\"fields\":[1],\"clocks\":{\"a\":true,\"b\":\"2\",\"c\":2.7,\"d\":-3,\"e\":1e30,\"f\":null}}","collection":"todos"}"##,
        ##"{"id":"x","updated_at":9223372036854775807,"seq":12,"device":"mac","meta":{"k":[1,{"z":null}]},"body":"{\"type\":\"project\",\"fields\":{\"name\":\"P\",\"archived\":1},\"clocks\":{\"name\":5},\"v\":2,\"w\":{\"q\":1}}","collection":"todos"}"##,
        ##"{"id":"x","updated_at":1e300,"created_at":-1e300,"deleted":true,"collection":"todos"}"##,
        ##"{"id":"x","updated_at":1,"device":5,"meta":[1],"body":"{\"type\":\"task\",\"fields\":{\"due\":{\"date\":\"2026-10-23\",\"time\":null}}}","collection":"todos"}"##,
        ##"{"id":"x","updated_at":1,"body":"{\"type\":\"entry\",\"fields\":{\"term\":\"Kubernetes\"}}","collection":"voice"}"##,
        ##"{"id":"x","updated_at":1,"body":"{\"type\":\"task\",\"fields\":{}}","collection":"Todos"}"##,
        ##"{"id":7,"updated_at":1,"deleted":true,"collection":"todos"}"##,
        ##"{"id":"x","updated_at":1,"seq":-4,"deleted":false,"body":"{\"type\":\"task\",\"fields\":{\"title\":\"a\\/b\"},\"clocks\":{\"title\":1}}","collection":"todos"}"##,
    ]
    var dec: [[Any]] = []
    for s in raw {
        let obj = try! JSONSerialization.jsonObject(with: Data(s.utf8))
        dec.append([b64(s), docTree(TodoWire.decode(obj))])
    }
    write("wire_decode", dec)
}

// MARK: - 3. sync engine traces

final class MemoryRepo: TodoRepository {
    var docs: [String: TodoDoc] = [:]
    func doc(_ id: String) -> TodoDoc? { docs[id] }
    func save(_ doc: TodoDoc, remote: Bool) { docs[doc.id] = doc }
    var allDocs: [TodoDoc] { Array(docs.values) }
}

/// The server's last-writer-wins rule (server/src/store.rs) in memory.
final class FakeServer {
    var docs: [String: TodoDoc] = [:]
    var seq: Int64 = 0

    func put(_ d: TodoDoc, device: String) -> (TodoDoc, Bool) {
        if let s = docs[d.id], d.updatedAt < s.updatedAt { return (s, false) }
        var n = d
        seq += 1
        n.seq = seq
        n.dirty = false
        if let s = docs[d.id] { n.createdAt = s.createdAt }
        n = TodoWire.decode(TodoWire.encode(n, device: device).merging(["seq": seq]) { $1 })!
        docs[d.id] = n
        return (n, true)
    }

    /// A backup restore: everything after `k` is gone.
    func rollback(to k: Int64) {
        docs = docs.filter { ($0.value.seq ?? 0) <= k }
        seq = k
    }
}

func docLine(_ d: TodoDoc) -> String {
    let clocks = d.clocks.keys.sorted().map { "\($0)=\(d.clocks[$0]!)" }.joined(separator: ",")
    return "\(d.id)|\(d.type)|\(d.deleted)|c=\(d.createdAt)|u=\(d.updatedAt)|s=\(d.seq.map(String.init) ?? "nil")|dirty=\(d.dirty)|dev=\(d.device)|f=\(JSONValue.object(d.fields).canonical)|k=\(clocks)|x=\(JSONValue.object(d.extra).canonical)\n"
}

func stateText(_ devices: [MemoryRepo], _ engines: [TodoSyncEngine], _ server: FakeServer) -> String {
    var s = ""
    for (i, r) in devices.enumerated() {
        s += "D\(i) pending=\(engines[i].pendingCount) blocked=\(engines[i].blockedCount)\n"
        for id in r.docs.keys.sorted() { s += docLine(r.docs[id]!) }
        s += "inflight=" + engines[i].inflight.keys.sorted().map { "\($0):" + engines[i].inflight[$0]!.map(String.init).joined(separator: ",") }.joined(separator: ";") + "\n"
        s += "failed=" + engines[i].failed.keys.sorted().map { "\($0):\(engines[i].failed[$0]!)" }.joined(separator: ";") + "\n"
    }
    s += "S seq=\(server.seq)\n"
    for id in server.docs.keys.sorted() { s += docLine(server.docs[id]!) }
    return s
}

func fnv(_ s: String) -> String {
    var h: UInt64 = 0xcbf29ce484222325
    for b in s.utf8 { h ^= UInt64(b); h = h &* 0x100000001b3 }
    return String(h, radix: 16)
}

do {
    var traces: [[String: Any]] = []
    var converged = 0
    for seed in 0..<60 {
        var r = RNG(UInt64(1000 + seed))
        let server = FakeServer()
        let devices = (0..<2).map { _ in MemoryRepo() }
        let engines = devices.map { TodoSyncEngine(repo: $0) }
        for (i, e) in engines.enumerated() { e.device = "d\(i)" }
        var clock: Int64 = 1000
        let ids = ["a", "b", "c"]
        var queued: [(device: Int, doc: TodoDoc)] = []
        var events: [[String: Any]] = []
        func record(_ e: [String: Any]) {
            var e = e
            e["h"] = fnv(stateText(devices, engines, server))
            events.append(e)
        }
        func deliver(mode: Int) {
            let q = queued.removeFirst()
            let e = engines[q.device]
            if mode == 3 {
                e.putFailed(id: q.doc.id, version: q.doc.updatedAt)
            } else {
                let (stored, accepted) = server.put(q.doc, device: "d\(q.device)")
                switch mode {
                case 1: e.ack(id: q.doc.id, seq: accepted ? stored.seq : nil, accepted: accepted)
                default: e.ack(id: q.doc.id, seq: accepted ? stored.seq : nil, accepted: accepted, version: q.doc.updatedAt)
                }
                if !accepted { e.applyRemote(stored) }
                for (j, o) in engines.enumerated() where j != q.device && accepted { o.applyRemote(stored) }
            }
            record(["t": "deliver", "mode": mode])
        }
        func send(_ dev: Int) {
            let docs = engines[dev].docsToSend()
            for s in docs { engines[dev].markSent(s); queued.append((dev, s)) }
            record(["t": "send", "dev": dev, "docs": docs.map { [$0.id, $0.updatedAt] }])
        }
        func reconnect(_ dev: Int) {
            queued.removeAll { $0.device == dev }
            engines[dev].reset()
            engines[dev].clearFailed()
            engines[dev].applySnapshot(Array(server.docs.values), ids: Set(server.docs.keys))
            record(["t": "reconnect", "dev": dev])
        }
        for _ in 0..<70 {
            clock += Int64(r.int(4))
            let dev = r.int(2)
            let repo = devices[dev]
            let id = r.pick(ids)
            var d = repo.docs[id] ?? { var t = TodoDoc.newTask(title: "", order: 0, now: 1); t.id = id; return t }()
            let op = r.int(6)
            clock = max(clock, d.updatedAt + 1) // a device's own clock never repeats a stamp
            if d.deleted, op != 4 { d.deleted = false; d.updatedAt = clock } // an edit after a delete resurrects
            var value: Any = NSNull()
            switch op {
            case 0: let t = "t\(r.int(5))"; value = t; d.setTitle(t, at: clock)
            case 1: let p = 1 + r.int(4); value = p; d.setPriority(p, at: clock)
            case 2: let c: Int64? = r.bool() ? clock : nil; value = c.map { $0 as Any } ?? NSNull(); d.setCompleted(c, at: clock)
            case 3: let x = r.bool(); value = x; d.setLabels(x ? ["x"] : [], at: clock)
            case 4: d.markDeleted(at: clock)
            default: let o = Double(r.int(9)) / (r.bool() ? 1 : 4); value = o; d.setOrder(o, at: clock)
            }
            d.dirty = true
            repo.save(d, remote: false)
            record(["t": "edit", "dev": dev, "id": id, "op": op, "clock": clock, "v": value])
            send(dev)
            while !queued.isEmpty, r.bool() { deliver(mode: r.int(10) == 0 ? 3 : r.int(3)) }
            if r.int(25) == 0 { reconnect(r.int(2)) }
            if r.int(80) == 0, server.seq > 2 {
                let k = server.seq - Int64(1 + r.int(3))
                server.rollback(to: k)
                record(["t": "rollback", "to": k])
            }
        }
        for _ in 0..<20 {
            while !queued.isEmpty { deliver(mode: 0) }
            reconnect(0)
            reconnect(1)
            send(0)
            send(1)
            if queued.isEmpty { break }
        }
        let a = devices[0].docs, b = devices[1].docs
        if ids.allSatisfy({ a[$0]?.deleted == b[$0]?.deleted && (a[$0]?.deleted ?? true || a[$0]?.fields == b[$0]?.fields) && a[$0]?.dirty != true && b[$0]?.dirty != true }) { converged += 1 }
        traces.append(["seed": seed, "events": events, "final": b64(stateText(devices, engines, server))])
    }
    print("engine traces: \(converged)/60 converged")
    write("engine", traces)
}

// MARK: - 4. parsers

func context(_ zone: String, _ y: Int, _ m: Int, _ d: Int, _ h: Int, _ min: Int, _ s: Int = 0) -> (Calendar, Date, [Any]) {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone(identifier: zone)!
    c.locale = Locale(identifier: "en_GB")
    let date = c.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: min, second: s))!
    return (c, date, [zone, Int64((date.timeIntervalSince1970 * 1000).rounded())])
}

let contexts = [
    context("Europe/London", 2026, 10, 21, 10, 0),      // the Swift tests' Wednesday
    context("Europe/London", 2026, 10, 25, 12, 0),      // Sunday, clocks go back
    context("America/Los_Angeles", 2026, 3, 8, 23, 30), // DST starts that day
    context("Pacific/Auckland", 2026, 12, 31, 23, 59),
    context("Asia/Kolkata", 2027, 2, 28, 0, 0, 30),
    context("UTC", 2028, 2, 29, 12, 0),
    context("America/Santiago", 2026, 9, 6, 10, 0),     // midnight doesn't exist that day
    context("Europe/London", 2026, 10, 26, 0, 5),       // Monday just after midnight
]

let projects = ["Inbox", "Work", "Side Project", "Side", "Plan Tomorrow", "Errands", "Café", "ΟΔΟΣ", "Straße", "C++", "a.b"]
let labels = ["errands", "Waiting For", "home", "Ünïcode", "x-y_z"]

var corpus: [String] = [
    // DateParserTests
    "today", "tod", "tomorrow", "tmr", "tom", "tmrw", "Tomorrow", "TMRW", "yesterday", "tonight", "thu", "friday", "fri",
    "sat", "sunday", "mon", "tues", "wed", "Wednesday", "thurs", "this wed", "this friday", "this mon", "next mon",
    "next monday", "next wed", "next fri", "next sunday", "next week", "weekend", "this weekend", "next weekend",
    "next month", "next year", "in 3 days", "in 1 day", "in 2 weeks", "in a week", "in two days", "in 1 month",
    "in 3 months", "in 1 year", "in 3", "in days", "3 days", "Oct 25", "25 Oct", "October 25", "october 25th", "1st nov",
    "25th of october", "25 october 2027", "oct 25, 2027", "sept 3", "dec 31", "oct 20", "21 oct", "jan 5", "20/10",
    "may 5", "20 oct 2026", "feb 30", "31 nov", "oct 32", "29 feb", "29 feb 2027", "may", "october", "oct 2027", "25/10",
    "25/10/2027", "25/10/27", "1/11", "10/25", "13/13", "25/10/202", "2026-10-25", "2025-01-02", "2026-02-30", "26-10-25",
    "5pm", "5 pm", "5:30pm", "5:30 PM", "5p", "9am", "9 a.m.", "12am", "12pm", "17:00", "9:05", "17", "at 17", "at 5pm",
    "13pm", "0am", "25:00", "24", "5:60", "5:3", "5:30:00", "5xm", "123", "at", "@ 5pm", "noon", "midnight", "eod",
    "morning", "this morning", "afternoon", "evening", "tomorrow at 5pm", "tomorrow 5pm", "5pm tomorrow",
    "at 5pm tomorrow", "fri 9am", "9am on fri", "on friday at noon", "oct 25 14:30", "25 oct 2027 8am", "25/10 17:00",
    "tomorrow morning", "friday evening", "tonight 9pm", "9pm tonight", "next week at 10", "in 2 days at 8:15",
    "tomorrow 17", "tomorrow at", "tomorrow friday", "no date", "No Due Date", "no due", "", "  ", "in", "next", "this",
    "on", "next door", "monkey", "mon key", "tomorrowland", "#tomorrow", "@today", "buy milk", "tomorrow buy milk",
    "today's", "  tomorrow  ", "(tomorrow)", "tomorrow,", "Call mom tomorrow at 5pm please", "Pay rent oct 25",
    "dentist 25/10 9:30", "report due next friday ok", "ship it in 2 weeks", "standup 9am", "Water plants @home every",
    "fri: move tomorrow at 5pm", "fri and mon", "today or tomorrow", "feed the monkey", "Tomorrowland tickets",
    "satisfy wedding", "buy 17 eggs", "page 5", "good morning team", "evening class notes", "call tom", "I may go",
    "march on", "https://x.com/tomorrow", "a/tomorrow", "check in later", "meet at the cafe", "mail a@b.com",
    "v2026-10-25", "C# today's", "meet at 17", "buy 17 eggs tomorrow", "call tomorrow 2 apples", "report this evening",
    "report tomorrow evening", "snack at midnight", "may 5 party", "Call Bob (tomorrow), then", "call tomorrow at",
    "Done by Friday.", "go on fri", "TOMORROW 5PM", "fix no date", "#Plan Tomorrow write",
    "👨‍👩‍👧 party 🎉tomorrow 🎉 fri 5pm",
    // QuickAddParserTests
    "Buy milk tomorrow #Errands @shop p1", "  just   a   task ", "#Side Project fix bug", "fix bug #side project",
    "fix #Side Projector", "fix #Side Project, then ship", "x #foo", "x #Workshop", "x #work", "x #work.", "x #",
    "C# tips", "see page#2", "#Work email #Errands", "call @phone @Home @home @phone x", "ping @waiting for reply",
    "x @foo-bar_2 @café @a.b @", "ok @done.", "mail bob@example.com about https://x.com/@me/#top and www.y.com/tomorrow",
    "x p1", "x P2", "p3 x", "x p4.", "x p5", "x p0", "x p1x", "x top1", "x p11", "x #p1", "x @p1", "p1 then p3",
    "Call mom tomorrow at 5pm #Work", "Pay rent oct 25 p2", "x #today @tomorrow", "#Plan Tomorrow write friday",
    "fix #Work no date", "x no due date", "Call Bob tomorrow, then email", "Buy milk, tomorrow", "Buy milk (tomorrow)",
    "👨‍👩‍👧 party 🎉 #Side Project @home tomorrow 5pm p2 🎂", "#Wo", "fix @ho", "fix #", "a #Work b", "plain",
    "mail a@b", "C#", "#work fix", "#work ", "🎉 buy @gro",
    // Unicode and edge cases
    "a \u{301}b tomorrow", "x \u{301}#Work y", "\u{600} tomorrow", "tomorrow.\u{301}", "(\u{301}tomorrow",
    "p\u{661} x", "x p\u{2163}", "x p①", "x p1\u{301}", "x p½", "x p١", "x ｐ1", "x p一", "x p¹",
    "buy\u{a0}milk\u{a0}tomorrow", "buy\u{2003}milk tomorrow\u{3000}#Work", "x\u{1c}tomorrow", "x\u{85}tomorrow",
    "x\u{200b}tomorrow", "x #️⃣ tomorrow", "x #\u{20e3}Work", "x #Work\u{301}", "x #café", "x #cafe\u{301} now",
    "x #CAFÉ", "x #οδος", "x #ΟΔΟΣ y", "x #strasse", "x #STRASSE!", "x #c++ y", "x #A.B", "x @ÜNÏCODE", "x @x-y_z.",
    "x tomorrow\u{37e} y", "Call Bob tomorrow\u{37e} then", "x 1\u{212A}m", "0000-01-01", "0000-02-29", "1500-02-29",
    "1582-10-10", "1582-10-04", "1582-10-15", "1600-02-29", "1700-02-29", "29/02/1500", "29/2/1700", "9999-12-31",
    "25/10/0099", "1/1/00", "31/12/99", "2026-1-5", "2026-01-5 9am", "2026--10", "-2026-10-25", "2026-10-25-",
    "25/10/", "/10", "25//10", "25/10/2027/1", "00/10", "10/00", "0/0", "12/13", "13/12", "32/1", "1/32",
    "in 999 days", "in 999 years", "in 1000 days", "in 0 days", "in 00 weeks", "in twelve months", "in an hour",
    "at 0", "at 00", "at 00:00", "at 23:59", "at 24:00", "at 12:00am", "at 12:30 a.m", "5 a.m", "5 p.m.", "5 P.M",
    "5:30a", "1pm", "01pm", "001pm", "12:60", "9.30", "9h30", "noon tomorrow", "midday on fri", "eod friday",
    "this afternoon", "this evening tomorrow", "this noon", "tonight at 8", "on tonight", "on today", "on 25 oct",
    "on oct 25 at 5pm", "at 5pm on oct 25", "at 5pm on", "next tomorrow", "next jan", "this jan", "this tomorrow",
    "1st", "2nd jan", "3rd of march 2030", "4th of", "31st feb", "11th nov 2199", "11th nov 2200", "jan 1 2000",
    "jan 1 1999", "december 32", "dec 0", "Dec 01", "dec 1st, 2026", "monday 25 oct", "fri 25 oct", "oct",
    "„tomorrow“", "“tomorrow”", "‘fri’", "[tomorrow]", "{tomorrow}", "tomorrow!?", "tomorrow...", "'tomorrow'",
    "\"no date\"", "no\u{a0}date", "no  due   date", "NO DATE", "no date tomorrow", "tomorrow no date",
    "Buy milk tomorrow\n#Errands", "line1\nline2 @home p2", "tab\tseparated\ttomorrow", "\r\ntomorrow\r\n",
    "a #Side Project, b", "a #Side Project: b", "a #Side Project; b", "a #Side Project? b", "#Side", "#Side Pro",
    "#Errands p1 p2 p3 p4", "@errands @ERRANDS @Errands", "@waiting for @waiting", "@Waiting For,", "@waiting forever",
    "x #Plan Tomorrow tomorrow", "x #plan tomorrow 5pm", "tomorrow #Plan Tomorrow", "p1 #Work @home tomorrow 9am",
    "call 555 1234 tomorrow", "version 2.0 next week", "50% off fri", "a, b, c tomorrow,", "tomorrow, a, b",
    "x tomorrow ,", "x tomorrow ;", "x tomorrow :", "x tomorrow .", "x tomorrow !", ", tomorrow", "tomorrow ,,",
    "🎉", "🎉 #Work", "#🎉", "@🎉", "x #Work🎉", "x #Work 🎉", "👍🏽 p1 tomorrow", "🇬🇧 trip next week", "日本語 明日 #Work",
    "Ünïcödé tëxt tomorrow", "e\u{301}cole tomorrow", "Straße p3", "İstanbul friday", "ﬁle report fri",
]

// Generated combinations and fuzz.
do {
    var r = RNG(4)
    let dates = ["tomorrow", "fri", "next week", "in 3 days", "oct 25", "25/10", "2026-10-25", "at 17:00", "5pm",
                 "tomorrow at 5pm", "no date", "this evening", "next fri 9am", "25th of october", "tonight"]
    let templates = ["Buy milk %@", "%@ call mom #Work p2", "fix %@, then ship @home", "#Side Project %@ write",
                     "p1 %@ @errands", "Email (%@) bob@x.com", "%@: standup", "a %@ b %@"]
    for d in dates { for t in templates { corpus.append(t.replacingOccurrences(of: "%@", with: d)) } }
    let words = ["buy", "milk", "tomorrow", "fri", "next", "week", "at", "5pm", "17", "17:00", "#Work", "#Side", "Project",
                 "@home", "@waiting", "for", "p1", "p4", "p5", "no", "date", "due", "in", "3", "days", "oct", "25", "25th",
                 "of", "2027", ",", ".", "(", ")", "\"", "this", "evening", "morning", "on", "the", "🎉", "é", "e\u{301}",
                 "\u{a0}", " ", "  ", "#", "@", "a@b.c", "x.com/@me", "C#", "tom", "may", "5", "may 5", "12am", "noon",
                 "#Plan", "Tomorrow", "\u{301}", "Café", "#café", "@Ünïcode", "p\u{661}", "25/10", "2026-10-25", "29/2"]
    for _ in 0..<400 {
        var s = ""
        for i in 0..<(1 + r.int(8)) {
            if i > 0 { s += r.int(8) == 0 ? "" : (r.int(10) == 0 ? "\u{a0}" : " ") }
            s += r.pick(words)
        }
        corpus.append(s)
    }
}

do {
    var dp: [[String: Any]] = []
    var qa: [[String: Any]] = []
    for (ci, ctx) in contexts.enumerated() {
        let (cal, now, desc) = ctx
        for s in corpus {
            var rec: [String: Any] = ["c": ci, "s": b64(s)]
            rec["parse"] = dueTree(DateParser.parse(s, now: now, calendar: cal))
            switch DateParser.parsePhrase(s, now: now, calendar: cal) {
            case .due(let d)?: rec["phrase"] = dueTree(d)
            case .clear?: rec["phrase"] = "clear"
            case nil: rec["phrase"] = NSNull()
            }
            if let f = DateParser.find(in: s, now: now, calendar: cal) {
                rec["find"] = [utf16(s, f.range), dueTree(f.due)]
            } else { rec["find"] = NSNull() }
            if let m = DateParser.findPhrase(in: s, now: now, calendar: cal) {
                switch m.phrase {
                case .due(let d): rec["findPhrase"] = [utf16(s, m.range), dueTree(d)]
                case .clear: rec["findPhrase"] = [utf16(s, m.range), "clear"]
                }
            } else { rec["findPhrase"] = NSNull() }
            dp.append(rec)
            if ci < 3 {
                let q = QuickAddParser.parse(s, projects: projects, labels: labels, now: now, calendar: cal)
                var o: [String: Any] = ["c": ci, "s": b64(s), "title": b64(q.title), "labels": q.labels.map(b64),
                                        "clearDue": q.clearDue, "due": dueTree(q.due),
                                        "tokens": q.tokens.map { t -> [Any] in
                                            let k: String
                                            switch t.kind {
                                            case .project: k = "project"
                                            case .label: k = "label"
                                            case .priority: k = "priority"
                                            case .date: k = "date"
                                            }
                                            return [k, t.range.location, t.range.length]
                                        }]
                o["project"] = q.project.map { b64($0) as Any } ?? NSNull()
                o["priority"] = q.priority.map { $0 as Any } ?? NSNull()
                if ci == 0 {
                    let len = (s as NSString).length
                    o["completion"] = [0, len / 2, len, len + 5].map { caret -> Any in
                        guard let c = QuickAddParser.completionContext(s, caret: caret) else { return NSNull() }
                        return [caret, c.kind == .project ? "project" : "label", b64(c.query), c.range.location, c.range.length]
                    }
                }
                qa.append(o)
            }
        }
    }
    write("parser_contexts", contexts.map { $0.2 })
    write("dateparser", ["projects": projects.map(b64), "labels": labels.map(b64), "records": dp] as [String: Any])
    write("quickadd", ["projects": projects.map(b64), "labels": labels.map(b64), "records": qa] as [String: Any])
}

// MARK: - 5. queries and due labels

do {
    var r = RNG(5)
    var out: [[String: Any]] = []
    for (ci, ctx) in contexts.enumerated() where [0, 1, 3, 7].contains(ci) {
        let (cal, now, _) = ctx
        let dates = TodoDates(calendar: cal, now: now)
        for round in 0..<12 {
            var projectsDocs: [TodoDoc] = []
            for p in 0..<3 {
                var d = TodoDoc.newProject(name: ["Work", "Home", "Old"][p], order: Double(r.int(3)) * 1024, now: Int64(10 + p))
                d.id = "p\(p)"
                if r.int(3) == 0 { d.setArchived(true, at: 20) }
                projectsDocs.append(d)
            }
            var tasks: [TodoDoc] = []
            for t in 0..<(5 + r.int(15)) {
                let due: DueDate? = r.int(3) == 0 ? nil : DueDate(date: dates.adding(days: r.int(30) - 10, to: dates.today),
                                                                    time: r.bool() ? nil : String(format: "%02d:%02d", r.int(24), r.pick([0, 15, 30, 59])))
                var d = TodoDoc.newTask(title: "t\(t) " + r.pick(["Buy milk", "Email Bob", "Ship it", "Other"]),
                                        project: r.int(3) == 0 ? nil : r.pick(["p0", "p1", "p2", "gone"]),
                                        labels: r.int(2) == 0 ? [] : [r.pick(["admin", "Admin", "home"])],
                                        priority: 1 + r.int(4), due: due, order: Double(r.int(5)) * 512, now: Int64(100 + r.int(3)))
                d.id = "task\(t)"
                if r.int(4) == 0 {
                    let back = Int64(now.timeIntervalSince1970 * 1000) - Int64(r.int(3)) * 86_400_000 - Int64(r.int(3_600_000))
                    d.setCompleted(back, at: 2000)
                }
                tasks.append(d)
            }
            let views: [(String, TodoListView)] = [("inbox", .inbox), ("today", .today), ("upcoming", .upcoming),
                                                  ("project:p0", .project("p0")), ("project:p2", .project("p2")),
                                                  ("label:admin", .label("admin")), ("search:bob", .search("bob")),
                                                  ("search:#work", .search("#work")), ("search:@home t1", .search("@home t1"))]
            var results: [[Any]] = []
            for (name, v) in views {
                for showCompleted in [false, true] {
                    let rows = TodoQuery.rows(for: v, tasks: tasks, projects: projectsDocs, showCompleted: showCompleted, dates: dates)
                    results.append([name, showCompleted, rows.map { row -> [Any] in
                        switch row {
                        case .header(let id, let title, let subtitle, let date):
                            return ["h", id, title, subtitle.map { $0 as Any } ?? NSNull(), date.map { $0 as Any } ?? NSNull()]
                        case .task(let t): return ["t", t.id]
                        }
                    }])
                }
            }
            let c = TodoQuery.counts(tasks: tasks, projects: projectsDocs, dates: dates)
            out.append(["c": ci, "round": round, "tasks": tasks.map(docTree), "projects": projectsDocs.map(docTree),
                        "views": results, "counts": [c.inbox, c.today, c.overdue, c.byProject]])
        }
    }
    write("queries", out)

    var labelsOut: [[Any]] = []
    for (ci, ctx) in contexts.enumerated() {
        let (cal, now, _) = ctx
        let dates = TodoDates(calendar: cal, now: now)
        for off in -400...400 where off % 7 == 0 || abs(off) < 10 {
            for time in [nil, "00:00", "09:05", "17:00", "23:59"] as [String?] {
                let due = DueDate(date: dates.adding(days: off, to: dates.today), time: time)
                labelsOut.append([ci, due.date, time.map { $0 as Any } ?? NSNull(),
                                  due.label(now: now, calendar: cal, locale: Locale(identifier: "en_GB")),
                                  due.label(now: now, calendar: cal, locale: Locale(identifier: "en_US")),
                                  due.isOverdue(now: now, calendar: cal), due.days(from: now, calendar: cal).map { $0 as Any } ?? NSNull(),
                                  dates.header(due.date).title, dates.header(due.date).subtitle.map { $0 as Any } ?? NSNull()])
            }
        }
        for bad in ["garbage", "2026-13-01", "2026-02-30", "2026-10-25", "0000-01-01"] {
            for time in [nil, "25:00", "5pm", "-1:30", "12:99"] as [String?] {
                let due = DueDate(date: bad, time: time)
                labelsOut.append([ci, bad, time.map { $0 as Any } ?? NSNull(),
                                  due.label(now: now, calendar: cal, locale: Locale(identifier: "en_GB")),
                                  due.label(now: now, calendar: cal, locale: Locale(identifier: "en_US")),
                                  due.isOverdue(now: now, calendar: cal), due.days(from: now, calendar: cal).map { $0 as Any } ?? NSNull(),
                                  dates.header(due.date).title, dates.header(due.date).subtitle.map { $0 as Any } ?? NSNull()])
            }
        }
    }
    write("due_labels", labelsOut)
}
