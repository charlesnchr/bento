package com.charles.bento.core.assistant

import com.charles.bento.core.voice.blocking
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The Hermes API server as a fake: request shapes, the recorded stream, and the error matrix. */
class HermesClientTest {
    private lateinit var server: MockWebServer
    private var endpoint: HermesEndpoint? = null
    private val client by lazy { HermesClient({ endpoint }, OkHttpClient()) }

    @BeforeTest fun setUp() {
        server = MockWebServer().apply { start() }
        endpoint = HermesEndpoint(server.url("/"), "secret-token")
    }

    @AfterTest fun tearDown() = server.close()

    private fun enqueue(code: Int, body: String, contentType: String = "application/json") =
        server.enqueue(MockResponse.Builder().code(code).body(body).addHeader("Content-Type", contentType).build())

    private fun fixture(name: String) = javaClass.getResource("/assistant/$name")!!.readText()

    @Test fun endpointsFromWhatPeopleType() {
        assertEquals("http://100.88.250.122:8642/", HermesEndpoint.parseUrl("100.88.250.122:8642")!!.toString())
        assertEquals("http://192.168.1.5:8642/", HermesEndpoint.parseUrl(" http://192.168.1.5:8642/ ")!!.toString())
        assertEquals("https://homelab.tail1.ts.net/", HermesEndpoint.parseUrl("homelab.tail1.ts.net/v1")!!.toString())
        assertEquals("http://[fd7a:115c:a1e0::1]:8642/", HermesEndpoint.parseUrl("[fd7a:115c:a1e0::1]:8642")!!.toString())
        assertEquals("https://h.example/hermes", HermesEndpoint.parseUrl("https://h.example/hermes/v1/")!!.toString())
        assertNull(HermesEndpoint.parseUrl(""))
        assertNull(HermesEndpoint.parseUrl("ftp://x"))
        assertNull(HermesEndpoint.of("homelab:8642", " "))
        assertTrue("secret" !in HermesEndpoint(server.url("/"), "secret").toString(), "the token never shows in logs")
    }

    @Test fun theKeyNeverGoesInTheClearOverTheInternet() {
        // Without a scheme, anything that could be on the internet is https.
        assertEquals("https://homelab:8642/", HermesEndpoint.parseUrl("homelab:8642")!!.toString())
        assertEquals("https://hermes.example.com/", HermesEndpoint.parseUrl("hermes.example.com")!!.toString())
        // Plain http is refused there, with a reason the dialogs show.
        assertNull(HermesEndpoint.parseUrl("http://hermes.example.com:8642"))
        assertNull(HermesEndpoint.parseUrl("http://homelab:8642"))
        assertNull(HermesEndpoint.parseUrl("http://8.8.8.8"))
        assertNull(HermesEndpoint.parseUrl("http://100.128.0.1")) // just outside Tailscale's range
        assertTrue(HermesEndpoint.problem("http://hermes.example.com")!!.contains("Use https:// for hermes.example.com"))
        assertNull(HermesEndpoint.problem("100.88.250.122:8642"))
        assertNull(HermesLink.parse("bento://hermes?url=http%3A%2F%2Fevil.example&token=t"))
        for (ok in listOf("100.64.0.1", "100.127.255.254", "10.0.2.2", "172.16.0.1", "172.31.9.9", "192.168.1.1",
                          "169.254.3.4", "127.0.0.1", "localhost", "::1", "fd7a:115c:a1e0::1", "fe80::1")) {
            assertTrue(HermesEndpoint.isPrivateAddress(ok), ok)
        }
        for (no in listOf("100.63.0.1", "172.32.0.1", "192.169.0.1", "8.8.8.8", "2001:db8::1", "homelab", "a.ts.net", "1.2.3")) {
            assertFalse(HermesEndpoint.isPrivateAddress(no), no)
        }
    }

    @Test fun aRunawayLineFailsTheStream() = blocking {
        server.enqueue(MockResponse.Builder().code(200).addHeader("Content-Type", "text/event-stream")
            .body("data: " + "x".repeat(4 * 1024 * 1024 + 10)).build())
        val e = assertFailsWith<HermesError> { client.chat("s", "hi").toList() }
        assertTrue(e.message!!.contains("4 MB"))
    }

    @Test fun pathsKeepAPrefix() {
        val base = HermesEndpoint.parseUrl("https://h.example/hermes")!!
        assertEquals("https://h.example/hermes/api/sessions?limit=1", HermesClient.resolve(base, "api/sessions?limit=1").toString())
    }

    @Test fun checkReadsHealthThenProvesTheToken() = blocking {
        enqueue(200, """{"status":"ok","platform":"hermes-agent","version":"0.22.2"}""")
        enqueue(200, """{"object":"list","data":[]}""")
        assertEquals("Hermes 0.22.2", client.check())
        val health = server.takeRequest()
        assertEquals("/health", health.url.encodedPath)
        assertNull(health.headers["Authorization"], "health is public; the token goes only where it's needed")
        val sessions = server.takeRequest()
        assertEquals("/api/sessions", sessions.url.encodedPath)
        assertEquals("Bearer secret-token", sessions.headers["Authorization"])
    }

    @Test fun aRejectedTokenSaysSo() = blocking {
        enqueue(200, """{"status":"ok"}""")
        enqueue(401, """{"error":{"message":"Invalid gateway API key (API_SERVER_KEY)","type":"gateway_auth_error","code":"gateway_auth_failed"}}""")
        val e = assertFailsWith<HermesError> { client.check() }
        assertTrue(e.unauthorized)
        assertEquals("Hermes rejected the token. Check it in Settings → Hermes.", e.message)
    }

    @Test fun anUnreachableServerPointsAtTailscale() = blocking {
        val port = server.port
        server.close()
        endpoint = HermesEndpoint(HermesEndpoint.parseUrl("127.0.0.1:$port")!!, "t")
        val e = assertFailsWith<HermesError> { client.sessions() }
        assertEquals("Can't reach Hermes at 127.0.0.1:$port. Is Tailscale connected?", e.message)
    }

    @Test fun notConfiguredIsAnError() = blocking {
        endpoint = null
        assertEquals("Set up Hermes first: Settings → Hermes.", assertFailsWith<HermesError> { client.sessions() }.message)
    }

    @Test fun sessionsAreTheApiServersConversations() = blocking {
        enqueue(200, """{"object":"list","data":[{"id":"api_1","title":null,"preview":"Hello there","last_active":1793225678.03,"message_count":8},{"title":"no id"}],"has_more":false}""")
        val list = client.sessions()
        assertEquals(listOf("api_1"), list.map { it.id })
        assertEquals("Hello there", list[0].label)
        assertEquals(8, list[0].messageCount)
        val r = server.takeRequest()
        assertEquals("api_server", r.url.queryParameter("source"))
    }

    @Test fun createAndDelete() = blocking {
        enqueue(201, """{"object":"hermes.session","session":{"id":"api_9","source":"api_server"}}""")
        enqueue(200, """{"object":"hermes.session.deleted","id":"api_9","deleted":true}""")
        assertEquals("api_9", client.createSession().id)
        client.delete("api_9")
        val create = server.takeRequest()
        assertEquals("POST", create.method)
        assertEquals("api_server", (HermesJson.parseToJsonElement(create.body!!.utf8()) as JsonObject)["source"]!!.jsonPrimitive.content)
        val delete = server.takeRequest()
        assertEquals("DELETE", delete.method)
        assertEquals("/api/sessions/api_9", delete.url.encodedPath)
    }

    @Test fun aGoneConversationIsNamed() = blocking {
        enqueue(404, """{"error":{"message":"Session not found: x","code":"session_not_found"}}""")
        val e = assertFailsWith<HermesError> { client.messages("x") }
        assertEquals("session_not_found", e.code)
        assertEquals("Hermes no longer has this conversation.", e.message)
    }

    @Test fun theRecordedStreamDecodes() = blocking {
        enqueue(200, fixture("chat-stream-tool.sse"), "text/event-stream")
        val events = withTimeout(10_000) { client.chat("api_1793224917_7121c802", "Please use the todo tool", "Be brief.").toList() }
        val request = server.takeRequest()
        assertEquals("/api/sessions/api_1793224917_7121c802/chat/stream", request.url.encodedPath)
        assertEquals("Bearer secret-token", request.headers["Authorization"])
        val body = HermesJson.parseToJsonElement(request.body!!.utf8()) as JsonObject
        assertEquals("Please use the todo tool", body["message"]!!.jsonPrimitive.content)
        assertEquals("Be brief.", body["instructions"]!!.jsonPrimitive.content)

        assertIs<HermesEvent.RunStarted>(events.first())
        assertEquals("run_40358cf849ec4cb6a613f33c1525e962", (events.first() as HermesEvent.RunStarted).runId)
        assertEquals(HermesEvent.ToolStarted("tool_search", "Searching tools"), events.filterIsInstance<HermesEvent.ToolStarted>().single())
        assertEquals(true, events.filterIsInstance<HermesEvent.ToolFinished>().single().failed)
        val completed = events.filterIsInstance<HermesEvent.Completed>().single()
        assertTrue(completed.content.startsWith("Done: I used **the tool** for you."))
        assertEquals(HermesEvent.Finished("completed", "api_1793224917_7121c802", null), events.filterIsInstance<HermesEvent.Finished>().single())
        assertEquals(HermesEvent.Done, events.last())
        val streamed = events.filterIsInstance<HermesEvent.Delta>().joinToString("") { it.text }
        assertTrue(streamed.startsWith("Let me use a tool. \n\nDone: "), streamed)
    }

    @Test fun aRefusedTurnFailsTheFlow() = blocking {
        enqueue(429, """{"error":{"message":"Too many concurrent runs","code":"rate_limited"}}""")
        val e = assertFailsWith<HermesError> { client.chat("s", "hi").toList() }
        assertEquals(429, e.status)
        assertEquals("Too many concurrent runs", e.message)
    }

    @Test fun cancellingTheCollectorClosesTheStream() = blocking {
        // run.started, then the server keeps the stream open (Hermes's keepalive).
        val head = "event: run.started\ndata: {\"run_id\":\"run_1\",\"session_id\":\"s\"}\n\n"
        server.enqueue(MockResponse.Builder().code(200).addHeader("Content-Type", "text/event-stream")
            .body(head + ": keepalive\n\n".repeat(200)).throttleBody(16, 100, TimeUnit.MILLISECONDS).build())
        val first = withTimeout(5_000) { client.chat("s", "hi").first() }
        assertEquals(HermesEvent.RunStarted("run_1", "s"), first)
    }

    @Test fun stopAndApprovalNameTheRun() = blocking {
        enqueue(200, """{"run_id":"run_1","status":"stopping"}""")
        enqueue(200, """{"ok":true}""")
        client.stop("run_1")
        client.approve("run_1", "once")
        val stop = server.takeRequest()
        assertEquals("/v1/runs/run_1/stop", stop.url.encodedPath)
        val approval = server.takeRequest()
        assertEquals("/v1/runs/run_1/approval", approval.url.encodedPath)
        assertEquals("once", (HermesJson.parseToJsonElement(approval.body!!.utf8()) as JsonObject)["choice"]!!.jsonPrimitive.content)
    }

    @Test fun sseParsing() {
        val p = SseParser()
        assertNull(p.line(": keepalive"))
        assertNull(p.line(""))
        assertNull(p.line("event: tool.started"))
        assertNull(p.line("data: {\"a\":"))
        assertNull(p.line("data:1}"))
        assertEquals(SseFrame("tool.started", "{\"a\":\n1}"), p.line(""))
        assertNull(p.line("data: x"))
        assertEquals(SseFrame(null, "x"), p.line(""))
    }

    @Test fun eventsWithoutAnEventLineUseTheirPayloadsName() {
        assertEquals(HermesEvent.Done, HermesEvent.decode(SseFrame(null, """{"event":"done"}""")))
        assertNull(HermesEvent.decode(SseFrame("tool.progress", """{"tool_name":"_thinking","delta":"x"}""")))
        assertNull(HermesEvent.decode(SseFrame("message.started", """{}""")))
        val approval = HermesEvent.decode(SseFrame("approval.request", """{"run_id":"r","command":"rm -rf /tmp/x","description":"delete","choices":["once","session","deny"]}"""))
        assertEquals(HermesEvent.Approval("r", "rm -rf /tmp/x", "delete", listOf("once", "session", "deny")), approval)
        assertEquals(HermesEvent.Failed("boom"), HermesEvent.decode(SseFrame("error", """{"message":"boom"}""")))
    }
}

class HermesLinkTest {
    @Test fun theLinkCarriesServerTokenAndName() {
        val link = HermesLink.parse("bento://hermes?v=1&url=http%3A%2F%2F100.88.250.122%3A8642&token=abc%2B1&name=homelab")!!
        assertEquals(HermesLink("http://100.88.250.122:8642", "abc+1", "homelab"), link)
        assertTrue("abc" !in link.toString())
        assertEquals(HermesLink("homelab.tail1.ts.net", "t", ""), HermesLink.parse(" bento://hermes?url=homelab.tail1.ts.net&token=t "))
    }

    @Test fun anythingElseIsNotOne() {
        assertNull(HermesLink.parse("bento://pair?server=x&token=y"))
        assertNull(HermesLink.parse("bento://hermes?url=x"))
        assertNull(HermesLink.parse("bento://hermes?token=y"))
        assertNull(HermesLink.parse("bento://hermes?v=2&url=h:1&token=y"))
        assertNull(HermesLink.parse("https://hermes?url=h:1&token=y"))
    }
}
