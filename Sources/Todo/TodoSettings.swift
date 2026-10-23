import SwiftUI
import BentoCore

/// `todo` section of config.json.
struct TodoSettings: Codable, Equatable {
    /// Keep the todo window above other windows.
    var floatOnTop = false
    /// View that opens first and that `h` / `g h` go to: "today", "inbox" or "upcoming".
    var homeView = "today"
    /// Escape with nothing selected: "close" hides the window, "nothing" keeps it.
    var escapeKey = "close"
    /// Quick Add: what Return does. "close" adds and closes, "keep" adds and stays open for the next task.
    var quickAddReturn = "close"
    var sync = TodoSyncSettings()

    var home: TodoListView {
        switch homeView {
        case "inbox": return .inbox
        case "upcoming": return .upcoming
        default: return .today
        }
    }
}

struct TodoSettingsView: View {
    @StateObject private var model = ConfigSection("todo", default: TodoSettings())
    @ObservedObject var status: TodoSyncStatus
    let actions: [BentoAction]
    let syncNow: () -> Void

    var body: some View {
        Form {
            Section("Window") {
                Toggle("Float on top of other windows", isOn: $model.value.floatOnTop)
                Picker("Home view", selection: $model.value.homeView) {
                    Text("Today").tag("today")
                    Text("Inbox").tag("inbox")
                    Text("Upcoming").tag("upcoming")
                }
                Picker("Escape with nothing selected", selection: $model.value.escapeKey) {
                    Text("Closes the window").tag("close")
                    Text("Does nothing").tag("nothing")
                }
                Picker("Return in Quick Add", selection: $model.value.quickAddReturn) {
                    Text("Adds the task and closes").tag("close")
                    Text("Adds the task and stays open").tag("keep")
                }
            }

            Section {
                Toggle("Sync tasks", isOn: $model.value.sync.enabled)
                TextField("Server", text: $model.value.sync.server, prompt: Text("https://sync.example.com"))
                    .textFieldStyle(.roundedBorder)
                TextField("Token file", text: $model.value.sync.tokenFile)
                    .textFieldStyle(.roundedBorder)
                LabeledContent("Status") {
                    HStack(spacing: 8) {
                        Image(systemName: status.symbol)
                            .foregroundStyle(status.isHealthy ? Color.secondary : Color.orange)
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(status.summary)
                            if let last = status.lastSync {
                                Text("Last sync \(last.formatted(.relative(presentation: .named)))")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            if let err = status.lastError, !status.isHealthy {
                                Text(err).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            }
                        }
                        Button("Sync Now", action: syncNow)
                            .disabled(!model.value.sync.enabled)
                    }
                }
            } header: {
                Text("Sync")
            } footer: {
                Text("Tasks sync in real time through the same Bento sync server and token as Notes.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section {
                ForEach(actions) { a in
                    HStack {
                        Text(a.title)
                        Spacer()
                        ShortcutRecorder(actionID: a.id)
                    }
                }
            } header: {
                Text("Shortcuts")
            }

            ForEach(TodoCommand.Group.allCases, id: \.self) { g in
                Section {
                    ForEach(TodoCommand.allCases.filter { $0.group == g }, id: \.self) { c in
                        HStack {
                            Text(c.title)
                            Spacer()
                            Text(c.keys.joined(separator: "  ")).foregroundStyle(.secondary).monospaced()
                        }
                    }
                } header: {
                    Text("In the todo window: \(g.rawValue.lowercased())")
                } footer: {
                    if g == .tasks {
                        Text("These follow Todoist. While adding or editing a task: #project, @label, p1–p4 and dates like “tomorrow 5pm” or “fri” are picked up from the text; Tab completes a project or label.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .formStyle(.grouped)
    }
}
