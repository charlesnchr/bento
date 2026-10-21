import CoreGraphics
import Foundation

/// A captured frame as packed 32-bit pixels (BGRA, premultiplied, little
/// endian — the native ScreenCaptureKit layout), row-major, top row first.
struct PixelFrame {
    let width: Int
    let height: Int
    var pixels: [UInt32]

    init(width: Int, height: Int, pixels: [UInt32]) {
        precondition(pixels.count == width * height)
        self.width = width
        self.height = height
        self.pixels = pixels
    }

    static let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    static let bitmapInfo = CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue

    /// Copies an image into a frame (converting to sRGB BGRA if needed).
    init?(_ image: CGImage) {
        let w = image.width, h = image.height
        guard w > 0, h > 0 else { return nil }
        var buf = [UInt32](repeating: 0, count: w * h)
        let ok = buf.withUnsafeMutableBytes { raw -> Bool in
            guard let ctx = CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                      space: PixelFrame.colorSpace, bitmapInfo: PixelFrame.bitmapInfo) else { return false }
            ctx.interpolationQuality = .none
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard ok else { return nil }
        self.init(width: w, height: h, pixels: buf)
    }

    func flippedVertically() -> PixelFrame {
        var out = [UInt32](repeating: 0, count: pixels.count)
        for y in 0..<height {
            let src = y * width, dst = (height - 1 - y) * width
            out[dst..<(dst + width)] = pixels[src..<(src + width)]
        }
        return PixelFrame(width: width, height: height, pixels: out)
    }

    /// Builds a CGImage from raw rows without copying them again.
    static func makeImage(width: Int, height: Int, fill: (UnsafeMutablePointer<UInt32>) -> Void) -> CGImage? {
        guard width > 0, height > 0 else { return nil }
        let count = width * height
        let ptr = UnsafeMutablePointer<UInt32>.allocate(capacity: count)
        fill(ptr)
        guard let provider = CGDataProvider(dataInfo: nil, data: ptr, size: count * 4, releaseData: { _, data, _ in
            data.assumingMemoryBound(to: UInt32.self).deallocate()
        }) else { ptr.deallocate(); return nil }
        return CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
                       space: colorSpace, bitmapInfo: CGBitmapInfo(rawValue: bitmapInfo), provider: provider,
                       decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    }

    func makeImage() -> CGImage? {
        PixelFrame.makeImage(width: width, height: height) { dst in
            pixels.withUnsafeBufferPointer { dst.update(from: $0.baseAddress!, count: pixels.count) }
        }
    }
}

/// Finds how far content moved between two consecutive frames of a
/// scrolling capture, by voting with per-row hashes.
///
/// - Rows that are identical at the same position at the top and bottom of
///   both frames are treated as static (sticky headers/footers, window chrome).
/// - Flat rows (one colour) are ignored: they match anything.
/// - Every remaining row of the new frame votes for the shifts at which an
///   identical row exists in the previous frame; the shift with most votes
///   wins if enough of the expected overlap agrees. A blinking caret, the
///   scroll bar or an animation only cost a few votes.
enum OverlapFinder {
    struct Signature: Equatable {
        var hashes: [UInt64]
        var flat: [Bool]
        var count: Int { hashes.count }
    }

    enum Match: Equatable {
        /// Frames are the same: nothing scrolled (end reached, or not rendered yet).
        case identical
        /// Content moved up by `shift` rows; `top`/`bottom` rows are static.
        case shift(Int, top: Int, bottom: Int)
        /// Content moved down (user scrolled back up).
        case backward(Int)
        /// No confident overlap (scrolled too far, or changing content).
        case none
    }

    /// Row hashes, ignoring `ignoreRight` columns on the right (overlay
    /// scroll bars move while scrolling). Low bits of each channel are masked
    /// so tiny rendering noise doesn't break matches.
    static func signature(_ f: PixelFrame, ignoreRight: Int = 0) -> Signature {
        let w = max(1, f.width - max(0, min(ignoreRight, f.width - 1)))
        var hashes = [UInt64](repeating: 0, count: f.height)
        var flat = [Bool](repeating: true, count: f.height)
        f.pixels.withUnsafeBufferPointer { px in
            for y in 0..<f.height {
                let base = px.baseAddress! + y * f.width
                let first = base[0] & 0xFCFC_FCFC
                var h: UInt64 = 0xcbf2_9ce4_8422_2325
                var isFlat = true
                for x in 0..<w {
                    let v = base[x] & 0xFCFC_FCFC
                    if v != first { isFlat = false }
                    h = (h ^ UInt64(v)) &* 0x0000_0100_0000_01B3
                }
                hashes[y] = h
                flat[y] = isFlat
            }
        }
        return Signature(hashes: hashes, flat: flat)
    }

    static func match(_ a: Signature, _ b: Signature, expected: Int? = nil, minRatio: Double = 0.5) -> Match {
        let h = a.count
        guard h == b.count, h > 0 else { return .none }
        if a.hashes == b.hashes { return .identical }

        // Static rows at the top and bottom (sticky headers, window chrome).
        var top = 0
        while top < h / 2 && a.hashes[top] == b.hashes[top] { top += 1 }
        var bottom = 0
        while bottom < h / 2 && top + bottom < h - 1 && a.hashes[h - 1 - bottom] == b.hashes[h - 1 - bottom] { bottom += 1 }
        let lo = top, hi = h - bottom
        guard hi - lo >= 4 else { return .none }

        var index: [UInt64: [Int]] = [:]
        for j in lo..<hi where !a.flat[j] { index[a.hashes[j], default: []].append(j) }

        // votes[d + h] for shift d in -(h-1)...(h-1)
        var votes = [Int](repeating: 0, count: 2 * h)
        for i in lo..<hi where !b.flat[i] {
            guard let js = index[b.hashes[i]] else { continue }
            for j in js where j != i { votes[j - i + h] += 1 }
        }

        var best = 0, bestVotes = 0
        for k in 0..<(2 * h) where votes[k] > 0 {
            let d = k - h
            let v = votes[k]
            if v > bestVotes {
                best = d; bestVotes = v
            } else if v == bestVotes {
                let target = expected ?? 0
                if abs(d - target) < abs(best - target) { best = d }
            }
        }
        guard bestVotes > 0 else { return .none }

        // How many rows should have matched for this shift?
        var expectedRows = 0
        if best > 0 {
            for i in lo..<max(lo, hi - best) where !b.flat[i] && !a.flat[i + best] { expectedRows += 1 }
        } else {
            for i in (lo - best)..<hi where i >= lo && !b.flat[i] && !a.flat[i + best] { expectedRows += 1 }
        }
        guard expectedRows >= 3, Double(bestVotes) >= minRatio * Double(expectedRows) else { return .none }
        return best > 0 ? .shift(best, top: top, bottom: bottom) : .backward(-best)
    }
}

/// Accumulates frames of a scrolling capture into one tall image.
///
/// Only the rows that are new in each frame are kept, so memory is about
/// the final image size plus one frame. For upward scrolling the caller
/// feeds vertically flipped frames and asks for a flipped result.
final class ScrollStitcher {
    enum Result: Equatable { case appended(Int), unchanged, noMatch, backward, reachedMax }

    let width: Int
    let frameHeight: Int
    let maxHeight: Int
    let ignoreRight: Int
    private var reference: PixelFrame
    private var refSig: OverlapFinder.Signature
    private var strips: [[UInt32]] = []
    private var committedRows = 0
    /// Row of `reference` up to which content is committed (nil until the first shift).
    private var committedEnd: Int?
    private(set) var frameCount = 1

    init(first: PixelFrame, maxHeight: Int = 20000, ignoreRight: Int = 0) {
        width = first.width
        frameHeight = first.height
        self.maxHeight = max(maxHeight, first.height)
        self.ignoreRight = ignoreRight
        reference = first
        refSig = OverlapFinder.signature(first, ignoreRight: ignoreRight)
    }

    /// Pixel budget of a stitched image (~320 MB at 4 bytes per pixel). The
    /// user's maximum height is lowered for wide regions so a long capture
    /// can't exhaust memory (the image is also copied once when finished).
    static let pixelBudget = 80_000_000

    /// The maximum height (pixels) for frames of `width` pixels: the user's
    /// setting (at least 1000 px), capped by `pixelBudget`.
    static func cappedMaxHeight(_ requested: Int, width: Int) -> Int {
        min(max(requested, 1000), max(1000, pixelBudget / max(1, width)))
    }

    /// Height of the image `makeImage()` would produce now.
    var height: Int { min(maxHeight, committedRows + (frameHeight - (committedEnd ?? 0))) }

    @discardableResult
    func add(_ frame: PixelFrame, expectedShift: Int? = nil) -> Result {
        guard frame.width == width, frame.height == frameHeight else { return .noMatch }
        let sig = OverlapFinder.signature(frame, ignoreRight: ignoreRight)
        switch OverlapFinder.match(refSig, sig, expected: expectedShift) {
        case .identical: return .unchanged
        case .none: return .noMatch
        case .backward: return .backward
        case let .shift(d, _, bottom):
            let h = frameHeight
            if committedEnd == nil {
                commit(reference, from: 0, to: h - bottom)
                committedEnd = h - bottom
            }
            let start = max(0, committedEnd! - d)
            let end = h - bottom
            var added = 0
            if end > start {
                commit(frame, from: start, to: end)
                added = end - start
                committedEnd = end
            } else {
                committedEnd = start
            }
            reference = frame
            refSig = sig
            frameCount += 1
            return height >= maxHeight ? .reachedMax : .appended(added)
        }
    }

    private func commit(_ f: PixelFrame, from: Int, to: Int) {
        guard to > from else { return }
        strips.append(Array(f.pixels[(from * width)..<(to * width)]))
        committedRows += to - from
    }

    /// Assembles the stitched image (rows reversed when `flipped`). With
    /// `consume`, each strip is released as soon as it is copied, so the peak
    /// is about one image instead of two; the stitcher is spent afterwards.
    func makeImage(flipped: Bool = false, consume: Bool = false) -> CGImage? {
        let tailStart = committedEnd ?? 0
        let total = height
        let w = width
        let ref = reference
        var strips = self.strips
        if consume { self.strips = [] }
        return PixelFrame.makeImage(width: w, height: total) { dst in
            var row = 0
            func put(_ src: UnsafeBufferPointer<UInt32>, rows: Int) {
                for r in 0..<rows where row < total {
                    let target = flipped ? (total - 1 - row) : row
                    (dst + target * w).update(from: src.baseAddress! + r * w, count: w)
                    row += 1
                }
            }
            strips.reverse()
            while let s = strips.popLast() { s.withUnsafeBufferPointer { put($0, rows: s.count / w) } }
            ref.pixels.withUnsafeBufferPointer { buf in
                let tail = UnsafeBufferPointer(rebasing: buf[(tailStart * w)...])
                put(tail, rows: ref.height - tailStart)
            }
        }
    }
}
