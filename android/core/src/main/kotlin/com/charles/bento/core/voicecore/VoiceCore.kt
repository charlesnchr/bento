package com.charles.bento.core.voicecore

import app.cash.zipline.QuickJs

/**
 * The shared voice core (`voice-core/` at the repo's root, built to `dist/voice-core.js`) in
 * QuickJS: the same call logic the Mac, the Echo bridge and the web harness run, byte for byte
 * (voice-core/scenarios; [VoiceCoreConformanceTest] holds this engine to them).
 *
 * The core is sans-IO: [create] and [push] take JSON and return the commands for the host to
 * carry out (open a socket, send a frame, play audio, run a Hermes task); see voice-core/src/types.ts.
 * The app loads the bundle from its assets, or in a debug build from the dev server
 * (`http://…:8770/voice-core.js`), so a change to the call logic needs no new APK.
 *
 * QuickJS isn't thread-safe: every method is synchronized, and a host should call from one thread.
 */
class VoiceCore(source: String) : AutoCloseable {
    private val js = QuickJs.create()

    init {
        // A call's state is small, but a frame of model audio is up to 480 KB of base64.
        js.memoryLimit = 64L * 1024 * 1024
        js.evaluate(source, "voice-core.js")
    }

    /** The bundle's build, a hash of what it does: shown so it's clear which core a call ran. */
    val version: String = js.evaluate("VoiceCore.version") as String

    /** Starts a call: `{"id":…,"commands":[…]}`. [configJson] is merged over the core's defaults. */
    @Synchronized
    fun create(configJson: String, t: Double): String = js.evaluate("VoiceCore.create(${literal(configJson)}, $t)") as String

    /** One event for call [id]; the commands it answers with, as a JSON array. */
    @Synchronized
    fun push(id: Int, eventJson: String): String = js.evaluate("VoiceCore.push($id, ${literal(eventJson)})") as String

    /** What the call's trace kept since last asked (config `"trace": true`), for the dev server's replay. */
    @Synchronized
    fun trace(id: Int): String = js.evaluate("VoiceCore.trace($id)") as String

    @Synchronized
    fun dispose(id: Int) {
        js.evaluate("VoiceCore.dispose($id)")
    }

    @Synchronized
    override fun close() = js.close()

    companion object {
        /** [json] as a JavaScript string literal. */
        internal fun literal(json: String): String {
            val out = StringBuilder(json.length + 16).append('"')
            for (c in json) {
                when (c) {
                    '"' -> out.append("\\\"")
                    '\\' -> out.append("\\\\")
                    '\n' -> out.append("\\n")
                    '\r' -> out.append("\\r")
                    ' ' -> out.append("\\u2028")
                    ' ' -> out.append("\\u2029")
                    else -> if (c < ' ') out.append("\\u%04x".format(c.code)) else out.append(c)
                }
            }
            return out.append('"').toString()
        }
    }
}
