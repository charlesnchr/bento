package com.charles.bento.core.voice.live

import com.charles.bento.core.voice.gemini.GeminiModels
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.io.IOException
import java.util.concurrent.TimeUnit

/** A Live socket as the sessions see it: JSON text frames in and out. */
interface LiveTransport {
    suspend fun connect()
    suspend fun send(frame: String)
    /** The next server frame; throws once the socket is closed or failed. */
    suspend fun receive(): String
    fun close()
}

/** How a socket ended, for diagnostics: a refused upgrade's status and the close frame. */
data class LiveSocketEnding(val httpStatus: Int? = null, val closeCode: Int? = null, val closeReason: String? = null)

/**
 * The Gemini API's Live WebSocket over OkHttp, authenticated with the API key in the
 * `x-goog-api-key` header. Port of the Mac's `WebSocketTransport`.
 *
 * OkHttp's `send` only enqueues; to keep the PCM ring's backpressure meaningful (a
 * stalled socket must fill the ring, not an unbounded queue), [send] waits while
 * more than [maxQueuedBytes] are still unsent.
 */
class OkHttpLiveTransport(
    private val apiKey: () -> String,
    private val endpoint: String = GeminiModels.LIVE_ENDPOINT,
    httpClient: OkHttpClient = defaultClient(),
    private val maxQueuedBytes: Long = 256L * 1024,
) : LiveTransport {
    private val client = httpClient
    private val incoming = Channel<String>(Channel.UNLIMITED)
    private val opened = CompletableDeferred<Unit>()
    @Volatile private var socket: WebSocket? = null
    @Volatile private var closed = false
    @Volatile var ending: LiveSocketEnding = LiveSocketEnding()
        private set

    override suspend fun connect() {
        val request = Request.Builder().url(endpoint).header("x-goog-api-key", apiKey()).build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                opened.complete(Unit)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                incoming.trySend(text)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                incoming.trySend(bytes.utf8())
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                ending = ending.copy(closeCode = code, closeReason = reason.ifEmpty { null })
                webSocket.close(code, null)
                incoming.close(IOException("socket closed by server ($code${if (reason.isNotEmpty()) " $reason" else ""})"))
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                incoming.close(IOException("socket closed ($code)"))
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val status = response?.code?.takeIf { it != 101 }
                if (status != null) ending = ending.copy(httpStatus = status)
                val error = if (t is IOException) t else IOException(t)
                opened.completeExceptionally(error)
                incoming.close(error)
            }
        })
        if (closed) socket?.cancel()
        opened.await()
    }

    override suspend fun send(frame: String) {
        val ws = socket ?: throw LiveError.setupTimedOut()
        if (closed || !ws.send(frame)) throw IOException("socket is closed")
        while (ws.queueSize() > maxQueuedBytes) {
            if (closed) throw IOException("socket is closed")
            delay(10)
        }
    }

    override suspend fun receive(): String = incoming.receive()

    override fun close() {
        if (closed) return
        closed = true
        socket?.close(1001, null)
        incoming.close()
        opened.completeExceptionally(IOException("closed"))
    }

    companion object {
        /** No redirects (the key must not follow one); the socket itself has no read timeout. */
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()
    }
}
