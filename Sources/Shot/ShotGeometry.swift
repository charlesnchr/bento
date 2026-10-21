import CoreGraphics

/// Pure rect/coordinate math for the capture overlay (unit tested).
///
/// Spaces used in this module:
/// - **AX / global**: points, origin top-left of the primary display, y down
///   (same as CGWindowList, CGEvent locations and `CGDisplayBounds`).
/// - **Local**: points relative to one display's top-left corner, y down
///   (the overlay views are flipped so their coordinates are local).
/// - **Pixel**: integer pixels of that display's captured image, origin top-left.
enum ShotGeometry {
    /// Global AX point -> display-local point.
    static func local(_ p: CGPoint, in displayAX: CGRect) -> CGPoint {
        CGPoint(x: p.x - displayAX.minX, y: p.y - displayAX.minY)
    }

    static func global(_ p: CGPoint, in displayAX: CGRect) -> CGPoint {
        CGPoint(x: p.x + displayAX.minX, y: p.y + displayAX.minY)
    }

    static func globalRect(_ r: CGRect, in displayAX: CGRect) -> CGRect {
        r.offsetBy(dx: displayAX.minX, dy: displayAX.minY)
    }

    static func localRect(_ r: CGRect, in displayAX: CGRect) -> CGRect {
        r.offsetBy(dx: -displayAX.minX, dy: -displayAX.minY)
    }

    /// Rounds to whole points (selections are made in logical pixels, like Shottr).
    static func snap(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x.rounded(), y: p.y.rounded()) }

    static func clamp(_ p: CGPoint, to b: CGRect) -> CGPoint {
        CGPoint(x: min(max(p.x, b.minX), b.maxX), y: min(max(p.y, b.minY), b.maxY))
    }

    /// The selection rectangle between the anchor and the current point.
    /// - square: Shift held — equal sides, growing towards the pointer, limited by `bounds`.
    /// - fromCenter: Option held — the anchor is the centre.
    static func selection(anchor: CGPoint, current: CGPoint, square: Bool, fromCenter: Bool, bounds: CGRect) -> CGRect {
        var dx = current.x - anchor.x
        var dy = current.y - anchor.y
        if square {
            let side = max(abs(dx), abs(dy))
            let sx: CGFloat = dx < 0 ? -1 : 1
            let sy: CGFloat = dy < 0 ? -1 : 1
            // Space available from the anchor in the drag direction.
            var limitX = sx > 0 ? bounds.maxX - anchor.x : anchor.x - bounds.minX
            var limitY = sy > 0 ? bounds.maxY - anchor.y : anchor.y - bounds.minY
            if fromCenter {
                limitX = min(anchor.x - bounds.minX, bounds.maxX - anchor.x)
                limitY = min(anchor.y - bounds.minY, bounds.maxY - anchor.y)
            }
            let s = min(side, limitX, limitY)
            dx = s * sx
            dy = s * sy
        }
        let r: CGRect
        if fromCenter {
            r = CGRect(x: anchor.x - abs(dx), y: anchor.y - abs(dy), width: abs(dx) * 2, height: abs(dy) * 2)
        } else {
            r = CGRect(x: min(anchor.x, anchor.x + dx), y: min(anchor.y, anchor.y + dy), width: abs(dx), height: abs(dy))
        }
        return r.intersection(bounds).standardized.nullToZero
    }

    /// Moves `r` by `delta`, keeping it entirely inside `bounds`.
    static func move(_ r: CGRect, by delta: CGVector, within bounds: CGRect) -> CGRect {
        var o = CGPoint(x: r.minX + delta.dx, y: r.minY + delta.dy)
        o.x = min(max(o.x, bounds.minX), bounds.maxX - r.width)
        o.y = min(max(o.y, bounds.minY), bounds.maxY - r.height)
        return CGRect(origin: o, size: r.size)
    }

    /// Integral pixel rect of a local rect in an image with the given scale,
    /// clamped to the image. Edges are rounded (not floored/ceiled) so a
    /// whole-point selection maps to exactly `size × scale` pixels.
    /// A null or non-finite rect (e.g. an empty intersection) gives `.zero`.
    static func pixelRect(local r: CGRect, scale: CGFloat, imageWidth: Int, imageHeight: Int) -> CGRect {
        guard !r.isNull, scale.isFinite, scale > 0 else { return .zero }
        let x0 = int((r.minX * scale).rounded()), y0 = int((r.minY * scale).rounded())
        let x1 = int((r.maxX * scale).rounded()), y1 = int((r.maxY * scale).rounded())
        let cx0 = min(max(x0, 0), imageWidth), cy0 = min(max(y0, 0), imageHeight)
        let cx1 = min(max(x1, 0), imageWidth), cy1 = min(max(y1, 0), imageHeight)
        return CGRect(x: cx0, y: cy0, width: max(0, cx1 - cx0), height: max(0, cy1 - cy0))
    }

    /// The image pixel under a local point (the pixel whose square contains it).
    static func pixel(at p: CGPoint, scale: CGFloat) -> (x: Int, y: Int) {
        (int((p.x * scale).rounded(.down)), int((p.y * scale).rounded(.down)))
    }

    /// `Int(v)` that never traps: NaN gives 0, infinities and huge values clamp.
    static func int(_ v: CGFloat) -> Int {
        guard !v.isNaN else { return 0 }
        let limit = CGFloat(1 << 40)
        return Int(min(max(v, -limit), limit))
    }

    /// Places a floating box (loupe) near the cursor: below-right by default,
    /// flipped to the other side of the cursor when it would leave `bounds`.
    static func floatingOrigin(near p: CGPoint, size: CGSize, offset: CGFloat, bounds: CGRect) -> CGPoint {
        var x = p.x + offset
        var y = p.y + offset
        if x + size.width > bounds.maxX { x = p.x - offset - size.width }
        if y + size.height > bounds.maxY { y = p.y - offset - size.height }
        x = min(max(x, bounds.minX), bounds.maxX - size.width)
        y = min(max(y, bounds.minY), bounds.maxY - size.height)
        return CGPoint(x: x, y: y)
    }

    /// Position for the "W × H" label: just below the selection's bottom-right
    /// corner, inside the selection when there's no room below.
    static func sizeLabelOrigin(selection r: CGRect, labelSize: CGSize, bounds: CGRect, gap: CGFloat = 6) -> CGPoint {
        var x = r.maxX - labelSize.width
        var y = r.maxY + gap
        if y + labelSize.height > bounds.maxY {
            y = r.maxY - gap - labelSize.height
            if y < bounds.minY { y = bounds.minY }
        }
        x = min(max(x, bounds.minX), bounds.maxX - labelSize.width)
        return CGPoint(x: x, y: y)
    }

    /// The rect in `rects` (front-to-back order) that contains the point.
    static func frontmost(at p: CGPoint, in rects: [CGRect]) -> Int? {
        rects.firstIndex { $0.contains(p) }
    }

    /// Union of display frames and the canvas size for compositing every
    /// display into one image at the highest scale.
    static func canvas(for frames: [CGRect], scales: [CGFloat]) -> (union: CGRect, scale: CGFloat, width: Int, height: Int) {
        let union = frames.reduce(CGRect.null) { $0.union($1) }
        let scale = scales.max() ?? 1
        guard !union.isNull else { return (.zero, scale, 0, 0) }
        return (union, scale, Int((union.width * scale).rounded()), Int((union.height * scale).rounded()))
    }

    /// Cardinal-direction distances from `p` to the nearest edges found by
    /// `isEdge` (pixel coordinates). Used by the frozen-screen ruler.
    static func rulerExtent(from p: (x: Int, y: Int), width: Int, height: Int,
                            same: (_ x: Int, _ y: Int) -> Bool) -> (left: Int, right: Int, up: Int, down: Int) {
        var l = p.x, r = p.x, u = p.y, d = p.y
        while l > 0 && same(l - 1, p.y) { l -= 1 }
        while r < width - 1 && same(r + 1, p.y) { r += 1 }
        while u > 0 && same(p.x, u - 1) { u -= 1 }
        while d < height - 1 && same(p.x, d + 1) { d += 1 }
        return (l, r, u, d)
    }
}

extension CGRect {
    var nullToZero: CGRect { isNull ? .zero : self }
}
