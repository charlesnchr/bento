package com.charles.bento.core.assistant

import com.charles.bento.core.voice.blocking
import kotlinx.coroutines.flow.toList
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.util.Base64
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class DpopTest {
    private lateinit var server: MockWebServer

    @BeforeTest fun setUp() {
        server = MockWebServer().apply { start() }
    }

    @AfterTest fun tearDown() = server.close()

    @Test fun proofStructureSignatureAndThumbprint() {
        val signer = JvmDpopSigner()
        val token = "bnt_test_token_123"
        val url = "https://bento-5f61f00e45.charlesnchr.com/api/sessions?source=api_server&limit=10#frag".toHttpUrl()
        val proof = DpopProof.create(signer, "get", url, token, nowSeconds = 1_795_638_000L, jti = "jti-1")

        val parts = proof.split('.')
        assertEquals(3, parts.size)

        val header = Json.parseToJsonElement(b64Decode(parts[0]).decodeToString()).jsonObject
        assertEquals("dpop+jwt", header["typ"]!!.jsonPrimitive.content)
        assertEquals("ES256", header["alg"]!!.jsonPrimitive.content)
        val jwk = header["jwk"]!!.jsonObject
        assertEquals("EC", jwk["kty"]!!.jsonPrimitive.content)
        assertEquals("P-256", jwk["crv"]!!.jsonPrimitive.content)
        assertNull(jwk["d"])
        val x = b64Decode(jwk["x"]!!.jsonPrimitive.content)
        val y = b64Decode(jwk["y"]!!.jsonPrimitive.content)
        assertEquals(32, x.size)
        assertEquals(32, y.size)

        val payload = Json.parseToJsonElement(b64Decode(parts[1]).decodeToString()).jsonObject
        assertEquals("jti-1", payload["jti"]!!.jsonPrimitive.content)
        assertEquals("GET", payload["htm"]!!.jsonPrimitive.content)
        assertEquals("https://bento-5f61f00e45.charlesnchr.com/api/sessions", payload["htu"]!!.jsonPrimitive.content)
        assertEquals(1_795_638_000L, payload["iat"]!!.jsonPrimitive.long)
        val expectedAth = Base64.getUrlEncoder().withoutPadding()
            .encodeToString(MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.US_ASCII)))
        assertEquals(expectedAth, payload["ath"]!!.jsonPrimitive.content)

        // Verify raw 64-byte IEEE P1363 signature by converting back to DER and verifying with JCA.
        val rawSig = b64Decode(parts[2])
        assertEquals(64, rawSig.size)
        val ecSpec = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }
            .getParameterSpec(ECParameterSpec::class.java)
        val pubKey = KeyFactory.getInstance("EC").generatePublic(
            ECPublicKeySpec(ECPoint(BigInteger(1, x), BigInteger(1, y)), ecSpec),
        )
        val verifier = Signature.getInstance("SHA256withECDSA").apply {
            initVerify(pubKey)
            update("${parts[0]}.${parts[1]}".toByteArray(Charsets.US_ASCII))
        }
        assertTrue(verifier.verify(p1363ToDer(rawSig)))
        assertEquals(43, signer.thumbprint.length)
    }

    @Test fun derToP1363HandlesShortAndPaddedIntegers() {
        // r = 0x01 (1 byte, needs 31 leading zeros), s = 32 bytes with high bit set (33 bytes in DER with 0x00 prefix)
        val sBytes = ByteArray(32) { i -> if (i == 0) 0x80.toByte() else (i + 1).toByte() }
        val rPart = byteArrayOf(0x02, 0x01, 0x01)
        val sPart = byteArrayOf(0x02, 0x21, 0x00) + sBytes
        val der = byteArrayOf(0x30, (rPart.size + sPart.size).toByte()) + rPart + sPart

        val raw = DpopProof.derToP1363(der, 32)
        assertEquals(64, raw.size)
        assertEquals(1.toByte(), raw[31])
        assertTrue(raw.sliceArray(0 until 31).all { it == 0.toByte() })
        assertTrue(raw.sliceArray(32 until 64).contentEquals(sBytes))
    }

    @Test fun hermesClientSendsDpopForBoundEndpointAndSkipsHealth() = blocking {
        val signer = JvmDpopSigner()
        val endpoint = HermesEndpoint(server.url("/"), "bnt_device_key")
        val client = HermesClient({ endpoint }, OkHttpClient(), dpop = { signer })

        server.enqueue(MockResponse.Builder().code(200).body("""{"status":"ok"}""").addHeader("Content-Type", "application/json").build())
        server.enqueue(MockResponse.Builder().code(200).body("""{"object":"list","data":[]}""").addHeader("Content-Type", "application/json").build())
        server.enqueue(MockResponse.Builder().code(200).body("event: done\ndata: {}\n\n").addHeader("Content-Type", "text/event-stream").build())

        client.check()
        client.chat("s1", "hi").toList()

        val health = server.takeRequest()
        assertEquals("/health", health.url.encodedPath)
        assertNull(health.headers["Authorization"])
        assertNull(health.headers["DPoP"])

        val sessions = server.takeRequest()
        assertEquals("DPoP bnt_device_key", sessions.headers["Authorization"])
        val p1 = sessions.headers["DPoP"]!!
        val payload1 = Json.parseToJsonElement(b64Decode(p1.split('.')[1]).decodeToString()).jsonObject
        assertEquals("GET", payload1["htm"]!!.jsonPrimitive.content)
        assertEquals(server.url("/api/sessions").toString(), payload1["htu"]!!.jsonPrimitive.content)

        val stream = server.takeRequest()
        assertEquals("DPoP bnt_device_key", stream.headers["Authorization"])
        val p2 = stream.headers["DPoP"]!!
        val payload2 = Json.parseToJsonElement(b64Decode(p2.split('.')[1]).decodeToString()).jsonObject
        assertEquals("POST", payload2["htm"]!!.jsonPrimitive.content)
        assertEquals(server.url("/api/sessions/s1/chat/stream").toString(), payload2["htu"]!!.jsonPrimitive.content)
        assertNotEquals(payload1["jti"]!!.jsonPrimitive.content, payload2["jti"]!!.jsonPrimitive.content)
    }

    private fun b64Decode(s: String): ByteArray = Base64.getUrlDecoder().decode(s)

    private fun p1363ToDer(raw: ByteArray): ByteArray {
        fun encodeInt(slice: ByteArray): ByteArray {
            val trimmed = BigInteger(1, slice).toByteArray()
            return byteArrayOf(0x02, trimmed.size.toByte()) + trimmed
        }
        val r = encodeInt(raw.copyOfRange(0, 32))
        val s = encodeInt(raw.copyOfRange(32, 64))
        return byteArrayOf(0x30, (r.size + s.size).toByte()) + r + s
    }
}
