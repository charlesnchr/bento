import AppKit
import SwiftUI

/// Todoist's colours: priorities, due-date states, the project palette.
enum TodoStyle {
    /// Narrowest the window may get; the sidebar takes 220 of it when shown.
    static func minWidth(sidebar: Bool) -> CGFloat { sidebar ? 520 : 300 }
    static let minHeight: CGFloat = 360

    static func priority(_ p: Int) -> NSColor {
        switch p {
        case 1: return NSColor(srgbRed: 0.82, green: 0.27, blue: 0.23, alpha: 1)   // #D1453B
        case 2: return NSColor(srgbRed: 0.92, green: 0.54, blue: 0.04, alpha: 1)   // #EB8909
        case 3: return NSColor(srgbRed: 0.14, green: 0.44, blue: 0.88, alpha: 1)   // #246FE0
        default: return .secondaryLabelColor
        }
    }

    static func tokenColor(_ k: QuickAddResult.Token.Kind) -> NSColor {
        switch k {
        case .project: return NSColor(srgbRed: 0.29, green: 0.47, blue: 0.85, alpha: 1)
        case .label: return NSColor(srgbRed: 0.55, green: 0.38, blue: 0.80, alpha: 1)
        case .priority: return priority(1)
        case .date: return NSColor(srgbRed: 0.16, green: 0.60, blue: 0.33, alpha: 1)
        }
    }

    /// Due label colour: overdue red, today green, tomorrow orange, this week purple, later grey.
    static func due(_ d: DueDate, dates: TodoDates) -> Color {
        if dates.isOverdue(d) { return Color(nsColor: priority(1)) }
        switch dates.days(until: d.date) {
        case 0: return Color(nsColor: tokenColor(.date))
        case 1: return Color(nsColor: priority(2))
        case 2...6: return Color(red: 0.55, green: 0.38, blue: 0.80)
        default: return .secondary
        }
    }

    /// Project palette (Todoist's names).
    static let palette: [(name: String, color: Color)] = [
        ("berry_red", Color(red: 0.72, green: 0.15, blue: 0.40)),
        ("red", Color(red: 0.86, green: 0.25, blue: 0.21)),
        ("orange", Color(red: 1.00, green: 0.60, blue: 0.20)),
        ("yellow", Color(red: 0.98, green: 0.82, blue: 0.20)),
        ("olive_green", Color(red: 0.69, green: 0.71, blue: 0.20)),
        ("lime_green", Color(red: 0.49, green: 0.80, blue: 0.28)),
        ("green", Color(red: 0.18, green: 0.63, blue: 0.30)),
        ("mint_green", Color(red: 0.42, green: 0.80, blue: 0.73)),
        ("teal", Color(red: 0.08, green: 0.56, blue: 0.62)),
        ("sky_blue", Color(red: 0.08, green: 0.70, blue: 0.86)),
        ("blue", Color(red: 0.26, green: 0.44, blue: 0.89)),
        ("grape", Color(red: 0.53, green: 0.30, blue: 0.82)),
        ("violet", Color(red: 0.69, green: 0.21, blue: 0.84)),
        ("magenta", Color(red: 0.88, green: 0.26, blue: 0.68)),
        ("salmon", Color(red: 1.00, green: 0.55, blue: 0.52)),
        ("charcoal", Color(red: 0.31, green: 0.31, blue: 0.31)),
        ("grey", Color(red: 0.60, green: 0.60, blue: 0.60)),
    ]

    static func project(_ name: String) -> Color { palette.first { $0.name == name }?.color ?? .gray }

    static func title(_ s: String) -> String {
        s.split(separator: "_").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }
}
