import Foundation
import IOKit
import IOKit.hid
import IOKit.hidsystem
import BentoCore

let mouseLog = BentoLog.make("mouse")

/// One HID service of a mouse or trackpad, as the HID event system lists it.
struct PointingService {
    let service: IOHIDServiceClient
    let identity: DeviceIdentity
    let kind: PointingKind
    /// The registry id scroll events of this service carry.
    let senderID: UInt64?
    let isPrimarilyPointer: Bool

    func number(_ key: String) -> Int? {
        (IOHIDServiceClientCopyProperty(service, key as CFString) as? NSNumber)?.intValue
    }

    func string(_ key: String) -> String? {
        IOHIDServiceClientCopyProperty(service, key as CFString) as? String
    }

    @discardableResult
    func set(_ key: String, _ value: Int) -> Bool {
        IOHIDServiceClientSetProperty(service, key as CFString, NSNumber(value: value))
    }
}

/// A connection to the HID event system, for listing pointing services and
/// reading and writing their properties.
///
/// The public "simple" client can set a service's acceleration but can neither
/// read nor set its resolution (checked on macOS 27), so the full client is
/// used when the system has it. `IOHIDEventSystemClientCreate` is not in the
/// SDK headers; it is looked up at run time so a system without it still gets
/// the simple client, and with it everything but pointer speed.
final class HIDSystem {
    let client: IOHIDEventSystemClient
    /// Whether the client can read and write every service property.
    let isFull: Bool

    private typealias Create = @convention(c) (CFAllocator?) -> Unmanaged<IOHIDEventSystemClient>?

    init() {
        if let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "IOHIDEventSystemClientCreate"),
           let full = unsafeBitCast(symbol, to: Create.self)(kCFAllocatorDefault)?.takeRetainedValue() {
            client = full
            isFull = true
        } else {
            client = IOHIDEventSystemClientCreateSimpleClient(kCFAllocatorDefault)
            isFull = false
        }
    }

    /// Every service that moves the pointer, and for each device the registry
    /// ids of its other services: a trackpad's scroll events can come from a
    /// service beside the one that moves the pointer.
    func scan() -> (services: [PointingService], siblings: [String: [UInt64]]) {
        let all = (IOHIDEventSystemClientCopyServices(client) as? [IOHIDServiceClient]) ?? []
        var pointing: [PointingService] = []
        var others: [(key: String, id: UInt64)] = []
        for service in all {
            func value(_ key: String) -> Any? { IOHIDServiceClientCopyProperty(service, key as CFString) }
            let vendor = (value(kIOHIDVendorIDKey) as? NSNumber)?.intValue ?? 0
            let product = (value(kIOHIDProductIDKey) as? NSNumber)?.intValue ?? 0
            let name = (value(kIOHIDProductKey) as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
            // Nothing to show or match it by.
            guard !name.isEmpty || vendor != 0 || product != 0 else { continue }
            let serial = (value(kIOHIDSerialNumberKey) as? String).flatMap { $0.isEmpty ? nil : $0 }
            let identity = DeviceIdentity(vendorID: vendor, productID: product, name: name.isEmpty ? "Pointing device" : name,
                                          serialNumber: serial)
            let senderID = (IOHIDServiceClientGetRegistryID(service) as? NSNumber)?.uint64Value
            let page = UInt32(kHIDPage_GenericDesktop)
            guard IOHIDServiceClientConformsTo(service, page, UInt32(kHIDUsage_GD_Mouse)) != 0
                || IOHIDServiceClientConformsTo(service, page, UInt32(kHIDUsage_GD_Pointer)) != 0 else {
                if let senderID { others.append((identity.key, senderID)) }
                continue
            }
            let isTouchPad = IOHIDServiceClientConformsTo(service, UInt32(kHIDPage_Digitizer), UInt32(kHIDUsage_Dig_TouchPad)) != 0
            let primaryPage = (value(kIOHIDPrimaryUsagePageKey) as? NSNumber)?.intValue
            let primaryUsage = (value(kIOHIDPrimaryUsageKey) as? NSNumber)?.intValue
            let primarilyPointer = isTouchPad || (primaryPage == kHIDPage_GenericDesktop
                && (primaryUsage == kHIDUsage_GD_Mouse || primaryUsage == kHIDUsage_GD_Pointer))
            pointing.append(PointingService(service: service, identity: identity,
                                            kind: PointingKind.detect(isTouchPad: isTouchPad, name: name),
                                            senderID: senderID, isPrimarilyPointer: primarilyPointer))
        }
        let keys = Set(pointing.map(\.identity.key))
        var siblings: [String: [UInt64]] = [:]
        for other in others where keys.contains(other.key) { siblings[other.key, default: []].append(other.id) }
        return (pointing, siblings)
    }

    /// The system-wide value of a property, such as the tracking speed.
    func number(_ key: String) -> Int? {
        (IOHIDEventSystemClientCopyProperty(client, key as CFString) as? NSNumber)?.intValue
    }

    /// The services grouped into devices: one per identity, mice and
    /// trackpads before keyboards that also have a pointer, then by name.
    static func devices(_ services: [PointingService], siblings: [String: [UInt64]] = [:]) -> [ConnectedDevice] {
        var order: [String] = []
        var byKey: [String: ConnectedDevice] = [:]
        for s in services {
            let key = s.identity.key
            if byKey[key] == nil {
                order.append(key)
                byKey[key] = ConnectedDevice(identity: s.identity, kind: s.kind, isPrimarilyPointer: false)
            }
            if let id = s.senderID, !byKey[key]!.senderIDs.contains(id) { byKey[key]!.senderIDs.append(id) }
            if s.isPrimarilyPointer { byKey[key]!.isPrimarilyPointer = true }
            if s.kind == .trackpad { byKey[key]!.kind = .trackpad }
        }
        for (key, ids) in siblings {
            for id in ids where byKey[key]?.senderIDs.contains(id) == false { byKey[key]?.senderIDs.append(id) }
        }
        return order.compactMap { byKey[$0] }.sorted {
            if $0.isPrimarilyPointer != $1.isPrimarilyPointer { return $0.isPrimarilyPointer }
            return $0.identity.name.localizedCaseInsensitiveCompare($1.identity.name) == .orderedAscending
        }
    }
}

/// Tells when a pointing device connects or disconnects. It only watches the
/// device list: nothing is opened, so no input is read and macOS asks for no
/// Input Monitoring permission.
final class DeviceWatcher {
    private var manager: IOHIDManager?
    private var pending: DispatchWorkItem?
    private let onChange: () -> Void
    private(set) var changes = 0

    init(onChange: @escaping () -> Void) {
        self.onChange = onChange
    }

    func start() {
        guard manager == nil else { return }
        let m = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
        let page = kHIDPage_GenericDesktop
        IOHIDManagerSetDeviceMatchingMultiple(m, [
            [kIOHIDDeviceUsagePageKey: page, kIOHIDDeviceUsageKey: kHIDUsage_GD_Mouse],
            [kIOHIDDeviceUsagePageKey: page, kIOHIDDeviceUsageKey: kHIDUsage_GD_Pointer],
        ] as CFArray)
        let context = Unmanaged.passUnretained(self).toOpaque()
        let callback: IOHIDDeviceCallback = { context, _, _, _ in
            guard let context else { return }
            Unmanaged<DeviceWatcher>.fromOpaque(context).takeUnretainedValue().deviceListChanged()
        }
        IOHIDManagerRegisterDeviceMatchingCallback(m, callback, context)
        IOHIDManagerRegisterDeviceRemovalCallback(m, callback, context)
        IOHIDManagerScheduleWithRunLoop(m, CFRunLoopGetMain(), CFRunLoopMode.commonModes.rawValue)
        manager = m
    }

    func stop() {
        pending?.cancel()
        pending = nil
        guard let m = manager else { return }
        IOHIDManagerRegisterDeviceMatchingCallback(m, nil, nil)
        IOHIDManagerRegisterDeviceRemovalCallback(m, nil, nil)
        IOHIDManagerUnscheduleFromRunLoop(m, CFRunLoopGetMain(), CFRunLoopMode.commonModes.rawValue)
        manager = nil
    }

    /// A device's HID service appears a moment after the device itself, and
    /// one device can arrive as several interfaces: wait for them to settle.
    private func deviceListChanged() {
        changes += 1
        pending?.cancel()
        let item = DispatchWorkItem { [weak self] in
            self?.pending = nil
            self?.onChange()
        }
        pending = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7, execute: item)
    }
}
