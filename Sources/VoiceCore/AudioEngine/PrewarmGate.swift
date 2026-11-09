import Foundation

/// Decides when the idle, speculative capture-graph build may run. Pure state,
/// no HAL: the pool feeds it events and a clock, so every rule here is tested.
///
/// Why it exists (gskm4, 2026-11-09): a prewarm build's `engine.inputNode`
/// never returned. AVFAudio sat in `AVAudioIOUnit_OSX::_GetHWFormat`, re-reading
/// the default input's subdevices from coreaudiod in a loop, while the engine's
/// own configuration-change block waited on the lock that loop held. It spun
/// for four days at ~35% CPU and dragged coreaudiod to ~70%. The build had
/// raced a device change, so a speculative build now only starts once the HAL
/// has been quiet for `quietPeriod`, never beside a running capture, never
/// twice at once, and its result is thrown away if the HAL moved while it ran.
public struct PrewarmGate: Sendable {
    public enum Decision: Equatable, Sendable {
        case build
        /// Ask again after this many seconds: the HAL is not quiet yet.
        case wait(TimeInterval)
        case hold(Hold)
    }

    public enum Hold: String, Sendable {
        /// Another mode (a voice call) owns the audio route.
        case suspended
        /// A dictation is capturing: never build beside a running engine.
        case captureActive
        /// One build at a time; a second one would race the first in AVFAudio.
        case building
        /// A spare is ready.
        case warm
        /// The last build was skipped by preflight or failed. Wait for the HAL
        /// to report a change rather than retrying against the same device.
        case unsettled
        /// A build hung; prewarming stays off (see BuildWatchdog).
        case disabled
    }

    public let quietPeriod: TimeInterval
    public private(set) var lastActivity: TimeInterval
    public private(set) var suspended = false
    public private(set) var captureActive = false
    public private(set) var building = false
    public private(set) var hasSpare = false
    public private(set) var disabled = false
    private var unsettled = false
    private var activityDuringBuild = false

    /// `now` counts as activity, so the first build after launch also waits for
    /// a quiet HAL: login is when virtual and Bluetooth devices appear.
    public init(quietPeriod: TimeInterval = 2, now: TimeInterval) {
        self.quietPeriod = quietPeriod
        lastActivity = now
    }

    public func decide(at now: TimeInterval) -> Decision {
        if disabled { return .hold(.disabled) }
        if suspended { return .hold(.suspended) }
        if captureActive { return .hold(.captureActive) }
        if building { return .hold(.building) }
        if hasSpare { return .hold(.warm) }
        if unsettled { return .hold(.unsettled) }
        let quiet = now - lastActivity
        return quiet >= quietPeriod ? .build : .wait(quietPeriod - quiet)
    }

    /// Any HAL change: a device appearing, a default moving, a format changing.
    public mutating func noteActivity(at now: TimeInterval) {
        lastActivity = max(lastActivity, now)
        unsettled = false
        if building { activityDuringBuild = true }
    }

    public mutating func setSuspended(_ value: Bool) { suspended = value }
    public mutating func setCaptureActive(_ value: Bool) { captureActive = value }
    public mutating func spareGone() { hasSpare = false }
    public mutating func disable() { disabled = true; hasSpare = false }
    /// Only for a cooldown inherited from an earlier process. A build stuck in
    /// this one is still running (`building` stays set), so nothing starts.
    public mutating func enable() { disabled = false }

    public mutating func buildStarted() {
        building = true
        activityDuringBuild = false
    }

    public enum Outcome: Equatable, Sendable {
        case built
        /// Preflight said the default input is mid-change or missing parts.
        case unsettled
        case failed
    }

    /// Whether the finished build may be kept as the spare. A build that
    /// overlapped HAL activity targets a route that may no longer exist, and
    /// one that lands after suspend or a hang is not wanted at all.
    public mutating func buildFinished(_ outcome: Outcome) -> Bool {
        building = false
        // A failure that overlapped a change says nothing about the new route:
        // retry once it is quiet. One that did not would only fail again.
        if outcome != .built, !activityDuringBuild { unsettled = true }
        let keep = outcome == .built && !activityDuringBuild && !suspended && !disabled
        activityDuringBuild = false
        hasSpare = keep
        return keep
    }
}

/// Times one graph build. A hung `engine.inputNode` cannot be cancelled from
/// inside the process and keeps coreaudiod busy for as long as it spins, so
/// the verdict has to reach someone who can end the process.
public struct BuildWatchdog: Sendable {
    public enum Verdict: Equatable, Sendable {
        case slow(TimeInterval)
        case hung(TimeInterval)
    }

    /// Builds take 75–135ms, a cold Bluetooth route a few hundred.
    public let slowAfter: TimeInterval
    /// Nothing legitimate takes this long; the 2026-11-09 hang never ended.
    public let hungAfter: TimeInterval
    private var startedAt: TimeInterval?
    private var saidSlow = false
    public private(set) var hung = false

    public init(slowAfter: TimeInterval = 1, hungAfter: TimeInterval = 10) {
        self.slowAfter = slowAfter
        self.hungAfter = hungAfter
    }

    public var isTiming: Bool { startedAt != nil }

    public mutating func begin(at now: TimeInterval) {
        startedAt = now
        saidSlow = false
        hung = false
    }

    /// Each verdict is reported at most once per build.
    public mutating func check(at now: TimeInterval) -> Verdict? {
        guard let startedAt else { return nil }
        let elapsed = now - startedAt
        if elapsed >= hungAfter, !hung {
            hung = true
            saidSlow = true
            return .hung(elapsed)
        }
        if elapsed >= slowAfter, !saidSlow {
            saidSlow = true
            return .slow(elapsed)
        }
        return nil
    }

    /// The build's duration, or nil when nothing was being timed.
    public mutating func finish(at now: TimeInterval) -> TimeInterval? {
        guard let startedAt else { return nil }
        self.startedAt = nil
        return now - startedAt
    }
}

/// Remembers a prewarm hang across the relaunch that recovers from it, so the
/// new process does not walk straight back into the same HAL state.
public struct PrewarmHangRecord: Sendable {
    public static let cooldown: TimeInterval = 24 * 60 * 60
    private static let key = "prewarmHangAt"
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    public func record(at date: Date) {
        defaults.set(date.timeIntervalSince1970, forKey: Self.key)
    }

    /// The last hang, if it was within `cooldown` of `now`.
    public func recentHang(now: Date) -> Date? {
        let stamp = defaults.double(forKey: Self.key)
        guard stamp > 0 else { return nil }
        let date = Date(timeIntervalSince1970: stamp)
        return now.timeIntervalSince(date) < Self.cooldown ? date : nil
    }
}
