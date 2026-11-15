import AppKit
import SwiftUI
import BentoCore

/// What the settings pane shows about the devices and the module's state.
final class MouseStatus: ObservableObject {
    static let shared = MouseStatus()

    @Published var devices: [ConnectedDevice] = []
    /// Whether the module is on (the pane lists devices either way).
    @Published var running = false
    /// A scroll rule is in force but the event tap couldn't start.
    @Published var tapBlocked = false
    /// Whether macOS lets Bento set pointer speed (acceleration always works).
    @Published var pointerSpeedAvailable = true
    @Published var pointerFailures: [String] = []
}

/// Per-device mouse and trackpad settings: scroll direction and speed through
/// an event tap, pointer speed and acceleration through HID service properties.
///
/// While the module is off nothing runs. While it is on it watches the device
/// list, and the event tap exists only while some scroll rule changes something.
public final class MouseModule: BentoModule {
    public let id = "mouse"
    public let title = "Mouse"
    public let symbol = "computermouse"
    public let enabledByDefault = false
    public let actions: [BentoAction] = []

    private var settings = MouseSettings()
    private var observers: [NSObjectProtocol] = []
    private var workspaceObserver: NSObjectProtocol?
    private var watcher: DeviceWatcher?
    private var tap: ScrollTap?
    private let tuner = PointerTuner()
    private var started = false
    private var pendingSync: DispatchWorkItem?
    private var syncs = 0
    private var lastSyncSeconds = 0.0
    private var hidClientIsFull = true

    public init() {}

    // MARK: Lifecycle

    public func start() {
        guard !started else { return }
        started = true
        ConfigStore.shared.materialize(id, default: MouseSettings())
        settings = ConfigStore.shared.section(id, default: MouseSettings())
        observers.append(ConfigStore.shared.observe(id) { [weak self] in self?.configChanged() })
        // A device that reconnects on wake is a new service with macOS's values.
        workspaceObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in self?.sync() }
        let w = DeviceWatcher { [weak self] in self?.sync() }
        watcher = w
        w.start()
        sync()
    }

    public func stop() {
        guard started else { return }
        started = false
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        if let workspaceObserver { NSWorkspace.shared.notificationCenter.removeObserver(workspaceObserver) }
        workspaceObserver = nil
        watcher?.stop()
        watcher = nil
        pendingSync?.cancel()
        pendingSync = nil
        sync() // not started: stops the tap and puts the pointer values back
    }

    /// A slider being dragged changes the config many times a second, and a
    /// sync lists every HID service (about 70 ms): run it once the changes pause.
    private func configChanged() {
        pendingSync?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self, self.started else { return }
            self.pendingSync = nil
            self.settings = ConfigStore.shared.section(self.id, default: MouseSettings())
            self.sync()
        }
        pendingSync = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: item)
    }

    /// Brings the devices in line with the settings: lists them, sets or
    /// restores their pointer values, and starts, updates or stops the tap.
    /// Also run by the settings pane when it appears, so it lists devices
    /// while the module is off and picks up a permission granted since.
    func sync() {
        syncs += 1
        let began = CFAbsoluteTimeGetCurrent()
        defer { lastSyncSeconds = CFAbsoluteTimeGetCurrent() - began }
        let system = HIDSystem()
        let (services, siblings) = system.scan()
        let devices = HIDSystem.devices(services, siblings: siblings)
        hidClientIsFull = system.isFull

        // Nothing to restore and nothing to set: don't touch any service.
        if started || !tuner.ledger.isEmpty {
            let settings = self.settings, started = self.started
            tuner.apply(to: services, system: system) { s in
                started ? settings.settings(for: s.identity, kind: s.kind).pointerRule : .system
            }
        }

        let table = started ? ScrollTable(settings: settings, devices: devices) : .identity
        var blocked = false
        if table.isIdentity {
            tap?.stop()
            tap = nil
        } else if let tap {
            tap.update(table)
        } else if Permissions.accessibility {
            let t = ScrollTap(table: table) { [weak self] failed in
                // macOS refused the tap after all: drop it, so the next sync tries again.
                guard let self, self.tap === failed else { return }
                self.tap = nil
                MouseStatus.shared.tapBlocked = true
            }
            tap = t
            t.start()
        } else {
            blocked = true
        }

        let status = MouseStatus.shared
        if status.devices != devices { status.devices = devices }
        if status.running != started { status.running = started }
        if status.tapBlocked != blocked { status.tapBlocked = blocked }
        if status.pointerSpeedAvailable != system.isFull { status.pointerSpeedAvailable = system.isFull }
        if status.pointerFailures != tuner.failures { status.pointerFailures = tuner.failures }
    }

    // MARK: Diagnostics

    public func diagnostics() -> [String: Any] {
        let stats = tap?.currentStats ?? ScrollTap.Stats()
        return [
            "running": started,
            "syncs": syncs,
            "lastSyncMs": (lastSyncSeconds * 1000).rounded(),
            "deviceListChanges": watcher?.changes ?? 0,
            "tap": tap?.isRunning ?? false,
            "tapBlocked": MouseStatus.shared.tapBlocked,
            "senderLookup": EventSender.isAvailable,
            "fullHIDClient": hidClientIsFull,
            "scroll": ["seen": stats.seen, "bySender": stats.bySender, "changed": stats.changed,
                       "synthetic": stats.synthetic, "reenabled": stats.reenabled],
            "pointerFailures": tuner.failures,
            "pointerChanged": Array(Set(tuner.ledger.resolution.keys).union(tuner.ledger.acceleration)).sorted(),
            "devices": MouseStatus.shared.devices.map { d -> [String: Any] in
                let s = settings.settings(for: d.identity, kind: d.kind)
                return ["name": d.identity.name, "kind": d.kind.rawValue, "vendorID": d.identity.vendorID,
                        "productID": d.identity.productID, "services": d.senderIDs.count,
                        "ownSettings": settings.entryIndex(for: d.identity) != nil,
                        "reverseScrollVertical": s.reverseScrollVertical, "scrollSpeed": s.scrollSpeed]
            },
        ]
    }

    // MARK: Settings

    public func makeSettingsView() -> AnyView? {
        AnyView(MouseSettingsView { [weak self] in self?.sync() })
    }
}
