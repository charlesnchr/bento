import Testing
import CoreGraphics
import Foundation
import ImageIO
@testable import Shot

// MARK: - Geometry

@Suite struct GeometryTests {
    let bounds = CGRect(x: 0, y: 0, width: 1512, height: 982)

    @Test func selectionFromAnyDirection() {
        let a = CGPoint(x: 100, y: 100)
        #expect(ShotGeometry.selection(anchor: a, current: CGPoint(x: 300, y: 250), square: false, fromCenter: false, bounds: bounds)
                == CGRect(x: 100, y: 100, width: 200, height: 150))
        #expect(ShotGeometry.selection(anchor: a, current: CGPoint(x: 40, y: 20), square: false, fromCenter: false, bounds: bounds)
                == CGRect(x: 40, y: 20, width: 60, height: 80))
    }

    @Test func squareConstraintFollowsLongerSideAndDirection() {
        let a = CGPoint(x: 100, y: 100)
        #expect(ShotGeometry.selection(anchor: a, current: CGPoint(x: 300, y: 150), square: true, fromCenter: false, bounds: bounds)
                == CGRect(x: 100, y: 100, width: 200, height: 200))
        #expect(ShotGeometry.selection(anchor: a, current: CGPoint(x: 60, y: 0), square: true, fromCenter: false, bounds: bounds)
                == CGRect(x: 0, y: 0, width: 100, height: 100))
    }

    @Test func squareIsLimitedByDisplayEdges() {
        let a = CGPoint(x: 1500, y: 100)
        let r = ShotGeometry.selection(anchor: a, current: CGPoint(x: 1512, y: 400), square: true, fromCenter: false, bounds: bounds)
        #expect(r == CGRect(x: 1500, y: 100, width: 12, height: 12))
    }

    @Test func fromCenter() {
        let r = ShotGeometry.selection(anchor: CGPoint(x: 500, y: 500), current: CGPoint(x: 520, y: 540), square: false, fromCenter: true, bounds: bounds)
        #expect(r == CGRect(x: 480, y: 460, width: 40, height: 80))
    }

    @Test func selectionIsClippedToBounds() {
        let r = ShotGeometry.selection(anchor: CGPoint(x: 1400, y: 900), current: CGPoint(x: 1700, y: 1200), square: false, fromCenter: false, bounds: bounds)
        #expect(r == CGRect(x: 1400, y: 900, width: 112, height: 82))
    }

    @Test func moveKeepsRectInside() {
        let r = CGRect(x: 10, y: 10, width: 100, height: 50)
        #expect(ShotGeometry.move(r, by: CGVector(dx: -30, dy: 5), within: bounds) == CGRect(x: 0, y: 15, width: 100, height: 50))
        #expect(ShotGeometry.move(r, by: CGVector(dx: 5000, dy: 5000), within: bounds) == CGRect(x: 1412, y: 932, width: 100, height: 50))
    }

    @Test func pixelRectAtRetinaScale() {
        let px = ShotGeometry.pixelRect(local: CGRect(x: 10, y: 20, width: 100, height: 50), scale: 2, imageWidth: 3024, imageHeight: 1964)
        #expect(px == CGRect(x: 20, y: 40, width: 200, height: 100))
        // Clamped to the image.
        let edge = ShotGeometry.pixelRect(local: CGRect(x: 1500, y: 970, width: 100, height: 50), scale: 2, imageWidth: 3024, imageHeight: 1964)
        #expect(edge == CGRect(x: 3000, y: 1940, width: 24, height: 24))
        // Non-integral scale (e.g. 1.5) rounds edges, never loses a pixel row.
        let odd = ShotGeometry.pixelRect(local: CGRect(x: 1, y: 1, width: 3, height: 3), scale: 1.5, imageWidth: 100, imageHeight: 100)
        #expect(odd == CGRect(x: 2, y: 2, width: 4, height: 4))
    }

    @Test func pixelUnderPoint() {
        #expect(ShotGeometry.pixel(at: CGPoint(x: 10.75, y: 3.2), scale: 2) == (21, 6))
        #expect(ShotGeometry.pixel(at: CGPoint(x: 10.75, y: 3.2), scale: 1) == (10, 3))
    }

    @Test func localGlobalRoundTripOnSecondaryDisplay() {
        // A display left of and above the primary (negative AX origin).
        let display = CGRect(x: -1920, y: -1080, width: 1920, height: 1080)
        let g = CGPoint(x: -100, y: -50)
        let l = ShotGeometry.local(g, in: display)
        #expect(l == CGPoint(x: 1820, y: 1030))
        #expect(ShotGeometry.global(l, in: display) == g)
        let r = CGRect(x: 10, y: 20, width: 30, height: 40)
        #expect(ShotGeometry.localRect(ShotGeometry.globalRect(r, in: display), in: display) == r)
    }

    @Test func loupeFlipsNearEdges() {
        let size = CGSize(width: 120, height: 158)
        #expect(ShotGeometry.floatingOrigin(near: CGPoint(x: 100, y: 100), size: size, offset: 20, bounds: bounds) == CGPoint(x: 120, y: 120))
        #expect(ShotGeometry.floatingOrigin(near: CGPoint(x: 1500, y: 970), size: size, offset: 20, bounds: bounds) == CGPoint(x: 1360, y: 792))
    }

    @Test func sizeLabelGoesInsideAtBottomEdge() {
        let label = CGSize(width: 80, height: 20)
        #expect(ShotGeometry.sizeLabelOrigin(selection: CGRect(x: 100, y: 100, width: 200, height: 100), labelSize: label, bounds: bounds)
                == CGPoint(x: 220, y: 206))
        #expect(ShotGeometry.sizeLabelOrigin(selection: CGRect(x: 100, y: 800, width: 200, height: 182), labelSize: label, bounds: bounds)
                == CGPoint(x: 220, y: 956))
    }

    @Test func compositeCanvasUsesHighestScale() {
        let frames = [CGRect(x: 0, y: 0, width: 1512, height: 982), CGRect(x: 1512, y: -200, width: 1920, height: 1080)]
        let c = ShotGeometry.canvas(for: frames, scales: [2, 1])
        #expect(c.union == CGRect(x: 0, y: -200, width: 3432, height: 1182))
        #expect(c.scale == 2)
        #expect(c.width == 6864 && c.height == 2364)
    }

    @Test func frontmostWindowWins() {
        let rects = [CGRect(x: 0, y: 0, width: 100, height: 100), CGRect(x: 0, y: 0, width: 500, height: 500)]
        #expect(ShotGeometry.frontmost(at: CGPoint(x: 50, y: 50), in: rects) == 0)
        #expect(ShotGeometry.frontmost(at: CGPoint(x: 300, y: 50), in: rects) == 1)
        #expect(ShotGeometry.frontmost(at: CGPoint(x: 900, y: 50), in: rects) == nil)
    }

    @Test func rulerFindsEdges() {
        // 20×10 image: a box of "1"s from x 5...14, y 2...7 on "0"s.
        let w = 20, h = 10
        let px: [Int] = (0..<(w * h)).map { i in
            let x = i % w, y = i / w
            return (5...14).contains(x) && (2...7).contains(y) ? 1 : 0
        }
        let e = ShotGeometry.rulerExtent(from: (8, 4), width: w, height: h) { x, y in px[y * w + x] == 1 }
        #expect(e.left == 5 && e.right == 14 && e.up == 2 && e.down == 7)
    }
}

// MARK: - Colour

@Suite struct ColorTests {
    @Test func formats() {
        let c = RGB8(r: 30, g: 144, b: 255)
        #expect(ColorFormat.hex.string(c) == "#1E90FF")
        #expect(ColorFormat.hexNoHash.string(c) == "1E90FF")
        #expect(ColorFormat.rgb.string(c) == "rgb(30, 144, 255)")
        #expect(ColorFormat.hsl.string(c) == "hsl(210, 100%, 56%)")
    }

    @Test func oklchReferenceValues() {
        #expect(ColorFormat.oklch.string(RGB8(r: 255, g: 255, b: 255)) == "oklch(100.0% 0.000 0.0)")
        // CSS red is oklch(62.8% 0.2577 29.23).
        let (l, c, h) = ColorFormat.oklch(RGB8(r: 255, g: 0, b: 0))
        #expect(abs(l - 0.628) < 0.001)
        #expect(abs(c - 0.2577) < 0.001)
        #expect(abs(h - 29.23) < 0.05)
    }

    @Test func parseHex() {
        #expect(ColorFormat.parseHex("#FF8000") == RGB8(r: 255, g: 128, b: 0))
        #expect(ColorFormat.parseHex("00ff00") == RGB8(r: 0, g: 255, b: 0))
        #expect(ColorFormat.parseHex("#12345") == nil)
    }

    @Test func pixelToRGB() {
        // BGRA little-endian: 0xAARRGGBB as a UInt32.
        #expect(UInt32(0xFF1E_90FF).rgb8 == RGB8(r: 30, g: 144, b: 255))
    }
}

// MARK: - Output

@Suite struct OutputTests {
    @Test func filenamePattern() {
        var comps = DateComponents()
        comps.year = 2026; comps.month = 3; comps.day = 9; comps.hour = 14; comps.minute = 5; comps.second = 7
        let date = Calendar.current.date(from: comps)!
        let name = CaptureOutput.filename(pattern: "Screenshot {yyyy-MM-dd} at {HH.mm.ss}", date: date, app: "Safari", kind: "area", size: CGSize(width: 800, height: 600))
        #expect(name == "Screenshot 2026-03-09 at 14.05.07")
        let tokens = CaptureOutput.filename(pattern: "{app}/{kind} {w}x{h}: {HH:mm}", date: date, app: "Safari", kind: "window", size: CGSize(width: 800, height: 600))
        #expect(tokens == "Safari-window 800x600. 14.05")
        #expect(CaptureOutput.filename(pattern: "  ", date: date, app: nil, kind: "area", size: .zero) == "Screenshot")
        #expect(CaptureOutput.filename(pattern: "x {unclosed", date: date, app: nil, kind: "area", size: .zero) == "x {unclosed")
    }

    @Test func joinOCRLines() {
        let text = "The quick brown\nfox jumps over the lazy\ndog. Hyphen-\nated words\n\nNew paragraph"
        #expect(OCRText.joinLines(text) == "The quick brown fox jumps over the lazy dog. Hyphenated words\n\nNew paragraph")
    }

    @Test func ocrRunsOnTheSameLineAreJoined() {
        let runs = [
            OCRText.OCRRun(text: "The quick", minX: 0.2, minY: 0.10, maxY: 0.14),
            OCRText.OCRRun(text: "0002", minX: 0.0, minY: 0.20, maxY: 0.24),
            OCRText.OCRRun(text: "0001", minX: 0.0, minY: 0.105, maxY: 0.145),
            OCRText.OCRRun(text: "second line", minX: 0.2, minY: 0.205, maxY: 0.24),
        ]
        #expect(OCRText.lines(runs) == "0001 The quick\n0002 second line")
    }

    @Test func writesPNGWithRetinaDPIAndJPEG() throws {
        let frame = PixelFrame(width: 20, height: 10, pixels: [UInt32](repeating: 0xFF33_66CC, count: 200))
        let image = try #require(frame.makeImage())
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("shot-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let png = dir.appendingPathComponent("a.png")
        #expect(CaptureOutput.write(image, scale: 2, to: png, format: .png, quality: 0.9))
        let src = try #require(CGImageSourceCreateWithURL(png as CFURL, nil))
        let props = try #require(CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any])
        #expect((props[kCGImagePropertyDPIWidth] as? Double) == 144)
        #expect((props[kCGImagePropertyPixelWidth] as? Int) == 20)

        let jpg = dir.appendingPathComponent("a.jpg")
        #expect(CaptureOutput.write(image, scale: 1, to: jpg, format: .jpeg, quality: 0.8))
        #expect(FileManager.default.fileExists(atPath: jpg.path))

        let small = try #require(CaptureOutput.downscale(image, by: 2))
        #expect(small.width == 10 && small.height == 5)

        // Unique names never overwrite.
        let u = CaptureOutput.uniqueURL(folder: dir, base: "a", ext: "png")
        #expect(u.lastPathComponent == "a (2).png")
    }

    @Test func windowCanvas() {
        #expect(WindowComposer.canvasSize(window: CGSize(width: 200, height: 100), padding: 16, scale: 2) == CGSize(width: 264, height: 164))
        let fill = WindowComposer.aspectFill(CGSize(width: 100, height: 50), into: CGRect(x: 0, y: 0, width: 100, height: 100))
        #expect(fill == CGRect(x: -50, y: 0, width: 200, height: 100))
    }
}

// MARK: - Scrolling stitch

/// A synthetic long document: deterministic noisy rows with ~35 % blank
/// (flat) rows, like text lines with gaps.
struct SyntheticDoc {
    let width: Int
    let rows: [[UInt32]]

    init(width: Int = 48, height: Int = 2600, seed: UInt64 = 42) {
        self.width = width
        var rng = seed
        func next() -> UInt64 { rng = rng &* 6364136223846793005 &+ 1442695040888963407; return rng >> 17 }
        var rows: [[UInt32]] = []
        for _ in 0..<height {
            if next() % 100 < 35 {
                rows.append([UInt32](repeating: 0xFFFF_FFFF, count: width))
            } else {
                rows.append((0..<width).map { _ in 0xFF00_0000 | UInt32(truncatingIfNeeded: next()) & 0x00FF_FFFF })
            }
        }
        self.rows = rows
    }

    /// A viewport frame: static header, `visible` rows from `offset`, static footer.
    func frame(offset: Int, visible: Int, header: Int = 0, footer: Int = 0) -> PixelFrame {
        var px: [UInt32] = []
        for y in 0..<header { px += [UInt32](repeating: 0xFF20_2020 &+ UInt32(y % 3), count: width) }
        for r in offset..<(offset + visible) { px += rows[r] }
        for y in 0..<footer { px += (0..<width).map { x in 0xFF40_0000 | UInt32((x * 7 + y) & 0xFF) } }
        return PixelFrame(width: width, height: header + visible + footer, pixels: px)
    }

    func expected(upTo end: Int, header: Int, footer: Int, from template: PixelFrame) -> [UInt32] {
        let w = width
        var px = Array(template.pixels[0..<(header * w)])
        for r in 0..<end { px += rows[r] }
        px += template.pixels[(template.height - footer) * w ..< template.height * w]
        return px
    }
}

func pixels(of image: CGImage) -> [UInt32] { PixelFrame(image)!.pixels }

@Suite struct StitchTests {
    @Test func identicalFramesAreUnchanged() {
        let doc = SyntheticDoc()
        let f = doc.frame(offset: 0, visible: 300)
        let st = ScrollStitcher(first: f)
        #expect(st.add(f) == .unchanged)
        #expect(st.height == 300)
    }

    @Test func overlapFinderReportsShiftAndStaticBands() {
        let doc = SyntheticDoc()
        let a = OverlapFinder.signature(doc.frame(offset: 100, visible: 300, header: 24, footer: 12))
        let b = OverlapFinder.signature(doc.frame(offset: 237, visible: 300, header: 24, footer: 12))
        guard case let .shift(d, top, bottom) = OverlapFinder.match(a, b) else { Issue.record("no match"); return }
        #expect(d == 137)
        #expect(top >= 24 && bottom >= 12)
        #expect(OverlapFinder.match(b, a) == .backward(137))
    }

    @Test func stitchesWithStickyHeaderAndFooter() {
        let doc = SyntheticDoc()
        let visible = 360, header = 30, footer = 20
        var offsets = Array(stride(from: 0, to: doc.rows.count - visible, by: 197))
        offsets.append(doc.rows.count - visible) // last, shorter step at the end
        let first = doc.frame(offset: 0, visible: visible, header: header, footer: footer)
        let st = ScrollStitcher(first: first, maxHeight: 100_000)
        for o in offsets.dropFirst() {
            let r = st.add(doc.frame(offset: o, visible: visible, header: header, footer: footer))
            guard case .appended = r else { Issue.record("offset \(o): \(r)"); return }
        }
        #expect(st.add(doc.frame(offset: offsets.last!, visible: visible, header: header, footer: footer)) == .unchanged)
        let img = st.makeImage()!
        #expect(img.height == header + doc.rows.count + footer)
        #expect(pixels(of: img) == doc.expected(upTo: doc.rows.count, header: header, footer: footer, from: first))
    }

    @Test func toleratesBlinkingCaretAndIrregularSteps() {
        let doc = SyntheticDoc(seed: 7)
        let visible = 400
        let offsets = [0, 150, 151, 420, 600, 777, 1000, 1290]
        let st = ScrollStitcher(first: doc.frame(offset: 0, visible: visible))
        for (i, o) in offsets.enumerated().dropFirst() {
            var f = doc.frame(offset: o, visible: visible)
            if i % 2 == 0 { // a caret: a few changed pixels in 12 rows
                for y in 200..<212 { f.pixels[y * f.width + 3] = 0xFF00_00FF }
            }
            guard case .appended = st.add(f) else { Issue.record("offset \(o)"); return }
        }
        #expect(st.height == 1290 + visible)
    }

    @Test func tooLargeJumpIsNoMatch() {
        let doc = SyntheticDoc()
        let st = ScrollStitcher(first: doc.frame(offset: 0, visible: 300))
        #expect(st.add(doc.frame(offset: 900, visible: 300)) == .noMatch)
        // The reference frame is kept, so continuing from an overlapping frame works.
        #expect(st.add(doc.frame(offset: 200, visible: 300)) == .appended(200))
    }

    @Test func upwardScrollingViaFlippedFrames() {
        let doc = SyntheticDoc(seed: 99)
        let visible = 300
        // Start at the bottom and scroll up.
        let offsets = [2000, 1800, 1650, 1400, 1200]
        let st = ScrollStitcher(first: doc.frame(offset: offsets[0], visible: visible).flippedVertically())
        for o in offsets.dropFirst() {
            guard case .appended = st.add(doc.frame(offset: o, visible: visible).flippedVertically()) else { Issue.record("offset \(o)"); return }
        }
        let img = st.makeImage(flipped: true)!
        #expect(img.height == 2000 + visible - 1200)
        var want: [UInt32] = []
        for r in 1200..<(2000 + visible) { want += doc.rows[r] }
        #expect(pixels(of: img) == want)
    }

    @Test func maxHeightStops() {
        let doc = SyntheticDoc()
        let st = ScrollStitcher(first: doc.frame(offset: 0, visible: 300), maxHeight: 700)
        #expect(st.add(doc.frame(offset: 200, visible: 300)) == .appended(200))
        #expect(st.add(doc.frame(offset: 400, visible: 300)) == .reachedMax)
        #expect(st.makeImage()!.height == 700)
    }

    @Test func blankFramesDoNotMatch() {
        let blank = PixelFrame(width: 10, height: 50, pixels: [UInt32](repeating: 0xFFFF_FFFF, count: 500))
        var other = blank
        other.pixels[0] = 0xFF00_0000
        #expect(OverlapFinder.match(OverlapFinder.signature(blank), OverlapFinder.signature(other)) == .none)
    }
}
