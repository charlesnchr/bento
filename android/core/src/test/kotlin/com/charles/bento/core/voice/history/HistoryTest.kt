package com.charles.bento.core.voice.history

import com.charles.bento.core.voice.TranscriptionError
import com.charles.bento.core.voice.TranscriptionResult
import com.charles.bento.core.voice.audio.WavWriter
import com.charles.bento.core.voice.blocking
import com.charles.bento.core.voice.dictation.DictationConfig
import com.charles.bento.core.voice.dictation.FakeTranscription
import com.charles.bento.core.voice.tempDir
import com.charles.bento.core.voice.tone
import java.io.File
import java.time.Instant
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

private fun HistoryStore.session(
    status: SessionMeta.Status, transcript: String? = null, onDisk: Boolean = true, audioSeconds: Double? = null,
    startedAt: Instant = Instant.now(), errorCode: String? = null, duration: Double? = null, app: String? = null,
): Pair<SessionMeta, File> {
    val meta = SessionMeta(UUID.randomUUID().toString(), startedAt, status, rawTranscript = transcript, cleanedTranscript = transcript,
        errorCode = errorCode, audioDurationSeconds = duration, targetAppName = app)
    val folder = File(recordingsRoot, meta.id)
    if (onDisk) {
        folder.mkdirs()
        meta.write(folder)
        audioSeconds?.let { WavWriter.write(FileLayout.audioWAV(folder), tone(it)) }
    }
    upsert(meta, folder)
    return meta to folder
}

/** Port of HistoryStoreTests.swift, plus search, visibility and the queues. */
class HistoryStoreTest {
    private val root = tempDir("history")
    private val store = HistoryStore(root)

    @Test fun reindexPrunesInvisibleOrphans() {
        store.session(SessionMeta.Status.SILENT, onDisk = false)
        store.session(SessionMeta.Status.CANCELLED, onDisk = false)
        val keptVisible = store.session(SessionMeta.Status.INSERTED, "hello there").first
        val keptInvisible = store.session(SessionMeta.Status.SILENT).first
        store.reindex()
        assertEquals(setOf(keptVisible.id, keptInvisible.id), store.allIDsForTesting().toSet())
    }

    @Test fun reindexKeepsRowsWithFolders() {
        val kept = store.session(SessionMeta.Status.INSERTED, "still here").first
        store.reindex()
        assertEquals(listOf(kept.id), store.allIDsForTesting())
    }

    @Test fun aFreshStoreRebuildsFromTheFolders() {
        val meta = store.session(SessionMeta.Status.INSERTED, "from disk").first
        val reopened = HistoryStore(root)
        assertTrue(reopened.records().isEmpty())
        reopened.reindex()
        assertEquals(meta.id, reopened.records().single().id)
    }

    @Test fun visibilityIsALibraryOfWordsNotAnEventLog() {
        val t = Instant.parse("2026-10-27T10:00:00Z")
        val words = store.session(SessionMeta.Status.INSERTED, "words", startedAt = t.plusSeconds(5)).first
        val failed = store.session(SessionMeta.Status.FAILED, startedAt = t.plusSeconds(4)).first
        val queued = store.session(SessionMeta.Status.QUEUED_FOR_RETRY, startedAt = t.plusSeconds(3)).first
        val longCancel = store.session(SessionMeta.Status.CANCELLED, duration = 12.0, startedAt = t.plusSeconds(2)).first
        store.session(SessionMeta.Status.CANCELLED, duration = 3.0)
        store.session(SessionMeta.Status.SILENT)
        store.session(SessionMeta.Status.RECORDING)
        store.session(SessionMeta.Status.TRANSCRIBING)
        assertEquals(listOf(words.id, failed.id, queued.id, longCancel.id), store.records().map { it.id }, "newest first")
    }

    @Test fun searchMatchesTranscriptsAndAppNamesLiterally() {
        val pct = store.session(SessionMeta.Status.INSERTED, "We hit 100% of the goal").first
        val app = store.session(SessionMeta.Status.INSERTED, "unrelated", app = "Slack").first
        store.session(SessionMeta.Status.INSERTED, "We hit 1000 of the goal")
        assertEquals(listOf(pct.id), store.records("100%").map { it.id })
        assertEquals(listOf(app.id), store.records("slack").map { it.id })
        assertEquals(3, store.records("  ").size)
    }

    @Test fun retryableAndInterruptedQueues() {
        val t = Instant.parse("2026-10-27T10:00:00Z")
        val q = store.session(SessionMeta.Status.QUEUED_FOR_RETRY, startedAt = t).first
        val net = store.session(SessionMeta.Status.FAILED, errorCode = "network", startedAt = t.plusSeconds(1)).first
        store.session(SessionMeta.Status.FAILED, errorCode = "auth")
        store.session(SessionMeta.Status.FAILED, errorCode = "tooNoisy")
        assertEquals(listOf(q.id, net.id), store.retryableRecords().map { it.id }, "oldest first")
        val rec = store.session(SessionMeta.Status.RECORDING, startedAt = t).first
        val recd = store.session(SessionMeta.Status.RECORDED, startedAt = t.plusSeconds(1)).first
        assertEquals(listOf(recd.id, rec.id), store.interruptedRecords().map { it.id }, "newest first")
    }

    @Test fun deleteAllSweepsTheDirectorySparingTheLiveSession() {
        val (_, a) = store.session(SessionMeta.Status.INSERTED, "a")
        val (_, hidden) = store.session(SessionMeta.Status.CANCELLED, duration = 2.0)
        val (_, live) = store.session(SessionMeta.Status.RECORDING)
        val version = store.changes.value
        store.deleteAll(removeFolders = true, sparing = live)
        assertFalse(a.exists())
        assertFalse(hidden.exists(), "hidden rows' audio goes too")
        assertTrue(live.exists())
        assertTrue(store.changes.value > version)
    }

    @Test fun statsCountWordsAndPace() {
        store.session(SessionMeta.Status.INSERTED, "one two three four five six", duration = 6.0)
        store.session(SessionMeta.Status.INSERTED, "seven eight\nnine ten", duration = 6.0)
        assertEquals(HistoryStore.Stats(totalWords = 10, totalDictations = 2, averageWPM = 50), store.stats())
    }
}

class RetryQueueTest {
    private val root = tempDir("retry")
    private val store = HistoryStore(root)
    private val transcription = FakeTranscription(Result.success(TranscriptionResult("raw", "Recovered text.", "m")))
    private val queue = RetryQueue(store, transcription)
    private val config = DictationConfig(apiKey = "k")

    @Test fun drainRecoversQueuedAndTransientRows() = blocking {
        val (a, folder) = store.session(SessionMeta.Status.QUEUED_FOR_RETRY, audioSeconds = 1.0)
        store.session(SessionMeta.Status.FAILED, errorCode = "timeout", audioSeconds = 1.0)
        val result = queue.drain(config)
        assertEquals(RetryQueue.DrainResult(2, null, false), result)
        val meta = assertNotNull(SessionMeta.read(folder))
        assertEquals(SessionMeta.Status.RECOVERED, meta.status, "recovered, never 'inserted': the text never reached a field")
        assertEquals("Recovered text.", meta.cleanedTranscript)
        assertEquals("Recovered text.", store.record(a.id)?.displayText)
        assertFalse(transcription.lastConfig!!.live)
    }

    @Test fun offlineStopsTheDrainAndKeepsRowsQueued() = blocking {
        transcription.result = Result.failure(TranscriptionError.Offline)
        val (_, folder) = store.session(SessionMeta.Status.QUEUED_FOR_RETRY, audioSeconds = 1.0)
        store.session(SessionMeta.Status.QUEUED_FOR_RETRY, audioSeconds = 1.0)
        assertEquals(RetryQueue.DrainResult(0, null, true), queue.drain(config))
        assertEquals(1, transcription.calls)
        assertEquals(SessionMeta.Status.QUEUED_FOR_RETRY, SessionMeta.read(folder)?.status)
    }

    @Test fun accountWallsBlockWithoutFailingRows() = blocking {
        transcription.result = Result.failure(TranscriptionError.RateLimitedDaily)
        val (_, folder) = store.session(SessionMeta.Status.QUEUED_FOR_RETRY, audioSeconds = 1.0)
        assertEquals(TranscriptionError.RateLimitedDaily, queue.drain(config).blockedBy)
        assertEquals(SessionMeta.Status.QUEUED_FOR_RETRY, SessionMeta.read(folder)?.status, "the promise survives to the next drain")
    }

    @Test fun permanentErrorsMarkTheRowFailed() = blocking {
        transcription.result = Result.failure(TranscriptionError.BadRequest("nope"))
        val (_, folder) = store.session(SessionMeta.Status.QUEUED_FOR_RETRY, audioSeconds = 1.0)
        queue.drain(config)
        val meta = assertNotNull(SessionMeta.read(folder))
        assertEquals(SessionMeta.Status.FAILED, meta.status)
        assertEquals("bad_request", meta.errorCode)
        assertTrue(store.retryableRecords().isEmpty(), "the queue never spins on it")
    }

    @Test fun existingTranscriptIsRecoveredWithoutUpload() = blocking {
        val (_, folder) = store.session(SessionMeta.Status.QUEUED_FOR_RETRY, transcript = "already here")
        assertEquals(RetryQueue.RetryOutcome.RECOVERED, queue.retrySingle(store.records().single(), config))
        assertEquals(0, transcription.calls)
        assertEquals(SessionMeta.Status.RECOVERED, SessionMeta.read(folder)?.status)
    }

    @Test fun purgedAudioFailsHonestly() = blocking {
        val (_, folder) = store.session(SessionMeta.Status.QUEUED_FOR_RETRY)
        assertEquals(RetryQueue.RetryOutcome.FAILED, queue.retrySingle(store.records().single(), config))
        assertEquals("audio_purged", SessionMeta.read(folder)?.errorCode)
    }

    @Test fun finishedRowsAreSkipped() = blocking {
        store.session(SessionMeta.Status.INSERTED, "done")
        assertEquals(RetryQueue.RetryOutcome.ALREADY_DONE, queue.retrySingle(store.records().single(), config))
    }
}

class RecoveryScannerTest {
    private val root = tempDir("recovery")
    private val store = HistoryStore(root)
    private val transcription = FakeTranscription(Result.success(TranscriptionResult("raw", "Recovered.", "m")))
    private val scanner = RecoveryScanner(store, transcription)
    private val config = DictationConfig(apiKey = "k")

    @Test fun newestIsTranscribedOlderAreQueued() = blocking {
        val t = Instant.parse("2026-10-27T10:00:00Z")
        val (_, old) = store.session(SessionMeta.Status.RECORDING, audioSeconds = 1.0, startedAt = t)
        val (_, newest) = store.session(SessionMeta.Status.RECORDED, audioSeconds = 1.0, startedAt = t.plusSeconds(60))
        val report = scanner.scanAndRecover(config)
        assertEquals(2, report.interrupted)
        assertTrue(report.recoveredLatest)
        assertEquals(1, report.queued)
        assertEquals(1, transcription.calls, "only the most recent is auto-transcribed")
        assertEquals(SessionMeta.Status.RECOVERED, SessionMeta.read(newest)?.status)
        assertEquals(SessionMeta.Status.QUEUED_FOR_RETRY, SessionMeta.read(old)?.status)
        assertEquals("recovered", SessionMeta.read(old)?.errorCode)
    }

    @Test fun storedTranscriptWinsEvenWithoutAudio() = blocking {
        val (_, folder) = store.session(SessionMeta.Status.TRANSCRIBING, transcript = "kept words")
        assertEquals("Recovered your last dictation — it's in History", scanner.scanAndRecover(config).message)
        assertEquals(SessionMeta.Status.RECOVERED, SessionMeta.read(folder)?.status)
        assertEquals(0, transcription.calls)
    }

    @Test fun failedRecoveryQueuesTheRecording() = blocking {
        transcription.result = Result.failure(TranscriptionError.Offline)
        val (_, folder) = store.session(SessionMeta.Status.RECORDING, audioSeconds = 1.0)
        scanner.scanAndRecover(config)
        assertEquals(SessionMeta.Status.QUEUED_FOR_RETRY, SessionMeta.read(folder)?.status)
        assertEquals(1, store.retryableRecords().size)
    }

    @Test fun aRecordingWithNoAudioLeavesNoDeadEndRow() = blocking {
        val (_, folder) = store.session(SessionMeta.Status.RECORDING, audioSeconds = 0.0)
        scanner.scanAndRecover(config)
        assertFalse(folder.exists())
        assertTrue(store.records().isEmpty())
    }

    @Test fun missingAudioFileIsAFailedRow() = blocking {
        val (_, folder) = store.session(SessionMeta.Status.RECORDING)
        scanner.scanAndRecover(config)
        assertEquals("no_audio_file", SessionMeta.read(folder)?.errorCode)
    }
}

class RetentionPolicyTest {
    private val root = tempDir("retention")
    private val store = HistoryStore(root)
    private val now = Instant.parse("2026-10-27T10:00:00Z")

    @Test fun purgesOnlyTranscribedAudioPastTheCutoff() {
        val (_, old) = store.session(SessionMeta.Status.INSERTED, "words", audioSeconds = 0.5, startedAt = now.minusSeconds(8 * 86_400))
        val (_, recent) = store.session(SessionMeta.Status.INSERTED, "words", audioSeconds = 0.5, startedAt = now.minusSeconds(86_400))
        val (_, cancelled) = store.session(SessionMeta.Status.CANCELLED, audioSeconds = 0.5, startedAt = now.minusSeconds(30 * 86_400))
        assertEquals(1, RetentionPolicy.purgeExpiredAudio(store.recordingsRoot, 7, now))
        assertFalse(FileLayout.audioWAV(old).exists())
        assertTrue(FileLayout.audioWAV(recent).exists())
        assertTrue(FileLayout.audioWAV(cancelled).exists(), "a transcript-less recording is the only artifact: retention-immune")
        assertEquals(0, RetentionPolicy.purgeExpiredAudio(store.recordingsRoot, 0, now), "0 keeps forever")
        assertEquals(1, RetentionPolicy.purgeExpiredAudio(store.recordingsRoot, -1, now), "never keep: everything transcribed")
        assertNull(SessionMeta.read(File(root, "nope")))
    }
}
