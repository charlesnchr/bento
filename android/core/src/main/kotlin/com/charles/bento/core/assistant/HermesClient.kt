package com.charles.bento.core.assistant

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Hermes's native session API over HTTP (the gateway's `api_server` platform): conversations
 * are Hermes sessions, a turn is `POST /api/sessions/{id}/chat/stream` (server-sent events),
 * and a running turn stops through `POST /v1/runs/{run}/stop`. Every request carries the
 * bearer token; nothing here retries a turn.
 */
class HermesClient(private val endpoint: () -> HermesEndpoint?, http: OkHttpClient) {
    private val http = http.newBuilder().followRedirects(false).followSslRedirects(false).build()
    /** Hermes sends a keepalive comment every 10 s, so a minute of silence is a dead connection. */
    private val streaming = this.http.newBuilder().readTimeout(60, TimeUnit.SECONDS).callTimeout(0, TimeUnit.SECONDS).build()

    /** Checks the server and the token; returns Hermes's version. */
    suspend fun check(): String {
        val health = get("health", auth = false)
        get("api/sessions?limit=1")
        return health.string("version")?.let { "Hermes $it" } ?: "Hermes"
    }

    suspend fun sessions(limit: Int = 100): List<HermesSession> =
        (get("api/sessions?source=api_server&limit=$limit")["data"] as? JsonArray).orEmpty()
            .mapNotNull { (it as? JsonObject)?.let(HermesSession::parse) }

    suspend fun createSession(): HermesSession {
        val body = send("POST", "api/sessions", buildJsonObject { put("source", "api_server") })
        return (body["session"] as? JsonObject)?.let(HermesSession::parse) ?: throw HermesError("Hermes didn't create a conversation.")
    }

    suspend fun messages(sessionId: String): List<HermesMessage> =
        (get("api/sessions/${seg(sessionId)}/messages")["data"] as? JsonArray).orEmpty()
            .mapNotNull { (it as? JsonObject)?.let(HermesMessage::parse) }

    suspend fun delete(sessionId: String) { send("DELETE", "api/sessions/${seg(sessionId)}", null) }

    suspend fun stop(runId: String) { send("POST", "v1/runs/${seg(runId)}/stop", JsonObject(emptyMap())) }

    suspend fun approve(runId: String, choice: String) {
        send("POST", "v1/runs/${seg(runId)}/approval", buildJsonObject { put("choice", choice) })
    }

    /**
     * One turn. Cancelling the collector closes the stream, which Hermes treats as a stop
     * (it interrupts the agent); errors arrive as [HermesError].
     */
    fun chat(sessionId: String, message: String, instructions: String? = null): Flow<HermesEvent> = callbackFlow {
        val e = endpoint() ?: throw notConfigured()
        val body = buildJsonObject {
            put("message", message)
            if (instructions != null) put("instructions", instructions)
        }
        val call = streaming.newCall(request(e, "api/sessions/${seg(sessionId)}/chat/stream", "POST", body.toString())
            .newBuilder().header("Accept", "text/event-stream").build())
        launch(Dispatchers.IO) {
            try {
                call.execute().use { response ->
                    if (!response.isSuccessful) throw failure(response, e)
                    val source = response.body.source()
                    val parser = SseParser()
                    while (!source.exhausted()) {
                        // A line with no end in sight is not Hermes: fail rather than buffer it all.
                        val line = try {
                            source.readUtf8LineStrict(MAX_LINE)
                        } catch (_: java.io.EOFException) {
                            throw HermesError("Hermes's stream broke off mid-line (or sent a line over 4 MB).")
                        }
                        val event = parser.line(line)?.let(HermesEvent::decode) ?: continue
                        send(event)
                        if (event == HermesEvent.Done) break
                    }
                }
                close()
            } catch (x: IOException) {
                close(if (call.isCanceled()) null else describe(x, e))
            }
        }
        awaitClose { call.cancel() }
    }

    private suspend fun get(path: String, auth: Boolean = true): JsonObject {
        val e = endpoint() ?: throw notConfigured()
        val r = request(e, path, "GET", null)
        return execute(if (auth) r else r.newBuilder().removeHeader("Authorization").build(), e)
    }

    private suspend fun send(method: String, path: String, body: JsonObject?): JsonObject {
        val e = endpoint() ?: throw notConfigured()
        return execute(request(e, path, method, body?.toString()), e)
    }

    private fun request(e: HermesEndpoint, path: String, method: String, json: String?): Request {
        val url = resolve(e.url, path)
        return Request.Builder().url(url)
            .header("Authorization", "Bearer ${e.token}")
            .method(method, json?.toRequestBody(JSON))
            .build()
    }

    private suspend fun execute(request: Request, e: HermesEndpoint): JsonObject = withContext(Dispatchers.IO) {
        val response = try {
            http.newCall(request).await()
        } catch (x: IOException) {
            throw describe(x, e)
        }
        response.use {
            if (!it.isSuccessful) throw failure(it, e)
            val text = runCatching { it.body.string() }.getOrElse { x -> throw describe(x as? IOException ?: IOException(x), e) }
            if (text.isBlank()) JsonObject(emptyMap())
            else runCatching { HermesJson.parseToJsonElement(text) as? JsonObject }.getOrNull()
                ?: throw HermesError("Hermes sent something that isn't JSON. Is this the API server's address?")
        }
    }

    companion object {
        private val JSON = "application/json".toMediaType()
        private const val MAX_LINE = 4L * 1024 * 1024

        private fun seg(s: String) = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")

        internal fun resolve(base: HttpUrl, path: String): HttpUrl {
            val prefix = base.encodedPath.trimEnd('/')
            val (p, q) = path.split('?', limit = 2).let { it[0] to it.getOrNull(1) }
            return base.newBuilder().encodedPath("$prefix/$p").encodedQuery(q).build()
        }

        private fun notConfigured() = HermesError("Set up Hermes first: Settings → Hermes.")

        /** The user's words for a refused request (Hermes's error envelope where there is one). */
        internal fun failure(response: Response, e: HermesEndpoint): HermesError {
            val body = runCatching { response.peekBody(16_384).string() }.getOrDefault("")
            val json = runCatching { HermesJson.parseToJsonElement(body) as? JsonObject }.getOrNull()
            val error = json?.get("error")
            val detail = (error as? JsonObject)?.string("message") ?: json?.string("error") ?: json?.string("message")
            val code = (error as? JsonObject)?.string("code")
            val status = response.code
            val message = when {
                status == 401 || status == 403 -> "Hermes rejected the token. Check it in Settings → Hermes."
                status == 404 && code == "session_not_found" -> "Hermes no longer has this conversation."
                status == 404 -> "${e.url.host} answered, but not as Hermes's API server (HTTP 404)."
                status == 429 -> detail ?: "Hermes is busy with other requests. Try again in a moment."
                status == 409 -> detail ?: "Hermes is still working on this conversation."
                else -> "Hermes failed (HTTP $status)" + (detail?.let { ": $it" } ?: ".")
            }
            return HermesError(message, status, code)
        }

        internal fun describe(x: IOException, e: HermesEndpoint): IOException = when (x) {
            is HermesError -> x
            is UnknownHostException, is ConnectException, is NoRouteToHostException ->
                HermesError("Can't reach Hermes at ${e.url.host}:${e.url.port}. Is Tailscale connected?")
            is SocketTimeoutException -> HermesError("Hermes at ${e.url.host} stopped answering.")
            else -> HermesError("Lost the connection to Hermes: ${x.message ?: x.javaClass.simpleName}")
        }
    }
}

/** Suspends until the call completes (30 s at most); cancelling the coroutine cancels the call. */
private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    timeout().timeout(30, TimeUnit.SECONDS)
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (!cont.isCancelled) cont.resumeWithException(e)
        }

        override fun onResponse(call: Call, response: Response) {
            cont.resume(response) { _, _, _ -> response.close() }
        }
    })
    cont.invokeOnCancellation { runCatching { cancel() } }
}
