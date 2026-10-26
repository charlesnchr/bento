import AppKit
import Foundation

@MainActor
final class AssistantRemoteImage: ObservableObject {
    @Published private(set) var image: NSImage?
    @Published private(set) var loading = false
    @Published private(set) var error: String?
    private var task: Task<Void, Never>?
    private var deadline: Task<Void, Never>?
    private var requestID: UUID?
    private let session: URLSession
    private let timeout: TimeInterval

    init(session: URLSession = .shared, timeout: TimeInterval = 25) {
        self.session = session
        self.timeout = timeout
    }

    func loadIfNeeded(_ url: URL) {
        guard image == nil, error == nil else { return }
        load(url)
    }

    func cancel() {
        guard let id = requestID else { return }
        task?.cancel()
        finish(id, error: "Image loading cancelled.")
    }

    func load(_ url: URL) {
        guard !loading, url.scheme == "https", url.user == nil, url.password == nil else { return }
        loading = true
        error = nil
        image = nil
        let id = UUID()
        requestID = id
        deadline = Task {
            do { try await Task.sleep(for: .seconds(timeout)) } catch { return }
            guard requestID == id else { return }
            task?.cancel()
            finish(id, error: "The image took too long to load. Try again.")
        }
        task = Task {
            do {
                let data = try await Self.download(url, session: session, timeout: timeout)
                guard requestID == id else { return }
                guard let decoded = NSImage(data: data), decoded.size.width > 0, decoded.size.height > 0 else { throw Failure("The downloaded image could not be decoded") }
                image = decoded
                finish(id)
            } catch { finish(id, error: error.localizedDescription) }
        }
    }

    private func finish(_ id: UUID, error: String? = nil) {
        guard requestID == id else { return }
        requestID = nil
        self.error = error
        loading = false
        deadline?.cancel()
        deadline = nil
        task = nil
    }

    // Consume the response off the main actor; the UI deadline also bounds trickling responses.
    nonisolated private static func download(_ url: URL, session: URLSession, timeout: TimeInterval) async throws -> Data {
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.setValue("image/*", forHTTPHeaderField: "Accept")
        let (bytes, response) = try await session.bytes(for: request)
        guard let response = response as? HTTPURLResponse else { throw Failure("No image response") }
        guard (200..<300).contains(response.statusCode) else { throw Failure("Server returned HTTP \(response.statusCode)") }
        guard response.mimeType?.hasPrefix("image/") == true else { throw Failure("This URL returned a webpage, not an image") }
        guard response.expectedContentLength <= 12_000_000 else { throw Failure("Image exceeds 12 MB") }
        var data = Data()
        for try await byte in bytes {
            try Task.checkCancellation()
            guard data.count < 12_000_000 else { throw Failure("Image exceeds 12 MB") }
            data.append(byte)
        }
        return data
    }

    private struct Failure: LocalizedError {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }
}
