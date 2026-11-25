package com.charles.bento.core.assistant

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl
import java.math.BigInteger
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Base64

/** Public EC P-256 key in RFC 7517 JWK form, with its RFC 7638 SHA-256 thumbprint. */
data class EcJwk(val x: String, val y: String) {
    /** Canonical member order required by RFC 7638 for computing `jkt`. */
    fun canonicalJson(): String = """{"crv":"P-256","kty":"EC","x":"$x","y":"$y"}"""

    val thumbprint: String
        get() = DpopProof.base64Url(DpopProof.sha256(canonicalJson().toByteArray(Charsets.UTF_8)))
}

/**
 * Signs RFC 9449 DPoP proofs (`ES256`, P-256) with a device-bound key.
 * [sign] returns the raw 64-byte IEEE P1363 `r || s` signature.
 */
interface DpopSigner {
    val jwk: EcJwk
    val thumbprint: String get() = jwk.thumbprint
    fun sign(input: ByteArray): ByteArray
}

/** Builds RFC 9449 `dpop+jwt` proofs for HTTP requests carrying an access token. */
object DpopProof {
    private val random = SecureRandom()
    private val b64 = Base64.getUrlEncoder().withoutPadding()

    fun create(
        signer: DpopSigner,
        method: String,
        url: HttpUrl,
        accessToken: String,
        nowSeconds: Long = System.currentTimeMillis() / 1000L,
        jti: String = randomJti(),
    ): String {
        val htu = url.newBuilder().query(null).fragment(null).build().toString()
        val ath = base64Url(sha256(accessToken.toByteArray(Charsets.US_ASCII)))
        val header = """{"typ":"dpop+jwt","alg":"ES256","jwk":${signer.jwk.canonicalJson()}}"""
        val payload = buildJsonObject {
            put("jti", jti)
            put("htm", method.uppercase())
            put("htu", htu)
            put("iat", nowSeconds)
            put("ath", ath)
        }.toString()
        val signingInput = "${base64Url(header.toByteArray(Charsets.UTF_8))}.${base64Url(payload.toByteArray(Charsets.UTF_8))}"
        val rawSig = signer.sign(signingInput.toByteArray(Charsets.US_ASCII))
        require(rawSig.size == 64) { "ES256 signature must be 64 bytes, got ${rawSig.size}" }
        return "$signingInput.${base64Url(rawSig)}"
    }

    fun ecPublicKeyToJwk(publicKey: ECPublicKey): EcJwk = EcJwk(
        x = base64Url(toUnsignedFixed(publicKey.w.affineX, 32)),
        y = base64Url(toUnsignedFixed(publicKey.w.affineY, 32)),
    )

    /** Converts a JCA ASN.1 DER ECDSA signature (`SEQUENCE { INTEGER r, INTEGER s }`) to IEEE P1363 `r || s`. */
    fun derToP1363(der: ByteArray, componentSize: Int = 32): ByteArray {
        require(der.size >= 8 && der[0] == 0x30.toByte()) { "Invalid DER ECDSA signature" }
        var offset = 1
        val seqLenByte = der[offset++].toInt() and 0xff
        val seqLen = if (seqLenByte < 0x80) {
            seqLenByte
        } else {
            val lenBytes = seqLenByte and 0x7f
            require(lenBytes in 1..2 && offset + lenBytes <= der.size) { "Invalid DER sequence length" }
            var acc = 0
            repeat(lenBytes) { acc = (acc shl 8) or (der[offset++].toInt() and 0xff) }
            acc
        }
        require(offset + seqLen == der.size) { "DER length mismatch" }

        val out = ByteArray(componentSize * 2)
        for (part in 0..1) {
            require(offset + 2 <= der.size && der[offset++] == 0x02.toByte()) { "Expected DER INTEGER" }
            val len = der[offset++].toInt() and 0xff
            require(len > 0 && offset + len <= der.size) { "Invalid DER INTEGER length" }
            var start = offset
            var count = len
            offset += len
            while (count > 0 && der[start] == 0.toByte()) {
                start++
                count--
            }
            require(count <= componentSize) { "ECDSA integer larger than $componentSize bytes" }
            val destOffset = part * componentSize + (componentSize - count)
            System.arraycopy(der, start, out, destOffset, count)
        }
        require(offset == der.size) { "Trailing bytes in DER ECDSA signature" }
        return out
    }

    internal fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

    internal fun base64Url(bytes: ByteArray): String = b64.encodeToString(bytes)

    private fun randomJti(): String = base64Url(ByteArray(16).also(random::nextBytes))

    private fun toUnsignedFixed(value: BigInteger, size: Int): ByteArray {
        require(value.signum() >= 0) { "Coordinate must be non-negative" }
        val bytes = value.toByteArray()
        val out = ByteArray(size)
        val srcOffset = if (bytes.size > size) {
            require(bytes.size == size + 1 && bytes[0] == 0.toByte()) { "Coordinate exceeds $size bytes" }
            1
        } else 0
        val copyLen = bytes.size - srcOffset
        System.arraycopy(bytes, srcOffset, out, size - copyLen, copyLen)
        return out
    }
}

/** Pure-JVM ES256 [DpopSigner], for tests and non-Android hosts. */
class JvmDpopSigner(private val keyPair: KeyPair = generateKeyPair()) : DpopSigner {
    override val jwk: EcJwk = DpopProof.ecPublicKeyToJwk(keyPair.public as ECPublicKey)

    override fun sign(input: ByteArray): ByteArray {
        val der = Signature.getInstance("SHA256withECDSA").apply {
            initSign(keyPair.private)
            update(input)
        }.sign()
        return DpopProof.derToP1363(der, 32)
    }

    companion object {
        fun generateKeyPair(): KeyPair = KeyPairGenerator.getInstance("EC").apply {
            initialize(ECGenParameterSpec("secp256r1"))
        }.generateKeyPair()
    }
}
