package com.charles.bento.core.voice.meeting

import com.charles.bento.core.voice.AtomicFile
import com.charles.bento.core.voice.VoiceJson
import com.charles.bento.core.voice.VoiceJsonCompact
import com.charles.bento.core.voice.VoiceLog
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.io.File
import java.io.IOException
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Meetings on disk: `<root>/meetings/<yyyyMMdd-HHmmss-id8>/` with `meeting.json`
 * (small: listing reads only this), `transcript.json`, `notes.md` and one WAV per part.
 */
class MeetingStore(voiceRoot: File) {
    val root: File = File(voiceRoot, "meetings")
    private val version = MutableStateFlow(0L)

    /** Bumps after every write or delete, so a Meetings list can refresh without polling. */
    val changes: StateFlow<Long> = version.asStateFlow()

    private val folderStamp = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss", Locale.US).withZone(ZoneId.systemDefault())

    @Throws(IOException::class)
    fun makeFolder(id: String, now: Instant): File {
        val folder = File(root, "${folderStamp.format(now)}-${id.take(8)}")
        if (!folder.mkdirs() && !folder.isDirectory) throw IOException("could not create ${folder.name}")
        return folder
    }

    /** A document serialized on the caller's thread: one consistent snapshot, written anywhere. */
    class Snapshot internal constructor(val folder: File, internal val meta: ByteArray, internal val transcript: ByteArray, internal val notes: ByteArray)

    fun snapshot(document: MeetingDocument): Snapshot = Snapshot(
        folder = document.folder,
        meta = VoiceJson.encodeToString(MeetingMeta.serializer(), document.meta).toByteArray(),
        transcript = VoiceJsonCompact.encodeToString(MeetingTranscript.serializer(), document.transcript).toByteArray(),
        notes = document.markdown().toByteArray(),
    )

    fun write(snapshot: Snapshot) {
        try {
            // Transcript before meta: a crash between the two leaves meta pointing at
            // chunks the transcript already has, never the reverse.
            AtomicFile.write(transcriptFile(snapshot.folder), snapshot.transcript)
            AtomicFile.write(metaFile(snapshot.folder), snapshot.meta)
            AtomicFile.write(notesFile(snapshot.folder), snapshot.notes)
        } catch (e: IOException) {
            VoiceLog.e("MeetingStore", "write failed in ${snapshot.folder.name}: ${e.message}")
        }
        version.update { it + 1 }
    }

    fun save(document: MeetingDocument) = write(snapshot(document))

    fun loadMeta(folder: File): MeetingMeta? {
        val text = runCatching { metaFile(folder).readText() }.getOrNull() ?: return null
        return runCatching { VoiceJson.decodeFromString(MeetingMeta.serializer(), text) }.getOrNull()
    }

    fun load(folder: File): MeetingDocument? {
        val meta = loadMeta(folder) ?: return null
        val transcript = runCatching {
            VoiceJson.decodeFromString(MeetingTranscript.serializer(), transcriptFile(folder).readText())
        }.getOrNull() ?: MeetingTranscript()
        return MeetingDocument(folder, meta, transcript)
    }

    data class Entry(val folder: File, val meta: MeetingMeta)

    /** Every meeting, newest first. */
    fun list(): List<Entry> = (root.listFiles() ?: emptyArray())
        .filter { it.isDirectory }
        .mapNotNull { folder -> loadMeta(folder)?.let { Entry(folder, it) } }
        .sortedByDescending { it.meta.startedAt }

    fun find(id: String): Entry? = list().firstOrNull { it.meta.id == id }

    /**
     * Audio retention applies to meetings too. Only finished meetings with nothing left
     * to transcribe lose their audio: a pending or failed span still needs it for Retry.
     */
    fun purgeExpiredAudio(retentionDays: Int, now: Instant = Instant.now()): Int {
        if (retentionDays == 0) return 0
        val cutoff = if (retentionDays < 0) now else now.minusSeconds(retentionDays * 86_400L)
        var purged = 0
        for ((folder, meta) in list()) {
            if (meta.status != MeetingMeta.Status.COMPLETE || !(meta.endedAt ?: meta.startedAt).isBefore(cutoff)) continue
            if (meta.pendingBatchCount != 0 || meta.failedChunkCount != 0) continue
            for (part in meta.parts) {
                val file = File(folder, part.micFileName)
                if (file.exists() && file.delete()) purged++
            }
        }
        if (purged > 0) VoiceLog.i("MeetingStore", "purged $purged meeting audio file(s) past retention")
        return purged
    }

    fun delete(folder: File) {
        folder.deleteRecursively()
        version.update { it + 1 }
    }

    companion object {
        fun metaFile(folder: File) = File(folder, "meeting.json")
        fun transcriptFile(folder: File) = File(folder, "transcript.json")
        fun notesFile(folder: File) = File(folder, "notes.md")
    }
}
