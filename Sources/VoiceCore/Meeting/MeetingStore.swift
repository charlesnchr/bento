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

public extension Notification.Name {
    /// Posted after a meeting's files are written or removed, so the Meetings
    /// list can refresh without polling.
    static let gtMeetingsDidChange = Notification.Name("com.charles.bento.voice.meetings-changed")
}

/// Meetings on disk, one folder each — kept apart from dictation recordings so
/// History's reindex, recovery, retry queue and retention never see them:
///
///     meetings/20261011-104112-1A2B3C4D/
///         meeting.json      status, parts, chunks, summary, usage
///         transcript.json   segments and cleaned blocks
///         notes.md          the readable item, rewritten as it changes
///         part-1-mic.caf    crash-safe audio, the batch path's source
///         part-1-system.caf
///
/// The folder is the source of truth; nothing indexes it.
public enum MeetingStore {
    public static var root: URL {
        FileLayout.appSupportRoot.appendingPathComponent("meetings", isDirectory: true)
    }

    public static func makeFolder(id: UUID, now: Date = Date()) throws -> URL {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        let url = root.appendingPathComponent("\(formatter.string(from: now))-\(id.uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    public static func metaURL(in folder: URL) -> URL { folder.appendingPathComponent("meeting.json") }
    public static func transcriptURL(in folder: URL) -> URL { folder.appendingPathComponent("transcript.json") }
    public static func notesURL(in folder: URL) -> URL { folder.appendingPathComponent("notes.md") }

    /// A document serialized on the caller's thread, so the bytes are one
    /// consistent snapshot; writing them can then happen anywhere.
    public struct Snapshot: Sendable {
        public let folder: URL
        let meta: Data
        let transcript: Data
        let notes: Data
    }

    public static func snapshot(_ document: MeetingDocument) throws -> Snapshot {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let meta = try encoder.encode(document.meta)
        encoder.outputFormatting = [.sortedKeys]
        let transcript = try encoder.encode(document.transcript)
        return Snapshot(folder: document.folder, meta: meta, transcript: transcript, notes: Data(document.markdown.utf8))
    }

    public static func write(_ snapshot: Snapshot) {
        do {
            // Transcript before meta: a crash between the two leaves meta pointing
            // at chunks the transcript already has, never the reverse.
            try snapshot.transcript.write(to: transcriptURL(in: snapshot.folder), options: .atomic)
            try snapshot.meta.write(to: metaURL(in: snapshot.folder), options: .atomic)
            try snapshot.notes.write(to: notesURL(in: snapshot.folder), options: .atomic)
        } catch {
            Log.history.error("MeetingStore: write failed in \(snapshot.folder.lastPathComponent, privacy: .public): \(error)")
        }
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: .gtMeetingsDidChange, object: nil)
        }
    }

    public static func save(_ document: MeetingDocument) {
        do {
            write(try snapshot(document))
        } catch {
            Log.history.error("MeetingStore: encode failed: \(error)")
        }
    }

    public static func loadMeta(folder: URL) -> MeetingMeta? {
        guard let data = try? Data(contentsOf: metaURL(in: folder)) else { return nil }
        return try? decoder.decode(MeetingMeta.self, from: data)
    }

    public static func load(folder: URL) -> MeetingDocument? {
        guard let meta = loadMeta(folder: folder) else { return nil }
        let transcript = (try? Data(contentsOf: transcriptURL(in: folder)))
            .flatMap { try? decoder.decode(MeetingTranscript.self, from: $0) } ?? MeetingTranscript()
        return MeetingDocument(folder: folder, meta: meta, transcript: transcript)
    }

    /// Every meeting's folder and metadata, newest first. Reads only the small
    /// meta file, so listing stays cheap however long the meetings were.
    public static func list() -> [(folder: URL, meta: MeetingMeta)] {
        let folders = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        return folders
            .filter(\.hasDirectoryPath)
            .compactMap { folder in loadMeta(folder: folder).map { (folder: folder, meta: $0) } }
            .sorted { $0.meta.startedAt > $1.meta.startedAt }
    }

    /// The audio-retention setting applies to meetings too — an hour of mic plus
    /// system audio is about 230MB. Only finished meetings with nothing left to
    /// transcribe lose their audio: a pending or failed span still needs it for
    /// Retry, exactly as History keeps a transcript-less recording.
    public static func purgeExpiredAudio(retentionDays: Int = SettingsStore().audioRetentionDays, now: Date = Date()) {
        guard retentionDays != 0 else { return }
        let cutoff = retentionDays < 0 ? now : now.addingTimeInterval(-Double(retentionDays) * 86_400)
        var purged = 0
        for (folder, meta) in list() where meta.status == .complete
            && (meta.endedAt ?? meta.startedAt) < cutoff
            && meta.pendingBatchCount == 0 && meta.failedChunkCount == 0 {
            for part in meta.parts {
                for name in [part.micFileName, part.systemFileName] {
                    let url = folder.appendingPathComponent(name)
                    if FileManager.default.fileExists(atPath: url.path) {
                        try? FileManager.default.removeItem(at: url)
                        purged += 1
                    }
                }
            }
        }
        if purged > 0 {
            Log.history.info("MeetingStore: purged \(purged) meeting audio file(s) past retention")
        }
    }

    public static func delete(folder: URL) {
        try? FileManager.default.removeItem(at: folder)
        NotificationCenter.default.post(name: .gtMeetingsDidChange, object: nil)
    }

    private static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
