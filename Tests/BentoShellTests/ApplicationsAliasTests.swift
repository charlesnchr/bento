import Testing
@testable import BentoShell

@Suite struct ApplicationsAliasTests {
    let brew = "/opt/homebrew/Cellar/bento/0.1.1/Bento.app"
    let home = "/Users/x"

    func action(_ bundle: String, _ existing: ApplicationsAlias.Existing, realApp: Bool = false) -> ApplicationsAlias.Action {
        ApplicationsAlias.action(bundlePath: bundle, home: home, existing: existing, realAppInApplications: realApp)
    }

    @Test func homebrewCopyGetsAnAlias() {
        #expect(action(brew, .none) == .write)
        #expect(action(brew, .alias(current: true, toBento: true)) == .keep)
        // after an upgrade (new keg) or a deleted keg
        #expect(action(brew, .alias(current: false, toBento: true)) == .replace)
        // an old link from build.sh or the formula caveats: Spotlight ignores links
        #expect(action(brew, .symlink(toBento: true)) == .replace)
    }

    @Test func leavesTheUsersThingsAlone() {
        #expect(action(brew, .symlink(toBento: false)) == .keep)
        #expect(action(brew, .alias(current: false, toBento: false)) == .keep)
        #expect(action(brew, .other) == .keep)
    }

    @Test func noAliasWhereSpotlightAlreadyLooks() {
        #expect(action("/Applications/Bento.app", .none) == .keep)
        #expect(action("/Users/x/Applications/Bento.app", .none) == .keep)
        #expect(action(brew, .none, realApp: true) == .keep)
    }
}
