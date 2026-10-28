package com.charles.bento.core.voice.live

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.util.Locale
import kotlin.math.abs

/**
 * One live dictation turn over the Live API: handshake, stream the ring, end the
 * turn, and decide whether the result can be trusted. Port of the Mac's actor of
 * the same name; state is confined to one dispatcher thread at a time.
 *
 * "Trusted" is strict on purpose: setup completed, no send or receive failure, no
 * ring drop, the server closed the turn activityEnd asked it to close (at the offset
 * the audio ended), and a final arrived in time. Anything else is [Outcome.Unusable]
 * and the caller uploads the recording instead.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class LiveTranscriptionSession(
    private val transport: LiveTransport,
    private val setup: LiveSetup,
    val ring: PcmRing = PcmRing(),
) {
    sealed class Outcome {
        data class Completed(val text: String) : Outcome()
        /** The string is for the log, never for the user. */
        data class Unusable(val why: String) : Outcome()
    }

    private enum class Command { PCM_AVAILABLE, END_ACTIVITY }

    companion object {
        /**
         * Slack between the audio the socket accepted and the audio the server says it
         * heard. A normal turn end matches to the millisecond; a turn the server closed
         * by itself is short by at least the pause that triggered it.
         */
        const val TURN_END_TOLERANCE = 1.0
    }

    private val confined = Dispatchers.Default.limitedParallelism(1)
    private val scope = CoroutineScope(SupervisorJob() + confined)
    private val commands = Channel<Command>(Channel.UNLIMITED)

    private var sendLoop: Job? = null
    private var receiveLoop: Job? = null

    private val finals = ArrayList<String>()
    private var failure: String? = null
    private var didSetup = false
    private var activityEndFlushed = false
    private var closed = false
    private var serverReportsActivity = false
    private var serverEndedTurn = false
    private var serverTurnEnd: Double? = null

    private val partialFlow = MutableSharedFlow<String>(replay = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    /** Partials for display. Nothing that arrives here may become the transcript. */
    val partials: SharedFlow<String> get() = partialFlow

    /** Called from the audio thread. Must not block, must not suspend. */
    fun enqueue(pcm: ByteArray) {
        ring.append(pcm)
        commands.trySend(Command.PCM_AVAILABLE)
    }

    /**
     * Connects, handshakes and opens the pumps. Throws if the socket or the key is
     * refused or setup does not complete in time: the caller falls back to batch.
     * Audio enqueued meanwhile waits in the ring.
     */
    suspend fun start(setupTimeout: Double = 5.0) = withContext(confined) {
        transport.connect()
        transport.send(LiveProtocol.setupFrame(setup))
        // Every receive is raced against the clock: a socket that connects and then
        // says nothing must not park dictation's fallback.
        val deadline = System.nanoTime() + (setupTimeout * 1e9).toLong()
        while (!didSetup) {
            val remaining = (deadline - System.nanoTime()) / 1_000_000
            if (remaining <= 0) break
            val frame = withTimeoutOrNull(remaining) { transport.receive() } ?: break
            when (val event = LiveProtocol.decode(frame)) {
                LiveEvent.SetupComplete -> didSetup = true
                is LiveEvent.Failed -> throw LiveError.refused(event.message)
                else -> continue
            }
        }
        if (!didSetup) throw LiveError.setupTimedOut()
        transport.send(LiveProtocol.activityStartFrame())
        receiveLoop = scope.launch { runReceiveLoop() }
        sendLoop = scope.launch { runSendLoop() }
    }

    private suspend fun runSendLoop() {
        for (command in commands) {
            if (closed) return
            // Drain the ring FIRST on every command: this keeps activityEnd behind the
            // audio it must not overtake.
            for (chunk in ring.drain()) {
                try {
                    transport.send(LiveProtocol.audioFrame(chunk))
                    ring.markAccepted(chunk.size)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    recordFailure("send failed: ${e.message ?: e.javaClass.simpleName}")
                    return
                }
            }
            if (command == Command.END_ACTIVITY) {
                try {
                    transport.send(LiveProtocol.activityEndFrame())
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    recordFailure("activityEnd failed: ${e.message ?: e.javaClass.simpleName}")
                }
                activityEndFlushed = true
                return
            }
        }
    }

    private suspend fun runReceiveLoop() {
        while (!closed) {
            val frame = try {
                transport.receive()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (!closed) recordFailure("receive failed: ${e.message ?: e.javaClass.simpleName}")
                return
            }
            when (val event = LiveProtocol.decode(frame) ?: continue) {
                is LiveEvent.Partial -> partialFlow.tryEmit(event.text)
                is LiveEvent.Final -> finals.add(event.text)
                LiveEvent.ActivityStarted -> serverReportsActivity = true
                is LiveEvent.ActivityEnded -> if (!serverEndedTurn) {
                    // The first one is kept so a later one cannot hide an early cut.
                    serverEndedTurn = true
                    serverTurnEnd = event.offsetSeconds
                }
                LiveEvent.GoAway -> { recordFailure("server sent goAway"); return }
                is LiveEvent.Failed -> { recordFailure(event.message); return }
                LiveEvent.SetupComplete -> continue
            }
        }
    }

    private fun recordFailure(why: String) {
        if (failure == null) failure = why
    }

    /**
     * Ends the turn and waits for the server's last word. Call only after the last
     * audio has been enqueued: key-up is not the end of speech.
     */
    suspend fun finish(deadline: Double = 6.0): Outcome = withContext(confined) {
        if (!didSetup) return@withContext Outcome.Unusable("setup never completed")
        failure?.let { close(); return@withContext Outcome.Unusable(it) }
        // Nothing asked for a turn end yet, so this one is the server's own: everything
        // said after it was ignored.
        if (serverEndedTurn) {
            close()
            return@withContext Outcome.Unusable(turnEndedEarly(serverTurnEnd))
        }

        commands.trySend(Command.END_ACTIVITY)
        commands.close()

        // Wait for the send loop to flush activityEnd before starting the final's clock.
        val flushDeadline = System.nanoTime() + 2_000_000_000L
        while (!activityEndFlushed && failure == null && System.nanoTime() < flushDeadline) delay(20)
        failure?.let { close(); return@withContext Outcome.Unusable(it) }
        if (!activityEndFlushed) { close(); return@withContext Outcome.Unusable("activityEnd never flushed") }

        // Wait for the server to close the turn activityEnd asked it to close. An
        // earlier segment's final says nothing about the audio after it. Only a server
        // that never reports activity is judged on finals alone.
        val finalDeadline = System.nanoTime() + (deadline * 1e9).toLong()
        while (failure == null && System.nanoTime() < finalDeadline &&
            (if (serverReportsActivity) !serverEndedTurn else finals.isEmpty())
        ) delay(30)
        close()

        failure?.let { return@withContext Outcome.Unusable(it) }
        if (serverReportsActivity && !serverEndedTurn) return@withContext Outcome.Unusable("no final turn end before deadline")
        if (finals.isEmpty()) return@withContext Outcome.Unusable("no final transcript before deadline")
        if (ring.didDrop) return@withContext Outcome.Unusable("dropped ${ring.droppedChunks} chunks — stream is truncated")
        val heard = serverTurnEnd
        if (heard != null && abs(heard - sentSeconds) > TURN_END_TOLERANCE) {
            return@withContext Outcome.Unusable(turnEndedEarly(heard))
        }
        val joined = finals.joinToString(" ").trim()
        if (joined.isEmpty()) return@withContext Outcome.Unusable("final transcript was empty")
        Outcome.Completed(joined)
    }

    private val sentSeconds: Double get() = ring.acceptedBytes.toDouble() / PcmRing.BYTES_PER_SECOND

    private fun turnEndedEarly(heard: Double?): String {
        val at = heard?.let { String.format(Locale.ROOT, "%.1fs", it) } ?: "an unstated offset"
        return "server ended the turn at $at of " + String.format(Locale.ROOT, "%.1fs", sentSeconds) +
            " — the rest was never transcribed"
    }

    /** Tear down without waiting. Idempotent. */
    suspend fun abort() = withContext(confined) { close() }

    private fun close() {
        if (closed) return
        closed = true
        sendLoop?.cancel()
        receiveLoop?.cancel()
        commands.close()
        transport.close()
    }

    /** Bytes the socket accepted, for reconciliation against `framesWritten * 2`. */
    val acceptedBytes: Long get() = ring.acceptedBytes
}
