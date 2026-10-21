import AppKit

/// Borderless full-screen panel showing a frozen display. Non-activating so
/// the user's app keeps focus, but it can become key to receive keys.
final class OverlayPanel: NSPanel {
    init(frame: NSRect) {
        super.init(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = true
        backgroundColor = .black
        hasShadow = false
        level = .screenSaver
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        isReleasedWhenClosed = false
        acceptsMouseMovedEvents = true
        becomesKeyOnlyIfNeeded = false
        hidesOnDeactivate = false
        animationBehavior = .none
        isMovable = false
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// Small rounded label ("1280 × 720", hints). Dark material look that reads
/// on any screen content.
final class PillLabel: NSView {
    var text = "" { didSet { if text != oldValue { invalidate() } } }
    var font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium) { didSet { invalidate() } }
    var insets = NSSize(width: 8, height: 4)
    private var cachedSize: NSSize?

    override var isFlipped: Bool { true }

    private var attrs: [NSAttributedString.Key: Any] {
        [.font: font, .foregroundColor: NSColor.white]
    }

    private func invalidate() {
        cachedSize = nil
        needsDisplay = true
    }

    /// Size that fits the current text.
    var fittingSizeForText: NSSize {
        if let cachedSize { return cachedSize }
        let s = (text as NSString).size(withAttributes: attrs)
        let size = NSSize(width: ceil(s.width) + insets.width * 2, height: ceil(s.height) + insets.height * 2)
        cachedSize = size
        return size
    }

    override func draw(_ dirtyRect: NSRect) {
        let path = NSBezierPath(roundedRect: bounds, xRadius: min(6, bounds.height / 2), yRadius: min(6, bounds.height / 2))
        NSColor(white: 0.08, alpha: 0.82).setFill()
        path.fill()
        NSColor(white: 1, alpha: 0.18).setStroke()
        path.lineWidth = 1
        path.stroke()
        let s = (text as NSString).size(withAttributes: attrs)
        (text as NSString).draw(at: NSPoint(x: (bounds.width - s.width) / 2, y: (bounds.height - s.height) / 2), withAttributes: attrs)
    }
}

/// Magnifier: a pixel grid around the cursor with coordinates and colour.
final class LoupeView: NSView {
    static let cells = 15
    static let cell: CGFloat = 8
    static let gridSize = CGFloat(cells) * cell
    static let infoHeight: CGFloat = 38
    static let size = NSSize(width: gridSize, height: gridSize + infoHeight)

    var image: CGImage?
    /// Pixel at the centre of the grid.
    var pixel: (x: Int, y: Int) = (0, 0)
    var coordinateText = ""
    var colorText = ""
    var color: RGB8?

    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.shadowColor = NSColor.black.cgColor
        layer?.shadowOpacity = 0.35
        layer?.shadowRadius = 6
        layer?.shadowOffset = CGSize(width: 0, height: -2)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let g = LoupeView.gridSize
        let outer = NSBezierPath(roundedRect: bounds, xRadius: 10, yRadius: 10)
        NSColor(white: 0.08, alpha: 0.9).setFill()
        outer.fill()

        // Magnified pixels.
        ctx.saveGState()
        let gridRect = CGRect(x: 0, y: 0, width: g, height: g)
        NSBezierPath(roundedRect: bounds, xRadius: 10, yRadius: 10).addClip()
        NSColor.black.setFill()
        gridRect.fill()
        if let image {
            let half = LoupeView.cells / 2
            let want = CGRect(x: pixel.x - half, y: pixel.y - half, width: LoupeView.cells, height: LoupeView.cells)
            let have = want.intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
            if !have.isNull, let crop = image.cropping(to: have) {
                let c = LoupeView.cell
                let dest = CGRect(x: (have.minX - want.minX) * c, y: (have.minY - want.minY) * c,
                                  width: have.width * c, height: have.height * c)
                ctx.interpolationQuality = .none
                // The view is flipped; draw the image upright.
                ctx.saveGState()
                ctx.translateBy(x: 0, y: dest.maxY + dest.minY)
                ctx.scaleBy(x: 1, y: -1)
                ctx.draw(crop, in: dest)
                ctx.restoreGState()
            }
        }
        // Grid.
        ctx.setStrokeColor(NSColor(white: 0.5, alpha: 0.25).cgColor)
        ctx.setLineWidth(0.5)
        for i in 1..<LoupeView.cells {
            let v = CGFloat(i) * LoupeView.cell
            ctx.move(to: CGPoint(x: v, y: 0)); ctx.addLine(to: CGPoint(x: v, y: g))
            ctx.move(to: CGPoint(x: 0, y: v)); ctx.addLine(to: CGPoint(x: g, y: v))
        }
        ctx.strokePath()
        // Centre pixel.
        let mid = CGFloat(LoupeView.cells / 2) * LoupeView.cell
        let centre = CGRect(x: mid, y: mid, width: LoupeView.cell, height: LoupeView.cell)
        ctx.setStrokeColor(NSColor.black.cgColor)
        ctx.setLineWidth(1)
        ctx.stroke(centre.insetBy(dx: -0.5, dy: -0.5))
        ctx.setStrokeColor(NSColor.white.cgColor)
        ctx.stroke(centre.insetBy(dx: 0.5, dy: 0.5))
        ctx.restoreGState()

        // Info: coordinates, swatch + colour value.
        let font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium)
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.white]
        let dim: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor(white: 1, alpha: 0.65)]
        (coordinateText as NSString).draw(at: NSPoint(x: 8, y: g + 3), withAttributes: dim)
        let swatch = CGRect(x: 8, y: g + 20, width: 12, height: 12)
        if let color {
            NSColor(srgbRed: CGFloat(color.r) / 255, green: CGFloat(color.g) / 255, blue: CGFloat(color.b) / 255, alpha: 1).setFill()
            NSBezierPath(roundedRect: swatch, xRadius: 3, yRadius: 3).fill()
            NSColor(white: 1, alpha: 0.4).setStroke()
            NSBezierPath(roundedRect: swatch.insetBy(dx: 0.5, dy: 0.5), xRadius: 3, yRadius: 3).stroke()
        }
        (colorText as NSString).draw(at: NSPoint(x: 26, y: g + 18), withAttributes: attrs)

        NSColor(white: 1, alpha: 0.2).setStroke()
        let border = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 10, yRadius: 10)
        border.lineWidth = 1
        border.stroke()
    }
}

extension NSVisualEffectView {
    /// Rounds a behind-window material properly (a layer corner radius
    /// leaves the blurred backdrop visible in the corners).
    func roundCorners(_ radius: CGFloat) {
        let edge = 2 * radius + 1
        let img = NSImage(size: NSSize(width: edge, height: edge), flipped: false) { r in
            NSColor.black.setFill()
            NSBezierPath(roundedRect: r, xRadius: radius, yRadius: radius).fill()
            return true
        }
        img.capInsets = NSEdgeInsets(top: radius, left: radius, bottom: radius, right: radius)
        img.resizingMode = .stretch
        maskImage = img
    }
}
