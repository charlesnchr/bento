import CoreGraphics
import Foundation
import Testing
@testable import MenuBar

private func item(_ key: String, _ minX: CGFloat, _ width: CGFloat = 30) -> LayoutItem {
    LayoutItem(key: key, minX: minX, width: width)
}

// MARK: - Sections

@Test func sectionsFromCollapsedSeparators() {
    let hiddenSep = item("H", 500, 12)
    let alwaysSep = item("A", 400, 12)
    let items = [item("clock", 900), item("wifi", 700), item("x", 450), item("y", 300), item("z", 520)]
    let s = MenuBarLayout.sections(of: items, hiddenSeparator: hiddenSep, alwaysHiddenSeparator: alwaysSep)
    #expect(s["clock"] == .visible)
    #expect(s["wifi"] == .visible)
    #expect(s["z"] == .visible)
    #expect(s["x"] == .hidden)
    #expect(s["y"] == .alwaysHidden)
}

@Test func sectionsWithExpandedSeparators() {
    // Hidden: the separator spans 10 000 pt to the left of its right edge and
    // everything left of it is pushed off-screen, in order.
    let hiddenSep = item("H", 600 - 10_000, 10_000)
    let alwaysSep = item("A", 600 - 10_000 - 60 - 10_000, 10_000)
    let items = [item("v", 620), item("h1", 600 - 10_000 - 30), item("h2", 600 - 10_000 - 60),
                 item("a1", 600 - 20_000 - 90)]
    let s = MenuBarLayout.sections(of: items, hiddenSeparator: hiddenSep, alwaysHiddenSeparator: alwaysSep)
    #expect(s["v"] == .visible)
    #expect(s["h1"] == .hidden)
    #expect(s["h2"] == .hidden)
    #expect(s["a1"] == .alwaysHidden)
}

@Test func noAlwaysHiddenSeparatorMeansHidden() {
    let s = MenuBarLayout.sections(of: [item("x", 10)], hiddenSeparator: item("H", 500), alwaysHiddenSeparator: nil)
    #expect(s["x"] == .hidden)
    // No separator at all (module just started): everything is visible.
    #expect(MenuBarLayout.sections(of: [item("x", 10)], hiddenSeparator: nil, alwaysHiddenSeparator: nil)["x"] == .visible)
}

@Test func misplacedAlwaysHiddenSeparatorIsIgnored() {
    // The always-hidden separator right of the hidden one (dragged there by
    // hand) can't define a section.
    let s = MenuBarLayout.sections(of: [item("x", 100)], hiddenSeparator: item("H", 300), alwaysHiddenSeparator: item("A", 500))
    #expect(s["x"] == .hidden)
}

@Test func arrangementKeepsOrderPerSection() {
    let order = ["a1", "A", "h1", "h2", "H", "v1", "v2"]
    let sections: [String: MenuBarSection] = ["a1": .alwaysHidden, "h1": .hidden, "h2": .hidden, "v1": .visible, "v2": .visible]
    let arr = MenuBarLayout.arrangement(order: order, sections: sections)
    #expect(arr[.alwaysHidden] == ["a1"])
    #expect(arr[.hidden] == ["h1", "h2"])
    #expect(arr[.visible] == ["v1", "v2"])
}

@Test func leftToRightUsesCentres() {
    let sorted = MenuBarLayout.leftToRight([item("v", 620), item("H", -9400, 10_000), item("h", -9430)])
    #expect(sorted.map(\.key) == ["h", "H", "v"])
}

// MARK: - Notch

@Test func statusAreaRespectsNotchAndMenus() {
    // 1512 pt wide MacBook display, notch from 663 to 848.
    let area = MenuBarLayout.statusArea(screenMinX: 0, screenMaxX: 1512, notch: 663...848, appMenuMaxX: 400)
    #expect(area == 848...1512)
    // Long app menus past the notch push the start further right.
    #expect(MenuBarLayout.statusArea(screenMinX: 0, screenMaxX: 1512, notch: 663...848, appMenuMaxX: 900) == 900...1512)
    // No notch: right of the app menus. Second display at x 1512.
    #expect(MenuBarLayout.statusArea(screenMinX: 1512, screenMaxX: 3432, notch: nil, appMenuMaxX: 1900) == 1900...3432)
    #expect(MenuBarLayout.statusArea(screenMinX: 1512, screenMaxX: 3432, notch: nil, appMenuMaxX: nil) == 1512...3432)
}

@Test func overflowFindsItemsBehindTheNotch() {
    let area: ClosedRange<CGFloat> = 848...1512
    let items = [item("clock", 1383, 131), item("fits", 860), item("notch", 830), item("off", -40), item("hidden", -9000)]
    let lost = MenuBarLayout.overflow(items, shown: ["clock", "fits", "notch", "off"], area: area)
    #expect(lost == ["notch", "off"])
    // Zero-width items (an app's empty item) never count.
    #expect(MenuBarLayout.overflow([item("empty", 10, 0)], shown: ["empty"], area: area).isEmpty)
}

@Test func shortfallSumsShownWidths() {
    let items = [item("a", 0, 300), item("b", 0, 300), item("c", 0, 200)]
    #expect(MenuBarLayout.shortfall(items, shown: ["a", "b"], available: 664) == 0)
    #expect(MenuBarLayout.shortfall(items, shown: ["a", "b", "c"], available: 664) == 136)
}

@Test func onDisplayToleratesTheClockPokingPastTheEdge() {
    let display = [CGRect(x: 0, y: 0, width: 1512, height: 982)]
    #expect(MenuBarLayout.isOnDisplay(CGRect(x: 1383, y: 0, width: 131, height: 33), displays: display))
    #expect(MenuBarLayout.isOnDisplay(CGRect(x: 900, y: 0, width: 30, height: 33), displays: display))
    // Parked off the left edge, or a zero-width item.
    #expect(!MenuBarLayout.isOnDisplay(CGRect(x: -900, y: 0, width: 30, height: 33), displays: display))
    #expect(!MenuBarLayout.isOnDisplay(CGRect(x: 900, y: 0, width: 0, height: 33), displays: display))
    // A second display to the right.
    #expect(MenuBarLayout.isOnDisplay(CGRect(x: 1600, y: 0, width: 30, height: 24),
                                      displays: display + [CGRect(x: 1512, y: 0, width: 1920, height: 1080)]))
}
