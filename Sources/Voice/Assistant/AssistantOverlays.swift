import AppKit
import SwiftUI

struct AssistantPalette: View {
    @ObservedObject var model: AssistantChatModel
    let accent: Color
    @FocusState private var focused: Bool

    // Arrow keys and Return reach the palette through the window's key handler.
    var body: some View {
        let items = model.paletteItems
        let selected = model.paletteSelection
        ZStack(alignment: .top) {
            Color.black.opacity(0.15).ignoresSafeArea().onTapGesture { model.perform(.palette) }
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("Search commands and conversations", text: $model.paletteQuery)
                        .textFieldStyle(.plain).font(.system(size: 15)).focused($focused)
                }.padding(12)
                Divider()
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 1) {
                            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                                Button { model.paletteSelection = index; model.runPalette() } label: {
                                    HStack(spacing: 10) {
                                        Image(systemName: item.symbol).frame(width: 18).foregroundStyle(index == selected ? accent : Color.secondary)
                                        Text(item.title).lineLimit(1)
                                        if !item.detail.isEmpty { Text(item.detail).foregroundStyle(.tertiary).lineLimit(1) }
                                        Spacer(minLength: 8)
                                        if !item.keys.isEmpty { Text(item.keys).font(.system(size: 11, design: .rounded)).foregroundStyle(.secondary) }
                                    }.font(.system(size: 13)).padding(.horizontal, 10).padding(.vertical, 7)
                                        .background(index == selected ? accent.opacity(0.16) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
                                        .contentShape(Rectangle())
                                }.buttonStyle(.plain).id(index)
                            }
                            if items.isEmpty {
                                Text(model.historyBusy ? "Loading conversations..." : "No matches").font(.system(size: 12))
                                    .foregroundStyle(.secondary).padding(20)
                            }
                        }.padding(6)
                    }.frame(maxHeight: 340).onChange(of: selected) { proxy.scrollTo(selected) }
                }
            }.frame(width: 460)
                .background(Color(nsColor: .windowBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.primary.opacity(0.12)))
                .shadow(color: .black.opacity(0.25), radius: 24, y: 8)
                .padding(.top, 56)
        }
        .onAppear { model.paletteSelection = 0; DispatchQueue.main.async { focused = true } }
    }
}

struct AssistantShortcutSheet: View {
    let model: AssistantChatModel
    var body: some View {
        ZStack {
            Color.black.opacity(0.15).ignoresSafeArea().onTapGesture { model.shortcutsVisible = false }
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Keyboard Shortcuts").font(.system(size: 15, weight: .semibold))
                    Spacer()
                    Button { model.shortcutsVisible = false } label: { Image(systemName: "xmark") }.buttonStyle(.borderless).help("Close (Esc)")
                }
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        ForEach(AssistantShortcuts.groups, id: \.self) { group in
                            VStack(alignment: .leading, spacing: 5) {
                                Text(group).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                                ForEach(AssistantShortcuts.all.filter { $0.group == group }) { shortcut in
                                    HStack {
                                        Text(shortcut.title)
                                        Spacer(minLength: 12)
                                        Text(shortcut.keys).font(.system(size: 12, design: .rounded)).foregroundStyle(.secondary)
                                    }.font(.system(size: 12.5))
                                }
                            }
                        }
                    }
                }
                Text("Shortcuts apply while the assistant window is focused. Shift-Option-F18 shows or hides it from anywhere.")
                    .font(.system(size: 11)).foregroundStyle(.tertiary).fixedSize(horizontal: false, vertical: true)
            }.padding(18).frame(width: 440).frame(maxHeight: 540)
                .background(Color(nsColor: .windowBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.primary.opacity(0.12)))
                .shadow(color: .black.opacity(0.25), radius: 24, y: 8)
        }
    }
}

struct AssistantFindBar: View {
    @ObservedObject var model: AssistantChatModel
    @FocusState private var focused: Bool
    var body: some View {
        let count = model.findMatches.count
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("Find in conversation", text: $model.findQuery).textFieldStyle(.plain).focused($focused)
                .onSubmit { model.perform(NSApp.currentEvent?.modifierFlags.contains(.shift) == true ? .findPrevious : .findNext) }
            if !model.findQuery.isEmpty {
                Text(count == 0 ? "No matches" : "\(min(model.findIndex, count - 1) + 1) of \(count)")
                    .font(.system(size: 11)).foregroundStyle(.secondary).monospacedDigit()
            }
            Button { model.perform(.findPrevious) } label: { Image(systemName: "chevron.up") }
                .buttonStyle(.borderless).disabled(count == 0).help("Previous match (⌘⇧G)")
            Button { model.perform(.findNext) } label: { Image(systemName: "chevron.down") }
                .buttonStyle(.borderless).disabled(count == 0).help("Next match (⌘G)")
            Button("Done") { model.findVisible = false; model.findQuery = ""; model.focus() }.buttonStyle(.borderless)
        }.font(.system(size: 12.5)).padding(.horizontal, 18).padding(.vertical, 7)
            .onAppear { DispatchQueue.main.async { focused = true } }
            .onChange(of: model.findFocus) { focused = true }
    }
}
