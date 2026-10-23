import Testing
@testable import BentoShell

@Test func versionOrdering() {
    #expect(UpdateRules.isNewer("0.2.0", than: "0.1.0"))
    #expect(UpdateRules.isNewer("0.10.0", than: "0.9.1"))
    #expect(UpdateRules.isNewer("1.0", than: "0.99.99"))
    #expect(UpdateRules.isNewer("0.1.1", than: "0.1"))
    #expect(!UpdateRules.isNewer("0.1.0", than: "0.1.0"))
    #expect(!UpdateRules.isNewer("0.1", than: "0.1.0"))
    #expect(!UpdateRules.isNewer("0.1.0", than: "0.2.0"))
    #expect(!UpdateRules.isNewer("0.2.0-dev", than: "0.2.0"))
}

@Test func formulaVersionLine() {
    let formula = """
    class Bento < Formula
      desc "Menu-bar app"
      url "https://github.com/charlesnchr/bento/releases/download/v0.3.1/Bento-0.3.1.zip", using: :nounzip
      version "0.3.1"
      sha256 "abc"
    end
    """
    #expect(UpdateRules.formulaVersion(formula) == "0.3.1")
    #expect(UpdateRules.formulaVersion("  version \"@VERSION@\"") == nil)
    #expect(UpdateRules.formulaVersion("version \"\"") == nil)
    #expect(UpdateRules.formulaVersion("# no version here") == nil)
}

@Test func homebrewKegDetection() {
    #expect(UpdateRules.homebrewPrefix(forBundle: "/opt/homebrew/Cellar/bento/0.2.0/Bento.app") == "/opt/homebrew")
    #expect(UpdateRules.homebrewPrefix(forBundle: "/usr/local/Cellar/bento/0.2.0_1/Bento.app") == "/usr/local")
    #expect(UpdateRules.homebrewPrefix(forBundle: "/Applications/Bento.app") == nil)
    #expect(UpdateRules.homebrewPrefix(forBundle: "/opt/homebrew/opt/bento/Bento.app") == nil)
    #expect(UpdateRules.homebrewPrefix(forBundle: "/Cellar/bento/0.2.0/Bento.app") == nil)
    #expect(UpdateRules.homebrewPrefix(forBundle: "/opt/homebrew/Cellar/other/0.2.0/Bento.app") == nil)
}

@Test func homebrewKegForOtherFormulaName() {
    #expect(UpdateRules.homebrewPrefix(forBundle: "/opt/homebrew/Cellar/bento-test/0.1.0/Bento.app", formula: "bento-test") == "/opt/homebrew")
    #expect(UpdateRules.homebrewPrefix(forBundle: "/opt/homebrew/Cellar/bento/0.1.0/Bento.app", formula: "bento-test") == nil)
}
