package com.charles.bento.settings

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The sync token, the Gemini API key and the Hermes token, encrypted with an AES key that never leaves the
 * Android Keystore (the phone's counterpart of the Mac's token file and Keychain). Not
 * backed up: a restored phone pairs again.
 */
class SecretStore(context: Context) {
    private val sp = context.getSharedPreferences("bento.secrets", Context.MODE_PRIVATE)
    private val cache = mutableMapOf<String, String?>()
    private val _version = MutableStateFlow(0)
    /** Bumps on every change, so screens and the sync coordinator can react. */
    val version: StateFlow<Int> = _version.asStateFlow()

    var syncToken: String?
        get() = get(SYNC_TOKEN)
        set(v) = set(SYNC_TOKEN, v)

    var geminiKey: String?
        get() = get(GEMINI_KEY)
        set(v) = set(GEMINI_KEY, v)

    /** Hermes's API server key (`API_SERVER_KEY`), for the Assistant. */
    var hermesToken: String?
        get() = get(HERMES_TOKEN)
        set(v) = set(HERMES_TOKEN, v)

    @Synchronized
    fun get(name: String): String? = cache.getOrPut(name) {
        val stored = sp.getString(name, null) ?: return@getOrPut null
        runCatching { decrypt(stored) }.getOrNull()
    }

    @Synchronized
    fun set(name: String, value: String?) {
        val v = value?.trim()?.takeIf { it.isNotEmpty() }
        cache[name] = v
        sp.edit().apply { if (v == null) remove(name) else putString(name, encrypt(v)) }.apply()
        _version.value++
    }

    /** Writes everything set so far to disk now (before the process exits). */
    fun flush() = sp.edit().commit()

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    private fun encrypt(plain: String): String {
        val c = Cipher.getInstance(TRANSFORMATION)
        c.init(Cipher.ENCRYPT_MODE, key())
        val out = c.iv + c.doFinal(plain.toByteArray())
        return Base64.encodeToString(out, Base64.NO_WRAP)
    }

    private fun decrypt(stored: String): String {
        val data = Base64.decode(stored, Base64.NO_WRAP)
        val c = Cipher.getInstance(TRANSFORMATION)
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, data, 0, 12))
        return String(c.doFinal(data, 12, data.size - 12))
    }

    companion object {
        const val SYNC_TOKEN = "sync_token"
        const val GEMINI_KEY = "gemini_api_key"
        const val HERMES_TOKEN = "hermes_token"
        private const val ALIAS = "bento-secrets"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
