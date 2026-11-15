import CoreGraphics
import Foundation
import BentoCore

/// Reads and writes the scroll distances of a `CGEvent`.
enum ScrollEventIO {
    static func values(of event: CGEvent) -> ScrollValues {
        ScrollValues(
            vertical: AxisDeltas(lines: event.getIntegerValueField(.scrollWheelEventDeltaAxis1),
                                 fixed: event.getDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1),
                                 points: event.getIntegerValueField(.scrollWheelEventPointDeltaAxis1)),
            horizontal: AxisDeltas(lines: event.getIntegerValueField(.scrollWheelEventDeltaAxis2),
                                   fixed: event.getDoubleValueField(.scrollWheelEventFixedPtDeltaAxis2),
                                   points: event.getIntegerValueField(.scrollWheelEventPointDeltaAxis2)))
    }

    /// Setting a whole-line delta makes Core Graphics recompute the other two
    /// forms from it, so the lines go in first and the others after.
    static func write(_ v: ScrollValues, to event: CGEvent) {
        event.setIntegerValueField(.scrollWheelEventDeltaAxis1, value: v.vertical.lines)
        event.setIntegerValueField(.scrollWheelEventDeltaAxis2, value: v.horizontal.lines)
        event.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1, value: v.vertical.fixed)
        event.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis2, value: v.horizontal.fixed)
        event.setIntegerValueField(.scrollWheelEventPointDeltaAxis1, value: v.vertical.points)
        event.setIntegerValueField(.scrollWheelEventPointDeltaAxis2, value: v.horizontal.points)
    }

    static func isContinuous(_ event: CGEvent) -> Bool {
        event.getIntegerValueField(.scrollWheelEventIsContinuous) != 0
    }

    /// True for an event another program posted (Bento's own scrolling
    /// capture, a scroll smoother), as opposed to one from a device.
    static func isSynthetic(_ event: CGEvent) -> Bool {
        event.getIntegerValueField(.eventSourceUnixProcessID) != 0
    }
}

/// The registry id of the HID service a `CGEvent` came from. Core Graphics
/// keeps the HID event it was made from; neither function that gets at it is
/// in the SDK headers, so both are looked up at run time, and without them
/// (or for an event that has no HID event) the answer is nil.
enum EventSender {
    private typealias CopyHIDEvent = @convention(c) (CGEvent) -> Unmanaged<CFTypeRef>?
    private typealias GetSenderID = @convention(c) (CFTypeRef) -> UInt64

    private static let copyHIDEvent: CopyHIDEvent? = lookup("CGEventCopyIOHIDEvent")
    private static let getSenderID: GetSenderID? = lookup("IOHIDEventGetSenderID")

    private static func lookup<T>(_ name: String) -> T? {
        dlsym(UnsafeMutableRawPointer(bitPattern: -2), name).map { unsafeBitCast($0, to: T.self) }
    }

    static var isAvailable: Bool { copyHIDEvent != nil && getSenderID != nil }

    static func id(of event: CGEvent) -> UInt64? {
        guard let copyHIDEvent, let getSenderID, let hid = copyHIDEvent(event)?.takeRetainedValue() else { return nil }
        let id = getSenderID(hid)
        return id == 0 ? nil : id
    }
}

/// The event tap that reverses and scales scroll events. It runs on its own
/// thread, so a busy main thread never delays scrolling, and exists only
/// while some rule changes something.
final class ScrollTap {
    struct Stats: Equatable {
        /// Scroll events from devices.
        var seen = 0
        /// Of those, the ones that named a known device.
        var bySender = 0
        /// Of those, the ones a rule changed.
        var changed = 0
        /// Events other programs posted, passed through untouched.
        var synthetic = 0
        /// Times macOS switched the tap off and it was switched back on.
        var reenabled = 0
    }

    private let lock = NSLock()
    private var table: ScrollTable
    /// Counts the tables, so the tap thread sees a change without comparing them.
    private var generation = 0
    private var stats = Stats()
    private var port: CFMachPort?
    private var runLoop: CFRunLoop?
    private var stopRequested = false
    private var failed = false
    /// Called on the main queue, with this tap, if it can't be created.
    private let onFailure: (ScrollTap) -> Void

    // Tap thread only.
    private var scalers: [UInt64: ScrollScaler] = [:]
    private var scalerGeneration = -1

    init(table: ScrollTable, onFailure: @escaping (ScrollTap) -> Void) {
        self.table = table
        self.onFailure = onFailure
    }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    func update(_ table: ScrollTable) {
        locked {
            guard table != self.table else { return }
            self.table = table
            generation += 1
        }
    }

    var currentStats: Stats { locked { stats } }
    var isRunning: Bool { locked { port != nil && !stopRequested } }

    func start() {
        let thread = Thread { [self] in run() }
        thread.name = "bento.mouse.scroll-tap"
        thread.qualityOfService = .userInteractive
        thread.start()
    }

    func stop() {
        let rl: CFRunLoop? = locked {
            stopRequested = true
            return runLoop
        }
        guard let rl else { return } // not running yet: run() sees the flag and never enables the tap
        // Stopped from a block on the loop itself, not directly: a direct stop
        // that lands between run() publishing the loop and the loop starting
        // would be lost and leave the tap running. The block waits for the loop.
        CFRunLoopPerformBlock(rl, CFRunLoopMode.commonModes.rawValue) { CFRunLoopStop(rl) }
        CFRunLoopWakeUp(rl)
    }

    private func run() {
        let refcon = Unmanaged.passRetained(self).toOpaque()
        defer { Unmanaged<ScrollTap>.fromOpaque(refcon).release() }
        let mask = CGEventMask(1) << CGEventType.scrollWheel.rawValue
        guard let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
                                           eventsOfInterest: mask, callback: scrollTapCallback, userInfo: refcon) else {
            mouseLog.error("Could not create the scroll event tap (Accessibility permission?)")
            locked { failed = true }
            DispatchQueue.main.async { [self] in onFailure(self) }
            return
        }
        let source = CFMachPortCreateRunLoopSource(nil, port, 0)
        let rl = CFRunLoopGetCurrent()
        CFRunLoopAddSource(rl, source, .commonModes)
        let proceed: Bool = locked {
            if stopRequested { return false }
            self.port = port
            runLoop = rl
            return true
        }
        if proceed {
            CGEvent.tapEnable(tap: port, enable: true)
            CFRunLoopRun()
        }
        CGEvent.tapEnable(tap: port, enable: false)
        CFRunLoopRemoveSource(rl, source, .commonModes)
        CFMachPortInvalidate(port)
        locked {
            self.port = nil
            runLoop = nil
        }
    }

    fileprivate func handle(type: CGEventType, event: CGEvent) {
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            // macOS switches a tap off when it answers slowly or the user holds a secure input field.
            let p: CFMachPort? = locked {
                stats.reenabled += 1
                return stopRequested ? nil : port
            }
            if let p { CGEvent.tapEnable(tap: p, enable: true) }
            return
        case .scrollWheel:
            break
        default:
            return
        }
        // Stopping: the settings this tap was made for no longer hold.
        if locked({ stopRequested }) { return }
        if ScrollEventIO.isSynthetic(event) {
            locked { stats.synthetic += 1 }
            return
        }
        let sender = EventSender.id(of: event)
        let continuous = ScrollEventIO.isContinuous(event)
        let (rule, known, generation): (ScrollRule, Bool, Int) = locked {
            (table.rule(sender: sender, continuous: continuous), sender.map { table.bySender[$0] != nil } ?? false, self.generation)
        }
        // What rounding carried over belongs to the rules it was computed under.
        if scalerGeneration != generation {
            scalers = [:]
            scalerGeneration = generation
        }
        var changed = false
        if !rule.isIdentity {
            // Events without a known sender share one stream per kind of event.
            let stream = known ? sender! : (continuous ? 1 : 0)
            let before = ScrollEventIO.values(of: event)
            let after = scalers[stream, default: ScrollScaler()].apply(rule, to: before)
            if after != before {
                ScrollEventIO.write(after, to: event)
                changed = true
            }
        }
        locked {
            stats.seen += 1
            if known { stats.bySender += 1 }
            if changed { stats.changed += 1 }
        }
    }
}

private func scrollTapCallback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent,
                               refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    if let refcon {
        Unmanaged<ScrollTap>.fromOpaque(refcon).takeUnretainedValue().handle(type: type, event: event)
    }
    return Unmanaged.passUnretained(event)
}
