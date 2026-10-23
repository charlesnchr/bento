import AppKit
import BentoCore

/// Bento's own status items that make the sections, right to left:
///
///     … visible items  [chevron] [hidden separator] hidden items  [always-hidden separator] always hidden items
///
/// A separator hides everything to its left by growing wider than the screen: macOS
/// lays status items out right to left and pushes the ones that don't fit
/// off-screen, keeping their order. Collapsed, it is a thin divider.
///
/// The items keep fixed autosave names, so macOS remembers where the user put
/// them. Created after Bento's own icon (the shell makes it during launch), so
/// on the very first run they appear left of every existing item: nothing is
/// hidden until items are arranged.
final class ControlItems: NSObject {
    enum Kind: String { case toggle, hidden, alwaysHidden }

    /// Width a separator grows to: wider than the widest display (set by the controller).
    var expandedLength: CGFloat = 5000

    /// Dev instances use their own names: on macOS 26 the window list only
    /// tells the items apart by name, and the installed app may run too.
    static let autosaveNames: [Kind: String] = {
        let prefix = ProcessInfo.processInfo.environment["BENTO_DEV"] != nil ? "BentoDevMenuBar" : "BentoMenuBar"
        return [.toggle: prefix + "Toggle", .hidden: prefix + "Hidden", .alwaysHidden: prefix + "AlwaysHidden"]
    }()

    private(set) var toggle: NSStatusItem?
    private(set) var hidden: NSStatusItem?
    private(set) var alwaysHidden: NSStatusItem?
    /// Called on clicks: which item, and whether it was a right / ⌥ click.
    var onClick: ((Kind, _ right: Bool, _ option: Bool) -> Void)?

    private(set) var hiddenExpanded = false
    private(set) var alwaysHiddenExpanded = false

    func create(showToggle: Bool, alwaysHiddenSection: Bool) {
        // Creation order matters on first run (newer items go further left):
        // chevron, then the hidden separator, then the always-hidden one.
        if showToggle, toggle == nil { toggle = make(.toggle) }
        if hidden == nil { hidden = make(.hidden) }
        if alwaysHiddenSection, alwaysHidden == nil { alwaysHidden = make(.alwaysHidden) }
        if !showToggle, let t = toggle { remove(t); toggle = nil }
        if !alwaysHiddenSection, let a = alwaysHidden { remove(a); alwaysHidden = nil }
    }

    func removeAll() {
        for item in [toggle, hidden, alwaysHidden].compactMap({ $0 }) { remove(item) }
        toggle = nil
        hidden = nil
        alwaysHidden = nil
        hiddenExpanded = false
        alwaysHiddenExpanded = false
    }

    private func remove(_ item: NSStatusItem) {
        // removeStatusItem also deletes the item's remembered position, so a
        // separator would come back at the far left (nothing hidden, the
        // arrangement gone) after quitting or switching the module off. Keep it.
        let key = "NSStatusItem Preferred Position \(item.autosaveName ?? "")"
        let saved = item.autosaveName == nil ? nil : UserDefaults.standard.object(forKey: key)
        NSStatusBar.system.removeStatusItem(item)
        if let saved { UserDefaults.standard.set(saved, forKey: key) }
    }

    private func make(_ kind: Kind) -> NSStatusItem {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.autosaveName = ControlItems.autosaveNames[kind]
        item.behavior = [] // never removable by ⌘-dragging it out of the bar
        if let button = item.button {
            button.target = self
            button.action = #selector(clicked(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
            button.identifier = NSUserInterfaceItemIdentifier(kind.rawValue)
            button.setAccessibilityLabel(kind == .toggle ? "Show Hidden Menu Bar Items" : "Menu Bar Separator")
        }
        style(item, kind: kind, expanded: false, revealed: true)
        return item
    }

    @objc private func clicked(_ sender: NSStatusBarButton) {
        guard let raw = sender.identifier?.rawValue, let kind = Kind(rawValue: raw) else { return }
        let event = NSApp.currentEvent
        let right = event?.type == .rightMouseUp || event?.modifierFlags.contains(.control) == true
        onClick?(kind, right, event?.modifierFlags.contains(.option) == true)
    }

    /// Lays the items out for a state: `showHidden` collapses the hidden
    /// separator, `showAlwaysHidden` the always-hidden one too.
    func apply(showHidden: Bool, showAlwaysHidden: Bool) {
        let expandHidden = !showHidden
        let expandAlways = !(showHidden && showAlwaysHidden)
        if let t = toggle { style(t, kind: .toggle, expanded: false, revealed: showHidden) }
        if let h = hidden { style(h, kind: .hidden, expanded: expandHidden, revealed: showHidden) }
        if let a = alwaysHidden { style(a, kind: .alwaysHidden, expanded: expandAlways, revealed: showHidden) }
        hiddenExpanded = hidden != nil && expandHidden
        alwaysHiddenExpanded = alwaysHidden != nil && expandAlways
    }

    private func style(_ item: NSStatusItem, kind: Kind, expanded: Bool, revealed: Bool) {
        guard let button = item.button else { return }
        switch kind {
        case .toggle:
            item.length = NSStatusItem.variableLength
            button.image = ControlItems.chevron(pointingLeft: !revealed)
            button.setAccessibilityLabel(revealed ? "Hide Menu Bar Items" : "Show Hidden Menu Bar Items")
        case .hidden, .alwaysHidden:
            if expanded {
                button.image = nil
                item.length = expandedLength
            } else {
                button.image = ControlItems.divider(dashed: kind == .alwaysHidden)
                item.length = NSStatusItem.variableLength
            }
        }
    }

    // MARK: Images

    static func chevron(pointingLeft: Bool) -> NSImage? {
        let cfg = NSImage.SymbolConfiguration(pointSize: 13, weight: .semibold)
        let image = NSImage(systemSymbolName: pointingLeft ? "chevron.compact.left" : "chevron.compact.right",
                            accessibilityDescription: nil)?.withSymbolConfiguration(cfg)
        image?.isTemplate = true
        return image
    }

    /// A thin vertical line (dashed for the always-hidden separator).
    static func divider(dashed: Bool) -> NSImage {
        let image = NSImage(size: NSSize(width: 9, height: 18), flipped: false) { rect in
            let path = NSBezierPath()
            path.move(to: NSPoint(x: rect.midX, y: 2))
            path.line(to: NSPoint(x: rect.midX, y: rect.maxY - 2))
            path.lineWidth = 1.5
            if dashed { path.setLineDash([2, 2.5], count: 2, phase: 0) }
            path.lineCapStyle = .round
            NSColor.black.withAlphaComponent(dashed ? 0.45 : 0.6).setStroke()
            path.stroke()
            return true
        }
        image.isTemplate = true
        return image
    }
}
