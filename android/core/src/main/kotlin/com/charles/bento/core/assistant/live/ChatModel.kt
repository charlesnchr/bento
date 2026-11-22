package com.charles.bento.core.assistant.live

import com.charles.bento.core.voice.gemini.GeminiModels
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit

/** The text model a typed chat runs on ([CoreChat]): one `generateContent` request, answered as a stream. */
fun interface ChatModel {
    /**
     * Sends [body] (a `generateContent` request as JSON) to [model] and gives each response of
     * its stream as JSON. Cancelling the collector drops the request; a refusal or a lost
     * connection is a [ChatModelError].
     */
    fun generate(model: String, body: String): Flow<String>
}

/** The text model didn't answer: [status] is the HTTP status when it refused. */
class ChatModelError(message: String, val status: Int? = null) : IOException(message)

/**
 * Gemini over the Gemini API with the phone's key: `streamGenerateContent` as server-sent events.
 * [url] is where a model's requests go (tests point it at the voice core's dev server).
 */
class GeminiChatModel(
    private val apiKey: () -> String?,
    http: OkHttpClient,
    private val url: (model: String) -> String = { "${GeminiModels.ENDPOINT}/v1beta/$it:streamGenerateContent?alt=sse" },
) : ChatModel {
    /** The model may think for a while before its first byte, and a long answer streams for longer. */
    private val http = http.newBuilder().readTimeout(60, TimeUnit.SECONDS).callTimeout(0, TimeUnit.SECONDS).build()

    override fun generate(model: String, body: String): Flow<String> = callbackFlow {
        val request = Request.Builder().url(url(model)).post(body.toRequestBody(JSON))
            .apply { apiKey()?.let { header("x-goog-api-key", it) } }.header("Accept", "text/event-stream").build()
        val call = http.newCall(request)
        launch(Dispatchers.IO) {
            try {
                call.execute().use { response ->
                    if (!response.isSuccessful) throw refusal(response.code, runCatching { response.peekBody(16_384).string() }.getOrDefault(""))
                    val source = response.body.source()
                    while (!source.exhausted()) {
                        val line = source.readUtf8LineStrict(MAX_LINE)
                        if (line.startsWith("data:")) send(line.substring(5).trim())
                    }
                }
                close()
            } catch (x: IOException) {
                close(if (call.isCanceled()) null else describe(x))
            }
        }
        awaitClose { call.cancel() }
    }

    companion object {
        private val JSON = "application/json".toMediaType()
        private const val MAX_LINE = 4L * 1024 * 1024
        private val MESSAGE = Regex("\"message\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"")

        /** Why the API refused, in the user's words where the status says it and the API's own otherwise. */
        internal fun refusal(status: Int, body: String): ChatModelError {
            val detail = MESSAGE.find(body)?.groupValues?.get(1)?.replace("\\\"", "\"")?.replace("\\n", " ")?.take(200)
            val message = when (status) {
                401, 403 -> "Gemini rejected the API key (HTTP $status)"
                429 -> "Gemini is over its rate limit (HTTP 429)"
                else -> "HTTP $status" + (detail?.let { ": $it" } ?: "")
            }
            return ChatModelError(message, status)
        }

        internal fun describe(x: IOException): ChatModelError = when (x) {
            is ChatModelError -> x
            is UnknownHostException, is ConnectException, is NoRouteToHostException -> ChatModelError("can't reach Gemini (is the phone online?)")
            is SocketTimeoutException -> ChatModelError("Gemini stopped answering")
            else -> ChatModelError("lost the connection to Gemini (${x.message ?: x.javaClass.simpleName})")
        }
    }
}
