package com.charles.bento.core.voice.meeting

import com.charles.bento.core.voice.TranscriptionError
import com.charles.bento.core.voice.VoiceLog
import com.charles.bento.core.voice.after
import com.charles.bento.core.voice.audio.FlacEncoder
import com.charles.bento.core.voice.audio.WavReader
import com.charles.bento.core.voice.format.ReplacementEngine
import com.charles.bento.core.voice.secondsSince
import kotlinx.coroutines.CancellationException

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.time.Instant

/** When to clean what: ported from the Mac's MeetingCleanupPlanner. */
object MeetingCleanupPlanner {
    data class Batch(val chunk: Int, val segments: List<MeetingSegment>, val context: String)

    /**
     * The next stretch to clean: once [minWords] of new text has arrived, or the oldest
     * uncleaned text is [maxWait] seconds old, or its chunk has settled; at most
     * [maxWords] per call. `force` (stopping) cleans everything final.
     */
    fun next(document: MeetingDocument, now: Instant, force: Boolean,
             minWords: Int = 140, maxWait: Double = 75.0, maxWords: Int = 450): Batch? {
        for (chunk in document.meta.chunks.sortedBy { it.index }) {
            // While recording, this text is about to be replaced by the batch transcript.
            if (!force && (chunk.status == MeetingChunk.Status.AWAITING_BATCH || chunk.status == MeetingChunk.Status.FAILED ||
                    chunk.status == MeetingChunk.Status.BUFFERING)) continue
            val pending = document.transcript.pendingSegments(chunk.index)
            val oldest = pending.firstOrNull() ?: continue
            val words = pending.sumOf { wordCount(it.text) }
            val settled = !chunk.isOpen && (chunk.status == MeetingChunk.Status.COMPLETE || chunk.status == MeetingChunk.Status.BATCHED)
            if (!(force || settled || words >= minWords || now.secondsSince(oldest.receivedAt) >= maxWait)) continue
            val take = ArrayList<MeetingSegment>()
            var taken = 0
            for (segment in pending) {
                if (take.isNotEmpty() && taken + wordCount(segment.text) > maxWords) break
                take += segment
                taken += wordCount(segment.text)
            }
            return Batch(chunk.index, take, context(chunk.index, take[0].id, document.transcript))
        }
        return null
    }

    /** The tail of the cleaned text just before this point, for continuity across calls. */
    internal fun context(chunk: Int, segment: Int, transcript: MeetingTranscript, characters: Int = 600): String {
        val earlier = transcript.blocks
            .filter { it.chunk < chunk || (it.chunk == chunk && it.lastSegment < segment) }
            .sortedWith(compareBy({ it.chunk }, { it.firstSegment }))
        val last = earlier.lastOrNull() ?: return ""
        if (last.text.length <= characters) return last.text
        val tail = last.text.takeLast(characters)
        val space = tail.indexOfFirst { it.isWhitespace() }
        return if (space >= 0) tail.substring(space + 1) else tail
    }

    internal fun wordCount(text: String) = text.split(Regex("\\s+")).count { it.isNotEmpty() }
}

/** Reads recorded spans back for batch transcription. */
object MeetingAudioExtractor {
    class MissingAudio : IOException("meeting audio is missing")

    /** Mic samples for `range`, with the muted (dictation) ranges silenced; padded past a short file. */
    fun samples(folder: File, part: MeetingPart, range: MeetingFrameRange): ShortArray {
        val mic = File(folder, part.micFileName)
        if (!mic.exists()) throw MissingAudio()
        val out = WavReader.readRange(mic, range.start, range.end)
        for (muted in part.mutedRanges) {
            val lower = maxOf(muted.start, range.start) - range.start
            val upper = minOf(muted.end, range.end) - range.start
            if (lower < upper) out.fill(0, lower.toInt(), upper.toInt())
        }
        return out
    }

    /** Splits a long stretch into uploads of at most ~`maxSeconds`, each cut at the quietest 200 ms nearby. */
    fun windows(samples: ShortArray, maxSeconds: Double = 300.0, searchSeconds: Double = 15.0): List<IntRange> {
        val count = samples.size
        val maxFrames = (maxSeconds * MeetingAudio.SAMPLE_RATE).toInt()
        if (count <= maxFrames || maxFrames <= 0) return listOf(0 until count)
        val pieces = kotlin.math.ceil(count.toDouble() / maxFrames).toInt()
        val search = (searchSeconds * MeetingAudio.SAMPLE_RATE).toInt()
        val probe = (0.2 * MeetingAudio.SAMPLE_RATE).toInt()
        val step = (0.05 * MeetingAudio.SAMPLE_RATE).toInt()
        val cuts = ArrayList<Int>()
        for (piece in 1 until pieces) {
            val ideal = (count.toLong() * piece / pieces).toInt()
            var best = ideal
            var bestEnergy = Double.POSITIVE_INFINITY
            var position = maxOf(0, ideal - search)
            val limit = minOf(count - probe, ideal + search)
            while (position <= limit) {
                var energy = 0.0
                for (i in position until position + probe) {
                    val v = samples[i].toDouble()
                    energy += v * v
                }
                if (energy < bestEnergy) {
                    bestEnergy = energy
                    best = position + probe / 2
                }
                position += step
            }
            val last = cuts.lastOrNull()
            if (last != null && best <= last) best = minOf(count - 1, last + step)
            cuts += best
        }
        val ranges = ArrayList<IntRange>()
        var lower = 0
        for (cut in cuts) {
            if (cut > lower) {
                ranges += lower until cut
                lower = cut
            }
        }
        ranges += lower until count
        return ranges
    }

    /** Frames actually in a part's recording: the truth after a crash. */
    fun framesOnDisk(folder: File, part: MeetingPart): Long? = WavReader.frames(File(folder, part.micFileName))
}

/**
 * One meeting's notes: holds the document, cleans the live transcript as it goes,
 * re-transcribes spans Live missed from the recording, and at the end backfills,
 * cleans everything and writes the summary. Port of the Mac's MeetingProcessor.
 *
 * Confined: every method runs on [dispatcher] (the recorder's). Observe [documentFlow].
 */
@OptIn(ExperimentalCoroutinesApi::class)
class MeetingProcessor internal constructor(
    document: MeetingDocument,
    private val services: MeetingServices,
    private val store: MeetingStore,
    private val scope: CoroutineScope,
    internal val dispatcher: CoroutineDispatcher,
    private val clock: () -> Instant = Instant::now,
) {
    private val docFlow = MutableStateFlow(document)
    val documentFlow: StateFlow<MeetingDocument> = docFlow.asStateFlow()
    var document: MeetingDocument
        get() = docFlow.value
        private set(value) { docFlow.value = value }

    private val stepFlow = MutableStateFlow<String?>(null)
    /** What finishing is doing right now ("Writing the summary…"), or null. */
    val step: StateFlow<String?> = stepFlow.asStateFlow()

    val id: String get() = document.meta.id

    private var cleanupTask: Job? = null
    private var batchTask: Job? = null
    private var cleanupRetryAt: Instant = Instant.MIN
    private var batchRetryAt: Instant = Instant.MIN
    private var finishing = false
    private var saveTask: Job? = null
    private val io = Dispatchers.IO.limitedParallelism(1)

    val isFinishing: Boolean get() = finishing

    // MARK: - Mutations from the recorder

    internal fun addPart(part: MeetingPart) {
        document = document.copy(meta = document.meta.copy(parts = document.meta.parts + part))
        saveNow()
    }

    internal fun updatePart(index: Int, immediately: Boolean = false, mutate: (MeetingPart) -> MeetingPart) {
        document = document.copy(meta = document.meta.updatingPart(index, mutate))
        if (immediately) saveNow() else saveSoon()
    }

    internal fun openChunk(part: Int, startFrame: Long, status: MeetingChunk.Status): Int {
        val index = (document.meta.chunks.maxOfOrNull { it.index } ?: 0) + 1
        document = document.copy(meta = document.meta.copy(chunks = document.meta.chunks + MeetingChunk(index, part, startFrame, status = status)))
        saveNow()
        return index
    }

    internal fun updateChunk(index: Int, mutate: (MeetingChunk) -> MeetingChunk) {
        if (document.meta.chunk(index) == null) return
        document = document.copy(meta = document.meta.updatingChunk(index, mutate))
        saveNow()
        pump()
    }

    internal fun chunk(index: Int): MeetingChunk? = document.meta.chunk(index)

    internal fun appendFinal(chunk: Int, text: String, start: Double) {
        // A span the batch path already rewrote owns its text outright.
        val record = chunk(chunk) ?: return
        if (record.status == MeetingChunk.Status.BATCHED || record.status == MeetingChunk.Status.FAILED) return
        val corrected = ReplacementEngine.apply(services.replacementRules, text)
        val t = document.transcript
        document = document.copy(transcript = t.copy(
            segments = t.segments + MeetingSegment(t.nextSegmentID, chunk, start, corrected, fromBatch = false, receivedAt = clock()),
            nextSegmentID = t.nextSegmentID + 1,
        ))
        saveSoon()
        pump()
    }

    internal fun addUsage(audioTokens: Int, textTokens: Int) {
        val u = document.meta.usage
        document = document.copy(meta = document.meta.copy(usage = u.copy(liveAudioTokens = u.liveAudioTokens + audioTokens,
            liveTextTokens = u.liveTextTokens + textTokens)))
        saveSoon()
    }

    internal fun setStatus(status: MeetingMeta.Status) {
        document = document.copy(meta = document.meta.copy(status = status))
        saveNow()
    }

    internal fun setEndedAt(date: Instant) {
        document = document.copy(meta = document.meta.copy(endedAt = date))
        saveNow()
    }

    fun rename(title: String) {
        val trimmed = title.trim()
        document = document.copy(meta = document.meta.copy(title = trimmed.ifEmpty { null }, titleIsUserSet = trimmed.isNotEmpty()))
        saveNow()
    }

    // MARK: - Persistence

    private fun saveSoon() {
        if (saveTask != null) return
        saveTask = scope.launch(dispatcher) {
            delay(1_000)
            saveTask = null
            saveNow()
        }
    }

    /** Snapshot here, write off the confined thread, in order. */
    fun saveNow() {
        saveTask?.cancel()
        saveTask = null
        val snapshot = store.snapshot(document)
        scope.launch(io) { store.write(snapshot) }
    }

    /** For an app going away: the bytes are on disk when this returns. */
    fun saveSynchronously() {
        saveTask?.cancel()
        saveTask = null
        store.write(store.snapshot(document))
    }

    // MARK: - Background work while recording

    /** Starts whatever work is due. Cheap; called on every change and on the recorder's tick. */
    fun pump() {
        if (finishing) return
        val now = clock()
        if (cleanupTask == null && !now.isBefore(cleanupRetryAt)) {
            val batch = MeetingCleanupPlanner.next(document, now, force = false)
            if (batch != null) {
                cleanupTask = scope.launch(dispatcher) {
                    try { runCleanup(batch, rawOnFailure = false) } finally { cleanupTask = null }
                    pump()
                }
            }
        }
        if (batchTask == null && !now.isBefore(batchRetryAt)) {
            val chunk = document.meta.chunks.filter { it.status == MeetingChunk.Status.AWAITING_BATCH }.minByOrNull { it.index }
            if (chunk != null) {
                batchTask = scope.launch(dispatcher) {
                    try { runBatch(chunk.index, lastChance = false) } finally { batchTask = null }
                    pump()
                }
            }
        }
    }

    private suspend fun runCleanup(batch: MeetingCleanupPlanner.Batch, rawOnFailure: Boolean) {
        val raw = batch.segments.joinToString(" ") { it.text }
        var text = raw
        var cleaned = false
        val model = services.text
        if (model != null) {
            val prompt = MeetingPrompts.cleanup(raw, batch.context, services.vocabulary, services.spellings)
            try {
                val response = model.generate(prompt, json = false, deadline = 60.0)
                bumpTextCalls()
                MeetingPrompts.acceptCleanup(raw, response)?.let { text = it; cleaned = true }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (!rawOnFailure) {
                    // Mid-meeting there is time to wait for the network; storing the raw
                    // text now would keep it raw forever.
                    VoiceLog.i(TAG, "meeting cleanup unavailable (${e.message}) — retrying later")
                    cleanupRetryAt = clock().after(30.0)
                    return
                }
            }
        }
        // The batch path may have replaced this chunk while the model was busy.
        val current = document.transcript.pendingSegments(batch.chunk).take(batch.segments.size)
        if (current.map { it.id } != batch.segments.map { it.id }) return
        val t = document.transcript
        document = document.copy(transcript = t.copy(blocks = t.blocks + MeetingBlock(
            chunk = batch.chunk, firstSegment = batch.segments.first().id, lastSegment = batch.segments.last().id,
            start = batch.segments.first().start, text = ReplacementEngine.apply(services.replacementRules, text), cleaned = cleaned,
        )))
        saveSoon()
    }

    private fun bumpTextCalls() {
        val u = document.meta.usage
        document = document.copy(meta = document.meta.copy(usage = u.copy(textCalls = u.textCalls + 1)))
    }

    private class Piece(val offset: Double, val text: String)

    private suspend fun runBatch(index: Int, lastChance: Boolean) {
        val chunk = chunk(index) ?: return
        if (chunk.status != MeetingChunk.Status.AWAITING_BATCH) return
        val end = chunk.endFrame ?: return
        val part = document.meta.part(chunk.part) ?: return
        val batch = services.batch
        if (batch == null) {
            updateChunk(index) { it.copy(status = MeetingChunk.Status.FAILED, lastError = "No transcription service is configured") }
            return
        }
        val folder = document.folder
        val vocabulary = services.vocabulary
        val base = document.meta.meetingSeconds(chunk.part, chunk.startFrame)
        val range = MeetingFrameRange(chunk.startFrame, end)
        val result: Result<List<Piece>> = withContext(Dispatchers.Default) {
            runCatching { transcribe(folder, part, range, batch, vocabulary) }
        }
        val current = chunk(index)
        if (current == null || current.status != MeetingChunk.Status.AWAITING_BATCH) return
        result.exceptionOrNull()?.let { if (it is CancellationException) throw it }
        val pieces = result.getOrNull()
        if (pieces != null) {
            val rules = services.replacementRules
            var t = document.transcript.copy(
                segments = document.transcript.segments.filter { it.chunk != index },
                blocks = document.transcript.blocks.filter { it.chunk != index },
            )
            for (piece in pieces) {
                if (piece.text.isEmpty()) continue
                t = t.copy(segments = t.segments + MeetingSegment(t.nextSegmentID, index, base + piece.offset,
                    ReplacementEngine.apply(rules, piece.text), fromBatch = true, receivedAt = clock()), nextSegmentID = t.nextSegmentID + 1)
            }
            val u = document.meta.usage
            document = document.copy(
                transcript = t,
                meta = document.meta.updatingChunk(index) { it.copy(status = MeetingChunk.Status.BATCHED, lastError = null) }
                    .copy(usage = u.copy(batchSeconds = u.batchSeconds + MeetingAudio.seconds(range.end - range.start))),
            )
            batchRetryAt = Instant.MIN
            VoiceLog.i(TAG, "meeting chunk $index transcribed from audio (${pieces.size} window(s))")
        } else {
            val error = result.exceptionOrNull() ?: IOException("unknown")
            val attempts = current.attempts + 1
            val permanent = isPermanent(error) || (lastChance && attempts >= 3)
            document = document.copy(meta = document.meta.updatingChunk(index) {
                it.copy(attempts = attempts, lastError = describe(error),
                    status = if (permanent) MeetingChunk.Status.FAILED else it.status)
            })
            if (!permanent) {
                val backoff = doubleArrayOf(5.0, 15.0, 30.0, 60.0, 120.0, 300.0)
                batchRetryAt = clock().after(backoff[minOf(attempts - 1, backoff.size - 1)])
            }
            VoiceLog.i(TAG, "meeting chunk $index batch failed (attempt $attempts): ${describe(error)}")
        }
        saveNow()
    }

    private suspend fun transcribe(folder: File, part: MeetingPart, range: MeetingFrameRange,
                                   batch: MeetingBatchTranscribing, vocabulary: List<String>): List<Piece> {
        val samples = MeetingAudioExtractor.samples(folder, part, range)
        val pieces = ArrayList<Piece>()
        for (window in MeetingAudioExtractor.windows(samples)) {
            // Digital silence (a muted stretch): nothing an upload could return.
            if (window.none { samples[it] > 120 || samples[it] < -120 }) continue
            // A very short span may hold the end of a word; the API rejects clips under
            // ~0.4 s, so pad rather than skip it.
            var audio = samples.copyOfRange(window.first, window.last + 1)
            val minimum = (0.5 * MeetingAudio.SAMPLE_RATE).toInt()
            if (audio.size < minimum) audio = audio.copyOf(minimum)
            val seconds = MeetingAudio.seconds(audio.size.toLong())
            val flac = FlacEncoder.encode(audio)
            val text = try {
                batch.transcribe(flac, seconds, vocabulary)
            } catch (_: TranscriptionError.EmptyTranscript) {
                ""
            }
            pieces += Piece(MeetingAudio.seconds(window.first.toLong()), text.trim())
        }
        return pieces
    }

    // MARK: - Finishing

    /**
     * Runs once capture is over: transcribe what Live missed, clean everything,
     * summarize. Bounded: a meeting that cannot reach the network finishes with gaps
     * marked in the notes and a Retry, rather than spinning forever.
     */
    suspend fun finish() = withContext(dispatcher) {
        if (finishing) return@withContext
        finishing = true
        setStatus(MeetingMeta.Status.FINISHING)
        cleanupTask?.join()
        batchTask?.join()

        for (round in 0 until 3) {
            val pending = document.meta.chunks.filter { it.status == MeetingChunk.Status.AWAITING_BATCH }.map { it.index }
            if (pending.isEmpty()) break
            stepFlow.value = "Transcribing missed audio…"
            for (index in pending.sorted()) runBatch(index, lastChance = round == 2)
            if (round < 2 && document.meta.pendingBatchCount > 0) delay(if (round == 0) 3_000 else 10_000)
        }

        stepFlow.value = "Cleaning up the transcript…"
        var guardrail = document.transcript.segments.size + 4
        while (guardrail > 0) {
            val batch = MeetingCleanupPlanner.next(document, clock(), force = true) ?: break
            runCleanup(batch, rawOnFailure = true)
            guardrail--
        }

        val model = services.text
        if (services.summaryEnabled && model != null && document.transcript.wordCount >= 25) {
            stepFlow.value = "Writing the summary…"
            try {
                val prompt = MeetingPrompts.summary(document.plainTranscript, document.meta.startedAt)
                val response = model.generate(prompt, json = true, deadline = 120.0)
                bumpTextCalls()
                val summary = MeetingPrompts.parseSummary(response)
                document = if (summary != null) {
                    document.copy(meta = document.meta.copy(
                        summary = summary, summaryError = null,
                        title = if (!document.meta.titleIsUserSet && summary.title.isNotEmpty()) summary.title else document.meta.title,
                    ))
                } else {
                    document.copy(meta = document.meta.copy(summaryError = "The summary came back unreadable"))
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                document = document.copy(meta = document.meta.copy(summaryError = describe(e)))
            }
        }

        document = document.copy(meta = document.meta.copy(status = MeetingMeta.Status.COMPLETE,
            endedAt = document.meta.endedAt ?: clock()))
        stepFlow.value = null
        finishing = false
        saveNow()
    }

    /** Gives failed spans, raw-fallback cleanup and a missing summary another go. */
    suspend fun retry() = withContext(dispatcher) {
        if (finishing) return@withContext
        document = document.copy(
            meta = document.meta.copy(chunks = document.meta.chunks.map {
                if (it.status == MeetingChunk.Status.FAILED) it.copy(status = MeetingChunk.Status.AWAITING_BATCH, attempts = 0) else it
            }),
            transcript = document.transcript.copy(blocks = document.transcript.blocks.filter { it.cleaned }),
        )
        batchRetryAt = Instant.MIN
        cleanupRetryAt = Instant.MIN
        finish()
    }

    /** Whether anything is left that [retry] could improve. */
    val canRetry: Boolean
        get() {
            val meta = document.meta
            return meta.status == MeetingMeta.Status.COMPLETE && (meta.failedChunkCount > 0 || meta.pendingBatchCount > 0 ||
                meta.summaryError != null || document.transcript.blocks.any { !it.cleaned })
        }

    companion object {
        private const val TAG = "MeetingProcessor"

        internal fun isPermanent(error: Throwable): Boolean = when (error) {
            is MeetingAudioExtractor.MissingAudio -> true
            is TranscriptionError.BadRequest, TranscriptionError.Auth, is TranscriptionError.ModelUnavailable,
            TranscriptionError.SafetyBlocked, TranscriptionError.RateLimitedDaily -> true
            else -> false
        }

        internal fun describe(error: Throwable): String = when (error) {
            is TranscriptionError -> error.userDescription
            is MeetingAudioExtractor.MissingAudio -> "Audio file missing"
            else -> "Could not read the audio"
        }

        /**
         * A meeting the app died in the middle of, made finishable from what reached
         * disk. Live text whose session never closed cleanly is re-transcribed.
         */
        fun recovered(document: MeetingDocument, recordedFrames: (MeetingPart) -> Long?): MeetingDocument {
            var meta = document.meta
            meta = meta.copy(parts = meta.parts.map { part ->
                if (part.ended) part else part.copy(frames = maxOf(part.frames, recordedFrames(part) ?: 0), ended = true)
            })
            meta = meta.copy(chunks = meta.chunks.map { chunk ->
                var c = chunk
                if (c.endFrame == null) c = c.copy(endFrame = meta.part(c.part)?.frames ?: c.startFrame)
                if (c.status == MeetingChunk.Status.STREAMING || c.status == MeetingChunk.Status.BUFFERING) {
                    c = c.copy(status = MeetingChunk.Status.AWAITING_BATCH)
                }
                val end = c.endFrame
                if (end != null && end <= c.startFrame && c.status == MeetingChunk.Status.AWAITING_BATCH) {
                    c = c.copy(status = MeetingChunk.Status.BATCHED)
                }
                c
            })
            meta = meta.copy(status = MeetingMeta.Status.FINISHING, endedAt = meta.endedAt ?: meta.startedAt.after(meta.durationSeconds))
            return document.copy(meta = meta)
        }
    }
}
