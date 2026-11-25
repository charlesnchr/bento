package com.charles.bento.settings

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.charles.bento.core.assistant.DpopProof
import com.charles.bento.core.assistant.DpopSigner
import com.charles.bento.core.assistant.EcJwk
import com.charles.bento.core.assistant.HermesEndpoint
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

/**
 * Hardware-backed EC P-256 key in Android Keystore for RFC 9449 DPoP proofs sent to the
 * Bento Hermes gateway. The private key never leaves the Keystore and is not backed up.
 */
class HermesDpopKey(private val alias: String = ALIAS) : DpopSigner {
    @Volatile private var cachedEntry: KeyStore.PrivateKeyEntry? = null
    @Volatile private var cachedJwk: EcJwk? = null

    override val jwk: EcJwk
        get() = cachedJwk ?: synchronized(this) {
            cachedJwk ?: DpopProof.ecPublicKeyToJwk(entry().certificate.publicKey as ECPublicKey)
                .also { cachedJwk = it }
        }

    override fun sign(input: ByteArray): ByteArray {
        val der = Signature.getInstance("SHA256withECDSA").apply {
            initSign(entry().privateKey)
            update(input)
        }.sign()
        return DpopProof.derToP1363(der, 32)
    }

    @Synchronized
    private fun entry(): KeyStore.PrivateKeyEntry {
        cachedEntry?.let { return it }
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (ks.getEntry(alias, null) as? KeyStore.PrivateKeyEntry)?.let {
            cachedEntry = it
            return it
        }
        val gen = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
        gen.initialize(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build(),
        )
        gen.generateKeyPair()
        val created = ks.getEntry(alias, null) as KeyStore.PrivateKeyEntry
        cachedEntry = created
        return created
    }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val ALIAS = "bento-hermes-dpop"

        /** Gateway-minted per-device tokens (`bnt_...`) authenticate with DPoP; direct tailnet keys stay Bearer. */
        fun shouldUseFor(endpoint: HermesEndpoint): Boolean = endpoint.token.startsWith("bnt_")
    }
}
