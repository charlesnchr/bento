import Foundation

/// Serial AX action work. Cancellation prevents queued or frame-reading work
/// from performing an action; stopping drains any action already begun.
final class ItemWorkQueue {
    struct Token {
        fileprivate let owner: ItemWorkQueue
        fileprivate let generation: Int
        var isCancelled: Bool { owner.isCancelled(self) }
    }

    private let queue: DispatchQueue
    private let lock = NSLock()
    private var generation = 0
    private var stopped = false

    init(label: String) { queue = DispatchQueue(label: label, qos: .userInitiated) }

    private func isCancelled(_ token: Token) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopped || generation != token.generation
    }

    @discardableResult
    func submit(_ body: @escaping (Token) -> Void) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !stopped else { return false }
        let token = Token(owner: self, generation: generation)
        queue.async { body(token) }
        return true
    }

    func cancelAll() {
        lock.lock()
        generation += 1
        lock.unlock()
    }

    func finish() {
        lock.lock()
        stopped = true
        generation += 1
        lock.unlock()
        queue.sync {}
    }
}
