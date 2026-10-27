package com.charles.bento

import android.app.Application
import android.content.Context

class BentoApp : Application() {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        com.charles.bento.core.voice.VoiceLog.sink = { level, tag, message ->
            val priority = when (level) {
                com.charles.bento.core.voice.VoiceLog.Level.DEBUG -> android.util.Log.DEBUG
                com.charles.bento.core.voice.VoiceLog.Level.INFO -> android.util.Log.INFO
                com.charles.bento.core.voice.VoiceLog.Level.WARN -> android.util.Log.WARN
                com.charles.bento.core.voice.VoiceLog.Level.ERROR -> android.util.Log.ERROR
            }
            android.util.Log.println(priority, "BentoVoice", "$tag: $message")
        }
        graph = AppGraph(this)
        graph.start()
    }
}

/** The app's singletons (stores, sync, dictation), shared by activities, services and widgets. */
val Context.graph: AppGraph get() = (applicationContext as BentoApp).graph
