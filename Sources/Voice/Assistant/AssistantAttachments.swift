import AppKit
import UniformTypeIdentifiers

@MainActor
enum AssistantAttachments {
    static func image(_ image: NSImage, name: String) -> AssistantAttachment? {
        guard let (data, mime) = encode(image) else { return nil }
        return AssistantAttachment(kind: .image, name: name, mime: mime, data: data.base64EncodedString())
    }

    static func file(_ url: URL) -> AssistantAttachment? {
        guard url.isFileURL else { return nil }
        if UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) == true, let picture = NSImage(contentsOf: url) {
            return image(picture, name: url.lastPathComponent)
        }
        return AssistantAttachment(kind: .file, name: url.lastPathComponent, path: url.path)
    }

    static func text(_ text: String, name: String) -> AssistantAttachment {
        AssistantAttachment(kind: .text, name: name, text: String(text.prefix(100_000)))
    }

    /// Files and images on a pasteboard. Text pastes stay ordinary text unless nothing else is there.
    static func pasteboard(_ pasteboard: NSPasteboard) -> [AssistantAttachment]? {
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            return urls.prefix(10).compactMap(file)
        }
        if pasteboard.string(forType: .string) != nil { return nil }
        if let picture = NSImage(pasteboard: pasteboard) { return image(picture, name: "Pasted image").map { [$0] } }
        return nil
    }

    static func load(_ providers: [NSItemProvider]) async -> [AssistantAttachment] {
        var result: [AssistantAttachment] = []
        for provider in providers.prefix(10) {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                let url: URL? = await withCheckedContinuation { continuation in
                    provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier) { item, _ in
                        continuation.resume(returning: (item as? Data).flatMap { URL(dataRepresentation: $0, relativeTo: nil) } ?? item as? URL)
                    }
                }
                if let url, let attachment = file(url) { result.append(attachment) }
            } else if provider.canLoadObject(ofClass: NSImage.self) {
                let data: Data? = await withCheckedContinuation { continuation in
                    _ = provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in continuation.resume(returning: data) }
                }
                if let data, let picture = NSImage(data: data), let attachment = image(picture, name: "Dropped image") { result.append(attachment) }
            }
        }
        return result
    }

    /// At most 2048 px on the long side; PNG when small enough, otherwise JPEG.
    private static func encode(_ image: NSImage) -> (Data, String)? {
        guard let source = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
        let scale = min(1, 2048 / CGFloat(max(source.width, source.height)))
        let width = max(1, Int(CGFloat(source.width) * scale)), height = max(1, Int(CGFloat(source.height) * scale))
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.interpolationQuality = .high
        context.draw(source, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let scaled = context.makeImage() else { return nil }
        let bitmap = NSBitmapImageRep(cgImage: scaled)
        if let png = bitmap.representation(using: .png, properties: [:]), png.count <= 4_000_000 { return (png, "image/png") }
        return bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.82]).map { ($0, "image/jpeg") }
    }
}
