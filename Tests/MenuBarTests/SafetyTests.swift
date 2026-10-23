import CoreGraphics
import Foundation
import Testing
@testable import MenuBar

// The rules that keep the user's items where they put them.

// MARK: - Separators

@Test func separatorsForEveryStateWhenInPlace() {
    typealias E = ControlItems.Expansion
    #expect(ControlItems.expansion(.hidden, alwaysHiddenMisplaced: false) == E(hidden: true, alwaysHidden: true))
    #expect(ControlItems.expansion(.shown, alwaysHiddenMisplaced: false) == E(hidden: false, alwaysHidden: true))
    #expect(ControlItems.expansion(.shownAll, alwaysHiddenMisplaced: false) == E(hidden: false, alwaysHidden: false))
}

@Test func misplacedAlwaysHiddenSeparatorNeverExpands() {
    // Right of the hidden separator, between visible items: expanded, it
    // would hide them (and the chevron or Bento's icon left of it).
    typealias E = ControlItems.Expansion
    #expect(ControlItems.expansion(.hidden, alwaysHiddenMisplaced: true) == E(hidden: true, alwaysHidden: false))
    #expect(ControlItems.expansion(.shown, alwaysHiddenMisplaced: true) == E(hidden: false, alwaysHidden: false))
    #expect(ControlItems.expansion(.shownAll, alwaysHiddenMisplaced: true) == E(hidden: false, alwaysHidden: false))
}
