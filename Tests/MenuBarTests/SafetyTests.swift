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

// MARK: - Putting back an item moved into view for a click

@Test func returnNeighboursStayInTheItemsSection() {
    // Left to right: always hidden a1, A, hidden h1 X h2, H, chevron, visible v1.
    let order = ["a1", "A", "h1", "X", "h2", "H", "T", "v1"]
    let bounds: Set<String> = ["A", "H", "T"]
    let n = MenuBarLayout.returnNeighbours(of: "X", in: order, bounds: bounds)
    #expect(n.right == ["h2", "H"])
    #expect(n.left == ["h1", "A"])
    // At the left end of the always hidden section: nothing on its left.
    let far = MenuBarLayout.returnNeighbours(of: "a1", in: order, bounds: bounds)
    #expect(far.right == ["A"])
    #expect(far.left.isEmpty)
    #expect(MenuBarLayout.returnNeighbours(of: "gone", in: order, bounds: bounds) == ([], []))
}

@Test func returnFallsBackToTheNextNeighbour() {
    let right = ["h2", "H"], left = ["h1", "A"]
    #expect(MenuBarLayout.returnDestination(right: right, left: left, present: ["h2", "H", "h1", "A"]) == .leftOf("h2"))
    // Its right neighbour's app quit: left of the next one (the separator).
    #expect(MenuBarLayout.returnDestination(right: right, left: left, present: ["H", "h1", "A"]) == .leftOf("H"))
    // Nothing on the right (module stopping): right of its left neighbour.
    #expect(MenuBarLayout.returnDestination(right: right, left: left, present: ["h1"]) == .rightOf("h1"))
    #expect(MenuBarLayout.returnDestination(right: right, left: left, present: []) == nil)
}

@Test func failedReturnsAreRetriedNotDropped() {
    typealias R = MenuBarLayout.ReturnRetry
    // A held key or button: wait for the user however long it takes.
    for attempt in [1, 2, 10, 100] {
        #expect(MenuBarLayout.retry(afterFailedReturn: .userBusy, attempt: attempt) == R.after(0.5))
    }
    // Its neighbour went away: the next one, a few times; then the next chance.
    #expect(MenuBarLayout.retry(afterFailedReturn: .targetGone, attempt: 1) == R.after(0.1))
    #expect(MenuBarLayout.retry(afterFailedReturn: .targetGone, attempt: 8) == R.later)
    // macOS didn't take the move: backing off, then the next chance (the record stays).
    #expect(MenuBarLayout.retry(afterFailedReturn: .notPlaced, attempt: 1) == R.after(0.5))
    #expect(MenuBarLayout.retry(afterFailedReturn: .notPlaced, attempt: 3) == R.after(1.5))
    #expect(MenuBarLayout.retry(afterFailedReturn: .notPlaced, attempt: 4) == R.later)
    #expect(MenuBarLayout.retry(afterFailedReturn: .noAccessibility, attempt: 1) == R.later)
    #expect(MenuBarLayout.retry(afterFailedReturn: .cancelled, attempt: 1) == R.later)
    // Only an item that's gone (its app quit) has nothing to go back to.
    #expect(MenuBarLayout.retry(afterFailedReturn: .itemGone, attempt: 1) == R.drop)
}

@Test func pendingReturnRecordsNeighboursAndFallsBack() {
    func control(_ id: CGWindowID, _ kind: ControlItems.Kind, x: CGFloat) -> MenuBarItem {
        var i = barItem(id, kind.rawValue, x: x)
        i.role = .control(kind)
        return i
    }
    // a1 A | h1 X h2 H | T v1
    let order = [barItem(1, "a1", x: -900), control(2, .alwaysHidden, x: -800), barItem(3, "h1", x: -500),
                 barItem(4, "X", x: -470), barItem(5, "h2", x: -440), control(6, .hidden, x: -410),
                 control(7, .toggle, x: 600), barItem(8, "v1", x: 640)]
    let trip = MenuBarController.PendingReturn(item: 4, order: order)
    #expect(trip.right == [5, 6])
    #expect(trip.left == [3, 2])
    let first = trip.request(in: order, excluding: [4])
    #expect(first?.target == 5 && first?.side == .left)
    // h2 quit while X was in view: X goes left of the hidden separator instead.
    let fallback = trip.request(in: order.filter { $0.windowID != 5 }, excluding: [4])
    #expect(fallback?.target == 6 && fallback?.side == .left)
    // Without a section boundary a surviving neighbour cannot prove that X
    // will return to Hidden; keep the record rather than accepting Visible.
    #expect(trip.request(in: order.filter { [3, 4].contains($0.windowID) }, excluding: [4]) == nil)
    #expect(trip.request(in: order.filter { [1, 4, 8].contains($0.windowID) }, excluding: [4]) == nil)
}
