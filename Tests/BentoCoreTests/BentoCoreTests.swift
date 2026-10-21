import AppKit
import Testing
@testable import BentoCore

@Test func parsesAndFormatsShortcuts() throws {
    let s = try #require(Shortcut("ctrl+opt+left"))
    #expect(s.modifiers == [.control, .option])
    #expect(s.configString == "ctrl+opt+left")
    #expect(s.displayString == "⌃⌥←")

    let h = try #require(Shortcut("hyper+t"))
    #expect(h.modifiers == [.control, .option, .command, .shift])
    #expect(h.configString == "hyper+t")

    let meh = try #require(Shortcut("Meh+N"))
    #expect(meh.modifiers == [.control, .option, .shift])

    #expect(Shortcut("cmd+shift+2")?.displayString == "⇧⌘2")
    #expect(Shortcut("cmd+enter")?.configString == "cmd+return")
    #expect(Shortcut("cmd+bogus") == nil)
    #expect(Shortcut("wat+a") == nil)
    #expect(Shortcut("") == nil)
}

@Test func shortcutCodableRoundTrip() throws {
    struct Box: Codable, Equatable { var s: Shortcut }
    let data = try JSONEncoder().encode(Box(s: Shortcut("ctrl+opt+cmd+f12")!))
    #expect(String(decoding: data, as: UTF8.self) == #"{"s":"ctrl+opt+cmd+f12"}"#)
    #expect(try JSONDecoder().decode(Box.self, from: data).s == Shortcut("ctrl+opt+cmd+f12"))
}

@Test func configMergeFillsMissingKeys() {
    let base: [String: Any] = ["a": 1, "nested": ["x": 1, "y": 2]]
    let override: [String: Any] = ["nested": ["y": 3], "b": true]
    let merged = ConfigStore.merge(base, override) as! [String: Any]
    #expect(merged["a"] as? Int == 1)
    #expect(merged["b"] as? Bool == true)
    let nested = merged["nested"] as! [String: Any]
    #expect(nested["x"] as? Int == 1)
    #expect(nested["y"] as? Int == 3)
}

@Test func configSectionsUseDefaultsForMissingFields() throws {
    struct S: Codable, Equatable { var enabled = true; var count = 3; var name = "x" }
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("bento-cfg-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let url = dir.appendingPathComponent("config.json")
    try Data(#"{"mod":{"count":7}}"#.utf8).write(to: url)
    let store = ConfigStore(url: url)
    let s = store.section("mod", default: S())
    #expect(s == S(enabled: true, count: 7, name: "x"))
    store.setSection("mod", S(enabled: false, count: 1, name: "y"))
    store.flush()
    let reloaded = ConfigStore(url: url).section("mod", default: S())
    #expect(reloaded == S(enabled: false, count: 1, name: "y"))
}

@Test func axCocoaConversionIsInvolution() {
    let r = CGRect(x: 10, y: 20, width: 300, height: 200)
    #expect(NSScreen.cocoaRect(fromAX: NSScreen.axRect(fromCocoa: r)) == r)
}

@Test func sqliteRoundTrip() throws {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent("bento-\(UUID().uuidString).db").path
    let db = try SQLiteDB(path: path)
    try db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, blob BLOB, n REAL)")
    try db.run("INSERT INTO t (name, blob, n) VALUES (?, ?, ?)", ["hi", Data([1, 2, 3]), 1.5])
    try db.run("INSERT INTO t (name, blob, n) VALUES (?, ?, ?)", [nil, nil, nil])
    let rows = try db.query("SELECT * FROM t ORDER BY id")
    #expect(rows.count == 2)
    #expect(rows[0]["name"] as? String == "hi")
    #expect(rows[0]["blob"] as? Data == Data([1, 2, 3]))
    #expect(rows[0]["n"] as? Double == 1.5)
    #expect((rows[1]["name"] ?? nil) == nil)
}

@Test func jsonWriterFormatsNumbersAndEscapes() throws {
    let obj: [String: Any] = ["b": 0.9, "a": ["x": true, "n": 3, "d": 2.0], "s": "q\"\n/", "e": [Any](), "z": NSNull()]
    let text = String(decoding: JSONWriter.data(obj), as: UTF8.self)
    #expect(text.contains("\"b\": 0.9"))
    #expect(text.contains("\"d\": 2"))
    #expect(text.contains("\"x\": true"))
    #expect(text.contains(#""s": "q\"\n/""#))
    #expect(text.contains("\"e\": []"))
    let back = try JSONSerialization.jsonObject(with: JSONWriter.data(obj)) as! [String: Any]
    #expect((back["b"] as? Double) == 0.9)
    #expect(text.firstRange(of: "\"a\"")!.lowerBound < text.firstRange(of: "\"b\"")!.lowerBound)
}
