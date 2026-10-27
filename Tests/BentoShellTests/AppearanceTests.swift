import Foundation
import Testing
@testable import BentoCore
@testable import BentoShell

private func tempConfig(_ json: String) throws -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("bento-cfg-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let url = dir.appendingPathComponent("config.json")
    try Data(json.utf8).write(to: url)
    return url
}

@Test func themeDefaultsToStandard() throws {
    #expect(GeneralSettings().theme == .standard)
    // Configs from before themes existed.
    let store = ConfigStore(url: try tempConfig(#"{"general":{"showMenuBarIcon":false}}"#))
    let general = store.section("general", default: GeneralSettings())
    #expect(general.theme == .standard)
    #expect(!general.showMenuBarIcon)
}

@Test func themeChoiceIsPersisted() throws {
    let url = try tempConfig(#"{"general":{}}"#)
    let store = ConfigStore(url: url)
    var general = store.section("general", default: GeneralSettings())
    general.theme = .aero
    store.setSection("general", general)
    store.flush()

    let object = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    #expect((object["general"] as? [String: Any])?["theme"] as? String == "aero")
    #expect(ConfigStore(url: url).section("general", default: GeneralSettings()).theme == .aero)
}

@Test func unknownThemeFallsBackWithoutLosingOtherSettings() throws {
    let store = ConfigStore(url: try tempConfig(#"{"general":{"theme":"vista","checkForUpdates":false}}"#))
    let general = store.section("general", default: GeneralSettings())
    #expect(general.theme == .standard)
    #expect(!general.checkForUpdates)
}
