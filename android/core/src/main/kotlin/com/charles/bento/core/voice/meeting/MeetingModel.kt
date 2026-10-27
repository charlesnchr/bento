package com.charles.bento.core.voice.meeting

import com.charles.bento.core.voice.InstantIsoSerializer
import com.charles.bento.core.voice.audio.AudioFormat
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/** Meeting audio is 16 kHz mono PCM16, like dictation. */
object MeetingAudio {
    const val SAMPLE_RATE = AudioFormat.SAMPLE_RATE
    fun seconds(frames: Long): Double = frames.toDouble() / SAMPLE_RATE
    fun frames(seconds: Double): Long = kotlin.math.round(seconds * SAMPLE_RATE).toLong()
}

@Serializable
data class MeetingFrameRange(val start: Long, val end: Long)

/** A stretch of continuous capture between start/resume and pause/stop, with its own recording file. */
@Serializable
data class MeetingPart(
    val index: Int,
    @Serializable(with = InstantIsoSerializer::class) val startedAt: Instant,
    /** Frames delivered to the stream, which equals frames in the part's recording. */
    val frames: Long = 0,
    /** Always false on Android (mic only); kept for the Mac's format. */
    val hasSystemAudio: Boolean = false,
    /** Where the mic was kept out of the stream (the user was dictating). Batch applies the same ranges. */
    val mutedRanges: List<MeetingFrameRange> = emptyList(),
    val ended: Boolean = false,
) {
    val micFileName: String get() = "part-$index-mic.wav"
}

@Serializable
data class MeetingChunk(
    val index: Int,
    val part: Int,
    val startFrame: Long,
    val endFrame: Long? = null,
    val status: Status,
    val attempts: Int = 0,
    val lastError: String? = null,
) {
    @Serializable
    enum class Status {
        /** A Live session is attached (or flushing its last utterance). */
        @SerialName("streaming") STREAMING,
        /** Audio only: Live is unavailable, failed or reconnecting. */
        @SerialName("buffering") BUFFERING,
        /** The Live session ended cleanly; its finals are the transcript. */
        @SerialName("complete") COMPLETE,
        /** Closed, and must be transcribed from the recording. */
        @SerialName("awaitingBatch") AWAITING_BATCH,
        /** The batch transcript replaced whatever Live produced for this span. */
        @SerialName("batched") BATCHED,
        /** Batch gave up on a permanent error. Retry is manual. */
        @SerialName("failed") FAILED,
    }

    val isOpen: Boolean get() = endFrame == null

    /** True while this span's text may still be replaced wholesale. */
    val isProvisional: Boolean
        get() = status == Status.BUFFERING || status == Status.AWAITING_BATCH || status == Status.FAILED
}

@Serializable
data class MeetingSegment(
    val id: Int,
    val chunk: Int,
    /** Seconds into the meeting's recorded audio (paused time excluded). */
    val start: Double,
    val text: String,
    val fromBatch: Boolean,
    @Serializable(with = InstantIsoSerializer::class) val receivedAt: Instant,
)

@Serializable
data class MeetingBlock(
    val chunk: Int,
    val firstSegment: Int,
    val lastSegment: Int,
    val start: Double,
    val text: String,
    /** False when cleanup was unavailable or rejected: the raw text with Dictionary rules. */
    val cleaned: Boolean,
)

@Serializable
data class MeetingActionItem(val task: String, val owner: String? = null, val due: String? = null)

@Serializable
data class MeetingSummary(
    val title: String,
    val overview: List<String>,
    val decisions: List<String>,
    val actionItems: List<MeetingActionItem>,
)

@Serializable
data class MeetingUsage(
    val liveAudioTokens: Int = 0,
    val liveTextTokens: Int = 0,
    val batchSeconds: Double = 0.0,
    val textCalls: Int = 0,
) {
    /** Published Live Transcribe rates plus batch per minute; text calls are left out rather than guessed. */
    val estimatedCostUSD: Double
        get() = liveAudioTokens * 3.5 / 1_000_000 + liveTextTokens * 21.0 / 1_000_000 + batchSeconds / 60 * 0.005
}

@Serializable
data class MeetingMeta(
    val id: String,
    @Serializable(with = InstantIsoSerializer::class) val startedAt: Instant,
    @Serializable(with = InstantIsoSerializer::class) val endedAt: Instant? = null,
    val status: Status = Status.RECORDING,
    val title: String? = null,
    val titleIsUserSet: Boolean = false,
    val parts: List<MeetingPart> = emptyList(),
    val chunks: List<MeetingChunk> = emptyList(),
    val summary: MeetingSummary? = null,
    val summaryError: String? = null,
    val usage: MeetingUsage = MeetingUsage(),
) {
    @Serializable
    enum class Status {
        @SerialName("recording") RECORDING,
        @SerialName("paused") PAUSED,
        /** Capture is over; batch, cleanup and summary are still running. */
        @SerialName("finishing") FINISHING,
        @SerialName("complete") COMPLETE,
        /** The app died with this meeting in flight; launch recovery finishes it from disk. */
        @SerialName("interrupted") INTERRUPTED,
    }

    val recordedFrames: Long get() = parts.sumOf { it.frames }
    val durationSeconds: Double get() = MeetingAudio.seconds(recordedFrames)

    /** Frames recorded before `part` began: turns a part-local frame into meeting time. */
    fun frameBase(part: Int): Long = parts.filter { it.index < part }.sumOf { it.frames }

    fun meetingSeconds(part: Int, frame: Long): Double = MeetingAudio.seconds(frameBase(part) + frame)

    fun part(index: Int): MeetingPart? = parts.firstOrNull { it.index == index }
    fun chunk(index: Int): MeetingChunk? = chunks.firstOrNull { it.index == index }

    val pendingBatchCount: Int get() = chunks.count { it.status == MeetingChunk.Status.AWAITING_BATCH }
    val failedChunkCount: Int get() = chunks.count { it.status == MeetingChunk.Status.FAILED }

    fun updatingChunk(index: Int, mutate: (MeetingChunk) -> MeetingChunk) =
        copy(chunks = chunks.map { if (it.index == index) mutate(it) else it })

    fun updatingPart(index: Int, mutate: (MeetingPart) -> MeetingPart) =
        copy(parts = parts.map { if (it.index == index) mutate(it) else it })
}

@Serializable
data class MeetingTranscript(
    val segments: List<MeetingSegment> = emptyList(),
    val blocks: List<MeetingBlock> = emptyList(),
    val nextSegmentID: Int = 1,
) {
    /** The last segment of `chunk` covered by a block, or 0. */
    fun cleanedThrough(chunk: Int): Int = blocks.filter { it.chunk == chunk }.maxOfOrNull { it.lastSegment } ?: 0

    fun pendingSegments(chunk: Int): List<MeetingSegment> {
        val through = cleanedThrough(chunk)
        return segments.filter { it.chunk == chunk && it.id > through }.sortedBy { it.id }
    }

    val wordCount: Int get() = segments.sumOf { s -> s.text.split(TRANSCRIPT_WHITESPACE).count { it.isNotEmpty() } }

}

data class MeetingParagraph(val id: String, val start: Double?, val text: String, val kind: Kind) {
    sealed class Kind {
        /** Cleanup has run over it. */
        data object Cleaned : Kind()
        /** Final from the model, not cleaned yet. */
        data object Pending : Kind()
        /** Audio with no transcript yet, or that batch gave up on. */
        data class Gap(val seconds: Double, val failed: Boolean) : Kind()
    }
}

/** A meeting's folder, metadata and transcript. */
data class MeetingDocument(
    val folder: File,
    val meta: MeetingMeta,
    val transcript: MeetingTranscript,
) {
    fun displayTitle(locale: Locale = Locale.getDefault(), zone: ZoneId = ZoneId.systemDefault()): String {
        meta.title?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
        val formatter = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT).withLocale(locale).withZone(zone)
        return "Meeting, " + plainSpaces(formatter.format(meta.startedAt))
    }

    /**
     * Reading order: chunk by chunk, each chunk's cleaned blocks then whatever arrived
     * since the last cleanup. A chunk with no text yet shows as a gap, so missing audio
     * is visible rather than a silent jump.
     */
    val paragraphs: List<MeetingParagraph>
        get() {
            val out = ArrayList<MeetingParagraph>()
            val blocksByChunk = transcript.blocks.groupBy { it.chunk }
            val segmentsByChunk = transcript.segments.groupBy { it.chunk }
            for (chunk in meta.chunks.sortedBy { it.index }) {
                val blocks = (blocksByChunk[chunk.index] ?: emptyList()).sortedBy { it.firstSegment }
                for (block in blocks) {
                    val pieces = block.text.split("\n\n").map { it.trim() }.filter { it.isNotEmpty() }
                    for ((offset, piece) in pieces.withIndex()) {
                        out.add(MeetingParagraph("b${block.chunk}-${block.firstSegment}-$offset",
                            if (offset == 0) block.start else null, piece, MeetingParagraph.Kind.Cleaned))
                    }
                }
                val through = blocks.maxOfOrNull { it.lastSegment } ?: 0
                val pending = (segmentsByChunk[chunk.index] ?: emptyList()).filter { it.id > through }.sortedBy { it.id }
                val end = chunk.endFrame
                if (pending.isNotEmpty()) {
                    out.add(MeetingParagraph("p${chunk.index}-${pending[0].id}", if (blocks.isEmpty()) pending[0].start else null,
                        pending.joinToString(" ") { it.text }, MeetingParagraph.Kind.Pending))
                } else if (blocks.isEmpty() && (chunk.status == MeetingChunk.Status.AWAITING_BATCH || chunk.status == MeetingChunk.Status.FAILED) &&
                    end != null && end > chunk.startFrame
                ) {
                    out.add(MeetingParagraph("g${chunk.index}", meta.meetingSeconds(chunk.part, chunk.startFrame), "",
                        MeetingParagraph.Kind.Gap(MeetingAudio.seconds(end - chunk.startFrame), chunk.status == MeetingChunk.Status.FAILED)))
                }
            }
            return out
        }

    /** The transcript as plain text, cleaned where cleanup ran: what the summary is written from. */
    val plainTranscript: String
        get() = paragraphs.filter { it.kind !is MeetingParagraph.Kind.Gap }.joinToString("\n\n") { it.text }

    /** The Mac's `notes.md`: title, date line, summary sections, then the timestamped transcript. */
    fun markdown(locale: Locale = Locale.getDefault(), zone: ZoneId = ZoneId.systemDefault()): String {
        val lines = ArrayList<String>()
        lines += "# ${displayTitle(locale, zone)}"
        lines += ""
        lines += "_${subtitle(locale, zone)}_"
        lines += ""
        meta.summary?.let { lines += summarySections(it) }
        lines += "## Transcript"
        lines += ""
        val paragraphs = paragraphs
        if (paragraphs.isEmpty()) {
            lines += "_Nothing transcribed yet._"
            lines += ""
        }
        for (paragraph in paragraphs) {
            lines += transcriptLine(paragraph)
            lines += ""
        }
        return lines.joinToString("\n")
    }

    /** "October 27, 2026 at 8:45 PM · 32 min". */
    fun subtitle(locale: Locale = Locale.getDefault(), zone: ZoneId = ZoneId.systemDefault()): String {
        val formatter = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.LONG, FormatStyle.SHORT).withLocale(locale).withZone(zone)
        var subtitle = plainSpaces(formatter.format(meta.startedAt))
        val minutes = kotlin.math.round(meta.durationSeconds / 60).toInt()
        if (meta.durationSeconds > 0) subtitle += " · ${maxOf(1, minutes)} min"
        return subtitle
    }

    companion object {
        /** "4:07", or "1:02:09" past the hour. */
        fun timestamp(seconds: Double): String {
            val total = maxOf(0, kotlin.math.floor(seconds).toInt())
            val hours = total / 3600
            val minutes = (total % 3600) / 60
            val secs = total % 60
            return if (hours > 0) String.format(Locale.ROOT, "%d:%02d:%02d", hours, minutes, secs)
            else String.format(Locale.ROOT, "%d:%02d", minutes, secs)
        }

        /** Summary, Decisions and Action items (`- [ ]` tasks), each only when non-empty. */
        internal fun summarySections(summary: MeetingSummary): List<String> {
            val lines = ArrayList<String>()
            if (summary.overview.isNotEmpty()) {
                lines += "## Summary"
                lines += summary.overview.map { "- $it" }
                lines += ""
            }
            if (summary.decisions.isNotEmpty()) {
                lines += "## Decisions"
                lines += summary.decisions.map { "- $it" }
                lines += ""
            }
            if (summary.actionItems.isNotEmpty()) {
                lines += "## Action items"
                for (item in summary.actionItems) {
                    var line = "- [ ] "
                    if (!item.owner.isNullOrEmpty()) line += "**${item.owner}**: "
                    line += item.task
                    if (!item.due.isNullOrEmpty()) line += " (due ${item.due})"
                    lines += line
                }
                lines += ""
            }
            return lines
        }

        internal fun transcriptLine(paragraph: MeetingParagraph): String {
            val stamp = paragraph.start?.let { "**[${timestamp(it)}]** " } ?: ""
            return when (val kind = paragraph.kind) {
                MeetingParagraph.Kind.Cleaned, MeetingParagraph.Kind.Pending -> stamp + paragraph.text
                is MeetingParagraph.Kind.Gap -> {
                    val length = timestamp(kind.seconds)
                    stamp + if (kind.failed) "_${length} of audio could not be transcribed. Retry from Bento's Meetings screen._"
                    else "_${length} of audio is still being transcribed._"
                }
            }
        }
    }
}

private val TRANSCRIPT_WHITESPACE = Regex("\\s+")

/** Localized times use a narrow no-break space ("2:00 PM" on JDK 20+); notes read better with a plain one. */
internal fun plainSpaces(text: String): String = text.replace('\u202F', ' ').replace('\u00A0', ' ')
