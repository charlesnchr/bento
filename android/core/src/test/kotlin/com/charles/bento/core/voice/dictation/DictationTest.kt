package com.charles.bento.core.voice.dictation

import com.charles.bento.core.voice.AppContext
import com.charles.bento.core.voice.TranscriptionError
import com.charles.bento.core.voice.TranscriptionResult
import com.charles.bento.core.voice.audio.AudioLevelCurve
import com.charles.bento.core.voice.audio.WavReader
import com.charles.bento.core.voice.blocking
import com.charles.bento.core.voice.history.FileLayout
import com.charles.bento.core.voice.history.SessionMeta
import com.charles.bento.core.voice.live.LiveTranscribing
import com.charles.bento.core.voice.tempDir
import com.charles.bento.core.voice.tone
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.withTimeout
import java.io.File
import java.time.Instant
import kotlin.math.roundToInt
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Port of DictationStateMachineTests.swift. */
class DictationStateMachineTest {
    private fun run(events: List<DictationEvent>, from: DictationState = DictationState.Idle) =
        events.fold(from) { state, event -> DictationStateMachine.transition(state, event) ?: state }

    private val begin = DictationEvent.HotkeyBegin
    private val started = DictationEvent.EngineStarted
    private val finalize = DictationEvent.Finalize
    private val finalized = DictationEvent.AudioFinalized
    private val ready = DictationEvent.TranscriptReady

    @Test fun holdSpeakReleaseInsert() = assertEquals(DictationState.Done(DictationOutcomeKind.INSERTED),
        run(listOf(begin, started, finalize, finalized, ready, DictationEvent.Inserted)))

    @Test fun handsFreeLockThenStop() {
        val locked = run(listOf(begin, started, DictationEvent.LockIn))
        assertEquals(DictationState.Recording(locked = true), locked)
        assertEquals(DictationState.Done(DictationOutcomeKind.INSERTED), run(listOf(finalize, finalized, ready, DictationEvent.Inserted), locked))
    }

    @Test fun escCancelsWhileRecording() = assertEquals(DictationState.Cancelled, run(listOf(begin, started, DictationEvent.Cancel)))
    @Test fun accidentalChordAbortsWarming() = assertEquals(DictationState.Cancelled, run(listOf(begin, DictationEvent.AbortAccidental)))
    @Test fun escCancelsDuringTranscription() = assertEquals(DictationState.Cancelled, run(listOf(begin, started, finalize, finalized, DictationEvent.Cancel)))

    @Test fun cannotCancelDuringInsertion() {
        val inserting = run(listOf(begin, started, finalize, finalized, ready))
        assertEquals(DictationState.Inserting, inserting)
        assertNull(DictationStateMachine.transition(inserting, DictationEvent.Cancel))
    }

    @Test fun releaseBeforeEngineStartStillFinalizes() = assertEquals(DictationState.Finalizing, run(listOf(begin, finalize)))
    @Test fun zeroBuffersIsAnErrorNeverEmptyTranscript() =
        assertEquals(DictationState.Failed(DictationFailure.NO_AUDIO), run(listOf(begin, started, finalize, DictationEvent.NoAudioCaptured)))
    @Test fun silenceOnlyIsCalmNotAnError() =
        assertEquals(DictationState.Done(DictationOutcomeKind.SILENT), run(listOf(begin, started, finalize, DictationEvent.SilenceOnly)))
    @Test fun offlineQueuesForRetry() =
        assertEquals(DictationState.Done(DictationOutcomeKind.QUEUED_FOR_RETRY), run(listOf(begin, started, finalize, finalized, DictationEvent.QueuedForRetry)))
    @Test fun midRecordingEngineDeathPreservesAudio() =
        assertEquals(DictationState.Finalizing, run(listOf(begin, started, DictationEvent.EngineFailed(DictationFailure.AUDIO))))
    @Test fun warmingEngineFailureCarriesHonestReason() =
        assertEquals(DictationState.Failed(DictationFailure.NO_MICROPHONE), run(listOf(begin, DictationEvent.EngineFailed(DictationFailure.NO_MICROPHONE))))
    @Test fun transcriptionFailureCarriesReason() =
        assertEquals(DictationState.Failed(DictationFailure.AUTH), run(listOf(begin, started, finalize, finalized, DictationEvent.TranscriptFailed(DictationFailure.AUTH))))
    @Test fun focusChangeNeverBlindPastes() = assertEquals(DictationState.Done(DictationOutcomeKind.AWAITING_CHIP),
        run(listOf(begin, started, finalize, finalized, ready, DictationEvent.FrontmostChangedAwaitingChip)))
    @Test fun secureFieldHoldsTextInHistoryOnly() = assertEquals(DictationState.Done(DictationOutcomeKind.HELD_FOR_SECURE_FIELD),
        run(listOf(begin, started, finalize, finalized, ready, DictationEvent.InsertionBlockedSecure)))

    @Test fun staleEventsReturnNil() {
        assertNull(DictationStateMachine.transition(DictationState.Idle, finalize))
        assertNull(DictationStateMachine.transition(DictationState.Idle, ready))
        assertNull(DictationStateMachine.transition(DictationState.Done(DictationOutcomeKind.INSERTED), DictationEvent.Inserted))
        assertNull(DictationStateMachine.transition(DictationState.Cancelled, ready))
        assertNull(DictationStateMachine.transition(DictationState.Recording(false), begin))
    }

    @Test fun doubleLockIsIgnored() = assertNull(DictationStateMachine.transition(DictationState.Recording(true), DictationEvent.LockIn))

    @Test fun terminalStatesAreTerminal() {
        for (state in listOf(DictationState.Done(DictationOutcomeKind.INSERTED), DictationState.Cancelled, DictationState.Failed(DictationFailure.NETWORK))) {
            assertTrue(state.isTerminal)
            for (event in listOf(begin, finalize, ready, DictationEvent.Inserted)) assertNull(DictationStateMachine.transition(state, event))
        }
    }
}

/** A transcription service whose answer the test dictates. */
class FakeTranscription(
    @Volatile var result: Result<TranscriptionResult> = Result.success(TranscriptionResult("raw", "clean", "test")),
    @Volatile var delayMillis: Long = 0,
) : TranscriptionService {
    @Volatile var calls = 0
    @Volatile var lastEditing: EditingSession? = null
    @Volatile var lastConfig: DictationConfig? = null
    @Volatile var finishLiveCalls = 0
    override val supportsEditing get() = true

    override suspend fun transcribe(audio: File, durationSeconds: Double, config: DictationConfig, editing: EditingSession?): TranscriptionResult {
        calls++
        lastEditing = editing
        lastConfig = config
        if (delayMillis > 0) delay(delayMillis)
        return result.getOrThrow()
    }

    override suspend fun finishLive(result: TranscriptionResult, config: DictationConfig): TranscriptionResult {
        finishLiveCalls++
        return result.copy(cleanedTranscript = result.cleanedTranscript + " (cleaned)")
    }
}

/** A live transcriber whose outcome the test dictates. */
class ScriptedLive(private val outcome: TranscriptionResult?, private val beginError: Exception? = null) : LiveTranscribing {
    @Volatile var enqueuedBytes = 0L
    @Volatile var finishedWithFrames: Long? = null
    @Volatile var aborted = false
    val partialFlow = MutableSharedFlow<String>(replay = 1)
    override val partials: Flow<String> get() = partialFlow
    override suspend fun begin() { beginError?.let { throw it } }
    override fun enqueue(pcm: ByteArray) { synchronized(this) { enqueuedBytes += pcm.size } }
    override suspend fun finish(deadline: Double, framesWritten: Long): TranscriptionResult? {
        finishedWithFrames = framesWritten
        return outcome
    }
    override suspend fun abort() { aborted = true }
}

/** Constant-amplitude samples that meter at exactly `level`. */
fun atLevel(level: Float, seconds: Double): ShortArray {
    val value = (AudioLevelCurve.rms(level) * 32_768).roundToInt().toShort()
    return ShortArray(Math.round(seconds * 16_000).toInt()) { value }
}

/** Port of the applicable DictationCoordinatorTests.swift cases, against DictationSession. */
class DictationSessionTest {
    private val root = tempDir("dictation")
    private var now = Instant.parse("2026-10-27T12:00:00Z")
    private val transcription = FakeTranscription()
    private var live: ((DictationConfig) -> LiveTranscribing?) = { null }
    private val engine = DictationEngine.forTesting(root, transcription, live = { live(it) }, clock = { now })
    private val config = DictationConfig(apiKey = "k", context = AppContext("com.google.android.gm", "Gmail"))
    private var insertOutcome = InsertionOutcome.INSERTED
    private val inserted = ArrayList<String>()

    private fun start(cfg: DictationConfig = config): DictationSession =
        assertNotNull(engine.start(cfg) { text -> inserted += text; insertOutcome })

    private suspend fun DictationSession.finishWithin(): DictationOutcome = withTimeout(10_000) { await() }

    @Test fun happyPathInserts() = blocking {
        val s = start()
        assertEquals(DictationState.Warming, s.state.value)
        assertTrue(s.feed(tone(1.0)))
        assertEquals(DictationState.Recording(false), s.state.value)
        val outcome = assertIs<DictationOutcome.Transcribed>(s.stop())
        assertEquals("clean", outcome.result.text)
        assertEquals("raw", outcome.result.rawTranscript)
        assertEquals(InsertionOutcome.INSERTED, outcome.insertion)
        assertFalse(outcome.result.usedLive)
        assertEquals(listOf("clean"), inserted)
        assertEquals(DictationState.Done(DictationOutcomeKind.INSERTED), s.state.value)
        // History mirrors the session; the recording is on disk.
        val row = engine.history.records().single()
        assertEquals("clean", row.displayText)
        assertEquals(SessionMeta.Status.INSERTED, row.status)
        assertEquals("Gmail", row.targetAppName)
        assertEquals(16_000L, WavReader.frames(s.audioFile))
        assertFalse(s.feed(tone(0.1)), "a finished session wants no more audio")
    }

    @Test fun stillSpeakingAtStopCarriesCapture() = blocking {
        val s = start()
        s.feed(tone(0.5))
        s.feed(atLevel(0.6f, 0.1)) // mid-word at the moment of stop
        s.requestStop()
        delay(150)
        assertTrue(s.wantsAudio, "still talking: the recording stays open")
        assertTrue(s.feed(atLevel(0.6f, 0.1)))
        repeat(8) { s.feed(atLevel(0f, 0.05)); delay(50) }
        assertIs<DictationOutcome.Transcribed>(s.finishWithin())
        assertTrue(WavReader.frames(s.audioFile)!! > 16_000 * 0.7, "the trailing words were kept")
    }

    @Test fun quietReleaseStopsImmediately() = blocking {
        val s = start()
        s.feed(tone(0.5))
        s.feed(atLevel(0.01f, 0.1))
        s.requestStop()
        delay(30)
        assertFalse(s.wantsAudio, "already quiet: no carry-over latency")
        s.finishWithin()
    }

    /** The app stopped the mic at stop: the trailing window ends on its own, not at the 1.5 s cap. */
    @Test fun trailingCaptureEndsWhenTheMicStops() = blocking {
        val s = start()
        s.feed(atLevel(0.6f, 1.0))
        val started = System.nanoTime()
        s.stop()
        assertTrue((System.nanoTime() - started) / 1e9 < 1.2)
    }

    @Test fun lockInDuringWarmingIsLatched() = blocking {
        val s = start()
        assertTrue(s.lockIn())
        s.feed(tone(0.2))
        assertEquals(DictationState.Recording(locked = true), s.state.value)
        s.cancel()
    }

    @Test fun zeroFramesOnRealHoldIsNoAudioFailure() = blocking {
        val s = start()
        now = now.plusSeconds(2)
        val outcome = assertIs<DictationOutcome.Failed>(s.stop())
        assertEquals(DictationFailure.NO_AUDIO, outcome.failure)
        assertEquals(DictationState.Failed(DictationFailure.NO_AUDIO), s.state.value)
        assertTrue(inserted.isEmpty())
        assertTrue(engine.history.records().isEmpty())
        assertFalse(s.recordingFolder!!.exists(), "nothing a retry could transcribe: nothing stored")
    }

    @Test fun zeroFramesOnQuickBlipIsSilent() = blocking {
        val s = start()
        assertIs<DictationOutcome.Silent>(s.stop())
        assertEquals(DictationState.Done(DictationOutcomeKind.SILENT), s.state.value)
    }

    @Test fun microClipNeverUploadsAndLeavesNoTrace() = blocking {
        transcription.result = Result.failure(TranscriptionError.Network("should never be called"))
        val s = start()
        s.feed(tone(0.19))
        now = now.plusSeconds(2)
        assertIs<DictationOutcome.Silent>(s.stop())
        assertEquals(0, transcription.calls)
        assertFalse(s.recordingFolder!!.exists())
    }

    @Test fun mutedMicIsSilentWithoutUpload() = blocking {
        val s = start()
        s.feed(ShortArray(48_000))
        assertIs<DictationOutcome.Silent>(s.stop())
        assertEquals(0, transcription.calls)
    }

    @Test fun shortCancelDiscardsButLongCancelKeeps() = blocking {
        val short = start()
        short.feed(tone(1.0))
        short.cancel()
        assertEquals(DictationState.Cancelled, short.state.value)
        assertEquals(DictationOutcome.Cancelled(short.id, recordingKept = false), short.finishWithin())
        assertFalse(short.recordingFolder!!.exists())

        val long = start()
        long.feed(tone(12.0))
        long.cancel()
        assertEquals(DictationOutcome.Cancelled(long.id, recordingKept = true), long.finishWithin())
        val row = engine.history.records().single()
        assertEquals(SessionMeta.Status.CANCELLED, row.status)
        assertTrue(row.hasAudio, "a 12 s cancelled recording stays recoverable")
    }

    @Test fun microphoneMissingBeforeAudioFailsWithoutAStoredRow() = blocking {
        val s = start()
        s.reportAudioFailure(DictationFailure.NO_MICROPHONE)
        assertEquals(DictationState.Failed(DictationFailure.NO_MICROPHONE), s.state.value)
        assertEquals(DictationFailure.NO_MICROPHONE, assertIs<DictationOutcome.Failed>(s.finishWithin()).failure)
        assertTrue(engine.history.records().isEmpty())
    }

    @Test fun microphoneDyingMidRecordingStillTranscribes() = blocking {
        val s = start()
        s.feed(tone(1.0))
        s.reportAudioFailure()
        assertIs<DictationOutcome.Transcribed>(s.finishWithin())
        assertEquals("engine_died", s.metaForTesting.errorCode)
    }

    @Test fun transcriptionAuthFailure() = blocking {
        transcription.result = Result.failure(TranscriptionError.Auth)
        val s = start()
        s.feed(tone(1.0))
        val outcome = assertIs<DictationOutcome.Failed>(s.stop())
        assertEquals(DictationFailure.AUTH, outcome.failure)
        assertEquals("auth", outcome.code)
        assertEquals(SessionMeta.Status.FAILED, engine.history.records().single().status)
    }

    @Test fun badRequestSurfacesAsItsOwnFailure() = blocking {
        transcription.result = Result.failure(TranscriptionError.BadRequest("malformed request"))
        val s = start()
        s.feed(tone(1.0))
        val outcome = assertIs<DictationOutcome.Failed>(s.stop())
        assertEquals(DictationFailure.BAD_REQUEST, outcome.failure)
        assertEquals("malformed request", outcome.message)
    }

    @Test fun offlineQueuesTheRecording() = blocking {
        transcription.result = Result.failure(TranscriptionError.Offline)
        val s = start()
        s.feed(tone(1.0))
        assertIs<DictationOutcome.Queued>(s.stop())
        assertEquals(DictationState.Done(DictationOutcomeKind.QUEUED_FOR_RETRY), s.state.value)
        val row = engine.history.retryableRecords().single()
        assertEquals("offline", row.errorCode)
    }

    @Test fun cancelDuringTranscribingKeepsLongRecording() = blocking {
        transcription.delayMillis = 2_000
        val s = start()
        s.feed(tone(60.0, amplitude = 2_000.0))
        s.requestStop()
        withTimeout(5_000) { while (s.state.value != DictationState.Transcribing) delay(10) }
        s.cancel()
        assertEquals(DictationState.Cancelled, s.state.value)
        assertEquals(DictationOutcome.Cancelled(s.id, recordingKept = true), s.finishWithin())
        val meta = s.metaForTesting
        assertEquals(SessionMeta.Status.CANCELLED, meta.status)
        assertEquals(60.0, meta.audioDurationSeconds)
    }

    @Test fun cancelDuringTranscribingStillDiscardsShortRecording() = blocking {
        transcription.delayMillis = 2_000
        val s = start()
        s.feed(tone(3.0))
        s.requestStop()
        withTimeout(5_000) { while (s.state.value != DictationState.Transcribing) delay(10) }
        s.cancel()
        assertEquals(DictationOutcome.Cancelled(s.id, recordingKept = false), s.finishWithin())
    }

    @Test fun secondStopWhileInFlightIsIgnored() = blocking {
        transcription.delayMillis = 100
        val s = start()
        s.feed(tone(1.0))
        s.requestStop()
        withTimeout(5_000) { while (s.state.value != DictationState.Transcribing) delay(5) }
        s.requestStop()
        assertEquals(DictationState.Transcribing, s.state.value)
        assertIs<DictationOutcome.Transcribed>(s.stop())
        assertEquals(1, transcription.calls)
    }

    @Test fun strayCancelAfterCompletionChangesNothing() = blocking {
        val s = start()
        s.feed(tone(1.0))
        s.stop()
        s.cancel()
        assertEquals(DictationState.Done(DictationOutcomeKind.INSERTED), s.state.value)
    }

    @Test fun quietLongHoldIsNoSpeechNotFailed() = blocking {
        transcription.result = Result.failure(TranscriptionError.EmptyTranscript)
        val s = start()
        s.feed(atLevel(0.01f, 3.0))
        assertIs<DictationOutcome.Silent>(s.stop())
    }

    @Test fun loudUtteranceWithEmptyTranscriptIsARetryableFailure() = blocking {
        transcription.result = Result.failure(TranscriptionError.EmptyTranscript)
        for (seconds in listOf(1.0, 3.0)) {
            val s = start()
            s.feed(tone(seconds))
            val outcome = assertIs<DictationOutcome.Failed>(s.stop())
            assertEquals(DictationFailure.VALIDATION, outcome.failure)
            assertTrue(outcome.recordingKept)
        }
    }

    @Test fun clipboardFallbackOutcome() = blocking {
        insertOutcome = InsertionOutcome.COPIED_TO_CLIPBOARD
        val s = start()
        s.feed(tone(1.0))
        s.stop()
        assertEquals(DictationState.Done(DictationOutcomeKind.COPIED_TO_CLIPBOARD), s.state.value)
        assertEquals(SessionMeta.Status.COPIED_TO_CLIPBOARD, engine.history.records().single().status)
    }

    @Test fun startWhileActiveIsRefused() = blocking {
        val s = start()
        assertNull(engine.start(config))
        s.feed(tone(1.0))
        s.stop()
        val next = assertNotNull(engine.start(config), "a new session after completion")
        next.feed(tone(0.1))
        assertEquals(DictationState.Recording(false), next.state.value)
        next.cancel()
    }

    @Test fun recordingCapStopsAndTranscribes() = blocking {
        val s = start()
        val minute = tone(60.0, amplitude = 2_000.0)
        repeat(9) { assertTrue(s.feed(minute)) }
        assertEquals("One minute left — 10-minute limit", s.notice.value)
        s.feed(minute)
        assertIs<DictationOutcome.Transcribed>(s.finishWithin())
        assertEquals(600.0, s.metaForTesting.audioDurationSeconds)
    }

    // MARK: Live

    @Test fun cleanLiveResultIsUsedWithoutUpload() = blocking {
        val scripted = ScriptedLive(TranscriptionResult("ship it friday", "Ship it Friday.", "gemini-3.5-transcribe-live"))
        live = { scripted }
        val s = start(config.copy(live = true))
        scripted.partialFlow.emit("um ship it on friday")
        s.feed(tone(1.0))
        delay(50)
        assertEquals("um ship it on friday", s.partialTranscript.value)
        val result = assertIs<DictationOutcome.Transcribed>(s.stop()).result
        assertTrue(result.usedLive)
        assertEquals("Ship it Friday. (cleaned)", result.text, "the cleanup pass runs over live text")
        assertEquals(0, transcription.calls, "no upload when live was clean")
        assertEquals(16_000L, scripted.finishedWithFrames)
        assertEquals(32_000L, scripted.enqueuedBytes, "every byte written reached the socket")
        assertTrue(result.corrections.any { it.isCut && it.text.contains("um") })
        assertEquals("Ship it Friday. (cleaned)", s.correctedTranscript.value)
        // the live socket is closed on the session's scope after stop returns
        withTimeout(2_000) { while (!scripted.aborted) delay(5) }
    }

    @Test fun unusableLiveFallsBackToTheUpload() = blocking {
        live = { ScriptedLive(null) }
        val s = start(config.copy(live = true))
        s.feed(tone(1.0))
        val result = assertIs<DictationOutcome.Transcribed>(s.stop()).result
        assertFalse(result.usedLive)
        assertEquals("clean", result.text)
        assertEquals(1, transcription.calls)
    }

    @Test fun liveThatNeverOpensUploads() = blocking {
        val scripted = ScriptedLive(TranscriptionResult("x", "x", "m"), beginError = IllegalStateException("refused"))
        live = { scripted }
        val s = start(config.copy(live = true))
        s.feed(tone(1.0))
        delay(50)
        assertFalse(assertIs<DictationOutcome.Transcribed>(s.stop()).result.usedLive)
        assertNull(scripted.finishedWithFrames)
    }

    // MARK: Voice editing

    @Test fun editingChainsFollowInsertedDictations() = blocking {
        val s = start()
        s.feed(tone(1.0))
        s.stop()
        val chain = assertNotNull(engine.recentEditingSession("com.google.android.gm"))
        assertEquals("clean", chain.seed)
        assertNull(engine.startEditing(config.copy(context = AppContext("com.other"))), "nothing to edit in another app")

        transcription.result = Result.success(TranscriptionResult("make that shorter", "Short.", "edit"))
        val edit = assertNotNull(engine.startEditing(config))
        edit.feed(tone(1.0))
        val result = assertIs<DictationOutcome.Transcribed>(edit.stop()).result
        assertEquals("clean", transcription.lastEditing?.seed)
        assertEquals("Short.", result.text)
        val updated = assertNotNull(result.editing)
        assertEquals(listOf(EditingTurn("make that shorter", "Short.")), updated.turns)
        assertEquals("Short.", engine.recentEditingSession("com.google.android.gm")?.currentText)
    }

    @Test fun anOrdinaryDictationResetsTheChain() = blocking {
        val s = start()
        s.feed(tone(1.0))
        s.stop()
        val next = start()
        assertNull(engine.recentEditingSession("com.google.android.gm"))
        next.cancel()
    }

    // MARK: Noise handling (ports of the experiment's tests)

    private suspend fun DictationSession.hearRoom(room: Float, speech: Float? = null) {
        feed(atLevel(room, 12 * 0.032))
        speech?.let { feed(atLevel(it, 0.032)) }
        feed(atLevel(room, 0.032))
    }

    @Test fun flagOffRoomToneHoldsTheMicOpen() = blocking {
        val s = start()
        s.hearRoom(0.15f, speech = 0.9f)
        s.requestStop()
        delay(150)
        assertTrue(s.wantsAudio, "today, room tone alone holds the mic open past stop")
        s.feed(atLevel(0f, 0.4))
        s.finishWithin()
    }

    @Test fun noisyRoomTrailingCaptureStopsEarly() = blocking {
        val s = start(config.copy(experimentalNoiseHandling = true))
        s.hearRoom(0.15f, speech = 0.9f)
        s.requestStop()
        delay(30)
        assertFalse(s.wantsAudio, "room tone is not speech once we know what the room sounds like")
        s.finishWithin()
    }

    @Test fun noisyRoomWithoutSeparationStillCarries() = blocking {
        val s = start(config.copy(experimentalNoiseHandling = true))
        s.hearRoom(0.15f)
        s.requestStop()
        delay(150)
        assertTrue(s.wantsAudio, "without proven separation the energy signal is not trusted")
        s.feed(atLevel(0f, 0.4))
        s.finishWithin()
    }

    @Test fun quietSpeechAboveAQuietRoomIsNotDiscarded() = blocking {
        val s = start()
        s.feed(atLevel(0.005f, 0.5))
        s.feed(atLevel(0.03f, 0.1))
        s.feed(atLevel(0.005f, 0.5))
        assertIs<DictationOutcome.Transcribed>(s.stop(), "24 dB above the room is speech, whatever the absolute peak says")
    }

    @Test fun emptyTranscriptInLoudRoomIsSilentButKeepsTheRecording() = blocking {
        transcription.result = Result.failure(TranscriptionError.EmptyTranscript)
        val s = start(config.copy(experimentalNoiseHandling = true))
        s.feed(atLevel(0.4f, 0.8)) // 25 meter windows of room
        s.feed(atLevel(0.5f, 0.096)) // 3 windows of "speech" barely above it
        s.feed(atLevel(0f, 0.032)) // a quiet release, so no trailing capture
        val outcome = assertIs<DictationOutcome.Silent>(s.stop())
        assertEquals(SilenceReason.TOO_NOISY, outcome.reason)
        assertTrue(outcome.kept)
        val row = engine.history.records().single()
        assertEquals(SessionMeta.Status.FAILED, row.status, ".silent rows are invisible in History and get purged")
        assertEquals("tooNoisy", row.errorCode)
    }

    @Test fun emptyTranscriptInLoudRoomStillFailsWithFlagOff() = blocking {
        transcription.result = Result.failure(TranscriptionError.EmptyTranscript)
        val s = start()
        s.feed(atLevel(0.4f, 0.8))
        s.feed(atLevel(0f, 0.1))
        assertNotEquals<Any>(DictationOutcome.Silent::class, s.stop()::class)
    }

    // MARK: Crash safety

    /** A killed app keeps the audio; the next launch finds and recovers it. */
    @Test fun killedMidRecordingIsRecoveredOnNextLaunch() = blocking {
        val s = start()
        s.feed(tone(2.0))
        val folder = assertNotNull(s.recordingFolder)
        // The process dies here: no stop, no close. A new engine opens the same root.
        val next = FakeTranscription(Result.success(TranscriptionResult("recovered raw", "Recovered.", "m")))
        val relaunched = DictationEngine.forTesting(root, next)
        val report = relaunched.recoverInterrupted(config)
        assertEquals(1, report.interrupted)
        assertTrue(report.recoveredLatest)
        val row = relaunched.history.records().single()
        assertEquals(SessionMeta.Status.RECOVERED, row.status)
        assertEquals("Recovered.", row.displayText)
        assertEquals(2.0, row.durationSeconds)
        assertEquals(folder, row.folder)
        assertEquals("com.google.android.gm", next.lastConfig?.context?.packageName)
        s.cancel()
    }

    @Test fun retryWithAnotherModelReplacesTheText() = blocking {
        val s = start()
        s.feed(tone(1.0))
        s.stop()
        transcription.result = Result.success(TranscriptionResult("raw2", "Better.", "gemini-x/smart"))
        val result = engine.retryWithModel(s.id, config, transcribeModel = "gemini-x")
        assertEquals("Better.", result.cleanedTranscript)
        assertEquals("gemini-x", transcription.lastConfig?.transcribeModel)
        assertEquals("Better.", engine.history.record(s.id)?.displayText)
        assertEquals("Better.", SessionMeta.read(s.recordingFolder!!)?.cleanedTranscript)
    }

    @Test fun neverKeepAudioDeletesTheRecordingOnceTranscribed() = blocking {
        engine.audioRetentionDays = -1
        val s = start()
        s.feed(tone(1.0))
        s.stop()
        assertFalse(s.audioFile.exists())
        assertEquals("clean", engine.history.records().single().displayText)
    }
}

class EditingSessionTest {
    @Test fun promptCarriesTheChainAsJsonAndTheInstructionLast() {
        val session = EditingSession("We meet Friday at 3 in the big room.", updatedAt = Instant.parse("2026-10-27T12:00:00Z"))
            .appending("shorter", "Friday 3pm, big room.", Instant.parse("2026-10-27T12:01:00Z"))
        val prompt = session.prompt("undo that")
        assertTrue(prompt.startsWith("You are a voice-driven text editor."))
        assertTrue(prompt.contains("Editing session (JSON):\n{\"seed\":\"We meet Friday at 3 in the big room.\",\"turns\":[{\"instruction\":\"shorter\",\"revision\":\"Friday 3pm, big room.\"}]"))
        assertTrue(prompt.endsWith("Latest editing instruction:\nundo that"))
        assertEquals("Friday 3pm, big room.", session.currentText)
    }

    @Test fun sessionsExpire() {
        val t0 = Instant.parse("2026-10-27T12:00:00Z")
        val s = EditingSession("x", updatedAt = t0)
        assertTrue(s.editsAtCaret(t0.plusSeconds(29)))
        assertFalse(s.editsAtCaret(t0.plusSeconds(31)))
        assertTrue(s.isActive(t0.plusSeconds(299)))
        assertFalse(s.isActive(t0.plusSeconds(301)))
        val store = EditingSessionStore()
        store.save(s, "app")
        assertNull(store.session("app", t0.plusSeconds(301)))
        assertNull(store.session(null, t0))
    }
}

class DictationConfigTest {
    @Test fun formattingPolicyFollowsTheMac() {
        val base = DictationConfig(apiKey = "k")
        assertEquals(DictationConfig.FormattingPolicy(nativeSmart = true, cleanupPass = false), base.formattingPolicy, "the default is ONE call")
        assertTrue(base.copy(toneMatching = true).formattingPolicy.cleanupPass)
        assertTrue(base.copy(customInstructions = "lowercase").formattingPolicy.cleanupPass)
        assertTrue(base.copy(modePrompt = "bullets").formattingPolicy.cleanupPass)
        assertFalse(base.copy(customInstructions = "   ").formattingPolicy.cleanupPass)
        assertFalse(base.copy(toneMatching = true, cleanup = false).formattingPolicy.cleanupPass, "the master switch wins")
        assertFalse(base.copy(legacyTranscribeEndpoint = true).formattingPolicy.nativeSmart)
        assertFalse(base.copy(live = true, legacyTranscribeEndpoint = true).liveActive)
        assertTrue(base.copy(live = true).liveActive)
        assertEquals("gemini-3.5-flash-lite", base.copy(cleanupModel = "gpt-6-luna").effectiveCleanupModel)
        assertFalse(base.copy(apiKey = "secret-key").toString().contains("secret-key"), "the key never reaches a log line")
    }
}
