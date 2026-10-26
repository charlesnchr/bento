import AppKit
import Testing
@testable import BentoCore

@Test func standardThemeKeepsWindowBackgrounds() {
    let s = ThemeStyle(theme: .standard)
    #expect(s == .standard)
    #expect(!s.isGlass)
    #expect(s.material == nil)
}

@Test func glassThemesAreTranslucentAndReadable() {
    for theme in [Theme.glass, .aero] {
        let s = ThemeStyle(theme: theme)
        #expect(s.isGlass)
        #expect(s.frost > 0, "\(theme): needs a frost to keep text readable")
        #expect(s.frost < 0.5, "\(theme): too much frost hides the glass")
    }
    // Only Aero tints with the accent colour; it has the stronger sheen.
    #expect(ThemeStyle(theme: .glass).tint == 0)
    #expect(ThemeStyle(theme: .aero).tint > 0)
    #expect(ThemeStyle(theme: .aero).sheen > ThemeStyle(theme: .glass).sheen)
}

@Test func reduceTransparencyFallsBackToStandard() {
    for theme in Theme.allCases {
        #expect(ThemeStyle(theme: theme, reduceTransparency: true) == .standard)
        #expect(ThemeStyle(theme: theme, reduceTransparency: true, increaseContrast: true) == .standard)
    }
}

@Test func increaseContrastThickensTheFrost() {
    #expect(ThemeStyle(theme: .glass, increaseContrast: true).frost > ThemeStyle(theme: .glass).frost)
    #expect(ThemeStyle(theme: .aero, increaseContrast: true).frost > ThemeStyle(theme: .aero).frost)
    #expect(ThemeStyle(theme: .standard, increaseContrast: true) == .standard)
}

@Test func themeIsStoredAsItsName() throws {
    struct Box: Codable, Equatable { var theme: Theme }
    let data = try JSONEncoder().encode(Box(theme: .aero))
    #expect(String(decoding: data, as: UTF8.self) == #"{"theme":"aero"}"#)
    for theme in Theme.allCases {
        let json = Data(#"{"theme":"\#(theme.rawValue)"}"#.utf8)
        #expect(try JSONDecoder().decode(Box.self, from: json).theme == theme)
    }
    #expect(Theme.allCases.map(\.title) == ["Standard", "Glass", "Aero"])
}

@MainActor @Test func selectingAThemePostsOneChange() {
    let center = ThemeCenter()
    var changes = 0
    let token = NotificationCenter.default.addObserver(forName: ThemeCenter.didChange, object: center, queue: nil) { _ in changes += 1 }
    defer { NotificationCenter.default.removeObserver(token) }

    center.select(.glass)
    #expect(center.selected == .glass)
    center.select(.glass)
    #expect(center.selected == .glass)
    if center.reduceTransparency {
        // The machine running the tests has Reduce Transparency on: windows stay standard.
        #expect(center.style == .standard)
        #expect(changes == 0)
    } else {
        #expect(center.style.isGlass)
        #expect(changes == 1)
    }
    center.select(.standard)
    #expect(center.style == .standard)
}
