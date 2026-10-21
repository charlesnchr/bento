import Foundation

/// Every window action Bento offers, modelled on Rectangle's action list.
/// Raw values are camelCase; action ids are `windows.<kebab-case>`.
enum WindowCommand: String, CaseIterable, Codable {
    // Halves
    case leftHalf, rightHalf, centerHalf, topHalf, bottomHalf
    // Corners
    case topLeft, topRight, bottomLeft, bottomRight
    // Thirds
    case firstThird, centerThird, lastThird, firstTwoThirds, centerTwoThirds, lastTwoThirds
    // Fourths
    case firstFourth, secondFourth, thirdFourth, lastFourth, firstThreeFourths, centerThreeFourths, lastThreeFourths
    // Sixths
    case topLeftSixth, topCenterSixth, topRightSixth, bottomLeftSixth, bottomCenterSixth, bottomRightSixth
    // Size
    case maximize, almostMaximize, maximizeHeight, larger, smaller, center, restore
    // Move to edges (no resize)
    case moveLeft, moveRight, moveUp, moveDown
    // Displays
    case nextDisplay, previousDisplay, displayLeft, displayRight
    // More sizes
    case topLeftNinth, topCenterNinth, topRightNinth, middleLeftNinth, middleCenterNinth, middleRightNinth,
         bottomLeftNinth, bottomCenterNinth, bottomRightNinth
    case topLeftEighth, topCenterLeftEighth, topCenterRightEighth, topRightEighth,
         bottomLeftEighth, bottomCenterLeftEighth, bottomCenterRightEighth, bottomRightEighth
    case topLeftThird, topRightThird, bottomLeftThird, bottomRightThird
    case topVerticalThird, middleVerticalThird, bottomVerticalThird, topVerticalTwoThirds, bottomVerticalTwoThirds
    case largerWidth, smallerWidth, largerHeight, smallerHeight
    case halveWidthLeft, halveWidthRight, halveHeightUp, halveHeightDown,
         doubleWidthLeft, doubleWidthRight, doubleHeightUp, doubleHeightDown
    // Several windows
    case tileAll, cascadeAll, tileActiveApp, cascadeActiveApp

    // MARK: Identity

    var actionID: String { "windows." + WindowCommand.kebab(rawValue) }

    static func from(actionID: String) -> WindowCommand? {
        allCases.first { $0.actionID == actionID }
    }

    static func kebab(_ s: String) -> String {
        var out = ""
        for ch in s {
            if ch.isUppercase {
                out += "-" + ch.lowercased()
            } else {
                out.append(ch)
            }
        }
        return out
    }

    var title: String {
        switch self {
        case .leftHalf: return "Left Half"
        case .rightHalf: return "Right Half"
        case .centerHalf: return "Center Half"
        case .topHalf: return "Top Half"
        case .bottomHalf: return "Bottom Half"
        case .topLeft: return "Top Left"
        case .topRight: return "Top Right"
        case .bottomLeft: return "Bottom Left"
        case .bottomRight: return "Bottom Right"
        case .firstThird: return "First Third"
        case .centerThird: return "Center Third"
        case .lastThird: return "Last Third"
        case .firstTwoThirds: return "First Two Thirds"
        case .centerTwoThirds: return "Center Two Thirds"
        case .lastTwoThirds: return "Last Two Thirds"
        case .firstFourth: return "First Fourth"
        case .secondFourth: return "Second Fourth"
        case .thirdFourth: return "Third Fourth"
        case .lastFourth: return "Last Fourth"
        case .firstThreeFourths: return "First Three Fourths"
        case .centerThreeFourths: return "Center Three Fourths"
        case .lastThreeFourths: return "Last Three Fourths"
        case .topLeftSixth: return "Top Left Sixth"
        case .topCenterSixth: return "Top Center Sixth"
        case .topRightSixth: return "Top Right Sixth"
        case .bottomLeftSixth: return "Bottom Left Sixth"
        case .bottomCenterSixth: return "Bottom Center Sixth"
        case .bottomRightSixth: return "Bottom Right Sixth"
        case .maximize: return "Maximize"
        case .almostMaximize: return "Almost Maximize"
        case .maximizeHeight: return "Maximize Height"
        case .larger: return "Make Larger"
        case .smaller: return "Make Smaller"
        case .center: return "Center"
        case .restore: return "Restore"
        case .moveLeft: return "Move Left"
        case .moveRight: return "Move Right"
        case .moveUp: return "Move Up"
        case .moveDown: return "Move Down"
        case .nextDisplay: return "Next Display"
        case .previousDisplay: return "Previous Display"
        case .displayLeft: return "Display on Left"
        case .displayRight: return "Display on Right"
        case .topLeftNinth: return "Top Left Ninth"
        case .topCenterNinth: return "Top Center Ninth"
        case .topRightNinth: return "Top Right Ninth"
        case .middleLeftNinth: return "Middle Left Ninth"
        case .middleCenterNinth: return "Middle Center Ninth"
        case .middleRightNinth: return "Middle Right Ninth"
        case .bottomLeftNinth: return "Bottom Left Ninth"
        case .bottomCenterNinth: return "Bottom Center Ninth"
        case .bottomRightNinth: return "Bottom Right Ninth"
        case .topLeftEighth: return "Top Left Eighth"
        case .topCenterLeftEighth: return "Top Center Left Eighth"
        case .topCenterRightEighth: return "Top Center Right Eighth"
        case .topRightEighth: return "Top Right Eighth"
        case .bottomLeftEighth: return "Bottom Left Eighth"
        case .bottomCenterLeftEighth: return "Bottom Center Left Eighth"
        case .bottomCenterRightEighth: return "Bottom Center Right Eighth"
        case .bottomRightEighth: return "Bottom Right Eighth"
        case .topLeftThird: return "Top Left Two Thirds"
        case .topRightThird: return "Top Right Two Thirds"
        case .bottomLeftThird: return "Bottom Left Two Thirds"
        case .bottomRightThird: return "Bottom Right Two Thirds"
        case .topVerticalThird: return "Top Third"
        case .middleVerticalThird: return "Middle Third"
        case .bottomVerticalThird: return "Bottom Third"
        case .topVerticalTwoThirds: return "Top Two Thirds"
        case .bottomVerticalTwoThirds: return "Bottom Two Thirds"
        case .largerWidth: return "Larger Width"
        case .smallerWidth: return "Smaller Width"
        case .largerHeight: return "Larger Height"
        case .smallerHeight: return "Smaller Height"
        case .halveWidthLeft: return "Halve Width (Left)"
        case .halveWidthRight: return "Halve Width (Right)"
        case .halveHeightUp: return "Halve Height (Up)"
        case .halveHeightDown: return "Halve Height (Down)"
        case .doubleWidthLeft: return "Double Width (Left)"
        case .doubleWidthRight: return "Double Width (Right)"
        case .doubleHeightUp: return "Double Height (Up)"
        case .doubleHeightDown: return "Double Height (Down)"
        case .tileAll: return "Tile All Windows"
        case .cascadeAll: return "Cascade All Windows"
        case .tileActiveApp: return "Tile App Windows"
        case .cascadeActiveApp: return "Cascade App Windows"
        }
    }

    enum Group: String, CaseIterable {
        case halves = "Halves", corners = "Corners", thirds = "Thirds", fourths = "Fourths", sixths = "Sixths"
        case size = "Size", move = "Move", display = "Display", more = "More Sizes", multi = "Multiple Windows"
    }

    var group: Group {
        switch self {
        case .leftHalf, .rightHalf, .centerHalf, .topHalf, .bottomHalf: return .halves
        case .topLeft, .topRight, .bottomLeft, .bottomRight: return .corners
        case .firstThird, .centerThird, .lastThird, .firstTwoThirds, .centerTwoThirds, .lastTwoThirds: return .thirds
        case .firstFourth, .secondFourth, .thirdFourth, .lastFourth,
             .firstThreeFourths, .centerThreeFourths, .lastThreeFourths: return .fourths
        case .topLeftSixth, .topCenterSixth, .topRightSixth, .bottomLeftSixth, .bottomCenterSixth, .bottomRightSixth: return .sixths
        case .maximize, .almostMaximize, .maximizeHeight, .larger, .smaller, .center, .restore: return .size
        case .moveLeft, .moveRight, .moveUp, .moveDown: return .move
        case .nextDisplay, .previousDisplay, .displayLeft, .displayRight: return .display
        case .tileAll, .cascadeAll, .tileActiveApp, .cascadeActiveApp: return .multi
        default: return .more
        }
    }

    /// Rectangle's default shortcuts (its "Rectangle" set, not the Spectacle
    /// set). Next/previous display follow the user's Rectangle Pro setup.
    var defaultShortcut: String? {
        switch self {
        case .leftHalf: return "ctrl+opt+left"
        case .rightHalf: return "ctrl+opt+right"
        case .topHalf: return "ctrl+opt+up"
        case .bottomHalf: return "ctrl+opt+down"
        case .topLeft: return "ctrl+opt+u"
        case .topRight: return "ctrl+opt+i"
        case .bottomLeft: return "ctrl+opt+j"
        case .bottomRight: return "ctrl+opt+k"
        case .firstThird: return "ctrl+opt+d"
        case .centerThird: return "ctrl+opt+f"
        case .lastThird: return "ctrl+opt+g"
        case .firstTwoThirds: return "ctrl+opt+e"
        case .centerTwoThirds: return "ctrl+opt+r"
        case .lastTwoThirds: return "ctrl+opt+t"
        case .maximize: return "ctrl+opt+return"
        case .maximizeHeight: return "ctrl+opt+shift+up"
        case .larger: return "ctrl+opt+equal"
        case .smaller: return "ctrl+opt+minus"
        case .center: return "ctrl+opt+c"
        case .restore: return "ctrl+opt+delete"
        case .nextDisplay: return "ctrl+opt+rightbracket"
        case .previousDisplay: return "ctrl+opt+leftbracket"
        case .displayLeft: return "ctrl+opt+cmd+left"
        case .displayRight: return "ctrl+opt+cmd+right"
        default: return nil
        }
    }

    /// Shown directly in the menu bar menu (the rest live in submenus).
    var inMainMenu: Bool {
        switch group {
        case .halves, .corners, .thirds, .size, .display: return true
        default: return false
        }
    }

    var symbol: String {
        switch self {
        case .leftHalf: return "rectangle.lefthalf.filled"
        case .rightHalf: return "rectangle.righthalf.filled"
        case .topHalf: return "rectangle.tophalf.filled"
        case .bottomHalf: return "rectangle.bottomhalf.filled"
        case .centerHalf: return "rectangle.center.inset.filled"
        case .topLeft: return "rectangle.inset.topleft.filled"
        case .topRight: return "rectangle.inset.topright.filled"
        case .bottomLeft: return "rectangle.inset.bottomleft.filled"
        case .bottomRight: return "rectangle.inset.bottomright.filled"
        case .maximize, .almostMaximize: return "rectangle.inset.filled"
        case .maximizeHeight: return "arrow.up.and.down"
        case .larger, .largerWidth, .largerHeight, .doubleWidthLeft, .doubleWidthRight, .doubleHeightUp, .doubleHeightDown:
            return "arrow.up.left.and.arrow.down.right"
        case .smaller, .smallerWidth, .smallerHeight, .halveWidthLeft, .halveWidthRight, .halveHeightUp, .halveHeightDown:
            return "arrow.down.right.and.arrow.up.left"
        case .center: return "rectangle.center.inset.filled"
        case .restore: return "arrow.uturn.backward"
        case .moveLeft: return "arrow.left.to.line"
        case .moveRight: return "arrow.right.to.line"
        case .moveUp: return "arrow.up.to.line"
        case .moveDown: return "arrow.down.to.line"
        case .nextDisplay, .displayRight: return "rectangle.portrait.and.arrow.right"
        case .previousDisplay, .displayLeft: return "rectangle.portrait.and.arrow.forward"
        case .tileAll, .tileActiveApp: return "square.grid.2x2"
        case .cascadeAll, .cascadeActiveApp: return "square.stack"
        default: return "rectangle.split.3x1"
        }
    }

    // MARK: Behaviour

    /// Commands handled by the engine without a single-window calculation.
    var isMultiWindow: Bool {
        switch self {
        case .tileAll, .cascadeAll, .tileActiveApp, .cascadeActiveApp: return true
        default: return false
        }
    }

    var isDisplayMove: Bool { group == .display }

    /// Commands that place a window at a fixed spot of the screen. They can be
    /// replayed on another display and are offered as snap / launch targets.
    var isPositional: Bool {
        switch group {
        case .halves, .corners, .thirds, .fourths, .sixths: return true
        case .more:
            switch self {
            case .largerWidth, .smallerWidth, .largerHeight, .smallerHeight,
                 .halveWidthLeft, .halveWidthRight, .halveHeightUp, .halveHeightDown,
                 .doubleWidthLeft, .doubleWidthRight, .doubleHeightUp, .doubleHeightDown: return false
            default: return true
            }
        default: return self == .maximize || self == .almostMaximize
        }
    }
}
