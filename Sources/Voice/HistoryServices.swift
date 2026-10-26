// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import Foundation
import VoiceCore

/// History, crash recovery and the offline retry queue — everything that keeps
/// a recording's words reachable after the session that made it is gone.
@MainActor
final class HistoryServices {
    let store: HistoryStore?
    private let transcription: any TranscriptionServicing
    private let coordinator: DictationCoordinator
    private let pill: PillPresenter
    private let vertexState: VertexRuntimeConfig.State
    private var recoveryScanner: RecoveryScanner?
    private var retryQueue: RetryQueue?
    private var retentionTimer: Timer?

    /// An inserted edit teaches the composer the instruction that produced it.
    var onEditInserted: ((_ instruction: String, _ revision: String) -> Void)?

    init(transcription: any TranscriptionServicing, coordinator: DictationCoordinator,
         pill: PillPresenter, vertexState: VertexRuntimeConfig.State) {
        store = try? HistoryStore.standard()
        self.transcription = transcription
        self.coordinator = coordinator
        self.pill = pill
        self.vertexState = vertexState
    }

    func start() {
        // Retention shouldn't depend on relaunches (audit L11): purge every 6h.
        retentionTimer = Timer.scheduledTimer(withTimeInterval: 6 * 3600, repeats: true) { _ in
            Task.detached(priority: .utility) {
                RetentionPolicy().purgeExpiredAudio()
            }
        }
        guard let store else {
            Log.history.error("HistoryStore unavailable — history features disabled")
            return
        }
        coordinator.onSessionDiscard = { id in
            store.delete(id: id.uuidString, removeFolder: false)
        }
        coordinator.onSessionUpdate = { [weak self] meta, folder in
            store.upsert(meta: meta, folder: folder)
            if meta.status == .inserted, meta.editingSession != nil,
               let instruction = meta.rawTranscript, let revision = meta.cleanedTranscript {
                self?.onEditInserted?(instruction, revision)
            }
            // "Never keep audio": purge the moment a transcript exists (audit #2).
            if SettingsStore().audioRetentionDays < 0, meta.rawTranscript != nil || meta.status == .silent {
                for audio in [FileLayout.audioCAF(in: folder), FileLayout.audioFLAC(in: folder)] {
                    try? FileManager.default.removeItem(at: audio)
                }
            }
        }

        let scanner = RecoveryScanner(store: store, transcription: transcription)
        scanner.onRecovered = { [weak self] message in
            self?.pill.showBackgroundNotice(message, for: 4.0, sound: .success)
        }
        recoveryScanner = scanner

        let queue = RetryQueue(store: store, transcription: transcription)
        queue.onDrained = { [weak self] count in
            let message = count == 1
                ? "Your queued dictation is ready — it's in History"
                : "\(count) queued dictations are ready — they're in History"
            self?.pill.showBackgroundNotice(message, for: 4.0, sound: .success)
        }
        queue.onDrainBlocked = { [weak self] error in
            let message: String
            if case .auth = error {
                message = self?.vertexState.isRequested == true
                    ? "Queued dictations are waiting — check the local Vertex gateway"
                    : "Queued dictations are waiting — fix your API key in Settings → Advanced"
            } else {
                message = "Daily quota reached — queued dictations will retry later"
            }
            self?.pill.showBackgroundNotice(message, for: 5.0, sound: nil)
        }
        retryQueue = queue

        // Both walk EVERY recording folder and read every meta.json. On the main
        // actor that grows without bound as history grows — and the hotkey is
        // already armed, so a key press would queue behind it.
        Task {
            await scanner.scanAndRecover()
            queue.start()
            Task.detached(priority: .utility) {
                RetentionPolicy().purgeExpiredAudio()
            }
        }
    }

    func latestRecord() -> DictationRecord? { store?.records(limit: 1).first }

    func upsert(meta: SessionMeta, folder: URL) { store?.upsert(meta: meta, folder: folder) }

    private(set) lazy var pages = AppPages(
        store: store,
        onRetry: { [weak self] record in
            Task { @MainActor [weak self] in
                guard let self, let queue = self.retryQueue else { return }
                switch await queue.retrySingle(record) {
                case .stillOffline:
                    self.pill.showNotice("Still offline — will retry automatically when you're back", for: 4.0, sound: nil)
                case .busy:
                    self.pill.showNotice("Already retrying your queued dictations…", for: 2.5, sound: nil)
                case .failed:
                    self.pill.showNotice("Retry didn't work — the row has the details", for: 3.0, sound: nil)
                case .recovered, .blocked, .alreadyDone:
                    break // recovered → drain notice; blocked → onDrainBlocked notice
                }
            }
        },
        onDeleteAllHistory: { [weak self] in
            guard let self else { return }
            if let store = self.store {
                store.deleteAll(
                    removeFolders: true,
                    sparing: self.coordinator.activeSessionFolder
                )
            } else {
                // No DB handle (quarantined at launch) must not turn the
                // destructive button into a silent no-op — the folders
                // are the actual data; sweep them directly.
                let folders = (try? FileManager.default.contentsOfDirectory(
                    at: FileLayout.recordingsRoot, includingPropertiesForKeys: nil
                )) ?? []
                let active = self.coordinator.activeSessionFolder?.standardizedFileURL
                for folder in folders where folder.hasDirectoryPath && folder.standardizedFileURL != active {
                    try? FileManager.default.removeItem(at: folder)
                }
            }
            // Wiping history also forgets the paste-last buffer.
            self.coordinator.clearLastResult()
        }
    )
}
