import SwiftUI
import VoiceCore

/// What the data pages need from the dictation side.
@MainActor
final class AppPages {
    let store: HistoryStore?
    let onRetry: (DictationRecord) -> Void
    let onDeleteAllHistory: () -> Void

    init(store: HistoryStore?, onRetry: @escaping (DictationRecord) -> Void, onDeleteAllHistory: @escaping () -> Void) {
        self.store = store
        self.onRetry = onRetry
        self.onDeleteAllHistory = onDeleteAllHistory
    }
}
