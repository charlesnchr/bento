import Foundation
import CoreGraphics

enum ComposerGeometry {
    static func frame(current: CGRect, target: CGRect?, visible: CGRect, desiredHeight: CGFloat, center: Bool) -> CGRect {
        let bounds = visible.insetBy(dx: 12, dy: 12)
        let width = min(current.width, bounds.width)
        let height = min(max(170, desiredHeight), max(170, bounds.height * 0.75))
        let anchor = target ?? visible
        let x = center ? anchor.midX - width / 2 : current.minX
        let y = center ? anchor.midY - height / 2 : current.maxY - height
        return CGRect(x: min(max(x, bounds.minX), bounds.maxX - width),
                      y: min(max(y, bounds.minY), bounds.maxY - height), width: width, height: height)
    }
}
