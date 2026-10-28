package com.charles.bento.settings

import android.net.Uri
import com.charles.bento.core.sync.SyncConnection

/**
 * What a Mac's "Pair Android Phone" code carries:
 * `bento://pair?v=1&server=…&token=…&name=…[&gemini=…]` (see docs/SYNC_PROTOCOL.md).
 */
data class Pairing(val server: String, val token: String, val macName: String, val geminiKey: String?) {
    companion object {
        fun parse(text: String): Pairing? {
            val uri = runCatching { Uri.parse(text.trim()) }.getOrNull() ?: return null
            if (uri.scheme != "bento" || uri.host != "pair") return null
            val v = uri.getQueryParameter("v")?.toIntOrNull() ?: 1
            if (v > 1) return null
            val server = uri.getQueryParameter("server")?.trim().orEmpty()
            val token = uri.getQueryParameter("token")?.trim().orEmpty()
            if (server.isEmpty() || token.isEmpty()) return null
            return Pairing(
                server = server,
                token = token,
                macName = uri.getQueryParameter("name").orEmpty(),
                geminiKey = uri.getQueryParameter("gemini")?.trim()?.takeIf { it.isNotEmpty() },
            )
        }
    }
}

/** Stores a pairing: the server in prefs, the token and key in the Keystore-backed store. */
/** A server address as compared and shown: `sync.example.com/` → `https://sync.example.com`. */
fun serverKey(server: String): String = SyncConnection.baseUrl(server)?.toString()?.trimEnd('/').orEmpty()

fun Pairing.save(prefs: Prefs, secrets: SecretStore) {
    prefs.server.value = server
    prefs.syncedServer.value = serverKey(server)
    prefs.pairedWith.value = macName
    prefs.syncEnabled.value = true
    secrets.syncToken = token
    if (geminiKey != null) secrets.geminiKey = geminiKey
}
