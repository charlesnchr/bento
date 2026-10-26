import Foundation

/// A cleanup model the settings offer: a Gemini model on Vertex, or one the
/// helper relays elsewhere (runtime config `relayed_cleanup_models`).
public struct CleanupModel: Codable, Equatable, Hashable, Sendable {
    public let id: String
    public let name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

public enum CleanupModels {
    /// Gemini models on Vertex, through the direct helper.
    public static let builtIn = [
        CleanupModel(id: "gemini-3.5-flash-lite", name: "Flash-Lite, fastest"),
        CleanupModel(id: "gemini-3.8-flash", name: "3.8 Flash"),
    ]

    /// Models the helper relays to another provider. They also edit drafts.
    public static var relayed: [CleanupModel] {
        VertexRuntimeConfig.state().config?.relayedCleanupModels ?? []
    }

    /// Everything the direct runtime can clean up with, relayed models first.
    public static var available: [CleanupModel] {
        var seen = Set<String>()
        return (relayed + builtIn).filter { seen.insert($0.id).inserted }
    }

    public static func isRelayed(_ id: String) -> Bool {
        relayed.contains { $0.id == id }
    }

    /// The runtime's default when it names an available model, else Flash-Lite.
    public static var defaultModel: String {
        if let id = VertexRuntimeConfig.state().config?.defaultCleanupModel, available.contains(where: { $0.id == id }) {
            return id
        }
        return builtIn[0].id
    }
}
