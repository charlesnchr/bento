import Foundation
import Darwin

/// Independent nonblocking pipe transport. Foundation's async byte readers can
/// stall one another when a second subprocess has no stdout ready on this Mac.
final class PipeLineReader: @unchecked Sendable {
    private struct Line: Sendable {
        let text: String
        let byteCount: Int
    }
    private enum Failure: Error { case oversizedLine, backlog, invalidUTF8 }
    private let queue = DispatchQueue(label: "com.charles.bento.voice.pipe-reader", qos: .userInitiated)
    private let source: DispatchSourceRead
    private let descriptor: Int32
    private let stream: AsyncThrowingStream<Line, Error>
    private let continuation: AsyncThrowingStream<Line, Error>.Continuation
    // Mutable parser state is used only on this reader's private queue.
    private var pending = Data()
    private var queuedBytes = 0
    private let maxLineBytes = 4 * 1024 * 1024
    private let maxQueuedBytes = 8 * 1024 * 1024

    init(_ handle: FileHandle) throws {
        let fd = dup(handle.fileDescriptor)
        guard fd >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        let flags = fcntl(fd, F_GETFL)
        guard flags >= 0, fcntl(fd, F_SETFL, flags | O_NONBLOCK) >= 0,
              fcntl(fd, F_SETFD, FD_CLOEXEC) >= 0 else {
            let error = NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            Darwin.close(fd); throw error
        }
        descriptor = fd
        let pair = AsyncThrowingStream<Line, Error>.makeStream(bufferingPolicy: .bufferingOldest(128))
        stream = pair.stream; continuation = pair.continuation
        source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak self] in self?.readReady() }
        // Close only after the source has stopped touching the descriptor.
        // The duplicated handle lets callers close their FileHandle independently.
        source.setCancelHandler { Darwin.close(fd); pair.continuation.finish() }
        source.resume()
    }

    func readLines(_ receive: @Sendable (String) async -> Void) async throws {
        try await withTaskCancellationHandler {
            for try await line in stream {
                guard !Task.isCancelled else { break }
                queue.async { self.queuedBytes -= line.byteCount }
                await receive(line.text)
            }
        } onCancel: { self.cancel() }
    }

    func cancel() {
        continuation.finish()
        source.cancel()
    }

    deinit { cancel() }

    private func fail(_ error: Error) {
        continuation.finish(throwing: error)
        source.cancel()
    }

    private func emit(_ data: Data) -> Bool {
        let bytes = data.count + 1
        guard data.count <= maxLineBytes else { fail(Failure.oversizedLine); return false }
        guard queuedBytes + bytes <= maxQueuedBytes else { fail(Failure.backlog); return false }
        var content = data
        if content.last == 13 { content.removeLast() }
        guard let text = String(data: content, encoding: .utf8) else { fail(Failure.invalidUTF8); return false }
        queuedBytes += bytes
        switch continuation.yield(Line(text: text, byteCount: bytes)) {
        case .enqueued: return true
        case .dropped: fail(Failure.backlog); return false
        case .terminated: source.cancel(); return false
        @unknown default: fail(Failure.backlog); return false
        }
    }

    private func readReady() {
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        // Bound each callback so cancellation can run even with continuous output.
        for _ in 0..<4 {
            guard !source.isCancelled else { return }
            let count = buffer.withUnsafeMutableBytes { Darwin.read(descriptor, $0.baseAddress, $0.count) }
            if count < 0 {
                if errno == EINTR { continue }
                if errno == EAGAIN || errno == EWOULDBLOCK { return }
                fail(NSError(domain: NSPOSIXErrorDomain, code: Int(errno))); return
            }
            if count == 0 {
                if !pending.isEmpty, !emit(pending) { return }
                pending.removeAll(); continuation.finish(); source.cancel(); return
            }
            pending.append(contentsOf: buffer.prefix(count))
            while let newline = pending.firstIndex(of: 10) {
                guard emit(Data(pending[..<newline])) else { return }
                pending.removeSubrange(...newline)
            }
            guard pending.count <= maxLineBytes else { fail(Failure.oversizedLine); return }
        }
    }
}
