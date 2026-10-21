import AppKit

/// Reads single pixels, rows and columns of the base image on demand (tiny
/// sRGB bitmaps per query, no full-size copy), for the colour picker and the
/// Shottr-style edge-to-edge measurement.
final class PixelSampler {
    let image: CGImage
    let scale: CGFloat
    private let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
    private var rowCache: (Int, [UInt32])?
    private var colCache: (Int, [UInt32])?

    init(image: CGImage, scale: CGFloat) {
        self.image = image
        self.scale = scale
    }

    var pixelSize: (w: Int, h: Int) { (image.width, image.height) }

    func pixelPoint(_ p: CGPoint) -> (x: Int, y: Int)? {
        let fx = floor(p.x * scale), fy = floor(p.y * scale)
        guard fx.isFinite, fy.isFinite, fx >= 0, fy >= 0, fx < CGFloat(image.width), fy < CGFloat(image.height) else { return nil }
        let x = Int(fx), y = Int(fy)
        guard x >= 0, y >= 0, x < image.width, y < image.height else { return nil }
        return (x, y)
    }

    /// sRGB colour of the pixel under an image point.
    func color(at p: CGPoint) -> (r: UInt8, g: UInt8, b: UInt8)? {
        guard let (x, y) = pixelPoint(p), let px = read(CGRect(x: x, y: y, width: 1, height: 1)).first else { return nil }
        return PixelSampler.unpack(px)
    }

    /// Darkest pixel in a square around `p` (Shottr's ⇧Tab "text colour").
    func darkest(around p: CGPoint, radiusPoints: CGFloat = 10) -> (r: UInt8, g: UInt8, b: UInt8)? {
        let r = CGRect(x: (p.x - radiusPoints) * scale, y: (p.y - radiusPoints) * scale,
                       width: radiusPoints * 2 * scale, height: radiusPoints * 2 * scale)
            .integral.intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard !r.isNull else { return nil }
        let px = read(r)
        guard let best = px.min(by: { PixelSampler.luma($0) < PixelSampler.luma($1) }) else { return nil }
        return PixelSampler.unpack(best)
    }

    /// Average sRGB colour of an area (image points). Large areas are
    /// downsampled first (area-averaging), so this stays cheap on big captures.
    func averageColor(in r: CGRect) -> (r: UInt8, g: UInt8, b: UInt8)? {
        let area = CGRect(x: r.minX * scale, y: r.minY * scale, width: r.width * scale, height: r.height * scale)
            .integral.intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard !area.isNull, area.width >= 1, area.height >= 1, let crop = image.cropping(to: area) else { return nil }
        let f = min(1, 128 / max(area.width, area.height))
        let w = max(1, Int((area.width * f).rounded())), h = max(1, Int((area.height * f).rounded()))
        var px = [UInt32](repeating: 0, count: w * h)
        let drawn = px.withUnsafeMutableBytes { ptr -> Bool in
            guard let ctx = CGContext(data: ptr.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                      space: srgb, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return false }
            ctx.interpolationQuality = .medium
            ctx.draw(crop, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard drawn else { return nil }
        return PixelSampler.average(px)
    }

    func row(_ y: Int) -> [UInt32] {
        if let (cy, data) = rowCache, cy == y { return data }
        let data = read(CGRect(x: 0, y: y, width: image.width, height: 1))
        rowCache = (y, data)
        return data
    }

    func column(_ x: Int) -> [UInt32] {
        if let (cx, data) = colCache, cx == x { return data }
        let data = read(CGRect(x: x, y: 0, width: 1, height: image.height))
        colCache = (x, data)
        return data
    }

    /// The uniform-colour span through `p` along one axis, as a segment in
    /// image points from edge to edge (Shottr's arrow-key measurement).
    func measure(at p: CGPoint, vertical: Bool, tolerance: Int = 24) -> (CGPoint, CGPoint)? {
        guard let (x, y) = pixelPoint(p) else { return nil }
        let line = vertical ? column(x) : row(y)
        let (lo, hi) = PixelSampler.span(in: line, at: vertical ? y : x, tolerance: tolerance)
        let a = CGFloat(lo) / scale, b = CGFloat(hi + 1) / scale
        let fixed = (CGFloat(vertical ? x : y) + 0.5) / scale
        return vertical ? (CGPoint(x: fixed, y: a), CGPoint(x: fixed, y: b)) : (CGPoint(x: a, y: fixed), CGPoint(x: b, y: fixed))
    }

    /// Bounding box (image points) of the uniform-colour area under `p`
    /// (Shottr: ⌘-click a monotone object to select it). Limited to `within`.
    func monotoneRegion(at p: CGPoint, within: CGRect, tolerance: Int = 12) -> CGRect? {
        let area = CGRect(x: within.minX * scale, y: within.minY * scale, width: within.width * scale, height: within.height * scale)
            .integral.intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard !area.isNull, let (px, py) = pixelPoint(p) else { return nil }
        let w = Int(area.width), h = Int(area.height)
        let sx = px - Int(area.minX), sy = py - Int(area.minY)
        guard sx >= 0, sy >= 0, sx < w, sy < h else { return nil }
        let pixels = read(area)
        guard pixels.count == w * h,
              let b = PixelSampler.floodBounds(pixels, width: w, height: h, start: (sx, sy), tolerance: tolerance) else { return nil }
        return CGRect(x: (area.minX + CGFloat(b.minX)) / scale, y: (area.minY + CGFloat(b.minY)) / scale,
                      width: CGFloat(b.maxX - b.minX + 1) / scale, height: CGFloat(b.maxY - b.minY + 1) / scale)
    }

    /// Shrinks `r` (image points) to the content that differs from its
    /// background colour (Shottr: select an area, press A to auto-adjust).
    func contentBounds(in r: CGRect, tolerance: Int = 16) -> CGRect? {
        let area = CGRect(x: r.minX * scale, y: r.minY * scale, width: r.width * scale, height: r.height * scale)
            .integral.intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard !area.isNull, area.width >= 1, area.height >= 1 else { return nil }
        let w = Int(area.width), h = Int(area.height)
        let pixels = read(area)
        guard pixels.count == w * h, let b = PixelSampler.contentBounds(pixels, width: w, height: h, tolerance: tolerance) else { return nil }
        return CGRect(x: (area.minX + CGFloat(b.minX)) / scale, y: (area.minY + CGFloat(b.minY)) / scale,
                      width: CGFloat(b.maxX - b.minX + 1) / scale, height: CGFloat(b.maxY - b.minY + 1) / scale)
    }

    // MARK: Pure helpers (unit-tested)

    typealias PixelBox = (minX: Int, minY: Int, maxX: Int, maxY: Int)

    /// Bounding box of the 4-connected area of colours similar to the start pixel.
    static func floodBounds(_ px: [UInt32], width w: Int, height h: Int, start: (Int, Int), tolerance: Int) -> PixelBox? {
        guard start.0 >= 0, start.1 >= 0, start.0 < w, start.1 < h, px.count == w * h else { return nil }
        let ref = px[start.1 * w + start.0]
        var seen = [Bool](repeating: false, count: w * h)
        var box: PixelBox = (start.0, start.1, start.0, start.1)
        var stack = [(start.0, start.1)]
        while let (x0, y) = stack.popLast() {
            var x = x0
            // Scanline fill: walk left, then sweep right marking and queueing rows above/below.
            while x > 0, !seen[y * w + x - 1], similar(px[y * w + x - 1], ref, tolerance) { x -= 1 }
            var upOpen = false, downOpen = false
            while x < w, !seen[y * w + x], similar(px[y * w + x], ref, tolerance) {
                seen[y * w + x] = true
                box.minX = min(box.minX, x); box.maxX = max(box.maxX, x)
                box.minY = min(box.minY, y); box.maxY = max(box.maxY, y)
                if y > 0 {
                    let ok = !seen[(y - 1) * w + x] && similar(px[(y - 1) * w + x], ref, tolerance)
                    if ok && !upOpen { stack.append((x, y - 1)) }
                    upOpen = ok
                }
                if y < h - 1 {
                    let ok = !seen[(y + 1) * w + x] && similar(px[(y + 1) * w + x], ref, tolerance)
                    if ok && !downOpen { stack.append((x, y + 1)) }
                    downOpen = ok
                }
                x += 1
            }
        }
        return box
    }

    /// Bounding box of pixels differing from the background (taken as the
    /// most common of the four corner colours). Nil if everything is background.
    static func contentBounds(_ px: [UInt32], width w: Int, height h: Int, tolerance: Int) -> PixelBox? {
        guard w > 0, h > 0, px.count == w * h else { return nil }
        let corners = [px[0], px[w - 1], px[(h - 1) * w], px[h * w - 1]]
        let bg = corners.max { a, b in corners.filter { similar($0, a, tolerance) }.count < corners.filter { similar($0, b, tolerance) }.count }!
        var box: PixelBox?
        for y in 0..<h {
            for x in 0..<w where !similar(px[y * w + x], bg, tolerance) {
                if var b = box {
                    b.minX = min(b.minX, x); b.maxX = max(b.maxX, x); b.minY = min(b.minY, y); b.maxY = max(b.maxY, y)
                    box = b
                } else {
                    box = (x, y, x, y)
                }
            }
        }
        return box
    }


    /// Extent [lo, hi] of pixels around `index` whose colour stays within
    /// `tolerance` (max channel difference) of the pixel at `index`.
    static func span(in line: [UInt32], at index: Int, tolerance: Int) -> (Int, Int) {
        guard line.indices.contains(index) else { return (index, index) }
        let ref = line[index]
        var lo = index, hi = index
        while lo > 0, similar(line[lo - 1], ref, tolerance) { lo -= 1 }
        while hi < line.count - 1, similar(line[hi + 1], ref, tolerance) { hi += 1 }
        return (lo, hi)
    }

    static func average(_ px: [UInt32]) -> (r: UInt8, g: UInt8, b: UInt8)? {
        guard !px.isEmpty else { return nil }
        var r = 0, g = 0, b = 0
        for v in px {
            let c = unpack(v)
            r += Int(c.r); g += Int(c.g); b += Int(c.b)
        }
        let n = px.count
        return (UInt8((r + n / 2) / n), UInt8((g + n / 2) / n), UInt8((b + n / 2) / n))
    }

    static func similar(_ a: UInt32, _ b: UInt32, _ t: Int) -> Bool {
        let (ar, ag, ab) = unpack(a), (br, bg, bb) = unpack(b)
        return abs(Int(ar) - Int(br)) <= t && abs(Int(ag) - Int(bg)) <= t && abs(Int(ab) - Int(bb)) <= t
    }

    static func pack(_ r: UInt8, _ g: UInt8, _ b: UInt8) -> UInt32 { UInt32(r) | UInt32(g) << 8 | UInt32(b) << 16 | 0xFF00_0000 }
    static func unpack(_ v: UInt32) -> (r: UInt8, g: UInt8, b: UInt8) { (UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF), UInt8((v >> 16) & 0xFF)) }
    static func luma(_ v: UInt32) -> Int { let (r, g, b) = unpack(v); return Int(r) * 299 + Int(g) * 587 + Int(b) * 114 }

    // MARK: Reading

    /// Pixels as UInt32 words; memory order R, G, B, X so `v & 0xFF` is red (see `unpack`).
    func read(_ rect: CGRect) -> [UInt32] {
        guard let crop = image.cropping(to: rect) else { return [] }
        let w = crop.width, h = crop.height
        var out = [UInt32](repeating: 0, count: w * h)
        out.withUnsafeMutableBytes { ptr in
            guard let ctx = CGContext(data: ptr.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                      space: srgb, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return }
            ctx.interpolationQuality = .none
            ctx.draw(crop, in: CGRect(x: 0, y: 0, width: w, height: h))
        }
        return out
    }
}
