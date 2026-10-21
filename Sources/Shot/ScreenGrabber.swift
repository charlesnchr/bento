import AppKit
import ScreenCaptureKit
import BentoCore

/// Frozen image of one display, taken at native (backing) resolution.
struct DisplaySnapshot {
    let screen: NSScreen
    let displayID: CGDirectDisplayID
    /// Display frame in global AX coordinates (points).
    let axFrame: CGRect
    /// Pixels per point.
    let scale: CGFloat
    let image: CGImage

    var localBounds: CGRect { CGRect(origin: .zero, size: axFrame.size) }

    /// Crops a display-local rect (points) at native resolution.
    func crop(local r: CGRect) -> CGImage? {
        let px = ShotGeometry.pixelRect(local: r, scale: scale, imageWidth: image.width, imageHeight: image.height)
        guard px.width >= 1, px.height >= 1 else { return nil }
        // Copy the pixels so the (large) full-display image can be released.
        return image.cropping(to: px).flatMap(ScreenGrabber.detached)
    }
}

/// A window under the pointer in window-capture mode (from CGWindowList,
/// front-to-back order).
struct WindowInfo {
    let id: CGWindowID
    let pid: pid_t
    let frame: CGRect // AX
    let appName: String
    let title: String
}

/// ScreenCaptureKit wrappers. All captures exclude Bento's own windows and
/// the cursor, and return sRGB images (so picked colours match CSS values).
enum ScreenGrabber {
    static let log = BentoLog.make("shot")

    enum GrabError: LocalizedError {
        case noPermission, noDisplay, noWindow
        var errorDescription: String? {
            switch self {
            case .noPermission: return "Screen Recording permission is needed"
            case .noDisplay: return "Display not found"
            case .noWindow: return "Window not found"
            }
        }
    }

    /// Checks (and if needed requests) Screen Recording permission.
    static func ensurePermission() -> Bool {
        if Permissions.screenRecording { return true }
        Permissions.requestScreenRecording()
        HUD.show("Allow Screen Recording for Bento", symbol: "exclamationmark.triangle")
        Permissions.open(.screenRecording)
        return false
    }

    static func content() async throws -> SCShareableContent {
        try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    }

    static func ownApp(_ content: SCShareableContent) -> [SCRunningApplication] {
        content.applications.filter { $0.processID == getpid() }
    }

    static func configuration(width: Int, height: Int) -> SCStreamConfiguration {
        let c = SCStreamConfiguration()
        c.width = max(1, width)
        c.height = max(1, height)
        c.showsCursor = false
        c.captureResolution = .best
        c.colorSpaceName = CGColorSpace.sRGB
        c.pixelFormat = kCVPixelFormatType_32BGRA
        return c
    }

    /// Captures a display, or a display-local rect of it (points).
    static func capture(display: SCDisplay, content: SCShareableContent, localRect: CGRect? = nil) async throws -> (CGImage, CGFloat) {
        let filter = SCContentFilter(display: display, excludingApplications: ownApp(content), exceptingWindows: [])
        let scale = CGFloat(filter.pointPixelScale)
        let rect = localRect ?? CGRect(x: 0, y: 0, width: CGFloat(display.width), height: CGFloat(display.height))
        let cfg = configuration(width: Int((rect.width * scale).rounded()), height: Int((rect.height * scale).rounded()))
        if localRect != nil { cfg.sourceRect = rect }
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
        return (image, scale)
    }

    /// Freezes the given screens (all by default), concurrently.
    static func snapshot(screens: [NSScreen] = NSScreen.screens) async throws -> [DisplaySnapshot] {
        let content = try await content()
        let start = Date()
        var result: [DisplaySnapshot] = []
        try await withThrowingTaskGroup(of: DisplaySnapshot?.self) { group in
            for screen in screens {
                guard let display = content.displays.first(where: { $0.displayID == screen.displayID }) else { continue }
                let axFrame = screen.axFrame
                group.addTask {
                    let (image, scale) = try await capture(display: display, content: content)
                    return DisplaySnapshot(screen: screen, displayID: display.displayID, axFrame: axFrame, scale: scale, image: image)
                }
            }
            for try await s in group { if let s { result.append(s) } }
        }
        guard !result.isEmpty else { throw GrabError.noDisplay }
        log.debug("snapshot of \(result.count) display(s) in \(Int(Date().timeIntervalSince(start) * 1000)) ms")
        // Keep NSScreen order (primary first).
        return screens.compactMap { s in result.first { $0.displayID == s.displayID } }
    }

    /// Captures a global AX rect live (repeat-area, scrolling frames).
    static func capture(axRect: CGRect, content: SCShareableContent? = nil) async throws -> (CGImage, CGFloat) {
        guard let screen = NSScreen.containing(axRect: axRect) else { throw GrabError.noDisplay }
        let content: SCShareableContent = try await {
            if let content { return content }
            return try await Self.content()
        }()
        guard let display = content.displays.first(where: { $0.displayID == screen.displayID }) else { throw GrabError.noDisplay }
        let local = ShotGeometry.localRect(axRect, in: screen.axFrame).intersection(CGRect(origin: .zero, size: screen.frame.size))
        guard !local.isNull, local.width >= 1, local.height >= 1 else { throw GrabError.noDisplay }
        return try await capture(display: display, content: content, localRect: local)
    }

    /// Captures one window on its own (even if covered), with or without the
    /// system shadow. With the shadow, ScreenCaptureKit scales the window to
    /// fit the requested size, so a half-resolution probe measures the shadow
    /// margins first and the real capture is sized to keep the window at 1:1.
    static func captureWindow(id: CGWindowID, shadow: Bool) async throws -> (CGImage, CGFloat) {
        let content = try await content()
        guard let window = content.windows.first(where: { $0.windowID == id }) else { throw GrabError.noWindow }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let scale = CGFloat(filter.pointPixelScale)
        let contentPx = CGSize(width: (filter.contentRect.width * scale).rounded(), height: (filter.contentRect.height * scale).rounded())
        let cfg = configuration(width: Int(contentPx.width), height: Int(contentPx.height))
        cfg.ignoreShadowsSingleWindow = !shadow
        cfg.shouldBeOpaque = false
        if !shadow {
            return (try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg), scale)
        }
        cfg.width = max(1, Int(contentPx.width / 2))
        cfg.height = max(1, Int(contentPx.height / 2))
        let probe = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
        if let bb = opaqueBounds(probe), bb.width > 4, bb.height > 4 {
            let kx = bb.width / CGFloat(probe.width), ky = bb.height / CGFloat(probe.height)
            cfg.width = Int((contentPx.width / kx).rounded())
            cfg.height = Int((contentPx.height / ky).rounded())
        } else {
            cfg.width = Int(contentPx.width)
            cfg.height = Int(contentPx.height)
        }
        return (try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg), scale)
    }

    /// The wallpaper behind a global AX rect (for "window over wallpaper").
    static func wallpaper(axRect: CGRect) async throws -> CGImage? {
        guard let screen = NSScreen.containing(axRect: axRect) else { return nil }
        let content = try await content()
        guard let display = content.displays.first(where: { $0.displayID == screen.displayID }) else { return nil }
        let desktopLevel = Int(CGWindowLevelForKey(.desktopWindow))
        let walls = content.windows.filter {
            ($0.owningApplication?.bundleIdentifier == "com.apple.dock" && ($0.title ?? "").hasPrefix("Wallpaper"))
                || $0.windowLayer == desktopLevel || $0.windowLayer == desktopLevel - 1
        }
        guard !walls.isEmpty else { return nil }
        let filter = SCContentFilter(display: display, including: walls)
        let scale = CGFloat(filter.pointPixelScale)
        let local = ShotGeometry.localRect(axRect, in: screen.axFrame)
        let cfg = configuration(width: Int((local.width * scale).rounded()), height: Int((local.height * scale).rounded()))
        cfg.sourceRect = local
        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
    }

    /// On-screen windows of other apps, front to back.
    static func windowList() -> [WindowInfo] {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
        let me = getpid()
        return list.compactMap { d in
            guard let id = d[kCGWindowNumber as String] as? CGWindowID,
                  let layer = d[kCGWindowLayer as String] as? Int, (0..<20).contains(layer),
                  let pid = d[kCGWindowOwnerPID as String] as? pid_t, pid != me,
                  let b = d[kCGWindowBounds as String] as? NSDictionary,
                  let frame = CGRect(dictionaryRepresentation: b),
                  frame.width >= 24, frame.height >= 24 else { return nil }
            if let alpha = d[kCGWindowAlpha as String] as? Double, alpha < 0.05 { return nil }
            let owner = d[kCGWindowOwnerName as String] as? String ?? ""
            if owner == "Window Server" || owner == "Dock" { return nil }
            return WindowInfo(id: id, pid: pid, frame: frame, appName: owner, title: d[kCGWindowName as String] as? String ?? "")
        }
    }

    /// The focused window of the frontmost app (AX), else its frontmost on-screen window.
    static func activeWindow() -> WindowInfo? {
        let list = windowList()
        if let ax = AXWindow.focused(), let id = ax.windowID, let w = list.first(where: { $0.id == id }) { return w }
        guard let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier else { return nil }
        return list.first { $0.pid == pid }
    }

    /// Bounding box of (nearly) opaque pixels.
    static func opaqueBounds(_ image: CGImage) -> CGRect? {
        guard let f = PixelFrame(image) else { return nil }
        var minX = f.width, minY = f.height, maxX = -1, maxY = -1
        f.pixels.withUnsafeBufferPointer { px in
            for y in 0..<f.height {
                let row = y * f.width
                for x in 0..<f.width where (px[row + x] >> 24) >= 250 {
                    if x < minX { minX = x }
                    if x > maxX { maxX = x }
                    if y < minY { minY = y }
                    if y > maxY { maxY = y }
                }
            }
        }
        guard maxX >= minX, maxY >= minY else { return nil }
        return CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1)
    }

    /// Re-renders an image into its own buffer (drops references to a larger parent image).
    static func detached(_ image: CGImage) -> CGImage? {
        PixelFrame(image)?.makeImage()
    }

    /// Reads one pixel of an image as sRGB.
    static func color(in image: CGImage, x: Int, y: Int) -> RGB8? {
        guard x >= 0, y >= 0, x < image.width, y < image.height,
              let px = image.cropping(to: CGRect(x: x, y: y, width: 1, height: 1)) else { return nil }
        var v: UInt32 = 0
        guard let ctx = CGContext(data: &v, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                  space: PixelFrame.colorSpace, bitmapInfo: PixelFrame.bitmapInfo) else { return nil }
        ctx.draw(px, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        return RGB8(r: UInt8(v >> 16 & 0xFF), g: UInt8(v >> 8 & 0xFF), b: UInt8(v & 0xFF))
    }

    /// Reads a block of pixels (clamped to the image) as a frame.
    static func block(in image: CGImage, x: Int, y: Int, width: Int, height: Int) -> (PixelFrame, CGRect)? {
        let r = CGRect(x: x, y: y, width: width, height: height).intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard !r.isNull, r.width >= 1, r.height >= 1, let crop = image.cropping(to: r), let f = PixelFrame(crop) else { return nil }
        return (f, r)
    }
}

extension UInt32 {
    /// BGRA-premultiplied pixel -> RGB8 (alpha is 255 for screen captures).
    var rgb8: RGB8 { RGB8(r: UInt8(self >> 16 & 0xFF), g: UInt8(self >> 8 & 0xFF), b: UInt8(self & 0xFF)) }
}
