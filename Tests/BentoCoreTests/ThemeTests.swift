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

@MainActor @Test func themedContentKeepsStandardVibrantAppearance() {
    for material in [NSVisualEffectView.Material.popover, .hudWindow, .contentBackground] {
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let nativeRoot = NSView()
            nativeRoot.appearance = NSAppearance(named: appearance)
            let native = NSVisualEffectView()
            native.material = material
            nativeRoot.addSubview(native)
            let nativeLabel = NSTextField(labelWithString: "Secondary text")
            native.addSubview(nativeLabel)

            let label = NSTextField(labelWithString: "Secondary text")
            let background = ThemedBackgroundView(material: material, content: label)
            background.appearance = NSAppearance(named: appearance)
            #expect(label.isDescendant(of: background.effect))
            #expect(label.effectiveAppearance.name == nativeLabel.effectiveAppearance.name)
        }
    }
}

@MainActor @Suite(.serialized) struct ThemedBackgroundTests {
    init() {
        ThemeCenter.shared.updateAccessibility(reduceTransparency: false, increaseContrast: false)
        ThemeCenter.shared.select(.standard)
    }

    private func restoreTheme() {
        ThemeCenter.shared.select(.standard)
        ThemeCenter.shared.updateAccessibility(
            reduceTransparency: NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency,
            increaseContrast: NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast)
    }

    @Test func liveSwitchingReusesViewsAndRestoresTheNativeMaterial() throws {
        defer { restoreTheme() }
        let content = NSTextField(labelWithString: "Content")
        let background = ThemedBackgroundView(material: .popover, content: content)
        let effect = background.effect
        let glaze = try #require(effect.subviews.first)
        var changes = 0
        background.onChange = { _ in changes += 1 }
        #expect(glaze.isHidden)

        for _ in 0..<10 {
            for theme in [Theme.glass, .aero, .standard] {
                ThemeCenter.shared.select(theme)
                ThemeCenter.shared.select(theme)
                #expect(background.effect === effect)
                #expect(effect.subviews.count == 2)
                #expect(effect.subviews.first === glaze)
                #expect(content.superview === effect)
                #expect(effect.material == (theme == .standard ? .popover : .hudWindow))
                #expect(glaze.isHidden == (theme == .standard))
            }
        }
        #expect(changes == 30)
    }

    @Test func accessibilityChangesUpdateOpenViewsWithoutChangingTheSelection() throws {
        defer { restoreTheme() }
        let background = ThemedBackgroundView(material: .popover)
        let plain = ThemedBackgroundView(material: nil)
        let glaze = try #require(background.effect.subviews.first)
        ThemeCenter.shared.select(.aero)
        #expect(!plain.effect.isHidden)
        ThemeCenter.shared.updateAccessibility(reduceTransparency: true, increaseContrast: true)
        #expect(ThemeCenter.shared.selected == .aero)
        #expect(ThemeCenter.shared.style == .standard)
        #expect(background.effect.material == .popover)
        #expect(glaze.isHidden)
        #expect(plain.effect.isHidden)
        ThemeCenter.shared.updateAccessibility(reduceTransparency: false, increaseContrast: true)
        #expect(ThemeCenter.shared.style == ThemeStyle(theme: .aero, increaseContrast: true))
        #expect(background.effect.material == .hudWindow)
        #expect(!glaze.isHidden)
        #expect(!plain.effect.isHidden)
    }

    @Test func backgroundsAndContentAreReleased() {
        defer { restoreTheme() }
        weak var background: ThemedBackgroundView?
        weak var content: NSView?
        weak var effect: NSVisualEffectView?
        autoreleasepool {
            let label = NSTextField(labelWithString: "Content")
            let view = ThemedBackgroundView(material: .popover, content: label)
            background = view
            content = label
            effect = view.effect
            ThemeCenter.shared.select(.glass)
        }
        #expect(background == nil)
        #expect(content == nil)
        #expect(effect == nil)
        ThemeCenter.shared.select(.aero)
    }
}
