import AppKit
import SwiftUI
import QuickLookThumbnailing
import UniformTypeIdentifiers
import BentoCore

/// Right-hand side of the panel: large preview + Raycast-style information.
struct PreviewPane: View {
    @ObservedObject var model: PanelModel

    var body: some View {
        if let d = model.detail {
            VStack(spacing: 0) {
                content(d)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                Divider()
                InfoView(detail: d, store: model.store)
            }
            .id(d.id)
        } else {
            Color.clear
        }
    }

    @ViewBuilder
    private func content(_ d: ClipDetail) -> some View {
        switch d.kind {
        case .text:
            TextPreview(detail: d)
        case .image:
            if let url = model.store.imageURL(d.imageFile) {
                ImagePreview(url: url, pixelSize: CGSize(width: d.row.width, height: d.row.height),
                             placeholder: ImageCache.shared.get("thumb:\(d.row.thumbFile ?? "")"))
            }
        case .file:
            FilePreview(urls: d.fileURLs)
        case .link:
            LinkPreview(detail: d)
        case .color:
            ColorPreview(text: d.text ?? "")
        }
    }
}

// MARK: - Text

struct TextPreview: NSViewRepresentable {
    let detail: ClipDetail
    static let limit = 150_000

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        if let tv = scroll.documentView as? NSTextView {
            tv.isEditable = false
            tv.isSelectable = true
            tv.drawsBackground = false
            tv.isRichText = true
            tv.textContainerInset = NSSize(width: 12, height: 12)
            tv.usesAdaptiveColorMappingForDarkAppearance = true
            tv.textStorage?.setAttributedString(Self.attributed(detail))
        }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {}

    static func attributed(_ d: ClipDetail) -> NSAttributedString {
        let text = d.text ?? ""
        let mono = ContentDetection.looksLikeCode(text)
        if !mono, let rtf = d.rtf, rtf.count < 3_000_000,
           let a = NSAttributedString(rtf: rtf, documentAttributes: nil), a.length > 0 {
            if a.length <= limit { return a }
            return a.attributedSubstring(from: NSRange(location: 0, length: limit))
        }
        let p = NSMutableParagraphStyle()
        p.lineSpacing = mono ? 1.5 : 2
        let font = mono ? NSFont.monospacedSystemFont(ofSize: 12, weight: .regular) : NSFont.systemFont(ofSize: 13)
        let truncated = text.utf16.count > limit
        let body = truncated ? String(text.prefix(limit)) + "\n\n… (preview truncated)" : text
        return NSAttributedString(string: body, attributes: [.font: font, .foregroundColor: NSColor.labelColor, .paragraphStyle: p])
    }
}

// MARK: - Image

struct ImagePreview: View {
    let url: URL
    let pixelSize: CGSize
    /// Shown until the preview is decoded (the row's thumbnail).
    var placeholder: NSImage?
    @State private var image: NSImage?
    @State private var failed = false

    /// Scrolling captures and other very tall images scroll at a readable width.
    private var isTall: Bool { pixelSize.width > 0 && pixelSize.height / pixelSize.width > 2.5 }

    var body: some View {
        GeometryReader { geo in
            let width = max(geo.size.width - 32, 1), height = max(geo.size.height - 32, 1)
            Group {
                if let image, isTall {
                    ScrollView(.vertical) {
                        styled(image)
                            .frame(width: min(width, max(pixelSize.width / 2, 1)))
                            .padding(16)
                            .frame(maxWidth: .infinity)
                    }
                } else if let shown = image ?? (failed ? nil : placeholder) {
                    styled(shown)
                        .frame(maxWidth: min(width, max(pixelSize.width, 1)), maxHeight: min(height, max(pixelSize.height, 1)))
                        .frame(width: geo.size.width, height: geo.size.height)
                } else if failed {
                    VStack(spacing: 6) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 28, weight: .light))
                            .foregroundStyle(.tertiary)
                        Text(FileManager.default.fileExists(atPath: url.path) ? "Cannot read this image" : "Image file is missing")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                    }
                    .frame(width: geo.size.width, height: geo.size.height)
                } else {
                    ProgressView().controlSize(.small)
                        .frame(width: geo.size.width, height: geo.size.height)
                }
            }
        }
        .task(id: url) {
            // While the selection races past (arrow key held), previews that
            // are replaced within this moment are never decoded.
            try? await Task.sleep(nanoseconds: 90_000_000)
            guard !Task.isCancelled else { return }
            let u = url
            // Tall images: decode by width (~1000 px), bounded at 6000 px tall.
            let maxPixels = isTall ? Int(min(6000, 1000 * pixelSize.height / max(pixelSize.width, 1))) : 1400
            let cg = await Task.detached(priority: .userInitiated) { ImageProcessor.downsampled(u, maxPixels: maxPixels) }.value
            guard !Task.isCancelled else { return }
            if let cg { image = NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height)) } else { failed = true }
        }
    }

    private func styled(_ image: NSImage) -> some View {
        Image(nsImage: image)
            .resizable()
            .interpolation(.high)
            .aspectRatio(contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .shadow(color: .black.opacity(0.15), radius: 4, y: 1)
    }
}

// MARK: - Files

struct FilePreview: View {
    let urls: [URL]

    static func pixelSize(_ url: URL) -> CGSize {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return CGSize(width: 4000, height: 4000) }
        let (w, h) = ImageProcessor.pixelSize(src, 0)
        return CGSize(width: w, height: h)
    }

    var body: some View {
        if urls.count == 1, let url = urls.first {
            VStack(spacing: 12) {
                if UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) == true,
                   FileManager.default.fileExists(atPath: url.path) {
                    ImagePreview(url: url, pixelSize: Self.pixelSize(url))
                } else {
                    QLThumbnail(url: url)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .padding(.top, 16)
                }
                VStack(spacing: 3) {
                    Text(url.lastPathComponent)
                        .font(.system(size: 13, weight: .semibold))
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                    Text((url.deletingLastPathComponent().path as NSString).abbreviatingWithTildeInPath)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 14)
            }
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    ForEach(urls, id: \.self) { url in
                        HStack(spacing: 8) {
                            Image(nsImage: ImageCache.shared.fileIcon(url.path))
                                .resizable()
                                .frame(width: 24, height: 24)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(url.lastPathComponent).font(.system(size: 12, weight: .medium)).lineLimit(1)
                                Text((url.deletingLastPathComponent().path as NSString).abbreviatingWithTildeInPath)
                                    .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                            }
                        }
                    }
                }
                .padding(14)
            }
        }
    }
}

/// Quick Look thumbnail with the file icon as fallback.
struct QLThumbnail: View {
    let url: URL
    @State private var thumb: NSImage?

    var body: some View {
        Image(nsImage: thumb ?? ImageCache.shared.fileIcon(url.path))
            .resizable()
            .interpolation(.high)
            .aspectRatio(contentMode: .fit)
            .frame(maxWidth: 160, maxHeight: 160)
            .task(id: url) {
                guard FileManager.default.fileExists(atPath: url.path) else { return }
                let req = QLThumbnailGenerator.Request(fileAt: url, size: CGSize(width: 160, height: 160),
                                                       scale: NSScreen.main?.backingScaleFactor ?? 2, representationTypes: .thumbnail)
                if let rep = try? await QLThumbnailGenerator.shared.generateBestRepresentation(for: req) {
                    thumb = rep.nsImage
                }
            }
    }
}

// MARK: - Link

struct LinkPreview: View {
    let detail: ClipDetail

    var body: some View {
        let text = detail.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let url = ContentDetection.linkURL(text)
        VStack(spacing: 14) {
            Spacer(minLength: 0)
            ZStack {
                Circle().fill(Color.accentColor.opacity(0.14))
                Image(systemName: url?.scheme == "mailto" ? "envelope" : "link")
                    .font(.system(size: 26, weight: .medium))
                    .foregroundStyle(Color.accentColor)
            }
            .frame(width: 64, height: 64)
            VStack(spacing: 6) {
                if let title = detail.linkTitle {
                    Text(title)
                        .font(.system(size: 15, weight: .semibold))
                        .multilineTextAlignment(.center)
                        .lineLimit(3)
                }
                Text(text)
                    .font(.system(size: 12))
                    .foregroundStyle(Color.accentColor)
                    .multilineTextAlignment(.center)
                    .lineLimit(5)
                    .textSelection(.enabled)
            }
            Spacer(minLength: 0)
        }
        .padding(20)
    }
}

// MARK: - Colour

struct ColorPreview: View {
    let text: String

    var body: some View {
        if let c = ContentDetection.parseColor(text) {
            VStack(spacing: 14) {
                ZStack {
                    // Checkerboard shows through translucent colours.
                    Checkerboard().clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color(nsColor: c.nsColor))
                    Text(c.hex)
                        .font(.system(size: 20, weight: .semibold, design: .monospaced))
                        .foregroundStyle(c.isLight || c.a < 0.5 ? Color.black.opacity(0.75) : Color.white.opacity(0.9))
                }
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.primary.opacity(0.12), lineWidth: 0.5))
                .frame(maxHeight: 170)
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                    row("HEX", c.hex)
                    row("RGB", c.rgbString)
                    row("HSL", c.hslString)
                }
                .font(.system(size: 12, design: .monospaced))
            }
            .padding(20)
        } else {
            Text(text).padding(20)
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary)
            Text(value).textSelection(.enabled)
        }
    }
}

struct Checkerboard: View {
    var body: some View {
        Canvas { ctx, size in
            let s: CGFloat = 8
            for y in stride(from: 0, to: size.height, by: s) {
                for x in stride(from: 0, to: size.width, by: s) where (Int(x / s) + Int(y / s)) % 2 == 0 {
                    ctx.fill(Path(CGRect(x: x, y: y, width: s, height: s)), with: .color(.gray.opacity(0.25)))
                }
            }
        }
    }
}

// MARK: - Information

struct InfoView: View {
    let detail: ClipDetail
    let store: ClipStore
    /// Counting words in megabytes of text takes ~0.5 s: big texts are
    /// counted off the main thread.
    @State private var largeStats: ContentDetection.TextStats?
    static let syncStatsLimit = 100_000

    struct Item: Identifiable {
        let id = UUID()
        let label: String
        let value: String
        var icon: NSImage?
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Information")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
                .padding(.bottom, 4)
            ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
                if i > 0 { Divider().opacity(0.6) }
                HStack(spacing: 6) {
                    Text(item.label).foregroundStyle(.secondary)
                    Spacer(minLength: 12)
                    if let icon = item.icon {
                        Image(nsImage: icon).resizable().frame(width: 14, height: 14)
                    }
                    Text(item.value)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                }
                .font(.system(size: 12))
                .padding(.vertical, 4)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .task(id: detail.id) {
            guard detail.kind == .text, let text = detail.text, !Self.isSmall(text) else { return }
            let s = await Task.detached(priority: .userInitiated) { ContentDetection.stats(text) }.value
            if !Task.isCancelled { largeStats = s }
        }
    }

    private static func isSmall(_ text: String) -> Bool { text.utf8.count <= syncStatsLimit }

    private var items: [Item] {
        var out: [Item] = []
        let d = detail
        out.append(Item(label: "Source", value: d.row.sourceApp ?? "Unknown",
                        icon: ImageCache.shared.appIcon(d.row.sourceBundleID)))
        switch d.kind {
        case .text:
            let text = d.text ?? ""
            let s = Self.isSmall(text) ? ContentDetection.stats(text) : largeStats
            let type = d.rtf != nil || d.html != nil ? "Rich Text" : (ContentDetection.looksLikeCode(text) ? "Code" : "Text")
            out.append(Item(label: "Content type", value: type))
            out.append(Item(label: "Characters", value: s?.characters.formatted() ?? "Counting…"))
            out.append(Item(label: "Words · Lines", value: s.map { "\($0.words.formatted()) · \($0.lines.formatted())" } ?? "Counting…"))
        case .image:
            out.append(Item(label: "Content type", value: "Image (\(Self.format(d.imageType)))"))
            out.append(Item(label: "Dimensions", value: "\(d.row.width) × \(d.row.height) px"))
            let size = store.imageURL(d.imageFile).flatMap { try? $0.resourceValues(forKeys: [.fileSizeKey]).fileSize } ?? d.byteSize
            out.append(Item(label: "Image size", value: ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)))
            if d.ocrDone, let t = d.ocrText, !t.isEmpty {
                out.append(Item(label: "Recognised text", value: "\(ContentDetection.stats(t).words.formatted()) words"))
            }
        case .file:
            let urls = d.fileURLs
            if urls.count == 1, let url = urls.first {
                let vals = try? url.resourceValues(forKeys: [.fileSizeKey, .localizedTypeDescriptionKey, .isDirectoryKey])
                out.append(Item(label: "Content type", value: vals?.localizedTypeDescription ?? (FileManager.default.fileExists(atPath: url.path) ? "File" : "Missing file")))
                if let size = vals?.fileSize, vals?.isDirectory != true {
                    out.append(Item(label: "File size", value: ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)))
                }
                out.append(Item(label: "Path", value: (url.path as NSString).abbreviatingWithTildeInPath))
            } else {
                out.append(Item(label: "Content type", value: "\(urls.count) Files"))
            }
        case .link:
            out.append(Item(label: "Content type", value: "Link"))
            if let url = ContentDetection.linkURL(d.text ?? ""), let domain = ContentDetection.domain(of: url) {
                out.append(Item(label: "Domain", value: domain))
            }
        case .color:
            out.append(Item(label: "Content type", value: "Colour"))
        }
        out.append(Item(label: "Times copied", value: d.copyCount.formatted()))
        out.append(Item(label: "Last copied", value: RelativeTime.long.string(from: d.row.lastCopied)))
        if d.copyCount > 1 {
            out.append(Item(label: "First copied", value: RelativeTime.long.string(from: d.firstCopied)))
        }
        return out
    }

    static func format(_ type: String?) -> String {
        guard let type, let ut = UTType(type) else { return "Unknown" }
        return ut.preferredFilenameExtension?.uppercased() ?? ut.localizedDescription ?? type
    }
}
