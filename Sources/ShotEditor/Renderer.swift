import AppKit
import CoreImage

// Draws annotations, both on screen (AnnotationView) and when flattening the
// document into the final image, so the two always match. All drawing happens
// in image-point coordinates in a flipped (top-left origin) context.

enum Metrics {
    static func stroke(_ s: Double) -> CGFloat { CGFloat(1 + s * 0.8) }
    static func arrowWidth(_ s: Double) -> CGFloat { CGFloat(2 + s * 1.15) }
    static func fontSize(_ s: Double) -> CGFloat { CGFloat(8 + s * 2) }
    static func counterRadius(_ s: Double) -> CGFloat { CGFloat(7 + s * 1.6) }
    static func highlightWidth(_ s: Double) -> CGFloat { CGFloat(8 + s * 2.4) }
    /// Gaussian sigma in points.
    static func blurRadius(_ s: Double) -> CGFloat { CGFloat(2 + s * 1.4) }
    /// Pixelation block size in points.
    static func pixelBlock(_ s: Double) -> CGFloat { CGFloat(3 + s * 1.3) }
    static func magnification(_ s: Double) -> CGFloat { CGFloat(1.5 + s * 0.25) }
    static let spotlightDim = 0.55
}

struct RenderContext {
    let image: CGImage
    /// Pixels per point of `image`.
    let scale: CGFloat
    /// Visible area in image points (spotlight dims this).
    let canvas: CGRect
    let effects: EffectCache
    /// Base-space units per point, so shadows look the same at every zoom / output scale.
    let shadowScale: CGFloat
    /// Text annotation being edited in place: its text is drawn by the text view.
    var editingTextID: UUID?
}

enum Renderer {
    // MARK: Whole document

    /// Draws all annotations: obfuscation first, then the spotlight dimming,
    /// then the vector annotations in their stacking order.
    static func drawAll(_ annotations: [Annotation], rc: RenderContext, cg: CGContext) {
        for a in annotations where a.kind == .blur || a.kind == .erase { draw(a, rc: rc, cg: cg) }
        drawSpotlights(annotations.filter { $0.kind == .spotlight }, rc: rc, cg: cg)
        for a in annotations where a.kind != .blur && a.kind != .erase && a.kind != .spotlight { draw(a, rc: rc, cg: cg) }
    }

    static func draw(_ a: Annotation, rc: RenderContext, cg: CGContext) {
        let color = HexColor.color(a.color)
        cg.saveGState()
        defer { cg.restoreGState() }
        switch a.kind {
        case .arrow:
            setShadow(cg, rc)
            cg.addPath(arrowPath(a.p1, a.p2, width: Metrics.arrowWidth(a.size), style: a.style))
            cg.setFillColor(color.cgColor)
            cg.setStrokeColor(color.cgColor)
            cg.setLineWidth(1)
            cg.setLineJoin(.round)
            cg.drawPath(using: .fillStroke)

        case .line:
            setShadow(cg, rc)
            let w = Metrics.stroke(a.size)
            cg.setStrokeColor(color.cgColor)
            cg.setLineWidth(w)
            cg.setLineCap(a.style == 1 ? .butt : .round)
            if a.style == 1 { cg.setLineDash(phase: 0, lengths: [w * 2.4, w * 1.6]) }
            cg.move(to: a.p1)
            cg.addLine(to: a.p2)
            cg.strokePath()

        case .rect, .oval:
            let w = Metrics.stroke(a.size)
            let r = a.rect
            let path = shapePath(a)
            if a.style == 2 {
                setShadow(cg, rc)
                cg.addPath(path)
                cg.setFillColor(color.cgColor)
                cg.fillPath()
            } else {
                if a.style == 1 {
                    cg.addPath(path)
                    cg.setFillColor(color.withAlphaComponent(color.alphaComponent * 0.28).cgColor)
                    cg.fillPath()
                }
                setShadow(cg, rc)
                cg.addPath(path)
                cg.setStrokeColor(color.cgColor)
                cg.setLineWidth(min(w, max(1, min(r.width, r.height) / 2)))
                cg.strokePath()
            }

        case .text:
            drawText(a, rc: rc, cg: cg)

        case .highlight:
            cg.setBlendMode(.multiply)
            cg.setStrokeColor(color.withAlphaComponent(0.45).cgColor)
            cg.setLineWidth(Metrics.highlightWidth(a.size))
            cg.setLineCap(a.style == 1 ? .butt : .round)
            cg.setLineJoin(.round)
            cg.addPath(strokePath(a))
            cg.strokePath()

        case .freehand:
            setShadow(cg, rc)
            cg.setStrokeColor(color.cgColor)
            cg.setLineWidth(Metrics.stroke(a.size))
            cg.setLineCap(.round)
            cg.setLineJoin(.round)
            cg.addPath(strokePath(a))
            cg.strokePath()

        case .blur, .erase:
            if let (patch, rect) = rc.effects.patch(for: a, image: rc.image, scale: rc.scale) {
                cg.interpolationQuality = .none
                drawImage(patch, in: rect, cg: cg)
            }

        case .counter:
            drawCounter(a, rc: rc, cg: cg)

        case .spotlight:
            drawSpotlights([a], rc: rc, cg: cg)

        case .magnifier:
            drawMagnifier(a, rc: rc, cg: cg)

        case .ruler:
            drawRuler(a, rc: rc, cg: cg)
        }
    }

    // MARK: Paths

    /// Shottr-style tapered arrow (style 0), line arrow (1) or double-headed (2), as a fill path.
    static func arrowPath(_ a: CGPoint, _ b: CGPoint, width w: CGFloat, style: Int) -> CGPath {
        let path = CGMutablePath()
        let dx = b.x - a.x, dy = b.y - a.y
        let len = hypot(dx, dy)
        guard len > 0.5 else { return path }
        let u = CGPoint(x: dx / len, y: dy / len)
        let n = CGPoint(x: -u.y, y: u.x)
        func p(_ o: CGPoint, _ along: CGFloat, _ across: CGFloat) -> CGPoint {
            CGPoint(x: o.x + u.x * along + n.x * across, y: o.y + u.y * along + n.y * across)
        }
        switch style {
        case 1, 2:
            let shaft = max(1.5, w * 0.45)
            let headLen = min(len * (style == 2 ? 0.4 : 0.6), shaft * 4.2 + 5)
            let headHalf = headLen * 0.55
            let start = style == 2 ? headLen * 0.8 : 0
            let line = CGMutablePath()
            line.move(to: p(a, start, 0))
            line.addLine(to: p(b, -headLen * 0.8, 0))
            path.addPath(line.copy(strokingWithWidth: shaft, lineCap: .round, lineJoin: .round, miterLimit: 10))
            path.addLines(between: [b, p(b, -headLen, headHalf), p(b, -headLen * 0.8, 0), p(b, -headLen, -headHalf)])
            path.closeSubpath()
            if style == 2 {
                path.addLines(between: [a, p(a, headLen, -headHalf), p(a, headLen * 0.8, 0), p(a, headLen, headHalf)])
                path.closeSubpath()
            }
        default:
            let headLen = min(len * 0.55, w * 3.0 + 7)
            let headHalf = headLen * 0.52
            let neckHalf = w * 0.5
            let tailHalf = max(w * 0.16, 0.6)
            let neck = headLen * 0.74
            path.move(to: p(a, 0, tailHalf))
            path.addLine(to: p(b, -neck, neckHalf))
            path.addLine(to: p(b, -headLen, headHalf))
            path.addLine(to: b)
            path.addLine(to: p(b, -headLen, -headHalf))
            path.addLine(to: p(b, -neck, -neckHalf))
            path.addLine(to: p(a, 0, -tailHalf))
            path.addArc(center: a, radius: tailHalf, startAngle: atan2(-n.y, -n.x), endAngle: atan2(n.y, n.x), clockwise: false)
            path.closeSubpath()
        }
        return path
    }

    static func shapePath(_ a: Annotation) -> CGPath {
        let r = a.rect
        if a.kind == .oval || (a.kind == .spotlight && a.style == 1) { return CGPath(ellipseIn: r, transform: nil) }
        let radius = min(a.kind == .spotlight ? 6 : Metrics.stroke(a.size) * 1.2 + 2, min(r.width, r.height) / 2)
        return CGPath(roundedRect: r, cornerWidth: radius, cornerHeight: radius, transform: nil)
    }

    /// Smoothed path through the stroke points (quadratic curves through midpoints).
    static func strokePath(_ a: Annotation) -> CGPath {
        let pts = a.path ?? [a.p1, a.p2]
        let path = CGMutablePath()
        guard let first = pts.first else { return path }
        path.move(to: first)
        if pts.count == 1 {
            path.addLine(to: CGPoint(x: first.x + 0.01, y: first.y))
        } else if pts.count == 2 {
            path.addLine(to: pts[1])
        } else {
            for i in 1..<(pts.count - 1) {
                let mid = CGPoint(x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2)
                path.addQuadCurve(to: mid, control: pts[i])
            }
            path.addLine(to: pts[pts.count - 1])
        }
        return path
    }

    // MARK: Text

    struct TextLayout {
        let frame: CGRect
        let textRect: CGRect
        let string: NSAttributedString
        let font: NSFont
        let padding: CGSize
        let foreground: NSColor
        let background: NSColor?
        let outline: NSColor?
    }

    static func textFont(size: Double) -> NSFont { .systemFont(ofSize: Metrics.fontSize(size), weight: .semibold) }

    static func textLayout(_ a: Annotation) -> TextLayout {
        let font = textFont(size: a.size)
        let fs = font.pointSize
        let label = a.style == 0
        let color = HexColor.color(a.color)
        let fg = label ? HexColor.contrasting(a.color) : color
        let para = NSMutableParagraphStyle()
        para.lineBreakMode = .byClipping
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: fg, .paragraphStyle: para]
        let raw = a.text ?? ""
        let string = NSAttributedString(string: raw, attributes: attrs)
        let measured = NSAttributedString(string: raw.isEmpty || raw.hasSuffix("\n") ? raw + "W" : raw, attributes: attrs)
        let bounds = measured.boundingRect(with: CGSize(width: 100_000, height: 100_000), options: [.usesLineFragmentOrigin, .usesFontLeading])
        let textSize = CGSize(width: ceil(max(bounds.width, fs * 0.6)), height: ceil(bounds.height))
        let padding = label ? CGSize(width: round(fs * 0.45), height: round(fs * 0.2)) : CGSize(width: 2, height: 0)
        let frame = CGRect(x: a.p1.x, y: a.p1.y, width: textSize.width + padding.width * 2, height: textSize.height + padding.height * 2)
        let textRect = CGRect(x: frame.minX + padding.width, y: frame.minY + padding.height, width: textSize.width, height: textSize.height)
        return TextLayout(frame: frame, textRect: textRect, string: string, font: font, padding: padding,
                          foreground: fg, background: label ? color : nil, outline: label ? nil : HexColor.contrasting(a.color))
    }

    static func drawText(_ a: Annotation, rc: RenderContext, cg: CGContext) {
        let layout = textLayout(a)
        if let bg = layout.background {
            setShadow(cg, rc)
            let radius = min(layout.font.pointSize * 0.32, layout.frame.height / 2)
            cg.addPath(CGPath(roundedRect: layout.frame, cornerWidth: radius, cornerHeight: radius, transform: nil))
            cg.setFillColor(bg.cgColor)
            cg.fillPath()
            cg.setShadow(offset: .zero, blur: 0, color: nil)
        }
        guard rc.editingTextID != a.id else { return }
        withNSContext(cg) {
            if let outline = layout.outline {
                let o = NSMutableAttributedString(attributedString: layout.string)
                o.addAttributes([.strokeColor: outline, .strokeWidth: 300 / layout.font.pointSize], range: NSRange(location: 0, length: o.length))
                o.draw(with: layout.textRect, options: [.usesLineFragmentOrigin, .usesFontLeading])
            }
            layout.string.draw(with: layout.textRect, options: [.usesLineFragmentOrigin, .usesFontLeading])
        }
    }

    // MARK: Counter

    static func counterRect(_ a: Annotation) -> CGRect {
        let r = Metrics.counterRadius(a.size)
        return CGRect(x: a.p1.x - r, y: a.p1.y - r, width: r * 2, height: r * 2)
    }

    static func drawCounter(_ a: Annotation, rc: RenderContext, cg: CGContext) {
        let rect = counterRect(a)
        let color = HexColor.color(a.color)
        setShadow(cg, rc)
        cg.setFillColor(color.cgColor)
        cg.fillEllipse(in: rect)
        cg.setShadow(offset: .zero, blur: 0, color: nil)
        let text = "\(a.number ?? 1)"
        let base = NSFont.systemFont(ofSize: rect.height * (text.count > 1 ? 0.5 : 0.58), weight: .bold)
        let font = base.fontDescriptor.withDesign(.rounded).flatMap { NSFont(descriptor: $0, size: base.pointSize) } ?? base
        let s = NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: HexColor.contrasting(a.color)])
        let size = s.size()
        withNSContext(cg) {
            s.draw(at: CGPoint(x: rect.midX - size.width / 2, y: rect.midY - size.height / 2))
        }
    }

    // MARK: Spotlight

    static func drawSpotlights(_ spots: [Annotation], rc: RenderContext, cg: CGContext) {
        guard !spots.isEmpty else { return }
        let dim = spots.compactMap(\.dim).max() ?? Metrics.spotlightDim
        cg.saveGState()
        let path = CGMutablePath()
        path.addRect(rc.canvas.insetBy(dx: -2, dy: -2))
        for s in spots { path.addPath(shapePath(s)) }
        cg.addPath(path)
        cg.setFillColor(NSColor.black.withAlphaComponent(dim).cgColor)
        cg.fillPath(using: .evenOdd)
        cg.restoreGState()
    }

    // MARK: Magnifier

    static func magnifierRadius(_ a: Annotation) -> CGFloat { max(12, a.p1.distance(to: a.p2)) }

    static func drawMagnifier(_ a: Annotation, rc: RenderContext, cg: CGContext) {
        let r = magnifierRadius(a)
        let c = a.p1
        let circle = CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2)
        let z = Metrics.magnification(a.size)
        let src = CGRect(x: c.x - r / z, y: c.y - r / z, width: r * 2 / z, height: r * 2 / z)
        let pixel = CGRect(x: src.minX * rc.scale, y: src.minY * rc.scale, width: src.width * rc.scale, height: src.height * rc.scale).integral
        let bounds = CGRect(x: 0, y: 0, width: rc.image.width, height: rc.image.height)
        setShadow(cg, rc, strong: true)
        cg.setFillColor(NSColor.white.cgColor)
        cg.fillEllipse(in: circle)
        cg.setShadow(offset: .zero, blur: 0, color: nil)
        let clipped = pixel.intersection(bounds)
        if !clipped.isNull, let crop = rc.image.cropping(to: clipped) {
            cg.saveGState()
            cg.addEllipse(in: circle)
            cg.clip()
            cg.interpolationQuality = .none
            // Map the clipped source rect back into the magnified circle.
            let dest = CGRect(x: c.x + (clipped.minX / rc.scale - c.x) * z, y: c.y + (clipped.minY / rc.scale - c.y) * z,
                              width: clipped.width / rc.scale * z, height: clipped.height / rc.scale * z)
            drawImage(crop, in: dest, cg: cg)
            cg.restoreGState()
        }
        cg.setStrokeColor(HexColor.color(a.color).cgColor)
        cg.setLineWidth(max(2, Metrics.stroke(a.size) * 0.7))
        cg.strokeEllipse(in: circle)
    }

    // MARK: Ruler

    static func rulerLabel(_ a: Annotation) -> String {
        let d = a.p1.distance(to: a.p2)
        return d.rounded() == d || abs(d - d.rounded()) < 0.05 ? "\(Int(d.rounded()))" : String(format: "%.1f", d)
    }

    static func drawRuler(_ a: Annotation, rc: RenderContext, cg: CGContext) {
        drawMeasurement(from: a.p1, to: a.p2, label: rulerLabel(a), color: HexColor.color(a.color), cg: cg, unit: 1)
    }

    /// Measurement line with end ticks and a centred value pill. `unit` scales
    /// the line/label size (1 / magnification for live on-screen overlays).
    static func drawMeasurement(from p1: CGPoint, to p2: CGPoint, label: String, color: NSColor, cg: CGContext, unit: CGFloat) {
        let len = p1.distance(to: p2)
        guard len > 0 else { return }
        let u = CGPoint(x: (p2.x - p1.x) / len, y: (p2.y - p1.y) / len)
        let n = CGPoint(x: -u.y, y: u.x)
        let tick = 5 * unit
        cg.saveGState()
        cg.setStrokeColor(color.cgColor)
        cg.setLineWidth(1.5 * unit)
        cg.move(to: p1); cg.addLine(to: p2)
        for p in [p1, p2] {
            cg.move(to: CGPoint(x: p.x + n.x * tick, y: p.y + n.y * tick))
            cg.addLine(to: CGPoint(x: p.x - n.x * tick, y: p.y - n.y * tick))
        }
        cg.strokePath()
        let font = NSFont.monospacedDigitSystemFont(ofSize: 11 * unit, weight: .semibold)
        let s = NSAttributedString(string: label, attributes: [.font: font, .foregroundColor: NSColor.white])
        let size = s.size()
        var mid = CGPoint(x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2)
        let pw = size.width + 10 * unit, ph = size.height + 4 * unit
        if len < pw + 16 * unit {
            // Too short to hold the label: put it beside the line (above / to the right).
            let off = (abs(n.y) * ph + abs(n.x) * pw) / 2 + 4 * unit
            let side: CGFloat = n.y > 0 || (n.y == 0 && n.x < 0) ? -1 : 1
            mid = CGPoint(x: mid.x + n.x * off * side, y: mid.y + n.y * off * side)
        }
        let pill = CGRect(x: mid.x - pw / 2, y: mid.y - ph / 2, width: pw, height: ph)
        cg.addPath(CGPath(roundedRect: pill, cornerWidth: 4 * unit, cornerHeight: 4 * unit, transform: nil))
        cg.setFillColor(NSColor(white: 0.1, alpha: 0.82).cgColor)
        cg.fillPath()
        withNSContext(cg) { s.draw(at: CGPoint(x: pill.minX + 5 * unit, y: pill.minY + 2 * unit)) }
        cg.restoreGState()
    }

    // MARK: Bounds & hit testing

    /// Generous bounds used for redraw invalidation and selection outlines.
    static func bounds(of a: Annotation) -> CGRect {
        switch a.kind {
        case .text: return textLayout(a).frame
        case .counter: return counterRect(a)
        case .magnifier:
            let r = magnifierRadius(a)
            return CGRect(x: a.p1.x - r, y: a.p1.y - r, width: r * 2, height: r * 2)
        case .freehand, .highlight:
            let pts = a.path ?? [a.p1, a.p2]
            let xs = pts.map(\.x), ys = pts.map(\.y)
            let w = (a.kind == .highlight ? Metrics.highlightWidth(a.size) : Metrics.stroke(a.size)) / 2
            return CGRect(x: (xs.min() ?? 0) - w, y: (ys.min() ?? 0) - w,
                          width: (xs.max() ?? 0) - (xs.min() ?? 0) + w * 2, height: (ys.max() ?? 0) - (ys.min() ?? 0) + w * 2)
        case .arrow:
            return CGRect(p1: a.p1, p2: a.p2).insetBy(dx: -Metrics.arrowWidth(a.size) * 2.5, dy: -Metrics.arrowWidth(a.size) * 2.5)
        case .line, .ruler:
            return CGRect(p1: a.p1, p2: a.p2).insetBy(dx: -max(12, Metrics.stroke(a.size)), dy: -max(12, Metrics.stroke(a.size)))
        default:
            let w = Metrics.stroke(a.size)
            return a.rect.insetBy(dx: -w, dy: -w)
        }
    }

    /// Whether `p` (image points) hits the annotation; `tolerance` in points.
    static func hitTest(_ a: Annotation, _ p: CGPoint, tolerance t: CGFloat) -> Bool {
        switch a.kind {
        case .arrow:
            return p.distance(toSegment: a.p1, a.p2) <= max(t, Metrics.arrowWidth(a.size))
        case .line, .ruler:
            return p.distance(toSegment: a.p1, a.p2) <= max(t, Metrics.stroke(a.size))
        case .rect, .oval:
            let r = a.rect
            if a.style != 0 { return r.insetBy(dx: -t, dy: -t).contains(p) }
            let w = Metrics.stroke(a.size) / 2 + t
            if a.kind == .oval {
                guard r.width > 0, r.height > 0 else { return false }
                let nx = (p.x - r.midX) / (r.width / 2), ny = (p.y - r.midY) / (r.height / 2)
                let d = sqrt(nx * nx + ny * ny)
                return abs(d - 1) * min(r.width, r.height) / 2 <= w
            }
            return r.insetBy(dx: -w, dy: -w).contains(p) && !r.insetBy(dx: w, dy: w).contains(p)
        case .blur, .erase, .spotlight:
            return a.rect.insetBy(dx: -t, dy: -t).contains(p)
        case .text, .counter, .magnifier:
            return bounds(of: a).insetBy(dx: -t / 2, dy: -t / 2).contains(p)
        case .freehand, .highlight:
            let pts = a.path ?? [a.p1, a.p2]
            let w = (a.kind == .highlight ? Metrics.highlightWidth(a.size) : Metrics.stroke(a.size)) / 2 + t
            if pts.count == 1 { return p.distance(to: pts[0]) <= w }
            for i in 1..<pts.count where p.distance(toSegment: pts[i - 1], pts[i]) <= w { return true }
            return false
        }
    }

    // MARK: Helpers

    static func setShadow(_ cg: CGContext, _ rc: RenderContext, strong: Bool = false) {
        let s = rc.shadowScale
        cg.setShadow(offset: CGSize(width: 0, height: -1 * s), blur: (strong ? 6 : 3) * s,
                     color: NSColor.black.withAlphaComponent(strong ? 0.45 : 0.32).cgColor)
    }

    /// Draws a CGImage upright into a rect of a flipped context.
    static func drawImage(_ img: CGImage, in r: CGRect, cg: CGContext) {
        cg.saveGState()
        cg.translateBy(x: r.minX, y: r.maxY)
        cg.scaleBy(x: 1, y: -1)
        cg.draw(img, in: CGRect(origin: .zero, size: r.size))
        cg.restoreGState()
    }

    /// Runs AppKit text drawing on `cg` (which must be flipped).
    static func withNSContext(_ cg: CGContext, _ body: () -> Void) {
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: true)
        body()
        NSGraphicsContext.restoreGraphicsState()
    }

    // MARK: Flatten

    /// Renders the document into a bitmap. `region` (image points) defaults to
    /// the crop; `outputScale` defaults to the capture scale (pixels per point).
    static func flatten(_ doc: ShotDocument, image: CGImage, effects: EffectCache,
                        region: CGRect? = nil, outputScale: CGFloat? = nil) -> CGImage? {
        let area = (region ?? doc.canvasRect).intersection(doc.imageBounds)
        guard !area.isNull, area.width > 0, area.height > 0 else { return nil }
        let scale = outputScale ?? doc.scale
        let pixelArea = CGRect(x: area.minX * doc.scale, y: area.minY * doc.scale,
                               width: area.width * doc.scale, height: area.height * doc.scale).integral
        if doc.annotations.isEmpty && scale == doc.scale {
            if pixelArea == CGRect(x: 0, y: 0, width: image.width, height: image.height) { return image }
            return image.cropping(to: pixelArea)
        }
        let w = max(1, Int((area.width * scale).rounded()))
        let h = max(1, Int((area.height * scale).rounded()))
        let space = outputColorSpace(image)
        guard let cg = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                                 bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        cg.interpolationQuality = .high
        cg.translateBy(x: 0, y: CGFloat(h))
        cg.scaleBy(x: CGFloat(w) / area.width, y: -CGFloat(h) / area.height)
        cg.translateBy(x: -area.minX, y: -area.minY)
        drawImage(image, in: doc.imageBounds, cg: cg)
        let rc = RenderContext(image: image, scale: doc.scale, canvas: area, effects: effects, shadowScale: scale)
        drawAll(doc.annotations, rc: rc, cg: cg)
        return cg.makeImage()
    }

    static func outputColorSpace(_ image: CGImage) -> CGColorSpace {
        if let cs = image.colorSpace, cs.model == .rgb, cs.supportsOutput { return cs }
        return CGColorSpace(name: CGColorSpace.sRGB)!
    }
}

// MARK: - Obfuscation patches

/// Caches the rendered blur / pixelate / erase patches per annotation (they are
/// computed from the original pixels at full resolution, so the same patch
/// serves the screen and the flattened output). Owned by one editor.
final class EffectCache {
    private var cache: [UUID: (key: String, image: CGImage, rect: CGRect)] = [:]
    private static var ciContext: CIContext?

    func removeAll() { cache.removeAll() }

    func patch(for a: Annotation, image: CGImage, scale: CGFloat) -> (CGImage, CGRect)? {
        let r = a.rect
        let pixel = CGRect(x: r.minX * scale, y: r.minY * scale, width: r.width * scale, height: r.height * scale)
            .integral.intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard !pixel.isNull, pixel.width >= 1, pixel.height >= 1 else { return nil }
        let key = "\(a.kind.rawValue)|\(a.style)|\(a.size)|\(pixel)"
        if let hit = cache[a.id], hit.key == key { return (hit.image, hit.rect) }
        let made: CGImage?
        switch (a.kind, a.style) {
        case (.erase, _): made = Effects.backfill(image, pixelRect: pixel)
        case (.blur, 1): made = Effects.pixelate(image, pixelRect: pixel, block: Metrics.pixelBlock(a.size) * scale)
        default: made = Effects.blur(image, pixelRect: pixel, sigma: Metrics.blurRadius(a.size) * scale, context: EffectCache.sharedCI())
        }
        guard let made else { return nil }
        let rect = CGRect(x: pixel.minX / scale, y: pixel.minY / scale, width: pixel.width / scale, height: pixel.height / scale)
        cache[a.id] = (key, made, rect)
        return (made, rect)
    }

    /// Drops the Core Image context once no editor needs it.
    static func releaseShared() { ciContext = nil }

    static func sharedCI() -> CIContext {
        if let c = ciContext { return c }
        let c = CIContext(options: [.cacheIntermediates: false])
        ciContext = c
        return c
    }
}

enum Effects {
    static func blur(_ image: CGImage, pixelRect r: CGRect, sigma: CGFloat, context: CIContext) -> CGImage? {
        // Core Image uses a bottom-left origin.
        let ciRect = CGRect(x: r.minX, y: CGFloat(image.height) - r.maxY, width: r.width, height: r.height)
        let src = CIImage(cgImage: image).cropped(to: ciRect).clampedToExtent()
        let out = src.applyingGaussianBlur(sigma: Double(sigma)).cropped(to: ciRect)
        return context.createCGImage(out, from: ciRect, format: .RGBA8, colorSpace: Renderer.outputColorSpace(image))
    }

    static func pixelate(_ image: CGImage, pixelRect r: CGRect, block: CGFloat) -> CGImage? {
        guard let crop = image.cropping(to: r) else { return nil }
        let w = Int(r.width), h = Int(r.height)
        let b = max(2, block)
        let sw = max(1, Int(ceil(CGFloat(w) / b))), sh = max(1, Int(ceil(CGFloat(h) / b)))
        let space = Renderer.outputColorSpace(image)
        let info = CGImageAlphaInfo.premultipliedLast.rawValue
        guard let small = CGContext(data: nil, width: sw, height: sh, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: info),
              let big = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: info)
        else { return nil }
        small.interpolationQuality = .high
        small.draw(crop, in: CGRect(x: 0, y: 0, width: sw, height: sh))
        guard let smallImage = small.makeImage() else { return nil }
        big.interpolationQuality = .none
        // Blocks anchored at the top-left like the source.
        big.draw(smallImage, in: CGRect(x: 0, y: CGFloat(h) - CGFloat(sh) * b, width: CGFloat(sw) * b, height: CGFloat(sh) * b))
        return big.makeImage()
    }

    /// "Smart erase": fills the rect from its surroundings with a Coons-patch
    /// interpolation of the four (lightly smoothed) border lines. Flat and
    /// gradient backgrounds come out seamless, so text and icons disappear.
    static func backfill(_ image: CGImage, pixelRect r: CGRect) -> CGImage? {
        let bounds = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        let e = r.insetBy(dx: -1, dy: -1).intersection(bounds)
        guard let buf = PixelBuffer(image: image, rect: e) else { return nil }
        let x0 = Int(r.minX), y0 = Int(r.minY), w = Int(r.width), h = Int(r.height)
        let lx = max(x0 - 1, Int(e.minX)), rx = min(x0 + w, Int(e.maxX) - 1)
        let ty = max(y0 - 1, Int(e.minY)), by = min(y0 + h, Int(e.maxY) - 1)
        var top = (0..<w).map { buf.pixel(x0 + $0, ty) }, bottom = (0..<w).map { buf.pixel(x0 + $0, by) }
        var left = (0..<h).map { buf.pixel(lx, y0 + $0) }, right = (0..<h).map { buf.pixel(rx, y0 + $0) }
        var corners = (buf.pixel(lx, ty), buf.pixel(rx, ty), buf.pixel(lx, by), buf.pixel(rx, by))
        // Glyphs or icons cut by the selection edge would streak across the
        // fill; replace border samples that are not background-coloured.
        if let bg = dominantColor(top + bottom + left + right) {
            top = cleanBorder(top, background: bg); bottom = cleanBorder(bottom, background: bg)
            left = cleanBorder(left, background: bg); right = cleanBorder(right, background: bg)
            func fix(_ c: RGBA, _ near: RGBA) -> RGBA { isNear(c, bg) ? c : near }
            corners = (fix(corners.0, top.first ?? bg), fix(corners.1, top.last ?? bg), fix(corners.2, bottom.first ?? bg), fix(corners.3, bottom.last ?? bg))
        }
        let out = backfillPixels(width: w, height: h, top: smooth(top), bottom: smooth(bottom), left: smooth(left), right: smooth(right),
                                 corners: corners, insetX: x0 - lx, insetY: y0 - ty, outsideX: rx - (x0 + w - 1), outsideY: by - (y0 + h - 1))
        return PixelBuffer.makeImage(out, width: w, height: h, space: buf.space)
    }

    typealias RGBA = SIMD4<Float>

    /// Pure Coons-patch fill (unit-tested). Border arrays run along the rect;
    /// `inset*`/`outside*` say how far the sampled lines sit outside the rect.
    static func backfillPixels(width w: Int, height h: Int, top: [RGBA], bottom: [RGBA], left: [RGBA], right: [RGBA],
                               corners: (RGBA, RGBA, RGBA, RGBA), insetX: Int = 1, insetY: Int = 1,
                               outsideX: Int = 1, outsideY: Int = 1) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: w * h * 4)
        let spanX = Float(w - 1 + insetX + outsideX), spanY = Float(h - 1 + insetY + outsideY)
        let (p00, p10, p01, p11) = corners
        for y in 0..<h {
            let v = spanY > 0 ? Float(y + insetY) / spanY : 0.5
            let l = left[y], rr = right[y]
            for x in 0..<w {
                let u = spanX > 0 ? Float(x + insetX) / spanX : 0.5
                let a = (1 - v) * top[x] + v * bottom[x]
                let b = (1 - u) * l + u * rr
                let c = (1 - u) * (1 - v) * p00 + u * (1 - v) * p10 + (1 - u) * v * p01 + u * v * p11
                let p = (a + b - c).clamped(lowerBound: RGBA(repeating: 0), upperBound: RGBA(repeating: 255))
                let i = (y * w + x) * 4
                out[i] = UInt8(p.x.rounded()); out[i + 1] = UInt8(p.y.rounded())
                out[i + 2] = UInt8(p.z.rounded()); out[i + 3] = UInt8(p.w.rounded())
            }
        }
        return out
    }

    static let backgroundTolerance: Float = 28

    static func isNear(_ a: RGBA, _ b: RGBA) -> Bool {
        let d = a - b
        return max(abs(d.x), max(abs(d.y), abs(d.z))) <= backgroundTolerance
    }

    /// Most common colour (coarsely bucketed) when it covers at least 40% of
    /// the samples; nil for busy backgrounds (photos), where cleaning would hurt.
    static func dominantColor(_ samples: [RGBA]) -> RGBA? {
        guard !samples.isEmpty else { return nil }
        var buckets: [Int: (count: Int, sum: RGBA)] = [:]
        for c in samples {
            let key = (Int(c.x) >> 4) << 8 | (Int(c.y) >> 4) << 4 | (Int(c.z) >> 4)
            let e = buckets[key] ?? (0, RGBA(repeating: 0))
            buckets[key] = (e.count + 1, e.sum + c)
        }
        guard let best = buckets.values.max(by: { $0.count < $1.count }),
              Float(samples.filter { isNear($0, best.sum / Float(best.count)) }.count) >= Float(samples.count) * 0.4 else { return nil }
        return best.sum / Float(best.count)
    }

    /// Replaces runs of non-background samples by interpolating between the
    /// background samples around them.
    static func cleanBorder(_ a: [RGBA], background bg: RGBA) -> [RGBA] {
        var out = a
        var i = 0
        while i < a.count {
            guard !isNear(a[i], bg) else { i += 1; continue }
            var j = i
            while j < a.count, !isNear(a[j], bg) { j += 1 }
            let l = i > 0 ? a[i - 1] : (j < a.count ? a[j] : bg)
            let r = j < a.count ? a[j] : l
            for k in i..<j {
                let t = Float(k - i + 1) / Float(j - i + 1)
                out[k] = l * (1 - t) + r * t
            }
            i = j
        }
        return out
    }

    /// 5-tap smoothing so a single stray border pixel doesn't streak across the fill.
    static func smooth(_ a: [RGBA]) -> [RGBA] {
        guard a.count > 4 else { return a }
        let k: [Float] = [1, 2, 3, 2, 1]
        return (0..<a.count).map { i in
            var sum = RGBA(repeating: 0); var wsum: Float = 0
            for (j, kw) in k.enumerated() {
                let idx = i + j - 2
                guard idx >= 0, idx < a.count else { continue }
                sum += a[idx] * kw; wsum += kw
            }
            return sum / wsum
        }
    }
}

/// RGBA8 copy of part of an image, for pixel-level reads.
struct PixelBuffer {
    let data: [UInt8]
    let rect: CGRect
    let width: Int
    let height: Int
    let space: CGColorSpace

    init?(image: CGImage, rect: CGRect, space: CGColorSpace? = nil) {
        guard let crop = image.cropping(to: rect) else { return nil }
        let w = crop.width, h = crop.height
        let cs = space ?? Renderer.outputColorSpace(image)
        var bytes = [UInt8](repeating: 0, count: w * h * 4)
        let ok = bytes.withUnsafeMutableBytes { ptr -> Bool in
            guard let ctx = CGContext(data: ptr.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                      space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            ctx.interpolationQuality = .none
            ctx.draw(crop, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard ok else { return nil }
        self.data = bytes
        self.rect = CGRect(x: rect.minX, y: rect.minY, width: CGFloat(w), height: CGFloat(h))
        self.width = w
        self.height = h
        self.space = cs
    }

    /// Pixel at absolute image coordinates (top-left origin), clamped to the buffer.
    func pixel(_ x: Int, _ y: Int) -> Effects.RGBA {
        let i = rgba(x, y)
        return Effects.RGBA(Float(i.0), Float(i.1), Float(i.2), Float(i.3))
    }

    func rgba(_ x: Int, _ y: Int) -> (UInt8, UInt8, UInt8, UInt8) {
        let cx = (x - Int(rect.minX)).clamped(0...(width - 1))
        let cy = (y - Int(rect.minY)).clamped(0...(height - 1))
        let i = (cy * width + cx) * 4
        return (data[i], data[i + 1], data[i + 2], data[i + 3])
    }

    static func makeImage(_ bytes: [UInt8], width: Int, height: Int, space: CGColorSpace) -> CGImage? {
        guard let provider = CGDataProvider(data: Data(bytes) as CFData) else { return nil }
        return CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4, space: space,
                       bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue), provider: provider,
                       decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    }
}
