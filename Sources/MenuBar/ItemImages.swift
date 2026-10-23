import AppKit
import BentoCore

/// Images of status items, captured from their windows (Screen Recording).
/// Captured on demand for the Bento Bar, search and Settings, and dropped
/// when those close; nothing is cached while they're closed.
enum ItemImages {
    private static let queue = DispatchQueue(label: "com.charles.bento.menubar.images", qos: .userInitiated)

    /// Captures `items` off the main thread; `completion` runs on the main thread.
    static func capture(_ items: [MenuBarItem], completion: @escaping ([CGWindowID: NSImage]) -> Void) {
        guard WindowServer.canCaptureImages else { completion([:]); return }
        let jobs = items.map { ($0.windowID, $0.frame) }
        queue.async {
            var out: [CGWindowID: NSImage] = [:]
            for (id, frame) in jobs {
                guard let cg = WindowServer.image(of: id, frame: frame) else { continue }
                // Pixel size → points, using the capture's own scale.
                let scale = max(1, (CGFloat(cg.width) / max(frame.width, 1)).rounded())
                out[id] = NSImage(cgImage: cg, size: NSSize(width: CGFloat(cg.width) / scale, height: CGFloat(cg.height) / scale))
            }
            DispatchQueue.main.async { completion(out) }
        }
    }

    /// A small fingerprint of an image (changes when the icon changes).
    static func fingerprint(_ image: CGImage) -> UInt64 {
        let w = 24, h = 12
        var pixels = [UInt8](repeating: 0, count: w * h)
        let drawn: Bool = pixels.withUnsafeMutableBytes { buf in
            guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
            ctx.interpolationQuality = .low
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard drawn else { return 0 }
        // FNV-1a over coarsely quantised pixels, so sub-pixel noise doesn't count.
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for p in pixels {
            hash ^= UInt64(p >> 3)
            hash = hash &* 0x100_0000_01b3
        }
        return hash
    }

    /// The app's icon, for items without a captured image.
    static func appIcon(for item: MenuBarItem) -> NSImage? {
        guard let pid = item.ownerPID, let app = NSRunningApplication(processIdentifier: pid) else { return nil }
        return app.icon
    }
}

/// Shows a hidden item for a few seconds when its icon changes (opt-in per
/// item). There is no notification for another app's icon changing, so the
/// chosen items are captured every 2 s while they're hidden: a capture of a
/// 40 × 30 pt window, a few times a minute, only for the items picked.
final class ChangeWatcher {
    private weak var controller: MenuBarController?
    private var timer: Timer?
    private var keys: Set<String> = []
    private var fingerprints: [CGWindowID: UInt64] = [:]
    private let queue = DispatchQueue(label: "com.charles.bento.menubar.watch", qos: .utility)

    init(controller: MenuBarController) {
        self.controller = controller
    }

    var isRunning: Bool { timer != nil }

    func update(keys new: Set<String>) {
        keys = new
        if keys.isEmpty { stop(); return }
        guard timer == nil else { return }
        let t = Timer(timeInterval: 2, repeats: true) { [weak self] _ in self?.tick() }
        t.tolerance = 1
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        fingerprints = [:]
    }

    private func tick() {
        guard let controller, WindowServer.canCaptureImages else { return }
        // Only while hidden: a shown item is already visible.
        guard controller.visibility == .hidden, !controller.isArranging, !controller.bar.isOpen else {
            fingerprints = [:]
            return
        }
        let items = controller.scanner.snapshot()
        let sections = controller.sections(items)
        let watched = items.filter { keys.contains($0.key) && (sections[$0.windowID] ?? .visible) != .visible }
        guard !watched.isEmpty else { return }
        let jobs = watched.map { ($0.windowID, $0.frame) }
        queue.async { [weak self] in
            var prints: [CGWindowID: UInt64] = [:]
            for (id, frame) in jobs {
                if let image = WindowServer.image(of: id, frame: frame) { prints[id] = ItemImages.fingerprint(image) }
            }
            DispatchQueue.main.async {
                guard let self, let controller = self.controller else { return }
                var changed: MenuBarItem?
                for item in watched {
                    guard let now = prints[item.windowID] else { continue }
                    if let before = self.fingerprints[item.windowID], before != now, changed == nil { changed = item }
                    self.fingerprints[item.windowID] = now
                }
                let live = Set(watched.map(\.windowID))
                self.fingerprints = self.fingerprints.filter { live.contains($0.key) }
                if let changed { controller.showForChange(changed) }
            }
        }
    }
}
