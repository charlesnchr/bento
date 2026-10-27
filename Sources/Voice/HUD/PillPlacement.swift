import AppKit

/// Where the pill sits: the geometry behind dragging it and remembering the spot.
///
/// The spot is the pill's bottom-centre, stored as a fraction of the visible
/// frame of the screen it was dropped on. The pill still follows the display
/// being dictated on, so the same fraction is applied to whichever screen that
/// is, and clamped to it, so a display change can never leave it off screen.
/// Nothing saved means the default: bottom-centre, just above the Dock.
enum PillPlacement {
    static let panelSize = NSSize(width: 600, height: 96)
    /// The pill's bottom edge sits this far above the panel's.
    static let bottomInset: CGFloat = 8
    static let defaultsKey = "pillPosition"
    /// Half the resting pill's hover target: the anchor goes no nearer a
    /// screen's side edge, so the resting pill is always centred on it.
    private static let edgeInset: CGFloat = 62

    /// The saved spot, or nil for nothing usable. Not NSPointFromString, which
    /// reads garbage as (0, 0): the bottom-left corner.
    static func parse(_ raw: String?) -> CGPoint? {
        guard let raw, raw.hasPrefix("{"), raw.hasSuffix("}") else { return nil }
        let parts = raw.dropFirst().dropLast().split(separator: ",")
            .compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard parts.count == 2, parts.allSatisfy(\.isFinite) else { return nil }
        return CGPoint(x: parts[0], y: parts[1])
    }

    /// The pill's bottom-centre in screen coordinates.
    static func anchor(relative: CGPoint?, in visible: NSRect) -> CGPoint {
        guard let relative, relative.x.isFinite, relative.y.isFinite else {
            return CGPoint(x: visible.midX, y: visible.minY + 16 + bottomInset)
        }
        return clampedAnchor(CGPoint(x: visible.minX + relative.x * visible.width,
                                     y: visible.minY + relative.y * visible.height), in: visible)
    }

    /// What gets saved for a pill dropped at `anchor` on a screen.
    static func relative(anchor: CGPoint, in visible: NSRect) -> CGPoint {
        let anchor = clampedAnchor(anchor, in: visible)
        return CGPoint(x: (anchor.x - visible.minX) / max(visible.width, 1),
                       y: (anchor.y - visible.minY) / max(visible.height, 1))
    }

    /// Keeps the anchor where the panel around it can stay on the screen.
    static func clampedAnchor(_ anchor: CGPoint, in visible: NSRect) -> CGPoint {
        CGPoint(x: clamp(anchor.x, visible.minX + edgeInset, visible.maxX - edgeInset),
                y: clamp(anchor.y, visible.minY + bottomInset, visible.maxY - panelSize.height + bottomInset))
    }

    /// The panel origin for an anchor, kept on the screen, and the anchor's x
    /// inside the panel. Away from the edges the anchor is the panel's centre.
    static func panelOrigin(anchor: CGPoint, in visible: NSRect) -> (origin: CGPoint, anchorX: CGFloat) {
        let anchor = clampedAnchor(anchor, in: visible)
        let origin = CGPoint(x: clamp(anchor.x - panelSize.width / 2, visible.minX, visible.maxX - panelSize.width),
                             y: clamp(anchor.y - bottomInset, visible.minY, visible.maxY - panelSize.height))
        return (origin, anchor.x - origin.x)
    }

    /// The pill's leading edge in the panel: centred on the anchor, slid inward
    /// only as far as a wide state needs to stay inside the panel.
    static func pillMinX(anchorX: CGFloat, width: CGFloat, panelWidth: CGFloat) -> CGFloat {
        clamp(anchorX - width / 2, 0, panelWidth - width)
    }

    /// Lower bound wins when the range is empty (a screen narrower than the panel).
    private static func clamp(_ value: CGFloat, _ lower: CGFloat, _ upper: CGFloat) -> CGFloat {
        max(lower, min(value, upper))
    }
}

extension Notification.Name {
    /// Settings asked for the pill to go back to its default spot.
    static let pillPositionReset = Notification.Name("com.charles.bento.voice.pill.resetPosition")
}
