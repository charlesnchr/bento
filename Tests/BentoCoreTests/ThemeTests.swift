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
    for theme in [Theme.glass, .tinted] {
        let s = ThemeStyle(theme: theme)
        #expect(s.isGlass)
        #expect(s.appearance == nil, "\(theme): follows light and dark")
        for dark in [false, true] {
            let alpha = try! #require(s.surface).components(dark: dark).alpha
            #expect(alpha > 0.3, "\(theme): needs a frost to keep text readable")
            #expect(alpha < 0.8, "\(theme): too much frost hides the glass")
        }
    }
    // Only Tinted washes the glass with the accent colour, and only lightly so
    // selections (accent-coloured) still stand out.
    #expect(ThemeStyle(theme: .glass).tint == 0)
    #expect(ThemeStyle(theme: .tinted).tint > 0)
    #expect(ThemeStyle(theme: .tinted).tint <= 0.15)
}

@Test func graphiteAndPaperAreOpaqueWithAFixedAppearance() {
    let graphite = ThemeStyle(theme: .graphite), paper = ThemeStyle(theme: .paper)
    #expect(graphite.appearance == .darkAqua)
    #expect(paper.appearance == .aqua)
    for s in [graphite, paper] {
        #expect(s.replacesBackground)
        #expect(!s.isGlass)
        #expect(s.material == nil)
        #expect(s.surface?.light.alpha == 1)
        #expect(s.surface?.dark.alpha == 1)
    }
}

/// Text colours resolved in `appearance`, with the alpha they're drawn with.
private func textColors(dark: Bool) -> [(String, NSColor)] {
    var colors: [(String, NSColor)] = []
    NSAppearance(named: dark ? .darkAqua : .aqua)!.performAsCurrentDrawingAppearance {
        colors = [("label", NSColor.labelColor), ("secondary", NSColor.secondaryLabelColor)]
            .map { ($0.0, $0.1.usingColorSpace(.sRGB)!) }
    }
    return colors
}

@Test func textStaysLegibleOnEveryTheme() {
    // Primary text gets WCAG AAA (7:1). Secondary text is drawn at half
    // opacity by macOS and gets about 4:1 on a standard light window, so it
    // may lose at most a tenth of that (3.5:1). Opaque themes are checked
    // exactly; glass over a mid grey (what a busy wallpaper blurs to,
    // ignoring the material's own frost), and over its worst case (black
    // behind light glass, white behind dark) primary text still gets 3:1.
    for theme in Theme.allCases where theme != .standard {
        let s = ThemeStyle(theme: theme)
        let appearances = s.appearance.map { [$0 == .darkAqua] } ?? [false, true]
        for dark in appearances {
            var backdrops: [(NSColor, label: CGFloat, secondary: CGFloat)] = [(NSColor(white: 0.5, alpha: 1), 7, 3.5)]
            if s.isGlass { backdrops.append((dark ? .white : .black, 3, 0)) }
            for (backdrop, labelMin, secondaryMin) in backdrops {
                let bg = s.background(dark: dark, backdrop: backdrop)
                for (name, text) in textColors(dark: dark) {
                    let ratio = text.over(bg).contrast(with: bg)
                    let min = name == "label" ? labelMin : secondaryMin
                    #expect(ratio >= min, "\(theme) \(dark ? "dark" : "light") \(name) over \(backdrop): \(ratio)")
                }
            }
        }
    }
}

@Test func reduceTransparencyTurnsGlassStandard() {
    for theme in [Theme.standard, .glass, .tinted] {
        #expect(ThemeStyle(theme: theme, reduceTransparency: true) == .standard)
        #expect(ThemeStyle(theme: theme, reduceTransparency: true, increaseContrast: true) == .standard)
    }
    // Nothing shows through the opaque themes: they stay.
    for theme in [Theme.graphite, .paper] {
        #expect(ThemeStyle(theme: theme, reduceTransparency: true) == ThemeStyle(theme: theme))
    }
}

@Test func increaseContrastThickensTheFrost() {
    for theme in [Theme.glass, .tinted] {
        let normal = try! #require(ThemeStyle(theme: theme).surface)
        let contrast = try! #require(ThemeStyle(theme: theme, increaseContrast: true).surface)
        #expect(contrast.light.alpha > normal.light.alpha)
        #expect(contrast.dark.alpha > normal.dark.alpha)
    }
    #expect(ThemeStyle(theme: .standard, increaseContrast: true) == .standard)
    #expect(ThemeStyle(theme: .graphite, increaseContrast: true) == ThemeStyle(theme: .graphite))
}

@Test func themeIsStoredAsItsName() throws {
    struct Box: Codable, Equatable { var theme: Theme }
    let data = try JSONEncoder().encode(Box(theme: .tinted))
    #expect(String(decoding: data, as: UTF8.self) == #"{"theme":"tinted"}"#)
    for theme in Theme.allCases {
        let json = Data(#"{"theme":"\#(theme.rawValue)"}"#.utf8)
        #expect(try JSONDecoder().decode(Box.self, from: json).theme == theme)
    }
    #expect(Theme.allCases.map(\.title) == ["Standard", "Glass", "Tinted", "Graphite", "Paper"])
}

@Test func aeroReadsAsTinted() throws {
    struct Box: Codable, Equatable { var theme: Theme }
    let box = try JSONDecoder().decode(Box.self, from: Data(#"{"theme":"aero"}"#.utf8))
    #expect(box.theme == .tinted)
    // Saved back under the new name.
    #expect(String(decoding: try JSONEncoder().encode(box), as: UTF8.self) == #"{"theme":"tinted"}"#)
    #expect(throws: DecodingError.self) { try JSONDecoder().decode(Box.self, from: Data(#"{"theme":"vista"}"#.utf8)) }
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
            for theme in [Theme.glass, .tinted, .graphite, .paper, .standard] {
                ThemeCenter.shared.select(theme)
                ThemeCenter.shared.select(theme)
                #expect(background.effect === effect)
                #expect(effect.subviews.count == 2)
                #expect(effect.subviews.first === glaze)
                #expect(content.superview === effect)
                #expect(effect.material == ThemeStyle(theme: theme).material ?? (theme == .standard ? .popover : .windowBackground))
                #expect(glaze.isHidden == (theme == .standard))
            }
        }
        #expect(changes == 50)
    }

    @Test func accessibilityChangesUpdateOpenViewsWithoutChangingTheSelection() throws {
        defer { restoreTheme() }
        let background = ThemedBackgroundView(material: .popover)
        let plain = ThemedBackgroundView(material: nil)
        let glaze = try #require(background.effect.subviews.first)
        ThemeCenter.shared.select(.tinted)
        #expect(!plain.effect.isHidden)
        ThemeCenter.shared.updateAccessibility(reduceTransparency: true, increaseContrast: true)
        #expect(ThemeCenter.shared.selected == .tinted)
        #expect(ThemeCenter.shared.style == .standard)
        #expect(background.effect.material == .popover)
        #expect(glaze.isHidden)
        #expect(plain.effect.isHidden)
        ThemeCenter.shared.updateAccessibility(reduceTransparency: false, increaseContrast: true)
        #expect(ThemeCenter.shared.style == ThemeStyle(theme: .tinted, increaseContrast: true))
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
        ThemeCenter.shared.select(.tinted)
    }

    @Test func pinnedAppearanceIsSetOnTheWindowAndRestored() {
        defer { restoreTheme() }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 200, height: 100), styleMask: [.titled], backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false
        window.contentView = ThemedBackgroundView(material: .popover)
        #expect(window.appearance == nil)
        ThemeCenter.shared.select(.graphite)
        #expect(window.appearance?.name == .darkAqua)
        ThemeCenter.shared.select(.paper)
        #expect(window.appearance?.name == .aqua)
        #expect(window.titlebarAppearsTransparent)
        ThemeCenter.shared.select(.glass)
        #expect(window.appearance == nil)
        #expect(window.titlebarAppearsTransparent)
        ThemeCenter.shared.select(.standard)
        #expect(!window.titlebarAppearsTransparent)

        // A window with its own appearance gets it back.
        let own = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 200, height: 100), styleMask: [.titled], backing: .buffered, defer: true)
        own.isReleasedWhenClosed = false
        own.appearance = NSAppearance(named: .aqua)
        ThemeCenter.shared.select(.graphite)
        own.contentView = ThemedBackgroundView(material: nil)
        #expect(own.appearance?.name == .darkAqua)
        ThemeCenter.shared.select(.standard)
        #expect(own.appearance?.name == .aqua)
    }
}
