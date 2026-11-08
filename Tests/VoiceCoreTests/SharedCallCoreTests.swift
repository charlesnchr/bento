import Foundation
import Testing
@testable import VoiceCore

/// JavaScriptCore answers every recorded scenario (voice-core/scenarios) exactly as Node did when it recorded them.
@Suite struct SharedCallCoreTests {
    private let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../voice-core").standardized

    private func core() throws -> SharedCallCore {
        try SharedCallCore(contentsOf: dir.appendingPathComponent("dist/voice-core.js"))
    }

    @Test func everyScenarioAnswersAsItsGoldenFileSays() throws {
        let scenarios = try FileManager.default.contentsOfDirectory(atPath: dir.appendingPathComponent("scenarios").path)
            .filter { $0.hasSuffix(".json") && !$0.hasSuffix(".golden.json") }.sorted()
        #expect(!scenarios.isEmpty)
        for file in scenarios {
            let name = String(file.dropLast(5))
            let data = try Data(contentsOf: dir.appendingPathComponent("scenarios/\(file)"))
            let recording = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let golden = try String(contentsOf: dir.appendingPathComponent("scenarios/\(name).golden.json"), encoding: .utf8)
                .trimmingCharacters(in: .newlines).components(separatedBy: "\n")
            let core = try core()
            let config = String(decoding: try JSONSerialization.data(withJSONObject: recording["config"]!), as: UTF8.self)
            let created = try core.create(configJSON: config, t: (recording["start"] as? Double) ?? 0)
            var answers = [created]
            let id = try #require((try JSONSerialization.jsonObject(with: Data(created.utf8)) as? [String: Any])?["id"] as? Int)
            for event in try rawEvents(data) { answers.append(try core.push(id: id, eventJSON: event)) }
            #expect(answers.count == golden.count, "\(name)")
            for (i, (got, want)) in zip(answers, golden).enumerated() where got != want {
                Issue.record("\(name): answer \(i) differs")
                break
            }
        }
    }

    @Test func aCallStartsWithItsSocket() throws {
        let core = try core()
        let created = try core.create(configJSON: #"{"today":"2026-11-08"}"#, t: 0)
        #expect(created.hasPrefix(#"{"id":1,"commands":[{"type":"status","status":"connecting"},{"type":"ws.connect""#))
        #expect(core.version.count == 12)
    }

    /// The recording's events as JSON text. JSONSerialization keeps neither key order nor the text of
    /// numbers, but the core reads events by key and a time written back parses to the same double.
    private func rawEvents(_ data: Data) throws -> [String] {
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let events = try #require(object["events"] as? [[String: Any]])
        return try events.map { String(decoding: try JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys]), as: UTF8.self) }
    }
}
