import AppKit
import SwiftUI

/// A Raycast/Todoist-style list overlay: field on top, ↑↓ (or ⌃N/⌃P) to move, ↩ to pick, Esc to close.
struct PickerOverlay: View {
    @ObservedObject var model: PickerModel
    let close: () -> Void

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.opacity(0.12).contentShape(Rectangle()).onTapGesture(perform: close)
            VStack(alignment: .leading, spacing: 0) {
                Text(model.title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    .padding(.horizontal, 14).padding(.top, 12)
                TokenField(model: model.field, placeholder: model.placeholder, font: .systemFont(ofSize: 16),
                           onSubmit: { _ in model.choose() }, onCancel: close,
                           onArrow: { d in model.move(d); return true })
                    .padding(.horizontal, 14).padding(.vertical, 8)
                if let p = model.preview {
                    Text(p).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 14).padding(.bottom, 6)
                }
                if !model.items.isEmpty {
                    Divider()
                    ScrollViewReader { proxy in
                        ScrollView {
                            VStack(spacing: 0) {
                                ForEach(Array(model.items.enumerated()), id: \.element.id) { i, item in
                                    PickerRow(item: item, highlighted: i == model.index)
                                        .id(item.id)
                                        .contentShape(Rectangle())
                                        .onTapGesture { model.index = i; model.choose(item) }
                                }
                            }
                            .padding(6)
                        }
                        .frame(maxHeight: 320)
                        .onChange(of: model.index) { i in
                            if model.items.indices.contains(i) { proxy.scrollTo(model.items[i].id) }
                        }
                    }
                }
            }
            .frame(maxWidth: 460)
            .fixedSize(horizontal: false, vertical: true)
            .background(VisualEffect(material: .popover, blending: .withinWindow))
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.primary.opacity(0.12)))
            .shadow(color: .black.opacity(0.25), radius: 20, y: 8)
            .padding(.horizontal, 16)
            .padding(.top, 64)
        }
    }
}

struct PickerRow: View {
    let item: PickerModel.Item
    let highlighted: Bool

    var body: some View {
        HStack(spacing: 10) {
            if let s = item.symbol {
                Image(systemName: s).foregroundStyle(item.tint ?? .secondary).frame(width: 18)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(item.title).lineLimit(1)
                if let sub = item.subtitle { Text(sub).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
            }
            Spacer()
            if item.checked == true { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
            if let h = item.hint { Text(h).font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(highlighted ? Color.accentColor.opacity(0.2) : .clear, in: RoundedRectangle(cornerRadius: 6))
    }
}

/// `?`: every binding, from the same table the router uses.
struct HelpOverlay: View {
    let close: () -> Void

    var body: some View {
        ZStack {
            Color.black.opacity(0.18).contentShape(Rectangle()).onTapGesture(perform: close)
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("Keyboard shortcuts").font(.headline)
                    Spacer()
                    Text("Press any key to close").font(.caption).foregroundStyle(.secondary)
                }
                HStack(alignment: .top, spacing: 28) {
                    ForEach(TodoCommand.Group.allCases, id: \.self) { g in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(g.rawValue).font(.subheadline.weight(.semibold)).padding(.bottom, 2)
                            ForEach(TodoCommand.allCases.filter { $0.group == g }, id: \.self) { c in
                                HStack(alignment: .firstTextBaseline) {
                                    Text(c.title).font(.caption)
                                    Spacer(minLength: 12)
                                    Text(c.keys.joined(separator: " ")).font(.caption.monospaced()).foregroundStyle(.secondary)
                                }
                            }
                        }
                        .frame(width: 250)
                    }
                }
                Text("While adding or editing: #project, @label, p1–p4 and dates (“tomorrow 5pm”, “fri”, “in 3 days”, “no date”) are read from the text. Tab completes, ⇥ moves to the description.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .padding(20)
            .background(VisualEffect(material: .popover, blending: .withinWindow))
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.primary.opacity(0.12)))
            .shadow(color: .black.opacity(0.25), radius: 20, y: 8)
        }
    }
}
