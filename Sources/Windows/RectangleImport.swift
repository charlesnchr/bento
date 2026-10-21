import AppKit
import BentoCore

/// Imports shortcuts and settings from Rectangle Pro (`com.knollsoft.Hookshot`)
/// or Rectangle (`com.knollsoft.Rectangle`), reading the preferences plist
/// directly. Shortcut entries are MASShortcut dictionaries:
/// `{keyCode, modifierFlags}` = bound, `{}` = explicitly unbound, missing =
/// Rectangle's default for that action.
enum RectangleImport {
    struct Source: Equatable {
        var name: String
        var isPro: Bool
        var url: URL
    }

    enum Origin: Equatable { case explicit, unbound, rectangleDefault }

    struct Assignment: Equatable {
        var shortcut: Shortcut?
        var origin: Origin
        var key: String
    }

    struct Plan: Equatable {
        var sourceName: String
        /// Bento action id → binding.
        var assignments: [String: Assignment] = [:]
        /// Other Bento actions whose shortcut an imported binding takes over.
        var unbind: [String] = []
        var settings: WindowsSettings
        var settingsChanges: [String] = []
        /// Bound Rectangle shortcuts with no Bento equivalent.
        var skipped: [String] = []
        var notes: [String] = []

        func count(_ o: Origin) -> Int { assignments.values.filter { $0.origin == o }.count }
    }

    static let nextSpaceID = "windows.next-space"
    static let prevSpaceID = "windows.prev-space"

    // MARK: Locating and reading

    static func locate(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> Source? {
        let prefs = home.appendingPathComponent("Library/Preferences", isDirectory: true)
        let pro = prefs.appendingPathComponent("com.knollsoft.Hookshot.plist")
        if FileManager.default.fileExists(atPath: pro.path) { return Source(name: "Rectangle Pro", isPro: true, url: pro) }
        let plain = prefs.appendingPathComponent("com.knollsoft.Rectangle.plist")
        if FileManager.default.fileExists(atPath: plain.path) { return Source(name: "Rectangle", isPro: false, url: plain) }
        return nil
    }

    static func read(_ url: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any]
    }

    // MARK: Key mapping

    /// Rectangle's own defaults ("Rectangle" set) and the Spectacle set.
    static let rectangleDefaults: [String: String] = [
        "leftHalf": "ctrl+opt+left", "rightHalf": "ctrl+opt+right", "bottomHalf": "ctrl+opt+down", "topHalf": "ctrl+opt+up",
        "bottomLeft": "ctrl+opt+j", "bottomRight": "ctrl+opt+k", "topLeft": "ctrl+opt+u", "topRight": "ctrl+opt+i",
        "maximize": "ctrl+opt+return", "maximizeHeight": "ctrl+opt+shift+up",
        "previousDisplay": "ctrl+opt+cmd+left", "nextDisplay": "ctrl+opt+cmd+right",
        "larger": "ctrl+opt+equal", "smaller": "ctrl+opt+minus", "center": "ctrl+opt+c", "restore": "ctrl+opt+delete",
        "firstThird": "ctrl+opt+d", "firstTwoThirds": "ctrl+opt+e", "centerThird": "ctrl+opt+f",
        "lastTwoThirds": "ctrl+opt+t", "lastThird": "ctrl+opt+g", "centerTwoThirds": "ctrl+opt+r",
    ]
    static let spectacleDefaults: [String: String] = [
        "leftHalf": "cmd+opt+left", "rightHalf": "cmd+opt+right", "maximize": "cmd+opt+f", "maximizeHeight": "ctrl+opt+shift+up",
        "previousDisplay": "ctrl+opt+cmd+left", "nextDisplay": "ctrl+opt+cmd+right",
        "larger": "ctrl+opt+shift+right", "smaller": "ctrl+opt+shift+left", "bottomHalf": "cmd+opt+down", "topHalf": "cmd+opt+up",
        "center": "cmd+opt+c", "bottomLeft": "cmd+ctrl+shift+left", "bottomRight": "cmd+ctrl+shift+right",
        "topLeft": "ctrl+cmd+left", "topRight": "ctrl+cmd+right", "restore": "ctrl+opt+delete",
    ]

    /// Rectangle action names Bento knows (missing ones fall back to Rectangle's default).
    static let rectangleKeys: [String] = WindowCommand.allCases
        .filter { $0 != .displayLeft && $0 != .displayRight }
        .map(\.rawValue)

    /// Rectangle Pro-only keys Bento maps (missing ones are left alone).
    static let proKeys = ["nextDisplayRatio", "prevDisplayRatio", "nextSpace", "prevSpace"]

    static func actionID(forKey key: String, isPro: Bool, spaces: Bool) -> String? {
        switch key {
        // Pro's "…DisplayRatio" keeps the relative frame, like Bento's Next/Previous Display.
        case "nextDisplayRatio": return WindowCommand.nextDisplay.actionID
        case "prevDisplayRatio": return WindowCommand.previousDisplay.actionID
        case "nextDisplay": return (isPro ? WindowCommand.displayRight : .nextDisplay).actionID
        case "previousDisplay", "prevDisplay": return (isPro ? WindowCommand.displayLeft : .previousDisplay).actionID
        case "nextSpace": return spaces ? nextSpaceID : nil
        case "prevSpace", "previousSpace": return spaces ? prevSpaceID : nil
        default:
            guard let cmd = WindowCommand(rawValue: key), cmd != .displayLeft, cmd != .displayRight else { return nil }
            return cmd.actionID
        }
    }

    /// MASShortcut dictionary → Shortcut. nil for `{}` / garbage.
    static func shortcut(_ value: Any?) -> Shortcut? {
        guard let d = value as? [String: Any], let code = (d["keyCode"] as? NSNumber)?.intValue, code >= 0 else { return nil }
        let raw = (d["modifierFlags"] as? NSNumber)?.uintValue ?? 0
        let mods = NSEvent.ModifierFlags(rawValue: raw).intersection([.command, .option, .control, .shift])
        return Shortcut(keyCode: UInt32(code), modifiers: mods)
    }

    static func modifierNames(_ raw: Int) -> [String] {
        let f = NSEvent.ModifierFlags(rawValue: UInt(max(0, raw)))
        var out: [String] = []
        if f.contains(.control) { out.append("ctrl") }
        if f.contains(.option) { out.append("opt") }
        if f.contains(.shift) { out.append("shift") }
        if f.contains(.command) { out.append("cmd") }
        return out
    }

    static func modifierSymbols(_ names: [String]) -> String {
        names.map { ["ctrl": "⌃", "opt": "⌥", "shift": "⇧", "cmd": "⌘"][$0] ?? $0 }.joined()
    }

    /// Rectangle stores optional booleans as 0 (unset) / 1 (on) / 2 (off); plain bools too.
    static func optionalBool(_ v: Any?) -> Bool? {
        guard let n = v as? NSNumber else { return nil }
        if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue }
        switch n.intValue {
        case 1: return true
        case 2: return false
        default: return nil
        }
    }

    // MARK: Planning (pure)

    /// - Parameters:
    ///   - current: the effective shortcut of every Bento action (for conflict resolution).
    static func plan(prefs: [String: Any], sourceName: String, isPro: Bool, settings: WindowsSettings,
                     current: [String: Shortcut], spaces: Bool) -> Plan {
        var plan = Plan(sourceName: sourceName, settings: settings)
        // Pro and recent Rectangle use the Rectangle set unless Spectacle was chosen.
        let alternate = optionalBool(prefs["alternateDefaultShortcuts"]) ?? isPro
        let defaults = alternate ? rectangleDefaults : spectacleDefaults

        for key in rectangleKeys + proKeys + ["prevDisplay", "previousSpace"] {
            guard let id = actionID(forKey: key, isPro: isPro, spaces: spaces) else { continue }
            let value = prefs[key]
            let assignment: Assignment
            if let dict = value as? [String: Any] {
                if let sc = shortcut(dict) {
                    assignment = Assignment(shortcut: sc, origin: .explicit, key: key)
                } else {
                    assignment = Assignment(shortcut: nil, origin: .unbound, key: key)
                }
            } else if value == nil, rectangleKeys.contains(key) {
                // An explicit entry under an alias (e.g. "prevDisplay") wins over a default.
                if plan.assignments[id] != nil { continue }
                assignment = Assignment(shortcut: defaults[key].flatMap(Shortcut.init), origin: .rectangleDefault, key: key)
            } else {
                continue
            }
            if let existing = plan.assignments[id], existing.origin != .rectangleDefault, assignment.origin == .rectangleDefault { continue }
            plan.assignments[id] = assignment
        }

        // Bound Pro shortcuts Bento has no counterpart for.
        for (key, value) in prefs.sorted(by: { $0.key < $1.key }) {
            guard let sc = shortcut(value), actionID(forKey: key, isPro: isPro, spaces: spaces) == nil else { continue }
            plan.skipped.append("\(key) \(sc.displayString)")
        }

        // Imported bindings win: free them from other Bento actions.
        let taken = Dictionary(plan.assignments.compactMap { id, a in a.shortcut.map { ($0, id) } }, uniquingKeysWith: { a, _ in a })
        plan.unbind = current.keys.sorted().filter { id in
            plan.assignments[id] == nil && current[id].map { taken[$0] != nil } == true
        }
        var seen: [Shortcut: String] = [:]
        for (id, a) in plan.assignments.sorted(by: { $0.key < $1.key }) {
            guard let sc = a.shortcut else { continue }
            if let other = seen[sc] {
                plan.notes.append("\(sc.displayString) is bound to both \(title(other)) and \(title(id)); only one will work.")
            } else {
                seen[sc] = id
            }
        }

        applySettings(prefs, to: &plan)
        return plan
    }

    static func title(_ actionID: String) -> String {
        if actionID == nextSpaceID { return "Next Space" }
        if actionID == prevSpaceID { return "Previous Space" }
        return WindowCommand.from(actionID: actionID)?.title ?? actionID
    }

    private static func applySettings(_ p: [String: Any], to plan: inout Plan) {
        var s = plan.settings
        func note(_ text: String) { plan.settingsChanges.append(text) }

        // Rectangle Pro modifier-drag gestures: [id, {flags, …}, …]; 32 = move, 33 = resize.
        if let json = p["gestures"] as? String, let data = json.data(using: .utf8),
           let list = try? JSONSerialization.jsonObject(with: data) as? [Any] {
            var flags: [Int: Int] = [:]
            var i = 0
            while i + 1 < list.count {
                if let id = (list[i] as? NSNumber)?.intValue, let cfg = list[i + 1] as? [String: Any],
                   let f = (cfg["flags"] as? NSNumber)?.intValue {
                    flags[id] = f
                }
                i += 2
            }
            if let f = flags[32], !modifierNames(f).isEmpty {
                s.dragMove = true
                s.dragMoveModifiers = modifierNames(f)
                note("Move by dragging with \(modifierSymbols(s.dragMoveModifiers))")
            } else {
                s.dragMove = false
                note("Modifier-drag move off")
            }
            if let f = flags[33], !modifierNames(f).isEmpty {
                s.dragResize = true
                s.dragResizeModifiers = modifierNames(f)
                note("Resize by dragging with \(modifierSymbols(s.dragResizeModifiers))")
            } else {
                s.dragResize = false
                note("Modifier-drag resize off")
            }
        }

        let gap = (p["gapSize"] as? NSNumber)?.doubleValue
        let edges = ["screenEdgeGapTop", "screenEdgeGapBottom", "screenEdgeGapLeft", "screenEdgeGapRight"]
            .compactMap { (p[$0] as? NSNumber)?.doubleValue }
        if gap != nil || !edges.isEmpty {
            let g = max(0, gap ?? 0)
            s.windowGap = g
            s.screenMargin = g + (edges.max() ?? 0)
            note("Gaps \(Int(s.windowGap)) pt between windows, \(Int(s.screenMargin)) pt at screen edges")
            if Set(edges).count > 1 { plan.notes.append("Rectangle's per-edge screen gaps differ; Bento uses the largest for all edges.") }
        }
        if let on = optionalBool(p["applyGapsToMaximize"]) { s.gapsOnMaximize = on }
        if let on = optionalBool(p["windowSnapping"]) {
            s.snapping = on
            note(on ? "Snapping on" : "Snapping off")
        }
        if let on = optionalBool(p["unsnapRestore"]) { s.restoreSizeOnUnsnap = on }
        if let on = optionalBool(p["sixthsSnapArea"]) { s.snapSixths = on }
        if let ignored = (p["ignoredSnapAreas"] as? NSNumber)?.intValue, ignored > 0 {
            if ignored & 1 != 0 { s.snapTopMaximizes = false }
            if ignored & 2 != 0 { s.snapBottomThirds = false }
            if ignored & 4 != 0 && ignored & 8 != 0 { s.snapSides = false }
            if ignored & (0xF << 4) == (0xF << 4) { s.snapCorners = false }
            if ignored & (0xF << 8) == (0xF << 8) { s.snapSideCornerHalves = false }
            note("Disabled snap areas carried over")
        }

        if let mode = (p["subsequentExecutionMode"] as? NSNumber)?.intValue {
            switch mode {
            case 0, 5: s.cycleOnRepeat = true; s.moveToAdjacentDisplayOnRepeat = false
            case 1: s.cycleOnRepeat = false; s.moveToAdjacentDisplayOnRepeat = true
            case 3: s.cycleOnRepeat = true; s.moveToAdjacentDisplayOnRepeat = true
            default:
                s.cycleOnRepeat = false; s.moveToAdjacentDisplayOnRepeat = false
                if mode != 2 { plan.notes.append("Rectangle's repeat mode \(mode == 4 ? "“cycle displays”" : "“switch sides”") has no Bento equivalent; repeating does nothing.") }
            }
            note("Repeat: \(s.cycleOnRepeat ? "cycle sizes" : "no cycling")\(s.moveToAdjacentDisplayOnRepeat ? ", move to adjacent display" : "")")
        }
        if optionalBool(p["cycleSizesIsChanged"]) == true, let bits = (p["selectedCycleSizes"] as? NSNumber)?.intValue {
            let names = [(0, "2/3"), (1, "1/2"), (2, "1/3"), (3, "1/4"), (4, "3/4")].filter { bits >> $0.0 & 1 == 1 }.map(\.1)
            if !names.isEmpty {
                s.cycleSizes = WindowsSettings.cycleChoices.map(\.0).filter(names.contains)
                note("Cycle sizes " + s.cycleSizes.joined(separator: ", "))
            }
        }
        if let h = (p["almostMaximizeHeight"] as? NSNumber)?.doubleValue, h > 0, h <= 1 { s.almostMaximizeHeight = h }
        if let w = (p["almostMaximizeWidth"] as? NSNumber)?.doubleValue, w > 0, w <= 1 { s.almostMaximizeWidth = w }
        if let step = (p["sizeOffset"] as? NSNumber)?.doubleValue, step > 0 {
            s.sizeStep = step
            note("Larger / Smaller step \(Int(step)) pt")
        }
        s.importedFromRectangle = true
        plan.settings = s
    }

    // MARK: Applying

    static func apply(_ plan: Plan) {
        let reg = ActionRegistry.shared
        for (id, a) in plan.assignments.sorted(by: { $0.key < $1.key }) where reg.shortcut(for: id) != a.shortcut {
            reg.setShortcut(a.shortcut, for: id)
        }
        for id in plan.unbind where reg.shortcut(for: id) != nil {
            reg.setShortcut(nil, for: id)
        }
        ConfigStore.shared.setSection("windows", plan.settings)
    }

    static func summary(_ plan: Plan) -> String {
        var lines = ["\(plan.count(.explicit)) shortcuts set, \(plan.count(.unbound)) unbound, \(plan.count(.rectangleDefault)) at Rectangle's defaults."]
        let bound = plan.assignments.filter { $0.value.origin == .explicit }.sorted { $0.key < $1.key }
        if !bound.isEmpty {
            lines.append(bound.map { "\(title($0.key)) \($0.value.shortcut?.displayString ?? "")" }.joined(separator: ", "))
        }
        lines += plan.settingsChanges
        if !plan.unbind.isEmpty {
            lines.append("Unbound to make room: " + plan.unbind.map(title).joined(separator: ", "))
        }
        if !plan.skipped.isEmpty {
            lines.append("No Bento equivalent: " + plan.skipped.joined(separator: ", "))
        }
        lines += plan.notes
        return lines.joined(separator: "\n")
    }
}
