package com.charles.bento.core.voice.history

import com.charles.bento.core.voice.VoiceLog
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.io.File
import java.time.Instant

/** One History row. */
data class DictationRecord(
    val id: String,
    val folder: File,
    val startedAt: Instant,
    val status: SessionMeta.Status,
    val targetApp: String?,
    val targetAppName: String?,
    val durationSeconds: Double?,
    val rawTranscript: String?,
    val cleanedTranscript: String?,
    val errorCode: String?,
    val errorMessage: String?,
    val pipelineSeconds: Double?,
    val modelID: String?,
) {
    val displayText: String get() = cleanedTranscript ?: rawTranscript ?: ""
    val audioFile: File get() = FileLayout.audioWAV(folder)
    val hasAudio: Boolean get() = audioFile.exists()

    companion object {
        fun of(meta: SessionMeta, folder: File) = DictationRecord(
            id = meta.id, folder = folder, startedAt = meta.startedAt, status = meta.status,
            targetApp = meta.targetApp, targetAppName = meta.targetAppName, durationSeconds = meta.audioDurationSeconds,
            rawTranscript = meta.rawTranscript, cleanedTranscript = meta.cleanedTranscript, errorCode = meta.errorCode,
            errorMessage = meta.errorMessage, pipelineSeconds = meta.pipelineSeconds, modelID = meta.modelID,
        )
    }
}

/**
 * Searchable dictation history over the session folders. The folders (each with a
 * `meta.json` and the recording) are the source of truth; this is an in-memory index
 * rebuilt by [reindex] at launch and kept current by [upsert], so a corrupt index can
 * never disable history or recovery (the Mac quarantines its SQLite index for the same
 * reason). Thread safe.
 */
class HistoryStore(val root: File) {
    val recordingsRoot: File = FileLayout.recordingsRoot(root)
    private val rows = LinkedHashMap<String, DictationRecord>()
    private val version = MutableStateFlow(0L)

    /** Bumps after every change, so an open History screen refreshes without polling. */
    val changes: StateFlow<Long> = version.asStateFlow()

    init {
        recordingsRoot.mkdirs()
    }

    private fun changed() = version.update { it + 1 }

    // MARK: - Writes

    fun upsert(meta: SessionMeta, folder: File) {
        synchronized(rows) { rows[meta.id] = DictationRecord.of(meta, folder) }
        changed()
    }

    fun delete(id: String, removeFolder: Boolean) {
        val record = synchronized(rows) { rows.remove(id) }
        if (removeFolder) record?.folder?.deleteRecursively()
        changed()
    }

    /** Deletes every row, and with `removeFolders` every folder on disk except the live session's. */
    fun deleteAll(removeFolders: Boolean, sparing: File? = null) {
        synchronized(rows) { rows.clear() }
        if (removeFolders) {
            // Sweep the DIRECTORY, not the index: hidden rows' audio must go too.
            val spared = sparing?.canonicalFile
            recordingsRoot.listFiles()?.filter { it.isDirectory }?.forEach { folder ->
                if (spared != null && folder.canonicalFile == spared) return@forEach
                folder.deleteRecursively()
            }
        }
        changed()
    }

    /**
     * Rebuilds the index from the folders on disk. Rows whose folders vanished are
     * pruned, never shown as ghosts.
     */
    fun reindex() {
        val found = HashMap<String, DictationRecord>()
        recordingsRoot.listFiles()?.filter { it.isDirectory }?.forEach { folder ->
            SessionMeta.read(folder)?.let { found[it.id] = DictationRecord.of(it, folder) }
        }
        val pruned: Int
        synchronized(rows) {
            rows.putAll(found)
            val orphans = rows.values.filter { !it.folder.exists() }.map { it.id }
            orphans.forEach(rows::remove)
            pruned = orphans.size
        }
        if (pruned > 0) VoiceLog.i(TAG, "reindex pruned $pruned orphaned row(s)")
        changed()
    }

    // MARK: - Reads

    private fun all(): List<DictationRecord> = synchronized(rows) { rows.values.toList() }

    /**
     * History is a library of words plus things needing attention, never an event
     * log. Visible: anything with a transcript; retryable failures and queued items;
     * long cancelled recordings (recoverable). Never silent rows, and never in-flight
     * ones (crash recovery reads those via [interruptedRecords]).
     */
    private fun isVisible(r: DictationRecord): Boolean =
        (r.rawTranscript != null || r.cleanedTranscript != null ||
            r.status == SessionMeta.Status.FAILED || r.status == SessionMeta.Status.QUEUED_FOR_RETRY ||
            (r.status == SessionMeta.Status.CANCELLED && (r.durationSeconds ?: 0.0) >= 10)) &&
            r.status != SessionMeta.Status.SILENT

    /** Newest first. `query` matches the transcripts and the app name, case-insensitively. */
    fun records(query: String? = null, limit: Int = 500): List<DictationRecord> {
        val needle = query?.trim()?.takeIf { it.isNotEmpty() }
        return all().asSequence()
            .filter(::isVisible)
            .filter { r ->
                needle == null || listOfNotNull(r.rawTranscript, r.cleanedTranscript, r.targetAppName)
                    .any { it.contains(needle, ignoreCase = true) }
            }
            .sortedByDescending { it.startedAt }
            .take(limit)
            .toList()
    }

    fun record(id: String): DictationRecord? = synchronized(rows) { rows[id] }

    /** Every row id, visibility filter bypassed (tests). */
    internal fun allIDsForTesting(): List<String> = all().sortedBy { it.startedAt }.map { it.id }

    /** What the retry queue drains: offline-queued plus transient failures, oldest first. */
    fun retryableRecords(): List<DictationRecord> = all().filter {
        it.status == SessionMeta.Status.QUEUED_FOR_RETRY ||
            (it.status == SessionMeta.Status.FAILED && it.errorCode in setOf("network", "timeout", "rate_limit"))
    }.sortedBy { it.startedAt }

    /** Non-terminal sessions found at launch: the app died mid-flight. Newest first. */
    fun interruptedRecords(): List<DictationRecord> = all().filter {
        it.status == SessionMeta.Status.RECORDING || it.status == SessionMeta.Status.RECORDED ||
            it.status == SessionMeta.Status.TRANSCRIBING
    }.sortedByDescending { it.startedAt }

    data class Stats(val totalWords: Int, val totalDictations: Int, val averageWPM: Int)

    fun stats(): Stats {
        var words = 0
        var timedWords = 0
        var speech = 0.0
        var count = 0
        for (r in all()) {
            val text = r.cleanedTranscript ?: continue
            count++
            val n = text.split(Regex("\\s+")).count { it.isNotEmpty() }
            words += n
            val duration = r.durationSeconds
            if (duration != null && duration > 0) {
                timedWords += n
                speech += duration
            }
        }
        val wpm = if (speech > 10) (timedWords / (speech / 60)).toInt() else 0
        return Stats(words, count, wpm)
    }

    private companion object { const val TAG = "HistoryStore" }
}
