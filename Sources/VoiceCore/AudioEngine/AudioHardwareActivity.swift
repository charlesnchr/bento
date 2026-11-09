import CoreAudio
import Foundation

/// Tells the warm-graph pool when the HAL is moving, so a speculative build
/// never starts inside a route or device-change burst.
///
/// Watches the system object (device list, default input and outputs) and the
/// current default input (alive, sample rate, input streams, an aggregate's
/// active subdevices), re-attaching to the new default whenever it moves.
/// Every HAL call, listener registration included, runs on a private queue:
/// CoreAudio can stall while a device connects. `onActivity` runs on main.
public final class AudioHardwareActivity: @unchecked Sendable {
    public var onActivity: (@MainActor () -> Void)?

    private let queue = DispatchQueue(label: "com.charles.bento.voice.audio.hal-activity", qos: .utility)
    private var watchedDevice: AudioDeviceID?
    private var started = false
    private lazy var listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
        self?.changed()
    }

    private static let systemSelectors: [AudioObjectPropertySelector] = [
        kAudioHardwarePropertyDevices,
        kAudioHardwarePropertyDefaultInputDevice,
        kAudioHardwarePropertyDefaultOutputDevice,
        kAudioHardwarePropertyDefaultSystemOutputDevice,
    ]

    private static let deviceAddresses: [(AudioObjectPropertySelector, AudioObjectPropertyScope)] = [
        (kAudioDevicePropertyDeviceIsAlive, kAudioObjectPropertyScopeGlobal),
        (kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal),
        (kAudioDevicePropertyStreams, kAudioDevicePropertyScopeInput),
        (kAudioDevicePropertyStreamConfiguration, kAudioDevicePropertyScopeInput),
        // Fails harmlessly on a device that is not an aggregate.
        (kAudioAggregateDevicePropertyActiveSubDeviceList, kAudioObjectPropertyScopeGlobal),
    ]

    public init() {}

    public func start() {
        queue.async { [self] in
            guard !started else { return }
            started = true
            for selector in Self.systemSelectors {
                var address = Self.address(selector)
                AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, queue, listener)
            }
            watchDefaultInput()
        }
    }

    /// Runs on `queue`.
    private func changed() {
        watchDefaultInput()
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated { self?.onActivity?() }
        }
    }

    /// Moves the device listeners to the current default input. Runs on `queue`.
    private func watchDefaultInput() {
        let current = AudioDeviceQuery.defaultInputDevice()
        guard current != watchedDevice else { return }
        if let old = watchedDevice {
            for (selector, scope) in Self.deviceAddresses {
                var address = Self.address(selector, scope)
                AudioObjectRemovePropertyListenerBlock(old, &address, queue, listener)
            }
        }
        watchedDevice = current
        if let current {
            for (selector, scope) in Self.deviceAddresses {
                var address = Self.address(selector, scope)
                AudioObjectAddPropertyListenerBlock(current, &address, queue, listener)
            }
        }
    }

    private static func address(
        _ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
    ) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }

    // MARK: - Preflight

    /// Whether the default input looks complete enough to build a graph on:
    /// present, alive, with input streams and a sample rate, and for an
    /// aggregate, every active subdevice alive. The 2026-11-09 hang was
    /// AVFAudio re-reading an input's subdevices forever; this reads them once,
    /// with plain property calls that return, and skips the build if they look
    /// half-formed. Call it off the main thread.
    public static func defaultInputLooksSettled() -> Bool {
        guard let device = AudioDeviceQuery.defaultInputDevice(), isAlive(device) else { return false }
        var streams = address(kAudioDevicePropertyStreams, kAudioDevicePropertyScopeInput)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(device, &streams, 0, nil, &size) == noErr, size > 0 else { return false }
        var rateAddress = address(kAudioDevicePropertyNominalSampleRate)
        var rate: Float64 = 0
        var rateSize = UInt32(MemoryLayout<Float64>.size)
        guard AudioObjectGetPropertyData(device, &rateAddress, 0, nil, &rateSize, &rate) == noErr, rate > 0 else {
            return false
        }
        var subAddress = address(kAudioAggregateDevicePropertyActiveSubDeviceList)
        guard AudioObjectHasProperty(device, &subAddress) else { return true }
        var subSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(device, &subAddress, 0, nil, &subSize) == noErr else { return false }
        var subs = [AudioObjectID](repeating: 0, count: Int(subSize) / MemoryLayout<AudioObjectID>.size)
        guard !subs.isEmpty,
              AudioObjectGetPropertyData(device, &subAddress, 0, nil, &subSize, &subs) == noErr else { return false }
        return subs.allSatisfy(isAlive)
    }

    private static func isAlive(_ device: AudioObjectID) -> Bool {
        var aliveAddress = address(kAudioDevicePropertyDeviceIsAlive)
        var alive: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(device, &aliveAddress, 0, nil, &size, &alive) == noErr && alive != 0
    }
}
