package com.charles.bento.core.assistant.live

import com.charles.bento.core.voice.gemini.GeminiModels
import com.charles.bento.core.voice.live.LiveProtocol
import com.charles.bento.core.voice.live.LiveTransport
import com.charles.bento.core.voice.meeting.MeetingLiveEvent
import com.charles.bento.core.voice.meeting.MeetingLiveProtocol
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ChannelResult
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.withTimeoutOrNull

/** What the captioner hears of the user's speech: display only, never a request. */
sealed interface Caption {
    /** The user started an utterance. */
    data object Started : Caption
    /** The utterance so far: each one replaces the last. */
    data class Partial(val text: String) : Caption
    /** The utterance ended (or the captioner lost it). */
    data object Ended : Caption
}

/** Live captions of the user's speech during a call; faked in tests. */
interface CallCaptions {
    /** [onCaption] is called from the captioner's own thread. */
    fun start(onCaption: (Caption) -> Unit)
    /** Microphone audio the call sent to Gemini (16 kHz PCM16). Must not block. */
    fun feed(pcm: ByteArray)
    /** The microphone went quiet (muted, standby): the utterance ends now, not at the next pause. */
    fun pause()
    fun stop()
}

/**
 * The words a user is saying in a call, shown while they speak. Gemini Live sends the
 * user's transcript in one piece just after they stop: measured on gemini-3.8-live on
 * 2026-10-30, 12.4 s of speech came as one inputTranscription 0.9 s after it ended, with
 * nothing during it. So the call also streams the audio it sends Gemini to Gemini's
 * transcription model, which sends a growing hypothesis about every half second.
 *
 * Display only: Hermes still gets Gemini Live's own transcript ([CallProtocol]), and
 * the call drops a caption once that transcript arrives. A captioner that can't connect
 * gives up quietly; the call goes on without captions.
 *
 * A socket opens with the first audio, so a muted call opens none, and closes after
 * [idleSeconds] without audio (a long mute, standby). One that ends (Gemini rotates
 * connections after about ten minutes) is replaced at the next audio: captions need no
 * memory of earlier speech.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class LiveCaptions(
    private val transport: () -> LiveTransport,
    private val model: String = GeminiModels.TRANSCRIBE_LIVE,
    private val idleSeconds: Double = 20.0,
    private val setupSeconds: Double = 10.0,
    private val retrySeconds: Double = 5.0,
    private val maxFailures: Int = 3,
) : CallCaptions {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO.limitedParallelism(1))
    /** Audio, or null for "the microphone went quiet". About two seconds wait while a socket opens. */
    private val audio = Channel<ByteArray?>(100, BufferOverflow.DROP_OLDEST)
    @Volatile private var stopped = false

    override fun start(onCaption: (Caption) -> Unit) {
        scope.launch { run(onCaption) }
    }

    override fun feed(pcm: ByteArray) {
        if (!stopped) audio.trySend(pcm)
    }

    override fun pause() {
        if (!stopped) audio.trySend(null)
    }

    override fun stop() {
        stopped = true
        audio.close()
        scope.cancel()
    }

    private suspend fun run(onCaption: (Caption) -> Unit) {
        var failures = 0
        while (scope.isActive) {
            // Nothing opens until there is something to hear.
            val first = audio.receiveCatching().getOrNull() ?: if (audio.isClosedForReceive) return else continue
            val socket = transport()
            val failed = try {
                !open(socket) || stream(socket, first, onCaption)
            } finally {
                socket.close()
            }
            if (!failed) { failures = 0; continue }
            if (++failures >= maxFailures) return
            delay((retrySeconds * 1000).toLong())
            while (audio.tryReceive().isSuccess) Unit // what was said meanwhile is gone
        }
    }

    private suspend fun open(socket: LiveTransport): Boolean = try {
        withTimeoutOrNull((setupSeconds * 1000).toLong()) {
            socket.connect()
            socket.send(MeetingLiveProtocol.setupFrame(model, VOCABULARY))
            var events = emptyList<MeetingLiveEvent>()
            while (events.none { it == MeetingLiveEvent.SetupComplete || it is MeetingLiveEvent.Failed }) {
                events = MeetingLiveProtocol.decode(socket.receive())
            }
            MeetingLiveEvent.SetupComplete in events
        } == true
    } catch (e: Exception) {
        if (e is kotlinx.coroutines.CancellationException) throw e
        false
    }

    /**
     * Sends audio and relays captions until the socket ends or goes idle. Whether it failed: a
     * socket that ends by itself having heard nothing (an error after setup, say).
     */
    private suspend fun stream(socket: LiveTransport, first: ByteArray, onCaption: (Caption) -> Unit): Boolean {
        var speaking = false
        var heard = false
        var broke = false
        val reader = scope.launch {
            try {
                while (isActive) {
                    for (event in MeetingLiveProtocol.decode(socket.receive())) when (event) {
                        is MeetingLiveEvent.ActivityStart -> { speaking = true; heard = true; onCaption(Caption.Started) }
                        is MeetingLiveEvent.Interim -> { heard = true; onCaption(Caption.Partial(event.text)) }
                        is MeetingLiveEvent.Final, is MeetingLiveEvent.ActivityEnd -> if (speaking) { speaking = false; onCaption(Caption.Ended) }
                        MeetingLiveEvent.GoAway, is MeetingLiveEvent.Failed -> return@launch
                        else -> Unit
                    }
                }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
            }
        }
        try {
            socket.send(LiveProtocol.audioFrame(first))
            while (reader.isActive) {
                val next = withTimeoutOrNull((idleSeconds * 1000).toLong()) {
                    select<ChannelResult<ByteArray?>?> { reader.onJoin { null }; audio.onReceiveCatching { it } }
                } ?: break
                if (next.isClosed) break
                val pcm = next.getOrNull()
                socket.send(if (pcm == null) MeetingLiveProtocol.streamEndFrame() else LiveProtocol.audioFrame(pcm))
            }
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            broke = true
        } finally {
            broke = broke || !reader.isActive
            reader.cancel()
            if (speaking) onCaption(Caption.Ended)
        }
        return broke && !heard
    }

    companion object {
        /** The call's own words, as Gemini Live's setup has them. */
        val VOCABULARY = listOf("Hermes", "Bento")
    }
}
