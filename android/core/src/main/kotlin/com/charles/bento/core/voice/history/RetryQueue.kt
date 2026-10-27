package com.charles.bento.core.voice.history

import com.charles.bento.core.voice.AppContext
import com.charles.bento.core.voice.TranscriptionError
import com.charles.bento.core.voice.VoiceLog
import com.charles.bento.core.voice.audio.WavReader
import com.charles.bento.core.voice.dictation.DictationConfig
import com.charles.bento.core.voice.dictation.TranscriptionService
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import java.io.File
import java.time.Instant

/** Audio retention: days to keep recordings once they have a transcript. 0 = forever, negative = never keep. */
object RetentionPolicy {
    fun purgeExpiredAudio(recordingsRoot: File, audioRetentionDays: Int, now: Instant = Instant.now()): Int {
        if (audioRetentionDays == 0) return 0
        val cutoff = if (audioRetentionDays < 0) now.plusSeconds(60) else now.minusSeconds(audioRetentionDays * 86_400L)
        var purged = 0
        recordingsRoot.listFiles()?.filter { it.isDirectory }?.forEach { folder ->
            // Transcript-less cancelled rows are retention-immune: their audio is the only artifact.
            val meta = SessionMeta.read(folder) ?: return@forEach
            if (!meta.startedAt.isBefore(cutoff)) return@forEach
            if (meta.rawTranscript == null && meta.status != SessionMeta.Status.SILENT) return@forEach
            val audio = FileLayout.audioWAV(folder)
            if (audio.exists() && audio.delete()) purged++
        }
        if (purged > 0) VoiceLog.i("RetentionPolicy", "purged $purged audio file(s) older than ${audioRetentionDays}d")
        return purged
    }
}

/** Duration for a recording whose meta never got one (a crash): from the WAV, else the file size. */
internal fun durationOf(meta: SessionMeta, audio: File): Double =
    meta.audioDurationSeconds
        ?: WavReader.frames(audio)?.takeIf { it > 0 }?.let { it / 16_000.0 }
        ?: FileLayout.estimatedDuration(audio)
        ?: 60.0

/** The context a retry runs under: the original target app, the current settings. */
internal fun DictationConfig.forRetry(meta: SessionMeta): DictationConfig =
    copy(context = AppContext(packageName = meta.targetApp, appLabel = meta.targetAppName), live = false)

/**
 * Re-runs queued and transiently failed recordings. The Mac drains on launch and
 * whenever the network comes back; on Android the app calls [drain] at launch and
 * from its connectivity callback. Auth or daily-quota walls stop the drain and keep
 * every row queued: "will retry automatically" never silently becomes "failed".
 */
class RetryQueue(private val store: HistoryStore, private val transcription: TranscriptionService) {
    private val draining = Mutex()

    enum class RetryOutcome { RECOVERED, STILL_OFFLINE, BLOCKED, FAILED, ALREADY_DONE, BUSY }

    /** What a drain did: rows recovered, and the account-level wall that stopped it, if any. */
    data class DrainResult(val recovered: Int, val blockedBy: TranscriptionError?, val stillOffline: Boolean)

    private sealed class Processed {
        data object Recovered : Processed()
        data object StillOffline : Processed()
        data class Blocked(val error: TranscriptionError) : Processed()
        data object Failed : Processed()
        data object Skipped : Processed()
    }

    suspend fun drain(config: DictationConfig): DrainResult {
        if (!draining.tryLock()) return DrainResult(0, null, false)
        try {
            var recovered = 0
            for (record in store.retryableRecords()) {
                when (val result = process(record, config)) {
                    Processed.Recovered -> recovered++
                    Processed.StillOffline -> {
                        VoiceLog.i(TAG, "still offline — pausing drain")
                        return DrainResult(recovered, null, true)
                    }
                    is Processed.Blocked -> {
                        VoiceLog.w(TAG, "drain blocked (${result.error}) — keeping queue intact")
                        return DrainResult(recovered, result.error, false)
                    }
                    Processed.Failed, Processed.Skipped -> continue
                }
            }
            return DrainResult(recovered, null, false)
        } finally {
            draining.unlock()
        }
    }

    /** Manual per-row retry; shares the drain's guard so a row is never sent twice at once. */
    suspend fun retrySingle(record: DictationRecord, config: DictationConfig): RetryOutcome {
        if (!draining.tryLock()) return RetryOutcome.BUSY
        try {
            return when (process(record, config)) {
                Processed.Recovered -> RetryOutcome.RECOVERED
                Processed.StillOffline -> RetryOutcome.STILL_OFFLINE
                is Processed.Blocked -> RetryOutcome.BLOCKED
                Processed.Failed -> RetryOutcome.FAILED
                Processed.Skipped -> RetryOutcome.ALREADY_DONE
            }
        } finally {
            draining.unlock()
        }
    }

    private suspend fun process(record: DictationRecord, config: DictationConfig): Processed {
        val folder = record.folder
        var meta = SessionMeta.read(folder) ?: return Processed.Skipped
        // Re-read from disk: a concurrent path may have finished it already.
        if (meta.status == SessionMeta.Status.AWAITING_CHIP || meta.status == SessionMeta.Status.INSERTED ||
            meta.status == SessionMeta.Status.RECOVERED
        ) return Processed.Skipped

        fun save(updated: SessionMeta) {
            meta = updated
            updated.write(folder)
            store.upsert(updated, folder)
        }

        // The transcript already exists (crash after transcription): recover the words.
        if (meta.rawTranscript != null) {
            save(meta.copy(status = SessionMeta.Status.RECOVERED, errorCode = null))
            return Processed.Recovered
        }
        val audio = FileLayout.audioWAV(folder)
        if (!audio.exists()) {
            save(meta.copy(status = SessionMeta.Status.FAILED, errorCode = "audio_purged"))
            return Processed.Failed
        }
        return try {
            val result = transcription.transcribe(audio, durationOf(meta, audio), config.forRetry(meta), meta.editingSession)
            // RECOVERED, not inserted: the text never reached a field.
            save(meta.copy(rawTranscript = result.rawTranscript, cleanedTranscript = result.cleanedTranscript,
                modelID = result.modelID, status = SessionMeta.Status.RECOVERED, errorCode = null, errorMessage = null))
            Processed.Recovered
        } catch (e: CancellationException) {
            throw e
        } catch (e: TranscriptionError) {
            when (e) {
                TranscriptionError.Offline, is TranscriptionError.Network, TranscriptionError.Timeout,
                TranscriptionError.RateLimitedTransient -> Processed.StillOffline
                // Account-level wall: not this row's fault. Its queued status stays untouched.
                TranscriptionError.Auth, TranscriptionError.RateLimitedDaily -> Processed.Blocked(e)
                is TranscriptionError.ModelUnavailable -> {
                    save(meta.copy(status = SessionMeta.Status.FAILED, errorCode = "model",
                        errorMessage = e.detail ?: "model ${e.model} not accessible"))
                    Processed.Failed
                }
                is TranscriptionError.BadRequest -> {
                    save(meta.copy(status = SessionMeta.Status.FAILED, errorCode = "bad_request", errorMessage = e.detail))
                    Processed.Failed
                }
                else -> {
                    save(meta.copy(status = SessionMeta.Status.FAILED, errorCode = "retry_${e.message}"))
                    Processed.Failed
                }
            }
        } catch (e: Exception) {
            // An unreadable recording: mark it failed so the queue never spins on it.
            VoiceLog.e(TAG, "unexpected error ${e.javaClass.simpleName}")
            save(meta.copy(status = SessionMeta.Status.FAILED, errorCode = "retry_unexpected"))
            Processed.Failed
        }
    }

    private companion object { const val TAG = "RetryQueue" }
}

/**
 * Launch recovery: sessions the app died in the middle of. A stored transcript is
 * surfaced as is; the newest recording without one is transcribed (quota-respectful:
 * only one); older ones are queued for the retry queue. Nothing is ever inserted.
 */
class RecoveryScanner(private val store: HistoryStore, private val transcription: TranscriptionService) {
    data class Report(val interrupted: Int, val recoveredLatest: Boolean, val queued: Int, val message: String?)

    suspend fun scanAndRecover(config: DictationConfig): Report {
        store.reindex()
        val interrupted = store.interruptedRecords()
        if (interrupted.isEmpty()) return Report(0, false, 0, null)
        VoiceLog.i("RecoveryScanner", "${interrupted.size} interrupted session(s) found")
        var recoveredLatest = false
        var queued = 0
        var message: String? = null
        for ((index, record) in interrupted.withIndex()) {
            val folder = record.folder
            var meta = SessionMeta.read(folder) ?: continue
            fun save(updated: SessionMeta) {
                meta = updated
                updated.write(folder)
                store.upsert(updated, folder)
            }
            // Crashed after the transcript was stored: the words exist, surface them.
            // Before the audio check: "never keep audio" may have purged the recording.
            if (meta.rawTranscript != null) {
                save(meta.copy(status = SessionMeta.Status.RECOVERED))
                if (index == 0) { recoveredLatest = true; message = RECOVERED_MESSAGE }
                continue
            }
            val audio = FileLayout.audioWAV(folder)
            if (!audio.exists()) {
                save(meta.copy(status = SessionMeta.Status.FAILED, errorCode = "no_audio_file"))
                continue
            }
            if ((WavReader.frames(audio) ?: 0L) == 0L) {
                // Killed before the first buffer landed: nothing a retry could ever
                // transcribe, so no dead-end row either.
                store.delete(meta.id, removeFolder = true)
                continue
            }
            val duration = durationOf(meta, audio)
            if (index == 0) {
                try {
                    val result = transcription.transcribe(audio, duration, config.forRetry(meta), meta.editingSession)
                    save(meta.copy(rawTranscript = result.rawTranscript, cleanedTranscript = result.cleanedTranscript,
                        modelID = result.modelID, status = SessionMeta.Status.RECOVERED, audioDurationSeconds = duration))
                    recoveredLatest = true
                    message = RECOVERED_MESSAGE
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    save(meta.copy(status = SessionMeta.Status.QUEUED_FOR_RETRY, audioDurationSeconds = duration))
                    queued++
                    VoiceLog.w("RecoveryScanner", "recovery transcription failed — queued (${e.message})")
                }
            } else {
                save(meta.copy(status = SessionMeta.Status.QUEUED_FOR_RETRY, errorCode = meta.errorCode ?: "recovered",
                    audioDurationSeconds = duration))
                queued++
            }
        }
        return Report(interrupted.size, recoveredLatest, queued, message)
    }

    private companion object { const val RECOVERED_MESSAGE = "Recovered your last dictation — it's in History" }
}
