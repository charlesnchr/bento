import AppKit

/// Adds padding and a background (solid colour or the wallpaper) behind a
/// captured window, like Shottr's window-capture modes.
enum WindowComposer {
    /// Canvas size in pixels for a window image plus padding (points) on each side.
    static func canvasSize(window: CGSize, padding: Int, scale: CGFloat) -> CGSize {
        let p = CGFloat(max(0, padding)) * scale
        return CGSize(width: window.width + 2 * p, height: window.height + 2 * p)
    }

    static func compose(window: CGImage, scale: CGFloat, padding: Int, background: ShotSettings.WindowBackground,
                        color: RGB8, wallpaper: CGImage?) -> CGImage? {
        if padding <= 0 && background == .transparent { return window }
        let size = canvasSize(window: CGSize(width: window.width, height: window.height), padding: padding, scale: scale)
        let w = Int(size.width.rounded()), h = Int(size.height.rounded())
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: PixelFrame.colorSpace, bitmapInfo: PixelFrame.bitmapInfo) else { return nil }
        let canvas = CGRect(x: 0, y: 0, width: w, height: h)
        switch background {
        case .transparent:
            break
        case .solid:
            ctx.setFillColor(CGColor(srgbRed: CGFloat(color.r) / 255, green: CGFloat(color.g) / 255, blue: CGFloat(color.b) / 255, alpha: 1))
            ctx.fill(canvas)
        case .wallpaper:
            if let wallpaper {
                ctx.interpolationQuality = .high
                ctx.draw(wallpaper, in: aspectFill(CGSize(width: wallpaper.width, height: wallpaper.height), into: canvas))
            } else {
                ctx.setFillColor(CGColor(gray: 0.5, alpha: 1))
                ctx.fill(canvas)
            }
        }
        let p = CGFloat(max(0, padding)) * scale
        ctx.draw(window, in: CGRect(x: p.rounded(), y: p.rounded(), width: CGFloat(window.width), height: CGFloat(window.height)))
        return ctx.makeImage()
    }

    static func aspectFill(_ s: CGSize, into r: CGRect) -> CGRect {
        guard s.width > 0, s.height > 0 else { return r }
        let k = max(r.width / s.width, r.height / s.height)
        let w = s.width * k, h = s.height * k
        return CGRect(x: r.midX - w / 2, y: r.midY - h / 2, width: w, height: h)
    }
}
