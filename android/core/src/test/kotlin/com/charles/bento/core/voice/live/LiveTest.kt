package com.charles.bento.core.voice.live

import com.charles.bento.core.voice.FakeTransport
import com.charles.bento.core.voice.Frames
import com.charles.bento.core.voice.InMemoryKeyValueStore
import com.charles.bento.core.voice.blocking
import com.charles.bento.core.voice.format.ReplacementEngine
import com.charles.bento.core.voice.json
import kotlinx.coroutines.delay
import java.io.IOException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail

private fun chunk(byte: Int, size: Int = 3_328) = ByteArray(size) { byte.toByte() }

/** Port of LiveTranscriptionSessionTests.swift. */
class LiveTranscriptionSessionTest {
    private fun session(transport: FakeTransport, ring: PcmRing = PcmRing()) = LiveTranscriptionSession(transport, LiveSetup(), ring)

    private fun unusable(outcome: LiveTranscriptionSession.Outcome): String =
        (outcome as? LiveTranscriptionSession.Outcome.Unusable)?.why ?: fail("expected unusable, got $outcome")

    @Test fun cleanSessionCompletesWithFinalText() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete(), Frames.final("Ship it on Friday.")))
        val s = session(transport)
        s.start()
        s.enqueue(chunk(1))
        delay(120)
        assertEquals(LiveTranscriptionSession.Outcome.Completed("Ship it on Friday."), s.finish(2.0))
    }

    /** activityEnd must reach the wire AFTER every audio chunk queued before it. */
    @Test fun activityEndNeverOvertakesQueuedAudio() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete(), Frames.final("done")))
        val s = session(transport)
        s.start()
        repeat(12) { s.enqueue(chunk(2)) }
        s.finish(2.0)
        val kinds = transport.sentKinds
        val end = kinds.indexOf("activityEnd")
        assertTrue(end >= 0)
        val audio = kinds.withIndex().filter { it.value == "audio" }.map { it.index }
        assertTrue(audio.isNotEmpty(), "audio must actually have been sent")
        assertTrue(audio.all { it < end }, "every audio chunk must precede activityEnd")
    }

    @Test fun setupIsSentBeforeActivityStart() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete(), Frames.final("x")))
        val s = session(transport)
        s.start()
        s.finish(1.0)
        assertEquals("setup", transport.sentKinds.first())
        assertEquals("activityStart", transport.sentKinds[1])
    }

    @Test fun turnEndCoveringTheAudioCompletes() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete(), Frames.activity("ACTIVITY_START")))
        // 20 chunks of 3,328 bytes at 32,000 bytes/s is 2.08 s.
        transport.replyToActivityEnd = listOf(Frames.final("Ship it on Friday."), Frames.activity("ACTIVITY_END", "2.080s"))
        val s = session(transport)
        s.start()
        repeat(20) { s.enqueue(chunk(1)) }
        assertEquals(LiveTranscriptionSession.Outcome.Completed("Ship it on Friday."), s.finish(2.0))
    }

    /** The 337 s dictation that came back as its first 216 s. */
    @Test fun turnTheServerEndedByItselfFallsBack() = blocking {
        val transport = FakeTransport(listOf(
            Frames.setupComplete(), Frames.activity("ACTIVITY_START"), Frames.final("Everything before the pause."),
            json("serverContent" to mapOf("generationComplete" to true)), Frames.activity("ACTIVITY_END", "216.120s"),
        ))
        val s = session(transport)
        s.start()
        repeat(20) { s.enqueue(chunk(6)) }
        delay(150)
        assertEquals(LiveStats.Fallback.TURN_ENDED_EARLY, LiveStats.classify(unusable(s.finish(1.0))))
    }

    @Test fun anEarlierFinalDoesNotStandInForTheTurnEnd() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete(), Frames.activity("ACTIVITY_START"), Frames.final("Only the first half.")))
        val s = session(transport)
        s.start()
        s.enqueue(chunk(7))
        delay(120)
        unusable(s.finish(0.4))
    }

    @Test fun turnEndShortOfTheAudioSentFallsBack() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete(), Frames.activity("ACTIVITY_START")))
        transport.replyToActivityEnd = listOf(Frames.final("Half of it."), Frames.activity("ACTIVITY_END", "0.500s"))
        val s = session(transport)
        s.start()
        repeat(20) { s.enqueue(chunk(8)) }
        assertEquals(LiveStats.Fallback.TURN_ENDED_EARLY, LiveStats.classify(unusable(s.finish(2.0))))
    }

    @Test fun turnEndPastTheAudioSentFallsBack() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete(), Frames.activity("ACTIVITY_START")))
        transport.replyToActivityEnd = listOf(Frames.final("Before the pause."), Frames.activity("ACTIVITY_END", "216.120s"))
        val s = session(transport)
        s.start()
        repeat(20) { s.enqueue(chunk(9)) }
        assertEquals(LiveStats.Fallback.TURN_ENDED_EARLY, LiveStats.classify(unusable(s.finish(2.0))))
    }

    @Test fun turnEndWithoutAnOffsetStillCompletes() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete(), Frames.activity("ACTIVITY_START")))
        transport.replyToActivityEnd = listOf(Frames.final("Ship it."), json("voiceActivity" to mapOf("type" to "ACTIVITY_END")))
        val s = session(transport)
        s.start()
        repeat(20) { s.enqueue(chunk(10)) }
        assertEquals(LiveTranscriptionSession.Outcome.Completed("Ship it."), s.finish(2.0))
    }

    @Test fun voiceActivityFramesDecode() {
        assertEquals(LiveEvent.ActivityStarted, LiveProtocol.decode(Frames.activity("ACTIVITY_START")))
        assertEquals(LiveEvent.ActivityEnded(216.12), LiveProtocol.decode(Frames.activity("ACTIVITY_END", "216.120s")))
        assertEquals(LiveEvent.ActivityEnded(null), LiveProtocol.decode(json("voiceActivity" to mapOf("type" to "ACTIVITY_END"))))
    }

    /** Dropped audio yields a fluent but truncated transcript: never promoted. */
    @Test fun droppedAudioDisqualifiesTheSession() = blocking {
        val ring = PcmRing(seconds = 1.0)
        val transport = FakeTransport(listOf(Frames.setupComplete(), Frames.final("…by Friday.")))
        val s = LiveTranscriptionSession(transport, LiveSetup(), ring)
        repeat(40) { ring.append(chunk(3)) }
        assertTrue(ring.didDrop, "precondition: the ring must have evicted")
        s.start()
        assertTrue(unusable(s.finish(1.0)).contains("truncated"))
    }

    @Test fun setupTimeoutIsThrownNotSwallowed() = blocking {
        val transport = FakeTransport(emptyList()).apply { receiveHangs = true }
        assertFailsWith<LiveError> { session(transport).start(setupTimeout = 0.2) }
    }

    @Test fun connectFailureThrows() = blocking {
        val transport = FakeTransport(emptyList()).apply { connectError = IOException("not connected to internet") }
        assertFailsWith<IOException> { session(transport).start(setupTimeout = 0.5) }
    }

    @Test fun serverErrorEnvelopeIsRefused() = blocking {
        val transport = FakeTransport(listOf(Frames.error("API key not valid")))
        val error = assertFailsWith<LiveError> { session(transport).start(setupTimeout = 1.0) }
        assertEquals(LiveError.refused("API key not valid"), error)
    }

    @Test fun noFinalBeforeDeadlineIsUnusable() = blocking {
        val s = session(FakeTransport(listOf(Frames.setupComplete())))
        s.start()
        s.enqueue(chunk(4, 1_024))
        unusable(s.finish(0.4))
    }

    @Test fun goAwayMakesTheSessionUnusable() = blocking {
        val s = session(FakeTransport(listOf(Frames.setupComplete(), """{"goAway":{}}""")))
        s.start()
        delay(120)
        unusable(s.finish(0.5))
    }

    @Test fun sendFailureMidStreamIsUnusable() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete(), Frames.final("partial words")))
        val s = session(transport)
        s.start()
        transport.sendErrorAfter = 2 // setup + activityStart already sent
        repeat(4) { s.enqueue(chunk(5)) }
        delay(150)
        unusable(s.finish(0.5))
    }

    @Test fun partialsAreNeverPromotedToTheOutcome() = blocking {
        val s = session(FakeTransport(listOf(Frames.setupComplete(), Frames.partial("ship it on fry"),
            Frames.partial("ship it on friday"), Frames.final("Ship it on Friday."))))
        s.start()
        delay(200)
        assertEquals(LiveTranscriptionSession.Outcome.Completed("Ship it on Friday."), s.finish(1.5))
        assertEquals("ship it on friday", s.partials.replayCache.last())
    }

    @Test fun partialOnlySessionIsUnusable() = blocking {
        val s = session(FakeTransport(listOf(Frames.setupComplete(), Frames.partial("half a thought"))))
        s.start()
        delay(120)
        unusable(s.finish(0.4))
    }

    @Test fun abortIsIdempotent() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete(), Frames.final("x")))
        val s = session(transport)
        s.start()
        s.abort(); s.abort(); s.abort()
        assertEquals(1, transport.closeCount)
    }

    @Test fun finishBeforeStartIsUnusableNotACrash() = blocking {
        unusable(session(FakeTransport(emptyList())).finish(0.2))
    }

    @Test fun emptyFinalIsUnusable() = blocking {
        val s = session(FakeTransport(listOf(Frames.setupComplete(), Frames.final("   "))))
        s.start()
        delay(120)
        unusable(s.finish(0.5))
    }
}

/** Port of LiveFallbackTests.swift: the byte reconciliation in LiveTranscriber.finish. */
class LiveFallbackTest {
    private val stats = LiveStats(InMemoryKeyValueStore())

    private fun transcriber(script: List<String>, rules: List<ReplacementEngine.Rule> = emptyList()) =
        LiveTranscriber(LiveTranscriptionSession(FakeTransport(script), LiveSetup(), PcmRing()), "test-live", { rules }, stats)

    @Test fun cleanReconciledStreamIsUsable() = blocking {
        val t = transcriber(listOf(Frames.setupComplete(), Frames.final("Ship it Friday.")))
        t.begin()
        t.enqueue(ByteArray(1_600) { 1 })
        delay(150)
        assertEquals("Ship it Friday.", t.finish(2.0, framesWritten = 800)?.cleanedTranscript)
        assertEquals(1, stats.successes)
    }

    @Test fun byteMismatchIsRejectedEvenWithCleanText() = blocking {
        val t = transcriber(listOf(Frames.setupComplete(), Frames.final("…by Friday.")))
        t.begin()
        t.enqueue(ByteArray(1_600) { 1 })
        delay(150)
        assertNull(t.finish(2.0, framesWritten = 5_000), "a transcript that reads fine but is missing audio must NOT be used")
        assertEquals(1, stats.count(LiveStats.Fallback.TRUNCATED))
    }

    @Test fun moreBytesThanFramesIsAlsoRejected() = blocking {
        val t = transcriber(listOf(Frames.setupComplete(), Frames.final("hello")))
        t.begin()
        t.enqueue(ByteArray(4_000) { 1 })
        delay(150)
        assertNull(t.finish(2.0, framesWritten = 100))
    }

    @Test fun noFinalTranscriptFallsBack() = blocking {
        val t = transcriber(listOf(Frames.setupComplete()))
        t.begin()
        t.enqueue(ByteArray(1_600) { 1 })
        assertNull(t.finish(0.4, 800))
    }

    @Test fun serverErrorFallsBack() = blocking {
        val t = transcriber(listOf(Frames.setupComplete(), Frames.final("some words"), Frames.error("quota exhausted")))
        t.begin()
        t.enqueue(ByteArray(1_600) { 1 })
        delay(150)
        assertNull(t.finish(0.5, 800), "an errored session must not contribute a transcript")
    }

    @Test fun replacementRulesApplyToLiveText() = blocking {
        val t = transcriber(listOf(Frames.setupComplete(), Frames.final("send it to Amar")), listOf(ReplacementEngine.Rule("Amar", "Ammaar")))
        t.begin()
        t.enqueue(ByteArray(1_600) { 1 })
        delay(150)
        val result = assertNotNull(t.finish(2.0, 800))
        assertEquals("send it to Ammaar", result.cleanedTranscript)
        assertEquals("send it to Amar", result.rawTranscript, "raw must stay what the model returned")
    }

    @Test fun sessionThatNeverOpenedYieldsNil() = blocking {
        assertNull(transcriber(emptyList()).finish(0.3, 800))
    }

    @Test fun refusedHandshakeCountsAsNeverOpened() = blocking {
        val t = transcriber(listOf(Frames.error("bad key")))
        assertFailsWith<LiveError> { t.begin() }
        assertEquals(1, stats.count(LiveStats.Fallback.NEVER_OPENED))
    }
}

/** Port of LiveStatsTests.swift. */
class LiveStatsTest {
    private val store = InMemoryKeyValueStore()
    private var clock = 10_000.0
    private val stats = LiveStats(store) { clock }

    @Test fun successAndFallbackBothCountAsAttempts() {
        stats.recordSuccess(); stats.recordFallback(LiveStats.Fallback.NO_FINAL); stats.recordSuccess()
        assertEquals(3, stats.attempts)
        assertEquals(2, stats.successes)
        assertEquals(1, stats.count(LiveStats.Fallback.NO_FINAL))
    }

    @Test fun stopsTryingAfterThreeConsecutiveFailures() {
        assertFalse(stats.shouldStopTrying)
        stats.recordFallback(LiveStats.Fallback.NEVER_OPENED)
        stats.recordFallback(LiveStats.Fallback.NEVER_OPENED)
        assertFalse(stats.shouldStopTrying)
        stats.recordFallback(LiveStats.Fallback.NEVER_OPENED)
        assertTrue(stats.shouldStopTrying)
    }

    @Test fun oneSuccessClearsTheStreak() {
        repeat(5) { stats.recordFallback(LiveStats.Fallback.DROPPED_MID_SESSION) }
        assertTrue(stats.shouldStopTrying)
        stats.recordSuccess()
        assertFalse(stats.shouldStopTrying)
        assertEquals(0, stats.consecutiveFailures)
    }

    @Test fun failurePauseExpiresWithoutChangingToggle() {
        val failedAt = 1_000.0
        repeat(3) { stats.recordFallback(LiveStats.Fallback.NEVER_OPENED, failedAt) }
        assertTrue(stats.shouldStopTrying(failedAt + 59))
        assertFalse(stats.shouldStopTrying(failedAt + 60))
        assertEquals(3, stats.attempts)
        stats.recordFallback(LiveStats.Fallback.NO_FINAL, failedAt + 60)
        assertTrue(stats.shouldStopTrying(failedAt + 61))
    }

    @Test fun legacyStreakAndClockChangeDoNotPauseForever() {
        store.putLong("liveConsecutiveFailures", 3)
        assertFalse(stats.shouldStopTrying)
        stats.recordFallback(LiveStats.Fallback.NEVER_OPENED, clock + 3_600)
        assertFalse(stats.shouldStopTrying, "wall-clock corrections must not strand Live")
    }

    @Test fun clearStreakKeepsHistory() {
        repeat(4) { stats.recordFallback(LiveStats.Fallback.TRUNCATED) }
        stats.clearStreak()
        assertFalse(stats.shouldStopTrying)
        assertEquals(4, stats.attempts)
        assertEquals(4, stats.count(LiveStats.Fallback.TRUNCATED))
    }

    @Test fun noSummaryBeforeAnyAttempts() = assertNull(stats.summary)

    @Test fun summaryReportsRateAndDominantReason() {
        repeat(7) { stats.recordSuccess() }
        repeat(3) { stats.recordFallback(LiveStats.Fallback.DROPPED_MID_SESSION) }
        val summary = assertNotNull(stats.summary)
        assertTrue(summary.contains("7 of the last 10"), summary)
        assertTrue(summary.contains("70%"), summary)
        assertTrue(summary.contains("dropped mid-sentence"), summary)
    }

    @Test fun perfectRunMentionsNoFailure() {
        repeat(4) { stats.recordSuccess() }
        assertFalse(assertNotNull(stats.summary).contains("fell back"))
    }

    @Test fun classificationOfRealSessionReasons() {
        assertEquals(LiveStats.Fallback.TRUNCATED, LiveStats.classify("dropped 3 chunks — stream is truncated"))
        assertEquals(LiveStats.Fallback.NEVER_OPENED, LiveStats.classify("setup never completed"))
        assertEquals(LiveStats.Fallback.NEVER_OPENED, LiveStats.classify("connect failed: offline"))
        assertEquals(LiveStats.Fallback.NO_FINAL, LiveStats.classify("no final transcript before deadline"))
        assertEquals(LiveStats.Fallback.NO_FINAL, LiveStats.classify("final transcript was empty"))
        assertEquals(LiveStats.Fallback.DROPPED_MID_SESSION, LiveStats.classify("server sent goAway"))
        assertEquals(LiveStats.Fallback.TURN_ENDED_EARLY,
            LiveStats.classify("server ended the turn at 216.1s of 337.0s — the rest was never transcribed"))
        assertEquals(LiveStats.Fallback.NO_FINAL, LiveStats.classify("no final turn end before deadline"))
        assertEquals(LiveStats.Fallback.DROPPED_MID_SESSION, LiveStats.classify("something nobody anticipated"))
    }

    @Test fun resetClearsEverything() {
        stats.recordSuccess(); stats.recordFallback(LiveStats.Fallback.NO_FINAL)
        stats.reset()
        assertEquals(0, stats.attempts)
        assertEquals(0, stats.successes)
        assertEquals(0, stats.count(LiveStats.Fallback.NO_FINAL))
        assertNull(stats.summary)
    }
}

class LiveProtocolTest {
    @Test fun setupFrameMatchesTheMac() {
        val frame = LiveProtocol.setupFrame(LiveSetup(customVocabulary = listOf("Ammaar")))
        assertEquals("""{"setup":{"model":"models/gemini-3.5-transcribe-live","generationConfig":{"responseModalities":["TEXT"]},""" +
            """"inputAudioTranscription":{"mode":"SMART","customVocabulary":["Ammaar"]},""" +
            """"realtimeInputConfig":{"automaticActivityDetection":{"disabled":true}}}}""", frame)
        assertFalse(frame.contains("language", ignoreCase = true), "never languageCodes: it silently disables smart mode")
        assertTrue(LiveProtocol.setupFrame(LiveSetup(smart = false)).contains("\"VERBATIM\""))
    }

    @Test fun audioFrameIsBase64Pcm() {
        assertEquals("""{"realtimeInput":{"audio":{"data":"AQID","mimeType":"audio/pcm;rate=16000"}}}""", LiveProtocol.audioFrame(byteArrayOf(1, 2, 3)))
    }

    @Test fun interimWinsOverFinalInOneFrame() {
        val both = json("serverContent" to mapOf("interimInputTranscription" to mapOf("text" to "guess"), "inputTranscription" to mapOf("text" to "final")))
        assertEquals(LiveEvent.Partial("guess"), LiveProtocol.decode(both))
        assertEquals(LiveEvent.Final("hi"), LiveProtocol.decode(json("server_content" to mapOf("input_transcription" to mapOf("text" to "hi")))))
        assertEquals(LiveEvent.SetupComplete, LiveProtocol.decode("""{"setup_complete":{}}"""))
        assertNull(LiveProtocol.decode("""{"usageMetadata":{"promptTokenCount":3}}"""))
        assertNull(LiveProtocol.decode("not json"))
    }

    @Test fun ringDropsOldestAndCountsAcceptedSeparately() {
        val ring = PcmRing(seconds = 1.0)
        repeat(11) { ring.append(ByteArray(3_200)) }
        assertTrue(ring.didDrop)
        assertEquals(1, ring.droppedChunks)
        assertEquals(32_000, ring.pendingBytes)
        val drained = ring.drain()
        assertEquals(10, drained.size)
        assertEquals(0L, ring.acceptedBytes, "draining is not accepting")
        ring.markAccepted(3_200)
        assertEquals(3_200L, ring.acceptedBytes)
        assertIs<String>(ring.summary)
    }
}
