import AppKit
import SwiftUI
import Vision
import ShotEditor
import BentoCore

/// Capture module (the Shottr capture side). See docs/SPEC.md.
///
/// Every capture freezes the screens first (ScreenCaptureKit), then selection
/// happens on the frozen image; results go to ShotEditor according to the
/// after-capture setting. Nothing runs between captures.
public final class ShotModule: BentoModule {
    public let id = "shot"
    public let title = "Capture"
    public let symbol = "camera.viewfinder"

    private var configObserver: NSObjectProtocol?
    private var busy = false

    public init() {}

    // MARK: Actions

    public var actions: [BentoAction] {
        let cap = "Capture", tools = "Tools", lib = "Library"
        return [
            BentoAction("shot.area", "Capture Area", group: cap, shortcut: "cmd+shift+2") { [weak self] in self?.captureArea() },
            BentoAction("shot.fullscreen", "Capture Fullscreen", group: cap, shortcut: "cmd+shift+1") { [weak self] in self?.captureFullscreen() },
            BentoAction("shot.window", "Capture Window", group: cap) { [weak self] in self?.captureWindowPicker() },
            BentoAction("shot.active-window", "Capture Active Window", group: cap) { [weak self] in self?.captureActiveWindow() },
            BentoAction("shot.repeat-area", "Repeat Last Area", group: cap) { [weak self] in self?.repeatArea() },
            BentoAction("shot.scrolling", "Scrolling Capture", group: cap) { [weak self] in self?.scrollingCapture(up: false) },
            BentoAction("shot.scrolling-up", "Scrolling Capture (Up)", group: cap) { [weak self] in self?.scrollingCapture(up: true) },
            BentoAction("shot.delayed", "Delayed Capture", group: cap) { [weak self] in self?.delayedCapture(seconds: nil) },
            BentoAction("shot.delayed-5", "Delayed Capture (5 s)", group: cap, hiddenFromMenu: true) { [weak self] in self?.delayedCapture(seconds: 5) },
            BentoAction("shot.delayed-10", "Delayed Capture (10 s)", group: cap, hiddenFromMenu: true) { [weak self] in self?.delayedCapture(seconds: 10) },
            BentoAction("shot.ocr", "Copy Text from Area", group: tools, shortcut: "ctrl+opt+cmd+o") { [weak self] in self?.copyText() },
            BentoAction("shot.pin-area", "Capture Area to Pin", group: tools) { [weak self] in self?.captureArea(action: .pin) },
            BentoAction("shot.color", "Pick Colour", group: tools) { [weak self] in self?.pickColor() },
            BentoAction("shot.reopen-last", "Reopen Last Capture", group: lib) { ShotEditor.shared.reopenLast() },
            BentoAction("shot.history", "Capture History", group: lib) { ShotEditor.shared.showHistory() },
            BentoAction("shot.open-clipboard", "Open Image from Clipboard", group: lib, hiddenFromMenu: true) { ShotEditor.shared.openClipboardImage() },
            BentoAction("shot.open-file", "Open Image File…", group: lib, hiddenFromMenu: true) { ShotEditor.shared.openFilePanel() },
        ]
    }

    public func start() {
        ConfigStore.shared.materialize(id, default: ShotSettings())
        reloadSettings()
        configObserver = ConfigStore.shared.observe(id) { [weak self] in self?.reloadSettings() }
    }

    public func stop() {
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        configObserver = nil
        CaptureOverlay.current?.finish(.cancelled)
        ScrollCaptureSession.cancel()
        Countdown.cancel()
        busy = false
    }

    public func makeSettingsView() -> AnyView? {
        AnyView(ShotSettingsView(actions: actions))
    }

    private func reloadSettings() {
        ConfigStoreAccess.settings = ConfigStore.shared.section(id, default: ShotSettings())
    }

    private var settings: ShotSettings { ConfigStoreAccess.settings }

    // MARK: Guards

    private var isBusy: Bool { busy || CaptureOverlay.isActive || ScrollCaptureSession.isActive || Countdown.isActive }

    /// Freezes the screens and shows the overlay.
    private func freeze(_ options: CaptureOverlay.Options, screens: [NSScreen] = NSScreen.screens,
                        completion: @escaping (OverlayOutcome, NSRunningApplication?) -> Void) {
        guard !isBusy, ScreenGrabber.ensurePermission() else { return }
        busy = true
        let front = NSWorkspace.shared.frontmostApplication
        Task { @MainActor in
            do {
                let snaps = try await ScreenGrabber.snapshot(screens: screens)
                self.busy = false
                CaptureOverlay.present(snapshots: snaps, options: options) { outcome in completion(outcome, front) }
            } catch {
                self.busy = false
                self.report(error)
            }
        }
    }

    private func overlayOptions(_ mode: OverlayMode, title: String? = nil, allowWindow: Bool = true, adjustable: Bool? = nil) -> CaptureOverlay.Options {
        let s = settings
        return CaptureOverlay.Options(mode: mode, allowWindowMode: allowWindow, magnifier: s.showMagnifier,
                                      adjustable: adjustable ?? s.adjustSelectionBeforeCapture, colorFormat: s.colorFormat, title: title)
    }

    private func report(_ error: Error) {
        ScreenGrabber.log.error("capture failed: \(error.localizedDescription, privacy: .public)")
        HUD.show("Capture failed: \(error.localizedDescription)", symbol: "exclamationmark.triangle")
    }

    // MARK: Area

    func captureArea(action: ShotSettings.AfterCapture? = nil) {
        freeze(overlayOptions(.area, title: action == .pin ? "Pin" : nil)) { [weak self] outcome, front in
            self?.handleAreaOutcome(outcome, front: front, action: action)
        }
    }

    private func handleAreaOutcome(_ outcome: OverlayOutcome, front: NSRunningApplication?, action: ShotSettings.AfterCapture?) {
        switch outcome {
        case let .area(snap, rect):
            guard let image = snap.crop(local: rect) else { return }
            let ax = ShotGeometry.globalRect(rect, in: snap.axFrame)
            LastArea.save(ax)
            let app = appOwning(point: CGPoint(x: ax.midX, y: ax.midY)) ?? front
            CaptureOutput.deliver(CapturedImage(image: image, scale: snap.scale, rect: ax, kind: .area,
                                                sourceAppName: app?.localizedName, sourceBundleID: app?.bundleIdentifier), action: action)
        case let .window(info, _):
            captureWindow(info, action: action)
        case .color, .cancelled:
            break
        }
    }

    /// App owning the frontmost window at an AX point.
    private func appOwning(point: CGPoint) -> NSRunningApplication? {
        guard let w = ScreenGrabber.windowList().first(where: { $0.frame.contains(point) }) else { return nil }
        return NSRunningApplication(processIdentifier: w.pid)
    }

    // MARK: Fullscreen

    func captureFullscreen() {
        guard !isBusy, ScreenGrabber.ensurePermission() else { return }
        busy = true
        let all = settings.fullscreenAllDisplays
        let screens = all ? NSScreen.screens : [NSScreen.underMouse ?? NSScreen.main].compactMap { $0 }
        let front = NSWorkspace.shared.frontmostApplication
        Task { @MainActor in
            defer { self.busy = false }
            do {
                let snaps = try await ScreenGrabber.snapshot(screens: screens)
                let capture: CapturedImage?
                if snaps.count == 1, let s = snaps.first {
                    capture = CapturedImage(image: s.image, scale: s.scale, rect: s.axFrame, kind: .fullscreen,
                                            sourceAppName: front?.localizedName, sourceBundleID: front?.bundleIdentifier)
                } else {
                    capture = Self.composite(snaps).map {
                        CapturedImage(image: $0.0, scale: $0.1, rect: $0.2, kind: .fullscreen,
                                      sourceAppName: front?.localizedName, sourceBundleID: front?.bundleIdentifier)
                    }
                }
                if let capture { CaptureOutput.deliver(capture) }
            } catch {
                self.report(error)
            }
        }
    }

    /// All displays in one image at the highest scale, laid out as arranged.
    static func composite(_ snaps: [DisplaySnapshot]) -> (CGImage, CGFloat, CGRect)? {
        let c = ShotGeometry.canvas(for: snaps.map(\.axFrame), scales: snaps.map(\.scale))
        guard c.width > 0, c.height > 0,
              let ctx = CGContext(data: nil, width: c.width, height: c.height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: PixelFrame.colorSpace, bitmapInfo: PixelFrame.bitmapInfo) else { return nil }
        ctx.interpolationQuality = .high
        for s in snaps {
            let x = (s.axFrame.minX - c.union.minX) * c.scale
            let yTop = (s.axFrame.minY - c.union.minY) * c.scale
            let w = s.axFrame.width * c.scale, h = s.axFrame.height * c.scale
            ctx.draw(s.image, in: CGRect(x: x, y: CGFloat(c.height) - yTop - h, width: w, height: h))
        }
        return ctx.makeImage().map { ($0, c.scale, c.union) }
    }

    // MARK: Window

    func captureWindowPicker() {
        freeze(overlayOptions(.window)) { [weak self] outcome, front in
            self?.handleAreaOutcome(outcome, front: front, action: nil)
        }
    }

    func captureActiveWindow() {
        guard !isBusy, ScreenGrabber.ensurePermission() else { return }
        guard let w = ScreenGrabber.activeWindow() else {
            HUD.show("No active window", symbol: "macwindow")
            return
        }
        captureWindow(w, action: nil)
    }

    private func captureWindow(_ info: WindowInfo, action: ShotSettings.AfterCapture?) {
        busy = true
        let s = settings
        Task { @MainActor in
            defer { self.busy = false }
            do {
                let (raw, scale) = try await ScreenGrabber.captureWindow(id: info.id, shadow: s.windowShadow)
                let canvasPts = WindowComposer.canvasSize(window: CGSize(width: raw.width, height: raw.height), padding: s.windowPadding, scale: scale)
                let size = CGSize(width: canvasPts.width / scale, height: canvasPts.height / scale)
                let rect = CGRect(x: info.frame.midX - size.width / 2, y: info.frame.midY - size.height / 2, width: size.width, height: size.height)
                var wallpaper: CGImage?
                if s.windowBackground == .wallpaper { wallpaper = try? await ScreenGrabber.wallpaper(axRect: rect) }
                let color = ColorFormat.parseHex(s.windowBackgroundColor) ?? RGB8(r: 255, g: 255, b: 255)
                guard let image = WindowComposer.compose(window: raw, scale: scale, padding: s.windowPadding,
                                                         background: s.windowBackground, color: color, wallpaper: wallpaper) else { return }
                let app = NSRunningApplication(processIdentifier: info.pid)
                CaptureOutput.deliver(CapturedImage(image: image, scale: scale, rect: info.frame, kind: .window,
                                                    sourceAppName: app?.localizedName ?? info.appName, sourceBundleID: app?.bundleIdentifier), action: action)
            } catch {
                self.report(error)
            }
        }
    }

    // MARK: Repeat area

    func repeatArea() {
        guard let rect = LastArea.load() else {
            HUD.show("No previous area — select one", symbol: "rectangle.dashed")
            captureArea()
            return
        }
        guard !isBusy, ScreenGrabber.ensurePermission() else { return }
        busy = true
        let front = NSWorkspace.shared.frontmostApplication
        Task { @MainActor in
            defer { self.busy = false }
            do {
                let (image, scale) = try await ScreenGrabber.capture(axRect: rect)
                let app = self.appOwning(point: CGPoint(x: rect.midX, y: rect.midY)) ?? front
                CaptureOutput.deliver(CapturedImage(image: image, scale: scale, rect: rect, kind: .repeatArea,
                                                    sourceAppName: app?.localizedName, sourceBundleID: app?.bundleIdentifier))
            } catch {
                self.report(error)
            }
        }
    }

    // MARK: Delayed

    func delayedCapture(seconds: Int?) {
        guard !isBusy else { return }
        let delay = seconds ?? settings.delaySeconds
        Countdown.start(seconds: delay) { [weak self] fire in
            guard fire, let self else { return }
            switch self.settings.delayedTarget {
            case .area: self.captureArea()
            case .fullscreen: self.captureFullscreen()
            }
        }
    }

    // MARK: Scrolling

    func scrollingCapture(up: Bool) {
        guard Permissions.accessibility || settings.scrollMode == .manual else {
            Permissions.requestAccessibility()
            HUD.show("Scrolling capture needs Accessibility", symbol: "exclamationmark.triangle")
            return
        }
        let title = up ? "Scrolling Capture (Up)" : "Scrolling Capture"
        freeze(overlayOptions(.area, title: title, allowWindow: true, adjustable: false)) { [weak self] outcome, front in
            guard let self else { return }
            var region: CGRect?
            switch outcome {
            case let .area(snap, rect): region = ShotGeometry.globalRect(rect, in: snap.axFrame)
            case let .window(info, _): region = info.frame.intersection(NSScreen.containing(axRect: info.frame)?.axFrame ?? info.frame)
            default: break
            }
            guard let region, region.width >= 20, region.height >= 20 else { return }
            ScrollCaptureSession.start(region: region, up: up, settings: self.settings, sourceApp: front) { capture in
                if let capture { CaptureOutput.deliver(capture) }
            }
        }
    }

    // MARK: Text (OCR + QR)

    func copyText() {
        freeze(overlayOptions(.area, title: "Copy Text", allowWindow: true, adjustable: false)) { [weak self] outcome, _ in
            guard let self else { return }
            let image: CGImage?
            switch outcome {
            case let .area(snap, rect): image = snap.crop(local: rect)
            case let .window(info, snap?):
                // Recognize the window as it was on the frozen screen.
                let local = ShotGeometry.localRect(info.frame.intersection(snap.axFrame), in: snap.axFrame)
                image = snap.crop(local: local)
            default: image = nil
            }
            guard let image else { return }
            self.recognize(image)
        }
    }

    private func recognize(_ image: CGImage) {
        let keepBreaks = settings.ocrKeepLineBreaks
        HUD.show("Recognizing text…", symbol: "text.viewfinder", duration: 4)
        Task.detached(priority: .userInitiated) {
            let codes = TextRecognizer.barcodes(image)
            let text = (try? await OCRText.recognize(image)) ?? ""
            await MainActor.run {
                let pb = NSPasteboard.general
                if !codes.isEmpty {
                    pb.clearContents()
                    pb.setString(codes.joined(separator: "\n"), forType: .string)
                    let first = codes[0]
                    HUD.show("QR code copied: \(first.prefix(48))\(first.count > 48 ? "…" : "")", symbol: "qrcode.viewfinder", duration: 2)
                } else if !text.isEmpty {
                    let out = keepBreaks ? text : OCRText.joinLines(text)
                    pb.clearContents()
                    pb.setString(out, forType: .string)
                    let lines = text.split(separator: "\n").count
                    HUD.show(lines == 1 ? "Copied text" : "Copied \(lines) lines of text", symbol: "text.viewfinder")
                } else {
                    HUD.show("No text found", symbol: "text.viewfinder")
                }
            }
        }
    }

    // MARK: Colour

    func pickColor() {
        freeze(overlayOptions(.color, allowWindow: false)) { _, _ in }
    }
}

/// OCR text helpers.
enum OCRText {
    /// Recognizes text and rebuilds lines: Vision returns one observation per
    /// text run, so runs on the same baseline (e.g. table cells, "0001  text")
    /// are joined with spaces instead of newlines.
    static func recognize(_ image: CGImage) async throws -> String {
        try await withCheckedThrowingContinuation { cont in
            let request = VNRecognizeTextRequest { req, err in
                if let err { cont.resume(throwing: err); return }
                let runs = ((req.results as? [VNRecognizedTextObservation]) ?? []).compactMap { o -> OCRRun? in
                    guard let s = o.topCandidates(1).first?.string else { return nil }
                    // Vision boxes are normalized with a bottom-left origin; flip to top-down.
                    let b = o.boundingBox
                    return OCRRun(text: s, minX: b.minX, minY: 1 - b.maxY, maxY: 1 - b.minY)
                }
                cont.resume(returning: lines(runs))
            }
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true
            request.automaticallyDetectsLanguage = true
            do { try VNImageRequestHandler(cgImage: image).perform([request]) } catch { cont.resume(throwing: error) }
        }
    }

    struct OCRRun { var text: String; var minX: CGFloat; var minY: CGFloat; var maxY: CGFloat }

    /// Groups runs into lines (vertical overlap of at least half the smaller
    /// height), each line left to right, lines top to bottom.
    static func lines(_ runs: [OCRRun]) -> String {
        var lines: [[OCRRun]] = []
        for r in runs.sorted(by: { $0.minY < $1.minY }) {
            if let i = lines.lastIndex(where: { line in
                guard let f = line.first else { return false }
                let overlap = min(f.maxY, r.maxY) - max(f.minY, r.minY)
                return overlap >= 0.5 * min(f.maxY - f.minY, r.maxY - r.minY)
            }) {
                lines[i].append(r)
            } else {
                lines.append([r])
            }
        }
        return lines.map { $0.sorted { $0.minX < $1.minX }.map(\.text).joined(separator: " ") }.joined(separator: "\n")
    }

    /// Joins recognized lines into flowing text (Shottr's "remove line breaks"),
    /// keeping blank-line paragraph breaks and de-hyphenating wrapped words.
    static func joinLines(_ text: String) -> String {
        var out = ""
        for raw in text.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty {
                if !out.isEmpty && !out.hasSuffix("\n\n") { out += "\n\n" }
                continue
            }
            if out.isEmpty || out.hasSuffix("\n") {
                out += line
            } else if out.hasSuffix("-"), let last = out.dropLast().last, last.isLetter {
                out.removeLast()
                out += line
            } else {
                out += " " + line
            }
        }
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// The last selected area (for Repeat Last Area), kept across launches.
enum LastArea {
    private static var url: URL { AppPaths.support("shot").appendingPathComponent("last-area.json") }
    private static var cached: CGRect?

    static func save(_ r: CGRect) {
        cached = r
        let dict = ["x": r.minX, "y": r.minY, "w": r.width, "h": r.height]
        if let data = try? JSONSerialization.data(withJSONObject: dict) { try? data.write(to: url, options: .atomic) }
    }

    static func load() -> CGRect? {
        if let cached { return cached }
        guard let data = try? Data(contentsOf: url),
              let d = try? JSONSerialization.jsonObject(with: data) as? [String: Double],
              let x = d["x"], let y = d["y"], let w = d["w"], let h = d["h"], w >= 1, h >= 1 else { return nil }
        let r = CGRect(x: x, y: y, width: w, height: h)
        cached = r
        return r
    }
}
