import AppKit
import SwiftUI
import BentoCore

struct MouseSettingsView: View {
    /// Asks the module to list the devices again and apply the settings.
    let resync: () -> Void
    @StateObject private var model = ConfigSection("mouse", default: MouseSettings())
    @ObservedObject private var status = MouseStatus.shared

    var body: some View {
        Form {
            Section {
                Text("Scroll direction, scroll speed and pointer speed for each mouse and trackpad. A mouse can scroll the traditional way while the trackpad keeps natural scrolling.")
                    .foregroundStyle(.secondary)
                if !status.running {
                    Label("The module is off: these settings take effect once it is on.", systemImage: "power")
                        .foregroundStyle(.secondary)
                }
                if status.tapBlocked || (needsTap && !Permissions.accessibility) {
                    HStack {
                        Label("Changing scrolling needs Accessibility permission.", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                        Spacer()
                        Button("Grant…") { Permissions.requestAccessibility() }
                    }
                }
                if !status.pointerSpeedAvailable {
                    Label("This macOS doesn't let Bento set pointer speed. Acceleration still applies.", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                } else if !status.pointerFailures.isEmpty {
                    Label("macOS refused: \(status.pointerFailures.joined(separator: ", ")).", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                }
            }

            Section {
                if status.devices.isEmpty {
                    Text("No mouse or trackpad found.").foregroundStyle(.secondary)
                }
                ForEach(status.devices) { device in
                    DeviceRow(device: device, model: model,
                              hasTwin: MouseSettings.hasTwin(device.identity, among: status.devices.map(\.identity)))
                }
            } header: {
                Text("Connected Devices")
            } footer: {
                Text("A device uses the defaults below until you change one of its values. It is then recognised by its vendor and product id, or by its name if it has none, on every Mac that shares this config.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section {
                DisclosureGroup {
                    DeviceSettingsEditor(settings: $model.value.defaults.mouse)
                } label: {
                    DeviceLabel(symbol: PointingKind.mouse.symbol, title: "Mice", detail: "Mice without settings of their own")
                }
                .accessibilityIdentifier("mouse-defaults:mouse")
                DisclosureGroup {
                    DeviceSettingsEditor(settings: $model.value.defaults.trackpad)
                } label: {
                    DeviceLabel(symbol: PointingKind.trackpad.symbol, title: "Trackpads", detail: "Trackpads without settings of their own")
                }
                .accessibilityIdentifier("mouse-defaults:trackpad")
            } header: {
                Text("Defaults")
            }

            if !awayEntries.isEmpty {
                Section {
                    ForEach(awayEntries, id: \.self) { index in
                        SavedEntryRow(index: index, model: model)
                    }
                } header: {
                    Text("Saved for Other Devices")
                } footer: {
                    Text("Devices that are not connected to this Mac right now.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
        .onAppear(perform: resync)
        // Back from granting the permission in System Settings.
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in resync() }
    }

    /// Whether any setting changes scrolling, which is what needs the event tap.
    private var needsTap: Bool {
        status.running && !ScrollTable(settings: model.value, devices: status.devices).isIdentity
    }

    /// Entries no connected device matches.
    private var awayEntries: [Int] {
        model.value.devices.indices.filter { i in
            !status.devices.contains { model.value.devices[i].matches($0.identity) }
        }
    }
}

extension PointingKind {
    var symbol: String { self == .mouse ? "computermouse" : "rectangle.and.hand.point.up.left" }
    var title: String { self == .mouse ? "Mouse" : "Trackpad" }
}

private func hexID(_ id: Int) -> String { String(format: "%04X", id) }

/// Rounds what a slider sets to a step, without the tick marks `Slider(step:)` draws.
private func stepped(_ value: Binding<Double>, _ step: Double) -> Binding<Double> {
    Binding(get: { value.wrappedValue }, set: {
        // Rounded again so 3 × 0.1 is written as 0.3, not 0.30000000000000004.
        value.wrappedValue = (($0 / step).rounded() * step * 1_000_000).rounded() / 1_000_000
    })
}

private struct DeviceLabel: View {
    let symbol: String
    let title: String
    let detail: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: symbol).frame(width: 22).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

/// A connected device: its values, which become its own entry when edited.
private struct DeviceRow: View {
    let device: ConnectedDevice
    @ObservedObject var model: ConfigSection<MouseSettings>
    /// Another connected device has the same ids: tell them apart by serial number.
    let hasTwin: Bool

    private var hasEntry: Bool { model.value.entryIndex(for: device.identity) != nil }

    var body: some View {
        DisclosureGroup {
            DeviceSettingsEditor(settings: Binding(
                get: { model.value.settings(for: device.identity, kind: device.kind) },
                set: { model.value.setSettings($0, for: device.identity, kind: device.kind, bySerial: hasTwin) }
            ), ownPointerSpeed: device.ownPointerSpeed)
            if hasEntry {
                Button("Use the \(device.kind == .mouse ? "Mouse" : "Trackpad") Defaults") {
                    model.value.removeEntries(for: device.identity)
                }
                .accessibilityIdentifier("mouse-use-defaults:\(device.id)")
            }
        } label: {
            DeviceLabel(symbol: device.kind.symbol, title: device.identity.name, detail: detail)
        }
        .accessibilityIdentifier("mouse-device:\(device.id)")
    }

    private var detail: String {
        var parts = [device.kind.title]
        if device.identity.hasIDs { parts.append("\(hexID(device.identity.vendorID)):\(hexID(device.identity.productID))") }
        if hasTwin, let serial = device.identity.serialNumber { parts.append("serial \(serial)") }
        parts.append(hasEntry ? "own settings" : "\(device.kind.title.lowercased()) defaults")
        return parts.joined(separator: " · ")
    }
}

/// An entry whose device is away (usually one that lives on another Mac).
private struct SavedEntryRow: View {
    let index: Int
    @ObservedObject var model: ConfigSection<MouseSettings>

    var body: some View {
        // The list can shrink between a change and the next render.
        if model.value.devices.indices.contains(index) {
            let entry = model.value.devices[index]
            DisclosureGroup {
                DeviceSettingsEditor(settings: Binding(
                    get: { model.value.devices.indices.contains(index) ? model.value.devices[index].settings : DeviceSettings() },
                    set: { if model.value.devices.indices.contains(index) { model.value.devices[index].settings = $0 } }
                ))
                Button("Remove", role: .destructive) {
                    if model.value.devices.indices.contains(index) { model.value.devices.remove(at: index) }
                }
            } label: {
                DeviceLabel(symbol: entry.kind.symbol, title: entry.name ?? "Unnamed device", detail: detail(entry))
            }
        }
    }

    private func detail(_ entry: DeviceEntry) -> String {
        var parts = [entry.kind.title]
        if entry.vendorID != nil || entry.productID != nil {
            parts.append("\(entry.vendorID.map(hexID) ?? "any"):\(entry.productID.map(hexID) ?? "any")")
        }
        if let serial = entry.serialNumber { parts.append("serial \(serial)") }
        return parts.joined(separator: " · ")
    }
}

/// The controls for one set of values.
struct DeviceSettingsEditor: View {
    @Binding var settings: DeviceSettings
    /// The speed the device has by itself, where the speed slider starts so
    /// that switching it on changes nothing. nil: the usual 400 counts per inch.
    var ownPointerSpeed: Double?

    var body: some View {
        Toggle(isOn: $settings.reverseScrollVertical) {
            Text("Reverse vertical scrolling")
            Text("The opposite of Natural scrolling in System Settings.")
        }
        Toggle("Reverse horizontal scrolling", isOn: $settings.reverseScrollHorizontal)
        LabeledContent("Scroll speed") {
            HStack {
                Slider(value: stepped($settings.scrollSpeed, 0.1), in: 0.1...5).frame(maxWidth: 220)
                Text("\(settings.scrollSpeed, specifier: "%.1f")×").monospacedDigit().frame(width: 52, alignment: .trailing)
            }
        }
        Toggle(isOn: $settings.disablePointerAcceleration) {
            Text("Disable pointer acceleration")
            Text("The pointer follows the device's raw movement. Pointer speed and acceleration then have no effect.")
        }
        OptionalSlider(title: "Pointer speed", value: $settings.pointerSpeed, range: 0...1, step: 0.01,
                       initial: ((ownPointerSpeed ?? PointerMath.defaultSpeed) * 100).rounded() / 100, format: "%.2f")
            .disabled(settings.disablePointerAcceleration)
        OptionalSlider(title: "Pointer acceleration", value: $settings.pointerAcceleration, range: 0...20, step: 0.05,
                       initial: PointerMath.systemDefaultAcceleration, format: "%.2f")
            .disabled(settings.disablePointerAcceleration)
    }
}

/// A value Bento either sets or leaves to macOS: a switch, and a slider while it is on.
private struct OptionalSlider: View {
    let title: String
    @Binding var value: Double?
    let range: ClosedRange<Double>
    let step: Double
    /// Where the slider starts when switched on: what macOS uses by default.
    let initial: Double
    let format: String

    var body: some View {
        LabeledContent(title) {
            HStack {
                if let current = value {
                    Slider(value: stepped(Binding(get: { min(max(current, range.lowerBound), range.upperBound) }, set: { value = $0 }), step),
                           in: range)
                        .frame(maxWidth: 190)
                    Text(String(format: format, current)).monospacedDigit().frame(width: 44, alignment: .trailing)
                } else {
                    Text("Set by macOS").foregroundStyle(.secondary)
                }
                Toggle(title, isOn: Binding(get: { value != nil }, set: { value = $0 ? initial : nil }))
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .controlSize(.small)
            }
        }
    }
}
