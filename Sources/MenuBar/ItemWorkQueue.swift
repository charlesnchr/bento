import Foundation

/// Serial input work with interruptible waits. A stop is acknowledged only
/// after the worker has unwound (including releasing any held input).
final class ItemWorkQueue {
    struct Token {
        fileprivate let owner: ItemWorkQueue
        fileprivate let generation: Int
        fileprivate let deadline: DispatchTime

        var isCancelled: Bool { owner.isCancelled(self) }

        @discardableResult
        func wait(_ seconds: TimeInterval) -> Bool {
            let end = min(DispatchTime.now() + seconds, deadline)
            owner.condition.lock()
            defer { owner.condition.unlock() }
            while owner.generation == generation, DispatchTime.now() < end {
                let remaining = (Double(end.uptimeNanoseconds) - Double(DispatchTime.now().uptimeNanoseconds)) / 1e9
                _ = owner.condition.wait(until: Date(timeIntervalSinceNow: max(0, remaining)))
            }
            return owner.generation == generation && DispatchTime.now() < deadline
        }
    }

    private let queue: DispatchQueue
    private let condition = NSCondition()
    private var generation = 0
    private var stopped = false

    init(label: String) { queue = DispatchQueue(label: label, qos: .userInitiated) }

    private func isCancelled(_ token: Token) -> Bool {
        condition.lock()
        defer { condition.unlock() }
        return generation != token.generation || DispatchTime.now() >= token.deadline
    }

    /// Returns false once closed; queued jobs still run to deliver cancellation.
    @discardableResult
    func submit(_ body: @escaping (Token) -> Void) -> Bool {
        condition.lock()
        defer { condition.unlock() }
        guard !stopped else { return false }
        let token = Token(owner: self, generation: generation, deadline: .distantFuture)
        queue.async { body(token) }
        return true
    }

    func drain() { queue.sync {} }

    func cancelAll() {
        condition.lock()
        generation += 1
        condition.broadcast()
        condition.unlock()
    }

    /// Closes admission, cancels pending work, then drains even when there is
    /// no final batch. The deadline governs the final worker, not just a wait
    /// on its caller. Synchronous because module stop also runs at termination.
    func finish(timeout: TimeInterval = 0, _ final: (Token) -> Void = { _ in }) {
        condition.lock()
        let alreadyStopped = stopped
        stopped = true
        generation += 1
        let token = Token(owner: self, generation: generation, deadline: .now() + max(0, timeout))
        condition.broadcast()
        condition.unlock()
        queue.sync {
            if !alreadyStopped, !token.isCancelled { final(token) }
        }
    }
}
