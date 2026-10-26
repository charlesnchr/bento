import AppKit
import SwiftUI

struct AssistantSidebar: View {
    @ObservedObject var model: AssistantChatModel
    @State private var search = ""
    @State private var renameItem: AssistantHistoryItem?
    @State private var name = ""
    @State private var deleteItem: AssistantHistoryItem?

    var body: some View {
        let groups = model.sessionGroups(search)
        let order = model.orderedSessions.map(\.id)
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Conversations").font(.system(size: 13, weight: .semibold))
                Spacer()
                Button { model.actions?.refreshHistory() } label: { Image(systemName: "arrow.clockwise").frame(width: 22, height: 22) }
                    .buttonStyle(.plain).foregroundStyle(.secondary).help("Refresh conversations").disabled(model.busy || model.historyBusy)
            }
            TextField("Search", text: $search).textFieldStyle(.roundedBorder)
            if model.historyBusy { ProgressView().controlSize(.small) }
            if let error = model.historyError { Text(error).font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(groups, id: \.title) { group in
                        Text(group.title).font(.system(size: 10.5, weight: .semibold)).foregroundStyle(.secondary)
                            .padding(.leading, 8).padding(.top, 8).padding(.bottom, 2)
                        ForEach(group.items) { item in row(item, number: order.firstIndex(of: item.id).map { $0 + 1 }) }
                    }
                    if groups.isEmpty, !model.historyBusy {
                        Text(search.isEmpty ? "No conversations yet" : "No matches").font(.caption).foregroundStyle(.secondary).padding(.top, 12)
                    }
                }
            }
            if !model.archived.isEmpty {
                Toggle("Show archived", isOn: $model.showArchived).toggleStyle(.checkbox).font(.system(size: 11))
            }
        }.padding(12).frame(maxHeight: .infinity, alignment: .top).background(Color.primary.opacity(0.025))
            .sheet(item: $renameItem) { item in
                VStack(alignment: .leading, spacing: 16) {
                    Text("Rename conversation").font(.headline)
                    TextField("Name", text: $name).textFieldStyle(.roundedBorder).onSubmit { model.rename(item.id, name); renameItem = nil }
                    HStack {
                        Spacer()
                        Button("Cancel") { renameItem = nil }
                        Button("Save") { model.rename(item.id, name); renameItem = nil }.keyboardShortcut(.defaultAction)
                    }
                }.padding(24).frame(width: 330)
            }
            .alert("Delete this conversation?", isPresented: Binding(get: { deleteItem != nil }, set: { if !$0 { deleteItem = nil } }),
                   presenting: deleteItem) { item in
                Button("Delete", role: .destructive) { model.actions?.delete(item.id) }
                Button("Cancel", role: .cancel) {}
            } message: { item in
                Text("\u{201C}\(model.title(item))\u{201D} will be removed from Hermes history. This can't be undone.")
            }
    }

    private func row(_ item: AssistantHistoryItem, number: Int?) -> some View {
        let current = model.sessionID == item.id
        return Button { model.actions?.restore(item.id) } label: {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: model.archived.contains(item.id) ? "archivebox" : model.pinned.contains(item.id) ? "pin.fill" : "bubble.left")
                    .font(.system(size: 11)).padding(.top, 3).foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.title(item)).font(.system(size: 12, weight: current ? .semibold : .regular)).lineLimit(2).multilineTextAlignment(.leading)
                    if let date = item.updated {
                        Text(date, format: .relative(presentation: .named)).font(.system(size: 10)).foregroundStyle(.secondary)
                    } else { Text(String(item.date.prefix(10))).font(.system(size: 10)).foregroundStyle(.secondary) }
                }
                Spacer(minLength: 0)
                if model.unread.contains(item.id) { Circle().fill(Color.accentColor).frame(width: 7, height: 7).padding(.top, 5).help("New reply") }
            }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
                .background(current ? Color.accentColor.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 6))
                .contentShape(Rectangle())
        }.buttonStyle(.plain).disabled(model.busy || model.historyBusy)
            .help(number.map { $0 <= 9 ? "⌘\($0)" : "" } ?? "")
            .contextMenu {
                Button(model.pinned.contains(item.id) ? "Unpin" : "Pin") { model.pin(item.id) }
                Button("Rename...") { name = model.title(item); renameItem = item }
                Button(model.archived.contains(item.id) ? "Unarchive" : "Archive") { model.archive(item.id) }
                Divider()
                Button("Delete...", role: .destructive) { deleteItem = item }.disabled(!model.idle)
            }
    }
}
