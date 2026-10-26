import Foundation

/// A voice conversation is time-scoped, never scoped to an application.
public struct AssistantSessionClock {
    public let timeout: TimeInterval
    private var lastActivity: TimeInterval?
    public init(timeout: TimeInterval = 600) { self.timeout = timeout }
    public func needsFreshSession(at time: TimeInterval) -> Bool {
        guard let lastActivity else { return true }
        return time < lastActivity || time - lastActivity >= timeout
    }
    public mutating func touch(at time: TimeInterval) { lastActivity = time }
    public mutating func reset() { lastActivity = nil }
}
