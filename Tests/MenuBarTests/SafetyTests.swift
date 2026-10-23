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

// MARK: - Show when the icon changes

private func barItem(_ id: CGWindowID, _ name: String, x: CGFloat, owner: pid_t? = 42) -> MenuBarItem {
    MenuBarItem(windowID: id, frame: CGRect(x: x, y: 0, width: 30, height: 24), windowName: name,
                ownerPID: owner, bundleID: owner == nil ? nil : "app.\(name.lowercased())", appName: name, detail: nil)
}

@Test func watcherLooksOnlyAtPickedHiddenItems() {
    let x = barItem(1, "X", x: -400), z = barItem(2, "Z", x: -900), v = barItem(3, "V", x: 700)
    let sections: [CGWindowID: MenuBarSection] = [1: .hidden, 2: .alwaysHidden, 3: .visible]
    let all = [x, z, v]
    #expect(ChangeWatcher.watched(all, sections: sections, keys: [x.key, z.key, v.key]).map(\.windowID) == [1, 2])
    // Only a visible item picked, or a picked app that isn't running: nothing to poll.
    #expect(ChangeWatcher.watched(all, sections: sections, keys: [v.key]).isEmpty)
    #expect(ChangeWatcher.watched(all, sections: sections, keys: ["app.gone/Gone"]).isEmpty)
    #expect(ChangeWatcher.watched(all, sections: sections, keys: []).isEmpty)
    // The picked item's app quit: its window is gone from the list.
    #expect(ChangeWatcher.watched([z, v], sections: sections, keys: [x.key]).isEmpty)
}

@Test func watcherIgnoresItemsWithoutAnOwnerOrSection() {
    // No owner yet: no stable key, so it can't be a picked item.
    let unresolved = barItem(1, "X", x: -400, owner: nil)
    #expect(ChangeWatcher.watched([unresolved], sections: [1: .hidden], keys: ["app.x/X"]).isEmpty)
    // No section known counts as visible (in view).
    let x = barItem(2, "X", x: 400)
    #expect(ChangeWatcher.watched([x], sections: [:], keys: [x.key]).isEmpty)
}

// MARK: - Owners from Accessibility

private func frame(_ x: CGFloat, _ w: CGFloat = 30) -> CGRect { CGRect(x: x, y: 0, width: w, height: 24) }

@Test func ownersMatchWindowsThatStayedPut() {
    let before: [UInt32: CGRect] = [1: frame(100), 2: frame(130)]
    let r = MenuBarLayout.matchOwners(before: before, after: before, elements: [frame(130.5), frame(100)])
    #expect(r.matched == [1: 1, 2: 0])
    #expect(r.moved.isEmpty)
}

@Test func swappedItemsAreNotMatchedToEachOthersElements() {
    // X at 100 and Y at 130 swap while the elements are read: by their old
    // places, X would get Y's element (and pressing X would open Y's menu).
    let before: [UInt32: CGRect] = [1: frame(100), 2: frame(130)]
    let after: [UInt32: CGRect] = [1: frame(130), 2: frame(100)]
    let r = MenuBarLayout.matchOwners(before: before, after: after, elements: [frame(130), frame(100)])
    #expect(r.matched.isEmpty)
    #expect(r.moved == [1, 2])
}

@Test func onlyTheItemsThatMovedAreLeftOut() {
    // An item left of one that grew shifts; the others still match.
    let before: [UInt32: CGRect] = [1: frame(100), 2: frame(130), 3: frame(200)]
    let after: [UInt32: CGRect] = [1: frame(92), 2: frame(130), 3: frame(200)]
    let r = MenuBarLayout.matchOwners(before: before, after: after, elements: [frame(92), frame(130), frame(200)])
    #expect(r.matched == [2: 1, 3: 2])
    #expect(r.moved == [1])
    // A window that's gone counts as moved; an element nowhere near matches nothing.
    let gone = MenuBarLayout.matchOwners(before: [1: frame(100), 2: frame(300)], after: [2: frame(300)], elements: [frame(100), frame(250)])
    #expect(gone.matched.isEmpty)
    #expect(gone.moved == [1])
}

@Test func sameItemTolerance() {
    #expect(MenuBarLayout.sameItem(frame(100), frame(101.5)))
    #expect(!MenuBarLayout.sameItem(frame(100), frame(103)))
    #expect(!MenuBarLayout.sameItem(frame(100), frame(100).offsetBy(dx: 0, dy: 4)))
}
