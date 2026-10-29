package com.charles.bento.core.assistant

import java.net.URLDecoder

/**
 * A link (or QR code) that sets the phone up for Hermes, made on the machine Hermes runs on:
 * `bento://hermes?v=1&url=<API server>&token=<API_SERVER_KEY>[&name=<host>]`. Separate from
 * a Mac's `bento://pair` code, which knows nothing about Hermes's server.
 */
data class HermesLink(val url: String, val token: String, val name: String) {
    override fun toString() = "HermesLink($url, $name)" // never the token

    companion object {
        fun parse(text: String): HermesLink? {
            val s = text.trim()
            if (!s.startsWith("bento://hermes?") && !s.startsWith("bento://hermes/?")) return null
            val query = s.substringAfter('?').substringBefore('#')
            val params = query.split('&').filter { it.isNotEmpty() }.associate { p ->
                val k = p.substringBefore('=')
                val v = p.substringAfter('=', "")
                decode(k) to decode(v)
            }
            if ((params["v"]?.toIntOrNull() ?: 1) > 1) return null
            val url = params["url"]?.trim().orEmpty()
            val token = params["token"]?.trim().orEmpty()
            if (HermesEndpoint.parseUrl(url) == null || token.isEmpty()) return null
            return HermesLink(url, token, params["name"]?.trim().orEmpty())
        }

        private fun decode(s: String) = runCatching { URLDecoder.decode(s, "UTF-8") }.getOrDefault(s)
    }
}
