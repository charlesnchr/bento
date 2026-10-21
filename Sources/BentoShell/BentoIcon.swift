import AppKit

/// The bento-box glyph: a rounded box split into one tall and two short
/// compartments. Drawn in code so there are no asset catalogs to build.
public enum BentoIcon {
    public static func menuBarImage() -> NSImage {
        let img = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { rect in
            let box = rect.insetBy(dx: 2, dy: 3)
            NSColor.black.setStroke()
            let outer = NSBezierPath(roundedRect: box, xRadius: 2.5, yRadius: 2.5)
            outer.lineWidth = 1.6
            outer.stroke()
            let split = NSBezierPath()
            split.lineWidth = 1.4
            let x = box.minX + box.width * 0.45
            split.move(to: NSPoint(x: x, y: box.minY))
            split.line(to: NSPoint(x: x, y: box.maxY))
            split.move(to: NSPoint(x: x, y: box.midY))
            split.line(to: NSPoint(x: box.maxX, y: box.midY))
            split.stroke()
            NSColor.black.setFill()
            NSBezierPath(ovalIn: NSRect(x: box.minX + box.width * 0.13, y: box.midY - 2, width: 4, height: 4)).fill()
            return true
        }
        img.isTemplate = true
        return img
    }
}
