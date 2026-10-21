// Draws the Bento app icon and writes Bento.icns into the given directory.
// usage: swift scripts/make-icon.swift Resources
import AppKit

let outDir = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ".")
let iconset = FileManager.default.temporaryDirectory.appendingPathComponent("Bento-\(getpid()).iconset")
try? FileManager.default.removeItem(at: iconset)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

func draw(_ px: Int) -> Data {
    let s = CGFloat(px)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let u = s / 1024

    // macOS icon grid: 824pt squircle centred in 1024 with a soft shadow.
    let tile = NSRect(x: 100 * u, y: 100 * u, width: 824 * u, height: 824 * u)
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.35)
    shadow.shadowBlurRadius = 24 * u
    shadow.shadowOffset = NSSize(width: 0, height: -10 * u)
    NSGraphicsContext.saveGraphicsState()
    shadow.set()
    let bg = NSBezierPath(roundedRect: tile, xRadius: 185 * u, yRadius: 185 * u)
    NSGradient(colors: [NSColor(calibratedRed: 0.17, green: 0.17, blue: 0.19, alpha: 1),
                        NSColor(calibratedRed: 0.08, green: 0.08, blue: 0.09, alpha: 1)])!.draw(in: bg, angle: -90)
    NSGraphicsContext.restoreGraphicsState()

    // Lacquered box.
    let box = tile.insetBy(dx: 120 * u, dy: 150 * u)
    let boxPath = NSBezierPath(roundedRect: box, xRadius: 56 * u, yRadius: 56 * u)
    NSGradient(colors: [NSColor(calibratedRed: 0.86, green: 0.22, blue: 0.20, alpha: 1),
                        NSColor(calibratedRed: 0.62, green: 0.10, blue: 0.11, alpha: 1)])!.draw(in: boxPath, angle: -90)

    // Compartments: one tall on the left, two stacked on the right.
    let inner = box.insetBy(dx: 30 * u, dy: 30 * u)
    let gap = 24 * u
    let leftW = inner.width * 0.46
    let left = NSRect(x: inner.minX, y: inner.minY, width: leftW, height: inner.height)
    let rightX = inner.minX + leftW + gap
    let rightW = inner.maxX - rightX
    let rh = (inner.height - gap) / 2
    let topRight = NSRect(x: rightX, y: inner.minY + rh + gap, width: rightW, height: rh)
    let bottomRight = NSRect(x: rightX, y: inner.minY, width: rightW, height: rh)
    let cells: [(NSRect, NSColor, NSColor)] = [
        (left, NSColor(calibratedWhite: 0.98, alpha: 1), NSColor(calibratedWhite: 0.86, alpha: 1)),
        (topRight, NSColor(calibratedRed: 0.99, green: 0.80, blue: 0.30, alpha: 1), NSColor(calibratedRed: 0.95, green: 0.62, blue: 0.16, alpha: 1)),
        (bottomRight, NSColor(calibratedRed: 0.46, green: 0.78, blue: 0.42, alpha: 1), NSColor(calibratedRed: 0.27, green: 0.60, blue: 0.30, alpha: 1)),
    ]
    for (r, top, bottom) in cells {
        let p = NSBezierPath(roundedRect: r, xRadius: 30 * u, yRadius: 30 * u)
        NSGradient(colors: [top, bottom])!.draw(in: p, angle: -90)
    }
    // Umeboshi on the rice.
    let dot = NSRect(x: left.midX - 52 * u, y: left.midY - 52 * u, width: 104 * u, height: 104 * u)
    NSGradient(colors: [NSColor(calibratedRed: 0.93, green: 0.30, blue: 0.36, alpha: 1),
                        NSColor(calibratedRed: 0.72, green: 0.12, blue: 0.22, alpha: 1)])!.draw(in: NSBezierPath(ovalIn: dot), angle: -90)

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for (name, px) in [("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64), ("128x128", 128),
                   ("128x128@2x", 256), ("256x256", 256), ("256x256@2x", 512), ("512x512", 512), ("512x512@2x", 1024)] {
    try draw(px).write(to: iconset.appendingPathComponent("icon_\(name).png"))
}
try draw(1024).write(to: outDir.appendingPathComponent("Bento-1024.png"))
let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
p.arguments = ["-c", "icns", iconset.path, "-o", outDir.appendingPathComponent("Bento.icns").path]
try p.run()
p.waitUntilExit()
try? FileManager.default.removeItem(at: iconset)
print(outDir.appendingPathComponent("Bento.icns").path)
