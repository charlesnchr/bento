package com.charles.bento.core.voice.history

import com.charles.bento.core.voice.AtomicFile
import com.charles.bento.core.voice.InstantIsoSerializer
import com.charles.bento.core.voice.VoiceJson
import com.charles.bento.core.voice.VoiceLog
import com.charles.bento.core.voice.dictation.EditingSession
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.io.File
import java.io.IOException
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.UUID

/** One dictation's folder record (`meta.json`), the source of truth History is built from. */
@Serializable
data class SessionMeta(
    val id: String,
    @Serializable(with = InstantIsoSerializer::class) val startedAt: Instant,
    val status: Status,
    /** Target app's package name (the Mac's bundle id, same key). */
    @SerialName("targetAppBundleID") val targetApp: String? = null,
    val targetAppName: String? = null,
    val audioDurationSeconds: Double? = null,
    /** Seconds-from-start positions where audio may have a seam. */
    val gapMarkers: List<Double> = emptyList(),
    val rawTranscript: String? = null,
    val cleanedTranscript: String? = null,
    val errorCode: String? = null,
    /** Human-relevant API error detail (e.g. the 404 body naming the model). */
    val errorMessage: String? = null,
    val modelID: String? = null,
    /** Stop → terminal-state latency. */
    val pipelineSeconds: Double? = null,
    /** How loud the room was and how loud the speech got (dBFS), recorded on every session. */
    @SerialName("noiseFloorDBFS") val noiseFloorDBFS: Double? = null,
    @SerialName("speechPeakDBFS") val speechPeakDBFS: Double? = null,
    val editingSession: EditingSession? = null,
) {
    @Serializable
    enum class Status {
        @SerialName("recording") RECORDING,
        /** Audio finalized on disk; transcription not yet complete. */
        @SerialName("recorded") RECORDED,
        @SerialName("transcribing") TRANSCRIBING,
        @SerialName("inserted") INSERTED,
        @SerialName("copiedToClipboard") COPIED_TO_CLIPBOARD,
        @SerialName("awaitingChip") AWAITING_CHIP,
        @SerialName("heldSecure") HELD_SECURE,
        @SerialName("queuedForRetry") QUEUED_FOR_RETRY,
        /** Transcribed after a crash or an offline drain: never inserted, so no UI may promise it was. */
        @SerialName("recovered") RECOVERED,
        @SerialName("silent") SILENT,
        @SerialName("cancelled") CANCELLED,
        @SerialName("failed") FAILED;

        val wire: String get() = name.lowercase().let { if (it.contains('_')) camel(it) else it }

        private fun camel(s: String) = s.split('_').mapIndexed { i, p -> if (i == 0) p else p.replaceFirstChar { it.uppercase() } }.joinToString("")
    }

    /** Atomic write; a failure is logged, never thrown (the audio is what matters). */
    fun write(folder: File) {
        try {
            AtomicFile.write(FileLayout.metaJSON(folder), VoiceJson.encodeToString(serializer(), this).toByteArray())
        } catch (e: IOException) {
            VoiceLog.e("SessionMeta", "write failed for $id: ${e.message}")
        }
    }

    companion object {
        fun read(folder: File): SessionMeta? {
            val file = FileLayout.metaJSON(folder)
            val text = runCatching { file.readText() }.getOrNull() ?: return null
            return runCatching { VoiceJson.decodeFromString(serializer(), text) }.getOrNull()
        }
    }
}

/** Where a voice store keeps things, under the directory the app passes in. */
object FileLayout {
    fun recordingsRoot(root: File) = File(root, "recordings")
    fun meetingsRoot(root: File) = File(root, "meetings")

    private val folderStamp: DateTimeFormatter =
        DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss", Locale.US).withZone(ZoneId.systemDefault())

    /** Creates a fresh session folder, timestamp-prefixed for human sortability. */
    @Throws(IOException::class)
    fun makeSessionFolder(root: File, id: String, now: Instant): File {
        val folder = File(recordingsRoot(root), "${folderStamp.format(now)}-${id.take(8)}")
        if (!folder.mkdirs() && !folder.isDirectory) throw IOException("could not create ${folder.name}")
        return folder
    }

    fun audioWAV(folder: File) = File(folder, "audio.wav")
    fun metaJSON(folder: File) = File(folder, "meta.json")

    /** Duration estimate from the recording's size, for crashed sessions that never wrote one. */
    fun estimatedDuration(audio: File): Double? {
        val bytes = audio.length()
        if (!audio.exists() || bytes <= 4096) return null
        return (bytes - 44).toDouble() / 32_000
    }

    fun newId(): String = UUID.randomUUID().toString().uppercase()
}
