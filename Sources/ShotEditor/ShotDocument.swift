import AppKit

// The editable document behind a capture: the original pixels live next to it
// as a PNG; this JSON holds everything the user added on top (annotations,
// non-destructive crop), so a capture can be reopened and re-edited later.
//
// Coordinates are image points (pixels / scale), top-left origin, relative to
// the full (uncropped) image.

struct Annotation: Codable, Equatable, Identifiable {
    enum Kind: String, Codable, CaseIterable {
        case arrow, line, rect, oval, text, highlight, freehand, blur, erase, counter, spotlight, magnifier, ruler
    }

    var id = UUID()
    var kind: Kind
    /// Start / end for two-point kinds; corners for box kinds; origin for text
    /// and centre for counters; centre + rim point for the magnifier.
    var p1: CGPoint
    var p2: CGPoint
    /// Points of freehand / highlighter strokes.
    var path: [CGPoint]?
    /// `#RRGGBB` or `#RRGGBBAA` (sRGB).
    var color: String
    /// Size level 1...10, interpreted per kind (stroke width, font size, ...).
    var size: Double
    /// Per-kind variant (see `Annotation.styles`).
    var style: Int = 0
    var text: String?
    var number: Int?
    /// Spotlight background darkness 0...1.
    var dim: Double?

    init(kind: Kind, p1: CGPoint, p2: CGPoint, color: String, size: Double, style: Int = 0) {
        self.kind = kind
        self.p1 = p1
        self.p2 = p2
        self.color = color
        self.size = size
        self.style = style
    }

    /// Box spanned by p1/p2.
    var rect: CGRect { CGRect(p1: p1, p2: p2) }

    var isBoxKind: Bool {
        switch kind {
        case .rect, .oval, .blur, .erase, .spotlight: return true
        default: return false
        }
    }

    var isTwoPointKind: Bool { kind == .arrow || kind == .line || kind == .ruler }

    /// Moves the whole annotation.
    mutating func offset(by d: CGVector) {
        p1 = CGPoint(x: p1.x + d.dx, y: p1.y + d.dy)
        p2 = CGPoint(x: p2.x + d.dx, y: p2.y + d.dy)
        path = path?.map { CGPoint(x: $0.x + d.dx, y: $0.y + d.dy) }
    }

    /// Drops or repairs values a damaged or hand-edited document could hold
    /// (NaN / huge coordinates, empty stroke paths, out-of-range sizes), so the
    /// drawing and hit-testing code never sees them. Nil = unusable.
    func sanitized() -> Annotation? {
        let limit: CGFloat = 1_000_000
        func ok(_ p: CGPoint) -> Bool { p.x.isFinite && p.y.isFinite && abs(p.x) < limit && abs(p.y) < limit }
        guard ok(p1), ok(p2) else { return nil }
        // An empty label autosaved mid-typing (the editor deletes these when editing ends).
        if kind == .text, (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return nil }
        var a = self
        if let path {
            let good = path.filter(ok)
            a.path = good.isEmpty ? [p1] : good
        }
        a.size = size.isFinite ? size.clamped(1...10) : 4
        a.style = style.clamped(0...7)
        a.number = number?.clamped(-9_999...99_999)
        a.dim = dim.flatMap { $0.isFinite ? $0.clamped(0...1) : nil }
        return a
    }

    /// Variant names per kind, shown in the style control and cycled by
    /// pressing the tool key again.
    static func styles(for kind: Kind) -> [(name: String, symbol: String)] {
        switch kind {
        case .arrow: return [("Tapered", "arrow.up.right"), ("Line", "arrow.right"), ("Double", "arrow.left.and.right")]
        case .line: return [("Solid", "line.diagonal"), ("Dashed", "line.3.horizontal.decrease")]
        case .rect: return [("Outline", "rectangle"), ("Translucent", "rectangle.inset.filled"), ("Filled", "rectangle.fill")]
        case .oval: return [("Outline", "circle"), ("Translucent", "circle.inset.filled"), ("Filled", "circle.fill")]
        case .text: return [("Label", "character.textbox"), ("Plain", "textformat")]
        case .blur: return [("Blur", "drop"), ("Pixelate", "square.grid.3x3")]
        case .spotlight: return [("Rectangle", "rectangle"), ("Oval", "oval")]
        case .highlight: return [("Round ends", "capsule.fill"), ("Square ends", "rectangle.fill")]
        default: return []
        }
    }
}

struct ShotDocument: Codable, Equatable {
    var version = 1
    var id: String
    var created: Date
    var modified: Date
    var kind: String
    /// Pixels per point.
    var scale: CGFloat
    var pixelWidth: Int
    var pixelHeight: Int
    var sourceAppName: String?
    var sourceBundleID: String?
    /// Capture rect in global AX coordinates (used to place pins), `.zero` if unknown.
    var captureRect: CGRect = .zero
    /// Non-destructive crop in image points; nil = whole image.
    var crop: CGRect?
    var annotations: [Annotation] = []

    /// Full image size in points.
    var pointSize: CGSize { CGSize(width: CGFloat(pixelWidth) / scale, height: CGFloat(pixelHeight) / scale) }
    var imageBounds: CGRect { CGRect(origin: .zero, size: pointSize) }
    /// The visible canvas (crop or whole image) in image points.
    var canvasRect: CGRect {
        let r = (crop ?? imageBounds).intersection(imageBounds)
        // A crop outside the image (damaged document) shows the whole image.
        return r.isNull || r.width <= 0 || r.height <= 0 ? imageBounds : r.integralIfNeeded
    }

    /// Repairs a document read from disk: pixel size from the actual image
    /// when known, a sane scale, a crop inside the image, usable annotations.
    func sanitized(imageWidth: Int? = nil, imageHeight: Int? = nil) -> ShotDocument {
        var d = self
        if let imageWidth, let imageHeight, imageWidth > 0, imageHeight > 0 {
            d.pixelWidth = imageWidth
            d.pixelHeight = imageHeight
        }
        d.pixelWidth = max(1, d.pixelWidth)
        d.pixelHeight = max(1, d.pixelHeight)
        if !(d.scale.isFinite && d.scale >= 0.5 && d.scale <= 8) { d.scale = 1 }
        let finite = [d.captureRect.minX, d.captureRect.minY, d.captureRect.width, d.captureRect.height].allSatisfy(\.isFinite)
        if !finite { d.captureRect = .zero }
        if let c = d.crop {
            let values = [c.minX, c.minY, c.width, c.height]
            let inside = c.intersection(d.imageBounds)
            if !values.allSatisfy(\.isFinite) || inside.isNull || inside.width < 0.5 || inside.height < 0.5 { d.crop = nil }
        }
        d.annotations = d.annotations.compactMap { $0.sanitized() }
        return d
    }
    var isEdited: Bool { crop != nil || !annotations.isEmpty }

    /// Next number for a step counter.
    var nextCounterNumber: Int { (annotations.compactMap { $0.kind == .counter ? $0.number : nil }.max() ?? 0) + 1 }

    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    func encoded() throws -> Data { try ShotDocument.encoder.encode(self) }
    static func decode(_ data: Data) throws -> ShotDocument { try decoder.decode(ShotDocument.self, from: data) }
}

// MARK: - Geometry helpers

extension CGRect {
    init(p1: CGPoint, p2: CGPoint) {
        self.init(x: min(p1.x, p2.x), y: min(p1.y, p2.y), width: abs(p2.x - p1.x), height: abs(p2.y - p1.y))
    }

    var center: CGPoint { CGPoint(x: midX, y: midY) }

    /// Snaps to whole points only when the values are already within a hair
    /// (avoids drifting crops through float error, keeps sub-point crops intact).
    var integralIfNeeded: CGRect {
        func r(_ v: CGFloat) -> CGFloat { abs(v - v.rounded()) < 0.001 ? v.rounded() : v }
        return CGRect(x: r(minX), y: r(minY), width: r(width), height: r(height))
    }

    /// The 8 resize handles: corners then edge midpoints (tl, tr, br, bl, t, r, b, l).
    var handlePoints: [CGPoint] {
        [CGPoint(x: minX, y: minY), CGPoint(x: maxX, y: minY), CGPoint(x: maxX, y: maxY), CGPoint(x: minX, y: maxY),
         CGPoint(x: midX, y: minY), CGPoint(x: maxX, y: midY), CGPoint(x: midX, y: maxY), CGPoint(x: minX, y: midY)]
    }

    /// Resizes by dragging handle `index` (see `handlePoints`) to `p`.
    func resized(handle index: Int, to p: CGPoint) -> CGRect {
        var x0 = minX, y0 = minY, x1 = maxX, y1 = maxY
        switch index {
        case 0: x0 = p.x; y0 = p.y
        case 1: x1 = p.x; y0 = p.y
        case 2: x1 = p.x; y1 = p.y
        case 3: x0 = p.x; y1 = p.y
        case 4: y0 = p.y
        case 5: x1 = p.x
        case 6: y1 = p.y
        case 7: x0 = p.x
        default: break
        }
        return CGRect(p1: CGPoint(x: x0, y: y0), p2: CGPoint(x: x1, y: y1))
    }
}

extension CGPoint {
    func distance(to p: CGPoint) -> CGFloat { hypot(p.x - x, p.y - y) }

    /// Distance from this point to the segment a-b.
    func distance(toSegment a: CGPoint, _ b: CGPoint) -> CGFloat {
        let dx = b.x - a.x, dy = b.y - a.y
        let len2 = dx * dx + dy * dy
        guard len2 > 0 else { return distance(to: a) }
        let t = (((x - a.x) * dx + (y - a.y) * dy) / len2).clamped(0...1)
        return distance(to: CGPoint(x: a.x + t * dx, y: a.y + t * dy))
    }

    /// Constrains `self` (relative to `origin`) to multiples of 45 degrees.
    func snapped45(from origin: CGPoint) -> CGPoint {
        let dx = x - origin.x, dy = y - origin.y
        let len = hypot(dx, dy)
        guard len > 0 else { return self }
        let angle = (atan2(dy, dx) / (.pi / 4)).rounded() * (.pi / 4)
        return CGPoint(x: origin.x + cos(angle) * len, y: origin.y + sin(angle) * len)
    }

    /// Constrains to a square box relative to `origin`.
    func squared(from origin: CGPoint) -> CGPoint {
        let dx = x - origin.x, dy = y - origin.y
        let s = max(abs(dx), abs(dy))
        return CGPoint(x: origin.x + (dx < 0 ? -s : s), y: origin.y + (dy < 0 ? -s : s))
    }
}

// MARK: - Colours

enum HexColor {
    static let palette: [(name: String, hex: String)] = [
        ("Red", "#FF3B30"), ("Orange", "#FF9500"), ("Yellow", "#FFDC2C"), ("Green", "#34C759"),
        ("Blue", "#0A84FF"), ("Purple", "#AF52DE"), ("Pink", "#FF2D78"), ("Black", "#1C1C1E"), ("White", "#FFFFFF"),
    ]

    /// Parses `#RGB`, `#RRGGBB` or `#RRGGBBAA` into sRGB components.
    static func components(_ hex: String) -> (r: CGFloat, g: CGFloat, b: CGFloat, a: CGFloat)? {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        guard s.count == 6 || s.count == 8, let v = UInt64(s, radix: 16) else { return nil }
        if s.count == 6 {
            return (CGFloat((v >> 16) & 0xFF) / 255, CGFloat((v >> 8) & 0xFF) / 255, CGFloat(v & 0xFF) / 255, 1)
        }
        return (CGFloat((v >> 24) & 0xFF) / 255, CGFloat((v >> 16) & 0xFF) / 255, CGFloat((v >> 8) & 0xFF) / 255, CGFloat(v & 0xFF) / 255)
    }

    static func color(_ hex: String) -> NSColor {
        guard let c = components(hex) else { return .systemRed }
        return NSColor(srgbRed: c.r, green: c.g, blue: c.b, alpha: c.a)
    }

    static func hex(_ color: NSColor, alpha: Bool = false) -> String {
        let c = color.usingColorSpace(.sRGB) ?? color
        func b(_ v: CGFloat) -> Int { Int((v.clamped(0...1) * 255).rounded()) }
        let base = String(format: "#%02X%02X%02X", b(c.redComponent), b(c.greenComponent), b(c.blueComponent))
        return alpha && c.alphaComponent < 1 ? base + String(format: "%02X", b(c.alphaComponent)) : base
    }

    static func hex(r: UInt8, g: UInt8, b: UInt8) -> String { String(format: "#%02X%02X%02X", r, g, b) }

    /// Relative luminance (sRGB, approximate) used to pick black or white text.
    static func luminance(_ hex: String) -> CGFloat {
        guard let c = components(hex) else { return 0 }
        return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b
    }

    static func contrasting(_ hex: String) -> NSColor {
        luminance(hex) > 0.62 ? NSColor(white: 0.08, alpha: 1) : .white
    }
}
